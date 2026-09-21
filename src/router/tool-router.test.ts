import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRouter } from './tool-router';
import { EventEmitter } from 'events';
import { MCPTool, MCPResponse, ServerAdapter, MCPRequest } from '../types';

// Mock ServerAdapter
class MockAdapter extends EventEmitter implements ServerAdapter {
  name: string;
  config: any;
  isConnected: boolean = false;
  private tools: MCPTool[];

  constructor(name: string, tools: MCPTool[]) {
    super();
    this.name = name;
    this.tools = tools;
    this.config = {};
  }

  connect = vi.fn(async () => {
    this.isConnected = true;
    this.emit('connected');
  });

  disconnect = vi.fn(async () => {
    this.isConnected = false;
    this.emit('disconnected');
  });

  getTools = vi.fn(async () => {
    if (!this.isConnected) throw new Error('Not connected');
    return this.tools;
  });

  callTool = vi.fn(async (toolName: string, args: any): Promise<MCPResponse> => {
    if (!this.isConnected) throw new Error('Not connected');
    return {
      jsonrpc: '2.0',
      id: 1,
      result: { content: `Result from ${this.name}.${toolName}` },
    };
  });

  // Added to satisfy ServerAdapter interface
  sendRequest = vi.fn(async (request: MCPRequest): Promise<MCPResponse> => {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { message: 'Mocked sendRequest' }
    };
  });
}

describe('ToolRouter', () => {
  let toolRouter: ToolRouter;

  beforeEach(() => {
    toolRouter = new ToolRouter();
  });

  it('should add an adapter and refresh routes on connect', async () => {
    const mockTools: MCPTool[] = [{ name: 'tool1', description: 'desc1', inputSchema: { type: 'object' } }];
    const adapter = new MockAdapter('server1', mockTools);
    
    toolRouter.addAdapter(adapter);
    await adapter.connect();

    const allTools = await toolRouter.getAllTools();
    expect(allTools).toHaveLength(1);
    expect(allTools[0].name).toBe('tool1');
    expect(toolRouter.getAdapter('server1')).toBe(adapter);
  });

  it('should handle tool name conflicts by prefixing', async () => {
    const tools1: MCPTool[] = [{ name: 'shared_tool', description: 'desc1', inputSchema: { type: 'object' } }];
    const tools2: MCPTool[] = [{ name: 'shared_tool', description: 'desc2', inputSchema: { type: 'object' } }];
    const adapter1 = new MockAdapter('server1', tools1);
    const adapter2 = new MockAdapter('server2', tools2);

    toolRouter.addAdapter(adapter1);
    toolRouter.addAdapter(adapter2);

    await adapter1.connect();
    await adapter2.connect();

    const allTools = await toolRouter.getAllTools();
    expect(allTools).toHaveLength(2);
    
    const toolNames = allTools.map(t => t.name).sort();
    expect(toolNames).toEqual(['server1-shared_tool', 'server2-shared_tool']);
  });

  it('should route a tool call to the correct adapter', async () => {
    const tools1: MCPTool[] = [{ name: 'tool1', description: 'desc1', inputSchema: { type: 'object' } }];
    const tools2: MCPTool[] = [{ name: 'tool2', description: 'desc2', inputSchema: { type: 'object' } }];
    const adapter1 = new MockAdapter('server1', tools1);
    const adapter2 = new MockAdapter('server2', tools2);

    toolRouter.addAdapter(adapter1);
    toolRouter.addAdapter(adapter2);

    await adapter1.connect();
    await adapter2.connect();

    // Need to manually trigger route creation for testing since it happens on 'connect' event
    // @ts-ignore - access private method for test
    await toolRouter.refreshToolRoutes('server1');
    // @ts-ignore
    await toolRouter.refreshToolRoutes('server2');

    const response = await toolRouter.callTool('tool2', {});
    expect(response.result.content).toBe('Result from server2.tool2');
    expect(adapter2.callTool).toHaveBeenCalledWith('tool2', {});
    expect(adapter1.callTool).not.toHaveBeenCalled();
  });

  it('should return an error if a tool is not found', async () => {
    const response = await toolRouter.callTool('non_existent_tool', {});
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toContain('Tool not found');
  });

  it('should hide tools and refuse calls when an adapter disconnects', async () => {
    const mockTools: MCPTool[] = [{ name: 'tool1', description: 'desc1', inputSchema: { type: 'object' } }];
    const adapter = new MockAdapter('server1', mockTools);

    toolRouter.addAdapter(adapter);
    await adapter.connect();

    let allTools = await toolRouter.getAllTools();
    expect(allTools).toHaveLength(1);

    // 掉线：工具必须从对外清单里消失，调用必须被拒。
    //
    // 这里不再断言 findToolRoute 返回 undefined —— 路由条目刻意保留：
    // 路由键（是否带 serverName- 前缀）取决于「哪些服务器提供了同名工具」，
    // 掉线就清缓存会让别的服务器同名工具在 `alpha-x` 与裸名 `x` 之间反复跳变，
    // 客户端手里的名字在重连窗口内失效（默认退避 5s）。
    // 对外可见性由 getAllTools（只遍历已连接 adapter）与 callTool 的
    // 「Server not connected」共同保证。
    adapter.isConnected = false;
    adapter.emit('disconnected');

    allTools = await toolRouter.getAllTools(true);
    expect(allTools).toHaveLength(0);

    const res = await toolRouter.callTool('tool1', {});
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('Server not connected');
  });

  it('should not block fast adapters when a slow adapter is refreshed in parallel', async () => {
    // 3 个慢 adapter 各 1200ms：并行总耗时 ≈1.2s（max），串行实现累计 ≈3.6s（Σ）
    const makeSlow = (name: string) => {
      const tools: MCPTool[] = [{ name: `tool_${name}`, description: name, inputSchema: { type: 'object' } }];
      const adapter = new MockAdapter(name, tools);
      adapter.getTools = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        return tools;
      });
      return adapter;
    };
    const s1 = makeSlow('s1');
    const s2 = makeSlow('s2');
    const s3 = makeSlow('s3');

    toolRouter.addAdapter(s1);
    toolRouter.addAdapter(s2);
    toolRouter.addAdapter(s3);
    await s1.connect();
    await s2.connect();
    await s3.connect();

    const start = Date.now();
    const allTools = await toolRouter.getAllTools(true); // force refresh 走实时拉取
    const elapsed = Date.now() - start;

    // 串行实现会累计到 ~3.6s；并行实现 ~1.2s，留出余量断言
    expect(elapsed).toBeLessThan(2500);
    expect(allTools.map(t => t.name)).toEqual(['tool_s1', 'tool_s2', 'tool_s3']);
  });

  it('should keep other servers\u2019 tools when one adapter fails to fetch', async () => {
    const okTools: MCPTool[] = [{ name: 'ok_tool', description: 'ok', inputSchema: { type: 'object' } }];
    const broken = new MockAdapter('broken', []);
    const ok = new MockAdapter('ok', okTools);

    broken.getTools = vi.fn(async (): Promise<MCPTool[]> => {
      throw new Error('connection refused');
    });

    toolRouter.addAdapter(broken);
    toolRouter.addAdapter(ok);
    await broken.connect();
    await ok.connect();

    const allTools = await toolRouter.getAllTools(true);

    expect(allTools.map(t => t.name)).toContain('ok_tool');
    expect(broken.getTools).toHaveBeenCalled();
  });
});