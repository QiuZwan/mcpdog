import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * stdio 协议流纯度守卫（回归测试）
 *
 * 背景：MCP 客户端按行解析进程 stdout 的 NDJSON 协议流，任何非 JSON 行都会破坏协议。
 * 因此运行在 stdio 协议进程里的日志一律必须走 stderr（console.error / console.warn）。
 * 此前 [SERVER] / [ROUTER] / [DAEMON-CLIENT] 日志误用 console.log，污染了
 * stdio 直连模式（node dist/index.js）与 stdio-proxy 代理进程的协议流。
 *
 * 这里对 4 个运行在协议流 stdout 上的源文件做静态断言：源码中不得出现 console.log(。
 * 豁免：src/index.ts 的 console.log 是刻意的协议写出口（sendMessage 写 JSON-RPC）与
 * --help CLI 输出，不参与本守卫；daemon-web-server.ts / mcpdog-daemon.ts 运行在
 * daemon 进程，其 stdout 不是协议流，同样不在守卫范围内。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROTOCOL_SOURCE_FILES = [
  join(__dirname, 'mcpdog-server.ts'),
  join(__dirname, '../router/tool-router.ts'),
  join(__dirname, '../daemon/daemon-client.ts'),
  join(__dirname, '../daemon/stdio-proxy.ts'),
];

describe('stdio 协议流纯度：协议文件源码不得写 stdout（console.log）', () => {
  for (const filePath of PROTOCOL_SOURCE_FILES) {
    it(`${filePath} 中不出现 console.log(`, () => {
      const source = readFileSync(filePath, 'utf-8');
      // 断言协议纯度不变量：这些文件编译产物运行在 stdio 协议进程上，
      // stdout 只允许出现 NDJSON 协议行；日志（console.log）必须走 stderr
      const matches = source.match(/console\.log\(/g);
      expect(matches, `协议文件 ${filePath} 含 ${matches?.length ?? 0} 处 console.log(，会污染 NDJSON 协议流`).toBeNull();
    });
  }
});
