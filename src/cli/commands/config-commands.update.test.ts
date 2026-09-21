import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigCommands } from './config-commands.js';
import { ConfigManager } from '../../config/config-manager.js';

/**
 * `config update` 是唯一能改 transport 的 CLI 路径，而 updateServer 会在切换传输时
 * 清掉不适用的字段（改成 http 会删掉 command、改成 stdio 会删掉 url）。
 *
 * 它此前**不校验**就落盘，于是 `config update <name> --transport bogus` 以 exit 0
 * 报「更新成功」并写下一个永久加载不了的条目 —— 更糟的是，此后
 * `PUT /api/config` 校验整份配置时会一直 400，界面再也存不了盘。
 */
describe('mcpdog config update 的校验', () => {
  let dir: string;
  let configPath: string;
  let cmd: ConfigCommands;
  let exitSpy: any;
  let errorSpy: any;

  const readCfg = async () => JSON.parse(await readFile(configPath, 'utf-8'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpdog-cfg-update-'));
    configPath = join(dir, 'mcpdog.config.json');
    // 一个 manager 既用于播种也交给命令使用（命令读的是它的内存配置）
    const manager = new ConfigManager(configPath, true);
    await manager.loadConfig();
    manager.addServer('seed', {
      name: 'seed',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['x'],
    } as any);
    await manager.saveConfig();

    cmd = new ConfigCommands(manager);
    // 命令内部用 process.exit(1) 报错；测试里改成抛错以便断言
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as any);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('未知 transport 必须失败且不改动配置', async () => {
    await expect(
      (cmd as any).updateServer(['seed'], { transport: 'bogus' })
    ).rejects.toThrow(/EXIT_1/);

    const cfg = await readCfg();
    expect(cfg.servers.seed.transport).toBe('stdio');
    expect(cfg.servers.seed.command).toBe('node');
  });

  it('切到 http 却未给 url 必须失败且不改动配置（切换会删掉 command）', async () => {
    await expect(
      (cmd as any).updateServer(['seed'], { transport: 'streamable-http' })
    ).rejects.toThrow(/EXIT_1/);

    const cfg = await readCfg();
    expect(cfg.servers.seed.transport).toBe('stdio');
    expect(cfg.servers.seed.command).toBe('node');
  });

  it('合法的局部更新必须成功且保留其余字段', async () => {
    await (cmd as any).updateServer(['seed'], { description: 'hello' });

    const cfg = await readCfg();
    expect(cfg.servers.seed.description).toBe('hello');
    expect(cfg.servers.seed.command).toBe('node');
    expect(cfg.servers.seed.transport).toBe('stdio');
  });

  it('非数字的 --timeout/--retries 必须失败且不写 null（NaN 会序列化成 null）', async () => {
    // parseInt('abc') === NaN，而 JSON.stringify(NaN) === 'null' ——
    // 落盘后 PUT /api/config 校验整份配置时会一直 400，界面再也存不了盘。
    // 走真实形态：CLI 选项是字符串，'abc' 经 parseInt 得到 NaN
    await expect((cmd as any).updateServer(['seed'], { timeout: 'abc' })).rejects.toThrow(/EXIT_1/);
    await expect((cmd as any).updateServer(['seed'], { retries: 'xyz' })).rejects.toThrow(/EXIT_1/);

    const cfg = await readCfg();
    expect(cfg.servers.seed.timeout).toBeUndefined();
    expect(cfg.servers.seed.retries).toBeUndefined();
    expect(cfg.servers.seed.command).toBe('node');
  });

  it('合法的传输切换（带 endpoint）必须成功', async () => {
    await (cmd as any).updateServer(['seed'], {
      transport: 'streamable-http',
      endpoint: 'http://127.0.0.1:1/mcp',
    });

    const cfg = await readCfg();
    expect(cfg.servers.seed.transport).toBe('streamable-http');
    expect(cfg.servers.seed.endpoint).toBe('http://127.0.0.1:1/mcp');
    // 切换传输时 stdio 专用字段被清理，这是预期行为
    expect(cfg.servers.seed.command).toBeUndefined();
  });
});
