import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { getFetchSafePort } from '../utils/test-safe-port.js';
import { McpHttpEndpoint } from './mcp-http-endpoint.js';

/**
 * DELETE 的失败路径曾在**不关闭 transport** 的情况下就把 session 从表里删掉，
 * 于是它持有的 SSE 流再也无人能碰：不在 sessions 里，reapIdleSessions 和 close()
 * 都够不着，流一直开着，http.close() 的回调永不触发 —— `daemon stop()` 挂住只能强杀。
 *
 * 触发条件是 SDK 的校验失败（它只 `return`，不抛异常也不 close）：例如协议版本不被支持。
 * 下面用真实 http server + 真实的 SDK transport 复现该路径。
 */
const TOOL = {
  name: 'fake-tool',
  description: '测试用工具',
  inputSchema: { type: 'object', properties: {} },
};

async function startEndpoint() {
  const endpoint = new McpHttpEndpoint({
    serverName: 'mcpdog',
    serverVersion: 'test',
    listTools: async () => [TOOL],
    callTool: async () => ({ ok: true, result: { content: [{ type: 'text', text: 'pong' }] } }),
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

describe('McpHttpEndpoint：DELETE 失败路径不得泄漏 SSE 流', () => {
  let ctx: Awaited<ReturnType<typeof startEndpoint>> | null = null;

  afterEach(async () => {
    await ctx?.stop();
    ctx = null;
    vi.restoreAllMocks();
  });

  it('协议版本不被支持导致 DELETE 失败时，会话仍被回收且 SSE 流被关闭', async () => {
    ctx = await startEndpoint();

    // 1) 建立会话
    const init = await fetch(ctx.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_BODY),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();

    // 2) 开一条 standalone SSE 流（长连接，响应不会自己结束）
    const sseRes = await fetch(ctx.url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sid! },
    });
    expect(sseRes.status).toBe(200);
    let sseClosed = false;
    void sseRes.text().then(() => {
      sseClosed = true;
    });

    // 3) 用不支持的协议版本发 DELETE —— SDK 会在校验处 return，不 close
    const del = await fetch(ctx.url, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid!,
        'mcp-protocol-version': '1999-01-01',
      },
    });
    // SDK 拒绝该请求（400）；无论状态码如何，关键是不留下泄漏的流
    expect([200, 400]).toContain(del.status);

    // 4) 会话必须已被回收：既不在表里，也不该再有开着的 SSE 流
    expect(ctx.endpoint.sessionCount).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(sseClosed).toBe(true);
  });

  it('正常 DELETE 关闭会话后，close() 能立即完成（不被悬挂的流阻塞）', async () => {
    ctx = await startEndpoint();

    const init = await fetch(ctx.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_BODY),
    });
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();

    const del = await fetch(ctx.url, {
      method: 'DELETE',
      headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': sid! },
    });
    expect(del.status).toBe(200);
    expect(ctx.endpoint.sessionCount).toBe(0);
  });
});
