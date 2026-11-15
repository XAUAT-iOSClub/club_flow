import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 起连接串从 schema.datasource 移到本文件。
 * 迁移命令在 packages/server 目录下执行（npm -w @clubflow/server run prisma:*）。
 *
 * Prisma 7 不再自动加载 .env，这里用 Node 内置的 loadEnvFile 读仓库根目录的 .env，
 * 避免为读取环境变量引入 dotenv。
 */
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // 不用 env('DATABASE_URL')：它在加载配置时就强制求值，导致没有 .env 的环境
    // （新克隆、CI）连 prisma generate 都跑不了。这里允许为空，
    // 只有真正连库的命令（migrate / db execute）才会因 URL 非法而明确失败。
    url: process.env.DATABASE_URL ?? '',
  },
});
