import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigManager } from '../config/config-manager.js';
import { AdapterFactory } from '../adapters/adapter-factory.js';
import { MCPDogServer } from './mcpdog-server.js';
import type { MCPServerConfig, ServerAdapter } from '../types/index.js';

/** 不 spawn 任何子进程的假 adapter，只用于观察「谁被重建了」 */
class FakeAdapter extends EventEmitter implements ServerAdapter {
  public isConnected = false;

  constructor(
    public readonly name: string,
    public readonly config: MCPServerConfig,
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.isConnected = true;
    this.emit('connected', { serverName: this.name });
  }
  async disconnect(): Promise<void> {
    this.isConnected = false;
  }
  async getTools() {
    return [];
  }
  async callTool() {
    return { jsonrpc: '2.0' as const, id: 1, result: {} };
  }
  async sendRequest() {
    return { jsonrpc: '2.0' as const, id: 1, result: {} };
  }
}

describe('配置变更时的 adapter 重建', () => {
  let dir: string;
  let configPath: string;
  let cm: ConfigManager;
  let server: MCPDogServer;
  let created: FakeAdapter[];
  let connectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpdog-reinit-'));
    configPath = join(dir, 'mcpdog.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0.0',
        servers: {
          'server-a': { name: 'server-a', enabled: true, transport: 'stdio', command: 'cmd-a' },
          'server-b': { name: 'server-b', enabled: true, transport: 'stdio', command: 'cmd-b' },
        },
      }),
    );

    cm = new ConfigManager(configPath, false);
    await cm.loadConfig();

    created = [];
    vi.spyOn(AdapterFactory, 'createAdapter').mockImplementation((name, config) => {
      const adapter = new FakeAdapter(name, config);
      created.push(adapter);
      return adapter;
    });

    server = new MCPDogServer(cm);
    // 连接编排在后台跑且会真的去 connect，这里只关心「有没有被触发」
    connectSpy = vi.spyOn(server as any, 'connectAdaptersInBackground').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const reinit = () => (server as any).reinitializeAdapters();
  const adapterOf = (name: string) => (server as any).toolRouter.getAdapter(name);

  it('首次初始化会为每个启用的 server 建 adapter，并触发一次连接编排', async () => {
    await reinit();

    expect(created.map((a) => a.name).sort()).toEqual(['server-a', 'server-b']);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('只改一个 server 的连接参数时，只重建它，其他 server 的 adapter 保持原对象', async () => {
    await reinit();
    const adapterABefore = adapterOf('server-a');
    const adapterBBefore = adapterOf('server-b');
    created.length = 0;
    connectSpy.mockClear();

    // 模拟文件监听路径：配置整体重读，所有 server 都是新对象
    const servers = cm.getServers();
    servers['server-b'] = { ...servers['server-b'], command: 'cmd-b-changed' };

    await reinit();

    expect(created.map((a) => a.name)).toEqual(['server-b']); // 只重建了 b
    expect(adapterOf('server-b')).not.toBe(adapterBBefore);
    expect(adapterOf('server-a')).toBe(adapterABefore); // a 的连接没被动过
    expect(connectSpy).toHaveBeenCalledTimes(1); // 仅为 b 触发一次编排
  });

  it('只改工具开关时不重建任何 adapter，也不触发连接编排', async () => {
    await reinit();
    const adapterABefore = adapterOf('server-a');
    created.length = 0;
    connectSpy.mockClear();

    const servers = cm.getServers();
    servers['server-a'] = {
      ...servers['server-a'],
      toolsConfig: { mode: 'blacklist', disabledTools: ['some-tool'] },
    };

    await reinit();

    expect(created).toEqual([]);
    expect(adapterOf('server-a')).toBe(adapterABefore);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('移除 server 后只摘掉它的 adapter', async () => {
    await reinit();
    const adapterABefore = adapterOf('server-a');
    created.length = 0;
    connectSpy.mockClear();

    delete cm.getServers()['server-b'];

    await reinit();

    expect(adapterOf('server-b')).toBeUndefined();
    expect(adapterOf('server-a')).toBe(adapterABefore);
    expect(created).toEqual([]);
  });
});
