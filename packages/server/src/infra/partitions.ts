import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * 分区维护：run_events 保留 90 天，audit_logs 保留 180 天。
 * 分区边界一律按 +08 计算——timestamptz 的区间边界会按会话时区解释，
 * 用裸字符串在 UTC 服务器上会整体偏 8 小时。
 */

export const RETENTION_DAYS = {
  run_events: 90,
  audit_logs: 180,
} as const;

export type PartitionedTable = keyof typeof RETENTION_DAYS;

/** +08 相对 UTC 的偏移毫秒数 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 取 +08 视角下某时间所在月份的第 offsetMonths 个月的起点 */
export function monthStartOf(date: Date, offsetMonths = 0): Date {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + offsetMonths;
  return new Date(Date.UTC(year, month, 1) - TZ_OFFSET_MS);
}

/** 分区名：`${table}_YYYYMM`，年月按 +08 计算 */
export function partitionName(table: PartitionedTable, monthStart: Date): string {
  const shifted = new Date(monthStart.getTime() + TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_${year}${month}`;
}

/** 解析分区名中的月份起点；不是本表分区则返回 null */
export function partitionMonthOf(table: PartitionedTable, name: string): Date | null {
  const match = new RegExp(`^${table}_(\\d{4})(\\d{2})$`).exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1) - TZ_OFFSET_MS);
}

/** 幂等创建某月分区（调用数据库函数 ensure_month_partition） */
export async function ensureMonthPartition(
  db: PrismaClient,
  table: PartitionedTable,
  monthStart: Date,
): Promise<void> {
  assertMonthStart(monthStart);
  // 用字面量而不是 Date 参数：DDL 的边界不能依赖驱动对 Date 的序列化行为
  const from = monthLiteral(monthStart);
  const to = monthLiteral(monthStartOf(monthStart, 1));
  await db.$executeRawUnsafe(
    `SELECT ensure_month_partition('${table}'::regclass, '${from}'::timestamptz, '${to}'::timestamptz)`,
  );
}

/** 断言 monthStart 必须是 +08 视角下当月 1 号 00:00，否则拼出的 DDL 边界会错位 */
function assertMonthStart(monthStart: Date): void {
  const shifted = new Date(monthStart.getTime() + TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const min = shifted.getUTCMinutes();
  const sec = shifted.getUTCSeconds();
  if (day !== 1 || hour !== 0 || min !== 0 || sec !== 0) {
    throw new RangeError(
      `ensureMonthPartition 的 monthStart 必须是 +08 视角下当月 1 号 00:00，` +
        `当前是 ${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')} ` +
        `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}+08`,
    );
  }
}

/** 把月份起点渲染成带显式 +08 偏移的 SQL 字面量 */
function monthLiteral(monthStart: Date): string {
  const shifted = new Date(monthStart.getTime() + TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01 00:00:00+08`;
}

/**
 * 确保当月及未来 months 个月的分区存在（幂等），默认共 3 个月。
 * 返回值是目标分区名，不区分本次是否真的新建。
 */
export async function ensureUpcomingPartitions(
  db: PrismaClient,
  months = 2,
  now = new Date(),
): Promise<string[]> {
  const created: string[] = [];
  for (const table of Object.keys(RETENTION_DAYS) as PartitionedTable[]) {
    for (let i = 0; i <= months; i += 1) {
      const start = monthStartOf(now, i);
      await ensureMonthPartition(db, table, start);
      created.push(partitionName(table, start));
    }
  }
  return created;
}

/** 枚举父表的现有子分区名 */
export async function listPartitions(
  db: PrismaClient,
  table: PartitionedTable,
): Promise<string[]> {
  // 限定 public 与 relkind = 'p'：只按 relname 过滤会把其他 schema 的同名表、
  // 以及同名的普通表算进来，进而让清理逻辑误删或误报。
  const rows = await db.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE p.relname = ${table} AND p.relkind = 'p' AND n.nspname = 'public'
    ORDER BY c.relname
  `;
  return rows.map((row) => row.relname);
}

/** 判断整月分区是否已超出保留期（分区上界早于或等于截止点） */
export function isPartitionExpired(
  table: PartitionedTable,
  monthStart: Date,
  now = new Date(),
): boolean {
  const cutoff = now.getTime() - RETENTION_DAYS[table] * DAY_MS;
  return monthStartOf(monthStart, 1).getTime() <= cutoff;
}

/** DROP 掉整月都已超出保留期的分区，返回被删除的分区名 */
export async function dropExpiredPartitions(
  db: PrismaClient,
  table: PartitionedTable,
  now = new Date(),
): Promise<string[]> {
  const names = await listPartitions(db, table);
  const dropped: string[] = [];

  for (const name of names) {
    const start = partitionMonthOf(table, name);
    if (!start) continue;
    if (!isPartitionExpired(table, start, now)) continue;
    if (!/^[a-z_]+_\d{6}$/.test(name)) continue;
    // 带 schema 限定：不依赖 search_path，避免落到同名表
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${name}"`);
    dropped.push(name);
  }

  return dropped;
}
