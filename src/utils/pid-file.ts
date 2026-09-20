/**
 * PID 文件解析与 daemon 身份判定。
 *
 * 抽成共享纯函数的原因：daemon 侧的「已在运行」判定与 proxy 侧的「daemon 是否在跑」判定
 * 读的是同一个文件，却各写了一份解析 —— 而 proxy 那份用 parseInt 读 JSON 格式，恒为 NaN，
 * 等于「daemon 是否在运行」的判定形同虚设。
 */

export interface PidFileInfo {
  pid: number;
  /** 旧格式（纯数字）无版本信息 */
  version: string | null;
}

/**
 * 解析 PID 文件内容，兼容两种格式：
 * - 新格式：`{"pid":123,"version":"1.1.0"}`
 * - 旧格式：纯数字 `123`
 * 解析不出合法 PID 时返回 null。
 */
export function parsePidFileContent(content: string): PidFileInfo | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const info = JSON.parse(trimmed);
      if (typeof info?.pid === 'number' && Number.isInteger(info.pid) && info.pid > 0) {
        return { pid: info.pid, version: typeof info.version === 'string' ? info.version : null };
      }
    } catch {
      // 落到下面返回 null
    }
    return null;
  }

  const pid = parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, version: null } : null;
}

/**
 * 判定某进程的命令行是否属于我们的 daemon。
 *
 * 两种真实布局都含 `cli-main.js`：npx 安装的（`.../@keysqiu/mcpdog/dist/cli/cli-main.js`）
 * 与桌面版内嵌的（`.../app/dist/cli/cli-main.js`）。故以它为唯一判据 ——
 * 不再附带更宽的 `mcpdog` 子串匹配（任何从 MCPDog 目录启动的 node 进程都会命中）。
 *
 * 读不到命令行（null/空）时返回 false，表示「无法确认是我们的」；
 * 调用方须按「不能认定它在运行」处理，而不是反过来。
 */
export function looksLikeOurDaemon(commandLine: string | null | undefined): boolean {
  if (!commandLine) return false;
  return commandLine.toLowerCase().includes('cli-main.js');
}
