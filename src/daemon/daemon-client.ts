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
  private pendingRequests = new Map<string, (response: any) => void>();
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
          responseCallback(message.response);
          this.pendingRequests.delete(message.requestId);
        }
        break;

      case 'mcp-error':
        // MCP request error
        const errorCallback = this.pendingRequests.get(message.requestId);
        if (errorCallback) {
          errorCallback({ error: message.error });
          this.pendingRequests.delete(message.requestId);
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

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    if (!this.config.silent) {
      console.log(`[DAEMON-CLIENT] Scheduling reconnect in ${this.config.reconnectInterval}ms`);
    }
    this.reconnectTimer = setTimeout(() => {
      if (!this.config.silent) {
        console.log('[DAEMON-CLIENT] Attempting to reconnect...');
      }
      this.connect();
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
    this.socket.end();
  }

  // MCP protocol forwarding
  async sendMCPRequest(request: any): Promise<any> {
    return new Promise((resolve) => {
      const requestId = `req_${++this.requestCounter}`;
      this.pendingRequests.set(requestId, resolve);
      
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