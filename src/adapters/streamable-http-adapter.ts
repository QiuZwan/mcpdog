import { EventEmitter } from 'events';
import axios, { AxiosInstance } from 'axios';
import { MCPServerConfig, MCPTool, MCPRequest, MCPResponse, ServerAdapter } from '../types/index.js';

export class StreamableHttpAdapter extends EventEmitter implements ServerAdapter {
  public readonly name: string;
  public readonly config: MCPServerConfig;
  public isConnected: boolean = false;

  private httpClient: AxiosInstance;
  private requestId: number = 1;
  private pendingRequests: Map<string | number, {
    resolve: (value: MCPResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private endpoint: string;
  private endpointPath: string = '/'; // Path part of the endpoint URL
  private sessionId?: string; // MCP Session ID (optional)
  private sessionMode: 'auto' | 'required' | 'disabled' = 'auto';
  private sessionRecovery?: Promise<void>; // 会话重建的单飞闩：并发失败共享同一次握手
  /** 进行中的 connect() 握手：并发合流 + 让 disconnect() 能取消在飞握手 */
  private connectPromise?: Promise<void>;
  /** 是否已被要求断开；在飞的 connect() 据此不宣称已连接，并在下一次 connect() 时复位 */
  private disconnectRequested = false;

  constructor(name: string, config: MCPServerConfig) {
    super();
    this.name = name;
    this.config = config;

    if (config.transport !== 'streamable-http') {
      throw new Error(`Invalid transport for StreamableHttpAdapter: ${config.transport}`);
    }

    const httpUrl = config.url || config.endpoint;
    if (!httpUrl) {
      throw new Error('URL or endpoint is required for streamable-http transport');
    }

    this.endpoint = httpUrl;
    
    // Set session mode
    this.sessionMode = (config as any).sessionMode || 'auto';

    // Parse URL to separate base and path
    const url = new URL(httpUrl);
    const baseURL = `${url.protocol}//${url.host}`;
    const endpointPath = url.pathname + url.search + url.hash;

    // Create HTTP client
    this.httpClient = axios.create({
      baseURL: baseURL,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'MCPDog/2.0.1-StreamableHTTP',
        ...(config.headers || {}),
        ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
      }
    });

    // Store the endpoint path for requests
    this.endpointPath = endpointPath;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    // 并发合流：握手期间 isConnected 仍为 false，不合并会各自发一次 initialize，
    // 后建立的会话顶掉先建立的（前面的会话在下游被孤立）。
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.disconnectRequested = false;
    this.connectPromise = (async () => {
      try {
        console.error(`Connecting to ${this.name} via Streamable HTTP: ${this.endpoint}`);

        // 1. Initialize handshake
        await this.initialize();

        // 握手期间被 disconnect()/disable() 取代：不能宣称已连接。
        // 必须**抛错**而不是正常返回 —— 正常返回会让调用方（ToolRouter.connectAll）
        // 把这次算作「连接成功」，于是日志与计数里出现一个并不存在的连接
        // （isConnected 实际为 false、getConnectedServerCount 为 0）。
        if (this.disconnectRequested) {
          console.error(`Connection attempt for ${this.name} was superseded by disconnect, discarding`);
          this.sessionId = undefined;
          throw new Error(`Connection attempt for ${this.name} was superseded by disconnect`);
        }

        // Mark as connected, let router manage tool list fetching
        this.isConnected = true;
        console.error(`Connected to ${this.name}`);
        this.emit('connected', { serverName: this.name });

      } catch (error) {
        throw new Error(`Failed to connect to ${this.name}: ${(error as Error).message}`);
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async disconnect(): Promise<void> {
    // 不能因 !isConnected 就早退：握手进行中（isConnected 尚为 false）时的 disconnect()
    // 必须能取消那次握手并了结在途请求，否则中途停机后这次握手会把连接建起来。
    if (!this.isConnected && !this.connectPromise) {
      return;
    }

    // 标记「已被要求断开」，让在飞的 connect() 在握手结束时不宣称已连接
    this.disconnectRequested = true;

    console.error(`Disconnecting from ${this.name}`);
    
    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    this.isConnected = false;
    console.error(`Disconnected from ${this.name}`);
    this.emit('disconnected', { serverName: this.name });
  }

  private async initialize(): Promise<void> {
    // initialize 的语义是「建立一个新会话」，因此不携带任何旧会话号。
    // 带上失效的旧会话号会让本次握手被下游按「会话不存在」拒掉（404），
    // 而 initialize 自身不参与会话恢复（避免递归），整个 connect() 就会直接失败。
    const previousSessionId = this.sessionId;
    this.sessionId = undefined;
    if (previousSessionId) {
      console.error(`Dropping previous session before re-initialize for ${this.name}: ${previousSessionId}`);
    }

    const initRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          prompts: {},
          resources: {}
        },
        clientInfo: {
          name: 'MCPClient',
          version: '1.0.0'
        }
      }
    };

    const response = await this.sendRequest(initRequest);

    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    // Check for session ID (get from extended properties)
    if ((response as any).sessionId) {
      this.sessionId = (response as any).sessionId;
      console.error(`Received session ID for ${this.name}: ${this.sessionId}`);
    }

    // Send initialized notification (some servers like GitHub Copilot may not support this)
    try {
      await this.sendNotification({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });
      console.error(`Sent initialized notification to ${this.name}`);
    } catch (error) {
      console.warn(`Failed to send initialized notification to ${this.name} (this is normal for some servers like GitHub Copilot):`, (error as Error).message);
      // Don't throw error - some servers don't support this notification
    }
  }


  async getTools(): Promise<MCPTool[]> {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/list',
      params: {}
    };

    const response = await this.sendRequest(request);

    if (response.error) {
      throw new Error(`Failed to get tools: ${response.error.message}`);
    }

    return response.result?.tools || [];
  }

  async callTool(name: string, args: any): Promise<MCPResponse> {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    };

    return this.sendRequest(request);
  }

  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.isConnected && request.method !== 'initialize') {
      throw new Error(`Not connected to ${this.name}`);
    }

    try {
      return await this.doSendRequest(request);
    } catch (error) {
      // initialize 自身不再触发会话恢复，否则会递归
      if (request.method === 'initialize' || !this.isSessionLoss(error)) {
        throw error;
      }

      await this.recoverSession();

      // 只重试一次，且换一个新的请求 id：上一次尝试可能还有一个迟到的响应在路上，
      // 沿用同一个 id 会让它被当成重试的结果而串号
      const retryRequest: MCPRequest = { ...request, id: this.getNextRequestId() };
      return await this.doSendRequest(retryRequest);
    }
  }

  /**
   * 判断一次失败是否源于「会话失效」——即下游已经不认我们手里的会话。
   *
   * 两种形态都会出现，缺一不可：
   * - 404：下游明确表示会话不存在（MCP 规范建议的取值，实测 rmcp 亦如此）。
   * - 422：我们手里已无会话可发（sessionId 被上一次失败清空）时，下游对非 initialize
   *   请求回「Unexpected message, expect initialize request」。
   *   只认 404 会漏掉这一形态 —— 清空 sessionId 之后一直没有重新握手，请求从此不带
   *   会话头，每一次都撞 422，而 422 不在任何恢复分支里；同时 isConnected 仍为 true，
   *   connectAll 又认为该 adapter 无需重连，于是**永久卡死**（ssh-server 曾如此）。
   *   故此处把「无会话可发时被下游拒绝」同样视为会话失效，交由 recoverSession 重建。
   */
  private isSessionLoss(error: unknown): boolean {
    // 显式关闭会话管理时不存在「会话失效」，422 只能请求本身的问题，不做重建
    if (this.sessionMode === 'disabled') {
      return false;
    }

    const status = (error as any)?.httpStatus;
    if (status === 404) {
      return true;
    }

    // 手里没有会话却被下游拒绝，就是会话失效。两种状态码都要认：
    // - 422：rmcp 对无会话的非 initialize 请求的回应
    //   （"Unexpected message, expect initialize request"）。
    // - 400：官方 SDK 的回应（"Bad Request: Mcp-Session-Id header is required"）。
    // 只认其中一种，另一种就会重现「清空 sessionId 之后一直撞错、却没有任何恢复分支」
    // 的永久卡死。限定 `!this.sessionId`，避免把带着会话的普通 400 误判成会话失效。
    return (status === 422 || status === 400) && !this.sessionId;
  }

  /**
   * 重建已失效的会话。
   *
   * 只重做 initialize 握手获取新 sessionId，**不**走 connect()/disconnect()：
   * 失败的是会话而非连接本身（HTTP 端点始终可达），绕开 connect() 的 isConnected
   * 守卫，也不会发出 disconnected/connected 事件把工具路由摘掉再重建 —— 工具清单
   * 并未变化，摘路由会让此刻正在进行的 tools/list 与 tools/call 平白失败。
   *
   * 并发合流：同一时刻多个在途请求可能一起拿到 404，不加闩就会各自发一次 initialize，
   * 后建立的会话顶掉先建立的，先建立的那次握手随即作废。
   */
  private async recoverSession(): Promise<void> {
    if (this.sessionRecovery) {
      return this.sessionRecovery;
    }

    this.sessionRecovery = (async () => {
      const expired = this.sessionId;
      // 先丢弃失效会话：initialize 必须以「无会话」形态发出，否则仍会被下游按失效会话拒掉
      this.sessionId = undefined;

      console.error(
        `Session lost for ${this.name}${expired ? ` (expired sessionId: ${expired})` : ''}, re-initializing...`
      );

      try {
        await this.initialize();
        console.error(`Session recovered for ${this.name}, sessionId: ${this.sessionId}`);
      } catch (error) {
        console.error(`Session recovery failed for ${this.name}:`, (error as Error).message);
        throw new Error(
          `Failed to recover session for ${this.name}: ${(error as Error).message}`
        );
      }
    })();

    try {
      await this.sessionRecovery;
    } finally {
      this.sessionRecovery = undefined;
    }
  }

  private async doSendRequest(request: MCPRequest): Promise<MCPResponse> {
    return new Promise<MCPResponse>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Request timeout for ${this.name}`));
      }, this.config.timeout || 30000);

      this.pendingRequests.set(request.id, {
        resolve,
        reject,
        timeout
      });

      try {
        console.error(`Sending request to ${this.name}: ${request.method}`);
        
        // Prepare request headers, including session info (if any)
        const requestHeaders: Record<string, string> = {};
        if (this.sessionId && this.sessionMode !== 'disabled') {
          requestHeaders['Mcp-Session-Id'] = this.sessionId;
        }
        
        // Send HTTP POST request to the correct endpoint path
        const response = await this.httpClient.post(this.endpointPath, request, {
          headers: requestHeaders,
          responseType: 'text' // Receive raw text to handle SSE
        });
        
        // Handle response
        await this.handleResponse(response, request.id);
        
      } catch (error) {
        this.pendingRequests.delete(request.id);
        clearTimeout(timeout);

        // 会话失效时不在这里清 sessionId：交给 recoverSession 统一处理，
        // 否则并发到达的多个 404 会各自看到不同的会话状态，重复触发重建
        const failure: any = new Error(
          `Failed to send request to ${this.name}: ${(error as Error).message}`
        );
        failure.httpStatus = (error as any)?.response?.status;
        reject(failure);
      }
    });
  }

  private async handleResponse(response: any, requestId: string | number): Promise<void> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    try {
      // Extract session ID from response headers (for GitHub Copilot and similar servers)
      const sessionId = response.headers['mcp-session-id'];
      if (sessionId) {
        this.sessionId = sessionId;
        console.error(`Extracted session ID from response headers for ${this.name}: ${this.sessionId}`);
      }

      const contentType = response.headers['content-type'] || '';
      
      if (contentType.includes('text/event-stream')) {
        // Handle SSE streaming response
        await this.handleSSEResponse(response.data, requestId);
      } else if (contentType.includes('application/json')) {
        // Handle single JSON response
        const jsonResponse = typeof response.data === 'string' 
          ? JSON.parse(response.data) 
          : response.data;
        
        this.handleJSONResponse(jsonResponse, requestId);
      } else {
        throw new Error(`Unsupported response content type: ${contentType}`);
      }
    } catch (error) {
      pending.reject(new Error(`Failed to handle response: ${(error as Error).message}`));
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
    }
  }

  private async handleSSEResponse(sseData: string, requestId: string | number): Promise<void> {
    const lines = sseData.split('\n');
    let eventType = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.substring(5).trim();
        
        if (eventType === 'message' && data) {
          try {
            const message = JSON.parse(data);
            
            // Check for session ID
            if ((message as any).sessionId) {
              this.sessionId = (message as any).sessionId;
              console.error(`Updated session ID for ${this.name}: ${this.sessionId}`);
            }
            
            // Handle MCP response
            if (message.id === requestId) {
              this.handleJSONResponse(message, requestId);
            } else if (message.method) {
              // Handle server-pushed notifications
              this.handleServerNotification(message);
            }
          } catch (error) {
            console.error(`Failed to parse SSE data from ${this.name}:`, data);
          }
        }
      }
    }
  }

  private handleJSONResponse(message: MCPResponse, requestId: string | number): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      
      // Check session ID in response headers
      if ((message as any).sessionId) {
        this.sessionId = (message as any).sessionId;
        console.error(`Updated session ID from response for ${this.name}: ${this.sessionId}`);
      }
      
      pending.resolve(message);
    }
  }

  private handleServerNotification(notification: any): void {
    console.error(`Received server notification from ${this.name}:`, notification.method);
    
    if (notification.method === 'notifications/tools/list_changed') {
      // Tool list changed, notify router for unified handling  
      this.emit('tools-changed', { serverName: this.name });
    }
    
    // Forward notification to upper layer
    this.emit('notification', { serverName: this.name, notification });
  }

  private async sendNotification(notification: any): Promise<void> {
    if (!this.isConnected && notification.method !== 'notifications/initialized') {
      return;
    }

    try {
      // Prepare request headers, including session info (if any)
      const requestHeaders: Record<string, string> = {};
      if (this.sessionId && this.sessionMode !== 'disabled') {
        requestHeaders['Mcp-Session-Id'] = this.sessionId;
      }
      
      await this.httpClient.post(this.endpointPath, notification, {
        headers: requestHeaders
      });
    } catch (error) {
      console.error(`Failed to send notification to ${this.name}:`, error);
    }
  }

  private getNextRequestId(): number {
    return this.requestId++;
  }

  // Get current tool list (fetch in real-time from server)
  async getCachedTools(): Promise<MCPTool[]> {
    if (!this.isConnected) return [];
    return await this.getTools();
  }

  // Check if specific tool is available (check in real-time from server)
  async hasTools(toolName: string): Promise<boolean> {
    if (!this.isConnected) return false;
    const tools = await this.getTools();
    return tools.some(tool => tool.name === toolName);
  }

  // Get connection status information
  getStatus(): {
    name: string;
    connected: boolean;
    toolCount: number;
    pendingRequests: number;
    endpoint: string;
    sessionId?: string;
  } {
    return {
      name: this.name,
      connected: this.isConnected,
              toolCount: 0, // Tool count managed by router
      pendingRequests: this.pendingRequests.size,
      endpoint: this.endpoint,
      sessionId: this.sessionId
    };
  }
}