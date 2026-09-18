import { describe, it, expect, vi, afterEach } from 'vitest';
import { StartCommand } from './start-command.js';
import { ConfigManager } from '../../config/config-manager.js';

describe('mcpdog start 选项处置', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCommand(): StartCommand {
    return new StartCommand(new ConfigManager('unused.json'));
  }

  it('传入 --mcp-http-port 时告警并忽略该端口', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cmd = makeCommand();

    const cfg = (cmd as any).parseStartupOptions({ 'mcp-http-port': '4001', 'dashboard-port': '38881' });
    const otherPortCfg = (cmd as any).parseStartupOptions({ 'mcp-http-port': '5999', 'dashboard-port': '38881' });

    // 这两个选项在重构后不再存在于 StartupConfig，断言「字段不存在」而非取值为 false
    expect('httpPort' in cfg).toBe(false);
    expect('enableHttp' in cfg).toBe(false);
    expect(cfg.dashboardPort).toBe(38881);
    // 「被忽略」的可失败断言：换一个端口值，结果必须完全一致
    expect(otherPortCfg).toEqual(cfg);
    // 告警内容本身也是契约（用户唯一能看到的迁移指引），不能只断言「调用过」
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--mcp-http-port'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('忽略'));
  });

  it('--http-only 报错，因为 MCP 与 dashboard 已同端口', async () => {
    const cmd = makeCommand();
    expect(() => (cmd as any).parseStartupOptions({ 'http-only': true })).toThrow(/同端口|--http-only/);
  });

  it('--stdio-only 是 no-op，dashboard 只由 --no-dashboard 控制', async () => {
    const cmd = makeCommand();
    const baseline = (cmd as any).parseStartupOptions({});
    const stdioOnly = (cmd as any).parseStartupOptions({ 'stdio-only': true });
    const noDashboard = (cmd as any).parseStartupOptions({ 'no-dashboard': true });

    // --stdio-only 的契约是 no-op（stdio 恒开）：若它开始改动任何启动字段，这条会失败；
    // 只断言 enableStdio === true 是空断言 —— 该值在实现里就是硬编码的 true
    expect(stdioOnly).toEqual(baseline);
    expect(baseline.enableStdio).toBe(true);
    // dashboard 开关只由 --no-dashboard 决定
    expect(baseline.enableDashboard).toBe(true);
    expect(noDashboard.enableDashboard).toBe(false);
  });
});
