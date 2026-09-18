/**
 * MCP Proxy CLI command - Connect to daemon as MCP client proxy
 */

import { ConfigManager } from '../../config/config-manager.js';
import { CLIUtils } from '../cli-utils.js';
import { StdioMCPServer } from '../../index.js';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { Socket } from 'net';
import path from 'path';
import os from 'os';

export class ProxyCommand {
  private mcpdogDir: string;

  constructor(private configManager: ConfigManager) {
    // Use ~/.mcpdog directory for PID files
    this.mcpdogDir = path.join(os.homedir(), '.mcpdog');
  }

  /**
   * Get default PID file path in ~/.mcpdog directory
   */
  private getDefaultPidFile(): string {
    return path.join(this.mcpdogDir, 'mcpdog.pid');
  }

  async execute(args: string[], options: Record<string, any>): Promise<void> {
    if (options.help) {
      this.showHelp();
      return;
    }

    // Check transport type
    const transport = options.transport || 'stdio';

    if (transport === 'streamable-http') {
      // 用 exitCode + return 而不是 process.exit(1)：stderr 是管道时进程立即退出可能截断
      // 尚未 flush 的写入，而这段是旧用户唯一的迁移指引（Windows 是目标平台）
      process.stderr.write(
        'MCPDog: --transport streamable-http 已移除。\n' +
        '请用 `mcpdog daemon start` 启动常驻服务，然后以 URL 接入：\n' +
        '  http://127.0.0.1:38881/mcp\n'
      );
      process.exitCode = 1;
      return;
    } else if (options['web-port']) {
      await this.startWebMode(options);
    } else {
      await this.startStdioMode(options);
    }
  }

  private async startStdioMode(options: Record<string, any>): Promise<void> {
    const daemonPort = parseInt(options['daemon-port']) || 9999;
    const pidFile = options['pid-file'] || this.getDefaultPidFile();
    
    try {
      // Check if daemon is running, auto-start if not
      const isDaemonRunning = await this.isDaemonRunning(pidFile, daemonPort);

      if (!isDaemonRunning) {
        // Auto-start daemon with default parameters
        // In MCP mode, suppress all output to avoid JSON parsing errors
        await this.autoStartDaemonSilent(daemonPort, pidFile);

        // 等待 daemon 的 IPC 端口真正开始监听（npx 冷启动时固定等待不可靠），
        // 超时后仍交给 StdioProxy 做最终连接判定
        await this.waitForDaemonPort(daemonPort, 15000);
      }

      // In MCP stdio mode, don't output any debug logs to stderr
      // All non-JSON output will be mistaken as responses by MCP clients

      const { StdioProxy } = await import('../../daemon/stdio-proxy.js');
      const proxy = new StdioProxy(daemonPort, {
        // daemon 半路被杀时，由 proxy 自动重新拉起，长会话可自愈
        autoRestart: () => this.autoStartDaemonSilent(daemonPort, pidFile)
      });
      
      // Graceful shutdown handling
      process.on('SIGINT', () => {
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        process.exit(0);
      });
      
      await proxy.start();
      
      // Prevent command exit from terminating process
      await new Promise(() => {}); // Wait forever

    } catch (error) {
      // Only output error on connection failure, then exit immediately
      // Use process.stderr.write instead of CLIUtils to avoid color codes
      process.stderr.write(`MCPDog: Failed to connect to daemon on port ${daemonPort}\n`);
      process.stderr.write(`Please ensure daemon is running: mcpdog daemon start\n`);
      process.exit(1);
    }
  }

  private async startWebMode(options: Record<string, any>): Promise<void> {
    const port = parseInt(options['web-port']);
    
    // In MCP mode, suppress all output to avoid JSON parsing errors
    // Just switch to stdio mode silently
    await this.startStdioMode(options);
  }

  /**
   * Check if daemon is running by checking PID file.
   * PID 存活还需要端口握手确认：Windows 重启后 PID 可能被无关进程复用，
   * 仅凭 kill(pid, 0) 会误判 daemon 在运行而跳过拉起。
   */
  private async isDaemonRunning(pidFile: string, daemonPort: number): Promise<boolean> {
    try {
      const pid = await this.getPidFromFile(pidFile);
      if (!pid) return false;

      // Check if process is still running
      let processAlive = true;
      try {
        process.kill(pid, 0); // Signal 0 doesn't kill, just checks if process exists
      } catch {
        processAlive = false;
      }

      if (!processAlive) {
        // Process doesn't exist, clean up stale PID file
        try {
          await fs.unlink(pidFile);
        } catch {
          // Ignore errors when cleaning up
        }
        return false;
      }

      // 进程存在但目标端口无监听 → PID 已被复用或 daemon 已死，按未运行处理
      const portListening = await this.isPortListening(daemonPort);
      if (!portListening) {
        try {
          await fs.unlink(pidFile);
        } catch {
          // Ignore errors when cleaning up
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Probe whether the daemon IPC port is accepting connections
   */
  private async isPortListening(port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, 'localhost');
    });
  }

  /**
   * Poll the daemon port until it starts listening or timeout
   */
  private async waitForDaemonPort(port: number, timeoutMs: number, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isPortListening(port)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Get PID from PID file
   */
  private async getPidFromFile(pidFile: string): Promise<number | null> {
    try {
      const pidStr = await fs.readFile(pidFile, 'utf-8');
      const pid = parseInt(pidStr.trim());
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Auto-start daemon in detached mode
   */
  private async autoStartDaemon(daemonPort: number, pidFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const mcpdogPath = process.argv[0]; // node executable path
      const scriptPath = process.argv[1]; // path to cli-main.js
      const configPath = this.configManager.getConfigPath();
      
      const daemon = spawn(mcpdogPath, [
        scriptPath, 'daemon', 'start',
        '--config', configPath,
        '--daemon-port', daemonPort.toString(),
        '--pid-file', pidFile
      ], { 
        detached: true, 
        stdio: 'ignore' 
      });
      
      // Detach the daemon process from parent
      daemon.unref();
      
      // Don't wait for the daemon to start completely, just for it to spawn
      daemon.on('spawn', () => {
        resolve();
      });
      
      daemon.on('error', (error) => {
        reject(error);
      });
      
      // If no spawn event in 5 seconds, consider it failed
      setTimeout(() => {
        reject(new Error('Daemon failed to start within 5 seconds'));
      }, 5000);
    });
  }

  /**
   * Auto-start daemon in silent mode (no output to avoid MCP client errors)
   */
  private async autoStartDaemonSilent(daemonPort: number, pidFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const mcpdogPath = process.argv[0]; // node executable path
      const scriptPath = process.argv[1]; // path to cli-main.js
      const configPath = this.configManager.getConfigPath();
      
      // Use --no-color and --json flags to suppress all output
      const daemon = spawn(mcpdogPath, [
        scriptPath, 'daemon', 'start',
        '--config', configPath,
        '--daemon-port', daemonPort.toString(),
        '--pid-file', pidFile,
        '--no-color',
        '--json'
      ], { 
        detached: true, 
        stdio: 'ignore' // Completely ignore all stdio to avoid any output
      });
      
      // Detach the daemon process from parent
      daemon.unref();
      
      // Don't wait for the daemon to start completely, just for it to spawn
      daemon.on('spawn', () => {
        resolve();
      });
      
      daemon.on('error', (error) => {
        reject(error);
      });
      
      // If no spawn event in 5 seconds, consider it failed
      setTimeout(() => {
        reject(new Error('Daemon failed to start within 5 seconds'));
      }, 5000);
    });
  }

  private showHelp(): void {
    console.log(`
${CLIUtils.colorize('mcpdog proxy', 'cyan')} - Connect to MCPDog daemon as MCP client proxy

${CLIUtils.colorize('Usage:', 'yellow')}
  mcpdog proxy [options]

${CLIUtils.colorize('Options:', 'yellow')}
  --daemon-port <port>  Connect to daemon on specific port (default: 9999)
  --help               Show this help message

${CLIUtils.colorize('Description:', 'yellow')}
  This command starts MCPDog and acts as a proxy for MCP clients over stdio.

${CLIUtils.colorize('Transport Types:', 'yellow')}
  stdio - Standard input/output (default, for MCP clients like Claude Desktop)
  StreamableHTTP is no longer started by this command: it is served by the resident
  daemon at http://127.0.0.1:38881/mcp (same port as the dashboard).

${CLIUtils.colorize('Examples:', 'yellow')}
  mcpdog proxy                                    # Start with stdio transport
  mcpdog proxy --daemon-port 9999                # Use specific daemon port

${CLIUtils.colorize('MCP Client Configuration:', 'yellow')}
  
  For stdio transport (Claude Desktop, Cursor):
  {
    "mcpdog": {
      "command": "mcpdog",
      "args": ["proxy"]
    }
  }
  
  For StreamableHTTP transport: start the daemon first (mcpdog daemon start),
  then configure the client:
  {
    "mcpServers": {
      "mcpdog-http": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:38881/mcp"
      }
    }
  }

${CLIUtils.colorize('Auto-Start Behavior (stdio mode):', 'yellow')}
  • Automatically detects if daemon is running
  • If not running, starts daemon in background with default settings
  • Uses configuration from ${this.configManager.getConfigPath()}
  • No manual daemon startup required
`);
  }
}