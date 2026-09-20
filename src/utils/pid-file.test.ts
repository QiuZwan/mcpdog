import { describe, it, expect } from 'vitest';
import { parsePidFileContent, looksLikeOurDaemon } from './pid-file.js';

describe('parsePidFileContent', () => {
  it('解析新格式（JSON，含版本）', () => {
    expect(parsePidFileContent('{"pid":1234,"version":"1.1.0"}')).toEqual({
      pid: 1234,
      version: '1.1.0',
    });
  });

  it('解析旧格式（纯数字，无版本）', () => {
    expect(parsePidFileContent('48196')).toEqual({ pid: 48196, version: null });
  });

  it('容忍首尾空白与换行', () => {
    expect(parsePidFileContent('  98765 \r\n')?.pid).toBe(98765);
  });

  it('JSON 里缺 version 时按 null 处理', () => {
    expect(parsePidFileContent('{"pid":42}')).toEqual({ pid: 42, version: null });
  });

  it('拒绝非法内容', () => {
    expect(parsePidFileContent('')).toBeNull();
    expect(parsePidFileContent('not-a-pid')).toBeNull();
    expect(parsePidFileContent('{"nope":1}')).toBeNull();
    expect(parsePidFileContent('{"pid":"46060"}')).toBeNull();
    expect(parsePidFileContent('{"pid":-1}')).toBeNull();
    expect(parsePidFileContent('{ 坏掉的 json')).toBeNull();
  });

  it('不会把 JSON 正文当数字解析出错误 PID', () => {
    // 这是 proxy 侧原实现的缺陷：parseInt('{"pid":46060,...}') 恒为 NaN
    expect(parsePidFileContent('{"pid":46060,"version":"1.1.0"}')?.pid).toBe(46060);
  });
});

describe('looksLikeOurDaemon', () => {
  it('认得 npx 安装布局', () => {
    const cmd =
      'D:\\develop\\environment\\nodejs\\node.exe D:\\...\\_npx\\9406a92453a78ed2\\node_modules\\@keysqiu\\mcpdog\\dist\\cli\\cli-main.js daemon start --config ...';
    expect(looksLikeOurDaemon(cmd)).toBe(true);
  });

  it('认得桌面版内嵌布局', () => {
    const cmd =
      '"\\\\?\\E:\\software\\MCPDog\\node\\node.exe" \\\\?\\E:\\software\\MCPDog\\app\\dist\\cli\\cli-main.js daemon start --config C:\\Users\\Keysqiu\\.mcpdog\\mcpdog.config.json';
    expect(looksLikeOurDaemon(cmd)).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(looksLikeOurDaemon('...\\CLI-MAIN.JS daemon start')).toBe(true);
  });

  it('无关进程判为 false（本次线上事故的实际命令行）', () => {
    const workbuddy =
      '"E:\\software\\WorkBuddy\\WorkBuddy.exe" --type=gpu-process --no-sandbox --user-data-dir="C:\\Users\\Keysqiu\\.workbuddy\\app"';
    expect(looksLikeOurDaemon(workbuddy)).toBe(false);
  });

  it('仅路径里含 mcpdog 但不含 cli-main.js 时判为 false', () => {
    // 曾经的实现还接受裸 `mcpdog` 子串，任何从 MCPDog 目录启动的 node 进程都会误判
    expect(looksLikeOurDaemon('E:\\software\\MCPDog\\node\\node.exe some-other-script.js')).toBe(
      false,
    );
  });

  it('读不到命令行时判为 false（无法确认）', () => {
    expect(looksLikeOurDaemon(null)).toBe(false);
    expect(looksLikeOurDaemon(undefined)).toBe(false);
    expect(looksLikeOurDaemon('')).toBe(false);
    expect(looksLikeOurDaemon('   ')).toBe(false);
  });
});
