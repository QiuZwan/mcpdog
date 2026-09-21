/**
 * StreamableHTTP MCP 端点：把 daemon 内唯一的聚合核心以标准协议暴露出去。
 *
 * 与旧实现（已删除的 src/streamable-http-server.ts）的关键差别：
 * 1. 不自己 new MCPDogServer —— 工具清单与工具调用都由调用方注入，
 *    因此全进程只有一个聚合实例，子服务器不会被拉两遍；
 * 2. 走官方 SDK 的 Server + StreamableHTTPServerTransport，协议一致性（session 头、
 *    GET 的 SSE 流、DELETE 关闭、事件回推）由 SDK 保证；
 * 3. 有状态 session，配置热更新后可向已连接客户端推 tools/list_changed。
 */

import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPTool, ToolCallOutcome } from '../types/index.js';

export interface McpHttpEndpointOptions {
  serverName: string;
  serverVersion: string;
  /** 复用聚合核心的工具清单（含等待与重试） */
  listTools: () => Promise<MCPTool[]>;
  /** 复用聚合核心的工具调用（含前缀剥离与路由） */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>;
  /** session 空闲回收阈值，默认 30 分钟 */
  sessionIdleMs?: number;
}

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;

export class McpHttpEndpoint {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionIdleMs: number;
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly options: McpHttpEndpointOptions) {
    this.sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    this.reaper = setInterval(() => void this.reapIdleSessions(), REAP_INTERVAL_MS);
    // 不要让回收定时器把进程按在那里
    this.reaper.unref?.();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 处理 /mcp 的 POST / GET / DELETE。请求体由 SDK 自己读流，不经 body-parser。 */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = this.readSessionId(req);
    const method = (req.method || 'GET').toUpperCase();

    if (sessionId) {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        this.writeJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: `Session not found: ${sessionId}` },
          id: null,
        });
        return;
      }
      entry.lastActivity = Date.now();
      if (method === 'DELETE') {
        // SDK 在校验失败时会在**关闭 transport 之前**就返回 —— 且是正常的 `return`，
        // 不抛异常（见 SDK 的 handleDeleteRequest：validateSession/validateProtocolVersion
        // 失败即 return），所以既不能用异常判断，也不能无条件删条目。
        // 此前用 finally 无条件删除：这一删，transport 与它持有的 SSE 流就再没人能碰到 ——
        // 不在 sessions 里，reapIdleSessions 与 close() 都够不着，流一直开着，
        // http.close() 的回调永不触发，`daemon stop()` 于是挂住只能强杀。
        // 判据改为「SDK 是否真的关掉了它」：正常路径由 SDK 调 close()（会 end 掉所有 SSE 响应），
        // 故用 transport 的 onclose 标记；没关则我们兜底关掉并回收条目。
        let sdkClosedTransport = false;
        const originalOnClose = (entry.transport as any).onclose;
        (entry.transport as any).onclose = () => {
          sdkClosedTransport = true;
          originalOnClose?.();
        };

        try {
          await entry.transport.handleRequest(req, res);
        } catch (error) {
          console.error(`[MCP-HTTP] DELETE 会话失败: ${sessionId}`, error);
        } finally {
          (entry.transport as any).onclose = originalOnClose;
        }

        if (!sdkClosedTransport) {
          // 校验失败等路径没关 transport：必须兜底释放，否则 SSE 流泄漏并挂住停机
          await entry.transport.close().catch(() => {});
        }
        this.sessions.delete(sessionId);
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (method !== 'POST') {
      // GET / DELETE 都必须带 session
      this.writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing mcp-session-id header' },
        id: null,
      });
      return;
    }

    // 无 session 的 POST：只有 initialize 会建立 session；其余情况 SDK 会回 400，
    // 此时必须把临时 transport/server 关掉，避免坏请求累积泄漏。
    await this.handleSessionlessPost(req, res);
  }

  /** 配置热更新（ToolRouter 的 routes-updated）后通知所有活跃 session */
  async notifyToolsChanged(): Promise<void> {
    const notification = { method: 'notifications/tools/list_changed' as const };
    await Promise.allSettled(
      Array.from(this.sessions.values()).map((entry) =>
        entry.server.notification(notification).catch((error) => {
          console.error('[MCP-HTTP] 推送 tools/list_changed 失败:', (error as Error).message);
        }),
      ),
    );
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.transport.close().catch(() => {});
        await entry.server.close().catch(() => {});
      }),
    );
  }

  private async handleSessionlessPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let initializedSessionId: string | null = null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        initializedSessionId = sid;
        this.sessions.set(sid, { server, transport, lastActivity: Date.now() });
        console.error(`[MCP-HTTP] session 建立: ${sid}`);
      },
      onsessionclosed: (sid) => {
        this.sessions.delete(sid);
        console.error(`[MCP-HTTP] session 关闭: ${sid}`);
      },
    });

    const server = this.createServer();
    await server.connect(transport);

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[MCP-HTTP] 处理请求失败:', error);
      if (!res.headersSent) {
        this.writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    } finally {
      if (!initializedSessionId) {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    }
  }

  private createServer(): Server {
    const server = new Server(
      { name: this.options.serverName, version: this.options.serverVersion },
      { capabilities: { tools: { listChanged: true } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await this.options.listTools(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const outcome = await this.options.callTool(name, (args ?? {}) as Record<string, unknown>);

      if (!outcome.ok) {
        // 工具级失败用 isError 结果承载，客户端能拿到原始文案；
        // 抛错会退化成 -32603 并丢掉 code 语义。
        return { content: [{ type: 'text', text: outcome.error.message }], isError: true };
      }

      const result: any = outcome.result;
      if (result && Array.isArray(result.content)) {
        return result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    });

    return server;
  }

  private readSessionId(req: IncomingMessage): string | undefined {
    const raw = req.headers['mcp-session-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && value.trim() ? value.trim() : undefined;
  }

  private async reapIdleSessions(): Promise<void> {
    const deadline = Date.now() - this.sessionIdleMs;
    for (const [sid, entry] of Array.from(this.sessions.entries())) {
      if (entry.lastActivity >= deadline) continue;
      console.error(`[MCP-HTTP] 回收空闲 session: ${sid}`);
      this.sessions.delete(sid);
      await entry.transport.close().catch(() => {});
      await entry.server.close().catch(() => {});
    }
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
