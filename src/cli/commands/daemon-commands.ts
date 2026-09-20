/**
 * Daemon-related commands
 */

import { CLIUtils } from '../cli-utils.js';
import { ConfigManager } from '../../config/config-manager.js';
import { MCPDogDaemon } from '../../daemon/mcpdog-daemon.js';
import { DaemonClient } from '../../daemon/daemon-client.js';
import { startDaemonFileLogging } from '../../logging/daemon-file-logger.js';
import { parsePidFileContent, looksLikeOurDaemon } from '../../utils/pid-file.js';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { spawn, execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// IPC 优雅停机请求的连接超时：端口半开或被占满时 connect 会一直挂着，
// 不设上限就永远到不了强杀兜底
const SHUTDOWN_CONNECT_TIMEOUT_MS = 3000;

// 优雅停机的等待上限与轮询间隔。
// 上限必须收紧：比本版本旧的 daemon 不认识 shutdown 消息（落到 handleClientMessage 的
// default 分支只打一条告警），升级路径上必然是跨版本，等待窗口越长、静默停顿越久。
// 5s 足以覆盖 stop() 关 web server + 停子服务器的耗时。
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;
const GRACEFUL_SHUTDOWN_POLL_INTERVAL_MS = 250;

/**
 * 读取某 PID 的命令行，用于判定该进程是不是我们的 daemon。
 * 非 Windows 或读取失败时返回 null —— 表示「无法确认」，调用方须按此处理而不是当成「不是我们」。
 */
export async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = String(stdout || '').trim();
        resolve(line ? line : null);
      },
    );
  });
}

export class DaemonCommands {
  private configManager: ConfigManager;
  private mcpdogDir: string;

  constructor(configPath?: string) {
    this.configManager = new ConfigManager(configPath);
    // Create ~/.mcpdog directory for PID files and configs
    this.mcpdogDir = path.join(os.homedir(), '.mcpdog');
  }

  /**
   * Ensure ~/.mcpdog directory exists
   */
  private async ensureMCPDogDir(): Promise<void> {
    try {
      await fs.mkdir(this.mcpdogDir, { recursive: true });
    } catch (error) {
      // Directory already exists or cannot be created
    }
  }

  /**
   * Get default PID file path in ~/.mcpdog directory
   */
  private getDefaultPidFile(): string {
    return path.join(this.mcpdogDir, 'mcpdog.pid');
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(port, 'localhost', () => {
        server.close();
        resolve(true);
      });
      server.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Find an available port starting from the given port
   */
  private async findAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`);
  }

  /**
   * Reserve a port by actually binding to it
   */
  private async reservePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(port, 'localhost', () => {
        // Keep the server running to reserve the port
        resolve(true);
      });
      server.on('error', () => {
        resolve(false);
      });
    });
  }

  async start(args: string[], options: any): Promise<void> {
    const port = parseInt(options['daemon-port']) || 9999;
    let webPort = parseInt(options['web-port']);
    const pidFile = options['pid-file'] || this.getDefaultPidFile();
    
    try {
      // Ensure ~/.mcpdog directory exists
      await this.ensureMCPDogDir();

      // daemon 通常以 detached + stdio:'ignore' 启动，输出全部丢弃；所以要在任何可能提前退出的
      // 判定之前开启文件日志 —— 否则「拒绝启动」这类失败连一行痕迹都不留
      // （线上事故：陈旧 PID 文件导致 exit(1)，当天完全没有日志，排查只能靠反推）
      const daemonLogFile = startDaemonFileLogging(this.mcpdogDir);
      CLIUtils.info(`Daemon log file: ${daemonLogFile}`);

      // Check if daemon is already running；版本不同（或旧格式 PID 文件无版本信息）时自动升级重启
      const runningInfo = await this.getDaemonInfoFromFile(pidFile);
      if (runningInfo && (await this.isOurDaemonRunning(runningInfo.pid, pidFile))) {
        const currentVersion = this.readPackageVersion();
        const runningVersion = runningInfo.version;

        if (runningVersion && runningVersion === currentVersion) {
          CLIUtils.error(`Daemon is already running (PID: ${runningInfo.pid}, v${runningVersion})`);
          process.exit(1);
        }

        CLIUtils.info(`Detected running daemon v${runningVersion ?? 'unknown (old format)'} (PID: ${runningInfo.pid}), upgrading to v${currentVersion}...`);
        await this.stopDaemonByPid(runningInfo.pid, port);
        try {
          await fs.unlink(pidFile);
        } catch {
          // PID 文件不存在则忽略
        }
        CLIUtils.success(`Old daemon stopped, starting v${currentVersion}...`);
      }

      // If web-port is not specified, default to starting web server with auto port detection
      if (!webPort) {
        webPort = await this.findAvailablePort(38881);
        CLIUtils.info(`Auto-detected available web port: ${webPort}`);
      }

      const daemon = new MCPDogDaemon({
        configPath: this.configManager.getConfigPath(),
        ipcPort: port,
        pidFile
      });

      // Set up signal handling
      process.on('SIGINT', async () => {
        CLIUtils.info('Received stop signal, shutting down daemon...');
        await daemon.stop();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        await daemon.stop();
        process.exit(0);
      });

      await daemon.start();

      // Always start web server now (default behavior)
      try {
        await daemon.startWebServer(webPort);
        CLIUtils.success(`Web interface started: http://localhost:${webPort}`);
      } catch (error) {
        // If the detected port is not available, try to find another one
        if ((error as Error).message.includes('EADDRINUSE')) {
          CLIUtils.warn(`Port ${webPort} is not available, trying to find another port...`);
          const newPort = await this.findAvailablePort(webPort + 1);
          await daemon.startWebServer(newPort);
          CLIUtils.success(`Web interface started: http://localhost:${newPort}`);
          webPort = newPort;
        } else {
          throw error;
        }
      }

      CLIUtils.success(`MCPDog daemon started (PID: ${process.pid})`);
      CLIUtils.info(`IPC port: ${port}`);
      CLIUtils.info(`Web interface: http://localhost:${webPort}`);
      CLIUtils.info(`Config file: ${this.configManager.getConfigPath()}`);
      CLIUtils.info('Press Ctrl+C to stop daemon');

      // Keep process running
      await new Promise(() => {});
      
    } catch (error) {
      CLIUtils.error('Failed to start daemon:', (error as Error).message);
      process.exit(1);
    }
  }

  async stop(args: string[], options: any): Promise<void> {
    const pidFile = options['pid-file'] || this.getDefaultPidFile();
    const port = parseInt(options['daemon-port']) || 9999;

    try {
      const pid = await this.getPidFromFile(pidFile);
      if (!pid) {
        CLIUtils.error('No running daemon found');
        process.exit(1);
      }

      const graceful = await this.stopDaemonByPid(pid, port);

      if (!graceful) {
        // 强杀兜底时 daemon 的 stop() 不会执行，PID 文件只能由这里清理
        try {
          await fs.unlink(pidFile);
        } catch {
          // PID 文件已被删除则忽略
        }
      }

      CLIUtils.success('Daemon stopped');

    } catch (error) {
      CLIUtils.error('Failed to stop daemon:', (error as Error).message);
      process.exit(1);
    }
  }

  // 重启 daemon：先停掉正在运行的实例（若有），再按 start 流程启动
  async restart(args: string[], options: any): Promise<void> {
    const pidFile = options['pid-file'] || this.getDefaultPidFile();

    const info = await this.getDaemonInfoFromFile(pidFile);
    if (info) {
      let running = false;
      try {
        process.kill(info.pid, 0);
        running = true;
      } catch {
        running = false;
      }
      if (running) {
        CLIUtils.info(`Stopping daemon (PID: ${info.pid})...`);
        await this.stopDaemonByPid(info.pid, parseInt(options['daemon-port']) || 9999);
        try {
          await fs.unlink(pidFile);
        } catch {
          // PID 文件不存在则忽略
        }
        CLIUtils.success('Daemon stopped');
      }
    }

    await this.start(args, options);
  }

  // 停止指定 PID 的 daemon：先经 IPC 请求优雅停机（Windows 上 SIGTERM 无法触发 daemon 的
  // handler，见 requestShutdown），轮询等待进程消失；超时再强杀兜底。
  // 返回 true 表示优雅停机成功（PID 文件等由 daemon 自身清理），false 表示走了强杀。
  private async stopDaemonByPid(pid: number, ipcPort: number): Promise<boolean> {
    const shutdownRequested = await this.requestShutdown(ipcPort);

    if (shutdownRequested) {
      let waitedMs = 0;
      while (waitedMs < GRACEFUL_SHUTDOWN_TIMEOUT_MS) {
        if (!this.isProcessAlive(pid)) {
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, GRACEFUL_SHUTDOWN_POLL_INTERVAL_MS));
        waitedMs += GRACEFUL_SHUTDOWN_POLL_INTERVAL_MS;
        // 进度可见：老版本 daemon 会忽略 shutdown 消息，不打印就是一段没有解释的静默停顿
        if (waitedMs % 1000 === 0) {
          CLIUtils.info(`Waiting for daemon (PID ${pid}) to stop gracefully... ${waitedMs / 1000}s / ${GRACEFUL_SHUTDOWN_TIMEOUT_MS / 1000}s`);
        }
      }

      // 最后一次轮询的 sleep 期间进程可能刚好退出：必须先复核存活再升级强杀。
      // 否则会对一个已死 PID 再执行一次强杀，并把一次成功的优雅停机误报为失败
      // （stop() 还会因此去删 daemon 已经删掉的 PID 文件）。
      if (!this.isProcessAlive(pid)) {
        return true;
      }

      CLIUtils.warn(
        `Daemon (PID ${pid}) did not stop gracefully within ${GRACEFUL_SHUTDOWN_TIMEOUT_MS / 1000}s. ` +
        'The running daemon may predate this version and not support graceful shutdown ' +
        '(older builds ignore the shutdown message). Forcing termination...'
      );
    } else {
      // shutdown 请求没送出去（daemon 在不同 IPC 端口或已死）时不等 5s，直接强杀兜底
      CLIUtils.warn('Daemon did not accept the shutdown request, forcing termination...');
    }

    const killed = await this.forceKill(pid);
    if (!killed) {
      // 不能吞掉：daemon 可能仍在运行，调用方若继续报 "Daemon stopped" 就是假成功
      throw new Error(`Daemon (PID ${pid}) is still running after a failed force kill`);
    }
    return false;
  }

  // 强杀兜底：Windows 上 process.kill 的 SIGKILL 同样是 TerminateProcess，用 taskkill /F 更明确。
  // /T 必须带：Windows 没有 job object，父进程被杀不会带走子进程，缺 /T 会把子服务器 node 进程
  // 全部留成孤儿 —— 而这条兜底路径正是优雅停机失败时走的、最可能产生孤儿的那条。
  // 返回 false 表示进程可能仍存活，调用方不得报成功。
  private async forceKill(pid: number): Promise<boolean> {
    if (!this.isProcessAlive(pid)) {
      return true;
    }

    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch (error) {
        CLIUtils.warn(`Failed to kill daemon (PID ${pid}): ${(error as Error).message}`);
        return false;
      }
    }

    return new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      killer.on('close', (code) => {
        if (code === 0) {
          resolve(true);
          return;
        }
        // 进程恰好在 taskkill 执行期间退出时 taskkill 也会回非 0（找不到进程），
        // 以存活实况为准，不能仅凭退出码判定失败
        if (!this.isProcessAlive(pid)) {
          resolve(true);
          return;
        }
        CLIUtils.warn(`taskkill exited with code ${code}, daemon (PID ${pid}) may still be running`);
        resolve(false);
      });
      killer.on('error', (error) => {
        CLIUtils.warn(`taskkill failed: ${error.message}`);
        resolve(false);
      });
    });
  }

  // 进程存活探测：signal 0 不发送信号，仅做存在性检查
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // 请求 daemon 走优雅停机（stop() + process.exit）。
  // 返回 false 表示请求没能送达（daemon 已死或端口不通），交给强杀兜底。
  private async requestShutdown(ipcPort: number): Promise<boolean> {
    const client = new DaemonClient({
      port: ipcPort,
      clientType: 'cli',
      reconnect: false,
      silent: true
    });

    // daemon 退出会让 socket 报错；EventEmitter 对无监听的 'error' 事件会直接抛出，
    // 会把一次成功的停机变成 CLI 崩溃，所以这里必须挂一个兜底监听
    client.on('error', () => {});

    try {
      await client.connect(SHUTDOWN_CONNECT_TIMEOUT_MS);
      client.shutdown();
      return true;
    } catch (error) {
      CLIUtils.verbose(`IPC shutdown request failed, falling back to kill: ${(error as Error).message}`);
      return false;
    } finally {
      client.disconnect();
    }
  }

  async status(args: string[], options: any): Promise<void> {
    const port = parseInt(options['daemon-port']) || 9999;
    
    try {
      const client = new DaemonClient({
        port,
        clientType: 'cli',
        reconnect: false,
        silent: true
      });

      await client.connect();
      
      client.on('status', (status) => {
        this.displayFriendlyStatus(status, port);
        client.disconnect();
        process.exit(0);
      });

      client.getStatus();
      
      // Timeout handling
      setTimeout(() => {
        console.log(`
❌ ${CLIUtils.colorize('Status check timeout', 'red')}

${CLIUtils.colorize('Possible issues:', 'yellow')}
  • Daemon not responding on port ${port}
  • Network connectivity issues
  • Daemon overloaded

${CLIUtils.colorize('Try:', 'cyan')}
  mcpdog start      # Start the daemon
  mcpdog stop       # Stop and restart
`);
        client.disconnect();
        process.exit(1);
      }, 5000);
      
    } catch (error) {
      this.displayConnectionError(error as Error, port);
    }
  }

  private displayFriendlyStatus(status: any, port: number): void {
    const daemon = status.daemon || {};
    const mcpServer = status.mcpServer || {};
    const servers = status.servers || [];

    console.log(`
✅ ${CLIUtils.colorize('MCPDog daemon is running', 'green')}

${CLIUtils.colorize('Daemon Info:', 'cyan')}
  🔌 IPC Port: ${port}
  ⏱️  Uptime: ${this.formatUptime(daemon.uptime || 0)}
  👥 Connected clients: ${daemon.clients?.length || 0}

${CLIUtils.colorize('MCP Server Status:', 'cyan')}
  🚀 Initialized: ${mcpServer.initialized ? '✅ Yes' : '❌ No'}
  🎯 Client: ${mcpServer.client?.clientName || 'Unknown'} v${mcpServer.client?.clientVersion || 'Unknown'}

${CLIUtils.colorize('MCP Servers:', 'cyan')}`);

    if (servers.length === 0) {
      console.log('  📭 No MCP servers configured');
    } else {
      servers.forEach((server: any) => {
        const status = server.connected ? '✅' : '❌';
        const toolCount = server.toolCount || 0;
        console.log(`  ${status} ${server.name} (${toolCount} tools)`);
      });
    }

    if (daemon.clients && daemon.clients.length > 0) {
      console.log(`\n${CLIUtils.colorize('Active Clients:', 'cyan')}`);
      daemon.clients.forEach((client: any) => {
        const lastSeen = new Date(client.lastSeen);
        const timeDiff = Math.round((Date.now() - lastSeen.getTime()) / 1000);
        console.log(`  📱 ${client.type} (last active: ${timeDiff}s ago)`);
      });
    }

    console.log(`
${CLIUtils.colorize('Management:', 'cyan')}
  🌐 Web interface: Check with 'mcpdog start --web-port 38881'
  🔄 Reload config: mcpdog daemon reload
  🛑 Stop daemon: mcpdog stop
`);
  }

  private displayConnectionError(error: Error, port: number): void {
    console.log(`
❌ ${CLIUtils.colorize('Cannot connect to MCPDog daemon', 'red')}

${CLIUtils.colorize('Connection Details:', 'yellow')}
  • Port: ${port}
  • Error: ${error.message}

${CLIUtils.colorize('Possible Solutions:', 'yellow')}
  1. Start the daemon:
     mcpdog start --config your-config.json

  2. Check if daemon is running:
     ps aux | grep mcpdog

  3. Check port conflicts:
     lsof -i :${port}

  4. Use different port:
     mcpdog status --daemon-port 9998

${CLIUtils.colorize('Quick Start:', 'cyan')}
  mcpdog start --config simple-config.json --web-port 38881
`);
    process.exit(1);
  }

  private formatUptime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.round(seconds / 60);
      return `${minutes}m`;
    } else {
      const hours = Math.round(seconds / 3600);
      const minutes = Math.round((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  async reload(args: string[], options: any): Promise<void> {
    const port = parseInt(options['daemon-port']) || 9999;
    
    try {
      const client = new DaemonClient({
        port,
        clientType: 'cli',
        reconnect: false
      });

      await client.connect();
      
      client.reloadConfig();
              CLIUtils.success('Configuration reload request sent');
      
      setTimeout(() => {
        client.disconnect();
        process.exit(0);
      }, 1000);
      
    } catch (error) {
      CLIUtils.error('Failed to connect to daemon:', (error as Error).message);
      process.exit(1);
    }
  }

  // 读取 PID 文件，兼容两种格式：
  // 新格式：{"pid":123,"version":"1.0.4"}（含版本号，用于升级检测）
  // 旧格式：纯数字 PID（无版本信息）
  private async getDaemonInfoFromFile(pidFile: string): Promise<{ pid: number; version: string | null } | null> {
    try {
      return parsePidFileContent(await fs.readFile(pidFile, 'utf-8'));
    } catch (error) {
      return null;
    }
  }

  /**
   * PID 文件里的 PID 是否**真的是我们的 daemon**。
   *
   * 只判「PID 存活」是不够的：daemon 被非正常终止（重启、强杀）时不会清理 PID 文件，
   * 而重启后该 PID 很容易被别的程序复用。此时若按存活认定「已在运行」：
   * - 版本恰好相同 → 直接 exit(1)，daemon 在整个登录会话里都起不来；
   * - 版本不同 → 更糟，会去 taskkill 一个无关进程。
   *
   * 读不到命令行时返回 true（无法确认身份，保持保守行为）并记日志；
   * 只有明确读到「不是我们的 daemon」才忽略该 PID 记录并清掉陈旧文件。
   */
  private async isOurDaemonRunning(pid: number, pidFile: string): Promise<boolean> {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return false;

    const commandLine = await readProcessCommandLine(pid);
    if (commandLine === null) {
      CLIUtils.warn(`PID ${pid} 存活但读不到命令行，无法确认身份，按「已在运行」处理`);
      return true;
    }
    if (looksLikeOurDaemon(commandLine)) return true;

    CLIUtils.warn(
      `PID 文件陈旧：PID ${pid} 现属于其他进程（${commandLine.slice(0, 140)}），忽略该记录并清理`,
    );
    try {
      await fs.unlink(pidFile);
    } catch {
      // 文件可能已被清理，忽略
    }
    return false;
  }

  private async getPidFromFile(pidFile: string): Promise<number | null> {
    const info = await this.getDaemonInfoFromFile(pidFile);
    return info?.pid ?? null;
  }

  // 读取当前包版本号（src/cli/commands 与 dist/cli/commands 均为三层到包根）
  private readPackageVersion(): string {
    try {
      const packagePath = path.join(__dirname, '../../../package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
      return packageJson.version || 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  getCommands() {
    return {
      'daemon:start': {
        description: 'Start MCPDog daemon',
        handler: this.start.bind(this),
        options: {
          'daemon-port': 'Daemon IPC port (default: 9999)',
          'web-port': 'Enable Web interface port',
          'pid-file': 'PID file path'
        }
      },
      'daemon:stop': {
        description: 'Stop MCPDog daemon',
        handler: this.stop.bind(this),
        options: {
          'daemon-port': 'Daemon IPC port (default: 9999)',
          'pid-file': 'PID file path'
        }
      },
      'daemon:restart': {
        description: 'Restart MCPDog daemon',
        handler: this.restart.bind(this),
        options: {
          'daemon-port': 'Daemon IPC port (default: 9999)',
          'web-port': 'Enable Web interface port',
          'pid-file': 'PID file path'
        }
      },
      'daemon:status': {
        description: 'Check daemon status',
        handler: this.status.bind(this),
        options: {
          'daemon-port': 'Daemon IPC port (default: 9999)'
        }
      },
      'daemon:reload': {
        description: 'Reload daemon configuration',
        handler: this.reload.bind(this),
        options: {
          'daemon-port': 'Daemon IPC port (default: 9999)'
        }
      }
    };
  }
}