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
});
