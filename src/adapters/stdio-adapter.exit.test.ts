import { describe, it, expect, afterEach } from 'vitest';
import { StdioAdapter } from './stdio-adapter.js';
import type { MCPServerConfig } from '../types/index.js';

/**
 * 子进程一启动就退出时，在途请求必须**立刻**以「退出码 + 它最后的 stderr」失败，
 * 而不是各自等到 timeout 之后报「Request timeout」—— 那会把最直接的证据淹掉。
 * 线上那次 playwright 连不上正是这样被误报成超时的。
 */
describe('StdioAdapter：子进程退出时的失败原因', () => {
  let adapter: StdioAdapter | null = null;

  afterEach(async () => {
    try {
      await adapter?.disconnect();
    } catch {
      // 清理失败不影响断言
    }
    adapter = null;
  });

  it('退出时带上退出码与最后的 stderr，而不是只报超时', async () => {
    const config: MCPServerConfig = {
      name: 'exit-probe',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      // 立刻往 stderr 写一行再以 1 退出，模拟 cmd 找不到路径那种「起不来」
      args: [
        '-e',
        'process.stderr.write("probe: cannot find the path specified\\n");process.exit(1)',
      ],
      // 给一个明显大于断言所需的超时；若实现仍在等超时，用例会因超时文案而失败
      timeout: 8000,
    } as MCPServerConfig;

    adapter = new StdioAdapter(config.name, config);

    const startedAt = Date.now();
    let message = '';
    try {
      await adapter.connect();
    } catch (error) {
      message = (error as Error).message;
    }
    const elapsed = Date.now() - startedAt;

    expect(message).toContain('子进程已退出');
    expect(message).toContain('code=1');
    expect(message).toContain('probe: cannot find the path specified');
    // 关键：不是等满 8s 超时才失败（留出余量避免机器慢导致偶发）
    expect(elapsed).toBeLessThan(6000);
  }, 20000);

  it('上一个进程的 stderr 不会污染下一次崩溃的失败原因', async () => {
    const config: MCPServerConfig = {
      name: 'exit-probe-2',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("first-life-marker\\n");process.exit(1)'],
      timeout: 8000,
    } as MCPServerConfig;

    adapter = new StdioAdapter(config.name, config);

    const first = await adapter.connect().then(
      () => '',
      (error: Error) => error.message
    );
    expect(first).toContain('first-life-marker');

    // 第二次生命：换个 stderr 内容再崩一次
    config.args = [
      '-e',
      'process.stderr.write("second-life-marker\\n");process.exit(1)',
    ];

    const second = await adapter.connect().then(
      () => '',
      (error: Error) => error.message
    );
    expect(second).toContain('second-life-marker');
    expect(second).not.toContain('first-life-marker');
  }, 20000);

  it('子进程已死时写入 stdin 不得让进程级异常扩散（EPIPE 不得拖垮整个 daemon）', async () => {
    // stdin 是独立于 child_process 的 socket，它的 'error'（进程死后写入抛 EPIPE）
    // 不挂监听就会成为 uncaughtException —— 而 CLI 的 handler 是 process.exit(1)，
    // 一个下游进程死掉会把整个 daemon 连同所有会话一起带走。
    const NL = String.fromCharCode(10);
    const childScript = [
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d;',
      '  let i;',
      '  while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {',
      '    const line = buf.slice(0, i);',
      '    buf = buf.slice(i + 1);',
      '    if (!line.trim()) continue;',
      '    let m;',
      '    try { m = JSON.parse(line); } catch { continue; }',
      '    if (m.id !== undefined) {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + String.fromCharCode(10));',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);',
    ].join(NL);

    const config: MCPServerConfig = {
      name: 'epipe-probe',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', childScript],
      timeout: 2000,
    } as MCPServerConfig;

    adapter = new StdioAdapter(config.name, config);
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);

    // 记录进程级未处理错误：修复前这里会被 EPIPE 触发
    const uncaught: string[] = [];
    const onUncaught = (e: Error) => uncaught.push(e.message);
    process.on('uncaughtException', onUncaught);

    try {
      // 杀掉子进程后立刻发请求：命中「标志位说活着、进程其实已死」的时序窗口
      const proc = (adapter as any).process;
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // 已退出
      }

      // 请求本身应当失败（或触发重连），但**不得**产生进程级未处理错误
      await adapter.getTools().catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught, `不得出现进程级未处理错误：${uncaught.join(' | ')}`).toEqual([]);
  }, 30000);

  it('迟到的旧进程 exit 不得打回新连接的状态', async () => {
    // 真实时序：cleanup() 用异步 taskkill / 延迟 SIGKILL 杀旧进程后立即把 this.process
    // 置空，而恢复只等 1s 就拉起新进程 —— 旧进程的 exit 常在新进程已 connected 之后
    // 才送达。不校验「这是不是当前进程」的话，这个迟到的 exit 会把健康的新连接标成
    // isConnected=false、发出 disconnected，还会再排一轮恢复把新进程也杀掉。
    // 子进程：一个最小 MCP 服务，回 initialize 后保持存活。
    // 用数组 join 组装，避免在测试文件里嵌套转义换行符
    const NL = String.fromCharCode(10);
    const childScript = [
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d;',
      '  let i;',
      '  while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {',
      '    const line = buf.slice(0, i);',
      '    buf = buf.slice(i + 1);',
      '    if (!line.trim()) continue;',
      '    let m;',
      '    try { m = JSON.parse(line); } catch { continue; }',
      '    if (m.id !== undefined) {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + String.fromCharCode(10));',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);',
    ].join(NL);

    const config: MCPServerConfig = {
      name: 'stale-exit-probe',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', childScript],
      timeout: 4000,
    } as MCPServerConfig;

    adapter = new StdioAdapter(config.name, config);
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);

    // 记录旧进程引用，然后模拟「重启该服务器」：断开并重连
    const stale = (adapter as any).process;
    await adapter.disconnect();
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);

    // 以重连完成为基准计数：disconnect() 自己会正常发一次 disconnected，
    // 这里只关心「迟到 exit」是否额外打回状态
    let disconnectedAfterReconnect = 0;
    adapter.on('disconnected', () => disconnectedAfterReconnect++);

    // 旧进程的 exit 迟到送达（真实场景由 taskkill 的异步性造成）
    stale.emit('exit', null, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 150));

    // 新连接的状态不得被这个迟到事件打回
    expect(adapter.isConnected).toBe(true);
    expect(disconnectedAfterReconnect).toBe(0);
    expect((adapter as any).process).toBeDefined();
    expect((adapter as any).process).not.toBe(stale);
  }, 30000);
});
