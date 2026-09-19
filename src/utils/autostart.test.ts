import { describe, it, expect } from 'vitest';
import {
  resolveAutostartTarget,
  buildWindowsRunValue,
  parseRegQueryOutput,
} from './autostart.js';

const CTX = {
  shellExe: 'C:\\Program Files\\MCPDog\\MCPDog.exe',
  nodeExe: 'C:\\Program Files\\MCPDog\\resources\\node\\node.exe',
  cliEntry: 'C:\\Program Files\\MCPDog\\resources\\app\\dist\\cli\\cli-main.js',
  configPath: 'C:\\Users\\me\\.mcpdog\\mcpdog.config.json',
};

describe('自启形态裁决', () => {
  it('存在 MCPDOG_SHELL_EXE 时指向壳 exe', () => {
    const r = resolveAutostartTarget({ MCPDOG_SHELL_EXE: CTX.shellExe }, CTX);
    expect(r.form).toBe('shell');
    expect(r.command).toBe(`"${CTX.shellExe}" --autostart`);
  });

  it('无 MCPDOG_SHELL_EXE 时指向 daemon 命令行', () => {
    const r = resolveAutostartTarget({}, CTX);
    expect(r.form).toBe('daemon');
    expect(r.command).toContain(CTX.nodeExe);
    expect(r.command).toContain('daemon start');
    expect(r.command).toContain(CTX.configPath);
  });

  it('环境变量为空字符串时按不存在处理', () => {
    const r = resolveAutostartTarget({ MCPDOG_SHELL_EXE: '   ' }, CTX);
    expect(r.form).toBe('daemon');
  });

  it('环境变量指向不存在的路径时仍按壳处理（不静默回退）', () => {
    const r = resolveAutostartTarget({ MCPDOG_SHELL_EXE: 'D:\\nope\\MCPDog.exe' }, CTX);
    expect(r.form).toBe('shell');
    expect(r.command).toContain('D:\\nope\\MCPDog.exe');
  });
});

describe('Windows Run 值构造与解析', () => {
  it('buildWindowsRunValue 给 exe 路径加引号并追加 --autostart', () => {
    expect(buildWindowsRunValue(CTX.shellExe)).toBe(`"${CTX.shellExe}" --autostart`);
  });

  it('parseRegQueryOutput 取出 REG_SZ 的值', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '    MCPDog    REG_SZ    "C:\\Program Files\\MCPDog\\MCPDog.exe" --autostart',
      '',
    ].join('\r\n');
    expect(parseRegQueryOutput(stdout)).toBe('"C:\\Program Files\\MCPDog\\MCPDog.exe" --autostart');
  });

  it('parseRegQueryOutput 在没有该项时返回 null', () => {
    expect(parseRegQueryOutput('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});
