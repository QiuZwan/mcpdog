/**
 * MCPDog Daemon
 * Unified management of MCP servers, supporting multiple client access modes
 */

import { EventEmitter } from 'events';
import { createServer, Server as NetServer } from 'net';
import { MCPDogServer } from '../core/mcpdog-server.js';
import { ConfigManager } from '../config/config-manager.js';
import type { DaemonWebServer } from './daemon-web-server.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonConfig {
  configPath: string;
  ipcPort?: number;
  pidFile?: string;
}

export interface DaemonClient {
  id: string;
  type: 'stdio' | 'web' | 'cli';
  socket?: any;
  lastSeen: Date;
}

export class MCPDogDaemon extends EventEmitter {
  private mcpServer: MCPDogServer;
  private configManager: ConfigManager;
  private ipcServer: NetServer;
  private webServer?: DaemonWebServer;
  private clients = new Map<string, DaemonClient>();
  private config: DaemonConfig;
  private isRunning = false;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;
    this.configManager = new ConfigManager(config.configPath);
    this.mcpServer = new MCPDogServer(this.configManager);
    this.ipcServer = createServer();
    
    this.setupMCPServerEvents();
    this.setupIPCServer();
  }

  private setupMCPServerEvents() {
    // Forward MCP server events to all clients
    this.mcpServer.on('started', () => {
      this.broadcastToClients('server-started', {});
    });

    this.mcpServer.on('stopped', () => {
      this.broadcastToClients('server-stopped', {});
    });

    // MCP 协议通知（如 notifications/tools/list_changed）必须转发给 stdio 客户端。
    // 此前全仓只有 src/index.ts（直接 stdio 模式）监听了 'notification'，daemon 没有，
    // 于是经 daemon 接入的客户端在配置热更新后永远收不到通知，工具列表停在旧状态 ——
    // 而 initialize 响应里还宣告了 tools.listChanged: true。
    this.mcpServer.on('notification', (notification: any) => {
      this.broadcastRawToClients(notification);
    });

    // Listen for individual server connection events
    this.mcpServer.on('server-connected', (data) => {
      console.log(`[DAEMON] Received server-connected event for: ${data.serverName}`);
      this.broadcastToClients('server-connected', data);
      console.log(`[DAEMON] Broadcasted server-connected event for: ${data.serverName}`);
    });

    this.mcpServer.on('server-disconnected', (data) => {
      this.broadcastToClients('server-disconnected', data);
    });

    this.mcpServer.on('server-error', (data) => {
      this.broadcastToClients('server-error', data);
    });

    this.mcpServer.on('server-log', (data) => {
      this.broadcastToClients('server-log', data);
    });

    // Listen for tool router events
    const toolRouter = this.mcpServer.getToolRouter();
    toolRouter.on('routes-updated', (data) => {
      this.broadcastToClients('routes-updated', data);
    });

    toolRouter.on('tool-called', (data) => {
      this.broadcastToClients('tool-called', data);
    });

    toolRouter.on('error', (data) => {
      this.broadcastToClients('error', data);
    });

    // Listen for config changes
    this.configManager.on('config-updated', (data) => {
      this.broadcastToClients('config-changed', data.config);
      // If it's a server toggle or tool config change, no need to restart all servers
      const changeType = data.context?.changeType;
      const serverName = data.context?.serverName;

      if (changeType === 'server-toggle') {
        console.log(`[DAEMON] Skipping full restart for server toggle: ${serverName}`);
      } else if (changeType === 'tool-toggle' || changeType === 'tool-config-update') {
        if (serverName) {
          console.log(`[DAEMON] Handling tool update for server: ${serverName}`);
          this.mcpServer.updateServerTools(serverName);
        }
      } else {
        // 全量重载由 MCPDogServer 自己的 'config-updated' 监听统一执行（reinitializeAdapters，
        // 增量重建 + 后台连接）；此处不再 stop/start，否则所有 adapter 会被拆除重建两次
        console.log('[DAEMON] Full config reload delegated to MCPDogServer');
      }
    });

    // Listen for server enable/disable events
    this.configManager.on('server-toggled', (data) => {
      console.log(`[DAEMON] Server toggled: ${data.name} enabled: ${data.enabled}`);
      this.emit('server-toggled', data);
    });
  }

  private setupIPCServer() {
    this.ipcServer.on('connection', (socket) => {
      const clientId = this.generateClientId();
      console.log(`[DAEMON] Client connected: ${clientId}`);

      // Register client
      const client: DaemonClient = {
        id: clientId,
        type: 'cli', // Default type, will be updated based on handshake message
        socket,
        lastSeen: new Date()
      };
      this.clients.set(clientId, client);

      // Handle client messages
      // Per-connection TCP fragmentation buffer (same mechanism as DaemonClient)
      let recvBuffer = '';
      socket.on('data', (data) => {
        recvBuffer += data.toString();
        let newlineIndex: number;
        while ((newlineIndex = recvBuffer.indexOf('\n')) >= 0) {
          const line = recvBuffer.slice(0, newlineIndex).trim();
          recvBuffer = recvBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          try {
            const message = JSON.parse(line);
            // handleClientMessage 是 async：不接住它，内部 await 的失败（如 reloadConfig 读
            // 到写坏/半截的配置文件时 loadConfig 抛错）会变成 process 级 unhandledRejection，
            // CLI 的 handler 会直接 process.exit(1) —— 一个客户端的坏请求把整个 daemon
            // 连同所有会话一起带走。这里是消息边界，必须就地捕获。
            this.handleClientMessage(clientId, message).catch((error) => {
              console.error(`[DAEMON] Error handling message from ${clientId}:`, error);
            });
          } catch (error) {
            console.error(`[DAEMON] Invalid message from ${clientId}:`, error);
          }
        }
      });

      socket.on('close', () => {
        console.log(`[DAEMON] Client disconnected: ${clientId}`);
        this.clients.delete(clientId);
      });

      socket.on('error', (error) => {
        console.error(`[DAEMON] Client error ${clientId}:`, error);
        this.clients.delete(clientId);
      });

      // Send welcome message
      this.sendToClient(clientId, {
        type: 'welcome',
        clientId,
        serverStatus: this.mcpServer.getStatus()
      });
    });
  }

  private async handleClientMessage(clientId: string, message: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastSeen = new Date();

    switch (message.type) {
      case 'handshake':
        // Client type handshake
        client.type = message.clientType || 'cli';
        this.sendToClient(clientId, {
          type: 'handshake-ack',
          serverStatus: this.mcpServer.getStatus()
        });
        break;

      case 'mcp-request':
        // MCP protocol request forwarding, pass client ID to support multi-client deduplication
        {
          const requestId = message.request?.id;
          try {
            const response = await this.mcpServer.handleRequest(message.request, clientId);
            this.sendToClient(clientId, {
              type: 'mcp-response',
              requestId: message.requestId,
              response
            });
          } catch (error) {
            // 这里回给客户端的必须是一条**完整的 JSON-RPC 错误报文**：
            // 客户端靠 id 把响应与自己的请求对上，靠 error.code 判断错误类型。
            // 此前只发 {error: "<字符串>"}，客户端收到后既对不上请求也读不到 code。
            this.sendToClient(clientId, {
              type: 'mcp-error',
              requestId: message.requestId,
              error: {
                jsonrpc: '2.0',
                id: requestId ?? null,
                error: {
                  code: -32603,
                  message: (error as Error).message
                }
              }
            });
          }
        }
        break;

      case 'get-status':
        this.sendToClient(clientId, {
          type: 'status',
          status: this.getFullStatus()
        });
        break;

      case 'reload-config':
        await this.reloadConfig();
        break;

      case 'shutdown':
        // 客户端要求优雅停机：先跑完整的 stop()（关 web server 释放端口、清 PID 文件、
        // 停子服务器），再退出进程。
        // Windows 上 `daemon stop` 不能靠 SIGTERM 触发本进程的 handler
        // （process.kill 在 Windows 是 TerminateProcess），这条 IPC 消息是 Windows 上
        // 唯一的优雅停机入口。
        console.log('[DAEMON] Shutdown requested by client');
        try {
          await this.stop();
          process.exit(0);
        } catch (error) {
          console.error('[DAEMON] Shutdown failed:', error);
          process.exit(1);
        }
        break;

      case 'get-tools':
        const tools = await this.mcpServer.getToolRouter().getAllTools();
        this.sendToClient(clientId, {
          type: 'tools',
          tools
        });
        break;

      case 'config-request':
        await this.handleConfigRequest(message);
        break;

      default:
        console.warn(`[DAEMON] Unknown message type from ${clientId}:`, message.type);
    }
  }

  private sendToClient(clientId: string, message: any) {
    const client = this.clients.get(clientId);
    if (client?.socket) {
      try {
        client.socket.write(JSON.stringify(message) + '\n');
      } catch (error) {
        console.error(`[DAEMON] Failed to send to client ${clientId}:`, error);
        this.clients.delete(clientId);
      }
    }
  }

  private broadcastToClients(type: string, data: any) {
    const message = { type, data, timestamp: new Date().toISOString() };
    this.clients.forEach((client, clientId) => {
      this.sendToClient(clientId, message);
    });
    
    // Also emit local event for daemon-web-server etc. to listen to
    this.emit(type, data);
  }

  /**
   * 把一条**已经成形的 MCP 报文**（如 notifications/tools/list_changed）原样发给所有客户端。
   *
   * 不能套 broadcastToClients：它包一层 {type, data} 信封，会被 DaemonClient 归为
   * 「未知消息类型」而丢弃，客户端永远收不到通知。这里直接发 MCP 报文本身，
   * DaemonClient 会把它当普通消息转交给 MCP 客户端。
   */
  private broadcastRawToClients(message: any) {
    this.clients.forEach((_client, clientId) => {
      this.sendToClient(clientId, message);
    });
    this.emit('mcp-notification', message);
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getFullStatus() {
    const toolRouter = this.mcpServer.getToolRouter();
    const adapters = toolRouter.getAllAdapters();
    
    return {
      daemon: {
        isRunning: this.isRunning,
        clients: Array.from(this.clients.values()).map(c => ({
          id: c.id,
          type: c.type,
          lastSeen: c.lastSeen
        })),
        uptime: process.uptime()
      },
      mcpServer: this.mcpServer.getStatus(),
      servers: adapters.map(adapter => ({
        name: adapter.name,
        connected: adapter.isConnected,
        toolCount: toolRouter.getToolsByServer(adapter.name).length,
        enabledToolCount: toolRouter.getEnabledToolsByServer(adapter.name).length,
        config: adapter.config
      }))
    };
  }

  private async initializeMCPServer() {
    // Simulate MCP client's initialize request to initialize the server
    const initializeRequest = {
      jsonrpc: '2.0' as const,
      id: 'daemon-init',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: false }
        },
        clientInfo: {
          name: 'MCPDog Daemon',
          version: '2.0.0'
        }
      }
    };

    try {
      await this.mcpServer.handleRequest(initializeRequest, 'daemon-init');
      console.log('[DAEMON] MCP Server initialized successfully');
    } catch (error) {
      console.error('[DAEMON] Failed to initialize MCP Server:', error);
    }
  }

  private async reloadConfig() {
    console.log('[DAEMON] Manual config reload requested');
    await this.configManager.loadConfig();
    
    // Re-initialize MCP server to connect to new servers
    try {
      await this.mcpServer.handleConfigReload();
      console.log('[DAEMON] MCP Server reinitialized after config reload');
    } catch (error) {
      console.error('[DAEMON] Failed to reinitialize MCP Server after config reload:', error);
    }
  }

  private async handleConfigRequest(message: any) {
    const { action, serverName, toolName, enabled } = message;

    switch (action) {
      case 'toggle-tool': {
        // 必须落盘：toggleTool 只改内存并 emit，不保存的话这次切换在进程重启后
        // 就没了（与 config-commands 里补上的「变更后必须 saveConfig」同一要求）。
        const toggled = this.configManager.toggleTool(serverName, toolName, enabled);
        if (!toggled) {
          console.error(`[DAEMON] toggle-tool 失败：服务器不存在 ${serverName}`);
          break;
        }
        await this.configManager.saveConfig();
        // 工具可见性变了，通知已连接的客户端刷新工具清单
        try {
          await this.mcpServer.handleConfigReload();
        } catch (error) {
          console.error('[DAEMON] Failed to reload after tool toggle:', error);
        }
        break;
      }
      // Add other config actions here
      default:
        console.warn(`[DAEMON] Unknown config action: ${action}`);
    }
  }

  async start(): Promise<void> {
    try {
      console.log('[DAEMON] Starting MCPDog daemon...');
      
      // Load config file
      await this.configManager.loadConfig();
      
      // Start MCP server
      await this.mcpServer.start();
      
      // In daemon mode, manually initialize MCP server
      await this.initializeMCPServer();
      
      // Start IPC server
      const ipcPort = this.config.ipcPort || 9999;
      await new Promise<void>((resolve, reject) => {
        // 必须挂一次性 error 处理：NetServer 的 'error' 无人监听时会变成 process 级
        // uncaughtException（端口被占用即 EADDRINUSE），而这里的 Promise 也不会 settle，
        // 于是外层 try/catch 形同虚设、启动失败没有任何可读信息。
        const onListenError = (error: Error) => {
          this.ipcServer.off('listening', onListening);
          reject(
            new Error(`IPC server failed to listen on port ${ipcPort}: ${error.message}`)
          );
        };
        const onListening = () => {
          this.ipcServer.off('error', onListenError);
          console.log(`[DAEMON] IPC server listening on port ${ipcPort}`);
          resolve();
        };
        this.ipcServer.once('error', onListenError);
        this.ipcServer.once('listening', onListening);
        this.ipcServer.listen(ipcPort, 'localhost');
      });

      // Write PID file（含版本号，供 daemon start 检测版本差异自动升级重启）
      if (this.config.pidFile) {
        let version = 'unknown';
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '../../package.json'), 'utf-8'));
          if (pkg.version) version = pkg.version;
        } catch {
          // 版本读取失败不阻塞启动
        }
        await fs.writeFile(this.config.pidFile, JSON.stringify({ pid: process.pid, version }));
      }

      this.isRunning = true;
      console.log('[DAEMON] MCPDog daemon started successfully');
      
    } catch (error) {
      console.error('[DAEMON] Failed to start daemon:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      console.log('[DAEMON] Stopping MCPDog daemon...');
      
      this.isRunning = false;
      
      // Close all client connections
      this.clients.forEach((client, clientId) => {
        if (client.socket) {
          client.socket.end();
        }
      });
      this.clients.clear();

      // Stop dashboard / MCP HTTP server if running
      // （必须真正 close：否则 daemon 停止后端口仍被占用，且已连接的 MCP session 不会被关闭）
      if (this.webServer) {
        try {
          await this.webServer.close();
          this.webServer = undefined;
        } catch (error) {
          console.error('[DAEMON] Error closing web server:', error);
        }
      }

      // Stop IPC server
      await new Promise<void>((resolve) => {
        this.ipcServer.close(() => resolve());
      });

      // Stop MCP server
      await this.mcpServer.stop();

      // Clean up PID file
      if (this.config.pidFile) {
        try {
          await fs.unlink(this.config.pidFile);
        } catch (error) {
          // PID file might have already been deleted, ignore error
        }
      }

      console.log('[DAEMON] MCPDog daemon stopped');
      
    } catch (error) {
      console.error('[DAEMON] Error stopping daemon:', error);
      throw error;
    }
  }

  getConfigManager(): ConfigManager {
    return this.configManager;
  }

  getMCPServer(): MCPDogServer {
    return this.mcpServer;
  }

  // Web server support (optional)
  async startWebServer(port: number): Promise<void> {
    const { DaemonWebServer } = await import('./daemon-web-server.js');
    const webServer = new DaemonWebServer(this, port);
    await webServer.start();
    // 持有实例，stop() 才能关掉 HTTP 服务并释放端口
    this.webServer = webServer;
    console.log(`[DAEMON] Web interface started on port ${port}`);
  }
}