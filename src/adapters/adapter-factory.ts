import { MCPServerConfig, ServerAdapter } from '../types/index.js';
import { StdioAdapter } from './stdio-adapter.js';
import { HttpSseAdapter } from './http-sse-adapter.js';
import { StreamableHttpAdapter } from './streamable-http-adapter.js';

export class AdapterFactory {
  // List of sensitive environment variable keywords
  private static sensitiveKeywords = [
    'password', 'secret', 'key', 'token', 'auth', 'credential', 
    'pass', 'pwd', 'private', 'sensitive', 'security', 'api_key',
    'access_token', 'refresh_token', 'jwt', 'session'
  ];

  static createAdapter(name: string, config: MCPServerConfig): ServerAdapter {
    switch (config.transport) {
      case 'stdio':
        return new StdioAdapter(name, config);
      
      case 'http-sse':
        return new HttpSseAdapter(name, config);
      
      case 'streamable-http':
        return new StreamableHttpAdapter(name, config);
      
      default:
        throw new Error(`Unsupported transport type: ${config.transport} for ${name}`);
    }
  }

  static validateConfig(config: MCPServerConfig): string[] {
    const errors: string[] = [];

    // General validation
    if (!config.name) {
      errors.push('Server name is required');
    }

    if (!config.transport) {
      errors.push('Transport type is required');
    }

    // Transport type specific validation
    switch (config.transport) {
      case undefined:
      case null:
        // 缺 transport 已在上面报过，这里不重复
        break;

      case 'stdio':
        if (!config.command) {
          errors.push('Command is required for stdio transport');
        }
        
        // Validate environment variables (only needed for stdio transport)
        const envErrors = this.validateEnvironmentVariables(config.env);
        errors.push(...envErrors);
        break;

      case 'http-sse':
      case 'streamable-http':
        // Support both 'url' (preferred) and 'endpoint' (legacy) fields
        const httpUrl = config.url || config.endpoint;
        if (!httpUrl) {
          errors.push(`URL or endpoint is required for ${config.transport} transport`);
        }
        
        // Validate URL format
        if (httpUrl) {
          try {
            new URL(httpUrl);
          } catch {
            errors.push(`Invalid URL: ${httpUrl}`);
          }
        }
        break;

      default:
        // 未知 transport 必须报错：createAdapter 遇到它会抛 Unsupported transport type，
        // 若这里放过，写配置的入口就会把一个永远加载不了的条目落盘
        // （界面上多一个永远连不上的死服务器，而接口回的是「成功」）。
        errors.push(
          `Unsupported transport type: ${String(config.transport)} (expected stdio / http-sse / streamable-http)`
        );
        break;
    }

    // 字段类型校验：JSON 粘贴（AddServerModal 会原样展开粘贴内容）与外部工具
    // 很容易给出类型不对的字段，而它们要到 spawn 时才炸，报出的还是
    // `this.config.args?.join is not a function` 这类内部错误，条目已落盘成为死条目。
    // 这里把「类型不对」在写入前挡掉。
    if (config.args !== undefined && !Array.isArray(config.args)) {
      errors.push(`args must be an array of strings, got ${typeof config.args}`);
    } else if (Array.isArray(config.args) && config.args.some((a) => typeof a !== 'string')) {
      errors.push('args must contain only strings');
    }
    if (config.cwd !== undefined && typeof config.cwd !== 'string') {
      errors.push(`cwd must be a string, got ${typeof config.cwd}`);
    }
    if (config.env !== undefined && (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env))) {
      errors.push(`env must be an object, got ${config.env === null ? 'null' : Array.isArray(config.env) ? 'array' : typeof config.env}`);
    }
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      errors.push(`enabled must be a boolean, got ${typeof config.enabled}`);
    }
    // NaN 必须显式拒绝：typeof NaN === 'number'，而 NaN <= 0 / NaN < 0 都是 false，
    // 只查类型与范围会把它整个漏过去。CLI 的 parseInt('abc') 就产生 NaN，
    // JSON.stringify 再把它写成 null —— 落盘后 PUT /api/config 会永远 400。
    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || Number.isNaN(config.timeout))) {
      errors.push(`timeout must be a finite number, got ${Number.isNaN(config.timeout as number) ? 'NaN' : typeof config.timeout}`);
    }
    if (config.retries !== undefined && (typeof config.retries !== 'number' || Number.isNaN(config.retries))) {
      errors.push(`retries must be a finite number, got ${Number.isNaN(config.retries as number) ? 'NaN' : typeof config.retries}`);
    }
    if (
      config.toolsConfig !== undefined &&
      (typeof config.toolsConfig !== 'object' || config.toolsConfig === null || Array.isArray(config.toolsConfig))
    ) {
      errors.push(`toolsConfig must be an object, got ${config.toolsConfig === null ? 'null' : Array.isArray(config.toolsConfig) ? 'array' : typeof config.toolsConfig}`);
    }

    // Timeout config validation
    if (typeof config.timeout === 'number' && !Number.isNaN(config.timeout) && config.timeout <= 0) {
      errors.push('Timeout must be a positive number');
    }

    if (typeof config.retries === 'number' && !Number.isNaN(config.retries) && config.retries < 0) {
      errors.push('Retries must be a non-negative number');
    }

    return errors;
  }

  /**
   * Validate environment variable configuration
   */
  static validateEnvironmentVariables(env?: Record<string, string>): string[] {
    const errors: string[] = [];

    if (!env) {
      return errors;
    }

    for (const [key, value] of Object.entries(env)) {
      // 名称判据必须与 Node 的 spawn 实际约束一致：只禁止含 '=' 或 NUL 的名称。
      // 此前要求「字母/下划线开头、仅字母数字下划线」，会把 Node 完全接受的
      // 名称（如 `my.var`）判为非法 —— 于是从一个合法 Claude 配置导入的条目
      // 过不了自己的校验，进而让整份配置在 PUT /api/config 处被拒（界面从此存不了盘）。
      if (key.includes('=') || key.includes('\0')) {
        errors.push(`Invalid environment variable name: '${key}' (must not contain '=' or NUL)`);
      }

      // 值类型：Node 会把非字符串强制转换（实测 env:{PORT:3000} 子进程读到 "3000"），
      // 故 number/boolean 也应接受，只有对象/数组/函数这类无法有意义转换的才拒绝。
      const t = typeof value;
      if (value === null || (t !== 'string' && t !== 'number' && t !== 'boolean')) {
        errors.push(`Environment variable '${key}' must be a string (or number/boolean), got ${value === null ? 'null' : t}`);
      }

      // Check for empty values
      if (key.trim() === '') {
        errors.push('Environment variable names cannot be empty');
      }

      // Security check: warn about sensitive information (now only log warnings, do not block config)
      const warnings = this.checkSensitiveEnvVar(key, value as string);
      if (warnings.length > 0) {
        // Output security warnings to console, but do not treat as validation errors
        warnings.forEach(warning => {
          console.warn(`[SECURITY WARNING] ${warning} for server configuration`);
        });
      }

      // Check environment variable name length
      if (key.length > 255) {
        errors.push(`Environment variable name '${key}' is too long (max 255 characters)`);
      }

      // Check value length (avoid excessively large values)
      if (value && value.length > 10000) {
        errors.push(`Environment variable '${key}' value is too long (max 10000 characters)`);
      }
    }

    return errors;
  }

  /**
   * Check for sensitive environment variables
   */
  static checkSensitiveEnvVar(key: string, value: string): string[] {
    const warnings: string[] = [];
    const lowerKey = key.toLowerCase();

    // Check if variable name contains sensitive keywords
    const containsSensitiveKeyword = this.sensitiveKeywords.some(keyword => 
      lowerKey.includes(keyword.toLowerCase())
    );

    if (containsSensitiveKeyword) {
      warnings.push(`Environment variable '${key}' appears to contain sensitive information`);
      
      // Check if value might be plain text password/key
      if (value && value.length > 0) {
        // Check if it's an obvious test value
        const testValues = ['test', 'demo', 'example', 'placeholder', 'your-key-here', 'replace-me'];
        const isTestValue = testValues.some(test => value.toLowerCase().includes(test));
        
        if (isTestValue) {
          warnings.push(`Environment variable '${key}' contains test/placeholder value. Please use real credentials.`);
        }
        
        // Check if value is too short (may not be a real key)
        if (value.length < 8) {
          warnings.push(`Environment variable '${key}' value seems too short for a secure credential`);
        }
      }
    }

    return warnings;
  }

  static getSupportedTransports(): string[] {
    return ['stdio', 'http-sse', 'streamable-http'];
  }

  static getTransportRequirements(transport: string): string[] {
    switch (transport) {
      case 'stdio':
        return ['command'];
      
      case 'http-sse':
      case 'streamable-http':
        return ['endpoint'];
      
      default:
        return [];
    }
  }
}