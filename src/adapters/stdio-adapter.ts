import spawn from 'cross-spawn';
import { ChildProcess, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { MCPServerConfig, MCPTool, MCPRequest, MCPResponse, ServerAdapter } from '../types/index.js';
import { globalLogManager } from '../logging/server-log-manager.js';
import { decodeChildLine } from '../utils/child-output.js';

export class StdioAdapter extends EventEmitter implements ServerAdapter {
  public readonly name: string;
  public readonly config: MCPServerConfig;
  public isConnected: boolean = false;

  private process?: ChildProcess;
  private requestId: number = 1;
  private pendingRequests: Map<string | number, {
    resolve: (value: MCPResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private buffer: string = '';
  /** stderr 按**字节**缓冲：解码要按行做（见 utils/child-output），不能在 chunk 边界上切 */
  private stderrBytes: Buffer = Buffer.alloc(0);
  /** 最近几行 stderr，用于子进程退出时把「它说了什么」带进失败原因 */
  private recentStderr: string[] = [];
  
  // Process stability monitoring
  private crashCount: number = 0;
  private lastCrashTime: number = 0;
  private isRecovering: boolean = false;
  /** 待执行的自动恢复定时器；必须可取消，否则 disconnect() 后进程仍会被重新拉起 */
  private recoveryTimer?: NodeJS.Timeout;
  /** 是否已放弃恢复（disconnect 时置位）；attemptRecovery 在等待结束后据此退出 */
  private recoveryAborted = false;
  private crashHistory: number[] = []; // Crash time history
  private isBlacklisted: boolean = false; // Whether blacklisted
  private blacklistUntil: number = 0; // Blacklist release time
  private isDisabled: boolean = false; // Whether disabled, should not auto-reconnect if disabled
  private connectingPromise?: Promise<void>; // 进行中的握手：并发调用合流，避免重复 spawn 出多个子进程

  constructor(name: string, config: MCPServerConfig) {
    super();
    this.name = name;
    this.config = config;

    if (config.transport !== 'stdio') {
      throw new Error(`Invalid transport for StdioAdapter: ${config.transport}`);
    }
  }

  /**
   * 子进程是否真的可用。
   * 这是判断连接是否可用的唯一权威依据：`isConnected` 标志位与 `'exit'` 事件之间存在时序窗口
   * （`exitCode` 在 libuv 回调里同步置位，而 `'exit'` 事件要等到 nextTick 才发出），
   * 只凭标志位判断会得到「已连接」的错误结论，进而把请求写进已断开的管道。
   */
  private isProcessAlive(): boolean {
    return !!this.process && !this.process.killed && this.process.exitCode === null && !!this.process.stdin;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      if (this.isProcessAlive()) {
        console.error(`[${this.name}] Already connected, skipping connect() call.`);
        return;
      }
      // 标志位说已连接、进程却已死：复位后按重连处理，否则调用方会误判为重连成功
      const staleMsg = 'Connection flag was stale (process already dead), forcing reconnect';
      console.error(`[${this.name}] ${staleMsg}`);
      globalLogManager.addLog(this.name, 'warn', staleMsg, 'system');
      this.isConnected = false;
      this.cleanup();
    }

    if (this.isDisabled) {
      console.error(`[${this.name}] Adapter is disabled, skipping connect() call.`);
      throw new Error(`Adapter ${this.name} is disabled.`);
    }

    // 显式重新连接（含 enable 后重连）视为恢复意图，清除上一次断开留下的放弃标记
    this.recoveryAborted = false;

    if (this.isBlacklisted) {
      // 先让黑名单有机会过期。checkAndUpdateBlacklist 只在进程退出时被调用，
      // 而黑名单生效期间 connect() 直接抛错、不会有新的退出事件 —— 于是过期判断
      // 永远不会被重新求值，一次拉黑就是整个进程生命周期内永久不可连。
      // 这里在每次连接尝试前复核一次，让「拉黑 N 分钟」真正只是 N 分钟。
      if (Date.now() >= this.blacklistUntil) {
        console.error(`🟢 ${this.name} blacklist expired, allowing reconnection`);
        this.isBlacklisted = false;
        this.blacklistUntil = 0;
        this.crashCount = Math.max(0, this.crashCount - 2);
      } else {
        const remaining = Math.ceil((this.blacklistUntil - Date.now()) / 1000);
        console.error(`[${this.name}] Adapter is blacklisted for ${remaining}s, skipping connect() call.`);
        throw new Error(`Adapter ${this.name} is blacklisted.`);
      }
    }

    if (!this.config.command) {
      throw new Error('Command is required for stdio transport');
    }

    // 并发合流：握手期间 isConnected 仍为 false，多个调用方会同时走到这里。
    // 不加闩会各自 spawn 一个子进程，后一个覆盖 this.process，前一个成为无人回收的孤儿。
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = undefined;
    }
  }

  /** 建立连接并完成 initialize 握手；守卫与并发合流由 connect() 负责 */
  private async doConnect(): Promise<void> {
    // connect() 已校验 command 必存在；取本地引用以便 spawn 处保持 TS 窄化
    const command = this.config.command!;

    try {
      console.error(`[${this.name}] Attempting to connect via stdio: ${command} ${this.config.args?.join(' ') || ''}`);

      // Environment variable debug log
      this.logEnvironmentVariables();

      // Prepare process environment variables
      const processEnv = {
        ...process.env,
        ...this.config.env
      };

      // 使用 cross-spawn 启动子进程。
      // Windows 上全局安装的命令(如 npx/npm/codegraph)实为 .cmd 批处理 shim，
      // 仅靠 Node 原生 spawn(shell:false) 无法解析，会立即 ENOENT 导致进程起不来、
      // initialize 握手超时。cross-spawn 内部会自动经 cmd.exe 解析并正确处理转义，
      // 与官方 @modelcontextprotocol/sdk 的 StdioClientTransport 行为一致。
      const spawnOptions: any = {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.config.cwd,
        env: processEnv,
        // 经 cmd.exe 启动 .cmd shim 时 Windows 默认会弹出可见的 CMD 窗口，
        // 隐藏之；子进程 stdio 均为管道，无需可见控制台。
        windowsHide: true
      };

      // Enhanced stdio handling for high-output processes like playwright
      if (this.name === 'playwright') {
        spawnOptions.detached = false; // Keep attached but in separate session
        // Increase buffer size for high-volume stderr output
        spawnOptions.stdio = ['pipe', 'pipe', 'pipe'];
        console.error(`[${this.name}] Using special spawn options for playwright`);
        
        // Verify critical environment variables are set
        if (processEnv.DEBUG) {
          console.error(`[${this.name}] ✅ DEBUG environment variable set: ${processEnv.DEBUG}`);
        } else {
          console.error(`[${this.name}] ⚠️ DEBUG environment variable not set`);
        }
        
        if (processEnv.PWDEBUG) {
          console.error(`[${this.name}] ✅ PWDEBUG environment variable set`);
        }
      }
      
      this.process = spawn(command, this.config.args || [], spawnOptions);

      this.setupProcessHandlers();
      
      // Initialize handshake
      await this.initialize();
      
      // Mark as connected, let router manage tool list fetching
      this.isConnected = true;
      console.error(`[${this.name}] Connected successfully.`);
      globalLogManager.updateConnectionStatus(this.name, true);
      globalLogManager.addLog(this.name, 'info', `MCP server connected successfully (command: ${this.config.command}, args: ${this.config.args?.join(' ') || 'none'})`, 'system');
      this.emit('connected', { serverName: this.name });

    } catch (error) {
      this.cleanup();
      const errorMsg = `[${this.name}] Failed to connect: ${(error as Error).message}`;
      console.error(errorMsg);
      globalLogManager.updateConnectionStatus(this.name, false, errorMsg);
      throw new Error(errorMsg);
    }
  }

  async disconnect(): Promise<void> {
    // 不能因 !isConnected 就早退：进程退出后、退避重连触发前，
    // isConnected 已是 false，但待执行的恢复定时器仍在，子进程也随时会被重新拉起。
    // 早退会让 disconnect() 什么都没做，随后 attemptRecovery 复活该服务器
    // —— disconnectAll()（MCPDogServer.stop 之外的入口）单独调用时会出现这种情况。
    if (!this.isConnected && !this.process && !this.recoveryTimer && !this.isRecovering) {
      console.error(`[${this.name}] Already disconnected, skipping disconnect() call.`);
      globalLogManager.addLog(this.name, 'warn', 'Disconnect called but server already disconnected', 'system');
      return;
    }

    console.error(`[${this.name}] Attempting to disconnect...`);
    globalLogManager.addLog(this.name, 'info', 'Initiating disconnect...', 'system');
    
    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // 取消待执行的自动恢复，使「已停止」成为稳定状态。
    // 同时置位放弃标记：已经进入 attemptRecovery 且正在等待的那一次也要退出，
    // 否则它会在 1s 等待结束后把子进程重新拉起来。
    this.recoveryAborted = true;
    this.cancelRecovery();

    this.cleanup();
    this.isConnected = false;
    
    console.error(`[${this.name}] Disconnected successfully.`);
    globalLogManager.updateConnectionStatus(this.name, false);
    globalLogManager.addLog(this.name, 'info', 'MCP server disconnected successfully', 'system');
    this.emit('disconnected', { serverName: this.name });
  }

  /** 取消待执行的自动恢复，使「已停止」成为稳定状态 */
  private cancelRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.stdout?.on('data', (data: Buffer) => {
      const stdout = data.toString();
      // Only log non-JSON response messages to log manager, avoid duplication
      const lines = stdout.trim().split('\n');
      const nonJsonLines = lines.filter(line => {
        try {
          JSON.parse(line.trim());
          return false; // This is a JSON message, do not log
        } catch {
          return true; // This is not JSON, log it
        }
      });
      
      if (nonJsonLines.length > 0) {
        globalLogManager.addServerOutput(this.name, nonJsonLines.join('\n'), 'stdout');
        this.emit('log', { stream: 'stdout', data: nonJsonLines.join('\n') });
      }
      
      this.handleStdoutData(stdout);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // 按字节拼接、按行解码：子进程可能是 cmd.exe（OEM/GBK）也可能是 Node 程序（UTF-8），
      // 判定编码需要整行，且不能跨 chunk 切断多字节字符
      this.stderrBytes = Buffer.concat([this.stderrBytes, data]);

      let start = 0;
      let newlineAt: number;
      while ((newlineAt = this.stderrBytes.indexOf(0x0a, start)) >= 0) {
        this.handleStderrLine(this.stderrBytes.subarray(start, newlineAt));
        start = newlineAt + 1;
      }
      // 保留未完成的尾行
      this.stderrBytes = this.stderrBytes.subarray(start);
      // 超长且无换行的输出（如进度条）不能让缓冲无界增长
      if (this.stderrBytes.length > 64 * 1024) {
        this.stderrBytes = this.stderrBytes.subarray(this.stderrBytes.length - 4096);
      }
    });

    this.process.on('error', (error: Error) => {
      console.error(`${this.name} process error:`, error);
      globalLogManager.addLog(this.name, 'error', `Process error: ${error.message}`, 'system');
      this.emit('error', { error, context: `${this.name}-process` });
    });

    // 捕获注册时的进程引用：下面用它判断这个 exit 是否属于「当前这个进程」
    const proc = this.process;
    this.process.on('exit', (code: number | null, signal: string | null) => {
      console.error(`[${this.name}] DEBUG: Process exited with code ${code}, signal ${signal}.`);
      console.error(`[${this.name}] DEBUG: Pending requests at exit: ${this.pendingRequests.size}`);

      // 必须是「当前这个进程」的退出事件，迟到的旧进程 exit 一律忽略 ——
      // 这必须是处理器的**第一件事**，任何对共享状态的改动都要排在它之后。
      //
      // cleanup() 用异步 taskkill / 延迟 SIGKILL 杀旧进程后立刻把 this.process 置空，
      // 而重连只等一小会儿就拉起新进程，所以旧进程的 exit 常常在新进程已经握手到一半
      // 时才送达。此时 pendingRequests 里装的是**新进程**的 initialize 请求：
      // 若先跑「拒绝所有在途请求」，就会用旧进程的退出原因把新连接的握手打断
      // （实测 Linux 上稳定复现：`Pending requests at exit: 1` 出现在本判定之前，
      // 新连接随即以「子进程已退出 (signal=SIGTERM)」失败）。
      // 不校验身份还会顺带把健康的新连接标成断开、发出 disconnected，
      // 并再排一轮恢复把新进程也杀掉：一次「重启该服务器」变成 3 个进程。
      if (this.process !== proc) {
        console.error(`[${this.name}] Ignoring exit from superseded process (pid ${proc.pid})`);
        return;
      }

      globalLogManager.addLog(this.name, 'error', `Process exited with code ${code}, signal ${signal}`, 'system');

      // 立即以「退出码 + 它最后的 stderr」拒绝所有在途请求。
      // 此前不拒绝，它们只能各自等到 30s 超时，失败原因被记成「Request timeout」——
      // 而子进程往往已经说出了真正的原因（例如 cmd 的「系统找不到指定的路径。」），却被淹没。
      const exitReason = this.describeExit(code, signal);
      for (const [id, pending] of Array.from(this.pendingRequests.entries())) {
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error(exitReason));
      }

      // Log crash history
      const now = Date.now();
      this.crashCount++;
      this.lastCrashTime = now;
      this.crashHistory.push(now);
      
      // Only keep crash records for the last 5 minutes
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      this.crashHistory = this.crashHistory.filter(time => time > fiveMinutesAgo);
      
      if (signal === 'SIGKILL') {
        const killMsg = `⚠️  Process was killed with SIGKILL - likely due to internal errors or resource issues. Crash count: ${this.crashCount} (${this.crashHistory.length} in last 5min)`;
        console.error(`[${this.name}] ${killMsg}`);
        globalLogManager.addLog(this.name, 'error', killMsg, 'system');
      }
      
      // Check if blacklisting is needed
      this.checkAndUpdateBlacklist();
      
      this.isConnected = false;
      globalLogManager.updateConnectionStatus(this.name, false, `Process exited: code=${code}, signal=${signal}`);
      this.emit('disconnected', { 
        serverName: this.name,
        error: new Error(`Process exited: code=${code}, signal=${signal}`)
      });
      
      // Smart reconnect strategy
      if (this.shouldAttemptReconnect(signal)) {
        const delay = this.getReconnectDelay();
        const reconnectMsg = `🔄 Will attempt reconnect in ${delay}ms`;
        console.error(`[${this.name}] ${reconnectMsg}`);
        globalLogManager.addLog(this.name, 'info', reconnectMsg, 'system');
        
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = undefined;
          this.attemptRecovery();
        }, delay);
      } else {
        const noReconnectMsg = '🚫 Not attempting reconnect';
        console.error(`[${this.name}] ${noReconnectMsg}`);
        globalLogManager.addLog(this.name, 'warn', noReconnectMsg, 'system');
      }
    });
  }

  /** 处理一行子进程 stderr（原始字节，已按 \n 切好） */
  private handleStderrLine(raw: Buffer): void {
    const stderr = decodeChildLine(raw).replace(/\r$/, '').trim();
    if (!stderr) return;

    this.rememberStderr(stderr);
    console.error(`[${this.name}] DEBUG: STDERR content: ${stderr.substring(0, 200)}`);
    globalLogManager.addServerOutput(this.name, stderr, 'stderr');
    this.emit('log', { stream: 'stderr', data: stderr });

    // Detect browsermcp stack overflow errors
    if (stderr.includes('Maximum call stack size exceeded') || stderr.includes('RangeError')) {
      console.error(`⚠️ ${this.name} detected stack overflow, will auto-restart on next request`);
      globalLogManager.addLog(this.name, 'warn', 'Stack overflow detected, will auto-restart on next request', 'system');
    }
  }

  /** 记住最近几行 stderr，供子进程退出时说明「它到底说了什么」 */
  private rememberStderr(line: string): void {
    this.recentStderr.push(line);
    if (this.recentStderr.length > 10) this.recentStderr.shift();
  }

  /**
   * 子进程退出时的失败原因：带退出码与它最后的 stderr。
   * 只报「请求超时」会把最直接的证据淹掉 —— 子进程往往已经说出了真正的原因。
   */
  private describeExit(code: number | null, signal: string | null): string {
    const base = `子进程已退出 (code=${code}, signal=${signal})`;
    if (this.recentStderr.length === 0) return base;
    return `${base}；最后的 stderr：${this.recentStderr.slice(-3).join(' | ')}`;
  }

  private handleStdoutData(data: string): void {
    console.error(`[${this.name}] DEBUG: Received stdout data - length: ${data.length}`);
    this.buffer += data;
    
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep the last incomplete line
    console.error(`[${this.name}] DEBUG: Split into ${lines.length} lines, buffer remaining: ${this.buffer.length}`);

    for (const line of lines) {
      if (line.trim()) {
        console.error(`[${this.name}] DEBUG: Processing line length: ${line.length}`);
        try {
          const message = JSON.parse(line);
          console.error(`[${this.name}] DEBUG: Parsed message - id: ${message.id}, method: ${message.method}`);
          this.handleMessage(message);
        } catch (error) {
          console.error(`Failed to parse message from ${this.name}:`, line);
        }
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id && this.pendingRequests.has(message.id)) {
      // This is a response to a request
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      
      // Log response details (but not the raw JSON)
      if (message.error) {
        globalLogManager.addLog(this.name, 'error', `Method response error (ID: ${message.id}): ${JSON.stringify(message.error)}`, 'system');
      } else {
        globalLogManager.addLog(this.name, 'info', `Method response success (ID: ${message.id}): ${message.result ? 'with result' : 'no result'}`, 'system');
      }
      
      pending.resolve(message as MCPResponse);
    } else if (!message.id && message.method) {
      // This is a notification
      this.handleNotification(message);
    }
  }

  private handleNotification(notification: any): void {
    console.error(`Notification from ${this.name}:`, notification.method);
    globalLogManager.addLog(this.name, 'info', `Notification received: ${notification.method}`, 'system');
    
    if (notification.method === 'notifications/tools/list_changed') {
      // Tool list changed, notify router for unified handling
      globalLogManager.addLog(this.name, 'info', 'Tools list changed, notifying router', 'system');
      this.emit('tools-changed', { serverName: this.name });
    }
    
    // Forward notification to upper layer
    this.emit('notification', { serverName: this.name, notification });
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

    // 握手期间不做「死进程重连」：initialize 是在 connect()/doConnect() 内部调用的，
    // 若此处再走重连分支会递归回 connect()，加了并发闩后会 await 到自己而死锁。
    const response = await this.sendRequest(initRequest, { reconnect: false });
    
    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    // Send initialized notification
    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };

    this.sendNotification(initializedNotification);
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
    const startTime = Date.now();
    globalLogManager.addLog(this.name, 'info', `Calling tool: ${name}`, 'system');
    
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    };

    try {
      const response = await this.sendRequest(request);
      const duration = Date.now() - startTime;
      
      if (response.error) {
        globalLogManager.addLog(this.name, 'error', `Tool call failed: ${name} (duration: ${duration}ms, error: ${JSON.stringify(response.error)})`, 'system');
      } else {
        globalLogManager.addLog(this.name, 'info', `Tool call successful: ${name} (duration: ${duration}ms)`, 'system');
        if (response.result?.content) {
          // Log content summary without serializing large content to avoid blocking
          const contentCount = Array.isArray(response.result.content) ? response.result.content.length : 1;
          globalLogManager.addLog(this.name, 'debug', `Tool result: ${contentCount} content item(s)`, 'system');
        }
      }
      
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      globalLogManager.addLog(this.name, 'error', `Tool call exception: ${name} (duration: ${duration}ms, error: ${(error as Error).message})`, 'system');
      throw error;
    }
  }

  /**
   * 发送请求。
   * @param options.reconnect 进程已死时是否尝试重连，默认 true。
   *   initialize 握手内部必须传 false —— 它本身就在 connect() 内部执行，
   *   再走重连分支会递归回 connect()（加了并发闩后会 await 到自己而死锁）。
   */
  async sendRequest(request: MCPRequest, options: { reconnect?: boolean } = {}): Promise<MCPResponse> {
    // Add detailed debug logging for troubleshooting
    console.error(`[${this.name}] DEBUG: sendRequest called - method: ${request.method}, id: ${request.id}`);
    globalLogManager.addLog(this.name, 'info', `DEBUG: Sending request ${request.method} (ID: ${request.id})`, 'system');

    // Check process status, try to reconnect if dead
    if (options.reconnect !== false && !this.isProcessAlive()) {
      console.error(`${this.name} process is dead, attempting reconnection...`);
      globalLogManager.addLog(this.name, 'warn', 'Process is dead, attempting reconnection...', 'system');
      try {
        await this.connect();
      } catch (error) {
        const errorMsg = `Failed to reconnect to ${this.name}: ${(error as Error).message}`;
        globalLogManager.addLog(this.name, 'error', errorMsg, 'system');
        throw new Error(errorMsg);
      }
      // connect() 在标志位为真时可能直接返回，因此必须复核进程是否真的可用；
      // 否则「重连成功」是假的，请求会被写进已断开的管道，直到 30s 超时才失败。
      if (!this.isProcessAlive()) {
        const errorMsg = `Failed to reconnect to ${this.name}: process is still unavailable after reconnect attempt`;
        globalLogManager.addLog(this.name, 'error', errorMsg, 'system');
        throw new Error(errorMsg);
      }
      globalLogManager.addLog(this.name, 'info', 'Reconnection successful', 'system');
    }

    if (!this.isProcessAlive()) {
      const errorMsg = `Not connected to ${this.name}`;
      globalLogManager.addLog(this.name, 'error', errorMsg, 'system');
      throw new Error(errorMsg);
    }

    const startTime = Date.now();
    return new Promise<MCPResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        const timeoutMsg = `Request timeout for ${this.name} (method: ${request.method}, timeout: ${this.config.timeout || 30000}ms)`;
        globalLogManager.addLog(this.name, 'error', timeoutMsg, 'system');
        reject(new Error(timeoutMsg));
      }, this.config.timeout || 30000);

      this.pendingRequests.set(request.id, {
        resolve: (response: MCPResponse) => {
          // Skip debug logging in resolve
          resolve(response);
        },
        reject: (error: Error) => {
          const duration = Date.now() - startTime;
          globalLogManager.addLog(this.name, 'error', `Request failed: ${request.method} (ID: ${request.id}, duration: ${duration}ms, error: ${error.message})`, 'system');
          reject(error);
        },
        timeout
      });

      try {
        const requestStr = JSON.stringify(request) + '\n';
        this.writeToStdin(requestStr, (writeError) => {
          // 写入失败（进程刚死，异步 EPIPE）：了结这个请求，不要把错误抛到进程级。
          // stdin 是独立于 child_process 的 socket，它的 'error' 事件不挂监听
          // 就会成为 uncaughtException —— 而 CLI 的 handler 是 process.exit(1)，
          // 一个下游进程死掉会把整个 daemon 连同所有会话一起带走。
          this.pendingRequests.delete(request.id);
          clearTimeout(timeout);
          const errorMsg = `Failed to write to ${this.name}: ${writeError.message}`;
          globalLogManager.addLog(this.name, 'error', errorMsg, 'system');
          reject(new Error(errorMsg));
        });
      } catch (error) {
        this.pendingRequests.delete(request.id);
        clearTimeout(timeout);
        const errorMsg = `Failed to send request to ${this.name}: ${(error as Error).message}`;
        globalLogManager.addLog(this.name, 'error', errorMsg, 'system');
        reject(new Error(errorMsg));
      }
    });
  }

  /**
   * 向子进程 stdin 写一行，失败时回调而不是抛出。
   *
   * stdin.write 的错误是**异步**通过 'error' 事件到达的（EPIPE/ERR_STREAM_DESTROYED），
   * try/catch 只能接住同步抛错。这里挂一次性监听把失败交回调用方，
   * 避免它变成无人处理的 'error' 事件导致整个进程退出。
   */
  private writeToStdin(data: string, onError: (error: Error) => void): void {
    const stdin: any = this.process?.stdin;
    if (!stdin) {
      onError(new Error('stdin is not available'));
      return;
    }

    // 某些测试替身给的是只有 write 的普通对象；没有事件接口时退化为直接写
    if (typeof stdin.once !== 'function' || typeof stdin.off !== 'function') {
      try {
        stdin.write(data);
      } catch (error) {
        onError(error as Error);
      }
      return;
    }

    const handleError = (error: Error) => {
      stdin.off('error', handleError);
      onError(error);
    };
    stdin.once('error', handleError);

    try {
      stdin.write(data, () => {
        // 写入成功：摘掉监听，避免长期累积
        stdin.off('error', handleError);
      });
    } catch (error) {
      stdin.off('error', handleError);
      onError(error as Error);
    }
  }

  private sendNotification(notification: any): void {
    // 判据用「子进程是否真的可写」而不是 isConnected：握手期的
    // notifications/initialized 必须在 isConnected 置位**之前**发出
    // （initialize() 在 doConnect() 里、isConnected = true 之前调用它），
    // 用 isConnected 判断会把这条通知静默丢掉，下游等不到 initialized。
    // 这与两个 HTTP 适配器的处理保持一致。
    if (!this.process?.stdin || this.process.killed || this.process.exitCode !== null) {
      return;
    }

    try {
      const notificationStr = JSON.stringify(notification) + '\n';
      this.process.stdin.write(notificationStr);
    } catch (error) {
      console.error(`Failed to send notification to ${this.name}:`, error);
    }
  }

  private getNextRequestId(): number {
    return this.requestId++;
  }

  private cleanup(): void {
    // 必须捕获当前进程引用：延迟强杀的定时器读的是闭包里的这个对象，
    // 若读 this.process，2 秒内若已完成重连就会把「新进程」SIGKILL 掉
    // （生产日志里「刚 spawn 就被 SIGKILL」正是这个原因）。
    const target = this.process;
    if (target) {
      try {
        if (process.platform === 'win32' && target.pid) {
          // Windows 上必须按「进程树」杀。
          // 全局安装的 npx/npm 型子服务器经 cmd.exe shim 启动，this.process 是 cmd.exe，
          // 真正的 MCP 服务进程是它的子进程 —— 只 kill cmd.exe 会把子进程留成孤儿
          // （实测 shim 已死、node 子进程在 1s/3s/6s 后仍在运行）。
          // taskkill 不带 /T 同样只杀一个进程，故这里必须带 /T。
          execFile('taskkill', ['/T', '/F', '/PID', String(target.pid)], (error) => {
            if (error) {
              console.error(`Failed to taskkill process tree for ${this.name}:`, error.message);
            }
          });
        } else if (!target.killed) {
          target.kill('SIGTERM');
        }

        // If process does not end within 2 seconds, force kill
        setTimeout(() => {
          if (!target.killed) {
            target.kill('SIGKILL');
          }
        }, 2000);
      } catch (error) {
        console.error(`Error killing process for ${this.name}:`, error);
      }

      this.process = undefined;
    }

    this.buffer = '';
    // stderr 状态必须一起清：否则上一个进程的残行会被算进下一次崩溃的失败原因里
    this.stderrBytes = Buffer.alloc(0);
    this.recentStderr = [];
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
    crashCount: number;
    recentCrashes: number;
    isBlacklisted: boolean;
    blacklistRemaining?: number;
  } {
    const now = Date.now();
    return {
      name: this.name,
      connected: this.isConnected,
      toolCount: 0, // Tool count managed by router
      pendingRequests: this.pendingRequests.size,
      crashCount: this.crashCount,
      recentCrashes: this.crashHistory.length,
      isBlacklisted: this.isBlacklisted,
      blacklistRemaining: this.isBlacklisted ? Math.max(0, this.blacklistUntil - now) : undefined
    };
  }

  // Manually clear blacklist (admin function)
  clearBlacklist(): void {
    if (this.isBlacklisted) {
      console.error(`🟢 Manually clearing blacklist for ${this.name}`);
      this.isBlacklisted = false;
      this.blacklistUntil = 0;
      this.crashCount = 0;
      this.crashHistory = [];
    }
  }

  // Get crash statistics
  getCrashStats(): {
    totalCrashes: number;
    recentCrashes: number;
    crashHistory: string[];
    isBlacklisted: boolean;
    nextAttemptIn?: number;
  } {
    const now = Date.now();
    return {
      totalCrashes: this.crashCount,
      recentCrashes: this.crashHistory.length,
      crashHistory: this.crashHistory.map(time => new Date(time).toISOString()),
      isBlacklisted: this.isBlacklisted,
      nextAttemptIn: this.isBlacklisted ? Math.max(0, this.blacklistUntil - now) : undefined
    };
  }

  // Check and update blacklist status
  private checkAndUpdateBlacklist(): void {
    const now = Date.now();
    
    // Check if blacklisted and time not yet reached
    if (this.isBlacklisted && now < this.blacklistUntil) {
      return;
    }
    
    // If blacklist time has passed, remove from blacklist
    if (this.isBlacklisted && now >= this.blacklistUntil) {
      console.error(`🟢 ${this.name} removed from blacklist, allowing reconnection`);
      this.isBlacklisted = false;
      this.blacklistUntil = 0;
      // Reset some statistics
      this.crashCount = Math.max(0, this.crashCount - 2);
    }
    
    // Check if blacklisting is needed
    const recentCrashes = this.crashHistory.length;
    
    if (recentCrashes >= 5) {
      // More than 5 crashes in 5 minutes, blacklist for 30 minutes
      this.isBlacklisted = true;
      this.blacklistUntil = now + 30 * 60 * 1000; // 30 minutes
      console.error(`🔴 ${this.name} blacklisted for 30 minutes due to ${recentCrashes} crashes in 5 minutes`);
    } else if (recentCrashes >= 3) {
      // More than 3 crashes in 5 minutes, blacklist for 10 minutes
      this.isBlacklisted = true;
      this.blacklistUntil = now + 10 * 60 * 1000; // 10 minutes
      console.error(`🟡 ${this.name} blacklisted for 10 minutes due to ${recentCrashes} crashes in 5 minutes`);
    }
  }

  // Smart reconnect strategy
  private shouldAttemptReconnect(signal: string | null): boolean {
    // If server is disabled, should not auto-reconnect
    if (this.isDisabled) {
      console.error(`❌ ${this.name} is disabled, no auto-reconnect`);
      return false;
    }

    // If already recovering, do not try again
    if (this.isRecovering) {
      return false;
    }

    // Check blacklist status
    const now = Date.now();
    if (this.isBlacklisted && now < this.blacklistUntil) {
      const remainingMinutes = Math.ceil((this.blacklistUntil - now) / (60 * 1000));
      console.error(`❌ ${this.name} is blacklisted for ${remainingMinutes} more minutes, no auto-reconnect`);
      return false;
    }

    // If recent crashes are too frequent, be cautious even if not blacklisted
    if (this.crashHistory.length >= 2) {
      const lastTwoCrashes = this.crashHistory.slice(-2);
      const timeBetweenCrashes = lastTwoCrashes[1] - lastTwoCrashes[0];
      
      // If two crashes are less than 30 seconds apart, pause reconnect
      if (timeBetweenCrashes < 30 * 1000) {
        console.error(`⏸️ ${this.name} crashing too quickly (${Math.round(timeBetweenCrashes/1000)}s apart), pausing auto-reconnect`);
        return false;
      }
    }

    // Only SIGKILL or other abnormal exits require reconnect
    return signal === 'SIGKILL' || signal === 'SIGTERM' || signal === null;
  }

  private getReconnectDelay(): number {
    // Adjust delay strategy based on crash history
    const recentCrashes = this.crashHistory.length;
    const baseDelay = 2000; // 2 second base delay
    
    let delay = baseDelay;
    
    // Adjust delay based on recent crash count
    if (recentCrashes >= 4) {
      delay = 60000; // 1 minute
    } else if (recentCrashes >= 3) {
      delay = 30000; // 30 seconds
    } else if (recentCrashes >= 2) {
      delay = 10000; // 10 seconds
    } else {
              delay = baseDelay; // 2 seconds
    }
    
    // If frequent crashes, add random delay to avoid thundering herd effect
    if (recentCrashes >= 2) {
      const randomDelay = Math.random() * delay * 0.5; // 0-50% random delay
      delay += randomDelay;
    }
    
    return Math.round(delay);
  }

  private async attemptRecovery(): Promise<void> {
    if (this.isRecovering || this.isConnected) {
      return;
    }

    this.isRecovering = true;
    console.error(`🔧 ${this.name} attempting recovery (attempt ${this.crashCount})`);

    try {
      // Clean up old state
      this.cleanup();
      
      // Wait a bit for system resources to be released
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 等待期间可能已被 disconnect()（停机）或 disable()（移除适配器）：
      // 这时必须放弃本次恢复，否则会在断开之后把子进程重新拉起来，
      // 「已停止」就不再是稳定状态（子进程与事件监听都成了孤儿）。
      if (this.isDisabled || this.recoveryAborted) {
        console.error(`🚫 ${this.name} recovery aborted (disabled or disconnected)`);
        return;
      }

      // Try to reconnect
      await this.connect();
      
      console.error(`✅ ${this.name} recovered successfully`);
      
      // Reset crash counter (after successful connection)
      if (this.isConnected) {
        this.crashCount = Math.max(0, this.crashCount - 1);
      }
      
    } catch (error) {
      console.error(`❌ ${this.name} recovery failed:`, (error as Error).message);
    } finally {
      this.isRecovering = false;
    }
  }

  // Manually trigger recovery (for external calls)
  async forceReconnect(): Promise<void> {
    console.error(`🔄 Force reconnecting ${this.name}...`);
    this.crashCount = 0; // Reset counter
    await this.disconnect();
    // disconnect() 会置位 recoveryAborted（那是为了阻止「停机后又被自动恢复拉起来」），
    // 但本方法的语义是「主动重连」，必须清掉它，否则 attemptRecovery 会在
    // `if (this.isDisabled || this.recoveryAborted) return` 处直接放弃 ——
    // forceReconnect 变成静默空操作，进程不会被重新拉起。
    this.recoveryAborted = false;
    await this.attemptRecovery();
  }

  // Disable adapter, prevent auto-reconnect
  disable(): void {
    console.error(`🚫 Disabling ${this.name} - no auto-reconnect`);
    this.isDisabled = true;
  }

  // Re-enable adapter, allow auto-reconnect
  enable(): void {
    console.error(`✅ Enabling ${this.name} - auto-reconnect allowed`);
    this.isDisabled = false;
  }

  /**
   * Log environment variable debug information
   */
  private logEnvironmentVariables(): void {
    const configEnv = this.config.env;
    
    if (!configEnv || Object.keys(configEnv).length === 0) {
      console.error(`[${this.name}] 🔧 No custom environment variables configured`);
      return;
    }

    console.error(`[${this.name}] 🔧 Environment Variables Configuration:`);
    
    // Statistics
    const envKeys = Object.keys(configEnv);
    console.error(`[${this.name}] 📊 Total custom environment variables: ${envKeys.length}`);
    
    // Detailed log (safely, without showing sensitive values)
    envKeys.forEach(key => {
      const value = configEnv[key];
      const isSensitive = this.isSensitiveEnvVar(key);
      
      if (isSensitive) {
        console.error(`[${this.name}] 🔐 ${key}=[REDACTED] (${value.length} chars, sensitive)`);
      } else {
        // For non-sensitive variables, also limit display length
        const displayValue = value.length > 50 ? `${value.substring(0, 47)}...` : value;
        console.error(`[${this.name}] 🔧 ${key}=${displayValue}`);
      }
    });

    // Environment variable override check
    const systemEnvKeys = Object.keys(process.env);
    const overriddenKeys = envKeys.filter(key => systemEnvKeys.includes(key));
    
    if (overriddenKeys.length > 0) {
      console.error(`[${this.name}] ⚠️  Overriding ${overriddenKeys.length} system environment variables: ${overriddenKeys.join(', ')}`);
    }

    // Working directory information
    if (this.config.cwd) {
      console.error(`[${this.name}] 📁 Working directory: ${this.config.cwd}`);
    } else {
      console.error(`[${this.name}] 📁 Working directory: ${process.cwd()} (default)`);
    }
  }

  /**
   * Check if environment variable is sensitive
   */
  private isSensitiveEnvVar(key: string): boolean {
    const sensitiveKeywords = [
      'password', 'secret', 'key', 'token', 'auth', 'credential', 
      'pass', 'pwd', 'private', 'sensitive', 'security', 'api_key',
      'access_token', 'refresh_token', 'jwt', 'session'
    ];
    
    const lowerKey = key.toLowerCase();
    return sensitiveKeywords.some(keyword => lowerKey.includes(keyword));
  }
}