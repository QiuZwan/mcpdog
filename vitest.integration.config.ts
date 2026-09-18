import { defineConfig } from 'vitest/config';

// 集成测试会真起 daemon / HTTP 服务，串行执行并放宽超时
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
