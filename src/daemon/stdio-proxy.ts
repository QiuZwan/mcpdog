/**
 * Stdio proxy - MCP client connecting to daemon
 * Acts as a bridge between MCP client and daemon
 */

import { createInterface } from 'readline';
import { DaemonClient } from './daemon-client.js';

export interface StdioProxyOptions {
  /**
   * daemon 连接持续被拒（如被意外杀死）时的自救回调，
   * 由调用方传入重新拉起 daemon 的逻辑；不传则仅被动重连
   */
  autoRestart?: () => void | Promise<void>;
}

export class StdioProxy {
  private daemonClient: DaemonClient;
  private readline: any;
  private isReady = false;
  // 连续 ECONNREFUSED 计数与自拉起冷却，防止频繁 spawn
  private connFailures = 0;
  private lastRespawnAt = 0;

  constructor(daemonPort?: number, private options: StdioProxyOptions = {}) {
    this.daemonClient = new DaemonClient({
      port: daemonPort || 9999,
      clientType: 'stdio',
      reconnect: true,
      silent: true // Enable silent mode to avoid log pollution in stdio
    });

    this.setupStdio();
    this.setupDaemonClient();
  }

  private setupStdio() {
    this.readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      crlfDelay: Infinity
    });

    this.readline.on('line', (line: string) => {
      this.handleStdioInput(line.trim());
    });

    this.readline.on('close', () => {
      this.shutdown();
    });

    // Handle process signals
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private setupDaemonClient() {
    this.daemonClient.on('connected', () => {
      // Connection established but handshake not completed yet, don't set as ready for now
    });

    this.daemonClient.on('disconnected', () => {
      this.isReady = false;
    });

    this.daemonClient.on('error', (error) => {
      // Only output to stderr for serious errors
      if (!this.isReady) {
        process.stderr.write(`MCPDog connection error: ${error.message}\n`);
      }

      // 连接被持续拒绝（daemon 已死，被动重连永远失败）时触发重新拉起
      const code = (error as NodeJS.ErrnoException).code || '';
      if (String(code).includes('ECONNREFUSED') || String(error.message).includes('ECONNREFUSED')) {
        this.connFailures++;
        const cooldownOver = Date.now() - this.lastRespawnAt > 30000;
        if (this.connFailures >= 3 && cooldownOver && this.options.autoRestart) {
          this.connFailures = 0;
          this.lastRespawnAt = Date.now();
          process.stderr.write('[MCPDog] daemon unreachable, attempting to restart daemon...\n');
          void this.options.autoRestart();
        }
      }
    });

    this.daemonClient.on('welcome', (message) => {
      // Set as ready immediately after receiving welcome message, because daemon is running
      this.isReady = true;
    });

    this.daemonClient.on('ready', (serverStatus) => {
      // Handshake completed, ensure ready status
      this.isReady = true;
    });

    // Listen to daemon events, forward to MCP client
    this.daemonClient.on('server-started', () => {
      // Can send notifications to MCP client
    });

    this.daemonClient.on('routes-updated', (data) => {
      // Tool routes updated, may need to send notifications
    });

    // 服务端发起的 MCP 通知（如 notifications/tools/list_changed）必须原样写回客户端 stdout。
    // 之前这里没有任何监听，daemon 就算发出来也会止步于代理进程。
    this.daemonClient.on('mcp-notification', (notification: any) => {
      this.sendStdioResponse(notification);
    });
  }

  private async handleStdioInput(line: string) {
    if (!line) return;

    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      // 只有真正的解析失败才是 Parse error；不能把下游转发失败也算成它
      this.sendStdioResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error"
        }
      });
      return;
    }

    try {
      // Check if it's a notification message (no id field)
      if (!('id' in request)) {
        // Notification messages are temporarily ignored or forwarded to daemon
        return;
      }

      // If daemon connection is not ready yet, wait a bit
      if (!this.isReady) {
        // Give some time for connection to establish
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // If still not ready, try to send request directly
      if (!this.isReady && !this.daemonClient.connected) {
        this.sendStdioResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "MCPDog daemon not connected"
          }
        });
        return;
      }

      // Forward MCP request to daemon (even if isReady is false, as long as connection exists)
      const response = await this.daemonClient.sendMCPRequest(request);
      
      // Send response back to stdio
      this.sendStdioResponse(response);
      
    } catch (error) {
      // 转发失败（daemon 断开、请求在途时连接关闭等）：必须回一条 JSON-RPC 错误，
      // 否则客户端在等一个永远不会来的响应。此前这里统一回 "Parse error"，
      // 把连接问题误报成报文格式问题，排查方向被带偏。
      this.sendStdioResponse({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: {
          code: -32603,
          message: `Internal error: ${(error as Error).message}`
        }
      });
    }
  }

  private sendStdioResponse(response: any) {
    // Write response directly to stdout for MCP protocol
    const responseStr = JSON.stringify(response) + '\n';
    process.stdout.write(responseStr);
    
    // Log summary to stderr for debugging (avoid stdout pollution)
    if (responseStr.length > 1000) {
      process.stderr.write(`[DEBUG] Response sent (${responseStr.length} chars)\n`);
    }
  }

  async start(): Promise<void> {
    try {
      await this.daemonClient.connect();
      // After successful connection, start processing MCP requests
    } catch (error) {
      process.stderr.write(`MCPDog failed to connect to daemon: ${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  private shutdown() {
    // Silent shutdown, no log output
    if (this.readline) {
      this.readline.close();
    }
    this.daemonClient.disconnect();
    process.exit(0);
  }
}