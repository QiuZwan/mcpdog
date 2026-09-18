/**
 * Daemon Web Server
 * Connects directly to the daemon instance instead of creating a separate MCPServer
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { MCPDogDaemon } from './mcpdog-daemon.js';
import { ConfigManager } from '../config/config-manager.js';
import { globalLogManager } from '../logging/server-log-manager.js';
import { ServerNameValidator } from '../utils/server-name-validator.js';
import { parseClaudeJson, buildImportPlan, ClaudeMCPEntry } from '../utils/claude-mcp-importer.js';
import { createExpressAuthMiddleware } from '../middleware/auth.js';
import { McpHttpEndpoint } from './mcp-http-endpoint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DaemonWebServer {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private daemon: MCPDogDaemon;
  private port: number;
  private configManager: ConfigManager; // Add configManager property
  private mcpEndpoint?: McpHttpEndpoint;

  constructor(daemon: MCPDogDaemon, port: number) {
    this.daemon = daemon;
    this.port = port;
    this.configManager = daemon.getConfigManager(); // Use daemon's configManager
    
    // Create Express application
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupDaemonEvents();
  }

  getMcpEndpoint(): McpHttpEndpoint | undefined {
    return this.mcpEndpoint;
  }

  private setupMiddleware() {
    // CORS 挂在 /api 路由上（见 createAPIRouter），不在此处全局施加。
    // 曾经的写法是「除字面量 /mcp 外全挂 cors()」，但 Express 路由匹配非严格且大小写不敏感，
    // /mcp/ 与 /MCP 仍会带着 Access-Control-Allow-Origin: * 命中 /mcp 处理器 —— 收窄形同虚设。

    // Host / Origin 校验：阻断浏览器经 DNS rebinding 访问本机服务
    this.app.use(this.guardLocalOnly());

    const authToken = process.env.MCPDOG_AUTH_TOKEN;

    // /mcp 必须注册在 express.json() 之前：SDK 需要读原始请求流，且不受 body-parser
    // 默认 100kb 体积上限的约束（工具参数可能很大）。同时也必须在 setupRoutes() 的
    // SPA 兜底之前，否则 GET /mcp 的 SSE 流会被返回 index.html。
    this.setupMcpEndpoint();
    const mcpHandler: express.RequestHandler = (req, res) => {
      // handleRequest 内部的 try 只覆盖 transport 处理段；会话查找等路径若抛出，
      // 未被 catch 的 rejection 会让 Express 无法回应请求，故在此兜底一次
      this.mcpEndpoint!.handleRequest(req, res).catch((error) => {
        console.error('[DAEMON-WEB] /mcp 请求处理失败:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal error' });
        }
      });
    };
    if (authToken) {
      // 不复用 createExpressAuthMiddleware：它是面向浏览器的管理台中间件 —— 非 /api 的
      // 未授权请求会被重定向到登录页（302）而不是 401，且会放过非 /api 的 GET，而 /mcp
      // 的 SSE 流恰恰是 GET。机器客户端需要确定性的 401。
      this.app.all('/mcp', this.requireMcpToken(authToken), mcpHandler);
    } else {
      this.app.all('/mcp', mcpHandler);
    }

    // JSON parsing
    this.app.use(express.json());

    // 这两个端点必须排在全局鉴权中间件之前（否则登录本身就要先登录），
    // 但排在 express.json() 之后 —— 登录要读 body，逐路由再挂一次解析器是多余的
    if (authToken) {
      console.log('[DAEMON-WEB] Authentication enabled');

      this.app.get('/api/auth/status', (req, res) => {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.json({ authenticated: false, required: true });
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          return res.json({ authenticated: false, required: true });
        }

        const token = parts[1];
        const isAuthorized = Buffer.compare(Buffer.from(token), Buffer.from(authToken)) === 0;

        if (!isAuthorized) {
          return res.json({ authenticated: false, required: true });
        }

        res.json({ authenticated: true, required: true });
      });

      this.app.post('/api/auth/login', (req, res) => {
        const { token } = req.body;

        if (!token) {
          return res.status(400).json({ error: '需要提供访问令牌' });
        }

        const isAuthorized = Buffer.compare(Buffer.from(token), Buffer.from(authToken)) === 0;

        if (!isAuthorized) {
          return res.status(401).json({ error: '访问令牌无效' });
        }

        res.json({ success: true, message: '登录成功' });
      });

      this.app.use(createExpressAuthMiddleware(authToken));
    } else {
      // When auth is disabled, return auth not required
      this.app.get('/api/auth/status', (req, res) => {
        res.json({ authenticated: true, required: false });
      });
    }

    // Static file serving
    const staticPath = path.join(__dirname, '../../web/dist');
    this.app.use(express.static(staticPath));

    // API route prefix
    this.app.use('/api', this.createAPIRouter());
  }

  /** 用 daemon 内唯一的聚合核心构造 MCP 端点；路由已在 setupMiddleware 中注册 */
  private setupMcpEndpoint(): void {
    const mcpServer = this.daemon.getMCPServer();
    this.mcpEndpoint = new McpHttpEndpoint({
      serverName: 'mcpdog',
      serverVersion: this.readPackageVersion(),
      listTools: () => mcpServer.listToolsResult(),
      callTool: (name, args) => mcpServer.callToolResult(name, args),
    });

    // 配置热更新 / 服务器与工具开关 → 通知已连接客户端刷新工具清单
    const toolRouter = mcpServer.getToolRouter();
    toolRouter.on('routes-updated', () => {
      void this.mcpEndpoint?.notifyToolsChanged();
    });
  }

  private readPackageVersion(): string {
    try {
      const pkgPath = path.join(__dirname, '../../package.json');
      return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * /mcp 的 Bearer 校验。与管理台的中间件分开，是因为面向浏览器的中间件在未授权时
   * 会 302 到登录页，机器客户端拿不到可解释的失败；这里统一回 401 JSON。
   */
  private requireMcpToken(authToken: string): express.RequestHandler {
    return (req, res, next) => {
      const authHeader = String(req.headers.authorization || '');
      const parts = authHeader.split(' ');

      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        res.status(401).json({ error: 'Authorization header is missing or malformed. Expected: Bearer <token>' });
        return;
      }

      if (Buffer.compare(Buffer.from(parts[1]), Buffer.from(authToken)) !== 0) {
        res.status(401).json({ error: 'Invalid authentication token' });
        return;
      }

      next();
    };
  }

  /**
   * 只接受本机回环的 Host / Origin。
   * 打开本机网页时浏览器会把 Host 设为实际访问的域名，DNS rebinding 攻击下 Host 是攻击者域名
   * 而非回环名，因此该校验能阻断「恶意网页读写本机配置与工具」这一类访问。
   *
   * 说明：SDK 的 StreamableHTTPServerTransport 自带 allowedHosts + enableDnsRebindingProtection，
   * 但它只覆盖 /mcp。本需求同时要保护 dashboard 的 /api（可改配置、可调用工具，暴露面不比 /mcp 小），
   * 两套校验器会增加「哪条路径由谁守」的理解成本，因此统一用这一个中间件覆盖两者。
   */
  private guardLocalOnly(): express.RequestHandler {
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

    const normalize = (value: string): string => {
      const lower = value.toLowerCase().trim();
      if (lower.startsWith('[')) {
        const end = lower.indexOf(']');
        return end > 0 ? lower.slice(0, end + 1) : lower;
      }
      const colon = lower.lastIndexOf(':');
      return colon > 0 ? lower.slice(0, colon) : lower;
    };

    return (req, res, next) => {
      const host = normalize(String(req.headers.host || ''));
      if (!allowedHosts.has(host)) {
        res.status(403).json({ error: 'Forbidden: unexpected Host header' });
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(String(origin)).hostname.toLowerCase();
        } catch {
          res.status(403).json({ error: 'Forbidden: malformed Origin header' });
          return;
        }
        if (!allowedHosts.has(originHost)) {
          res.status(403).json({ error: 'Forbidden: unexpected Origin header' });
          return;
        }
      }

      next();
    };
  }

  private createAPIRouter() {
    const router = express.Router();

    // CORS 只作用于 dashboard API；/mcp 与静态资源都不回 CORS 头。
    // 只创建一次中间件实例，避免逐请求分配。
    router.use(cors());

    // System status API
    router.get('/status', this.handleGetStatus.bind(this));

    // System info API (version & config path for header display)
    router.get('/system/info', this.handleGetSystemInfo.bind(this));
    
    // Server management API
    router.get('/servers', this.handleGetServers.bind(this));
    router.post('/servers', this.handleAddServer.bind(this));
    router.put('/servers/:name', this.handleUpdateServer.bind(this));
    router.delete('/servers/:name', this.handleRemoveServer.bind(this));
    router.post('/servers/:name/toggle', this.handleToggleServer.bind(this));
    
    // Tool-level control API
    router.get('/servers/:name/tools', this.handleGetServerTools.bind(this));
    router.post('/servers/:name/tools/:tool/toggle', this.handleToggleServerTool.bind(this));
    router.put('/servers/:name/tools', this.handleUpdateServerTools.bind(this));
    
    // Tool management API
    router.get('/tools', this.handleGetTools.bind(this));
    router.post('/tools/:name/call', this.handleCallTool.bind(this));
    
    // Config management API
    router.get('/config', this.handleGetConfig.bind(this));
    router.put('/config', this.handleUpdateConfig.bind(this));

    // Claude .claude.json 一键导入 API
    router.get('/import/claude/preview', this.handleClaudeImportPreview.bind(this));
    router.post('/import/claude', this.handleClaudeImport.bind(this));
    
    // Daemon-specific API
    router.get('/daemon/clients', this.handleGetClients.bind(this));
    router.post('/daemon/reload', this.handleReloadConfig.bind(this));
    
    // Log management API
    router.get('/logs', this.handleGetAllLogs.bind(this));
    router.get('/logs/:serverName', this.handleGetServerLogs.bind(this));
    router.delete('/logs/:serverName', this.handleClearServerLogs.bind(this));
    router.get('/logs/:serverName/stats', this.handleGetServerLogStats.bind(this));
    
    return router;
  }

  private setupRoutes() {
    // SPA route support - all non-API routes return index.html
    this.app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        const indexPath = path.join(__dirname, '../../web/dist/index.html');
        res.sendFile(indexPath);
      }
    });
  }

  private setupWebSocket() {
    this.io.on('connection', (socket) => {
      console.log('[DAEMON-WEB] Web client connected:', socket.id);
      
      // Send initial status
      this.sendStatusUpdate(socket);
      
      // Client requests status update
      socket.on('request-status', () => {
        this.sendStatusUpdate(socket);
      });

      socket.on('disconnect', () => {
        console.log('[DAEMON-WEB] Web client disconnected:', socket.id);
      });
    });
  }

  private setupDaemonEvents() {
    // Listen for daemon events, push to web clients in real-time
    this.daemon.on('server-started', (data) => {
      console.log(`[DAEMON-WEB] Server started event received: ${data.serverName}`);
      
      // Delay sending composite event to ensure adapter status is fully updated
      setTimeout(() => {
        const systemStatus = this.getSystemStatus();
        if (systemStatus) {
          console.log(`[DAEMON-WEB] Sending server-status-changed event for: ${data.serverName}`);
          this.io.emit('server-status-changed', {
            event: 'server-started',
            serverName: data.serverName,
            systemStatus: systemStatus,
            originalData: data,
            timestamp: data.timestamp || new Date().toISOString()
          });
        } else {
          // If status retrieval fails, fall back to original method
          this.io.emit('server-started', data);
          this.broadcastStatusUpdate();
        }
      }, 1000); // Delay to ensure status synchronization
    });

    this.daemon.on('server-stopped', (data) => {
      console.log(`[DAEMON-WEB] Server stopped event received: ${data.serverName}`);
      
      // Immediately get and send status
      const systemStatus = this.getSystemStatus();
      if (systemStatus) {
        console.log(`[DAEMON-WEB] Sending server-status-changed event for: ${data.serverName}`);
        this.io.emit('server-status-changed', {
          event: 'server-stopped',
          serverName: data.serverName,
          systemStatus: systemStatus,
          originalData: data,
          timestamp: data.timestamp || new Date().toISOString()
        });
      } else {
        // If status retrieval fails, fall back to original method
        this.io.emit('server-stopped', data);
        this.broadcastStatusUpdate();
      }
    });

    this.daemon.on('routes-updated', (data) => {
      this.io.emit('server-updated', {
        serverName: data.serverName,
        toolCount: data.toolCount,
        timestamp: new Date().toISOString()
      });
      // Delay broadcasting status update to ensure tool routes are fully updated
      setTimeout(() => {
        console.log(`[DAEMON-WEB] Broadcasting delayed status update after routes-updated for: ${data.serverName}`);
        this.broadcastStatusUpdate();
      }, 500); // 500ms delay
    });

    this.daemon.on('server-connected', (data) => {
      console.log(`[DAEMON-WEB] Server connected event received: ${data.serverName}`);
      
      // Delay sending composite event to ensure adapter status is fully updated
      setTimeout(() => {
        const systemStatus = this.getSystemStatus();
        if (systemStatus) {
          console.log(`[DAEMON-WEB] Sending server-status-changed event for: ${data.serverName}`);
          this.io.emit('server-status-changed', {
            event: 'server-connected',
            serverName: data.serverName,
            systemStatus: systemStatus,
            originalData: data,
            timestamp: data.timestamp || new Date().toISOString()
          });
        } else {
          // If status retrieval fails, fall back to original method
          this.io.emit('server-connected', data);
          this.broadcastStatusUpdate();
        }
      }, 1000); // Delay to ensure status synchronization
    });

    this.daemon.on('server-disconnected', (data) => {
      console.log(`[DAEMON-WEB] Server disconnected event received: ${data.serverName}`);
      
      // Immediately get and send status, as disconnection status changes are immediate
      const systemStatus = this.getSystemStatus();
      if (systemStatus) {
        console.log(`[DAEMON-WEB] Sending server-status-changed event for: ${data.serverName}`);
        this.io.emit('server-status-changed', {
          event: 'server-disconnected',
          serverName: data.serverName,
          systemStatus: systemStatus,
          originalData: data,
          timestamp: data.timestamp || new Date().toISOString()
        });
      } else {
        // If status retrieval fails, fall back to original method
        this.io.emit('server-disconnected', data);
        this.broadcastStatusUpdate();
      }
    });

    this.daemon.on('server-error', (data) => {
      this.io.emit('server-error', data);
    });

    this.daemon.on('server-log', (data) => {
      this.io.emit('server-log', data);
    });

    this.daemon.on('tool-called', (data) => {
      this.io.emit('tool-called', {
        serverName: data.serverName,
        toolName: data.toolName,
        duration: data.duration,
        timestamp: new Date().toISOString()
      });
    });

    this.daemon.on('error', (data) => {
      this.io.emit('error', {
        error: data.error,
        context: data.context,
        timestamp: new Date().toISOString()
      });
    });

    // Listen for config change events - this is the critical part for fixing!
    this.daemon.on('config-changed', (config) => {
      console.log('[DAEMON-WEB] Config changed event received, broadcasting to WebSocket clients');
      this.io.emit('config-changed', {
        config,
        timestamp: new Date().toISOString()
      });
      // Broadcast latest status after config change
      this.broadcastStatusUpdate();
    });

    // Listen for log manager events, push logs to web clients in real-time
    globalLogManager.on('log-added', (data) => {
      this.io.emit('enhanced-log-added', {
        serverName: data.serverName,
        logEntry: data.logEntry,
        timestamp: data.logEntry.timestamp
      });
    });

    globalLogManager.on('server-error', (data) => {
      this.io.emit('server-log-error', data);
    });

    globalLogManager.on('connection-status-changed', (data) => {
      this.io.emit('server-connection-status', data);
    });

    this.daemon.on('server-toggled', (data) => {
      console.log(`[DAEMON-WEB] Server toggled event received: ${data.name} enabled: ${data.enabled}`);
      const systemStatus = this.getSystemStatus();
      if (systemStatus) {
        this.io.emit('server-status-changed', {
          event: data.enabled ? 'server-enabled' : 'server-disabled',
          serverName: data.name,
          systemStatus: systemStatus,
          originalData: data,
          timestamp: new Date().toISOString()
        });
      } else {
        this.broadcastStatusUpdate();
      }
    });
  }

  // API handlers
  private async handleGetStatus(req: express.Request, res: express.Response) {
    try {
      const status = this.daemon['getFullStatus'](); // Access private method of daemon
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: '获取状态失败',
        message: (error as Error).message
      });
    }
  }

  // Header 展示用的系统信息：版本号与配置文件路径
  private async handleGetSystemInfo(req: express.Request, res: express.Response) {
    try {
      const packagePath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
      res.json({
        version: packageJson.version,
        configPath: this.configManager.getConfigPath()
      });
    } catch (error) {
      res.status(500).json({
        error: '获取系统信息失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetServers(req: express.Request, res: express.Response) {
    try {
      // Get all servers from config file to merge configuration information
      const configManager = this.daemon['configManager'];
      const config = configManager.getConfig();
      const configServers = config.servers || {};
      
      // Get runtime status
      const status = this.daemon['getFullStatus']();
      const runtimeServers = status.servers || [];
      const toolRouter = this.daemon['mcpServer'].getToolRouter();
      
      // Create runtime status map
      const runtimeMap = new Map();
      (status.servers || []).forEach((server: any) => {
        runtimeMap.set(server.name, server);
      });
      
      // Merge configuration and runtime information
      const serversWithTools = Object.entries(configServers).map(([serverName, serverConfig]: [string, any]) => {
        const runtimeInfo = runtimeMap.get(serverName);
        const isConnected = !!runtimeInfo?.connected;
        const tools = isConnected ? toolRouter.getToolsByServer(serverName) : [];
        const enabledTools = isConnected ? toolRouter.getEnabledToolsByServer(serverName) : [];
        
        return {
          // Include all ServerConfig properties and ensure name is set correctly
          ...serverConfig,
          name: serverName, // Always use the key as the definitive name
          // Add server runtime status
          connected: isConnected,
          toolCount: tools.length,
          enabledToolCount: enabledTools.length,
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            enabled: this.isToolEnabled(serverConfig, tool.name),
            inputSchema: tool.inputSchema,
            settings: {}
          }))
        };
      });
      
      res.json(serversWithTools);
    } catch (error) {
      res.status(500).json({
        error: '获取服务器列表失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetTools(req: express.Request, res: express.Response) {
    try {
      const mcpServer = this.daemon['mcpServer'];
      const toolRouter = mcpServer.getToolRouter();
      const tools = await toolRouter.getAllTools(true);
      
      const toolsWithServer = tools.map(tool => {
        const route = toolRouter.findToolRoute(tool.name);
        return {
          ...tool,
          serverName: route?.serverName || 'unknown'
        };
      });
      
      res.json(toolsWithServer);
    } catch (error) {
      res.status(500).json({
        error: '获取工具列表失败',
        message: (error as Error).message
      });
    }
  }

  private async handleCallTool(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const { args } = req.body;
      
      const mcpServer = this.daemon['mcpServer'];
      const toolRouter = mcpServer.getToolRouter();
      const result = await toolRouter.callTool(name, args || {});
      
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: '工具调用失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetConfig(req: express.Request, res: express.Response) {
    try {
      const configManager = this.daemon['configManager'];
      const config = configManager.getConfig();
      res.json(config);
    } catch (error) {
      res.status(500).json({
        error: '获取配置失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetClients(req: express.Request, res: express.Response) {
    try {
      const clients = this.daemon['clients'];
      const clientList = Array.from(clients.values()).map(c => ({
        id: c.id,
        type: c.type,
        lastSeen: c.lastSeen
      }));
      res.json(clientList);
    } catch (error) {
      res.status(500).json({
        error: '获取客户端列表失败',
        message: (error as Error).message
      });
    }
  }

  private async handleReloadConfig(req: express.Request, res: express.Response) {
    try {
      await this.daemon['reloadConfig']();
      res.json({ success: true, message: '配置已重载' });
    } catch (error) {
      res.status(500).json({
        error: '配置重载失败',
        message: (error as Error).message
      });
    }
  }

  // WebSocket helper methods
  private async sendStatusUpdate(socket: any) {
    try {
      const status = this.daemon['getFullStatus']();
      
      // Get all servers from config file to merge configuration information
      const configManager = this.daemon['configManager'];
      const config = configManager.getConfig();
      const configServers = config.servers || {};
      const toolRouter = this.daemon['mcpServer'].getToolRouter();
      
      // Get latest adapter status directly from toolRouter to avoid caching issues
      const allAdapters = toolRouter.getAllAdapters();
      const runtimeMap = new Map();
      allAdapters.forEach((adapter: any) => {
        runtimeMap.set(adapter.name, {
          connected: adapter.isConnected,
          toolCount: toolRouter.getToolsByServer(adapter.name).length,
          enabledToolCount: toolRouter.getEnabledToolsByServer(adapter.name).length
        });
      });
      
      // Merge configuration and runtime information
      const serversWithTools = Object.entries(configServers).map(([serverName, serverConfig]: [string, any]) => {
        const runtimeInfo = runtimeMap.get(serverName);
        const isConnected = runtimeInfo ? !!runtimeInfo.connected : false;
        const toolCount = runtimeInfo ? runtimeInfo.toolCount : 0;
        const enabledToolCount = runtimeInfo ? runtimeInfo.enabledToolCount : 0;
        const tools = isConnected ? toolRouter.getToolsByServer(serverName) : [];
        
        return {
          // Include all ServerConfig properties and ensure name is set correctly
          ...serverConfig,
          name: serverName, // Always use the key as the definitive name
          // Add server runtime status
          connected: isConnected,
          toolCount: toolCount,
          enabledToolCount: enabledToolCount,
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            enabled: this.isToolEnabled(serverConfig, tool.name),
            inputSchema: tool.inputSchema,
            settings: {}
          }))
        };
      });
      
      // Send status update with structure consistent with /api/servers
      const enhancedStatus = {
        ...status,
        servers: serversWithTools
      };
      
      console.log(`[DAEMON-WEB] Broadcasting status update: ${serversWithTools.map(s => `${s.name}(connected:${s.connected}, tools:${s.toolCount})`).join(', ')}`);
      socket.emit('status-update', enhancedStatus);
    } catch (error) {
      console.error('[DAEMON-WEB] Error sending status update:', error);
      socket.emit('error', {
        error: '获取状态失败',
        message: (error as Error).message
      });
    }
  }

  private broadcastStatusUpdate() {
    this.io.sockets.sockets.forEach(socket => {
      this.sendStatusUpdate(socket);
    });
  }

  // Get complete system status
  private getSystemStatus() {
    try {
      const toolRouter = this.daemon['mcpServer'].getToolRouter();
      const configManager = this.daemon['configManager'];
      const config = configManager.getConfig();
      
      const serversConfig = config?.servers || {};
      const enabledServers = Object.keys(serversConfig).filter(name => serversConfig[name].enabled !== false);
      
      // Get latest adapter status directly from toolRouter to avoid caching issues
      const allAdapters = toolRouter.getAllAdapters();
      const runtimeMap = new Map();
      allAdapters.forEach((adapter: any) => {
        runtimeMap.set(adapter.name, {
          connected: adapter.isConnected,
          toolCount: toolRouter.getToolsByServer(adapter.name).length,
          enabledToolCount: toolRouter.getEnabledToolsByServer(adapter.name).length
        });
      });

      const connectedCount = allAdapters.filter((adapter: any) => adapter.isConnected).length;
      const totalTools = allAdapters.reduce((sum: number, adapter: any) => {
        return sum + toolRouter.getToolsByServer(adapter.name).length;
      }, 0);
      const totalEnabledTools = allAdapters.reduce((sum: number, adapter: any) => {
        return sum + toolRouter.getEnabledToolsByServer(adapter.name).length;
      }, 0);

      const serversWithTools = enabledServers.map(serverName => {
        const serverConfig = { ...serversConfig[serverName], name: serverName };
        const runtimeInfo = runtimeMap.get(serverName);
        const isConnected = runtimeInfo ? runtimeInfo.connected : false;
        const toolCount = runtimeInfo ? runtimeInfo.toolCount : 0;
        const enabledToolCount = runtimeInfo ? runtimeInfo.enabledToolCount : 0;
        const tools = isConnected ? toolRouter.getToolsByServer(serverConfig.name) : [];
        
        return {
          ...serverConfig,
          connected: isConnected,
          toolCount: toolCount,
          enabledToolCount: enabledToolCount,
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            enabled: this.isToolEnabled(serverConfig, tool.name),
            inputSchema: tool.inputSchema,
            settings: {}
          }))
        };
      });

      return {
        total: enabledServers.length,
        connected: connectedCount,
        totalTools: totalTools, // This should be total tools
        enabledTools: totalEnabledTools, // This should be enabled tools
        servers: serversWithTools
      };
    } catch (error) {
      console.error('[DAEMON-WEB] Error getting system status:', error);
      return null;
    }
  }

  private async handleAddServer(req: express.Request, res: express.Response) {
    try {
      const { name, config } = req.body;
      const configManager = this.daemon['configManager'];

      // Validate server name
      const nameValidation = ServerNameValidator.validateServerName(name);
      if (!nameValidation.valid) {
        return res.status(400).json({ 
          error: '服务器名称无效', 
          details: nameValidation.error,
          suggestions: nameValidation.suggestions
        });
      }

      // Check for name conflicts
      if (configManager.checkServerNameConflict(name)) {
        return res.status(409).json({ 
          error: '服务器名称已存在',
          existingName: name
        });
      }

      try {
        // Add the server
        configManager.addServer(name, config);
        await configManager.saveConfig();
        await configManager.loadConfig();
        
        // Only start the server if it's enabled, without reloading all config
        if (config.enabled) {
          console.log(`[DAEMON-WEB] Server ${name} is enabled, starting it directly`);
          // Use configManager's toggleServer method to start the server
          configManager.toggleServer(name, true);
        } else {
          console.log(`[DAEMON-WEB] Server ${name} is disabled, skipping start`);
        }

        // Emit a server-added event for the specific server
        const systemStatus = this.getSystemStatus();
        if (systemStatus) {
          this.io.emit('server-status-changed', {
            event: 'server-added',
            serverName: name,
            systemStatus: systemStatus,
            originalData: { name, ...config },
            timestamp: new Date().toISOString()
          });
        }

        res.json({
          success: true,
          message: `服务器 ${name} 添加成功`,
          server: { name, ...config }
        });
      } catch (error) {
        res.status(500).json({
          error: '添加服务器失败',
          message: (error as Error).message
        });
      }
    } catch (error) {
      res.status(500).json({
        error: '添加服务器失败',
        message: (error as Error).message
      });
    }
  }

  private async handleUpdateServer(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const serverConfig = req.body;
      const configManager = this.daemon['configManager'];

      // If name is being updated, validate the new name
      if (serverConfig.name && serverConfig.name !== name) {
        const nameValidation = ServerNameValidator.validateServerName(serverConfig.name);
        if (!nameValidation.valid) {
          return res.status(400).json({ 
            error: '服务器名称无效', 
            details: nameValidation.error,
            suggestions: nameValidation.suggestions
          });
        }

        // Check for name conflicts with other servers
        if (configManager.checkServerNameConflict(serverConfig.name)) {
          return res.status(409).json({ 
            error: '服务器名称已存在',
            existingName: serverConfig.name
          });
        }
      }

      try {
        // Get the old server config to check if it was enabled
        const oldConfig = configManager.getServerConfig(name);
        const wasEnabled = oldConfig?.enabled || false;
        const nameChanged = serverConfig.name && serverConfig.name !== name;
        
        // Update the server configuration
        configManager.updateServer(name, serverConfig);
        await configManager.saveConfig();
        await configManager.loadConfig();
        
        // Get the new server config
        const newConfig = configManager.getServerConfig(serverConfig.name || name);
        const isEnabled = newConfig?.enabled || false;
        
        // Always restart the server if it was enabled, regardless of what changed
        // This ensures any config change (command, args, env, etc.) takes effect
        if (wasEnabled) {
          console.log(`[DAEMON-WEB] Server ${name} config updated, restarting server`);
          
          if (nameChanged) {
            // Name changed: disable old server and enable new server
            console.log(`[DAEMON-WEB] Disabling old server: ${name}`);
            configManager.toggleServer(name, false);
            
            console.log(`[DAEMON-WEB] Enabling new server: ${serverConfig.name}`);
            configManager.toggleServer(serverConfig.name, true);
          } else {
            // Config changed but name is the same: restart the server
            console.log(`[DAEMON-WEB] Restarting server ${name} due to config change`);
            configManager.toggleServer(name, false);
            configManager.toggleServer(name, true);
          }
        } else if (wasEnabled !== isEnabled) {
          // Only enabled status changed
          console.log(`[DAEMON-WEB] Toggling server ${serverConfig.name || name} to ${isEnabled}`);
          configManager.toggleServer(serverConfig.name || name, isEnabled);
        } else {
          console.log(`[DAEMON-WEB] Server ${name} updated but was not enabled, no restart needed`);
        }

        // Emit a server-updated event for the specific server
        const systemStatus = this.getSystemStatus();
        if (systemStatus) {
          this.io.emit('server-status-changed', {
            event: 'server-updated',
            serverName: serverConfig.name || name,
            systemStatus: systemStatus,
            originalData: { name: serverConfig.name || name, ...serverConfig },
            timestamp: new Date().toISOString()
          });
        }

        // Rely on daemon events to broadcast status update
        res.json({
          success: true,
          message: `服务器 ${name} 已更新`,
          server: { name: serverConfig.name || name, ...serverConfig }
        });
      } catch (error) {
        res.status(500).json({
          error: '更新服务器失败',
          message: (error as Error).message
        });
      }
    } catch (error) {
      res.status(500).json({
        error: '更新服务器失败',
        message: (error as Error).message
      });
    }
  }

  private async handleRemoveServer(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const configManager = this.daemon['configManager'];

      // Get the server config before removing it to check if it was enabled
      const serverConfig = configManager.getServerConfig(name);
      const wasEnabled = serverConfig?.enabled || false;

      await configManager.removeServer(name);
      await configManager.saveConfig();
      await configManager.loadConfig();
      
      // Only stop the server if it was enabled, without reloading all config
      if (wasEnabled) {
        console.log(`[DAEMON-WEB] Server ${name} was enabled, stopping it directly`);
        // Use configManager's toggleServer method to stop the server
        configManager.toggleServer(name, false);
      } else {
        console.log(`[DAEMON-WEB] Server ${name} was disabled, skipping stop`);
      }

      // Emit a server-removed event for the specific server
      const systemStatus = this.getSystemStatus();
      if (systemStatus) {
        this.io.emit('server-status-changed', {
          event: 'server-removed',
          serverName: name,
          systemStatus: systemStatus,
          originalData: { name },
          timestamp: new Date().toISOString()
        });
      }

      // Rely on daemon events to broadcast status update
      res.json({ success: true, message: `服务器 ${name} 已删除` });
    } catch (error) {
      res.status(500).json({
        error: '删除服务器失败',
        message: (error as Error).message
      });
    }
  }

  private async handleToggleServer(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const configManager = this.daemon['configManager'];
      
      const config = configManager.getConfig();
      const serverConfig = config.servers[name];
      
      if (!serverConfig) {
        return res.status(404).json({ error: '未找到服务器' });
      }
      
      // Use configManager's toggleServer method, which automatically emits events
      const oldEnabled = serverConfig.enabled;
      await configManager.toggleServer(name, !oldEnabled);
      
      // Save configuration to persist the change
      await configManager.saveConfig();
      
      console.log(`[DAEMON-WEB] Server ${name} toggled: ${oldEnabled} -> ${!oldEnabled}`);
      
      // ConfigManager's toggleServer method emits a server-toggled event
      // MCPDogServer already listens to this event and automatically handles server start/stop
      // No need to manually call reloadConfig() or manually connect/disconnect servers
      
      // Send composite event, including toggle operation and latest status
      setTimeout(() => {
        const systemStatus = this.getSystemStatus();
        if (systemStatus) {
          console.log(`[DAEMON-WEB] Sending server-status-changed event for toggle: ${name}`);
          this.io.emit('server-status-changed', {
            event: serverConfig.enabled ? 'server-enabled' : 'server-disabled',
            serverName: name,
            systemStatus: systemStatus,
            originalData: { enabled: serverConfig.enabled },
            timestamp: new Date().toISOString()
          });
        } else {
          // If status retrieval fails, fall back to original method
          this.broadcastStatusUpdate();
        }
      }, 100); // Short delay to ensure config is saved
      
      res.json({ 
        success: true, 
        server: name,
        enabled: serverConfig.enabled,
        message: `服务器 ${name} 已${serverConfig.enabled ? '启用' : '禁用'}` 
      });
    } catch (error) {
      res.status(500).json({
        error: '切换服务器状态失败',
        message: (error as Error).message
      });
    }
  }

  private async handleUpdateConfig(req: express.Request, res: express.Response) {
    try {
      const newConfig = req.body;
      const configManager = this.daemon['configManager'];
      
      // Update config
      configManager['config'] = newConfig; // Directly set config
      await configManager.saveConfig();
      
      // Reload daemon configuration
      await this.daemon['reloadConfig']();
      
      res.json({ success: true, message: '配置更新成功' });
    } catch (error) {
      res.status(500).json({
        error: '更新配置失败',
        message: (error as Error).message
      });
    }
  }

  // Claude .claude.json 一键导入相关私有方法
  private getClaudeImportSource(): string {
    return path.join(homedir(), '.claude.json');
  }

  private readClaudeMCPServers(): Record<string, ClaudeMCPEntry> {
    const source = this.getClaudeImportSource();
    if (!existsSync(source)) {
      const error = new Error(`未找到 Claude 配置文件: ${source}`);
      (error as any).statusCode = 404;
      throw error;
    }

    let content: string;
    try {
      content = readFileSync(source, 'utf-8');
    } catch (error) {
      const wrapped = new Error(`读取 Claude 配置文件失败: ${source}`);
      (wrapped as any).statusCode = 500;
      throw wrapped;
    }

    return parseClaudeJson(content);
  }

  private buildClaudeImportPlan(source: string, entries: Record<string, ClaudeMCPEntry>) {
    const configManager = this.daemon['configManager'];
    const existingNames = Object.keys(configManager.getConfig().servers || {});
    return buildImportPlan({
      source,
      entries,
      existingNames,
      validateName: (name) => ServerNameValidator.validateServerName(name),
    });
  }

  // 预览：只读 ~/.claude.json 并返回「将导入 / 将跳过」清单，不产生任何写入
  private async handleClaudeImportPreview(req: express.Request, res: express.Response) {
    try {
      const source = this.getClaudeImportSource();
      const entries = this.readClaudeMCPServers();
      const plan = this.buildClaudeImportPlan(source, entries);

      // 预览不返回完整配置，避免泄露 env 中的密钥等敏感信息
      res.json({
        source: plan.source,
        servers: plan.items.map(({ name, transport, status, reason }) => ({
          name,
          transport,
          status,
          reason,
        })),
        counts: plan.counts,
      });
    } catch (error) {
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({ error: (error as Error).message });
    }
  }

  // 导入：仅添加 new 组条目，冲突/无效跳过；有新增则保存并重载配置以启动启用的服务器
  private async handleClaudeImport(req: express.Request, res: express.Response) {
    try {
      const source = this.getClaudeImportSource();
      const entries = this.readClaudeMCPServers();
      const plan = this.buildClaudeImportPlan(source, entries);
      const configManager = this.daemon['configManager'];

      const added: Array<{ name: string; transport?: string }> = [];
      const skipped: Array<{ name: string; reason: string }> = [];

      for (const item of plan.items) {
        if (item.status === 'new' && item.config) {
          try {
            configManager.addServer(item.name, item.config);
            added.push({ name: item.name, transport: item.transport });
          } catch (error) {
            skipped.push({ name: item.name, reason: (error as Error).message });
          }
        } else {
          skipped.push({ name: item.name, reason: item.reason || '已存在或无效' });
        }
      }

      if (added.length > 0) {
        await configManager.saveConfig();
        // reloadConfig 会 loadConfig 并重建 adapter，启用状态的服务器随即连接
        await this.daemon['reloadConfig']();
      }

      res.json({ source: plan.source, added, skipped, counts: plan.counts });
    } catch (error) {
      const statusCode = (error as any).statusCode || 500;
      res.status(statusCode).json({ error: (error as Error).message });
    }
  }

  // New tool-level control API handler
  private async handleGetServerTools(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const mcpServer = this.daemon['mcpServer'];
      const configManager = this.daemon['configManager'];
      
      const serverConfig = configManager.getServerConfig(name);
      if (!serverConfig) {
        return res.status(404).json({ error: '未找到服务器' });
      }
      
      const toolRouter = mcpServer.getToolRouter();
      const allTools = toolRouter.getToolsByServer(name);
      
      // Apply tool filtering config
      const toolsWithConfig = allTools.map(tool => ({
        ...tool,
        enabled: this.isToolEnabled(serverConfig, tool.name),
        settings: serverConfig.toolsConfig?.toolSettings?.[tool.name] || {}
      }));
      
      res.json({
        serverName: name,
        toolsConfig: serverConfig.toolsConfig || { mode: 'all' },
        tools: toolsWithConfig
      });
    } catch (error) {
      res.status(500).json({
        error: '获取服务器工具失败',
        message: (error as Error).message
      });
    }
  }

  private async handleToggleServerTool(req: express.Request, res: express.Response) {
    try {
      const { name, tool } = req.params;
      const configManager = this.daemon['configManager'];
      
      const config = configManager.getConfig();
      const serverConfig = config.servers[name];
      
      if (!serverConfig) {
        return res.status(404).json({ error: '未找到服务器' });
      }
      
      // Initialize tool config
      if (!serverConfig.toolsConfig) {
        serverConfig.toolsConfig = { mode: 'all' };
      }
      
      if (!serverConfig.toolsConfig.toolSettings) {
        serverConfig.toolsConfig.toolSettings = {};
      }
      
      // Toggle tool status
      const currentEnabled = this.isToolEnabled(serverConfig, tool);
      serverConfig.toolsConfig.toolSettings[tool] = {
        ...serverConfig.toolsConfig.toolSettings[tool],
        enabled: !currentEnabled
      };
      
      // If mode is 'all', switch to 'blacklist' or 'whitelist' mode
      if (serverConfig.toolsConfig.mode === 'all') {
        serverConfig.toolsConfig.mode = currentEnabled ? 'blacklist' : 'whitelist';
      }
      
      // Save configuration with tool-toggle context to avoid server reconnection
      await configManager.saveConfig();
      
      // Just broadcast status update instead of full reload
      this.broadcastStatusUpdate();
      
      res.json({
        success: true,
        tool,
        enabled: !currentEnabled,
        message: `工具 ${tool} 已${!currentEnabled ? '启用' : '禁用'}`
      });
    } catch (error) {
      res.status(500).json({
        error: '工具切换失败',
        message: (error as Error).message
      });
    }
  }

  private async handleUpdateServerTools(req: express.Request, res: express.Response) {
    try {
      const { name } = req.params;
      const { toolsConfig } = req.body;
      const configManager = this.daemon['configManager'];
      
      const config = configManager.getConfig();
      const serverConfig = config.servers[name];
      
      if (!serverConfig) {
        return res.status(404).json({ error: '未找到服务器' });
      }
      
      // Update tool config
      serverConfig.toolsConfig = toolsConfig;
      
      // Save configuration with tool-config-update context to avoid server reconnection
      await configManager.saveConfig();
      
      // Just broadcast status update instead of full reload
      this.broadcastStatusUpdate();
      
      res.json({ success: true, message: '服务器工具配置已更新' });
    } catch (error) {
      res.status(500).json({
        error: '更新服务器工具失败',
        message: (error as Error).message
      });
    }
  }

  // Helper method: check if tool is enabled
  private isToolEnabled(serverConfig: any, toolName: string): boolean {
    const toolsConfig = serverConfig.toolsConfig;
    
    if (!toolsConfig) {
      return true; // Default to all enabled
    }
    
    // Check specific tool settings
    const toolSettings = toolsConfig.toolSettings?.[toolName];
    if (toolSettings !== undefined) {
      return toolSettings.enabled;
    }
    
    // Determine based on mode
    switch (toolsConfig.mode) {
      case 'all':
        return true;
      case 'whitelist':
        return toolsConfig.enabledTools?.includes(toolName) || false;
      case 'blacklist':
        return !toolsConfig.disabledTools?.includes(toolName);
      default:
        return true;
    }
  }

  // Log API handlers
  private async handleGetAllLogs(req: express.Request, res: express.Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = globalLogManager.getAllRecentLogs(limit);
      res.json(logs);
    } catch (error) {
      res.status(500).json({
        error: '获取日志失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetServerLogs(req: express.Request, res: express.Response) {
    try {
      const { serverName } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      const level = req.query.level as string;
      const source = req.query.source as string;
      const search = req.query.search as string;
      
      let logs;
      if (search) {
        logs = globalLogManager.searchLogs(serverName, search, { level: level as any, source: source as any, limit });
      } else {
        logs = globalLogManager.getLogs(serverName, limit);
      }
      
      res.json(logs);
    } catch (error) {
      res.status(500).json({
        error: '获取服务器日志失败',
        message: (error as Error).message
      });
    }
  }

  private async handleClearServerLogs(req: express.Request, res: express.Response) {
    try {
      const { serverName } = req.params;
      globalLogManager.clearLogs(serverName);
      res.json({ success: true, message: `已清空 ${serverName} 的日志` });
    } catch (error) {
      res.status(500).json({
        error: '清空服务器日志失败',
        message: (error as Error).message
      });
    }
  }

  private async handleGetServerLogStats(req: express.Request, res: express.Response) {
    try {
      const { serverName } = req.params;
      const stats = globalLogManager.getStats(serverName);
      if (!stats) {
        return res.status(404).json({ error: '未找到服务器' });
      }
      res.json(stats);
    } catch (error) {
      res.status(500).json({
        error: '获取服务器日志统计失败',
        message: (error as Error).message
      });
    }
  }

  // Server control
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[DAEMON-WEB] Web interface started on port ${this.port}`);
        console.log(`[DAEMON-WEB] Dashboard: http://localhost:${this.port}`);
        console.log(`[DAEMON-WEB] WebSocket: ws://localhost:${this.port}`);
        resolve();
      });
      
      this.server.on('error', (error: any) => {
        reject(error);
      });
    });
  }

  /**
   * 关闭 dashboard / /mcp 所在的 HTTP 服务。
   * 顺序：先关 MCP session（否则已连接的 SSE 流不会被主动关闭）→ 再关 Socket.IO 与 HTTP server。
   */
  async close(): Promise<void> {
    await this.mcpEndpoint?.close();

    // io.close() 会断开所有 socket 并关闭它持有的 http server，回调在连接清空后触发
    await new Promise<void>((resolve) => {
      this.io.close(() => resolve());
    });

    // 兜底再关一次 http server：不让「端口是否释放」依赖 socket.io 的内部实现
    // （重复 close 会带 ERR_SERVER_NOT_RUNNING 回调，不影响结果）
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    console.log('[DAEMON-WEB] Web server stopped');
  }

  async stop(): Promise<void> {
    return this.close();
  }
}