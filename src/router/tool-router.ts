import { EventEmitter } from 'events';
import { MCPTool, MCPRequest, MCPResponse, ServerAdapter, MCPServerConfig } from '../types/index.js';
import { ConfigManager } from '../config/config-manager.js';

export interface ToolRoute {
  toolName: string;
  serverName: string;
  adapter: ServerAdapter;
  /**
   * 下游服务器上该工具的真实名字。
   *
   * 必须显式记录，不能在调用时按 `serverName-` 前缀反推：服务器 `files` 若有名为
   * `files-read` 的真实工具（未发生冲突、路由键就是它自己），反推会把名字改成 `read`
   * 再发出去 —— 若该服务器恰好也有 `read`，就会以调用方的参数静默执行另一个工具。
   */
  originalToolName: string;
}

export class ToolRouter extends EventEmitter {
  private adapters: Map<string, ServerAdapter> = new Map();
  private toolRoutes: Map<string, ToolRoute> = new Map();
  private toolsByServer: Map<string, MCPTool[]> = new Map();
  private lastStableToolsList: MCPTool[] = []; // Cache the last stable tool list
  private lastStableToolsCount: number = 0;
  private configManager?: ConfigManager;

  constructor(configManager?: ConfigManager) {
    super();
    this.configManager = configManager;
  }

  // Check if tool is enabled
  private isToolEnabled(serverName: string, toolName: string): boolean {
    if (!this.configManager) return true; // If no config manager, default to enabled
    
    const config = this.configManager.getConfig();
    const serverConfig = config.servers[serverName];
    if (!serverConfig) return true;
    
    const toolsConfig = serverConfig.toolsConfig;
    if (!toolsConfig) return true; // No tool config, default to enabled

    const { mode, enabledTools, disabledTools, toolSettings } = toolsConfig;

    // 显式逐工具开关优先：tools/toggle 写的就是它，用户的手动选择不能被模式默认值盖掉
    const toolSetting = toolSettings?.[toolName];
    if (toolSetting !== undefined) {
      return toolSetting.enabled;
    }

    // 判定必须与 DaemonWebServer.isToolEnabled（界面据它显示勾选状态）完全一致，
    // 否则会出现「界面显示启用、客户端拿不到工具」（此前本方法只认 toolSettings，
    // 而界面还会看 enabledTools/disabledTools，两边语义不同）。
    switch (mode) {
      case 'all':
        return true;
      case 'whitelist':
        return enabledTools ? enabledTools.includes(toolName) : false;
      case 'blacklist':
        return disabledTools ? !disabledTools.includes(toolName) : true;
      default:
        return true;
    }
  }

  addAdapter(adapter: ServerAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter ${adapter.name} already exists`);
    }

    this.adapters.set(adapter.name, adapter);
    
    // Listen for adapter events
    adapter.on('connected', () => {
      this.refreshToolRoutes(adapter.name).catch(error => {
        console.error(`Failed to refresh routes for ${adapter.name}:`, error);
      });
    });

    adapter.on('disconnected', () => {
      // 刻意**不**清工具缓存。
      //
      // 路由键（是否带 serverName- 前缀）取决于「哪些服务器提供了同名工具」，
      // 而这个集合来自 toolsByServer。若在掉线时清掉缓存，另一个服务器的同名工具
      // 会立刻从 `alpha-x` 变回裸名 `x`，重连成功后又变回去 —— 客户端手里那个名字
      // 在窗口内失效（Tool not found），而 SSE 重连退避默认 5s，窗口并不短。
      //
      // 隐藏「已断线服务器的工具」不靠这里：getAllTools 只遍历 connectedAdapters，
      // callTool 也会对未连接的 adapter 回 Server not connected。
      // 只有服务器真的被移除（配置变更/停用）时才清缓存 —— 见 removeAdapter。
      this.emit('routes-updated', { serverName: adapter.name, toolCount: 0 });
    });

    adapter.on('tools-changed', () => {
      this.refreshToolRoutes(adapter.name).catch(error => {
        console.error(`Failed to refresh routes for ${adapter.name}:`, error);
      });
    });

    console.error(`Added adapter: ${adapter.name}`);
  }

  /**
   * 移除全部 adapter（停服用）。
   *
   * MCPDogServer.stop() 必须调用它：只 disconnect 不移除，会让后续 start() 在
   * addAdapter 处撞上 "already exists"，新配置的 adapter 被丢弃。
   */
  removeAllAdapters(): void {
    for (const serverName of Array.from(this.adapters.keys())) {
      this.removeAdapter(serverName);
    }
  }

  removeAdapter(serverName: string): void {
    const adapter = this.adapters.get(serverName);
    if (!adapter) {
      return;
    }

    // Remove all related routes
    this.removeToolRoutes(serverName);

    // 先 disconnect 再 disable：disable() 会立刻把 isConnected 置 false，
    // 而 disconnect() 的早退守卫看的正是这个标志 —— 顺序反了会让在途请求
    // 得不到「Connection closed」，只能各自等满请求超时（实测 0.3s → 6s）。
    adapter.disconnect().catch(error => {
      console.error(`Error disconnecting ${serverName}:`, error);
    });

    // Disable adapter to prevent auto-reconnect（放在 disconnect 之后）
    if ('disable' in adapter && typeof adapter.disable === 'function') {
      (adapter as any).disable();
    }

    // Remove event listeners
    adapter.removeAllListeners();

    this.adapters.delete(serverName);
    console.error(`Removed adapter: ${serverName}`);
  }

  getAdapter(serverName: string): ServerAdapter | undefined {
    return this.adapters.get(serverName);
  }  getAllAdapters(): ServerAdapter[] {
    return Array.from(this.adapters.values());
  }

  getConnectedAdapters(): ServerAdapter[] {
    return Array.from(this.adapters.values()).filter(adapter => adapter.isConnected);
  }

  /**
   * 计算某个工具对外的路由键：跨服务器重名时统一加 `serverName-` 前缀。
   *
   * 两个关键点：
   * 1) 判据是「所有服务器里有多少个同名工具」，而不是「当前路由表里有没有」。
   *    此前 refreshToolRoutes 用「先到者占裸名、后来者改名」，而 getAllTools 用跨服务器
   *    计数，两套规则不一致会产生重名条目与不可达的工具（见下面 refreshToolRoutes 注释）。
   * 2) 名字本身就以 `serverName-` 开头时也要参与前缀化，避免加完前缀后与别的工具撞车。
   */
  private buildRouteKey(serverName: string, originalToolName: string, nameCounts: Map<string, number>): string {
    const count = nameCounts.get(originalToolName) ?? 0;
    return count > 1 ? `${serverName}-${originalToolName}` : originalToolName;
  }

  /** 统计每个工具名出现在多少个服务器上（同一服务器内的重复名只算一次） */
  private countToolNamesAcrossServers(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const tools of this.toolsByServer.values()) {
      const seenInThisServer = new Set<string>();
      for (const tool of tools) {
        if (seenInThisServer.has(tool.name)) continue;
        seenInThisServer.add(tool.name);
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * 重建全部路由键。
   *
   * 必须整体重建而不是在单个 server 刷新时局部推论：某个服务器新增/减少工具会改变
   * 「是否重名」的判断，从而改变**其他**服务器的路由键（裸名 ↔ 带前缀）。
   * 局部更新会让路由键与 getAllTools 展示的名字对不上，客户端拿到名字却调不通。
   */
  /**
   * 为所有已缓存工具分配对外路由键，返回 `serverName -> originalToolName -> routeKey`。
   *
   * 这是**唯一**的命名来源：rebuildToolRoutes（路由）与 getAllTools（展示给客户端）
   * 都从这里取名字，两者不可能再分叉。
   *
   * 取名规则与冲突处理：
   * - 跨服务器重名的工具加 `serverName-` 前缀（避免客户端看到两个同名工具）。
   * - 不重名的直接用裸名 —— 但若该裸名已被抢占（某服务器的工具名恰好等于
   *   另一服务器前缀化后的结果，如 A 有 `B-x` 而 B 有 `x`），则继续追加前缀直到唯一。
   *   必须继续追加而不能丢弃：丢弃会让某个工具彻底不可达且只有一行日志。
   *
   * 结果必须**只取决于「服务器名 → 工具名集合」，与工具出现顺序无关**：
   * 下游 tools/list 的顺序变化（同一批工具换个次序）绝不能导致路由键互换 ——
   * 那会让客户端手里的名字在两次刷新之间指向不同的下游工具（静默误执行）。
   * 因此这里先把所有候选按 (serverName, toolName) 排序后统一分配，
   * 且「抢裸名」的优先级也由排序决定，而不是由下游给的先后决定。
   */
  private allocateRouteKeys(): Map<string, Map<string, string>> {
    const nameCounts = this.countToolNamesAcrossServers();
    const allocation = new Map<string, Map<string, string>>();
    const taken = new Set<string>();

    const serverNames = Array.from(this.toolsByServer.keys()).sort();

    // 先收集并排序所有候选，消除下游顺序的影响
    const candidates: Array<{ serverName: string; toolName: string }> = [];
    for (const serverName of serverNames) {
      const tools = this.toolsByServer.get(serverName) ?? [];
      const seenInServer = new Set<string>();
      const names: string[] = [];
      for (const tool of tools) {
        if (seenInServer.has(tool.name)) {
          // 同一服务器内工具名本应唯一；若下游给了重复名，保留先出现的并明确报告
          console.warn(
            `Duplicate tool name within server ${serverName}: ${tool.name} — keeping the first occurrence`
          );
          continue;
        }
        seenInServer.add(tool.name);
        names.push(tool.name);
      }
      names.sort();
      for (const toolName of names) {
        candidates.push({ serverName, toolName });
      }
    }

    // 两轮分配，保证「裸名优先给本来就用裸名的工具」这一优先级与顺序无关：
    // 第一轮只分配 buildRouteKey 给出的首选名，第二轮处理落选者（追加前缀直到唯一）。
    const pending: Array<{ serverName: string; toolName: string; candidate: string }> = [];
    for (const { serverName, toolName } of candidates) {
      const preferred = this.buildRouteKey(serverName, toolName, nameCounts);
      if (!taken.has(preferred)) {
        taken.add(preferred);
        this.setAllocation(allocation, serverName, toolName, preferred);
      } else {
        pending.push({ serverName, toolName, candidate: preferred });
      }
    }

    for (const { serverName, toolName, candidate } of pending) {
      let resolved = candidate;
      // 被占用时不断追加服务器前缀，直到唯一（极端但必须处理，否则工具不可达）
      while (taken.has(resolved)) {
        resolved = `${serverName}-${resolved}`;
      }
      taken.add(resolved);
      this.setAllocation(allocation, serverName, toolName, resolved);
      console.warn(
        `Tool name collision on "${candidate}" for ${serverName}/${toolName}, assigned "${resolved}"`
      );
    }

    return allocation;
  }

  private setAllocation(
    allocation: Map<string, Map<string, string>>,
    serverName: string,
    toolName: string,
    routeKey: string
  ): void {
    let perServer = allocation.get(serverName);
    if (!perServer) {
      perServer = new Map<string, string>();
      allocation.set(serverName, perServer);
    }
    perServer.set(toolName, routeKey);
  }

  private rebuildToolRoutes(): void {
    this.toolRoutes.clear();
    const allocation = this.allocateRouteKeys();

    for (const [serverName, perServer] of allocation) {
      const adapter = this.adapters.get(serverName);
      if (!adapter) continue;

      for (const [originalToolName, routeKey] of perServer) {
        this.toolRoutes.set(routeKey, {
          toolName: routeKey,
          serverName,
          adapter,
          originalToolName
        });
      }
    }
  }

  private async refreshToolRoutes(serverName: string): Promise<void> {
    const adapter = this.adapters.get(serverName);
    if (!adapter || !adapter.isConnected) {
      return;
    }

    try {
      // Get server's tool list
      const tools = await adapter.getTools();

      // Cache tool list
      this.toolsByServer.set(serverName, tools);

      // 路由键依赖「跨服务器是否重名」，必须整体重建（见 rebuildToolRoutes 注释）
      this.rebuildToolRoutes();

      console.error(`Refreshed ${tools.length} tool routes for ${serverName}`);
      this.emit('routes-updated', { serverName, toolCount: tools.length });

    } catch (error) {
      console.error(`Failed to refresh tool routes for ${serverName}:`, error);
      this.emit('error', { 
        error: error as Error, 
        context: `refresh-routes-${serverName}` 
      });
    }
  }

  private removeToolRoutes(serverName: string): void {
    const hadRoutes = Array.from(this.toolRoutes.values()).some(
      (route) => route.serverName === serverName
    );

    // Clear cache
    this.toolsByServer.delete(serverName);

    // 整体重建而非只删该 server 的条目：它的消失会改变「跨服务器是否重名」，
    // 其他 server 的路由键可能要从带前缀变回裸名（或反之）。
    // 此前只删自己，别人的键就留在旧形态上，与 getAllTools 展示的名字不一致。
    this.rebuildToolRoutes();

    if (hadRoutes) {
      console.error(`Removed tool routes for ${serverName}`);
      this.emit('routes-updated', { serverName, toolCount: 0 });
    }
  }

  async getAllTools(forceRefresh: boolean = false): Promise<MCPTool[]> {
    const connectedAdapters = this.getConnectedAdapters();

    // If no adapters are connected, return empty tool list (security fix)
    if (connectedAdapters.length === 0) {
      console.error(`📦 No adapters connected, returning empty tools list for security`);
      // Clear stable tool cache to ensure disabled tools are not leaked
      this.lastStableToolsList = [];
      this.lastStableToolsCount = 0;
      return [];
    }

    // Step 1: Collect tools from all servers, with server info
    const allServerTools: Array<{tool: MCPTool, serverName: string}> = [];

    // 实时拉取并行执行：串行逐个 await 时，多个慢/半死 server 的 8s 超时会累计，
    // 导致 tools/list 总耗时突破客户端 30s 连接超时
    const staleAdapters = connectedAdapters.filter(adapter =>
      forceRefresh || (this.toolsByServer.get(adapter.name)?.length ?? 0) === 0
    );

    if (staleAdapters.length > 0) {
      console.error(`Real-time fetching tools from ${staleAdapters.length} servers in parallel...`);
      const fetchTimeoutMs = 8000;
      const results = await Promise.allSettled(staleAdapters.map(async adapter => {
        const freshTools = await Promise.race([
          adapter.getTools(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), fetchTimeoutMs)
          )
        ]);
        return { adapter, freshTools };
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { adapter, freshTools } = result.value;
          // 空清单也要缓存：下游答了 tools/list 且就是 []，说明它的工具被删光了。
          // 此前 `length > 0` 才写缓存，于是旧工具继续被当作仍然存在而对外提供。
          this.toolsByServer.set(adapter.name, freshTools);
          console.error(`✅ Got ${freshTools.length} tools from ${adapter.name}`);
        } else {
          console.error(`⚠️ Failed to fetch tools from a server: ${(result.reason as Error)?.message}`);
          // Continue with cached tools (if any)
        }
      }
    }

    // 工具清单有变化时重建路由键：路由键依赖「跨服务器是否重名」，
    // 必须与下面展示给客户端的名字用同一套规则（否则客户端拿到名字却调不通）
    if (staleAdapters.length > 0) {
      this.rebuildToolRoutes();
    }

    // 取名与路由都用同一份分配结果（本方法是唯一消费方）
    const allocation = this.allocateRouteKeys();

    for (const adapter of connectedAdapters) {
      const serverTools = this.toolsByServer.get(adapter.name) || [];
      // 同服务器内的重名工具在分配阶段只保留第一个（见 allocateRouteKeys）。
      // 这里必须按「已产出过的路由键」去重，而不是只判断 allocated.has(tool.name) ——
      // 后者对两个同名工具都成立，会把同一路由键输出两条（其中一条不可路由）。
      const allocated = allocation.get(adapter.name);
      const emitted = new Set<string>();

      // Add enabled tools to the list
      for (const tool of serverTools) {
        const routeKey = allocated?.get(tool.name);
        if (!routeKey || emitted.has(routeKey)) continue;
        if (this.isToolEnabled(adapter.name, tool.name)) {
          emitted.add(routeKey);
          allServerTools.push({ tool, serverName: adapter.name });
        }
      }
    }

    // Step 2+3: 用与路由键完全相同的分配结果取名。
    // 此前这里是「跨服务器计数」而建路由时是「先到者占裸名」，两套规则会在
    // 「A 有 x 与 B-x，B 有 x」这类组合下产出重名条目和不可达工具。
    const allTools: MCPTool[] = [];
    for (const { tool, serverName } of allServerTools) {
      const routeKey = allocation.get(serverName)?.get(tool.name);
      if (!routeKey) {
        // 上面重建过后必然有值；真到不了这里说明内部状态不一致，明确报出来而不是给个错名字
        console.error(`No route key allocated for ${serverName}/${tool.name}, skipping`);
        continue;
      }
      allTools.push({
        ...tool,
        name: routeKey,
        // Add server info to tool description
        description: `[${serverName}] ${tool.description}`
      });
    }

    // If a reasonable number of tools are obtained, update the stable cache
    if (allTools.length >= this.lastStableToolsCount * 0.8) { // At least 80% of tools
      this.lastStableToolsList = [...allTools];
      this.lastStableToolsCount = allTools.length;
      console.error(`💾 Updated stable tools cache: ${allTools.length} tools`);
    }
    
    // Security fix: always return currently available tools, do not use cache
    // This ensures disabled servers/tools are not visible to MCP clients

    return allTools;
  }

  getToolsByServer(serverName: string): MCPTool[] {
    return this.toolsByServer.get(serverName) || [];
  }

  getEnabledToolsByServer(serverName: string): MCPTool[] {
    const serverTools = this.toolsByServer.get(serverName) || [];
    return serverTools.filter(tool => this.isToolEnabled(serverName, tool.name));
  }

  /**【仅供错误提示】当前对外可见（已连接且未被禁用）的工具名 */
  private listVisibleToolNames(): string[] {
    const names: string[] = [];
    for (const [routeKey, route] of this.toolRoutes) {
      if (!route.adapter.isConnected) continue;
      if (!this.isToolEnabled(route.serverName, route.originalToolName)) continue;
      names.push(routeKey);
    }
    return names;
  }

  findToolRoute(toolName: string): ToolRoute | undefined {
    return this.toolRoutes.get(toolName);
  }

  async callTool(toolName: string, args: any): Promise<MCPResponse> {
    const route = this.toolRoutes.get(toolName);
    
    if (!route) {
      // If tool not found, try to force refresh all tools
      console.error(`Tool ${toolName} not found, refreshing tools...`);
      await this.getAllTools(true); // Force refresh
      
      const refreshedRoute = this.toolRoutes.get(toolName);
      if (!refreshedRoute) {
        return {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32601,
            message: `Tool not found: ${toolName}`,
            // 只列**当前对外可见**的工具：toolRoutes 里也含被 toolsConfig 禁用的条目，
            // 直接抛出会把「已禁用」的名字泄漏给调用方。
            data: { availableTools: this.listVisibleToolNames() }
          }
        };
      }
      // Use refreshed route
      return this.callTool(toolName, args);
    }

    // 被禁用的工具在列表里不出现，也必须不能被调用。
    // 只靠「不出现在 tools/list」是不足的：客户端可能缓存了旧的工具清单
    // （配置热更新后我们还会主动推 list_changed，旧清单仍在客户端手里），
    // 只要知道名字就能绕过开关 —— 那会让「禁用工具」这个管控形同虚设。
    if (!this.isToolEnabled(route.serverName, route.originalToolName)) {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32601,
          message: `Tool is disabled: ${toolName}`,
          data: { serverName: route.serverName, toolName: route.originalToolName }
        }
      };
    }

    if (!route.adapter.isConnected) {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: `Server not connected: ${route.serverName}`,
          data: { serverName: route.serverName }
        }
      };
    }

    try {
      console.error(`Routing tool call: ${toolName} -> ${route.serverName}`);

      // 用路由里记录的真实工具名，而不是按 `serverName-` 前缀反推：
      // 反推会把服务器自己就叫 `serverName-xxx` 的工具错改成 `xxx`，
      // 若该服务器恰好也有 `xxx`，就会以调用方参数静默执行另一个工具。
      const originalToolName = route.originalToolName;

      if (originalToolName !== toolName) {
        console.error(`Stripping prefix: ${toolName} -> ${originalToolName}`);
      }
      
      const startTime = Date.now();
      const response = await route.adapter.callTool(originalToolName, args);
      const duration = Date.now() - startTime;

      console.error(`Tool call completed: ${toolName} (${duration}ms)`);
      
      this.emit('tool-called', {
        serverName: route.serverName,
        toolName,
        args,
        result: response.result,
        duration
      });

      return response;

    } catch (error) {
      console.error(`Tool call failed: ${toolName} -> ${route.serverName}:`, error);
      
      this.emit('tool-call-failed', {
        serverName: route.serverName,
        toolName,
        args,
        error: error as Error
      });

      return {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32000,
          message: `Tool call failed: ${(error as Error).message}`,
          data: { 
            toolName, 
            serverName: route.serverName,
            originalError: (error as Error).message 
          }
        }
      };
    }
  }

  async connectAll(options?: { 
    timeout?: number; 
    maxConcurrent?: number; 
  }): Promise<void> {
    const { timeout = 8000, maxConcurrent = 3 } = options || {};
    
    const adaptersToConnect = Array.from(this.adapters.values())
      .filter(adapter => !adapter.isConnected);

    if (adaptersToConnect.length === 0) {
      console.error("[ROUTER] No adapters to connect.");
      return;
    }

    console.error(`[ROUTER] Starting parallel connection of ${adaptersToConnect.length} adapters (timeout: ${timeout}ms, max concurrent: ${maxConcurrent})`);

    // Batch parallel connection, limit concurrency
    const batches: any[][] = [];
    for (let i = 0; i < adaptersToConnect.length; i += maxConcurrent) {
      batches.push(adaptersToConnect.slice(i, i + maxConcurrent));
    }

    let connectedCount = 0;
    let failedCount = 0;

    for (const batch of batches) {
      const batchPromises = batch.map(async adapter => {
        const startTime = Date.now();
        try {
          // Add timeout control for each connection
          await this.connectWithTimeout(adapter, timeout);
          const duration = Date.now() - startTime;
          console.error(`[ROUTER] ✅ ${adapter.name} connection successful (${duration}ms)`);
          connectedCount++;
        } catch (error) {
          const duration = Date.now() - startTime;
          console.error(`[ROUTER] ❌ ${adapter.name} connection failed (${duration}ms):`, (error as Error).message);
          failedCount++;
        }
      });

      await Promise.allSettled(batchPromises);
    }

    console.error(`[ROUTER] Connection completed: ${connectedCount} successful, ${failedCount} failed`);
  }

  private async connectWithTimeout(adapter: any, timeout: number): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Connection timeout (${timeout}ms)`));
      }, timeout);

      try {
        await adapter.connect();
        clearTimeout(timeoutId);
        resolve();
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  async disconnectAll(): Promise<void> {
    // 同 removeAdapter：不能按 isConnected 过滤。停机时最需要清理的恰恰是
    // isConnected=false 但仍挂着 reconnectTimer / live SSE 流的适配器
    // （重连退避窗口中的状态），漏掉它们会让「已停止」的服务器自己连回来并拖住进程。
    const disconnectionPromises = Array.from(this.adapters.values())
      .map(async adapter => {
        try {
          await adapter.disconnect();
        } catch (error) {
          console.error(`Failed to disconnect ${adapter.name}:`, error);
        }
      });

    await Promise.allSettled(disconnectionPromises);
  }

  getRouteStatus(): {
    totalAdapters: number;
    connectedAdapters: number;
    totalTools: number;
    toolsByServer: Record<string, number>;
    toolConflicts: string[];
  } {
    const connectedAdapters = this.getConnectedAdapters();
    const toolsByServer: Record<string, number> = {};
    const toolNames = new Set<string>();
    const toolConflicts: string[] = [];

    for (const adapter of this.adapters.values()) {
      const tools = this.toolsByServer.get(adapter.name) || [];
      toolsByServer[adapter.name] = tools.length;

      for (const tool of tools) {
        if (toolNames.has(tool.name)) {
          toolConflicts.push(tool.name);
        } else {
          toolNames.add(tool.name);
        }
      }
    }

    return {
      totalAdapters: this.adapters.size,
      connectedAdapters: connectedAdapters.length,
      totalTools: this.toolRoutes.size,
      toolsByServer,
      toolConflicts: Array.from(new Set(toolConflicts))
    };
  }

  // Tool search and filtering
  searchTools(query: string): MCPTool[] {
    const allTools = Array.from(this.toolsByServer.values()).flat();
    const lowerQuery = query.toLowerCase();

    return allTools.filter(tool =>
      tool.name.toLowerCase().includes(lowerQuery) ||
      tool.description.toLowerCase().includes(lowerQuery)
    );
  }

  // Enable/disable tools by server
  async enableServerTools(serverName: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.refreshToolRoutes(serverName);
    } else {
      this.removeToolRoutes(serverName);
    }
  }

  // Manually reconnect specific server (for SIGKILL etc. issues)
  async forceReconnectServer(serverName: string): Promise<boolean> {
    const adapter = this.adapters.get(serverName);
    if (!adapter) {
      console.error(`Server ${serverName} not found`);
      return false;
    }

    try {
      console.error(`🔄 Force reconnecting server: ${serverName}`);
      
      // If adapter supports force reconnect, use dedicated method
      if ('forceReconnect' in adapter && typeof adapter.forceReconnect === 'function') {
        await (adapter as any).forceReconnect();
      } else {
        // Otherwise use standard reconnect process
        if (adapter.isConnected) {
          await adapter.disconnect();
        }
        await adapter.connect();
      }

      console.error(`✅ ${serverName} reconnected successfully`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to reconnect ${serverName}:`, (error as Error).message);
      return false;
    }
  }

  // Get server health status
  getServerHealth(): Record<string, {
    connected: boolean;
    toolCount: number;
    lastSeen: string;
    status: 'healthy' | 'unstable' | 'failed';
  }> {
    const health: Record<string, any> = {};

    for (const [name, adapter] of this.adapters) {
      const tools = this.toolsByServer.get(name) || [];
      
      let status: 'healthy' | 'unstable' | 'failed' = 'healthy';
      if (!adapter.isConnected) {
        status = 'failed';
      } else if (tools.length === 0) {
        status = 'unstable';
      }

      health[name] = {
        connected: adapter.isConnected,
        toolCount: tools.length,
        lastSeen: new Date().toISOString(),
        status
      };
    }

    return health;
  }

  // Auto-heal unhealthy servers
  async autoHealUnhealthyServers(): Promise<void> {
    const health = this.getServerHealth();
    
    for (const [serverName, healthInfo] of Object.entries(health)) {
      if (healthInfo.status === 'failed') {
        console.error(`🩹 Auto-healing failed server: ${serverName}`);
        await this.forceReconnectServer(serverName);
      }
    }
  }

  // Get crash statistics for all servers
  getAllCrashStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [name, adapter] of this.adapters) {
      if ('getCrashStats' in adapter && typeof adapter.getCrashStats === 'function') {
        stats[name] = (adapter as any).getCrashStats();
      }
    }
    
    return stats;
  }

  // Clear blacklist for specific server
  clearServerBlacklist(serverName: string): boolean {
    const adapter = this.adapters.get(serverName);
    if (!adapter) {
      console.error(`Server ${serverName} not found`);
      return false;
    }

    if ('clearBlacklist' in adapter && typeof adapter.clearBlacklist === 'function') {
      (adapter as any).clearBlacklist();
      console.error(`🟢 Cleared blacklist for ${serverName}`);
      return true;
    }

    return false;
  }

  // Clear all server blacklists
  clearAllBlacklists(): void {
    console.error('🟢 Clearing all server blacklists...');
    
    for (const [name, adapter] of this.adapters) {
      if ('clearBlacklist' in adapter && typeof adapter.clearBlacklist === 'function') {
        (adapter as any).clearBlacklist();
      }
    }
  }

  // Get number of connected servers (for MCPDogServer)
  getConnectedServerCount(): number {
    return this.getConnectedAdapters().length;
  }

  // Get total number of servers (for MCPDogServer)
  getTotalServerCount(): number {
    return this.adapters.size;
  }

  // Get tool distribution (for MCPDogServer)
  getToolDistribution(): Record<string, number> {
    const distribution: Record<string, number> = {};
    
    for (const [serverName, tools] of this.toolsByServer) {
      distribution[serverName] = tools.length;
    }
    
    return distribution;
  }

  async updateServerTools(serverName: string): Promise<void> {
    console.log(`[ROUTER] Updating tools for server: ${serverName}`);
    await this.refreshToolRoutes(serverName);
  }
}