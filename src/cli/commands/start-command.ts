/**
 * Start Command - 用户友好的启动命令
 */

import { ConfigManager } from '../../config/config-manager.js';
import { CLIUtils } from '../cli-utils.js';
import { DaemonCommands } from './daemon-commands.js';
import { spawn } from 'child_process';
import { DaemonClient } from '../../daemon/daemon-client.js';
import { MCPDogDaemon, DaemonConfig } from '../../daemon/mcpdog-daemon.js';
import { parsePidFileContent, looksLikeOurDaemon } from '../../utils/pid-file.js';
import { readProcessCommandLine } from './daemon-commands.js';
import { createServer } from 'net';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

interface StartupConfig {
  enableStdio: boolean;
  enableDashboard: boolean;
  dashboardPort: number;
  daemonPort: number;
  pidFile: string;
}

export class StartCommand {
  private daemonCommands: DaemonCommands;

  constructor(private configManager: ConfigManager) {
    this.daemonCommands = new DaemonCommands(configManager.getConfigPath());
  }

  async execute(args: string[], options: Record<string, any>): Promise<void> {
    if (options.help) {
      this.showHelp();
      return;
    }

    try {
      // 加载配置以获取准确信息
      await this.configManager.loadConfig();
      
      // 检查守护进程是否已在运行
      const isAlreadyRunning = await this.isDaemonRunning(options);
      if (isAlreadyRunning) {
        console.log(`
❌ ${CLIUtils.colorize('MCPDog daemon is already running', 'red')}

${CLIUtils.colorize('Available actions:', 'yellow')}
  mcpdog status    # Check current status
  mcpdog stop      # Stop the daemon
`);
        process.exit(1);
      }

      // 解析启动模式
      const startupConfig = this.parseStartupOptions(options);
      
      // 显示启动信息
      this.showStartingInfo(startupConfig);
      
      // 启动守护进程
      await this.startDaemonWithConfig(startupConfig);
      
    } catch (error) {
      await this.showStartupError(error as Error, options);
    }
  }

  private parseStartupOptions(options: Record<string, any>): StartupConfig {
    // 支持向后兼容性
    const dashboardPort = parseInt(options['dashboard-port']) ||
                         parseInt(options['web-port']) || 38881;
    const daemonPort = parseInt(options['daemon-port']) || 9999;
    const pidFile = options['pid-file'] || path.join(os.homedir(), '.mcpdog', 'mcpdog.pid');

    if (options['mcp-http-port']) {
      console.warn('[MCPDog] --mcp-http-port 已弃用：/mcp 与 dashboard 同端口，此选项被忽略。');
    }
    if (options['http-only']) {
      throw new Error('--http-only 已移除：/mcp 与 dashboard 同端口，无法只开 HTTP 传输。');
    }

    return {
      enableStdio: true,
      enableDashboard: !options['no-dashboard'],
      dashboardPort,
      daemonPort,
      pidFile,
    };
  }

  private async showStartupInfo(startupConfig: StartupConfig): Promise<void> {
    // 等待一点时间让守护进程完全启动
    await new Promise(resolve => setTimeout(resolve, 1000));

    const config = this.configManager.getConfig();
    const enabledServers = this.configManager.getEnabledServers();

    console.log(`
🚀 ${CLIUtils.colorize('MCPDog started successfully!', 'green')}

📊 ${CLIUtils.colorize('Services:', 'cyan')}${startupConfig.enableStdio ? `
  ✅ Stdio Transport: Ready (for MCP clients)` : ''}${startupConfig.enableDashboard ? `
  ✅ Dashboard UI: ${CLIUtils.colorize(`http://localhost:${startupConfig.dashboardPort}`, 'blue')}
  ✅ MCP Endpoint: ${CLIUtils.colorize(`http://127.0.0.1:${startupConfig.dashboardPort}/mcp`, 'blue')} (StreamableHTTP, same port as dashboard)` : ''}

🔧 ${CLIUtils.colorize('Configuration:', 'cyan')}
  📁 Config: ${this.configManager.getConfigPath()}
  🔧 Servers: ${Object.keys(enabledServers).join(', ')} (${this.getTotalToolCount()} tools)

📋 ${CLIUtils.colorize('Usage:', 'cyan')}${startupConfig.enableStdio ? `
  • MCP Clients: Use 'npx mcpdog@latest' in client config` : ''}${startupConfig.enableDashboard ? `
  • MCP Clients (HTTP): Connect to http://127.0.0.1:${startupConfig.dashboardPort}/mcp
  • Manage: Visit http://localhost:${startupConfig.dashboardPort}` : ''}

⏹️  ${CLIUtils.colorize('Stop:', 'cyan')} npx mcpdog@latest stop

${CLIUtils.colorize('[INFO]', 'cyan')} Daemon is running in the background
`);
  }

  private async startDaemonWithConfig(startupConfig: StartupConfig): Promise<void> {
    // 查找可用端口
    const finalConfig = await this.findAvailablePorts(startupConfig);
    
    // 显示端口变化信息
    if (finalConfig.dashboardPort !== startupConfig.dashboardPort) {
      CLIUtils.warn(`Dashboard port ${startupConfig.dashboardPort} is busy, using ${finalConfig.dashboardPort}`);
    }

    // 确保 .mcpdog 目录存在
    const mcpdogDir = path.dirname(finalConfig.pidFile);
    try {
      await fs.mkdir(mcpdogDir, { recursive: true });
    } catch (error) {
      // 目录可能已存在，忽略错误
    }

    // 创建 daemon 配置：dashboard 端口由 startWebServer(port) 参数传入，不在此处配置
    const daemonConfig: DaemonConfig = {
      configPath: this.configManager.getConfigPath(),
      ipcPort: finalConfig.daemonPort,
      pidFile: finalConfig.pidFile,
    };

    // 启动 daemon
    const daemon = new MCPDogDaemon(daemonConfig);
    
    try {
      await daemon.start();
      
      // 启动 dashboard (如果启用)
      if (finalConfig.enableDashboard) {
        try {
          await daemon.startWebServer(finalConfig.dashboardPort);
        } catch (error) {
          CLIUtils.warn(`Failed to start dashboard on port ${finalConfig.dashboardPort}: ${(error as Error).message}`);
        }
      }

      // 显示成功信息
      await this.showStartupInfo(finalConfig);

    } catch (error) {
      throw new Error(`Failed to start daemon: ${(error as Error).message}`);
    }
  }

  private async findAvailablePorts(config: StartupConfig): Promise<StartupConfig> {
    const result = { ...config };
    
    if (config.enableDashboard) {
      result.dashboardPort = await this.findAvailablePort(config.dashboardPort);
    }
    
    return result;
  }

  private async findAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`No available port found starting from ${startPort} (tried ${maxAttempts} ports)`);
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      // 与 dashboard 实际绑定地址一致（见 daemon-web-server 监听 127.0.0.1）：
      // 'localhost' 会先解析到 ::1，把已占用的 127.0.0.1 端口误报为可用
      server.listen(port, '127.0.0.1', () => {
        server.close();
        resolve(true);
      });
      server.on('error', () => {
        resolve(false);
      });
    });
  }

  private async showStartupError(error: Error, options: Record<string, any>): Promise<void> {
    const configPath = this.configManager.getConfigPath();
    
    console.log(`
❌ ${CLIUtils.colorize('Startup failed:', 'red')} ${error.message}

${CLIUtils.colorize('Common solutions:', 'yellow')}
  1. Check if configuration file exists:
     ls -la ${configPath}
     
  2. Create a default configuration:
     mcpdog config init
     
  3. Validate your configuration:
     mcpdog config validate
     
  4. Check if port is already in use:
     lsof -i :${options['daemon-port'] || 9999}

${CLIUtils.colorize('Need help?', 'cyan')}
  mcpdog --help          # Show all commands
  mcpdog config --help   # Configuration help
  mcpdog daemon --help   # Advanced daemon options
`);
    
    process.exit(1);
  }

  private async isDaemonRunning(options: Record<string, any>): Promise<boolean> {
    // 必须与 daemon 实际写入的文件一致：daemon 用 options['pid-file'] 或
    // ~/.mcpdog/mcpdog.pid（见 parseStartupOptions），此前这里却按 cwd 找，
    // 于是这个「已在运行」守卫从未命中。
    const pidFile = options['pid-file'] || path.join(os.homedir(), '.mcpdog', 'mcpdog.pid');
    try {
      const pidData = await fs.readFile(pidFile, 'utf-8');
      // 文件内容是新格式 {"pid":N,"version":"x"}，必须走共享解析器：
      // 直接 parseInt 会得到 NaN，process.kill(NaN,0) 抛 ERR_INVALID_ARG_TYPE 被吞掉，
      // 判定同样形同虚设。
      const info = parsePidFileContent(pidData);
      if (!info) return false;

      // 检查进程是否存在
      process.kill(info.pid, 0);

      // 光「PID 活着」不够：非正常终止不会清理 PID 文件，重启后该 PID 很容易被
      // 别的程序复用。不校验身份就会把无关进程当成自己的 daemon —— 轻则永久拒绝
      // 启动（用户再也起不来 daemon），重则调用方据此去终止那个无关进程。
      // 读不到命令行时按「不能认定它在运行」处理（shared helper 的契约）。
      const commandLine = await readProcessCommandLine(info.pid);
      if (looksLikeOurDaemon(commandLine)) {
        return true;
      }

      CLIUtils.warn(
        `PID 文件陈旧：PID ${info.pid} 不是 MCPDog daemon，忽略该记录`
      );
      try {
        await fs.unlink(pidFile);
      } catch {
        // 文件可能已被清理，忽略
      }
      return false;
    } catch {
      return false;
    }
  }

  private showStartingInfo(options: Record<string, any>): void {
    console.log(`
🚀 ${CLIUtils.colorize('Starting MCPDog daemon...', 'cyan')}
`);
  }



  private getTotalToolCount(): number {
    const enabledServers = this.configManager.getEnabledServers();
    return Object.keys(enabledServers).length;
  }

  private showHelp(): void {
    console.log(`
${CLIUtils.colorize('mcpdog start', 'cyan')} - Start MCPDog daemon with all services

${CLIUtils.colorize('Usage:', 'yellow')}
  mcpdog start [options]

${CLIUtils.colorize('Options:', 'yellow')}
  -c, --config <path>        Configuration file path (default: ./mcpdog.config.json)
  --dashboard-port <port>    Dashboard UI + MCP endpoint port (default: 38881, auto-detected)
  --daemon-port <port>       IPC daemon port (default: 9999)
  --pid-file <path>          PID file location (default: ~/.mcpdog/mcpdog.pid)
  
  --stdio-only               No-op, kept for compatibility (stdio is always on)
  --no-dashboard             Disable dashboard UI (and the /mcp endpoint); no listening port is opened
  
  --web-port <port>          Deprecated, use --dashboard-port
  --mcp-http-port <port>     Deprecated and ignored, /mcp shares the dashboard port
  --http-only                Removed, /mcp shares the dashboard port
  --help                     Show this help message

${CLIUtils.colorize('Default Behavior:', 'yellow')}
  By default, 'mcpdog start' enables all services:
  • Stdio Transport (for MCP clients)
  • Dashboard UI + StreamableHTTP MCP endpoint (same port, http://127.0.0.1:38881/mcp)

${CLIUtils.colorize('Examples:', 'yellow')}
  mcpdog start                              # Start all services
  mcpdog start --stdio-only                 # No-op, same as plain 'mcpdog start'
  mcpdog start --no-dashboard               # Stdio only, no listening port
  mcpdog start --dashboard-port 3001        # Custom dashboard/MCP port

${CLIUtils.colorize('After starting:', 'yellow')}
  • MCP Clients (stdio): Use 'npx mcpdog@latest' in client config
  • MCP Clients (HTTP): Connect to http://127.0.0.1:38881/mcp
  • Management: Visit http://localhost:38881
  • Stop: mcpdog stop
`);
  }
}