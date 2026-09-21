import { EventEmitter } from 'events';
import axios, { AxiosInstance } from 'axios';
import * as EventSourceLib from 'eventsource';
// @ts-ignore - CommonJS module in ESM context
const EventSource = (EventSourceLib as any).EventSource;
import { MCPServerConfig, MCPTool, MCPRequest, MCPResponse, ServerAdapter } from '../types/index.js';

export class HttpSseAdapter extends EventEmitter implements ServerAdapter {
  public readonly name: string;
  public readonly config: MCPServerConfig;
  public isConnected: boolean = false;

  private httpClient: AxiosInstance;
  private sseEventSource?: any; // Use any type to avoid EventSource type complexity
  private requestId: number = 1;
  private pendingRequests: Map<string | number, {
    resolve: (value: MCPResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private baseUrl: string;
  private sseUrl: string;
  private dynamicEndpoint?: string; // Dynamic endpoint obtained from SSE
  private sessionId?: string; // MCP Session ID
  private sessionMode: 'auto' | 'required' | 'disabled' = 'auto'; // Session mode
  private reconnectTimer?: NodeJS.Timeout;
  private isReconnecting: boolean = false;
  private isDisabled: boolean = false; // Whether disabled, should not auto-reconnect if disabled
  /**
   * 连接代数：每次 connect()/disconnect()/disable() 递增。
   *
   * 用于让「停止」在重连进行中也生效：attemptReconnection 里 `await this.connect()`
   * 可能耗时（SSE 建连 + 1s 等待 + initialize），期间调用 disconnect() 只是把标志位
   * 复位，那个已经飞在半空的重连仍会在返回后把连接建起来 —— 表现为「刚 stop 又自己连上」。
   * 重连前后比对代数，不一致就说明期间被停止/重启过，放弃本次结果并清理。
   */
  private connectionGeneration = 0;
  /**
   * 进行中的 connect() 握手。
   *
   * 两个作用：
   * - 并发合流：握手期间 isConnected 仍为 false，多个调用方会各自建一条 SSE 流，
   *   后一条覆盖 sseEventSource，前一条成为无人引用的活连接（关不掉也收不到事件）。
   * - 让 disconnect() 知道「有握手在进行」，从而不会因 isConnected 为 false 就早退。
   */
  private connectPromise?: Promise<void>;
  /** 事件通道是否已失效（收到过 onerror）；connect() 据此拒绝在死流上宣称已连接 */
  private sseStreamLost = false;
  /**
   * 当前这条流的 onopen 是否已经触发过。
   * 用于区分「建连失败」与「连上之后掉线」：前者交给 connect() 的 Promise，
   * 后者必须走重连。用 reject 闭包是否存在来判断会误伤中途掉线
   * （onopen 之后 reject 闭包仍然存在）。
   */
  private hasEverOpened = false;
  /** 建连卡住时（对端接受 TCP 却不回响应头）由 cleanup() 调用的 settle 出口 */
  private settlePendingConnect?: (error: Error) => void;

  constructor(name: string, config: MCPServerConfig) {
    super();
    this.name = name;
    this.config = config;

    if (config.transport !== 'http-sse') {
      throw new Error(`Invalid transport for HttpSseAdapter: ${config.transport}`);
    }

    const httpUrl = config.url || config.endpoint;
    if (!httpUrl) {
      throw new Error('URL or endpoint is required for http-sse transport');
    }

    this.baseUrl = httpUrl;
    this.sseUrl = config.sseEndpoint || `${this.baseUrl}/sse`;
    
    // Set session mode
    this.sessionMode = (config as any).sessionMode || 'auto';

    // Create HTTP client
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        ...(config.headers || {}),
        ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
      }
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    // 并发合流：握手期间 isConnected 仍为 false，不合并会各自建一条 SSE 流，
    // 后一条覆盖 sseEventSource，前一条成为无人引用的活连接。
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // 记录本次连接的代数，握手结束时核对是否已被停止/重启取代
    const generation = this.connectionGeneration;

    this.connectPromise = (async () => {
      try {
        console.error(`Connecting to ${this.name} via HTTP+SSE: ${this.baseUrl}`);

        // 1. Establish SSE connection
        await this.connectSSE();

        // 2. Wait for dynamic endpoint to be set (give some time to receive endpoint event)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 3. Initialize handshake
        await this.initialize();

        // 握手期间被 disconnect()/disable() 或另一次 connect() 取代：不能宣称已连接。
        // 这条流属于已经作废的那一次尝试，必须关掉，否则会留下一份无人引用的连接
        // （旧流不可达也无法关闭），并让「已停止」的服务器看起来又活了。
        if (generation !== this.connectionGeneration) {
          console.error(
            `Connection attempt for ${this.name} was superseded (generation ${generation} -> ${this.connectionGeneration}), discarding`
          );
          this.cleanup();
          return;
        }

        // 事件通道在握手期间就断了：initialize 是独立 HTTP POST，可能照常成功，
        // 但这条流已死。不能宣称已连接并留下「isConnected=true 却没有活流」的
        // 永久卡死形态（工具调用会全部超时，connectAll 还认为它无需重连）。
        if (this.sseStreamLost) {
          console.error(`SSE stream was lost during handshake for ${this.name}, not marking as connected`);
          this.cleanup();
          throw new Error(`Failed to connect to ${this.name}: SSE stream closed during handshake`);
        }

        // Mark as connected, let router manage tool list fetching
        this.isConnected = true;
        console.error(`Connected to ${this.name}`);
        this.emit('connected', { serverName: this.name });

      } catch (error) {
        this.cleanup();

        // 建连失败后的重试由**适配器自己**负责排期，而不是甩给调用方。
        //
        // 一度把「握手窗口内掉线」交给调用方去重试，结果是彻底不恢复：
        // 唯一的调用方 ToolRouter.connectAll 只把失败计入 failedCount，不会重排；
        // 而 onerror 那边又已不再 arm 重连 —— 该服务器从此永久离线，只有改配置才回来。
        //
        // 现在统一为：只要这次失败不是「被 disconnect()/disable() 取代」，
        // 就排一轮退避重试（scheduleReconnect 会同时置 isReconnecting 并记住定时器，
        // 二者一致，不会出现「标志位 true 却无定时器」的闩死形态）。
        if (generation === this.connectionGeneration && !this.isDisabled) {
          this.scheduleReconnect((this.config.sseReconnectInterval || 5000) * 2);
        } else {
          // 已被停止/取代：不要排期，也不必复位什么——调用方已经把我们停掉了
          this.isReconnecting = false;
        }

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
    // 在途请求必须在任何早退之前了结：连接已断，它们不可能再收到响应。
    // 放在守卫之后会被跳过 —— removeAdapter 是先 disable()（它会把 isConnected
    // 置 false）再 disconnect()，守卫看到「未连接」就直接返回，调用方于是要各自
    // 等满请求超时（实测从 0.3s 的干净失败退化成 6s 挂住）。
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // 不能因 !isConnected 就早退：handleSSEDisconnection 会先把 isConnected 置 false
    // 再挂 reconnectTimer，这个窗口内调用 disconnect() 若直接返回，定时器与
    // isReconnecting=true 都会留下 —— 已经请求停机的服务器随后会自己 reconnect 复活
    // （MCPDogServer.stop() 只调 disconnect()、不调 disable()），EventSource 还会拖住进程。
    // connectPromise 同样要算进来：握手进行中（isConnected 尚为 false、也没有定时器）
    // 时的 disconnect() 必须能取消那次握手，否则它会照常把连接建起来。
    if (!this.isConnected && !this.reconnectTimer && !this.isReconnecting && !this.connectPromise) {
      return;
    }

    console.error(`Disconnecting from ${this.name}`);

    // 递增代数：让任何在飞的 connect()/重连在返回时发现「已被取代」并自行放弃
    this.connectionGeneration++;

    // 建连卡住时（对端接受 TCP 却不回响应头 / 库把在飞的 fetch abort 掉且不派发
    // 任何事件）connectSSE 的 Promise 不会 settle，connectPromise 会永久占位，
    // 此后每一次 connect() 都直接返回那个永不 settle 的 Promise —— 实例再也连不上。
    // 这里显式了结它，让 connectPromise 得以释放。
    if (this.settlePendingConnect) {
      const settle = this.settlePendingConnect;
      this.settlePendingConnect = undefined;
      settle(new Error(`Connection attempt for ${this.name} was aborted by disconnect`));
    }

    // cleanup() 清掉 reconnectTimer；isReconnecting 必须一并复位，
    // 否则后续连接尝试会被 `if (this.isReconnecting) return` 永久挡住
    this.cleanup();
    this.isReconnecting = false;
    this.isConnected = false;

    console.error(`Disconnected from ${this.name}`);
    this.emit('disconnected', { serverName: this.name });
  }

  private async connectSSE(): Promise<void> {
    // 新流开始建立：这些标记只描述「当前这条流」，必须复位
    this.sseStreamLost = false;
    this.hasEverOpened = false;
    return new Promise((resolve, reject) => {
      // 登记 settle 出口：建连卡住时由 cleanup()（disconnect/disable 调用）了结，
      // 否则 connectPromise 永久占位，实例再也连不上
      this.settlePendingConnect = (error: Error) => reject(error);
      try {
        const sseOptions: any = {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...(this.config.headers || {}),
            ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
          }
        };

        console.error(`Establishing SSE connection to ${this.sseUrl}`);
        
        this.sseEventSource = new EventSource(this.sseUrl, sseOptions);
        
        // Set event handler
        this.setupSSEHandlers(resolve, reject);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  private setupSSEHandlers(resolve?: () => void, reject?: (error: Error) => void): void {
    if (!this.sseEventSource) {
      reject?.(new Error('SSE EventSource not initialized'));
      return;
    }

    // Connection successful
    this.sseEventSource.onopen = (event: any) => {
      console.error(`SSE connection opened for ${this.name}`);
      this.hasEverOpened = true;
      this.settlePendingConnect = undefined;
      if (resolve) {
        resolve();
        resolve = undefined; // Avoid duplicate calls
      }
    };

    // Receive message
    this.sseEventSource.onmessage = (event: any) => {
      try {
        // Handle typed SSE events
        if (event.type === 'endpoint' || event.lastEventId === 'endpoint') {
          this.dynamicEndpoint = event.data;
          console.error(`Updated dynamic endpoint for ${this.name}: ${this.dynamicEndpoint}`);
          return;
        }
        
        const message = JSON.parse(event.data);
        this.handleSSEMessage(message);
        
        // Check if it's an MCP response
        if (message.id && (message.result || message.error)) {
          this.handleMCPResponse(message);
        }
      } catch (error) {
        // May be plain text message, try to handle as endpoint
        if (event.data && event.data.startsWith('/mcp/messages/')) {
          this.dynamicEndpoint = event.data;
          console.error(`Updated dynamic endpoint from text for ${this.name}: ${this.dynamicEndpoint}`);
        } else {
          console.error(`Failed to parse SSE message from ${this.name}:`, event.data);
        }
      }
    };

    // Connection error
    this.sseEventSource.onerror = (event: any) => {
      console.error(`SSE connection error for ${this.name}:`, event);

      // 标记事件通道已失效。connect() 会在握手结束前核对它：握手期间（onopen 之后、
      // isConnected 置位之前，窗口 ≥1s）掉线时，initialize 走的是独立 HTTP POST，
      // 可能照常成功，于是 connect() 会在一条已死的流上宣称「已连接」。
      this.sseStreamLost = true;

      if (reject && !this.hasEverOpened) {
        // 建连阶段就失败（onopen 之前）：这次失败归 connectSSE 的 Promise，
        // 由 connect() 的 catch 处理。不能在这里arm重连 —— 那个定时器随后会被
        // connect() 的 catch 里的 cleanup() 清掉，只留下 isReconnecting=true 的闩死状态。
        this.settlePendingConnect = undefined;
        reject(new Error(`SSE connection failed for ${this.name}`));
        reject = undefined;
        return;
      }
      reject = undefined;

      // 握手进行中（onopen 之后、connect() 尚未返回）掉线：**不在这里 arm 重连**。
      // 这次 connect() 会在结尾发现流已死并失败，由它的调用方决定后续：
      // 普通调用方（connectAll / 配置重载）会重试；重连发起的调用方由
      // attemptReconnection 自己按退避续排。若在这里 arm，定时器会被随后的
      // cleanup() 清掉（清掉定时器却不复位标志位 → 闩死），或者反过来在标志位被
      // 复位后留下一个永远不被执行的定时器 —— 两种都是永久失效。
      if (this.connectPromise) {
        console.error(`SSE stream lost during handshake for ${this.name}, deferring to the connect() caller`);
        return;
      }

      if (!this.isReconnecting) {
        // Connection lost, try to reconnect
        this.handleSSEDisconnection();
      }
    };

    // Listen for MCP response messages
    this.sseEventSource.addEventListener('mcp-response', (event: any) => {
      try {
        const response = JSON.parse(event.data);
        this.handleMCPResponse(response);
      } catch (error) {
        console.error(`Failed to parse MCP response from ${this.name}:`, event.data);
      }
    });

    // Listen for MCP notifications
    this.sseEventSource.addEventListener('mcp-notification', (event: any) => {
      try {
        const notification = JSON.parse(event.data);
        this.handleMCPNotification(notification);
      } catch (error) {
        console.error(`Failed to parse MCP notification from ${this.name}:`, event.data);
      }
    });

    // Listen for endpoint events
    this.sseEventSource.addEventListener('endpoint', (event: any) => {
      this.dynamicEndpoint = event.data;
      console.error(`Received endpoint event for ${this.name}: ${this.dynamicEndpoint}`);
      
      // Extract sessionId (if exists)
      this.extractSessionId();
    });
  }

  private extractSessionId(): void {
    if (!this.dynamicEndpoint) {
      return;
    }

    try {
      // Extract sessionId from URL query parameters
      const url = new URL(this.dynamicEndpoint, this.baseUrl);
      const urlSessionId = url.searchParams.get('sessionId');
      
      if (urlSessionId) {
        this.sessionId = urlSessionId;
        console.error(`Extracted sessionId from URL for ${this.name}: ${this.sessionId}`);
        return;
      }

      // Extract sessionId from path (e.g., /mcp/messages/session-id-here)
      const pathMatch = this.dynamicEndpoint.match(/\/mcp\/messages\/([^/?]+)/);
      if (pathMatch && pathMatch[1]) {
        this.sessionId = pathMatch[1];
        console.error(`Extracted sessionId from path for ${this.name}: ${this.sessionId}`);
        return;
      }

      // If sessionMode is required but no sessionId found, log warning
      if (this.sessionMode === 'required' && !this.sessionId) {
        console.error(`Warning: Session mode is required but no sessionId found in endpoint: ${this.dynamicEndpoint}`);
      }

    } catch (error) {
      console.error(`Failed to extract sessionId from endpoint ${this.dynamicEndpoint}:`, error);
    }
  }

  private async initialize(): Promise<void> {
    const initRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        clientInfo: {
          name: 'mcpdog',
          version: '2.0.0'
        }
      }
    };

    const response = await this.sendRequest(initRequest);

    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
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
    // Allow sending initialize request during connection process
    if (!this.isConnected && !this.sseEventSource) {
      throw new Error(`Not connected to ${this.name}`);
    }

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
        // Use dynamic endpoint or fall back to default endpoint
        let endpoint = this.dynamicEndpoint || '/mcp';
        console.error(`Sending request to ${this.name} via: ${endpoint}`);
        
        // If dynamic endpoint and relative path, need to construct full URL
        if (this.dynamicEndpoint && this.dynamicEndpoint.startsWith('/')) {
          const url = new URL(this.dynamicEndpoint, this.baseUrl);
          endpoint = url.pathname + url.search;
        }
        
        // Prepare request headers, including session info (if any)
        const requestHeaders: Record<string, string> = {};
        if (this.sessionId && this.sessionMode !== 'disabled') {
          requestHeaders['Mcp-Session-Id'] = this.sessionId;
          console.error(`Adding session header for ${this.name}: Mcp-Session-Id=${this.sessionId}`);
        }
        
        // Send request via HTTP POST
        const response = await this.httpClient.post(endpoint, request, {
          headers: requestHeaders
        });
        
        // Handle synchronous response
        if (response.data && response.data.id === request.id) {
          const pending = this.pendingRequests.get(request.id);
          if (pending) {
            this.pendingRequests.delete(request.id);
            clearTimeout(pending.timeout);
            pending.resolve(response.data as MCPResponse);
          }
        }
      } catch (error) {
        this.pendingRequests.delete(request.id);
        clearTimeout(timeout);
        
        // Check for session-related errors
        if ((error as any).response?.status === 404 && this.sessionId) {
          console.error(`Session expired for ${this.name}, sessionId: ${this.sessionId}`);
          // Clear expired sessionId, trigger reconnect to get new session
          this.sessionId = undefined;
          this.handleSSEDisconnection();
        }
        
        reject(new Error(`Failed to send request to ${this.name}: ${(error as Error).message}`));
      }
    });
  }

  private async sendNotification(notification: any): Promise<void> {
    // 与 StreamableHttpAdapter.sendNotification 同样的豁免：握手期的
    // notifications/initialized 必须在 isConnected 置位**之前**发出
    // （initialize() 就是在 connect() 里、isConnected = true 之前 await 它的）。
    // 此前无条件 `if (!this.isConnected) return`，这条通知被静默丢掉，
    // 下游等不到 initialized，而调用方那句「某些服务器不支持该通知」的 catch 也不会触发。
    //
    // 但豁免必须限定在「握手进行中」：只看方法名的话，一个从未连接、
    // 甚至已经 disconnect() 的适配器也会照发（打到 fallback 端点），
    // 等于对已停止的服务器继续写数据。
    const inHandshake = !!this.connectPromise;
    const handshakeNotification = notification?.method === 'notifications/initialized' && inHandshake;
    if (!this.isConnected && !handshakeNotification) {
      return;
    }

    try {
      // Use dynamic endpoint or fall back to default endpoint
      let endpoint = this.dynamicEndpoint || '/mcp';
      
      // Prepare request headers, including session info (if any)
      const requestHeaders: Record<string, string> = {};
      if (this.sessionId && this.sessionMode !== 'disabled') {
        requestHeaders['Mcp-Session-Id'] = this.sessionId;
      }
      
      await this.httpClient.post(endpoint, notification, {
        headers: requestHeaders
      });
    } catch (error) {
      console.error(`Failed to send notification to ${this.name}:`, error);
    }
  }

  private getNextRequestId(): number {
    return this.requestId++;
  }

  private handleSSEMessage(message: any): void {
    // Handle generic SSE message
    console.error(`Received SSE message from ${this.name}:`, message);
    
    // Check if it's an endpoint message
    if (message.endpoint) {
      this.dynamicEndpoint = message.endpoint;
      console.error(`Updated dynamic endpoint for ${this.name}: ${this.dynamicEndpoint}`);
    }
  }

  private handleMCPResponse(response: MCPResponse): void {
    // Handle MCP response
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
    } else {
      console.warn(`Received response for unknown request ID: ${response.id}`);
    }
  }

  private handleMCPNotification(notification: any): void {
    console.error(`Received MCP notification from ${this.name}:`, notification.method);
    
    if (notification.method === 'notifications/tools/list_changed') {
      // Tool list changed, notify router for unified handling
      this.emit('tools-changed', { serverName: this.name });
    }
    
    // Forward notification to upper layer
    this.emit('notification', { serverName: this.name, notification });
  }

  /**
   * 排定下一轮重连。
   *
   * 这是**唯一**的重连排期入口，集中保证两件不变量：
   * - 定时器句柄必须被记录，且回调触发时先清掉自己 —— 否则 disconnect()/cleanup()
   *   看到的是一个已完成的旧句柄，重连无法被取消，或排期与状态不一致。
   * - 「有重连在排队」与 isReconnecting 必须同真同假。二者不一致会让
   *   attemptReconnection 的入口守卫 `if (!this.isReconnecting) return` 静默吞掉
   *   本轮重试（定时器触发了却什么都没做，之后也不再排期 —— 重试链永久断掉）。
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.isDisabled) {
      return;
    }

    this.isReconnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnection();
    }, delayMs);
  }

  private handleSSEDisconnection(): void {
    if (this.isReconnecting) {
      return;
    }

    // If server is disabled, should not auto-reconnect
    if (this.isDisabled) {
      console.error(`❌ ${this.name} is disabled, no auto-reconnect`);
      this.isConnected = false;
      this.emit('disconnected', { 
        serverName: this.name,
        error: new Error('SSE connection lost - server disabled')
      });
      return;
    }

    this.isConnected = false;
    
    console.error(`SSE connection lost for ${this.name}, attempting reconnection...`);
    this.emit('disconnected', { 
      serverName: this.name,
      error: new Error('SSE connection lost')
    });

    this.scheduleReconnect(this.config.sseReconnectInterval || 5000);
  }

  private async attemptReconnection(): Promise<void> {
    if (!this.isReconnecting) {
      return;
    }

    // 记下代数：重连期间若被 disconnect()/disable() 取代，返回后不得再改状态。
    // 注意这里**不能**自己递增 this.connectionGeneration —— 下面的比对就是以
    // 「期间的递增是否来自别人」为判据；自己递增会让比对恒不相等，于是每次重连都走
    // 「已被取代」分支、isReconnecting 永远留 true，重连只跑一轮就再也不试。
    const generation = this.connectionGeneration;

    try {
      console.error(`Attempting to reconnect ${this.name}...`);

      // 只关掉旧的事件流，**不能**调 cleanup()：
      // cleanup() 还会清掉 reconnectTimer —— 而本轮重连正是由那个定时器驱动的
      // （它已在回调里把自己置空），更关键的是 scheduleReconnect 依赖
      // 「定时器句柄」与 isReconnecting 的一致性来判断重试链是否还活着。
      // 用它做 teardown 会让重试链在第一次重连失败后就断掉（实测 sseHits 停止增长，
      // 最终 isReconnecting=true 而 timer=false —— 正是闩死形态）。
      this.closeEventStream();

      // connect() 顶部有 `if (this.isConnected) return` 守卫：若期间已由别处建立了连接，
      // 这里会先关掉那条活流、再空转返回，然后报「重连成功」——
      // 实际事件通道已失去，走 SSE 回包的工具调用会全部超时。
      // 因此重连前必须把状态复位，让 connect() 真正执行。
      this.isConnected = false;

      // Reconnect：失败时的重试排期由 connect() 的 catch 统一负责
      await this.connect();

      if (generation !== this.connectionGeneration) {
        console.error(`Reconnect for ${this.name} was superseded, not restoring state`);
        return;
      }

      this.isReconnecting = false;
      console.error(`Successfully reconnected ${this.name}`);

    } catch (error) {
      console.error(`Reconnection failed for ${this.name}:`, (error as Error).message);

      if (generation !== this.connectionGeneration) {
        // 期间已被停止：不要再排下一轮，否则「已停止」的服务器会持续重连
        console.error(`Reconnect for ${this.name} was superseded, stopping retries`);
        return;
      }

      // 重连失败：按退避续排下一轮（由 scheduleReconnect 保证
      // 「有定时器」与「isReconnecting」始终一致 —— 二者不一致会让下一轮
      // 在入口守卫处被静默吞掉，重试链就此永久断掉）
      this.scheduleReconnect((this.config.sseReconnectInterval || 5000) * 2);
    }
  }

  /**
   * 只关掉当前事件流并释放卡住的建连。
   *
   * 与 cleanup() 的区别：**不动 reconnectTimer**。重连流程需要这个区分 ——
   * cleanup() 会把驱动重试链的定时器一并清掉，用它做重连前的 teardown
   * 会让重试链在首次失败后断掉。
   */
  private closeEventStream(): void {
    if (this.sseEventSource) {
      this.sseEventSource.close();
      this.sseEventSource = undefined;
    }
    this.sseStreamLost = false;

    // 建连卡住时（对端接受 TCP 却不回响应头）库不会派发任何事件，
    // 这里的 settle 出口是唯一的了结途径，否则 connectPromise 永久占位。
    if (this.settlePendingConnect) {
      const settle = this.settlePendingConnect;
      this.settlePendingConnect = undefined;
      settle(new Error(`Connection attempt for ${this.name} was aborted`));
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.closeEventStream();
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
  } {
    return {
      name: this.name,
      connected: this.isConnected,
      toolCount: 0, // Tool count managed by router
      pendingRequests: this.pendingRequests.size,
      endpoint: this.baseUrl
    };
  }

  // Disable adapter, prevent auto-reconnect
  disable(): void {
    console.error(`🚫 Disabling ${this.name} - no auto-reconnect`);
    this.isDisabled = true;
    // 递增代数：正在进行的 connect() 结束时会发现已被取代，不会把连接建起来
    this.connectionGeneration++;
    // 必须真正关掉底层 SSE 连接。只清定时器不够：eventsource 库自带重连，
    // 不 close() 它会继续按自己的节奏重试并保持一条打开的流
    // （removeAdapter 之后事件监听已被摘除，那条流再没人能关）。
    this.cleanup();
    this.isReconnecting = false;
    this.isConnected = false;
  }

  // Re-enable adapter, allow auto-reconnect
  enable(): void {
    console.error(`✅ Enabling ${this.name} - auto-reconnect allowed`);
    this.isDisabled = false;
  }
}