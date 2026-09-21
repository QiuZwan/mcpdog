import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MCPDogDaemon } from './mcpdog-daemon.js';

/**
 * 配置写入类 API 的端到端行为。
 *
 * 这一组接口此前**没有任何测试**，而它们直接改磁盘上的配置 —— 出过的真实缺陷包括：
 * 空 body 的 PUT /api/config 清空全部服务器定义、空 body 的 PUT .../tools 清空逐工具设置、
 * 未知 transport 被写进配置（该服务器此后永久加载失败）、不存在的服务器被回「已更新/已删除」。
 * 下面把「必须拒绝」与「必须接受」两侧都钉住，避免校验改过头把正常请求也拒了。
 */
const PORT = 39421;

describe('配置写入 API（集成）', () => {
  let daemon: MCPDogDaemon | null = null;
  let dir = '';
  let configPath = '';
  let base = '';
  let previousToken: string | undefined;

  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf-8'));

  const put = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpdog-config-api-'));
    configPath = join(dir, 'mcpdog.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0.0',
        logging: { level: 'info' },
        web: { enabled: true, port: 38881 },
        servers: {
          existing: { name: 'existing', enabled: true, transport: 'stdio', command: 'node' },
        },
      })
    );

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
      if (previousToken === undefined) {
        delete process.env.MCPDOG_AUTH_TOKEN;
      } else {
        process.env.MCPDOG_AUTH_TOKEN = previousToken;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响结论
      }
    }
  }, 60000);

  describe('POST /api/servers', () => {
    it('合法 stdio 服务器被接受并落盘', async () => {
      // body 形态为 { name, config }，与 Web 前端 configStore.addServer 一致
      const res = await post('/api/servers', {
        name: 'added_ok',
        config: { enabled: true, transport: 'stdio', command: 'node' },
      });
      expect(res.status).toBe(200);
      expect(readConfig().servers.added_ok).toBeDefined();
    });

    it('未知 transport 必须 400 且不落盘（否则是一个永久加载不了的死条目）', async () => {
      const res = await post('/api/servers', {
        name: 'bad_transport',
        config: { enabled: true, transport: 'bogus' },
      });
      expect(res.status).toBe(400);
      expect(readConfig().servers.bad_transport).toBeUndefined();
    });

    it('stdio 缺 command 必须 400 且不落盘', async () => {
      const res = await post('/api/servers', {
        name: 'no_command',
        config: { enabled: true, transport: 'stdio' },
      });
      expect(res.status).toBe(400);
      expect(readConfig().servers.no_command).toBeUndefined();
    });

    it('http 传输缺 url 必须 400 且不落盘', async () => {
      const res = await post('/api/servers', {
        name: 'no_url',
        config: { enabled: true, transport: 'streamable-http' },
      });
      expect(res.status).toBe(400);
      expect(readConfig().servers.no_url).toBeUndefined();
    });

    it('缺 enabled 必须 400 且不落盘', async () => {
      const res = await post('/api/servers', {
        name: 'no_enabled',
        config: { transport: 'stdio', command: 'node' },
      });
      expect(res.status).toBe(400);
      expect(readConfig().servers.no_enabled).toBeUndefined();
    });
  });

  describe('PUT /api/servers/:name', () => {
    it('局部更新（只改 description）必须被接受，且其余字段保持', async () => {
      const res = await put('/api/servers/existing', { description: 'new desc' });
      expect(res.status).toBe(200);
      const s = readConfig().servers.existing;
      expect(s.description).toBe('new desc');
      expect(s.command).toBe('node');
      expect(s.transport).toBe('stdio');
    });

    it('未知 transport 必须 400 且不落盘', async () => {
      const res = await put('/api/servers/existing', { transport: 'bogus' });
      expect(res.status).toBe(400);
      expect(readConfig().servers.existing.transport).toBe('stdio');
    });

    it('不存在的服务器必须 404（此前回「已更新」的假成功）', async () => {
      const res = await put('/api/servers/ghost_server', { description: 'x' });
      expect(res.status).toBe(404);
    });

    it('数组 body 必须 400 且不污染配置（此前会写入 "0"/"1" 这类数字键）', async () => {
      const res = await put('/api/servers/existing', ['evil', 'payload']);
      expect(res.status).toBe(400);
      const s = readConfig().servers.existing;
      expect(s['0']).toBeUndefined();
      expect(s['1']).toBeUndefined();
    });
  });

  describe('DELETE /api/servers/:name', () => {
    it('不存在的服务器必须 404（此前回「已删除」的假成功）', async () => {
      const res = await fetch(`${base}/api/servers/ghost_server2`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/config', () => {
    it('空 body 必须 400 且不得清空配置', async () => {
      const res = await fetch(`${base}/api/config`, { method: 'PUT' });
      expect(res.status).toBe(400);
      expect(readConfig().servers.existing).toBeDefined();
    });

    it('空对象必须 400 且不得清空配置', async () => {
      const res = await put('/api/config', {});
      expect(res.status).toBe(400);
      expect(readConfig().servers.existing).toBeDefined();
    });

    it('servers 条目为 null 必须 400（此前会让 /api/status 持续 500）', async () => {
      const res = await put('/api/config', { servers: { x: null } });
      expect(res.status).toBe(400);
    });

    it('未知 transport 的条目必须 400 且不落盘', async () => {
      const res = await put('/api/config', {
        servers: { bogus_entry: { name: 'bogus_entry', enabled: true, transport: 'bogus' } },
      });
      expect(res.status).toBe(400);
      expect(readConfig().servers.bogus_entry).toBeUndefined();
    });

    it('合法配置被接受，且顶层 version/logging/web 不被抹掉', async () => {
      const res = await put('/api/config', {
        servers: {
          existing: { name: 'existing', enabled: true, transport: 'stdio', command: 'node' },
        },
      });
      expect(res.status).toBe(200);
      const cfg = readConfig();
      expect(cfg.servers.existing).toBeDefined();
      expect(cfg.version).toBe('2.0.0');
      expect(cfg.logging).toBeDefined();
      expect(cfg.web).toBeDefined();
    });
  });

  describe('PUT /api/servers/:name/tools', () => {
    it('空 body 必须 400 且不得清空既有 toolsConfig', async () => {
      // 先写入一份逐工具设置
      const seed = await put('/api/servers/existing/tools', {
        toolsConfig: { mode: 'blacklist', disabledTools: ['dangerous'] },
      });
      expect(seed.status).toBe(200);
      expect(readConfig().servers.existing.toolsConfig.disabledTools).toEqual(['dangerous']);

      // 空 body 不得把它清空
      const res = await fetch(`${base}/api/servers/existing/tools`, { method: 'PUT' });
      expect(res.status).toBe(400);
      expect(readConfig().servers.existing.toolsConfig.disabledTools).toEqual(['dangerous']);
    });
  });
});
