import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { MCPDogDaemon } from '../daemon/mcpdog-daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const CLI_MAIN = resolve(__dirname, 'cli-main.ts');
const TSX_PACKAGE = join(REPO_ROOT, 'node_modules', 'tsx', 'package.json');

// 与 /mcp 集成用例（45231/45241）错开的端口，避免同 fork 内抢端口
const IPC_PORT = 45311;

const INIT_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest-stdio-e2e', version: '1' },
  },
};

/**
 * stdio 回归守卫：走真实 `proxy` 入口，而不是直接实例化 StdioProxy。
 * 这是「stdio 路径在本分支未被破坏」的自动化证据 —— 只有零 diff 和一次手工
 * `daemon status` 不算证据。
 *
 * 机制选择：`node --import tsx src/cli/cli-main.ts proxy ...`，不用 `node dist/...`。
 * 原因是 dist 需要先 `npm run build`，而本测试属于集成套件，不应依赖构建产物是否最新
 * （构建过期会让守卫验的是旧代码）；tsx 已是 devDependency，不引入新运行时依赖。
 */
describe('stdio 路径端到端回归（集成）', () => {
  let dir: string;
  let pidFile: string;
  let daemon: MCPDogDaemon | null = null;
  let proxy: ChildProcess | null = null;
  let stdoutLines: string[] = [];
  let stderrBuf = '';

  beforeAll(async () => {
    // 前置缺失时明确失败，不静默跳过：跳过等于守卫不存在
    expect(existsSync(CLI_MAIN), `找不到 CLI 入口: ${CLI_MAIN}`).toBe(true);
    expect(existsSync(TSX_PACKAGE), `找不到 tsx（devDependency 未安装）: ${TSX_PACKAGE}`).toBe(true);

    dir = mkdtempSync(join(tmpdir(), 'mcpdog-stdio-e2e-'));
    const configPath = join(dir, 'mcpdog.config.json');
    pidFile = join(dir, 'mcpdog.pid');
    // 不配子服务器：本用例只验证 stdio 传输链路本身，不依赖外部 npx 子进程
    writeFileSync(configPath, JSON.stringify({ version: '2.0.0', servers: {} }));

    daemon = new MCPDogDaemon({ configPath, ipcPort: IPC_PORT, pidFile });
    await daemon.start();
  }, 60000);

  afterAll(async () => {
    try {
      proxy?.stdin?.end();
      proxy?.kill();
    } catch {
      // 子进程可能已自行退出
    }
    await daemon?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function startProxy(): void {
    proxy = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_MAIN, 'proxy', '--daemon-port', String(IPC_PORT), '--pid-file', pidFile],
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proxy.stdout?.on('data', (chunk: Buffer) => {
      stdoutLines = stdoutLines.concat(chunk.toString().split('\n'));
    });
    proxy.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
  }

  // proxy 与 daemon 完成握手后才发请求：StdioProxy 在 isReady 之前收到请求会直接回
  // -32603（daemon not connected），那属于时序竞态而不是被测行为
  async function waitForStdioClient(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const clients = (daemon as any)?.getFullStatus?.()?.daemon?.clients ?? [];
      if (clients.some((c: any) => c.type === 'stdio')) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待 proxy 连接 daemon 超时；stderr:\n${stderrBuf}`);
  }

  async function waitForResponse(id: number, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const line of stdoutLines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed?.id === id) {
          return parsed;
        }
      }
      if (proxy && proxy.exitCode !== null) {
        throw new Error(
          `proxy 提前退出（code ${proxy.exitCode}）而 id=${id} 的响应未到。\nstdout:\n${stdoutLines.join('\n')}\nstderr:\n${stderrBuf}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `等待 id=${id} 的 JSON-RPC 响应超时。\nstdout:\n${stdoutLines.join('\n')}\nstderr:\n${stderrBuf}`,
    );
  }

  it('initialize 与 tools/list 经真实 proxy 走通', async () => {
    startProxy();
    await waitForStdioClient(20000);

    proxy!.stdin!.write(JSON.stringify(INIT_REQUEST) + '\n');
    const init = await waitForResponse(1, 20000);
    expect(init.error).toBeUndefined();
    expect(init.result?.protocolVersion).toBeTruthy();
    expect(init.result?.serverInfo?.name).toBeTruthy();

    proxy!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const list = await waitForResponse(2, 20000);
    expect(list.error).toBeUndefined();
    expect(Array.isArray(list.result?.tools)).toBe(true);
  }, 60000);
});
