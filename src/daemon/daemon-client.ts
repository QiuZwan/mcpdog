/**
 * MCPDog Daemon Client
 * Used to connect to the daemon and communicate
 */

import { EventEmitter } from 'events';
import { Socket } from 'net';

export interface DaemonClientConfig {
  host?: string;
  port?: number;
  clientType: 'stdio' | 'web' | 'cli';
  reconnect?: boolean;
  reconnectInterval?: number;
  silent?: boolean; // Silent mode, no log output
}

export class DaemonClient extends EventEmitter {
  private socket: Socket;
  private config: DaemonClientConfig;
  private isConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private requestCounter = 0;
  private pendingRequests = new Map<string, {
    resolve: (response: any) => void;
    reject: (error: Error) => void;
  }>();
  private recvBuffer = '';

  constructor(config: DaemonClientConfig) {
    super();
    this.config = {
      host: 'localhost',
      port: 9999,
      reconnect: true,
      reconnectInterval: 5000,
      ...config
    };
    this.socket = new Socket();
    this.setupSocket();
  }

  private setupSocket() {
    this.socket.on('connect', () => {
      if (!this.config.silent) {
        console.log('[DAEMON-CLIENT] Connected to daemon');
      }
      this.isConnected = true;
      this.clearReconnectTimer();
      
      // Send handshake message
      this.send({
        type: 'handshake',
        clientType: this.config.clientType
      });
      
      this.emit('connected');
    });

    this.socket.on('data', (data) => {
      // TCP 分片缓冲：单条 JSON 消息可能超过单个 TCP chunk（约 64KB，如聚合全部工具后的
      // tools/list 响应），被拆到多个 data 事件；必须跨 chunk 拼接后再按行切分，
      // 否则大响应永远解析失败，且 silent 模式下错误被吞、请求方一直等到超时
      this.recvBuffer += data.toString();
      let newlineIndex: number;
      while ((newlineIndex = this.recvBuffer.indexOf('\n')) >= 0) {
        const line = this.recvBuffer.slice(0, newlineIndex).trim();
        this.recvBuffer = this.recvBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          if (!this.config.silent) {
            console.error('[DAEMON-CLIENT] Invalid message:', error);
          }
        }
      }
    });

    this.socket.on('close', () => {
      if (!this.config.silent) {
        console.log('[DAEMON-CLIENT] Disconnected from daemon');
      }
      this.isConnected = false;

      // 连接断了，在途请求不可能再收到响应：必须显式失败。
      // 此前只置标志位，等待方（stdio-proxy 的 await sendMCPRequest）永远挂住，
      // MCP 客户端那边表现为毫无反馈地一直等。
      this.failPendingRequests(new Error('Connection to daemon closed before response'));

      this.emit('disconnected');
      
      if (this.config.reconnect) {
        this.scheduleReconnect();
      }
    });

    this.socket.on('error', (error) => {
      if (!this.config.silent) {
        console.error('[DAEMON-CLIENT] Socket error:', error);
      }
      this.emit('error', error);
    });
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'welcome':
        if (!this.config.silent) {
          console.log(`[DAEMON-CLIENT] Welcome, client ID: ${message.clientId}`);
        }
        this.emit('welcome', message);
        break;

      case 'handshake-ack':
        if (!this.config.silent) {
          console.log('[DAEMON-CLIENT] Handshake acknowledged');
        }
        this.emit('ready', message.serverStatus);
        break;

      case 'mcp-response':
        // MCP request response
        const responseCallback = this.pendingRequests.get(message.requestId);
        if (responseCallback) {
          this.pendingRequests.delete(message.requestId);
          responseCallback.resolve(message.response);
        }
        break;

      case 'mcp-error':
        // MCP request error：error 字段本身就是一条完整的 JSON-RPC 错误报文
        // （见 daemon 侧 mcp-request 的 catch），原样交给上层即可。
        // 此前包成 { error: message.error }，把完整报文塞进 error 里，
        // 客户端拿到的既没有 jsonrpc/id 也没有 error.code，无法对应到自己的请求。
        const errorCallback = this.pendingRequests.get(message.requestId);
        if (errorCallback) {
          this.pendingRequests.delete(message.requestId);
          errorCallback.resolve(message.error);
        }
        break;

      case 'server-started':
      case 'server-stopped':
      case 'routes-updated':
      case 'tool-called':
      case 'config-changed':
        // Forward events
        this.emit(message.type, message.data);
        break;

      case 'status':
        this.emit('status', message.status);
        break;

      case 'tools':
        this.emit('tools', message.tools);
        break;

      default:
        // MCP 协议报文（形如 {jsonrpc:'2.0', method:'notifications/...'}）没有 `type` 字段，
        // 它们是 daemon 转发的服务端通知，必须交给上层写回 MCP 客户端。
        // 此前一律归为「未知消息类型」丢弃，配置热更新后的 tools/list_changed 到不了客户端。
        if (message && message.jsonrpc === '2.0' && typeof message.method === 'string') {
          this.emit('mcp-notification', message);
          break;
        }

        if (!this.config.silent) {
          console.warn('[DAEMON-CLIENT] Unknown message type:', message.type);
        }
    }
  }

  private send(message: any) {
    if (this.isConnected) {
      this.socket.write(JSON.stringify(message) + '\n');
    } else {
      if (!this.config.silent) {
        console.error('[DAEMON-CLIENT] Cannot send message, not connected');
      }
    }
  }

  /** 让所有在途请求以错误结束，避免等待方永久挂住 */
  private failPendingRequests(error: Error): void {
    if (this.pendingRequests.size === 0) return;
    const pending = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();
    for (const [requestId, entry] of pending) {
      entry.reject(error);
      if (!this.config.silent) {
        console.error(`[DAEMON-CLIENT] Failing pending request ${requestId}: ${error.message}`);
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    if (!this.config.silent) {
      console.log(`[DAEMON-CLIENT] Scheduling reconnect in ${this.config.reconnectInterval}ms`);
    }
    this.reconnectTimer = setTimeout(() => {
      // 必须先清掉自己：这个字段同时是「是否有重连在排队」的判据（见上面的守卫），
      // 回调触发后若仍留着这个已完成的 timer 对象，下一次 close 触发的
      // scheduleReconnect() 会被守卫直接短路 —— 重连只跑一轮就再也不试，
      // proxy 的「连续 3 次连不上就自拉起 daemon」阈值因此永远达不到。
      this.reconnectTimer = undefined;

      if (!this.config.silent) {
        console.log('[DAEMON-CLIENT] Attempting to reconnect...');
      }
      // 必须接住 rejection：connect() 在 daemon 不可达时 reject，裸调用会成为
      // process 级 unhandledRejection，而 CLI 的 handler 是 process.exit(1) ——
      // proxy 会因此自杀，它自己的 autoRestart 自愈路径永远走不到。
      // 这里失败是预期情况（等下一轮重试即可），只需记录。
      this.connect().catch((error: Error) => {
        if (!this.config.silent) {
          console.error(`[DAEMON-CLIENT] Reconnect attempt failed: ${error.message}`);
        }
        // 连接失败不会有 'connect'/'close' 事件来重新排期，必须在这里续上下一次
        if (this.config.reconnect) {
          this.scheduleReconnect();
        }
      });
    }, this.config.reconnectInterval);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  // Public API
  // timeoutMs 可选：超时则 reject 并中止本次连接尝试。
  // 不传时行为与从前一致（不设上限），避免影响 status / reload / proxy 等既有调用方。
  async connect(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        this.off('connected', onConnect);
        this.off('error', onError);
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.once('connected', onConnect);
      this.once('error', onError);

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          // 中止仍在进行的连接尝试：否则超时后 socket 可能才连上，留下悬挂句柄
          this.socket.destroy();
          reject(new Error(`Connection to daemon timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.socket.connect(this.config.port!, this.config.host!);
    });
  }

  disconnect() {
    this.config.reconnect = false;
    this.clearReconnectTimer();
    // 主动断开同样要了结在途请求：socket.end() 之后不会再有响应，
    // 等待方必须收到明确的失败而不是永久挂起
    this.failPendingRequests(new Error('Disconnected from daemon'));
    this.socket.end();
  }

  // MCP protocol forwarding
  async sendMCPRequest(request: any): Promise<any> {
    // 未连接时必须立刻失败：send() 只是静默丢弃消息，若仍然登记在途请求，
    // 调用方就会一直等到天荒地老（stdio-proxy 用 silent:true，连日志都没有）。
    if (!this.isConnected) {
      throw new Error('Cannot send MCP request: not connected to daemon');
    }

    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.requestCounter}`;
      this.pendingRequests.set(requestId, { resolve, reject });
      
      this.send({
        type: 'mcp-request',
        requestId,
        request
      });
    });
  }

  // Get status
  getStatus(): void {
    this.send({ type: 'get-status' });
  }

  // Get tools list
  getTools(): void {
    this.send({ type: 'get-tools' });
  }

  // Reload configuration
  reloadConfig(): void {
    this.send({ type: 'reload-config' });
  }

  // Request graceful shutdown (daemon runs stop() then exits)
  shutdown(): void {
    this.send({ type: 'shutdown' });
  }

  get connected(): boolean {
    return this.isConnected;
  }
}