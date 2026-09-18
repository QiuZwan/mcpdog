import { describe, it, expect, vi, afterEach } from 'vitest';
import { StartCommand } from './start-command.js';
import { ConfigManager } from '../../config/config-manager.js';

describe('mcpdog start 选项处置', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('传入 --mcp-http-port 时告警并忽略该端口', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cm = new ConfigManager('unused.json');
    const cmd = new StartCommand(cm);
    const cfg = (cmd as any).parseStartupOptions({ 'mcp-http-port': '4001', 'dashboard-port': '38881' });
    // 这两个选项在重构后不再存在于 StartupConfig，断言「字段不存在」而非取值为 false
    expect('httpPort' in cfg).toBe(false);
    expect('enableHttp' in cfg).toBe(false);
    expect(cfg.dashboardPort).toBe(38881);
    expect(warn).toHaveBeenCalled();
  });

  it('--http-only 报错，因为 MCP 与 dashboard 已同端口', async () => {
    const cm = new ConfigManager('unused.json');
    const cmd = new StartCommand(cm);
    expect(() => (cmd as any).parseStartupOptions({ 'http-only': true })).toThrow(/同端口|--http-only/);
  });

  it('--stdio-only 与 --no-dashboard 仍生效', async () => {
    const cm = new ConfigManager('unused.json');
    const cmd = new StartCommand(cm);
    const cfg = (cmd as any).parseStartupOptions({ 'stdio-only': true, 'no-dashboard': true });
    expect(cfg.enableStdio).toBe(true);
    expect(cfg.enableDashboard).toBe(false);
  });
});
