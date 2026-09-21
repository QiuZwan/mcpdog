import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { StreamableHttpAdapter } from './streamable-http-adapter.js';
import type { MCPServerConfig } from '../types/index.js';

/**
 * 会话失效后的自愈。
 *
 * 线上那次 ssh-server 永久卡死是：适配器收到 404 只清空 sessionId、从不重新握手，
 * 此后请求不再带会话头，下游（rmcp）对无会话的非 initialize 请求回 422
 * 「Unexpected message, expect initialize request」——422 又不在任何恢复分支里，
 * 于是每一次调用都撞 422；同时 isConnected 仍为 true，connectAll 认为该 adapter
 * 无需重连，没有任何一层会来修它。下面用一个模拟下游把这些形态按真实顺序复现。
 */
const SESSION_HEADER = 'mcp-session-id';

interface DownstreamState {
  /** 下游当前认可的会话号 */
  validSessionId: string | null;
  /** initialize 被调用的次数 */
  initializeCount: number;
  /** 每个请求路径的调用次数，用于断言重试没有发散 */
  calls: string[];
  /** 强制某个方法返回会话失效（用于测并发与 422 分支） */
  forceSessionLossOn?: (method: string) => '404' | '422' | null;
}

function startFakeDownstream(state: DownstreamState) {
  const server: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      const method: string = body.method || 'unknown';
      const sentSession = req.headers[SESSION_HEADER] as string | undefined;
      state.calls.push(method);

      // 模拟 rmcp：未 initialize 就发别的请求 → 422
      if (method !== 'initialize' && !sentSession) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Unexpected message, expect initialize request',
          })
        );
        return;
      }

      // 模拟会话已失效：下游不认这个会话号 → 404
      if (sentSession && sentSession !== state.validSessionId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: `Session not found: ${sentSession}` })
        );
        return;
      }

      const forced = state.forceSessionLossOn?.(method);
      if (forced === '404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      if (forced === '422') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unexpected message' }));
        return;
      }

      // initialize：建立新会话，session 头随响应下发
      if (method === 'initialize') {
        state.initializeCount++;
        state.validSessionId = `session-${state.initializeCount}`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          [SESSION_HEADER]: state.validSessionId,
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2024-11-05', capabilities: {} },
          })
        );
        return;
      }

      // notifications/initialized 之类：只需 202
      if (!body.id) {
        res.writeHead(202);
        res.end();
        return;
      }

      const result =
        method === 'tools/list'
          ? { tools: [{ name: 'probe-tool', description: 'p', inputSchema: {} }] }
          : { content: [{ type: 'text', text: 'pong' }] };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });

  return {
    server,
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/mcp`;
    },
    async close(): Promise<void> {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function makeConfig(url: string): MCPServerConfig {
  return {
    name: 'session-probe',
    enabled: true,
    transport: 'streamable-http',
    url,
    timeout: 5000,
  } as MCPServerConfig;
}

describe('StreamableHttpAdapter：会话失效后的自愈', () => {
  let adapter: StreamableHttpAdapter | null = null;
  let downstream: ReturnType<typeof startFakeDownstream> | null = null;

  afterEach(async () => {
    await adapter?.disconnect().catch(() => {});
    await downstream?.close().catch(() => {});
    adapter = null;
    downstream = null;
  });

  async function setup(): Promise<{ adapter: StreamableHttpAdapter; state: DownstreamState }> {
    const state: DownstreamState = { validSessionId: null, initializeCount: 0, calls: [] };
    downstream = startFakeDownstream(state);
    const url = await downstream.listen();
    adapter = new StreamableHttpAdapter('session-probe', makeConfig(url));
    return { adapter, state };
  }

  it('会话失效（404）后自动重新握手，下一次调用恢复正常而不是永久 422', async () => {
    const { adapter, state } = await setup();
    await adapter.connect();
    expect(state.initializeCount).toBe(1);

    // 下游丢掉会话（重启/回收），适配器手里的会话号随之失效
    state.validSessionId = 'a-different-session';

    // 这一次调用会撞 404，适配器应自愈并在同一次调用内重试成功
    const result = await adapter.callTool('probe-tool', {});
    expect(result.result).toBeTruthy();
    expect(state.initializeCount).toBe(2);

    // 关键：恢复后必须能持续工作，而不是「清空会话号 → 从此每次都 422」
    const again = await adapter.getTools();
    expect(again).toHaveLength(1);
    // 后续请求不应再触发额外的 initialize
    expect(state.initializeCount).toBe(2);
  });

  it('会话号已被清空时撞 422，同样会重新握手', async () => {
    const { adapter, state } = await setup();
    await adapter.connect();

    // 制造「无会话可发」的形态：让下游拒绝，适配器清空会话号
    state.forceSessionLossOn = () => '404';
    await expect(adapter.callTool('probe-tool', {})).rejects.toThrow();

    // 此后 adapter 已无会话号；下游对无会话请求回 422。
    // 修复前：422 不进任何恢复分支，每次调用都失败且没有任何一层会重连。
    state.forceSessionLossOn = undefined;
    const result = await adapter.callTool('probe-tool', {});
    expect(result.result).toBeTruthy();
  });

  it('并发请求同时撞上会话失效时，只重建一次会话', async () => {
    const { adapter, state } = await setup();
    await adapter.connect();
    expect(state.initializeCount).toBe(1);

    state.validSessionId = 'a-different-session';

    // 多个在途请求同时拿到 404：不加闩会各自 initialize，后建立的会话顶掉先建立的
    const results = await Promise.all([
      adapter.callTool('probe-tool', {}),
      adapter.getTools(),
      adapter.callTool('probe-tool', {}),
    ]);

    expect(results.every((r) => r !== undefined)).toBe(true);
    expect(state.initializeCount).toBe(2);
  });

  it('会话管理被显式关闭时，422 不触发重建（它是请求本身的问题）', async () => {
    const state: DownstreamState = { validSessionId: null, initializeCount: 0, calls: [] };
    downstream = startFakeDownstream(state);
    const url = await downstream.listen();
    adapter = new StreamableHttpAdapter('session-probe', {
      ...makeConfig(url),
      sessionMode: 'disabled',
    } as MCPServerConfig);

    await adapter.connect();
    expect(state.initializeCount).toBe(1);

    state.forceSessionLossOn = () => '422';
    await expect(adapter.callTool('probe-tool', {})).rejects.toThrow();
    // 不因 422 重建会话
    expect(state.initializeCount).toBe(1);
  });

  it('initialize 自身的失败不会被当成会话失效而递归重试', async () => {
    const state: DownstreamState = { validSessionId: null, initializeCount: 0, calls: [] };
    downstream = startFakeDownstream(state);
    const url = await downstream.listen();
    adapter = new StreamableHttpAdapter('session-probe', makeConfig(url));

    // 让 initialize 永远失败：必须直接抛出，而不是反复自愈
    state.forceSessionLossOn = (method) => (method === 'initialize' ? '404' : null);

    await expect(adapter.connect()).rejects.toThrow();
    // 只有最初那次 initialize；没有因「恢复」而反复重试
    expect(state.calls.filter((m) => m === 'initialize')).toHaveLength(1);
  });
});
