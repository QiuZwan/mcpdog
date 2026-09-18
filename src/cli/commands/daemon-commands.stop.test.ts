import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { DaemonCommands } from './daemon-commands.js';
import { CLIUtils } from '../cli-utils.js';

// 优雅停机窗口的固定上限与轮询间隔（见 daemon-commands.ts 的 GRACEFUL_SHUTDOWN_* 常量）
const GRACEFUL_WINDOW_MS = 5000;
const POLL_INTERVAL_MS = 250;

function spawnChild(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
}

describe('daemon stop 的优雅停机决策', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 可能已自行退出
      }
    }
    vi.restoreAllMocks();
  });

  // 老版本 daemon：连接成功但忽略 shutdown 消息（落到 handleClientMessage 的 default 分支）。
  // 修复前这里要等满 30s 才强杀；修复后必须在约 5s 内收敛。
  it('daemon 忽略 shutdown 时在约 5s 内强杀兜底，不再等 30s', async () => {
    const child = spawnChild('setInterval(() => {}, 1000)');
    children.push(child);
    const pid = child.pid!;

    const cmd = new DaemonCommands('unused.json');
    vi.spyOn(cmd as any, 'requestShutdown').mockResolvedValue(true);
    const forceKill = vi.spyOn(cmd as any, 'forceKill').mockResolvedValue(true);
    const warn = vi.spyOn(CLIUtils, 'warn').mockImplementation(() => {});

    const started = Date.now();
    const graceful = await (cmd as any).stopDaemonByPid(pid, 1);
    const elapsed = Date.now() - started;

    expect(graceful).toBe(false);
    expect(forceKill).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(GRACEFUL_WINDOW_MS);
    // 30s 的旧行为必须不复存在；留足调度抖动余量
    expect(elapsed).toBeLessThan(GRACEFUL_WINDOW_MS + 3000);
    // 超时原因必须解释清楚（老版本 daemon 不支持优雅停机），不能只有一句笼统的 warn
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('predate this version'));
  }, 30000);

  // 进程在最后一次 sleep 期间自行退出：修复前会对已死 PID 再强杀并报「未优雅停机」，
  // 让 CLI 误删 daemon 已删的 PID 文件。现在必须先复核存活、如实返回优雅停机成功。
  // 用假时钟 + 受控的 isProcessAlive 精确复现「最后一次 sleep 期间退出」这个窗口：
  // 依赖真实计时会落在轮询抖动里，测不出这个分支。
  it('进程在最后一次等待窗口内自行退出时，报告优雅停机成功且不触发强杀', async () => {
    vi.useFakeTimers();
    try {
      const cmd = new DaemonCommands('unused.json');
      vi.spyOn(cmd as any, 'requestShutdown').mockResolvedValue(true);
      const forceKill = vi.spyOn(cmd as any, 'forceKill').mockResolvedValue(true);
      const warn = vi.spyOn(CLIUtils, 'warn').mockImplementation(() => {});

      const inLoopChecks = GRACEFUL_WINDOW_MS / POLL_INTERVAL_MS;
      let calls = 0;
      // 循环内每一次存活检查都返回 true；循环结束后那次复核返回 false
      vi.spyOn(cmd as any, 'isProcessAlive').mockImplementation(() => ++calls <= inLoopChecks);

      const pending = (cmd as any).stopDaemonByPid(12345, 1);
      await vi.advanceTimersByTimeAsync(GRACEFUL_WINDOW_MS + POLL_INTERVAL_MS);
      const graceful = await pending;

      expect(graceful).toBe(true);
      expect(forceKill).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(calls).toBe(inLoopChecks + 1); // 最后一次调用就是被修掉的那个 off-by-one 复核
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  // 强杀失败必须冒泡：否则 stop() 会继续打印 "Daemon stopped"，用户以为已停而进程还在
  it('强杀失败时抛错，不得假报停机成功', async () => {
    const child = spawnChild('setInterval(() => {}, 1000)');
    children.push(child);

    const cmd = new DaemonCommands('unused.json');
    vi.spyOn(cmd as any, 'requestShutdown').mockResolvedValue(false); // 请求没送达 → 直接强杀分支
    vi.spyOn(cmd as any, 'forceKill').mockResolvedValue(false); // 强杀失败

    await expect((cmd as any).stopDaemonByPid(child.pid!, 1)).rejects.toThrow(/still running/);
  }, 30000);
});
