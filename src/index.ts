import { createInterface } from 'readline';
import { MCPDogServer } from './core/mcpdog-server.js';
import { MCPDogConfig, MCPMessage, MCPNotification, MCPNotificationRequest, MCPResponse, MCPRequest } from './types/index.js';
import { ConfigManager } from './config/config-manager.js';

export class StdioMCPServer {
  private server: MCPDogServer;
  private readline: any;
  private lastProcessedLine: string = ''; // Prevent duplicate line processing

  constructor(configManager: ConfigManager) {
    console.error(`[STDIO] Creating StdioMCPServer instance`);
    this.server = new MCPDogServer(configManager);
    this.setupServer();
    this.setupStdio();
  }

  private setupServer(): void {
    this.server.on('notification', (notification: MCPNotification) => {
      this.sendMessage(notification);
    });

    this.server.on('error', ({ error, context }) => {
      console.error(`MCPDog error [${context}]:`, error);
    });

    this.server.on('started', () => {
      console.error('MCPDog Server started (stdio mode)');
    });

    this.server.on('stopped', () => {
      console.error('MCPDog Server stopped');
    });
  }

  private setupStdio(): void {
    this.readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      crlfDelay: Infinity
    });

    this.readline.on('line', (line: string) => {
      console.error(`[STDIO] Received line: ${line.substring(0, 50)}...`);
      this.handleInput(line.trim());
    });

    this.readline.on('close', () => {
      this.shutdown();
    });

    // Handle process signals
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      this.shutdown();
    });
  }

  private async handleInput(line: string): Promise<void> {
    console.error(`[STDIO] handleInput called with: ${line.substring(0, 30)}...`);
    
    if (!line) {
      return;
    }
    
    // Prevent processing duplicate lines
    if (line === this.lastProcessedLine) {
      console.error(`[DEDUP] Ignoring duplicate line processing`);
      return;
    }
    this.lastProcessedLine = line;

    try {
      const message = JSON.parse(line) as MCPMessage;
      
      // Check if it's a notification message (no id field)
      if (!('id' in message)) {
        const notification = message as MCPNotificationRequest;
        console.error(`Handling notification: ${notification.method}`);
        // Notifications don't need responses
        return;
      }
      
      // Handle regular requests
      const request = message as MCPRequest;
      
      console.error(`Processing request: ${request.method} (id: ${request.id})`);
      const response = await this.server.handleRequest(request, 'stdio-client');
      console.error(`Sending response for: ${request.method} (id: ${request.id})`);
      this.sendMessage(response);
      
    } catch (error) {
      console.error('Error processing request:', error);
      // Don't send error response, only log error
    }
  }

  private sendMessage(message: MCPResponse | MCPNotification): void {
    
    const messageStr = JSON.stringify(message);
    console.log(messageStr);
  }

  async start(): Promise<void> {
    try {
      console.error(`[STDIO] Starting StdioMCPServer...`);
      await this.server.start();
      console.error(`[STDIO] StdioMCPServer started successfully`);
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  private async shutdown(): Promise<void> {
    console.error('Shutting down MCPDog Server...');
    
    try {
      if (this.readline) {
        this.readline.close();
      }
      
      await this.server.stop();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

interface ParsedArgs {
  configPath?: string;
  transport?: string;
  /** 只服务于已移除的 HTTP 传输的参数（--port / --web-port），仅用于给出迁移指引 */
  removedEntry?: string;
}

// Parse command line arguments
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--config' || arg === '-c') {
      result.configPath = args[i + 1];
      i++;
    } else if (arg === '--transport' || arg === '-t') {
      // 仍需解析该参数：stdio 是合法取值，只有非 stdio 才属于已移除的 HTTP 入口
      result.transport = args[i + 1];
      i++;
    } else if (arg === '--port' || arg === '-p' || arg === '--web-port') {
      // 这两个参数只服务于已移除的 HTTP 传输入口
      result.removedEntry = `${arg} ${args[i + 1] ?? ''}`.trim();
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
MCPDog - Universal MCP Server Manager

Usage: mcpdog [options]

Options:
  -c, --config <path>     Configuration file path (default: ./mcpdog.config.json)
  -h, --help              Show this help message

Examples:
  mcpdog                                    # Start with stdio transport
  mcpdog --config ./my-config.json         # Use custom config file

StreamableHTTP MCP is served by the resident daemon, not by this command:
  mcpdog daemon start
  http://127.0.0.1:38881/mcp

For more information, visit: https://github.com/SIE-Operations-and-Maintenance-Team/mcpdog
      `);
      process.exit(0);
    }
  }

  return result;
}

// Main program entry point
async function main(): Promise<void> {
  const { configPath, transport, removedEntry } = parseArgs();

  // 非 stdio 传输（含 streamable-http）与 --port / --web-port 均已随 HTTP 传输入口移除
  const removed = removedEntry ?? (transport && transport !== 'stdio' ? `--transport ${transport}` : undefined);

  if (removed) {
    // 用 exitCode + return 而不是 process.exit(1)：stderr 是管道时进程立即退出可能截断
    // 尚未 flush 的写入，而这段是旧用户唯一的迁移指引（Windows 是目标平台）
    process.stderr.write(
      `MCPDog: ${removed} 已移除。\n` +
      '请用 `mcpdog daemon start` 启动常驻服务，然后以 URL 接入：\n' +
      '  http://127.0.0.1:38881/mcp\n'
    );
    process.exitCode = 1;
    return;
  }

  const configManager = new ConfigManager(configPath);
  await configManager.loadConfig(); // Load config before passing to server

  const mcpServer = new StdioMCPServer(configManager);
  await mcpServer.start();
}

// Only start server when this file is run directly, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}