import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

/**
 * 事务客户端类型（顶层 Client 去掉 $connect / $disconnect 等管理方法）。
 * 仓储层函数统一接收 `Db`，调用方既能传 `prisma` 也能传事务内的 `tx`。
 */
export type Db = Prisma.TransactionClient;

/**
 * Prisma 7 不再内置数据库驱动，需要显式传入 driver adapter。
 *
 * 关键约束：query compiler 会把 Date 参数序列化成不带时区偏移的「UTC 墙上时间」
 * （例如 `2026-11-30 16:00:00`）。若会话时区不是 UTC，PostgreSQL 会按本地时区解释，
 * 所有 timestamptz 参数整体偏移。因此这里强制会话时区为 UTC，与序列化格式对齐。
 */
export function createPrismaClient(connectionString: string, max = 20): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max,
    options: '-c timezone=UTC',
  });
  return new PrismaClient({ adapter });
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('缺少 DATABASE_URL，无法初始化数据库连接');
}

export const prisma = createPrismaClient(connectionString);

/**
 * 交互式事务的统一入口。
 *
 * 同一次状态迁移涉及的 run / node_run / run_events 必须放在一个事务里
 * （AGENTS.md §5 第 11 条）；HTTP 调用一律留在事务外。
 */
export function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
