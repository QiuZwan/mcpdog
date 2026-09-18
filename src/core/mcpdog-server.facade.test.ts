import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigManager } from '../config/config-manager.js';
import { MCPDogServer } from './mcpdog-server.js';

/** 用一个已连上的假 ToolRouter 替掉真实现，避免 spawn 子进程 */
function stubRouter(server: MCPDogServer, tools: any[]) {
  const router: any = server.getToolRouter();
  vi.spyOn(router, 'getAllTools').mockResolvedValue(tools);
  vi.spyOn(router, 'getConnectedServerCount').mockReturnValue(1);
  vi.spyOn(router, 'getTotalServerCount').mockReturnValue(1);
  vi.spyOn(router, 'getToolDistribution').mockReturnValue({ fake: tools.length });
  return router;
}

const FAKE_TOOL = {
  name: 'fake-tool',
  description: '测试用工具',
  inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
};

describe('MCPDogServer 门面方法', () => {
  let dir: string;
  let configPath: string;
  let server: MCPDogServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpdog-facade-'));
    configPath = join(dir, 'mcpdog.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0.0',
        servers: {
          fake: {
            name: 'fake',
            enabled: true,
            transport: 'stdio',
            command: 'node',
            args: ['-e', ''],
          },
        },
      }),
    );
    const cm = new ConfigManager(configPath);
    await cm.loadConfig();
    server = new MCPDogServer(cm);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('listToolsResult 返回工具数组本身，不带 JSON-RPC 信封', async () => {
    stubRouter(server, [FAKE_TOOL]);
    const tools = await server.listToolsResult();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0].name).toBe('fake-tool');
    expect(tools[0].inputSchema.required).toEqual(['a']);
    // 不得出现信封字段
    expect((tools as any).jsonrpc).toBeUndefined();
    expect((tools as any).result).toBeUndefined();
  });

  it('listToolsResult 在未初始化时仍可用（守卫属于 JSON-RPC 路径）', async () => {
    stubRouter(server, [FAKE_TOOL]);
    // 刻意不调用 handleRequest(initialize)
    const tools = await server.listToolsResult();
    expect(tools).toHaveLength(1);
  });

  it('callToolResult 成功时返回 ok:true 与原始结果', async () => {
    const router = stubRouter(server, [FAKE_TOOL]);
    vi.spyOn(router, 'callTool').mockResolvedValue({
      jsonrpc: '2.0',
      id: 0,
      result: { content: [{ type: 'text', text: 'pong' }] },
    });
    const outcome = await server.callToolResult('fake-tool', { a: '1' });
    expect(outcome).toEqual({ ok: true, result: { content: [{ type: 'text', text: 'pong' }] } });
  });

  it('callToolResult 失败时返回 ok:false 与原始 code', async () => {
    const router = stubRouter(server, [FAKE_TOOL]);
    vi.spyOn(router, 'callTool').mockResolvedValue({
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32601, message: 'Tool not found: nope' },
    });
    const outcome = await server.callToolResult('nope', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.code).toBe(-32601);
    expect(outcome.error.message).toContain('Tool not found');
  });

  it('callToolResult 对空工具名返回 -32602，且不触碰 router', async () => {
    const router = stubRouter(server, [FAKE_TOOL]);
    const callSpy = vi.spyOn(router, 'callTool');
    const outcome = await server.callToolResult('', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.code).toBe(-32602);
    expect(callSpy).not.toHaveBeenCalled();
  });
});
