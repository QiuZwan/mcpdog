import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { getFetchSafePort } from '../utils/test-safe-port.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpHttpEndpoint } from './mcp-http-endpoint.js';

const TOOL = {
  name: 'fake-tool',
  description: '测试用工具',
  inputSchema: { type: 'object', properties: {} },
};

/** 起一个真实 http server 把 McpHttpEndpoint 挂上去，用 fetch 走真实 HTTP 路径 */
async function startEndpoint(overrides: Partial<any> = {}) {
  const endpoint = new McpHttpEndpoint({
    serverName: 'mcpdog',
    serverVersion: 'test',
    listTools: async () => [TOOL],
    callTool: async () => ({ ok: true, result: { content: [{ type: 'text', text: 'pong' }] } }),
    ...overrides,
  });
  const http: HttpServer = createServer((req, res) => {
    void endpoint.handleRequest(req, res);
  });
  // 显式取 fetch 可用端口：listen(0) 可能落到 WHATWG 阻止端口，
  // 而 Node 的 fetch 会直接以 bad port 失败（端口本身可绑定）→ 测试随机挂
  const port = await getFetchSafePort();
  await new Promise<void>((r) => http.listen(port, '127.0.0.1', () => r()));
  return {
    endpoint,
    url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      await endpoint.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  },
};

function post(url: string, body: unknown, sessionId?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** 从 SSE 或 JSON 响应里取第一个 JSON-RPC 报文 */
async function readMessage(res: Response): Promise<any> {
  const text = await res.text();
  if (text.trimStart().startsWith('event:') || text.includes('data:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse((line ?? '').replace(/^data:\s*/, ''));
  }
  return JSON.parse(text);
}

describe('McpHttpEndpoint', () => {
  let ctx: Awaited<ReturnType<typeof startEndpoint>> | null = null;

  afterEach(async () => {
    await ctx?.stop();
    ctx = null;
    vi.restoreAllMocks();
  });

  it('initialize 建立 session，返回 mcp-session-id 头', async () => {
    ctx = await startEndpoint();
    const res = await post(ctx.url, INIT_BODY);
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    expect(ctx.endpoint.sessionCount).toBe(1);
  });

  it('带 session 的 tools/list 返回真实工具', async () => {
    ctx = await startEndpoint();
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;

    // 通知 initialized，再列工具
    await post(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const res = await post(ctx.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    const msg = await readMessage(res);
    expect(msg.result.tools[0].name).toBe('fake-tool');
  });

  it('无 session 的非 initialize 请求返回 400，且临时 transport 被关闭', async () => {
    ctx = await startEndpoint();
    // sessionCount 只反映已建立 session 的池，临时 transport 不经过 onsessioninitialized，
    // 因此它必须靠直接观察 close() 才能真正验证"不泄漏"这条约束。
    // 本用例全程不会建立 session，所以任何一次 close() 都只可能来自那个临时 transport。
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');

    const res = await post(ctx.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(res.status).toBe(400);
    expect(ctx.endpoint.sessionCount).toBe(0);
    // 响应可能先于 handleRequest 的 finally 到达客户端，故等待而非立即断言；
    // 若 finally 里的兜底清理被移除，这里会超时失败。
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
  });

  it('未知 session id 返回 404', async () => {
    ctx = await startEndpoint();
    const res = await post(ctx.url, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'not-a-real-session');
    expect(res.status).toBe(404);
  });

  it('tools/call 成功时把工具结果原样回给客户端', async () => {
    ctx = await startEndpoint();
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;
    await post(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    const res = await post(
      ctx.url,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fake-tool', arguments: {} } },
      sid,
    );
    const msg = await readMessage(res);
    expect(msg.result.isError).toBeUndefined();
    expect(msg.result.content[0].text).toBe('pong');
  });

  it('tools/call 失败时返回 isError 结果而非协议级异常', async () => {
    ctx = await startEndpoint({
      callTool: async () => ({ ok: false, error: { code: -32601, message: 'Tool not found: nope' } }),
    });
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;
    await post(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    const res = await post(
      ctx.url,
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      sid,
    );
    const msg = await readMessage(res);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toContain('Tool not found');
  });

  it('result 不是合法 CallToolResult 时包成文本内容', async () => {
    ctx = await startEndpoint({ callTool: async () => ({ ok: true, result: { plain: 'value' } }) });
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;
    await post(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    const res = await post(
      ctx.url,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fake-tool', arguments: {} } },
      sid,
    );
    const msg = await readMessage(res);
    expect(msg.result.content[0].type).toBe('text');
    expect(msg.result.content[0].text).toContain('plain');
  });

  it('DELETE 关闭 session 并从池中移除', async () => {
    ctx = await startEndpoint();
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;
    expect(ctx.endpoint.sessionCount).toBe(1);

    const res = await fetch(ctx.url, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    expect([200, 204]).toContain(res.status);
    expect(ctx.endpoint.sessionCount).toBe(0);
  });

  it('GET 携带非法 session 返回 404', async () => {
    ctx = await startEndpoint();
    const res = await fetch(ctx.url, { method: 'GET', headers: { 'mcp-session-id': 'bogus' } });
    expect(res.status).toBe(404);
  });

  it('close() 清空全部 session', async () => {
    ctx = await startEndpoint();
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    expect(ctx.endpoint.sessionCount).toBe(1);
    await ctx.endpoint.close();
    expect(ctx.endpoint.sessionCount).toBe(0);
  });

  it('notifyToolsChanged 向活跃 session 推送 notifications/tools/list_changed', async () => {
    ctx = await startEndpoint();
    const init = await post(ctx.url, INIT_BODY);
    await readMessage(init);
    const sid = init.headers.get('mcp-session-id')!;
    await post(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    // 打开 GET SSE 流
    const ac = new AbortController();
    const streamRes = await fetch(ctx.url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sid },
      signal: ac.signal,
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntilNotification = (async () => {
      while (!received.includes('notifications/tools/list_changed')) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    })();

    await ctx.endpoint.notifyToolsChanged();
    await Promise.race([
      readUntilNotification,
      new Promise((_, rej) => setTimeout(() => rej(new Error('未在 3s 内收到 list_changed')), 3000)),
    ]);

    expect(received).toContain('notifications/tools/list_changed');
    ac.abort();
  });
});
