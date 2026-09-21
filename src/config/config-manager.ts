import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import { MCPDogConfig, MCPServerConfig } from '../types/index.js';
import { AdapterFactory } from '../adapters/adapter-factory.js';
import { AutoConfigGenerator, ConfigSuggestion } from '../core/auto-config-generator.js';
import { ProtocolDetector } from '../core/protocol-detector.js';
import { ServerNameValidator } from '../utils/server-name-validator.js';

export class ConfigManager extends EventEmitter {
  private config: MCPDogConfig;
  private configPath: string;
  private autoCreateConfig: boolean;
  private watchAbortController?: AbortController;
  private watchDebounceTimer?: NodeJS.Timeout;
  private autoConfigGenerator: AutoConfigGenerator;
  private protocolDetector: ProtocolDetector;
  /** saveConfig 的并发序号：临时文件名必须每次唯一，见 saveConfig */
  private saveSequence = 0;

  constructor(configPath?: string, autoCreateConfig?: boolean) {
    super();
    this.configPath = configPath || this.getDefaultConfigPath();
    this.config = this.getDefaultConfig();
    
    // Intelligently detect whether to auto-create config file
    if (autoCreateConfig === undefined) {
      this.autoCreateConfig = this.shouldAutoCreateConfig();
    } else {
      this.autoCreateConfig = autoCreateConfig;
    }
    
    this.autoConfigGenerator = new AutoConfigGenerator();
    this.protocolDetector = new ProtocolDetector();
  }

  /**
   * Get the default configuration file path
   * Always use user home directory ~/.mcpdog/mcpdog.config.json
   */
  private getDefaultConfigPath(): string {
    // Use user home directory for global config
    const userConfigDir = join(homedir(), '.mcpdog');
    const userConfigPath = join(userConfigDir, 'mcpdog.config.json');
    
    // Ensure the config directory exists
    try {
      fsSync.mkdirSync(userConfigDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore error
    }
    
    return userConfigPath;
  }

  private isStdioMode(): boolean {
    // Detect if running in stdio mode (called by MCP client)
    // Determine by checking command line arguments
    return process.argv.includes('serve') && !process.argv.includes('--web-port');
  }

  /**
   * 判断是否应当自动创建配置文件。
   *
   * 可写探测只在**目标目录**里做。此前用相对路径 './test-write-<ts>' 探测，
   * 于是每次构造 ConfigManager 都会往进程 CWD（CLI 与测试下就是项目根目录）
   * 扔一个临时文件；写入是 fire-and-forget，任何提前退出或崩溃都会把它永久留下。
   * 而且 `return true` 写在 Promise 之外，无论写不写得进去都报「可写」，探测本身
   * 也不成立。这里改为同步探测目标目录、并保证探测文件被清理。
   */
  private shouldAutoCreateConfig(): boolean {
    // If in serve mode, do not auto-create (to avoid polluting stdio)
    if (process.argv.includes('serve')) {
      return false;
    }
    
    // If running as an MCP server (via stdio), do not auto-create
    if (this.isStdioMode()) {
      return false;
    }

    if (existsSync(this.configPath)) {
      return false;
    }

    try {
      const configDir = dirname(this.configPath);
      mkdirSync(configDir, { recursive: true });
      const probePath = join(configDir, `.write-probe-${process.pid}-${Date.now()}`);
      try {
        writeFileSync(probePath, 'probe');
        return true;
      } finally {
        try {
          unlinkSync(probePath);
        } catch {
          // 探测文件清理失败不影响结论
        }
      }
    } catch {
      return false;
    }
  }

  private getDefaultConfig(): MCPDogConfig {
    return {
      servers: {},
      version: '2.0.0',
      logging: {
        level: 'info' as const
      }
    };
  }

  async loadConfig(): Promise<void> {
    try {
      const configJson = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(configJson);

      // 结构校验：JSON 合法不等于配置可用。
      // `{"servers":null}` 或 `{"servers":{"x":null}}` 能解析通过，但会让
      // getEnabledServers / reinitializeAdapters 抛错 —— 经过文件监听热加载后
      // /api/status 与 /api/servers 会持续 500，且没有自愈路径（只能手工改回文件）。
      // 这里直接拒绝这类文件，保留内存中的既有配置，由调用方报错。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('配置根节点必须是 JSON 对象');
      }
      if (parsed.servers !== undefined) {
        if (parsed.servers === null || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) {
          throw new Error('servers 必须是对象（当前为 ' + (Array.isArray(parsed.servers) ? 'array' : String(parsed.servers)) + '）');
        }
        for (const [name, entry] of Object.entries(parsed.servers)) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`服务器 "${name}" 的定义必须是对象`);
          }
        }
      }

      this.config = {
        ...this.getDefaultConfig(),
        ...parsed
      };
    } catch (error) {
      // Config doesn't exist
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.autoCreateConfig) {
          await this.initializeAutoConfig();
        }
      } else {
        throw new Error(`Failed to load config from ${this.configPath}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Initialize auto-config by detecting available MCP servers and creating basic configuration
   */
  private async initializeAutoConfig(): Promise<void> {
    try {
      // Let the auto config generator create a basic config
      const suggestions = await this.generateConfigSuggestionsInternal();
      
      if (suggestions.length > 0) {
        // Apply the first suggestion (usually the comprehensive one)
        const suggestion = suggestions[0];
        if (suggestion.config) {
          this.config.servers[suggestion.config.name] = suggestion.config;
        }
        await this.saveConfig();
      } else {
        // No suggestions, keep default config
        await this.saveConfig();
      }
    } catch (error) {
      console.warn(`Failed to auto-initialize config: ${(error as Error).message}`);
      // Keep default config
    }
  }

  async saveConfig(): Promise<void> {
    try {
      // Ensure the directory exists
      const configDir = dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });

      // 原子落盘：先写同目录临时文件再 rename。
      // 直接 writeFile 是「截断 + 写入」，期间文件是半截的 —— 崩溃或断电会留下
      // 无法解析的配置（整个网关的服务器定义都在这个文件里），而 fs.watch 也可能
      // 正好读到写了一半的内容。rename 在同一文件系统内是原子的，读者要么看到
      // 旧内容、要么看到完整新内容。
      //
      // 临时名必须每次唯一（进程号 + 递增序号）：只用进程号时，两次并发的
      // saveConfig（例如多个前端请求同时改工具配置）会共用同一临时文件，
      // 先完成的 rename 把它取走，后一个随即 ENOENT 失败并冒泡成 HTTP 500。
      const tempPath = `${this.configPath}.tmp-${process.pid}-${++this.saveSequence}`;
      try {
        await fs.writeFile(tempPath, JSON.stringify(this.config, null, 2));
        await this.renameWithRetry(tempPath, this.configPath);
      } catch (error) {
        // 失败时清掉自己的临时文件，不在配置目录里留垃圾
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      throw new Error(`Failed to save config to ${this.configPath}: ${(error as Error).message}`);
    }
  }

  /**
   * rename 到目标路径，遇 Windows 的瞬时错误则重试。
   *
   * Windows 上 rename 覆盖一个已存在的目标文件会间歇性 EPERM/EBUSY
   * （实测 200 次串行里失败 2~4 次；并发 10 次里失败 3~4 次；重试一次即成功）。
   * 这个失败会一路冒泡成 HTTP 500，前端表现为「随机保存失败」。
   * 注意：临时文件与目标同目录、同一文件系统，rename 仍是原子的。
   */
  private async renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await fs.rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!transient || i >= attempts) {
          throw error;
        }
        // 退避后重试（20ms, 40ms, 80ms, 160ms）
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** (i - 1)));
      }
    }
  }

  getConfig(): MCPDogConfig {
    return this.config;
  }

  setConfig(config: MCPDogConfig): void {
    this.config = config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getServerConfig(serverName: string): MCPServerConfig | undefined {
    return this.config.servers[serverName];
  }

  getServer(serverName: string): MCPServerConfig | undefined {
    return this.config.servers[serverName];
  }

  getAllServers(): Record<string, MCPServerConfig> {
    return this.config.servers;
  }

  getServers(): Record<string, MCPServerConfig> {
    return this.config.servers;
  }

  getEnabledServers(): Record<string, MCPServerConfig> {
    const servers: Record<string, MCPServerConfig> = {};
    for (const [name, config] of Object.entries(this.config.servers)) {
      if (config.enabled !== false) { // Default to enabled if not specified
        servers[name] = config;
      }
    }
    return servers;
  }

  toggleServer(name: string, enabled: boolean): boolean {
    if (this.config.servers[name]) {
      this.config.servers[name].enabled = enabled;
      // Emit server-toggled event so MCPDogServer can handle connection/disconnection
      this.emit('server-toggled', { name, enabled });
      return true;
    }
    return false;
  }

  addServer(name: string, config: MCPServerConfig): boolean {
    // Validate server name
    const validation = ServerNameValidator.validateServerName(name);
    if (!validation.valid) {
      throw new Error(`Invalid server name: ${validation.error}`);
    }

    // Check for name conflicts
    if (this.config.servers[name]) {
      throw new Error(`Server "${name}" already exists`);
    }

    // Ensure name field matches the key
    const finalConfig = { ...config, name };
    this.config.servers[name] = finalConfig;
    
    // Emit server-added event
    this.emit('server-added', { name, config: finalConfig });
    
    return true;
  }

  removeServer(name: string): boolean {
    if (this.config.servers[name]) {
      delete this.config.servers[name];
      // Emit server-removed event
      this.emit('server-removed', { name });
      return true;
    }
    return false;
  }

  updateServer(name: string, config: Partial<MCPServerConfig>): boolean {
    if (!this.config.servers[name]) {
      return false;
    }

    // If name is being updated, validate the new name
    if (config.name && config.name !== name) {
      const validation = ServerNameValidator.validateServerName(config.name);
      if (!validation.valid) {
        throw new Error(`Invalid server name: ${validation.error}`);
      }

      // Check for name conflicts with other servers
      if (this.config.servers[config.name]) {
        throw new Error(`Server "${config.name}" already exists`);
      }

      // Rename the server
      const oldConfig = this.config.servers[name];
      delete this.config.servers[name];
      this.config.servers[config.name] = { ...oldConfig, ...config };

      // Emit server-renamed event
      this.emit('server-renamed', { oldName: name, newName: config.name, config: this.config.servers[config.name] });
    } else {
      // Update existing server
      const merged = { ...this.config.servers[name], ...config };

      // 切换传输类型时清理不相关字段
      if (config.transport && config.transport !== this.config.servers[name].transport) {
        if (config.transport === 'stdio') {
          delete merged.endpoint;
          delete merged.url;
          delete merged.apiKey;
          delete merged.headers;
        } else {
          delete merged.command;
          delete merged.args;
          delete merged.cwd;
          delete merged.env;
        }
      }

      this.config.servers[name] = merged;

      // Emit server-updated event
      this.emit('server-updated', { name, config: this.config.servers[name] });
    }

    return true;
  }

  /**
   * Rename a server
   */
  renameServer(oldName: string, newName: string): boolean {
    if (!this.config.servers[oldName]) {
      return false;
    }

    const validation = ServerNameValidator.validateServerName(newName);
    if (!validation.valid) {
      throw new Error(`Invalid server name: ${validation.error}`);
    }

    if (this.config.servers[newName]) {
      throw new Error(`Server "${newName}" already exists`);
    }

    const config = this.config.servers[oldName];
    delete this.config.servers[oldName];
    this.config.servers[newName] = { ...config, name: newName };
    
    // Emit server-renamed event
    this.emit('server-renamed', { oldName, newName, config: this.config.servers[newName] });
    
    return true;
  }

  /**
   * Generate a unique server name
   */
  generateUniqueServerName(baseName: string): string {
    const existingNames = Object.keys(this.config.servers);
    return ServerNameValidator.generateUniqueName(baseName, existingNames);
  }

  /**
   * Validate server name
   */
  validateServerName(name: string): { valid: boolean; error?: string; suggestions?: string[] } {
    return ServerNameValidator.validateServerName(name);
  }

  /**
   * Check if server name conflicts with existing names
   */
  checkServerNameConflict(name: string): boolean {
    return ServerNameValidator.checkNameConflict(name, Object.keys(this.config.servers));
  }

  /**
   * Start watching config file
   */
  async startWatching(): Promise<void> {
    return this.watchConfig();
  }

  /**
   * Watch config file for changes and reload
   */
  async watchConfig(): Promise<void> {
    if (this.watchAbortController) {
      return; // Already watching
    }

    this.watchAbortController = new AbortController();

    try {
      const watcher = fs.watch(this.configPath, { signal: this.watchAbortController.signal });

      for await (const event of watcher) {
        // 编辑器/sed 等以"临时文件+rename"方式保存时触发 rename 而非 change，两种都要处理
        if (event.eventType === 'change' || event.eventType === 'rename') {
          // 一次保存常触发多次 change 事件，防抖合并后再重载，避免连续多轮全量重连
          if (this.watchDebounceTimer) {
            clearTimeout(this.watchDebounceTimer);
          }
          this.watchDebounceTimer = setTimeout(() => {
            this.watchDebounceTimer = undefined;
            void this.reloadAndNotifyConfig();
          }, 300);
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        // 同上：仅 emit 会被静默吞掉，watch 建立失败意味着热更新彻底失效
        console.error('Config file watcher error:', (error as Error).message);
        this.emit('configError', error);
      }
    }
  }

  /**
   * Reload config from disk and notify listeners.
   * 事件名必须与 MCPDogServer / MCPDogDaemon 的监听一致（'config-updated'），
   * 否则文件级配置变更永远不会触发重载。
   */
  private async reloadAndNotifyConfig(): Promise<void> {
    try {
      // rename 事件可能对应文件被删除或替换瞬间，文件不存在时保留现有配置、不广播
      if (!fsSync.existsSync(this.configPath)) {
        return;
      }
      await this.loadConfig();
      this.emit('config-updated', { config: this.config });
    } catch (error) {
      // 必须留下痕迹：'configError' 全仓无监听方，事件命名也不是 'error'，
      // EventEmitter 不会因此抛出 —— 只 emit 等于静默吞掉。结果是配置文件已被改坏
      // （或写入过程被读到半截），内存里却还是旧配置，两侧静默分叉且不会自动重试。
      console.error(
        `Failed to reload config from ${this.configPath}, keeping previous in-memory config:`,
        (error as Error).message
      );
      this.emit('configError', error);
    }
  }

  /**
   * Stop watching config file
   */
  stopWatching(): void {
    if (this.watchAbortController) {
      this.watchAbortController.abort();
      this.watchAbortController = undefined;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }
  }

  /**
   * Validate configuration structure
   */
  validateConfig(config?: MCPDogConfig): { valid: boolean; errors: string[] } {
    const configToValidate = config || this.config;
    const errors: string[] = [];

    if (!configToValidate.servers || typeof configToValidate.servers !== 'object') {
      errors.push('Config must have a "servers" object');
    } else {
      for (const [name, serverConfig] of Object.entries(configToValidate.servers)) {
        if (!serverConfig.command) {
          errors.push(`Server "${name}" must have a command`);
        }
        
        if (serverConfig.args && !Array.isArray(serverConfig.args)) {
          errors.push(`Server "${name}" args must be an array`);
        }
        
        if (serverConfig.env && typeof serverConfig.env !== 'object') {
          errors.push(`Server "${name}" env must be an object`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Optimize configuration by detecting protocols and suggesting improvements
   */
  async optimizeConfig(): Promise<ConfigSuggestion[]> {
    const suggestions: ConfigSuggestion[] = [];
    
    for (const [name, serverConfig] of Object.entries(this.config.servers)) {
      try {
        const detection = await this.detectConfigProtocol(serverConfig);
        
        if (detection.recommendations.length > 0) {
          suggestions.push({
            config: serverConfig,
            confidence: 0.8,
            alternatives: [],
            warnings: [`Detected issues with ${name}`, ...detection.recommendations],
            optimizations: [`Server optimization available for ${name}`]
          });
        }
      } catch (error) {
        suggestions.push({
          config: serverConfig,
          confidence: 0.1,
          alternatives: [],
          warnings: [`Server ${name} has configuration errors: ${(error as Error).message}`],
          optimizations: []
        });
      }
    }
    
    return suggestions;
  }

  /**
   * Apply configuration suggestions
   */
  async applySuggestions(suggestions: ConfigSuggestion[]): Promise<void> {
    for (const suggestion of suggestions) {
      if (suggestion.config && suggestion.config.name) {
        this.config.servers[suggestion.config.name] = suggestion.config;
      }
    }
    
    await this.saveConfig();
  }

  /**
   * Export configuration for backup or sharing
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * Import configuration from JSON string
   */
  async importConfig(configJson: string): Promise<void> {
    try {
      const config = JSON.parse(configJson);
      const validation = this.validateConfig(config);
      
      if (!validation.valid) {
        throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
      }
      
      this.config = {
        ...this.getDefaultConfig(),
        ...config
      };
      
      await this.saveConfig();
    } catch (error) {
      throw new Error(`Failed to import configuration: ${(error as Error).message}`);
    }
  }

  /**
   * Get configuration statistics
   */
  getConfigStats(): {
    serverCount: number;
    totalTools: number;
    configSize: number;
    lastModified?: Date;
  } {
    return {
      serverCount: Object.keys(this.config.servers).length,
      totalTools: 0, // This would need to be calculated from actual server connections
      configSize: JSON.stringify(this.config).length,
      lastModified: undefined // This would need file stats
    };
  }

  // Legacy compatibility methods
  generateAutoConfig(): Promise<MCPDogConfig[]> {
    return Promise.resolve([this.config]);
  }

  /**
   * 对某个端点做协议自动检测，返回可用的服务器配置建议。
   *
   * 转发到已实例化的 AutoConfigGenerator（内部用 ProtocolDetector 真实探测），
   * 供 `config add --auto-detect` 使用 —— 此前该分支整段被注释掉，却仍报成功。
   */
  async generateAutoConfigForEndpoint(
    name: string,
    endpoint: string,
    options?: { timeout?: number; headers?: Record<string, string> }
  ): Promise<ConfigSuggestion> {
    return this.autoConfigGenerator.generateConfig(name, endpoint, options);
  }

  // Internal method that returns ConfigSuggestion[]
  private async generateConfigSuggestionsInternal(): Promise<ConfigSuggestion[]> {
    const suggestions: ConfigSuggestion[] = [];
    for (const [name, serverConfig] of Object.entries(this.config.servers)) {
      suggestions.push({
        config: serverConfig,
        confidence: 0.9,
        alternatives: [],
        warnings: [],
        optimizations: []
      });
    }
    return suggestions;
  }

  // Legacy method that returns MCPDogConfig[] for compatibility
  generateConfigSuggestions(): Promise<MCPDogConfig[]> {
    return this.generateAutoConfig();
  }

  /**
   * 检测服务器的协议。
   *
   * 返回契约由调用方决定（detect-commands / diagnose-commands 读的是
   * `detected` / `confidence` / `recommendations`），因此必须返回这些字段。
   * 曾经恒返回 `{ protocol: 'stdio', issues: [] }`，所有 http-sse / streamable-http
   * 服务器都被报告成 stdio 且「无问题」，检测形同虚设。
   *
   * 注意 `detected` **必须永远是合法的 transport 取值**：调用方会以
   * 「detected !== server.transport && confidence > 70」为条件把它写进配置
   * （detect-commands.ts / diagnose-commands.ts 的自动修复路径）。给出 undefined
   * 会把 transport 覆盖成 undefined 从而写坏配置。
   */
  detectConfigProtocol(server: MCPServerConfig): Promise<{
    current: string;
    detected: string;
    confidence: number;
    recommendations: string[];
    needsUpdate: boolean;
  }> {
    const recommendations: string[] = [];
    // 配置里的 transport 就是权威事实，据实回报即可。
    // 但必须保证 detected 始终是合法取值：调用方会以
    // 「detected !== server.transport && confidence > 70」为条件把它写回配置，
    // 给出 undefined 就会把 transport 覆盖成 undefined（配置损坏）。
    const isValidTransport =
      server.transport === 'stdio' ||
      server.transport === 'http-sse' ||
      server.transport === 'streamable-http';
    const detected = isValidTransport ? server.transport : 'stdio';

    if (!isValidTransport) {
      recommendations.push(
        `transport 缺失或非法（${String(server.transport)}），已按 stdio 处理`
      );
    }

    switch (server.transport) {
      case 'stdio':
        if (!server.command) {
          recommendations.push('stdio 传输缺少 command，请补充启动命令');
        }
        break;
      case 'streamable-http':
      case 'http-sse': {
        const url = server.url || server.endpoint;
        if (!url) {
          recommendations.push(`${server.transport} 传输缺少 url/endpoint，请补充服务地址`);
        } else if (!/^https?:\/\//i.test(url)) {
          recommendations.push(`${server.transport} 的 url 不是 http(s) 地址：${url}`);
        }
        break;
      }
      default:
        recommendations.push(`未知的 transport: ${String(server.transport)}`);
    }

    const hasIssues = recommendations.length > 0;

    return Promise.resolve({
      current: server.transport,
      detected,
      confidence: hasIssues ? 40 : 100,
      recommendations,
      // 协议与配置一致且无问题就不需要改动，避免自动修复路径去写一个等价值
      needsUpdate: false
    });
  }

  validateServerConfig(config: MCPServerConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!config.command && config.transport === "stdio") {
      errors.push("Command is required for stdio transport");
    }
    return { valid: errors.length === 0, errors };
  }

  optimizeServerConfig(name: string): Promise<any> {
    return Promise.resolve({ optimizations: [] });
  }

  /**
   * 批量协议审计。字段契约同上（detect-commands 的 `--all` 读
   * `current` / `detected` / `confidence` / `recommendations` / `needsUpdate`）。
   */
  auditAllServerProtocols(): Promise<Record<string, any>> {
    const results: Record<string, any> = {};
    for (const [name, serverConfig] of Object.entries(this.config.servers)) {
      const recommendations: string[] = [];
      if (serverConfig.transport === 'stdio' && !serverConfig.command) {
        recommendations.push('stdio 传输缺少 command');
      } else if (
        serverConfig.transport !== 'stdio' &&
        !(serverConfig.url || serverConfig.endpoint)
      ) {
        recommendations.push(`${serverConfig.transport} 传输缺少 url/endpoint`);
      }

      const okTransport =
        serverConfig.transport === 'stdio' ||
        serverConfig.transport === 'http-sse' ||
        serverConfig.transport === 'streamable-http';
      results[name] = {
        current: serverConfig.transport,
        // 同 detectConfigProtocol：detected 必须是合法 transport，调用方会写回配置
        detected: okTransport ? serverConfig.transport : 'stdio',
        confidence: recommendations.length === 0 ? 100 : 40,
        recommendations,
        needsUpdate: false
      };
    }
    return Promise.resolve(results);
  }

  /**
   * 逐工具开关。
   *
   * 此前是无条件 return true 的空实现，daemon 拿到 true 就当作已完成，
   * 工具实际纹丝不动 —— 调用方看到的是「成功」。
   * 现写入 toolsConfig.toolSettings[tool].enabled 并返回真实结果；
   * 服务器不存在时返回 false，让调用方能区分失败。
   */
  toggleTool(serverName: string, toolName: string, enabled: boolean): boolean {
    const serverConfig = this.config.servers[serverName];
    if (!serverConfig) {
      return false;
    }

    if (!serverConfig.toolsConfig) {
      serverConfig.toolsConfig = { mode: 'all' };
    }
    if (!serverConfig.toolsConfig.toolSettings) {
      serverConfig.toolsConfig.toolSettings = {};
    }

    const existing = serverConfig.toolsConfig.toolSettings[toolName];
    serverConfig.toolsConfig.toolSettings[toolName] = {
      ...(existing ?? {}),
      enabled
    };

    this.emit('tool-toggled', { serverName, toolName, enabled });
    return true;
  }
}
