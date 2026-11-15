import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // 所有集成用例共用同一个测试库，串行执行避免互相干扰
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
