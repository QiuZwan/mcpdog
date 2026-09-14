import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('cross-spawn', () => ({ default: spawnMock }));

import { StdioAdapter } from './stdio-adapter.js';
import type { MCPServerConfig } from '../types/index.js';

/**
 * 可控的假子进程。关键能力是能构造生产环境里那个时序窗口：
 * `exitCode` 已被置位（libuv 回调里同步设置），但 'exit' 事件还没发出（要等 nextTick），
 * 此时 `isConnected` 仍为 true —— 这正是「假报重连成功、请求写进死管道」的成因。
 */
class FakeChildProcess extends EventEmitter {
  public stdin = { write: vi.fn((_chunk: string) => true) };
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public killed = false;
  public exitCode: number | null = null;

  public kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });

  /** 对任意带 id 的请求异步回包，模拟真实子进程的握手与应答 */
  public autoRespond(result: unknown = {}): this {
    this.stdin.write = vi.fn((chunk: string) => {
      const message = JSON.parse(chunk);
      if (message.id !== undefined) {
        setTimeout(() => {
          this.stdout.emit(
            'data',
            Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'),
          );
        }, 0);
      }
      return true;
    });
    return this;
  }

  /** 写进 stdin 的所有 JSON-RPC 方法名，用于断言请求实际发给了哪个进程 */
  public writtenMethods(): string[] {
    return this.stdin.write.mock.calls.map(([chunk]) => {
      try {
        return JSON.parse(chunk as string).method as string;
      } catch {
        return '<unparsable>';
      }
    });
  }
}

function createConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'ssh-server',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'fake-mcp-server'],
    timeout: 300,
    ...overrides,
  };
}

describe('StdioAdapter 死进程重连', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('标志位仍为已连接但进程已死时，必须真正重连并把请求发给新进程', async () => {
    const dead = new FakeChildProcess().autoRespond({ tools: [] });
    const revived = new FakeChildProcess().autoRespond({ tools: [] });
    spawnMock.mockReturnValueOnce(dead).mockReturnValueOnce(revived);

    const adapter = new StdioAdapter('ssh-server', createConfig());
    await adapter.connect();
    expect(adapter.isConnected).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // 只置 exitCode、不发 'exit' 事件：复现 isConnected 尚未复位的窗口
    dead.exitCode = 1;

    const response = await adapter.sendRequest({ jsonrpc: '2.0', id: 42, method: 'tools/list' });

    // 真的重新拉起了进程，且请求发给了新进程
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(revived.writtenMethods()).toContain('tools/list');
    // 关键回归点：绝不能把请求写进已死的那个进程（旧实现会写进去然后卡到超时）
    expect(dead.writtenMethods()).not.toContain('tools/list');
    expect(response.id).toBe(42);
  });

  it('重连后进程仍不可用时立即失败，不得假报重连成功、不得等到请求超时', async () => {
    const dead = new FakeChildProcess().autoRespond({ tools: [] });
    const stillborn = new FakeChildProcess().autoRespond({ tools: [] });
    stillborn.exitCode = 1; // 重新拉起的进程也起不来
    spawnMock.mockReturnValueOnce(dead).mockReturnValueOnce(stillborn);

    const adapter = new StdioAdapter('ssh-server', createConfig({ timeout: 5000 }));
    await adapter.connect();
    dead.exitCode = 1;

    const startedAt = Date.now();
    await expect(
      adapter.sendRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    ).rejects.toThrow(/Failed to reconnect to ssh-server/);

    // 快速失败：远小于 5000ms 的请求超时，说明没有走「写进死管道再干等」那条路
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(stillborn.writtenMethods()).not.toContain('tools/list');
  });
});
