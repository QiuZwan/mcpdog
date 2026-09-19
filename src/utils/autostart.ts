/**
 * 开机自启的形态裁决与注册表读写。
 *
 * 自启有两种形态，必须由 daemon 侧统一裁决，否则壳与 CLI 会各写一份互相打架：
 * - shell  形态：桌面壳安装后接管，注册表指向壳 exe，壳再拉起 daemon；
 * - daemon 形态：无壳（npm 安装的 CLI 用法），走已有的 service 脚本。
 * 判据是壳 spawn daemon 时注入的 MCPDOG_SHELL_EXE —— 只有壳知道自己在托管这个 daemon。
 */

import { execFile } from 'child_process';

export type AutostartForm = 'shell' | 'daemon' | 'none';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_NAME = 'MCPDog';

export interface AutostartContext {
  shellExe?: string;
  nodeExe: string;
  cliEntry: string;
  configPath: string;
}

export function resolveAutostartTarget(
  env: NodeJS.ProcessEnv,
  ctx: AutostartContext,
): { form: AutostartForm; command: string } {
  const shellExe = (env.MCPDOG_SHELL_EXE || '').trim();
  if (shellExe) {
    return { form: 'shell', command: buildWindowsRunValue(shellExe) };
  }

  return {
    form: 'daemon',
    command: `"${ctx.nodeExe}" "${ctx.cliEntry}" daemon start --config "${ctx.configPath}"`,
  };
}

export function buildWindowsRunValue(shellExe: string): string {
  return `"${shellExe}" --autostart`;
}

export function parseRegQueryOutput(stdout: string): string | null {
  // 形如：    MCPDog    REG_SZ    "<值>"
  const match = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
  return match ? match[1] : null;
}

function reg(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as any).code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

// reg.exe 的退出码 1 表示「项或值不存在」，这是预期情况（读时视为未配置、删时视为幂等成功）。
// 其余非零退出是真实故障，必须抛出，不能一律读成「没配置」——否则 service install 的冲突检测
// 会 fail open（查出错照样写 VBS），且 setAutostart(false) 删除失败也会假报成功。
// 判定只看退出码，不匹配 stderr 文案（reg.exe 的提示随系统语言变化）。
const REG_EXIT_NOT_FOUND = 1;

export async function readWindowsRunValue(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const { code, stdout, stderr } = await reg(['query', RUN_KEY, '/v', RUN_VALUE_NAME]);
  if (code === REG_EXIT_NOT_FOUND) return null;
  if (code !== 0) throw new Error(`读取注册表失败 (reg.exe exit ${code}): ${stderr.trim()}`);
  return parseRegQueryOutput(stdout);
}

export async function writeWindowsRunValue(command: string | null): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('开机自启目前仅支持 Windows');
  }
  if (command === null) {
    const { code, stderr } = await reg(['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f']);
    // 值本就不存在时 reg.exe 返回 1，按幂等成功处理；其余非零是真实删除失败，不能假报成功
    if (code !== 0 && code !== REG_EXIT_NOT_FOUND) {
      throw new Error(`删除注册表值失败 (reg.exe exit ${code}): ${stderr.trim()}`);
    }
    return;
  }
  const { code, stderr } = await reg([
    'add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f',
  ]);
  if (code !== 0) throw new Error(`写入注册表失败: ${stderr}`);
}

export async function getAutostartState(): Promise<{ form: AutostartForm; enabled: boolean; command: string | null }> {
  const existing = await readWindowsRunValue();
  if (!existing) return { form: 'none', enabled: false, command: null };
  // 复用 isShellAutostart 而不是再写一次 /--autostart\b/：两处各写一份迟早会漂移，
  // 而「注册表值指向壳还是 daemon」正是本模块唯一的裁决点。
  const form: AutostartForm = isShellAutostart(existing) ? 'shell' : 'daemon';
  return { form, enabled: true, command: existing };
}

export async function setAutostart(enabled: boolean, ctx: AutostartContext): Promise<void> {
  if (!enabled) {
    await writeWindowsRunValue(null);
    return;
  }
  const target = resolveAutostartTarget(process.env, ctx);
  await writeWindowsRunValue(target.command);
}

/** 供 service install 判断是否已被桌面壳接管 */
export function isShellAutostart(command: string | null): boolean {
  return !!command && /--autostart\b/.test(command);
}
