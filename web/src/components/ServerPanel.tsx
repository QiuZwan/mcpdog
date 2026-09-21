import React, { useState, useEffect } from 'react';
import {
  Settings,
  Trash2,
  Save,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Loader2,
  Zap,
  Plus,
  ExternalLink
} from 'lucide-react';
import { useConfigStore } from '../store/configStore';
import { ServerWithTools } from '../types/config';
import { ToolsPanel } from './ToolsPanel';
import { ServerLogs } from './ServerLogs';
import { apiClient } from '../utils/api';

// Server name validation pattern
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9\-_]+$/;

interface ServerPanelProps {
  server: ServerWithTools;
  refreshServerTools: (serverName?: string) => void;
}

export const ServerPanel: React.FC<ServerPanelProps> = ({ server, refreshServerTools }) => {
  const [activeTab, setActiveTab] = useState<'config' | 'tools' | 'logs'>('tools');
  const [isEditing, setIsEditing] = useState(false);
  const [editedConfig, setEditedConfig] = useState<any>(server);
  const [isToggling, setIsToggling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [nameValidation, setNameValidation] = useState<{ valid: boolean; error?: string; suggestions?: string[] }>({ valid: true });
  
  const { 
    updateServerConfig, 
    toggleServer, 
    removeServer, 
    saving 
  } = useConfigStore();

  // Reset editing state when server changes
  useEffect(() => {
    setEditedConfig(server);
    setIsEditing(false);
    setNameValidation({ valid: true });
    setActiveTab('tools'); // Switch to Tool List tab when server changes
  }, [server.name]); // Use server.name as dependency to detect server changes

  // Auto-enter edit mode when switching to config tab
  useEffect(() => {
    if (activeTab === 'config') {
      setIsEditing(true);
    }
  }, [activeTab]);

  // Validate server name
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

  const handleToggleServer = async () => {
    setIsToggling(true);
    try {
      await toggleServer(server?.name || '', () => refreshServerTools(server?.name));
      // Status will be automatically updated through global store
    } catch (error) {
      console.error('切换服务器状态失败:', error);
    } finally {
      // Delay removing loading state to give user time to see connection process
      setTimeout(() => {
        setIsToggling(false);
      }, 1500);
    }
  };

  // 重试连接：复用启用开关的重连机制——禁用移除旧适配器，再启用重建并发起连接
  const handleRetryConnection = async () => {
    if (!server?.name || isRetrying) {
      return;
    }
    setIsRetrying(true);
    try {
      if (server.enabled) {
        await toggleServer(server?.name || '');
      }
      await toggleServer(server?.name || '', () => refreshServerTools(server?.name));
    } catch (error) {
      console.error('重试连接失败:', error);
      alert(`重试连接失败: ${(error as Error).message}`);
    } finally {
      setTimeout(() => {
        setIsRetrying(false);
      }, 1500);
    }
  };

  const handleSave = async () => {
    // Validate server name if it has changed
    if (editedConfig.name !== server.name) {
      const validation = validateServerName(editedConfig.name);
      if (!validation.valid) {
        alert(`服务器名称无效: ${validation.error}`);
        return;
      }

      // Check for name conflicts with other servers
      try {
        const servers = await apiClient.get('/api/servers');
        const existingNames = Object.keys(servers);
        const otherNames = existingNames.filter(name => name !== server.name);

        if (otherNames.includes(editedConfig.name)) {
          alert(`服务器名称 "${editedConfig.name}" 已存在`);
          return;
        }
      } catch (error) {
        console.warn('无法检查服务器名称冲突:', error);
      }
    }

    // Validate environment variables
    if (editedConfig.env && editedConfig.transport === 'stdio') {
      const envEntries = Object.entries(editedConfig.env);
      const invalidEnvVars = envEntries.filter(([key]) => !key.trim() || !isValidEnvVarName(key));
      const envKeys = envEntries.map(([key]) => key);
      const duplicateKeys = envKeys.filter((key, index) => envKeys.indexOf(key) !== index);

      if (invalidEnvVars.length > 0) {
        alert('请修正无效的环境变量名称');
        return;
      }

      if (duplicateKeys.length > 0) {
        alert('环境变量名称不能重复');
        return;
      }
    }
    
    // Clean up empty environment variables
    const cleanedConfig = { ...editedConfig };
    if (cleanedConfig.env) {
      const cleanedEnv: Record<string, string> = {};
      Object.entries(cleanedConfig.env).forEach(([key, value]) => {
        if (key.trim() && isValidEnvVarName(key)) {
          cleanedEnv[key] = String(value);
        }
      });
      // 空对象而不是 undefined：undefined 会被 JSON.stringify 丢掉键，
      // 服务端按「合并」处理时就会保留旧值 —— 表现为「删掉最后一个环境变量并保存」
      // 回了成功却什么都没改。显式空对象才能真正清空。
      cleanedConfig.env = cleanedEnv;
    }
    
    try {
      console.log('[ServerPanel] Saving server config:', server?.name, cleanedConfig);
      console.log('[ServerPanel] Environment variables:', cleanedConfig.env);
      
      // Call the dedicated server update API endpoint
      const data = await apiClient.put(`/api/servers/${server?.name}`, cleanedConfig);
      console.log('[ServerPanel] Server updated successfully:', data);
      
      // Update local state with the response data
      if (data.server) {
        updateServerConfig(server?.name || '', data.server);
      }
      
      console.log('[ServerPanel] Config saved successfully');
      setIsEditing(false);
    } catch (error) {
      console.error('更新服务器配置失败:', error);
      alert(`❌ 保存配置失败:\n\n${(error as Error).message}`);
    }
  };

  const handleInputChange = (field: string, value: any) => {
    const newConfig = { ...editedConfig, [field]: value };
    setEditedConfig(newConfig);
    
    // Validate name if it's being changed
    if (field === 'name') {
      setNameValidation(validateServerName(value));
    }
  };

  // Environment variable management functions
  const handleEnvChange = (index: number, field: 'key' | 'value', newValue: string) => {
    const currentEnv = editedConfig.env || {};
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
      
      setEditedConfig({ ...editedConfig, env: newEnv });
    } else {
      const key = envEntries[index]?.[0];
      if (key) {
        setEditedConfig({ 
          ...editedConfig, 
          env: { ...currentEnv, [key]: newValue } 
        });
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
    const currentEnv = editedConfig.env || {};
    // Create a temporary unique key for new environment variable
    let newKey = 'NEW_VAR';
    let counter = 1;
    while (currentEnv[newKey]) {
      newKey = `NEW_VAR_${counter}`;
      counter++;
    }
    const newEnv = { ...currentEnv, [newKey]: '' };
    setEditedConfig({ ...editedConfig, env: newEnv });
  };

  const removeEnvVar = (index: number) => {
    const currentEnv = editedConfig.env || {};
    const envEntries = Object.entries(currentEnv);
    const keyToRemove = envEntries[index]?.[0];
    if (keyToRemove !== undefined) {
      const newEnv = { ...currentEnv };
      delete newEnv[keyToRemove];
      setEditedConfig({ ...editedConfig, env: newEnv });
    }
  };

  // Headers management functions (similar to environment variables)
  const handleHeaderChange = (index: number, field: 'key' | 'value', newValue: string) => {
    const currentHeaders = editedConfig.headers || {};
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
      
      setEditedConfig({ ...editedConfig, headers: newHeaders });
    } else {
      const key = headerEntries[index]?.[0];
      if (key) {
        setEditedConfig({ 
          ...editedConfig, 
          headers: { ...currentHeaders, [key]: newValue } 
        });
      }
    }
  };

  const addHeader = () => {
    const currentHeaders = editedConfig.headers || {};
    // Create a temporary unique key for new header
    let newKey = 'Header-Name';
    let counter = 1;
    while (currentHeaders[newKey]) {
      newKey = `Header-Name-${counter}`;
      counter++;
    }
    const newHeaders = { ...currentHeaders, [newKey]: '' };
    setEditedConfig({ ...editedConfig, headers: newHeaders });
  };

  const removeHeader = (index: number) => {
    const currentHeaders = editedConfig.headers || {};
    const headerEntries = Object.entries(currentHeaders);
    const keyToRemove = headerEntries[index]?.[0];
    
    if (keyToRemove) {
      const newHeaders = { ...currentHeaders };
      delete newHeaders[keyToRemove];
      // 同上：undefined 会被 JSON 丢掉，服务端合并后旧 header 仍在（假成功）
      setEditedConfig({ ...editedConfig, headers: newHeaders });
    }
  };

  const handleRemoveServer = async () => {
    if (!confirm(`确定要删除服务器 "${server?.name}" 吗？`)) {
      return;
    }

    try {
      await removeServer(server?.name || '');
      console.log('[ServerPanel] 服务器删除成功');
    } catch (error) {
      console.error('删除服务器失败:', error);
      alert(`删除服务器失败: ${(error as Error).message}`);
    }
  };

  const isStdio = editedConfig.transport === 'stdio';

  return (
    <div className="flex flex-col h-full">
      {/* Server header */}
      <div className="flex items-center justify-between p-6 border-b border-base-300 bg-base-100">
        <div className="flex items-center space-x-4">
          <div>
            <h2 className="text-xl font-bold text-base-content flex items-center gap-3">
              {server?.name}
              <span className={`badge ${
                server?.transport === 'stdio' ? 'badge-info' :
                server?.transport === 'http-sse' ? 'badge-success' :
                'badge-secondary'
              }`}>
                {server?.transport || '未知'}
              </span>
            </h2>
            <p className="text-sm text-base-content/70 mt-1">
              {server?.description || '无描述'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* 打开子 server 自带管理页（可选 adminUrl） */}
          {server?.adminUrl && (
            <a
              href={server.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="打开该 MCP 自带的管理界面"
              className="btn btn-ghost btn-square"
            >
              <ExternalLink className="h-5 w-5" />
            </a>
          )}

          {/* Retry connection button */}
          <button
            onClick={handleRetryConnection}
            className="btn btn-ghost btn-square"
            title="重试连接"
            disabled={isRetrying}
          >
            {isRetrying ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <RefreshCw className="h-5 w-5" />
            )}
          </button>

          {/* Delete button */}
          <button
            onClick={handleRemoveServer}
            className="btn btn-ghost btn-square text-error"
            title="删除该 MCP"
          >
            <Trash2 className="h-5 w-5" />
          </button>

          {/* Toggle server button */}
          <button
            onClick={handleToggleServer}
            className={`btn btn-ghost btn-square ${
              server?.enabled
                ? 'text-success'
                : 'text-base-content/40'
            }`}
            title={server?.enabled ? '禁用该 MCP' : '启用该 MCP'}
            disabled={isToggling}
          >
            {isToggling ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : server?.enabled ? (
              <ToggleRight className="h-5 w-5" />
            ) : (
              <ToggleLeft className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-base-300">
        <div className="tabs tabs-bordered px-6">
          {[
            { id: 'tools', label: '工具列表', icon: Zap },
            { id: 'config', label: '服务器配置', icon: Settings },
            { id: 'logs', label: '运行日志', icon: RefreshCw }
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as any)}
              className={`tab tab-bordered flex items-center gap-2 ${
                activeTab === id ? 'tab-active' : ''
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'config' && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-medium text-base-content">服务器配置</h3>
              <div className="flex items-center space-x-2">
                {!isEditing ? (
                  <button
                    onClick={() => setIsEditing(true)}
                    className="btn btn-primary btn-sm"
                  >
                    编辑配置
                  </button>
                ) : (
                  <button
                    onClick={handleSave}
                    disabled={saving || !nameValidation.valid}
                    className="btn btn-primary btn-sm flex items-center gap-2"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? '保存中...' : '保存'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-6">
              {/* Basic configuration */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <h4 className="card-title text-base-content">基本信息</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">服务器名称</span>
                      </label>
                      <input
                        type="text"
                        value={editedConfig.name}
                        onChange={(e) => handleInputChange('name', e.target.value)}
                        disabled={!isEditing}
                        className={`input input-bordered w-full ${
                          nameValidation.valid 
                            ? '' 
                            : 'input-error'
                        }`}
                      />
                      {!nameValidation.valid && isEditing && (
                        <label className="label">
                          <span className="label-text-alt text-error">
                            {nameValidation.error}
                          </span>
                        </label>
                      )}
                    </div>
                    
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">传输协议</span>
                      </label>
                      <select
                        value={editedConfig.transport}
                        onChange={(e) => handleInputChange('transport', e.target.value)}
                        disabled={!isEditing}
                        className="select select-bordered w-full"
                      >
                        <option value="stdio">Stdio</option>
                        <option value="http-sse">HTTP SSE</option>
                        <option value="streamable-http">Streamable HTTP</option>
                      </select>
                    </div>
                    
                    <div className="col-span-2 form-control">
                      <label className="label">
                        <span className="label-text">描述</span>
                      </label>
                      <textarea
                        value={editedConfig.description || ''}
                        onChange={(e) => handleInputChange('description', e.target.value)}
                        disabled={!isEditing}
                        rows={2}
                        className="textarea textarea-bordered w-full"
                        placeholder="服务器描述..."
                      />
                    </div>

                    <div className="col-span-2 form-control">
                      <label className="label">
                        <span className="label-text">管理界面地址（可选）</span>
                      </label>
                      <input
                        type="url"
                        value={editedConfig.adminUrl || ''}
                        onChange={(e) => handleInputChange('adminUrl', e.target.value)}
                        disabled={!isEditing}
                        className="input input-bordered w-full"
                        placeholder="如 http://127.0.0.1:61823/admin/ —— 该 MCP 自带管理界面的地址"
                      />
                      <label className="label">
                        <span className="label-text-alt">设置后，服务器标题旁会出现"打开管理页"按钮，直达该 MCP 自带的管理界面</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {/* Connection configuration */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <h4 className="card-title text-base-content">连接配置</h4>

                  {isStdio ? (
                    <div className="space-y-4">
                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">命令</span>
                        </label>
                        <input
                          type="text"
                          value={editedConfig.command || ''}
                          onChange={(e) => handleInputChange('command', e.target.value)}
                          disabled={!isEditing}
                          className="input input-bordered w-full"
                          placeholder="例如：npx, node, python"
                        />
                      </div>

                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">参数（每行一个）</span>
                        </label>
                        <textarea
                          value={editedConfig.args?.join('\n') || ''}
                          onChange={(e) => handleInputChange('args', e.target.value.split('\n').filter(Boolean))}
                          disabled={!isEditing}
                          rows={3}
                          className="textarea textarea-bordered w-full"
                          placeholder="例如：\n@modelcontextprotocol/server-filesystem\n/path/to/directory"
                        />
                      </div>

                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">环境变量</span>
                        </label>
                        <div className="space-y-2">
                          {Object.entries(editedConfig.env || {}).map(([key, value], index) => (
                            <div key={index} className="flex gap-2">
                              <input
                                type="text"
                                value={key}
                                onChange={(e) => handleEnvChange(index, 'key', e.target.value)}
                                disabled={!isEditing}
                                className="input input-bordered input-sm flex-1"
                                placeholder="变量名"
                              />
                              <input
                                type="text"
                                value={String(value)}
                                onChange={(e) => handleEnvChange(index, 'value', e.target.value)}
                                disabled={!isEditing}
                                className="input input-bordered input-sm flex-1"
                                placeholder="值"
                              />
                              {isEditing && (
                                <button
                                  type="button"
                                  onClick={() => removeEnvVar(index)}
                                  className="btn btn-ghost btn-sm btn-square text-error"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          ))}
                          {isEditing && (
                            <button
                              type="button"
                              onClick={addEnvVar}
                              className="btn btn-ghost btn-sm text-primary"
                            >
                              <Plus className="h-4 w-4" />
                              添加环境变量
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">URL</span>
                        </label>
                        <input
                          type="url"
                          value={editedConfig.url || editedConfig.endpoint || ''}
                          onChange={(e) => handleInputChange('url', e.target.value)}
                          disabled={!isEditing}
                          className="input input-bordered w-full"
                          placeholder="例如：https://api.example.com/mcp"
                        />
                      </div>

                      <div className="form-control">
                        <label className="label">
                          <span className="label-text">请求头</span>
                        </label>
                        <div className="space-y-2">
                          {Object.entries(editedConfig.headers || {}).map(([key, value], index) => (
                            <div key={index} className="flex gap-2">
                              <input
                                type="text"
                                value={key}
                                onChange={(e) => handleHeaderChange(index, 'key', e.target.value)}
                                disabled={!isEditing}
                                className="input input-bordered input-sm flex-1"
                                placeholder="Header 名称"
                              />
                              <input
                                type="text"
                                value={value as string}
                                onChange={(e) => handleHeaderChange(index, 'value', e.target.value)}
                                disabled={!isEditing}
                                className="input input-bordered input-sm flex-1"
                                placeholder="Header 值"
                              />
                              {isEditing && (
                                <button
                                  type="button"
                                  onClick={() => removeHeader(index)}
                                  className="btn btn-ghost btn-sm btn-square text-error"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          ))}
                          {isEditing && (
                            <button
                              type="button"
                              onClick={addHeader}
                              className="btn btn-ghost btn-sm text-primary"
                            >
                              <Plus className="h-4 w-4" />
                              添加请求头
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Advanced options - always show */}
              <div className="card bg-base-200">
                <div className="card-body">
                  <h4 className="card-title text-base-content">高级选项</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">超时（毫秒）</span>
                      </label>
                      <input
                        type="number"
                        value={editedConfig.timeout || ''}
                        onChange={(e) => {
                          // 空值写回默认值而不是 undefined：undefined 会被
                          // JSON.stringify 丢掉，服务端按合并处理时保留旧值 ——
                          // 表现为「清空超时并保存」回了成功却什么都没改。
                          const n = parseInt(e.target.value, 10);
                          handleInputChange('timeout', Number.isNaN(n) ? 30000 : n);
                        }}
                        disabled={!isEditing}
                        className="input input-bordered w-full"
                        placeholder="30000"
                      />
                    </div>
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">重试次数</span>
                      </label>
                      <input
                        type="number"
                        value={editedConfig.retries || ''}
                        onChange={(e) => {
                          // 同上：空值写回默认值，避免静默空操作
                          const n = parseInt(e.target.value, 10);
                          handleInputChange('retries', Number.isNaN(n) ? 3 : n);
                        }}
                        disabled={!isEditing}
                        className="input input-bordered w-full"
                        placeholder="3"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Save button at bottom */}
              {isEditing && (
                <div className="flex justify-end pt-4 border-t border-base-300">
                  <button
                    onClick={handleSave}
                    disabled={saving || !nameValidation.valid}
                    className="btn btn-primary btn-sm flex items-center gap-2"
                  >
                    <Save className="h-4 w-4" />
                    <span>{saving ? '保存中...' : '保存'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'tools' && (
          <ToolsPanel server={server} />
        )}

        {activeTab === 'logs' && (
          <ServerLogs serverName={server?.name} />
        )}
      </div>
    </div>
  );
};