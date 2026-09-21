/**
 * Claude Code .claude.json 的 MCP 服务器导入工具
 * 纯函数、无 IO：负责解析、条目转换与导入规划，供 daemon 预览/导入 API 复用
 */

import { MCPServerConfig } from '../types/index.js';

/** Claude Code .claude.json 中单个 MCP 服务器条目 */
export interface ClaudeMCPEntry {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  [key: string]: unknown;
}

export type ImportPlanStatus = 'new' | 'conflict' | 'invalid';

export interface ImportPlanItem {
  name: string;
  status: ImportPlanStatus;
  config?: MCPServerConfig;
  transport?: MCPServerConfig['transport'];
  reason?: string;
}

export interface ImportPlan {
  source: string;
  items: ImportPlanItem[];
  counts: {
    new: number;
    conflict: number;
    invalid: number;
  };
}

export interface ImportNameValidator {
  (name: string): { valid: boolean };
}

export type ConvertResult =
  | { ok: true; config: MCPServerConfig; transport: MCPServerConfig['transport'] }
  | { ok: false; error: string };

/**
 * 解析 .claude.json 文件内容，取顶层 mcpServers（用户级配置）
 */
export function parseClaudeJson(content: string): Record<string, ClaudeMCPEntry> {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`解析 .claude.json 失败: ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.claude.json 顶层结构无效');
  }

  const mcpServers = parsed.mcpServers;
  if (mcpServers === undefined || mcpServers === null) {
    return {};
  }
  if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    throw new Error('.claude.json 的 mcpServers 字段结构无效');
  }

  return mcpServers as Record<string, ClaudeMCPEntry>;
}

/**
 * 将 Claude Code 条目转换为 MCPDog 服务器配置
 * 规则：有 url 走远程（type === 'sse' → http-sse，其余 → streamable-http）；
 *       否则有 command 走 stdio；两者皆无则返回错误。
 */
export function convertEntryToServerConfig(name: string, entry: ClaudeMCPEntry): ConvertResult {
  if (entry.url) {
    const transport = entry.type === 'sse' ? 'http-sse' : 'streamable-http';
    const config: MCPServerConfig = {
      name,
      enabled: entry.disabled !== true,
      transport,
      url: entry.url,
      ...(entry.headers && typeof entry.headers === 'object' ? { headers: entry.headers } : {}),
    };
    return { ok: true, config, transport };
  }

  if (entry.command) {
    const config: MCPServerConfig = {
      name,
      enabled: entry.disabled !== true,
      transport: 'stdio',
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      // env 值统一转成字符串：Claude 配置里出现数字/布尔很常见（如 {"PORT":3000}），
      // 而 MCPServerConfig.env 的类型是 Record<string,string>。Node 会强制转换，
      // 但把非字符串原样写进配置会让类型声明与落盘内容不一致。
      ...(entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? {
            env: Object.fromEntries(
              Object.entries(entry.env as Record<string, unknown>)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => [k, String(v)])
            ),
          }
        : {}),
    };
    return { ok: true, config, transport: 'stdio' };
  }

  return { ok: false, error: '缺少 command 或 url，无法判定传输方式' };
}

export interface BuildImportPlanParams {
  source: string;
  entries: Record<string, ClaudeMCPEntry>;
  existingNames: string[];
  validateName: ImportNameValidator;
}

/**
 * 生成导入规划：按 new / conflict / invalid 分组，供预览与导入复用
 */
export function buildImportPlan({
  source,
  entries,
  existingNames,
  validateName,
}: BuildImportPlanParams): ImportPlan {
  const items: ImportPlanItem[] = [];
  const seenNames = new Set<string>();

  for (const [name, entry] of Object.entries(entries)) {
    const validation = validateName(name);
    if (!validation.valid) {
      items.push({ name, status: 'invalid', reason: '服务器名称不合规' });
      continue;
    }

    if (existingNames.includes(name)) {
      items.push({ name, status: 'conflict', reason: '已在 MCPDog 中配置' });
      continue;
    }

    if (seenNames.has(name)) {
      items.push({ name, status: 'invalid', reason: '同一 .claude.json 中名称重复' });
      continue;
    }
    seenNames.add(name);

    const converted = convertEntryToServerConfig(name, entry);
    if (!converted.ok) {
      items.push({ name, status: 'invalid', reason: converted.error });
      continue;
    }

    items.push({
      name,
      status: 'new',
      transport: converted.transport,
      config: converted.config,
    });
  }

  const counts = items.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { new: 0, conflict: 0, invalid: 0 },
  );

  return { source, items, counts };
}