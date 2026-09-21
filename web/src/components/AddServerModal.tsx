import React, { useState } from 'react';
import { X, FileText, Settings, Plus, Trash2 } from 'lucide-react';
import { useConfigStore } from '../store/configStore';
import { ServerConfig } from '../types/config';
import { apiClient } from '../utils/api';

// Server name validation pattern
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9\-_]+$/;

export const AddServerModal: React.FC = () => {
  const [addMode, setAddMode] = useState<'json' | 'form'>('json');
  const [jsonConfig, setJsonConfig] = useState('');
  const [serverName, setServerName] = useState('');
  const [serverConfig, setServerConfig] = useState<Partial<ServerConfig>>({
    enabled: true,
    transport: 'stdio',
    toolsConfig: { mode: 'all' }
  });
  const [jsonError, setJsonError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nameValidation, setNameValidation] = useState<{ valid: boolean; error?: string; suggestions?: string[] }>({ valid: true });
  
  const { hideAddServer, addServer, saving } = useConfigStore();

  // Validate server name with real-time feedback
  const validateServerName = (name: string) => {
    if (!name || name.trim() === '') {
      return { valid: false, error: '服务器名称不能为空' };
    }

    if (name.length > 50) {
      return { valid: false, error: '服务器名称过长（最多 50 个字符）' };
    }

    if (!SERVER_NAME_PATTERN.test(name)) {
      const suggestions = generateNameSuggestions(name);
      return {
        valid: false,
        error: '服务器名称只能包含字母、数字、连字符和下划线',
        suggestions
      };
    }

    return { valid: true };
  };

  // Generate suggestions for invalid names
  const generateNameSuggestions = (invalidName: string): string[] => {
    const suggestions: string[] = [];

    // Remove special characters and replace with hyphens
    let cleaned = invalidName
      .replace(/[^a-zA-Z0-9\-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (cleaned && SERVER_NAME_PATTERN.test(cleaned)) {
      suggestions.push(cleaned);
    }

    // Convert to lowercase and replace spaces with hyphens
    let lowerCase = invalidName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-_]/g, '');

    if (lowerCase && SERVER_NAME_PATTERN.test(lowerCase)) {
      suggestions.push(lowerCase);
    }

    return suggestions.slice(0, 3);
  };

  // Handle server name input with real-time validation
  const handleServerNameChange = (value: string) => {
    setServerName(value);
    setNameValidation(validateServerName(value));
  };

  // JSON parsing and validation function
  const parseJsonConfig = (jsonText: string) => {
    setJsonError('');
    
    if (!jsonText.trim()) {
      setJsonError('请输入配置 JSON');
      return null;
    }

    try {
      const parsed = JSON.parse(jsonText);
      
      // Support multiple JSON formats
      let servers: Record<string, any> = {};
      
      if (parsed.mcpServers) {
        // Claude Desktop format: { "mcpServers": { "server-name": {...} } }
        servers = parsed.mcpServers;
      } else if (parsed.servers) {
        // MCPDog format: { "servers": { "server-name": {...} } }
        servers = parsed.servers;
      } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Direct server configuration: { "server-name": {...} }
        servers = parsed;
      } else {
        setJsonError('配置格式无效。请提供有效的 MCP 服务器配置 JSON');
        return null;
      }

      const serverEntries = Object.entries(servers);
      if (serverEntries.length === 0) {
        setJsonError('配置中未找到任何服务器');
        return null;
      }

      return serverEntries.map(([name, config]) => ({ name, config }));
    } catch (error) {
      setJsonError(`JSON 解析错误: ${(error as Error).message}`);
      return null;
    }
  };

  // Validate server configuration
  const validateServerConfig = (name: string, config: any) => {
    const errors: string[] = [];

    // Use the same validation as form mode
    const nameValidation = validateServerName(name);
    if (!nameValidation.valid) {
      errors.push(`服务器名称 "${name}": ${nameValidation.error}`);
    }

    if (!config.command && !config.endpoint && !config.url) {
      errors.push(`服务器 "${name}" 缺少命令或 URL 字段`);
    }

    if (config.args && !Array.isArray(config.args)) {
      errors.push(`服务器 "${name}" 的 args 必须是数组`);
    }

    if (config.env && typeof config.env !== 'object') {
      errors.push(`服务器 "${name}" 的 env 必须是对象`);
    }

    return errors;
  };

  const handleConfigChange = (field: string, value: any) => {
    setServerConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  // Environment variable management functions
  const handleEnvChange = (index: number, field: 'key' | 'value', newValue: string) => {
    const currentEnv = serverConfig.env || {};
    const envEntries = Object.entries(currentEnv);
    
    if (field === 'key') {
      const oldKey = envEntries[index]?.[0];
      const value = envEntries[index]?.[1] || '';
      const newEnv = { ...currentEnv };
      
      // Delete old key
      if (oldKey) delete newEnv[oldKey];
      
      // Add new key (if valid)
      if (newValue.trim() && isValidEnvVarName(newValue)) {
        newEnv[newValue] = value;
      }
      
      handleConfigChange('env', newEnv);
    } else {
      const key = envEntries[index]?.[0];
      if (key) {
        handleConfigChange('env', { ...currentEnv, [key]: newValue });
      }
    }
  };

  // Validate environment variable name
  const isValidEnvVarName = (name: string): boolean => {
    // 判据必须与后端 AdapterFactory.validateEnvironmentVariables 一致：
    // Node 的 spawn 只要求名称不含 '=' 与 NUL，含点号等字符完全合法。
    // 界面若比后端更严，用户从 Claude 配置导入（或手工添加）一个带点号的名称后
    // 会存不了盘 —— 保存被这个校验直接挡回，而后端其实是接受的。
    return name.length > 0 && !name.includes('=') && !name.includes('\0');
  };

  const addEnvVar = () => {
    const currentEnv = serverConfig.env || {};
    // Create a temporary unique key for new environment variable
    let newKey = 'NEW_VAR';
    let counter = 1;
    while (currentEnv[newKey]) {
      newKey = `NEW_VAR_${counter}`;
      counter++;
    }
    const newEnv = { ...currentEnv, [newKey]: '' };
    handleConfigChange('env', newEnv);
  };

  const removeEnvVar = (index: number) => {
    const currentEnv = serverConfig.env || {};
    const envEntries = Object.entries(currentEnv);
    const keyToRemove = envEntries[index]?.[0];
    if (keyToRemove !== undefined) {
      const newEnv = { ...currentEnv };
      delete newEnv[keyToRemove];
      handleConfigChange('env', newEnv);
    }
  };

  // Headers management functions (similar to environment variables)
  const handleHeaderChange = (index: number, field: 'key' | 'value', newValue: string) => {
    const currentHeaders = serverConfig.headers || {};
    const headerEntries = Object.entries(currentHeaders);
    
    if (field === 'key') {
      const oldKey = headerEntries[index]?.[0];
      const value = headerEntries[index]?.[1] || '';
      const newHeaders = { ...currentHeaders };
      
      // Delete old key
      if (oldKey) delete newHeaders[oldKey];
      
      // Add new key (if valid)
      if (newValue.trim()) {
        newHeaders[newValue] = value;
      }
      
      handleConfigChange('headers', newHeaders);
    } else {
      const key = headerEntries[index]?.[0];
      if (key) {
        handleConfigChange('headers', { ...currentHeaders, [key]: newValue });
      }
    }
  };

  const addHeader = () => {
    const currentHeaders = serverConfig.headers || {};
    // Create a temporary unique key for new header
    let newKey = 'Header-Name';
    let counter = 1;
    while (currentHeaders[newKey]) {
      newKey = `Header-Name-${counter}`;
      counter++;
    }
    const newHeaders = { ...currentHeaders, [newKey]: '' };
    handleConfigChange('headers', newHeaders);
  };

  const removeHeader = (index: number) => {
    const currentHeaders = serverConfig.headers || {};
    const headerEntries = Object.entries(currentHeaders);
    const keyToRemove = headerEntries[index]?.[0];
    
    if (keyToRemove) {
      const newHeaders = { ...currentHeaders };
      delete newHeaders[keyToRemove];
      handleConfigChange('headers', Object.keys(newHeaders).length > 0 ? newHeaders : undefined);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (addMode === 'json') {
      // JSON mode processing
      const parsedServers = parseJsonConfig(jsonConfig);
      if (!parsedServers) return;

      // Check existing server names
      let existingNames: string[] = [];
      try {
        const servers = await apiClient.get('/api/servers');
        existingNames = Object.keys(servers);
      } catch (error) {
        console.warn('无法检查服务器名称重复:', error);
      }

      // Validate all server configurations
      const errors: string[] = [];
      const conflictNames: string[] = [];
      
      for (const { name, config } of parsedServers) {
        const configErrors = validateServerConfig(name, config);
        errors.push(...configErrors);
        
        if (existingNames.includes(name)) {
          conflictNames.push(name);
        }
      }

      if (conflictNames.length > 0) {
        setJsonError(`❌ 检测到服务器名称冲突！\n\n以下服务器名称已存在:\n${conflictNames.map(name => `• ${name}`).join('\n')}\n\n请为这些服务器选择其他名称。`);
        return;
      }

      if (errors.length > 0) {
        setJsonError(`❌ 发现配置错误:\n\n${errors.join('\n')}`);
        return;
      }

      // Add all servers
      try {
        for (const { name, config } of parsedServers) {
          // Ensure all required fields exist, including transport
          // Prioritize user-specified transport, otherwise infer from configuration
          let transport = config.transport;
          if (!transport) {
            if (config.url || config.endpoint) {
              // Has URL/endpoint field
              if (config.type === 'sse' || config.transport === 'http-sse') {
                transport = 'http-sse';
              } else {
                transport = 'streamable-http';  // Default HTTP transport
              }
            } else if (config.command) {
              // Has command field
              transport = 'stdio';
            } else {
              // Fallback to stdio if neither URL nor command is specified
              transport = 'stdio';
            }
          }
          const enabled = config.enabled !== undefined ? config.enabled : true;
          
          const finalConfig: any = {
            ...config, // Apply original config first
            name: name, // Ensure name is correct
            enabled,    // Set enabled status
            transport,  // Set transport type
            toolsConfig: { mode: 'all' } // Set tool configuration
          };
          
          console.log('[AddServerModal] Adding server from JSON:', name, finalConfig);
          await addServer(name, finalConfig);
        }
        console.log('[AddServerModal] All servers added successfully');
        hideAddServer();
      } catch (error) {
        console.error('添加服务器失败:', error);
        const errorMessage = (error as Error).message;
        if (errorMessage.includes('already exists')) {
          setJsonError(`❌ 服务器名称冲突！\n\n已存在同名服务器。请选择其他名称。`);
        } else {
          setJsonError(`❌ 添加服务器失败:\n\n${errorMessage}`);
        }
      }
    } else {
      // Form mode processing
      if (!serverName.trim()) {
        alert('请输入服务器名称');
        return;
      }

      if (!nameValidation.valid) {
        alert(`服务器名称无效: ${nameValidation.error}`);
        return;
      }

      try {
        const servers = await apiClient.get('/api/servers');
        const existingNames = Object.keys(servers);

        if (existingNames.includes(serverName.trim())) {
          alert(`❌ 服务器名称 "${serverName.trim()}" 已存在！\n\n请选择其他名称。`);
          return;
        }
      } catch (error) {
        console.warn('无法检查服务器名称重复:', error);
      }

      const finalConfig: any = {
        name: serverName,
        ...serverConfig
      };

      try {
        console.log('[AddServerModal] 通过表单添加服务器:', serverName, finalConfig);
        await addServer(serverName, finalConfig);
        console.log('[AddServerModal] 服务器添加成功');
        hideAddServer();
      } catch (error) {
        console.error('添加服务器失败:', error);
        const errorMessage = (error as Error).message;
        if (errorMessage.includes('already exists')) {
          alert(`❌ 服务器名称冲突！\n\n已存在名为 "${serverName}" 的服务器。请选择其他名称。`);
        } else {
          alert(`❌ 添加服务器失败:\n\n${errorMessage}`);
        }
      }
    }
  };

  const isStdio = serverConfig.transport === 'stdio';

  return (
    <div className="modal modal-open">
      <div className="modal-box w-full max-w-4xl h-[90vh] max-h-none bg-base-100">
        {/* Modal header */}
        <div className="flex items-center justify-between pb-6 border-b border-base-300">
          <div>
            <h2 className="text-xl font-bold text-base-content">添加 MCP 服务器</h2>
            <p className="text-sm text-base-content/70 mt-1">配置一个新的 MCP 服务器</p>
          </div>
          <button
            onClick={hideAddServer}
            className="btn btn-ghost btn-sm btn-circle"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="py-6 max-h-[600px] overflow-y-auto">
          {/* Mode switching */}
          <div className="tabs tabs-boxed mb-6">
            <button
              type="button"
              onClick={() => setAddMode('json')}
              className={`tab flex items-center gap-2 ${
                addMode === 'json' ? 'tab-active' : ''
              }`}
            >
              <FileText className="h-4 w-4" />
              <span>JSON 配置</span>
            </button>
            <button
              type="button"
              onClick={() => setAddMode('form')}
              className={`tab flex items-center gap-2 ${
                addMode === 'form' ? 'tab-active' : ''
              }`}
            >
              <Settings className="h-4 w-4" />
              <span>表单配置</span>
            </button>
          </div>

          {addMode === 'json' ? (
            // JSON Configuration Mode
            <div className="space-y-4">
              <div>
                <label className="label">
                  <span className="label-text font-medium">服务器配置（JSON）</span>
                </label>
                <textarea
                  value={jsonConfig}
                  onChange={(e) => setJsonConfig(e.target.value)}
                  rows={12}
                  className="textarea textarea-bordered w-full font-mono text-sm"
                  placeholder={`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}`}
                />
                {jsonError && (
                  <div className="alert alert-error mt-2">
                    <div className="text-sm whitespace-pre-wrap">
                      {jsonError}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Form Configuration Mode
            <div className="space-y-6">
              {/* Basic Information */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <h4 className="card-title text-base">基本信息</h4>
                  <div className="space-y-4">
                    <div>
                      <label className="label">
                        <span className="label-text font-medium">服务器名称 *</span>
                      </label>
                      <input
                        type="text"
                        value={serverName}
                        onChange={(e) => handleServerNameChange(e.target.value)}
                        className={`input input-bordered w-full ${
                          !nameValidation.valid ? 'input-error' : ''
                        }`}
                        placeholder="例如：playwright, filesystem-server"
                      />
                      {!nameValidation.valid && (
                        <div className="mt-2 text-error text-sm">
                          {nameValidation.error}
                          {nameValidation.suggestions && nameValidation.suggestions.length > 0 && (
                            <div className="mt-1">
                              <span className="text-base-content/70">建议: </span>
                              {nameValidation.suggestions.map((suggestion, index) => (
                                <button
                                  key={index}
                                  type="button"
                                  onClick={() => handleServerNameChange(suggestion)}
                                  className="btn btn-link btn-xs p-0 mr-2"
                                >
                                  {suggestion}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="label">
                        <span className="label-text-alt">仅允许字母、数字、连字符和下划线</span>
                      </div>
                    </div>

                    <div>
                      <label className="label">
                        <span className="label-text font-medium">传输协议</span>
                      </label>
                      <select
                        value={serverConfig.transport}
                        onChange={(e) => handleConfigChange('transport', e.target.value)}
                        className="select select-bordered w-full"
                      >
                        <option value="stdio">Stdio</option>
                        <option value="http-sse">HTTP SSE</option>
                        <option value="streamable-http">Streamable HTTP</option>
                      </select>
                    </div>

                    <div>
                      <label className="label">
                        <span className="label-text font-medium">描述</span>
                      </label>
                      <textarea
                        value={serverConfig.description || ''}
                        onChange={(e) => handleConfigChange('description', e.target.value)}
                        rows={2}
                        className="textarea textarea-bordered w-full"
                        placeholder="可选的服务器描述..."
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Connection Configuration */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <h4 className="card-title text-base">连接配置</h4>

                  {isStdio ? (
                    <div className="space-y-4">
                      <div>
                        <label className="label">
                          <span className="label-text font-medium">命令 *</span>
                        </label>
                        <input
                          type="text"
                          value={serverConfig.command || ''}
                          onChange={(e) => handleConfigChange('command', e.target.value)}
                          className="input input-bordered w-full"
                          placeholder="例如：npx, node, python"
                        />
                      </div>

                      <div>
                        <label className="label">
                          <span className="label-text font-medium">参数（每行一个）</span>
                        </label>
                        <textarea
                          value={serverConfig.args?.join('\n') || ''}
                          onChange={(e) => handleConfigChange('args', e.target.value.split('\n').filter(Boolean))}
                          rows={3}
                          className="textarea textarea-bordered w-full"
                          placeholder="例如：\n@modelcontextprotocol/server-filesystem\n/path/to/directory"
                        />
                      </div>

                      <div>
                        <label className="label">
                          <span className="label-text font-medium">环境变量</span>
                        </label>
                        <div className="space-y-2">
                          {Object.entries(serverConfig.env || {}).map(([key, value], index) => (
                            <div key={index} className="flex gap-2">
                              <input
                                type="text"
                                value={key}
                                onChange={(e) => handleEnvChange(index, 'key', e.target.value)}
                                className="input input-bordered input-sm flex-1"
                                placeholder="变量名"
                              />
                              <input
                                type="text"
                                value={value}
                                onChange={(e) => handleEnvChange(index, 'value', e.target.value)}
                                className="input input-bordered input-sm flex-1"
                                placeholder="值"
                              />
                              <button
                                type="button"
                                onClick={() => removeEnvVar(index)}
                                className="btn btn-ghost btn-sm btn-square text-error"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={addEnvVar}
                            className="btn btn-ghost btn-sm gap-2"
                          >
                            <Plus className="h-4 w-4" />
                            <span>添加环境变量</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <label className="label">
                          <span className="label-text font-medium">URL *</span>
                        </label>
                        <input
                          type="url"
                          value={serverConfig.url || serverConfig.endpoint || ''}
                          onChange={(e) => handleConfigChange('url', e.target.value)}
                          className="input input-bordered w-full"
                          placeholder="例如：https://api.example.com/mcp"
                        />
                      </div>

                      <div>
                        <label className="label">
                          <span className="label-text font-medium">请求头</span>
                        </label>
                        <div className="space-y-2">
                          {Object.entries(serverConfig.headers || {}).map(([key, value], index) => (
                            <div key={index} className="flex gap-2">
                              <input
                                type="text"
                                value={key}
                                onChange={(e) => handleHeaderChange(index, 'key', e.target.value)}
                                className="input input-bordered input-sm flex-1"
                                placeholder="Header 名称"
                              />
                              <input
                                type="text"
                                value={value as string}
                                onChange={(e) => handleHeaderChange(index, 'value', e.target.value)}
                                className="input input-bordered input-sm flex-1"
                                placeholder="Header 值"
                              />
                              <button
                                type="button"
                                onClick={() => removeHeader(index)}
                                className="btn btn-ghost btn-sm btn-square text-error"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={addHeader}
                            className="btn btn-ghost btn-sm gap-2"
                          >
                            <Plus className="h-4 w-4" />
                            <span>添加请求头</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Advanced Options */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="card-title text-base">高级选项</h4>
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="btn btn-ghost btn-sm"
                    >
                      {showAdvanced ? '隐藏' : '显示'}高级
                    </button>
                  </div>

                  {showAdvanced && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="label">
                            <span className="label-text font-medium">超时（毫秒）</span>
                          </label>
                          <input
                            type="number"
                            value={serverConfig.timeout || ''}
                            onChange={(e) => {
                              // 挡住 NaN：后端会拒绝非数字的 timeout（NaN 序列化成 null）
                              const n = parseInt(e.target.value, 10);
                              handleConfigChange('timeout', Number.isNaN(n) ? undefined : n);
                            }}
                            className="input input-bordered w-full"
                            placeholder="30000"
                          />
                        </div>
                        <div>
                          <label className="label">
                            <span className="label-text font-medium">重试次数</span>
                          </label>
                          <input
                            type="number"
                            value={serverConfig.retries || ''}
                            onChange={(e) => {
                              const n = parseInt(e.target.value, 10);
                              handleConfigChange('retries', Number.isNaN(n) ? undefined : n);
                            }}
                            className="input input-bordered w-full"
                            placeholder="3"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Submit Button */}
          <div className="modal-action pt-6 border-t border-base-300">
            <button
              type="button"
              onClick={hideAddServer}
              className="btn btn-ghost"
            >
              取消
            </button>
            <button
              type="submit"
              onClick={handleSubmit}
              disabled={saving || (addMode === 'form' && !nameValidation.valid)}
              className="btn btn-primary"
            >
              {saving ? '添加中...' : '添加服务器'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};