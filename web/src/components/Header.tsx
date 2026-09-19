import React, { useEffect, useState } from 'react';
import { Github } from 'lucide-react';
import { apiClient } from '../utils/api';
import { AutostartToggle } from './AutostartToggle';
import { ThemeToggle } from './ThemeToggle';

const GITHUB_URL = 'https://github.com/SIE-Operations-and-Maintenance-Team/mcpdog';

// 顶部栏：完全照搬 ssh-mcp-server 管理台——固定蓝色渐变背景 + 白色元素，不随主题变化（主题切换只影响内容区）
export const Header: React.FC = () => {
  const [version, setVersion] = useState<string>('');
  const [configPath, setConfigPath] = useState<string>('');

  useEffect(() => {
    apiClient
      .get('/api/system/info')
      .then((d: any) => {
        if (d?.version) setVersion(String(d.version));
        if (d?.configPath) setConfigPath(String(d.configPath));
      })
      .catch(() => {
        // 获取失败时隐藏对应元素，不影响主界面
      });
  }, []);

  return (
    <header
      className="sticky top-0 z-10 flex h-16 items-center justify-between px-4 sm:px-6"
      style={{
        background: 'linear-gradient(135deg, #1677ff 0%, #4096ff 50%, #69b1ff 100%)',
        boxShadow: '0 2px 8px rgba(22,119,255,0.25)',
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-lg font-bold tracking-wide text-white">
          MCPDog 管理控制台
        </span>
        {configPath && (
          <span
            className="hidden rounded-full border border-white/30 bg-white/20 px-2.5 py-0.5 text-xs leading-5 text-white md:inline-block"
            title={configPath}
          >
            配置文件: {configPath}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {version && (
          <span className="rounded-full border border-white/30 bg-white/20 px-2.5 py-0.5 text-xs leading-5 text-white">
            v{version}
          </span>
        )}
        <AutostartToggle />
        <ThemeToggle className="!text-white" />
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          title="GitHub 仓库"
          className="btn btn-ghost btn-sm btn-circle !text-white"
        >
          <Github className="h-5 w-5" />
        </a>
      </div>
    </header>
  );
};
