import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server as NetServer } from 'net';
import type { AddressInfo } from 'net';
import { DaemonClient } from './daemon-client.js';

/**
 * 重连循环必须能**反复**尝试。
 *
 * 曾经的形态：scheduleReconnect 的定时器回调里从不把 this.reconnectTimer 置回
 * undefined，而该字段同时是「已有重连在排队」的防重入判据 —— 回调触发后它仍是
 * 一个 truthy 的已完成 timer 对象，于是下一次调度被守卫直接短路，重连只跑一轮
 * 就再也不试。proxy 侧依赖「连续多次失败」触发的自拉起 daemon 因此永远达不到阈值。
 */
describe('DaemonClient：重连循环', () => {
  let client: DaemonClient | null = null;
  let server: NetServer | null = null;

  afterEach(async () => {
    client?.disconnect();
    client = null;
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it('连接不上时会持续重试，而不是只试一次', async () => {
    // 占用一个端口后立刻释放，保证拿到一个确定没人监听的端口号
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    let attempts = 0;
    client = new DaemonClient({
      host: '127.0.0.1',
      port: deadPort,
      clientType: 'cli',
      reconnect: true,
      reconnectInterval: 30,
      silent: true,
    });
    // connect() 的失败由内部重连路径接住；这里数「发起过多少次连接尝试」
    const originalConnect = client.connect.bind(client);
    (client as any).connect = (...args: unknown[]) => {
      attempts++;
      return (originalConnect as (...a: unknown[]) => Promise<void>)(...args);
    };

    // 首次连接失败，进入重连循环
    await client.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    // 30ms 间隔、250ms 窗口：若循环只跑一轮，这里最多 1-2 次
    expect(attempts).toBeGreaterThanOrEqual(3);
  }, 15000);

  it('重连期间 daemon 恢复后能重新连上并通知上层', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    client = new DaemonClient({
      host: '127.0.0.1',
      port,
      clientType: 'cli',
      reconnect: true,
      reconnectInterval: 30,
      silent: true,
    });

    let connected = 0;
    client.on('connected', () => connected++);

    await client.connect().catch(() => {});

    // daemon 起来了（接受连接并回一条 welcome）
    server = createServer((socket) => {
      socket.on('data', () => {
        socket.write(JSON.stringify({ type: 'welcome', clientId: 'test' }) + '\n');
      });
    });
    await new Promise<void>((r) => server!.listen(port, '127.0.0.1', () => r()));

    await new Promise((r) => setTimeout(r, 400));
    expect(connected).toBeGreaterThanOrEqual(1);
    expect(client.connected).toBe(true);
  }, 15000);
});
