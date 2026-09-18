import React, { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { useConfigStore } from '../store/configStore';

export const ClientConfigModal: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'http' | 'stdio'>('http');

  const { hideClientConfig, authRequired, authToken } = useConfigStore();
  const shouldIncludeAuth = authRequired && authToken;

  // 管理页正是从 daemon 的 dashboard 端口打开的，因此用当前 origin 即为正确的 MCP 基址
  const mcpUrl = `${window.location.origin}/mcp`;

  const handleCopyConfig = async (config: string, type: string) => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
    }
  };

  const httpConfig = {
    "mcpServers": {
      "mcpdog": {
        "type": "streamable-http",
        "url": mcpUrl,
        ...(shouldIncludeAuth && {
          "headers": {
            "Authorization": `Bearer ${authToken}`
          }
        })
      }
    }
  };

  const stdioConfig = {
    "mcpServers": {
      "mcpdog": {
        "command": "npx",
        "args": ["@keysqiu/mcpdog@latest"]
      }
    }
  };

  const configs = {
    http: {
      title: 'HTTP Streamable 连接（推荐）',
      description: '客户端以 URL 连接常驻服务，无需为每次会话启动子进程',
      config: JSON.stringify(httpConfig, null, 2)
    },
    stdio: {
      title: 'STDIO 连接（兼容路径）',
      description: '传统 stdio 接入；需为每次会话启动代理子进程，仍受会话生命周期影响',
      config: JSON.stringify(stdioConfig, null, 2)
    }
  };

  const currentConfig = configs[activeTab];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-base-100 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        {/* Modal header */}
        <div className="flex items-center justify-between p-6 border-b border-base-300">
          <div>
            <h2 className="text-xl font-bold text-base-content">连接 MCPDOG</h2>
            <p className="text-sm text-base-content/70 mt-1">
              使用以下 JSON 配置将你的 MCP 客户端连接到 MCPDog
            </p>
          </div>
          <button
            onClick={hideClientConfig}
            className="btn btn-ghost btn-sm btn-circle"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[80vh]">
          {/* Tabs */}
          <div className="tabs tabs-boxed justify-center mb-6">
            <button
              className={`tab ${activeTab === 'http' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('http')}
            >
              HTTP Streamable
            </button>
            <button
              className={`tab ${activeTab === 'stdio' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('stdio')}
            >
              STDIO 连接
            </button>
          </div>

          {/* Current Config Display */}
          <div className="card bg-base-100 border border-base-300">
            <div className="card-body">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="card-title text-base-content">{currentConfig.title}</h3>
                  <p className="text-sm text-base-content/70 mt-1">{currentConfig.description}</p>
                </div>
                <button
                  onClick={() => handleCopyConfig(currentConfig.config, activeTab)}
                  className="btn btn-outline btn-sm"
                >
                  {copied === activeTab ? (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-2" />
                      复制
                    </>
                  )}
                </button>
              </div>

              {/* Configuration JSON */}
              <div className="mockup-code">
                <pre className="text-sm"><code>{currentConfig.config}</code></pre>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
