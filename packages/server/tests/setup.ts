import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 测试环境准备：
 * 1. 读取仓库根目录 .env（Prisma 7 不再自动加载）；
 * 2. 强制把 DATABASE_URL 指向独立测试库，避免集成测试写脏开发库。
 */
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('缺少 TEST_DATABASE_URL：集成测试会写入真实数据，必须指向独立测试库');
}

process.env.DATABASE_URL = testUrl;
