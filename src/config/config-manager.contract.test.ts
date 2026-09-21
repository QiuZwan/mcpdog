import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigManager } from './config-manager.js';
import type { MCPServerConfig } from '../types/index.js';

/**
 * 协议检测的返回契约。
 *
 * 调用方（detect-commands / diagnose-commands）读的是
 * `detected` / `confidence` / `recommendations` / `current` / `needsUpdate`，
 * 并且会把 `detected` 在「detected !== server.transport && confidence > 70」时
 * 写回配置。曾经这些字段缺一不可地被漏掉：返回 `protocol`/`issues` 时
 * 命令会因 `undefined.length` 直接崩溃，更糟的是 `detected` 为 undefined 会被
 * 当作「检测到更好的协议」写进 transport，把配置改坏。
 */
describe('ConfigManager：协议检测返回契约', () => {
  let dir: string;
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpdog-detect-'));
    configPath = join(dir, 'mcpdog.config.json');
    manager = new ConfigManager(configPath, true);
    await manager.loadConfig();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stdioServer = (): MCPServerConfig =>
    ({ name: 's', enabled: true, transport: 'stdio', command: 'npx' }) as MCPServerConfig;
  const httpServer = (): MCPServerConfig =>
    ({ name: 'h', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }) as MCPServerConfig;

  it('单服务器检测：字段齐备，且 detected 是合法 transport（可安全写回配置）', async () => {
    for (const server of [stdioServer(), httpServer()]) {
      const result = await manager.detectConfigProtocol(server);
      expect(result.current).toBe(server.transport);
      expect(result.detected).toBe(server.transport);
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(typeof result.confidence).toBe('number');
      // 关键：不能是 undefined —— 调用方会用它覆盖配置里的 transport
      expect(['stdio', 'http-sse', 'streamable-http']).toContain(result.detected);
      // 协议与配置一致时不应被判定为「需要更新」
      expect(result.needsUpdate).toBe(false);
    }
  });

  it('配置有问题时给出可读建议且置信度降低，但仍不谎报「需要换协议」', async () => {
    const broken = { name: 'b', enabled: true, transport: 'stdio' } as MCPServerConfig;
    const result = await manager.detectConfigProtocol(broken);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(100);
    expect(result.detected).toBe('stdio');
    expect(result.needsUpdate).toBe(false);
  });

  it('批量审计：每条都带调用方需要的字段，且据实回报各服务器自己的协议', async () => {
    await manager.addServer('s', stdioServer());
    await manager.addServer('h', httpServer());

    const results = await manager.auditAllServerProtocols();
    expect(Object.keys(results).sort()).toEqual(['h', 's']);
    for (const [, entry] of Object.entries(results)) {
      for (const field of ['current', 'detected', 'confidence', 'recommendations', 'needsUpdate']) {
        expect(entry, `缺少字段 ${field}`).toHaveProperty(field);
      }
      expect(entry.detected).toBe(entry.current);
    }
    // 逐个服务器的协议不能被统一成同一个值
    expect(results.s.detected).toBe('stdio');
    expect(results.h.detected).toBe('streamable-http');
  });
});

describe('ConfigManager：落盘与变更语义', () => {
  let dir: string;
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpdog-persist-'));
    configPath = join(dir, 'mcpdog.config.json');
    manager = new ConfigManager(configPath, true);
    await manager.loadConfig();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('toggleTool 真实生效并返回真实结果（不再是无条件 return true 的空实现）', () => {
    manager.addServer('s', { name: 's', enabled: true, transport: 'stdio', command: 'x' } as MCPServerConfig);

    expect(manager.toggleTool('s', 'danger', false)).toBe(true);
    expect(manager.getConfig().servers.s.toolsConfig?.toolSettings?.danger?.enabled).toBe(false);

    // 不存在的服务器必须返回 false，否则调用方无从区分成功与什么都没做
    expect(manager.toggleTool('ghost', 't', true)).toBe(false);
  });

  it('saveConfig 原子落盘：不留下临时文件，且落盘内容可解析', async () => {
    manager.addServer('s', { name: 's', enabled: true, transport: 'stdio', command: 'x' } as MCPServerConfig);
    await manager.saveConfig();

    const raw = await readFile(configPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).servers.s.command).toBe('x');

    const { readdir } = await import('fs/promises');
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('并发 saveConfig 不得随机失败（Windows rename 覆盖已存在目标会瞬时 EPERM）', async () => {
    // Windows 上 rename 覆盖一个已存在的目标文件会间歇性 EPERM/EBUSY
    // （实测串行 200 次失败 2~6 次、并发 10 次失败 3~4 次，重试一次即成功）。
    // 不重试的话这些失败会一路冒泡成 HTTP 500，前端表现为「随机保存失败」；
    // 而各 API handler 都是 await saveConfig 后 catch 回 500，故必须在这里兜住。
    manager.addServer('s', { name: 's', enabled: true, transport: 'stdio', command: 'x' } as MCPServerConfig);

    // 串行若干轮 + 并发若干轮，任何一次失败都算不通过
    for (let i = 0; i < 30; i++) {
      await expect(manager.saveConfig()).resolves.toBeUndefined();
    }
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => manager.saveConfig())
      );
      const failed = results.filter((r) => r.status === 'rejected');
      expect(failed, `并发第 ${round} 轮出现失败`).toHaveLength(0);
    }

    // 落盘内容必须始终是完整可解析的配置，且不留临时文件
    const raw = await readFile(configPath, 'utf-8');
    expect(JSON.parse(raw).servers.s.command).toBe('x');
    const { readdir } = await import('fs/promises');
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('配置文件被写坏时重载失败要留下痕迹，且保留内存中的旧配置', async () => {
    manager.addServer('keep', { name: 'keep', enabled: true, transport: 'stdio', command: 'x' } as MCPServerConfig);
    await manager.saveConfig();

    // 写一个坏 JSON，再触发重载
    await writeFile(configPath, '{ this is not json', 'utf-8');

    const errors: unknown[] = [];
    manager.on('configError', (e) => errors.push(e));

    await expect(manager.loadConfig()).rejects.toThrow();

    // 内存配置不能被坏文件清空（loadConfig 抛错前不应替换 this.config）
    expect(manager.getConfig().servers.keep).toBeDefined();
  });
});
