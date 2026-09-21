import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { HttpSseAdapter } from './http-sse-adapter.js';
import type { MCPServerConfig } from '../types/index.js';

/**
 * HttpSseAdapter 的重连状态机。
 *
 * 这个文件此前**没有任何测试**，而它的状态机正是最容易出错的地方：
 * - `isReconnecting` 一旦被留成 true，重连入口 `if (!this.isReconnecting) return`
 *   会把后续所有掉线检测永久挡住；
 * - 反过来，若重连成功路径误判「已被取代」，标志位同样会永久卡住，
 *   并且适配器会在一条死流上保持 isConnected=true（工具调用全部超时）。
 * 下面用真实 HTTP + SSE 下游把这两点钉住。
 */
function startFakeSseDownstream() {
  const state = {
    /** 已建立的 SSE 流数量（用来看有没有残留的活流） */
    openStreams: 0,
    /** 每次 initialize 都计数，用于确认真的重新握了手 */
    initializeCount: 0,
    /** 当前活着的 SSE 响应对象，用于从服务端强制掐断 */
    liveResponses: [] as any[],
  };

  const server: HttpServer = createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      state.openStreams++;
      state.liveResponses.push(res);
      // 告知消息端点
      res.write('event: endpoint\ndata: /mcp\n\n');
      res.on('close', () => {
        state.openStreams = Math.max(0, state.openStreams - 1);
        state.liveResponses = state.liveResponses.filter((r) => r !== res);
      });
      return;
    }

    // 消息端点
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      } catch {
        // 忽略非 JSON
      }
      if (body.method === 'initialize') state.initializeCount++;
      // 通知没有 id，回 202
      if (body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'tools/list' ? { tools: [] } : {},
        })
      );
    });
  });

  return {
    state,
    server,
    /** 从服务端掐断当前所有 SSE 流，制造一次真实掉线 */
    dropStreams() {
      for (const res of state.liveResponses.slice()) {
        res.destroy();
      }
      state.liveResponses = [];
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('HttpSseAdapter：重连状态机', () => {
  let adapter: HttpSseAdapter | null = null;
  let downstream: ReturnType<typeof startFakeSseDownstream> | null = null;

  afterEach(async () => {
    await adapter?.disconnect().catch(() => {});
    await downstream?.close().catch(() => {});
    adapter = null;
    downstream = null;
  });

  async function setup() {
    downstream = startFakeSseDownstream();
    const url = await downstream.listen();
    adapter = new HttpSseAdapter('sse-probe', {
      name: 'sse-probe',
      enabled: true,
      transport: 'http-sse',
      url,
      timeout: 3000,
      sseReconnectInterval: 40,
    } as MCPServerConfig);
    return { adapter, state: downstream.state };
  }

  it('connect 成功后 isReconnecting 必须复位（否则后续掉线再也检测不到）', async () => {
    const { adapter: a } = await setup();
    await a.connect();

    // 重连成功路径不能把自己判成「已被取代」——那会让 isReconnecting 永久卡住
    expect((a as any).isReconnecting).toBe(false);
    expect(a.isConnected).toBe(true);
    expect((a as any).connectionGeneration).toBe(0);
  }, 20000);

  it('掉线后能自动重连成功，且重连后仍能检测下一次掉线', async () => {
    const { adapter: a, state } = await setup();
    await a.connect();
    expect(state.initializeCount).toBe(1);

    let reconnected = 0;
    let disconnected = 0;
    a.on('connected', () => reconnected++);
    a.on('disconnected', () => disconnected++);

    // 从服务端掐断 SSE 流，制造一次真实掉线
    downstream!.dropStreams();

    // 等待重连完成
    await new Promise((r) => setTimeout(r, 1500));

    expect(disconnected).toBeGreaterThanOrEqual(1);
    expect(reconnected).toBeGreaterThanOrEqual(1);
    // 关键：重连后标志位必须干净，否则下一次掉线会被永久忽略
    expect((a as any).isReconnecting).toBe(false);
    expect(a.isConnected).toBe(true);
    // 真的重新握了手
    expect(state.initializeCount).toBeGreaterThanOrEqual(2);
  }, 25000);

  it('重连成功后再掉线，仍然会被检测并再次重连（不被启动时标志位卡死）', async () => {
    const { adapter: a, state } = await setup();
    await a.connect();

    let reconnected = 0;
    a.on('connected', () => reconnected++);

    for (let round = 0; round < 2; round++) {
      downstream!.dropStreams();
      await new Promise((r) => setTimeout(r, 1500));
    }

    // 两轮掉线都应各触发一次重连 → initialize 至少 3 次（首次 + 两次重连）
    expect(reconnected).toBeGreaterThanOrEqual(2);
    expect(state.initializeCount).toBeGreaterThanOrEqual(3);
    expect(a.isConnected).toBe(true);
    expect((a as any).isReconnecting).toBe(false);
  }, 35000);

  it('disconnect 后不会自己连回来', async () => {
    const { adapter: a } = await setup();
    await a.connect();

    await a.disconnect();
    expect(a.isConnected).toBe(false);

    let revived = false;
    a.on('connected', () => {
      revived = true;
    });

    // 超过重连间隔数倍，确认没有复活
    await new Promise((r) => setTimeout(r, 400));
    expect(revived).toBe(false);
    expect(a.isConnected).toBe(false);
  }, 20000);

  it('第一次重连失败后必须继续重试，直到下游恢复（重试链不能断在一轮）', async () => {
    // 覆盖缺口：前面的用例要么「重连成功」要么「建连失败」，
    // 唯独「重连失败 → 下游恢复」这条路径没人测 —— 而它正是重试链最容易断的地方：
    // attemptReconnection 靠 isReconnecting 放行、并在失败后按退避续排下一次，
    // 任何在该路径上复位标志位的改动都会让重试进门即返。
    const { adapter: a, state } = await setup();
    await a.connect();
    expect(state.initializeCount).toBe(1);

    const port = Number(new URL((a as any).baseUrl).port);

    // 让下游彻底不可达：先掐断流的服务器，再停掉监听
    downstream!.dropStreams();
    await downstream!.close();

    // 等第一次重连失败（此时重试链应该已经排好下一轮）
    await new Promise((r) => setTimeout(r, 700));
    expect(a.isConnected).toBe(false);

    // 在同一端口上恢复下游，重试链必须能自己连回来
    downstream = startFakeSseDownstream();
    await new Promise<void>((r) => downstream!.server.listen(port, '127.0.0.1', () => r()));

    // 退避间隔 40ms（失败后 ×2）；给足时间让后续重试成功
    await new Promise((r) => setTimeout(r, 1500));

    expect(a.isConnected).toBe(true);
    expect((a as any).isReconnecting).toBe(false);
    // 确实对**恢复后的下游**重新握了手（initializeCount 属于新起的那个下游，
    // 旧的 state 对象已随旧 server 一起作废）
    expect(downstream!.state.initializeCount).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('握手窗口内掉线不得把 isReconnecting 闩死（随后必须能连上且能再次检测掉线）', async () => {
    // 时序：onopen 已触发 → 流在 isConnected 置位前掉线（窗口 ≥1s）→
    // onerror 进入 handleSSEDisconnection 置 isReconnecting=true 并排定时器 →
    // initialize 的独立 POST 仍成功 → connect() 命中「握手期间流已死」分支 cleanup()，
    // 顺手清掉了那个定时器，标志位却无人复位 → 闩死：
    // 此后所有掉线被 `if (this.isReconnecting) return` 永久忽略，
    // 实例在一条死流上保持 isConnected=true，工具调用全部超时。
    const { adapter: a } = await setup();
    await a.connect();
    expect((a as any).isReconnecting).toBe(false);

    // 制造「握手窗口内掉线」：先收掉当前连接，再在 connect() 的 1s 等待里掐断新流
    await a.disconnect();
    const connectP = a.connect();
    // 等 onopen 完成、进入 1s 等待窗口后掐断
    await new Promise((r) => setTimeout(r, 250));
    downstream!.dropStreams();

    // connect() 会以「握手期间流已死」失败。
    // 关键不变量：**不得闩死** —— 标志位为 true 时必须确实有重试在排队；
    // 曾经失败形态是「标志位为 true 而定时器已被 cleanup 清掉」，
    // 此后所有掉线与重试都被入口守卫静默吞掉，实例永久离线。
    await connectP.catch(() => {});
    const latched = (adapter as any) ?? a;
    expect(
      (latched as any).isReconnecting === true && !(latched as any).reconnectTimer,
      '不得出现「重连标志为 true 却没有待执行定时器」的闩死形态'
    ).toBe(false);

    // 必须能恢复：等待重试链自己连上（每次尝试含 ≥1s 握手等待 + 退避）
    await new Promise((r) => setTimeout(r, 2500));
    expect(a.isConnected).toBe(true);

    // 且仍能检测后续掉线
    let reconnected = 0;
    a.on('connected', () => reconnected++);
    downstream!.dropStreams();
    await new Promise((r) => setTimeout(r, 1200));
    expect(reconnected).toBeGreaterThanOrEqual(1);
    expect(a.isConnected).toBe(true);
  }, 30000);

  it('建连卡住（对端不回响应头）时 disconnect 必须了结 connectPromise，实例仍可再用', async () => {
    // 对端接受 TCP 但不回响应头；库会把在飞的 fetch abort 掉且不派发任何事件，
    // connectSSE 的 Promise 永不 settle —— connectPromise 会永久占位，
    // 此后每一次 connect() 都直接返回那个永不 settle 的 Promise，实例再也连不上。
    const stuck = createServer((_req, _res) => {
      // 故意什么都不写：不回响应头也不结束
    });
    await new Promise<void>((r) => stuck.listen(0, '127.0.0.1', () => r()));
    const stuckPort = (stuck.address() as AddressInfo).port;

    adapter = new HttpSseAdapter('sse-stuck', {
      name: 'sse-stuck',
      enabled: true,
      transport: 'http-sse',
      url: `http://127.0.0.1:${stuckPort}`,
      timeout: 2000,
      sseReconnectInterval: 40,
    } as MCPServerConfig);

    // 不 await：这次 connect 会卡住
    void adapter.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    await adapter.disconnect();
    await new Promise<void>((r) => stuck.close(() => r()));

    // 关键：connectPromise 必须已被释放，换到可用下游后能连上
    downstream = startFakeSseDownstream();
    await new Promise<void>((r) => downstream!.server.listen(stuckPort, '127.0.0.1', () => r()));

    const url = `http://127.0.0.1:${stuckPort}`;
    (adapter as any).baseUrl = url;
    (adapter as any).sseUrl = `${url}/sse`;

    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
  }, 30000);

  it('持续连不上时必须反复重试，而不是只试一两次', async () => {
    // 这是重试链最容易断的地方：定时器句柄与 isReconnecting 只要有一次不一致
    // （例如 teardown 顺手清掉了驱动重试的定时器），就会在入口守卫处被静默吞掉，
    // 此后不再有任何尝试 —— 服务器永久离线，只有改配置才回来。
    // 下游：每次 /sse 都在握手窗口内主动结束流，必然连不上
    let sseHits = 0;
    const closingServer = createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url === '/sse') {
        sseHits++;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(['event: endpoint', 'data: /mcp', '', ''].join(String.fromCharCode(10)));
        setTimeout(() => {
          try {
            res.end();
          } catch {
            // 已结束
          }
        }, 20);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let b: any = {};
        try {
          b = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        } catch {
          // 忽略
        }
        if (b.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }));
      });
    });
    await new Promise<void>((r) => closingServer.listen(0, '127.0.0.1', () => r()));
    const closinPort = (closingServer.address() as AddressInfo).port;

    adapter = new HttpSseAdapter('sse-alwaysfail', {
      name: 'sse-alwaysfail',
      enabled: true,
      transport: 'http-sse',
      url: `http://127.0.0.1:${closinPort}`,
      timeout: 1500,
      sseReconnectInterval: 100,
    } as MCPServerConfig);

    void adapter.connect().catch(() => {});

    // 每 1s 采样；每次尝试含 ≥1s 握手等待 + 退避，故 8s 内应有多次新连接
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      samples.push(sseHits);
    }

    // 关键：重试必须持续发生（而不是停在 1~2 次）
    expect(sseHits, `重试次数应持续增长，实际采样=${samples.join(',')}`).toBeGreaterThanOrEqual(3);

    // 且必须仍在推进：再观察一段，确认没有停在某个次数上
    const before = sseHits;
    await new Promise((r) => setTimeout(r, 3000));
    expect(sseHits, '重试应仍在继续').toBeGreaterThan(before);

    await adapter.disconnect();
    await new Promise<void>((r) => closingServer.close(() => r()));
  }, 40000);

  it('首次建连失败（下游未就绪）不得把 isReconnecting 卡成 true', async () => {
    // 这是最常见的失败：下游 SSE 端点还没起来 / 返回 5xx。
    // 建连失败由 connectSSE 的 Promise 承载，不该被当成「掉线」而进入重连态 ——
    // 那会在 cleanup() 清掉定时器后留下 isReconnecting=true 且无人复位，
    // 之后所有掉线检测被永久屏蔽，适配器再也连不上。
    const failServer = createServer((_req, res) => {
      res.writeHead(503);
      res.end('not ready');
    });
    await new Promise<void>((r) => failServer.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(failServer.address() as AddressInfo).port}`;

    adapter = new HttpSseAdapter('sse-fail', {
      name: 'sse-fail',
      enabled: true,
      transport: 'http-sse',
      url,
      timeout: 2000,
      sseReconnectInterval: 40,
    } as MCPServerConfig);

    await expect(adapter.connect()).rejects.toThrow();

    // 关键不变量：不得闩死（标志位为 true 却没有待执行定时器）。
    // 建连失败后适配器会自己排重试，故标志位为 true 是正常的 ——
    // 不正常的只有「没人再会重试」。
    expect(
      (adapter as any).isReconnecting === true && !(adapter as any).reconnectTimer,
      '不得出现「重连标志为 true 却没有待执行定时器」的闩死形态'
    ).toBe(false);
    expect(adapter.isConnected).toBe(false);

    // 停机必须仍然是稳定状态
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    await new Promise<void>((r) => failServer.close(() => r()));
  }, 25000);

  it('建连失败后仍能成功连上（标志位没有被卡住）', async () => {
    // 用「同一个下游先拒绝一次、之后正常」来制造失败→成功，避免换端口带来的
    // 端口竞争（并行跑测试文件时那会让本用例随机失败）。
    const NL = String.fromCharCode(10);
    let sseHits = 0;
    let live = 0;
    const flaky = createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url === '/sse') {
        sseHits++;
        if (sseHits === 1) {
          // 首次：建连阶段直接失败（下游未就绪）
          res.writeHead(503);
          res.end('not ready');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        live++;
        res.write(['event: endpoint', 'data: /mcp', '', ''].join(NL));
        res.on('close', () => {
          live--;
        });
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let b: any = {};
        try {
          b = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        } catch {
          // 忽略
        }
        if (b.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }));
      });
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', () => r()));
    const flakyPort = (flaky.address() as AddressInfo).port;

    adapter = new HttpSseAdapter('sse-retry', {
      name: 'sse-retry',
      enabled: true,
      transport: 'http-sse',
      url: `http://127.0.0.1:${flakyPort}`,
      timeout: 1500,
      sseReconnectInterval: 60,
    } as MCPServerConfig);

    await expect(adapter.connect()).rejects.toThrow();
    // 关键：不得闩死（标志位为 true 却没有待执行定时器）
    expect(
      (adapter as any).isReconnecting === true && !(adapter as any).reconnectTimer,
      '不得出现「重连标志为 true 却没有待执行定时器」的闩死形态'
    ).toBe(false);

    // 停机（停掉在途重试），再显式连接：同一实例必须能连上
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);

    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
    expect(live).toBeGreaterThan(0);

    // 必须先断开再关服务器：SSE 是长连接，server.close() 会一直等这条连接结束
    // （否则这里会挂到测试超时）
    await adapter.disconnect();
    await new Promise<void>((r) => flaky.close(() => r()));
  }, 30000);
});
