import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { io as ioClient } from 'socket.io-client';

import { MCPDogDaemon } from './mcpdog-daemon.js';

const PORT = 45231;
// 鉴权用例用独立端口，避免与上面的 daemon 抢端口
const AUTH_PORT = 45241;
const AUTH_TOKEN = 'vitest-bearer-token';
const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest-integration', version: '1' },
  },
};

describe('/mcp 端点（集成）', () => {
  let dir: string;
  let daemon: MCPDogDaemon | null = null;
  let base = '';
  let previousToken: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpdog-mcp-http-'));
    const configPath = join(dir, 'mcpdog.config.json');
    // 不配任何子服务器：本测试只验证协议外壳与安全边界，不依赖子进程
    writeFileSync(configPath, JSON.stringify({ version: '2.0.0', servers: {} }));

    // 显式清掉环境里可能已存在的 token：否则本组用例会因 401 全挂，
    // 结果取决于开发者 / CI 的环境变量而不是代码
    previousToken = process.env.MCPDOG_AUTH_TOKEN;
    delete process.env.MCPDOG_AUTH_TOKEN;

    daemon = new MCPDogDaemon({
      configPath,
      ipcPort: PORT + 1,
      pidFile: join(dir, 'mcpdog.pid'),
    });
    await daemon.start();
    await daemon.startWebServer(PORT);
    base = `http://127.0.0.1:${PORT}`;
  }, 60000);

  afterAll(async () => {
    try {
      await daemon?.stop();
    } finally {
      // stop() 会 rethrow：恢复环境变量与清理目录必须放在 finally，否则一次失败的
      // teardown 会把 token 泄漏给同 worker 的后续用例
      if (previousToken === undefined) {
        delete process.env.MCPDOG_AUTH_TOKEN;
      } else {
        process.env.MCPDOG_AUTH_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function mcpPost(body: unknown, sessionId?: string, headers: Record<string, string> = {}) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  async function readMessage(res: Response): Promise<any> {
    const text = await res.text();
    if (text.includes('data:')) {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse((line ?? '').replace(/^data:\s*/, ''));
    }
    return JSON.parse(text);
  }

  // fetch 会静默丢弃 Fetch 规范的 forbidden header（Host 在内），
  // 只有原始 http 请求才能把伪造的 Host 真正发到服务端
  async function rawPost(
    pathname: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const payload = JSON.stringify(INIT_BODY);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('initialize → tools/list 全通', async () => {
    const init = await mcpPost(INIT_BODY);
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await readMessage(init);

    await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid!);
    const list = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid!);
    const msg = await readMessage(list);
    expect(Array.isArray(msg.result.tools)).toBe(true);
  }, 30000);

  it('GET /mcp 返回 SSE 流，而不是 SPA 的 index.html', async () => {
    const init = await mcpPost(INIT_BODY);
    const sid = init.headers.get('mcp-session-id')!;
    await readMessage(init);
    await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

    const ac = new AbortController();
    const res = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sid },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/event-stream');
    const body = await Promise.race([
      res.text(),
      new Promise<string>((r) => setTimeout(() => r(''), 1000)),
    ]);
    expect(body).not.toContain('<!doctype html');
    ac.abort();
  }, 30000);

  it('伪造 Host 头被拒绝（DNS rebinding 防护）', async () => {
    // 必须用 http.request 而不是 fetch：Host 是 Fetch 规范的 forbidden header，
    // undici 会静默丢弃 fetch 传入的 host，伪造不出该头（可用性由下方的原始请求保证）
    const res = await rawPost('/mcp', {
      host: 'evil.example.com',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    expect(res.status).toBe(403);
  });

  it('伪造 Origin 头被拒绝', async () => {
    const res = await mcpPost(INIT_BODY, undefined, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('dashboard 的 /api 仍然可用（回归）', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it('POST /mcp 不回 CORS 头（含 /mcp/ 与 /MCP 变体）', async () => {
    // Express 路由匹配非严格且大小写不敏感：/mcp/ 与 /MCP 同样命中 /mcp 处理器，
    // 所以「除字面量 /mcp 外全挂 cors()」的旧写法收窄形同虚设 —— 三个变体都必须无 CORS 头
    for (const pathname of ['/mcp', '/mcp/', '/MCP']) {
      const res = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(INIT_BODY),
      });
      // soft：让三个变体都跑完，失败信息能一次列全所有泄漏的路径
      expect.soft(res.headers.get('access-control-allow-origin'), pathname).toBeNull();
    }
  });

  it('GET /api/status 仍回 CORS 头（CORS 是收窄到 /api 而非被移除）', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  // Engine.IO 在 Express 之前接管 /socket.io/*，guardLocalOnly 看不到这些请求；
  // WebSocket 握手也不受 CORS 约束。这里直接验证 Socket.IO 自己的回环 Origin 白名单。
  async function rawGetSocketIo(origin: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/socket.io/?EIO=4&transport=polling',
          method: 'GET',
          headers: { origin },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function wsConnect(origin: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = ioClient(base, {
        transports: ['websocket'], // dashboard 客户端用的就是 websocket 传输
        reconnection: false,
        timeout: 4000,
        extraHeaders: { Origin: origin },
      });
      const done = (ok: boolean) => {
        socket.close();
        resolve(ok);
      };
      socket.on('connect', () => done(true));
      socket.on('connect_error', () => done(false));
      setTimeout(() => done(false), 6000);
    });
  }

  it('Socket.IO 只接受回环 Origin：回环放行、外来 Origin 被拒', async () => {
    const loopback = await rawGetSocketIo('http://127.0.0.1:45231');
    expect(loopback.status).toBe(200);
    const localhost = await rawGetSocketIo('http://localhost:45231');
    expect(localhost.status).toBe(200);
    const foreign = await rawGetSocketIo('http://evil.example.com');
    expect(foreign.status).toBe(403);

    // WebSocket 握手必须同样被 allowRequest 拦住，否则「恶意本机网页」仍能开 socket
    expect(await wsConnect('http://127.0.0.1:45231')).toBe(true);
    expect(await wsConnect('http://evil.example.com')).toBe(false);
  }, 30000);
});

describe('/mcp Bearer 鉴权（集成）', () => {
  let dir: string;
  let daemon: MCPDogDaemon | null = null;
  let base = '';
  let previousToken: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpdog-mcp-auth-'));
    const configPath = join(dir, 'mcpdog.config.json');
    writeFileSync(configPath, JSON.stringify({ version: '2.0.0', servers: {} }));

    // DaemonWebServer 在构造时读该环境变量，必须在 startWebServer 之前设置
    previousToken = process.env.MCPDOG_AUTH_TOKEN;
    process.env.MCPDOG_AUTH_TOKEN = AUTH_TOKEN;

    daemon = new MCPDogDaemon({
      configPath,
      ipcPort: AUTH_PORT + 1,
      pidFile: join(dir, 'mcpdog.pid'),
    });
    await daemon.start();
    await daemon.startWebServer(AUTH_PORT);
    base = `http://127.0.0.1:${AUTH_PORT}`;
  }, 60000);

  afterAll(async () => {
    try {
      await daemon?.stop();
    } finally {
      // stop() 会 rethrow：恢复环境变量与清理目录必须放在 finally，否则一次失败的
      // teardown 会把 MCPDOG_AUTH_TOKEN 泄漏给同 worker 的后续用例
      if (previousToken === undefined) {
        delete process.env.MCPDOG_AUTH_TOKEN;
      } else {
        process.env.MCPDOG_AUTH_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function postMcp(authorization?: string) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(INIT_BODY),
    });
  }

  it('未带 Bearer 的 POST /mcp 返回 401（而不是 302 跳登录页）', async () => {
    const res = await postMcp();
    expect(res.status).toBe(401);
  });

  it('未带 Bearer 的 GET /mcp 返回 401（SSE 流不放行）', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });

  it('带正确 Bearer 的 POST /mcp 能到达 MCP handler', async () => {
    const res = await postMcp(`Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});
