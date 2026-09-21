import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { ToolRouter } from './tool-router.js';
import type { MCPTool, MCPResponse, ServerAdapter } from '../types/index.js';

/**
 * 工具名冲突与「服务器自带前缀风格的名字」这些组合下的路由正确性。
 *
 * 线上风险是**静默误路由**：调用方请求 A 服务器的某个工具，实际执行的是另一个工具。
 * 这比报「工具不存在」危险得多，所以下面每条都断言到「到底哪个工具的哪个参数被执行」。
 */
class MockAdapter extends EventEmitter implements ServerAdapter {
  name: string;
  config: any = {};
  isConnected = true;
  calls: Array<{ tool: string; args: any }> = [];
  private tools: MCPTool[];

  constructor(name: string, toolNames: string[]) {
    super();
    this.name = name;
    this.tools = toolNames.map((n) => ({
      name: n,
      description: `${name} 的 ${n}`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  async connect() {
    this.isConnected = true;
    this.emit('connected');
  }
  async disconnect() {
    this.isConnected = false;
    this.emit('disconnected');
  }
  async getTools() {
    return this.tools;
  }
  async callTool(toolName: string, args: any): Promise<MCPResponse> {
    this.calls.push({ tool: toolName, args });
    return { jsonrpc: '2.0', id: 1, result: { content: `${this.name}.${toolName}` } } as MCPResponse;
  }
  async sendRequest(): Promise<MCPResponse> {
    return { jsonrpc: '2.0', id: 1, result: {} } as MCPResponse;
  }
  getStatus() {
    return { name: this.name, connected: this.isConnected, toolCount: 0, pendingRequests: 0, endpoint: '' };
  }
}

/** 建一个 router 并把 adapter 连上（触发路由构建） */
async function buildRouter(servers: Array<{ name: string; tools: string[] }>) {
  const router = new ToolRouter();
  const adapters = new Map<string, MockAdapter>();
  for (const s of servers) {
    const a = new MockAdapter(s.name, s.tools);
    adapters.set(s.name, a);
    router.addAdapter(a);
    await a.connect();
  }
  // 触发工具拉取与路由构建
  await router.getAllTools(true);
  return { router, adapters };
}

describe('ToolRouter：工具名冲突与误路由', () => {
  it('服务器自带「本服务器名-」前缀的工具名不会被误剥（避免静默调用另一个工具）', async () => {
    // files 服务器同时有 `read` 和 `files-read`：后者名字自带前缀但不是冲突产生的
    const { router, adapters } = await buildRouter([
      { name: 'files', tools: ['read', 'files-read'] },
    ]);
    const files = adapters.get('files')!;

    const res = await router.callTool('files-read', { path: 'x' });
    expect(res.result).toBeTruthy();

    // 必须调用下游的 `files-read`，而不是被剥成 `read`
    expect(files.calls).toHaveLength(1);
    expect(files.calls[0].tool).toBe('files-read');
  });

  it('跨服务器重名时两侧都带前缀，且各自路由到正确的服务器', async () => {
    const { router, adapters } = await buildRouter([
      { name: 'alpha', tools: ['shared'] },
      { name: 'beta', tools: ['shared'] },
    ]);

    const tools = await router.getAllTools(true);
    const names = tools.map((t) => t.name).sort();
    // 两个都加前缀，不再有裸名
    expect(names).toEqual(['alpha-shared', 'beta-shared']);

    await router.callTool('alpha-shared', {});
    await router.callTool('beta-shared', {});
    expect(adapters.get('alpha')!.calls[0].tool).toBe('shared');
    expect(adapters.get('beta')!.calls[0].tool).toBe('shared');
  });

  it('展示给客户端的名字与路由键一致：每个列出的工具都真的可调用', async () => {
    // A 有 `x` 与 `B-x`，B 有 `x` —— 这是旧实现产出重名条目与不可达工具的组合
    const { router } = await buildRouter([
      { name: 'A', tools: ['x', 'B-x'] },
      { name: 'B', tools: ['x'] },
    ]);

    const tools = await router.getAllTools(true);
    const names = tools.map((t) => t.name);

    // 不能有重名
    expect(new Set(names).size).toBe(names.length);

    // 每个展示出来的名字都必须能路由到（findToolRoute 命中）
    for (const name of names) {
      expect(router.findToolRoute(name), `展示的工具 ${name} 必须可路由`).toBeDefined();
    }
  });

  it('某服务器消失后，其余服务器重名工具的路由键会跟着回退（不留陈旧键）', async () => {
    const { router, adapters } = await buildRouter([
      { name: 'alpha', tools: ['shared'] },
      { name: 'beta', tools: ['shared'] },
    ]);
    expect((await router.getAllTools(true)).map((t) => t.name).sort()).toEqual([
      'alpha-shared',
      'beta-shared',
    ]);

    // beta 整体下线：alpha 的 `shared` 不再重名，应回到裸名
    router.removeAdapter('beta');
    await router.getAllTools(true);

    const names = (await router.getAllTools(true)).map((t) => t.name);
    expect(names).toEqual(['shared']);
    // 旧的带前缀键不能还留着，否则客户端可能拿到一个指向已移除 adapter 的名字
    expect(router.findToolRoute('alpha-shared')).toBeUndefined();
    expect(router.findToolRoute('shared')).toBeDefined();
  });

  it('blacklist 模式按 disabledTools 判定，被禁工具不出现且调用被拒', async () => {
    const router = new ToolRouter({
      getConfig: () => ({
        servers: {
          srv: {
            toolsConfig: { mode: 'blacklist', disabledTools: ['bad'] },
          },
        },
      }),
    } as any);
    const a = new MockAdapter('srv', ['good', 'bad']);
    router.addAdapter(a);
    await a.connect();
    await router.getAllTools(true);

    expect((await router.getAllTools()).map((t) => t.name)).toEqual(['good']);
  });

  it('whitelist 模式按 enabledTools 判定，未列出的工具不出现（与界面判定一致）', async () => {
    const router = new ToolRouter({
      getConfig: () => ({
        servers: {
          srv: {
            toolsConfig: { mode: 'whitelist', enabledTools: ['good'] },
          },
        },
      }),
    } as any);
    const a = new MockAdapter('srv', ['good', 'other']);
    router.addAdapter(a);
    await a.connect();
    await router.getAllTools(true);

    expect((await router.getAllTools()).map((t) => t.name)).toEqual(['good']);
  });

  it('toolSettings 的逐工具开关优先于模式默认值', async () => {
    const router = new ToolRouter({
      getConfig: () => ({
        servers: {
          srv: {
            toolsConfig: {
              mode: 'all',
              toolSettings: { off: { enabled: false } },
            },
          },
        },
      }),
    } as any);
    const a = new MockAdapter('srv', ['on', 'off']);
    router.addAdapter(a);
    await a.connect();
    await router.getAllTools(true);

    expect((await router.getAllTools()).map((t) => t.name)).toEqual(['on']);
  });

  it('被禁用的工具不只在列表里隐藏，也必须无法调用（客户端可能持有旧清单）', async () => {
    const router = new ToolRouter({
      getConfig: () => ({
        servers: {
          srv: {
            toolsConfig: { mode: 'blacklist', disabledTools: ['danger'] },
          },
        },
      }),
    } as any);
    const a = new MockAdapter('srv', ['safe', 'danger']);
    router.addAdapter(a);
    await a.connect();
    await router.getAllTools(true);

    expect((await router.getAllTools()).map((t) => t.name)).toEqual(['safe']);

    // 知道名字也不能绕过开关 —— 否则「禁用工具」这个管控形同虚设
    const res = await router.callTool('danger', {});
    expect(res.error).toBeDefined();
    expect(a.calls).toHaveLength(0);

    // 启用中的工具照常可调用
    await router.callTool('safe', {});
    expect(a.calls).toHaveLength(1);
  });

  it('下游返回重复工具名时不产出重名条目（展示与路由都只保留第一个）', async () => {
    const { router } = await buildRouter([{ name: 'srv', tools: ['dup', 'dup', 'other'] }]);

    const names = (await router.getAllTools(true)).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(router.findToolRoute(name), `${name} 必须可路由`).toBeDefined();
    }
  });

  it('下游把工具删空后，旧工具不再对外提供', async () => {
    const router = new ToolRouter();
    const a = new MockAdapter('srv', ['a', 'b']);
    router.addAdapter(a);
    await a.connect();
    expect((await router.getAllTools(true)).map((t) => t.name).sort()).toEqual(['a', 'b']);

    // 下游答了 tools/list 但已经是空列表：必须如实反映，不能继续用旧缓存
    (a as any).tools = [];
    const names = (await router.getAllTools(true)).map((t) => t.name);
    expect(names).toEqual([]);
  });

  it('路由键与下游 tools/list 的顺序无关（重排不得改变名字指向哪个工具）', async () => {
    // 这是「静默误执行」的温床：同一批工具换个次序若导致路由键互换，
    // 客户端手里的名字就会在两次刷新之间指向不同的下游工具。
    const run = async (filesToolOrder: string[]) => {
      const { router, adapters } = await buildRouter([
        { name: 'files', tools: filesToolOrder },
        { name: 'other', tools: ['read'] },
      ]);
      const tools = await router.getAllTools(true);
      const mapping: Record<string, string> = {};
      for (const t of tools.map((x) => x.name).sort()) {
        const res: any = await router.callTool(t, {});
        // 下游回的内容是 `${serverName}.${toolName}`，据此判定实际执行了谁
        mapping[t] = String(res.result?.content ?? '');
      }
      void adapters;
      return mapping;
    };

    const a = await run(['read', 'files-read']);
    const b = await run(['files-read', 'read']);

    // 名字集合必须一致
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // 而且每个名字指向的下游工具也必须一致
    expect(a).toEqual(b);
  });
});
