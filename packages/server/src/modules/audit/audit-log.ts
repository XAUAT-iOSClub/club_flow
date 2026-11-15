import type { AuditLog, Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../infra/db.js';

export interface AuditEntry {
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * 写一条审计日志。id 由数据库序列分配、ts 默认 now()，
 * 调用方不要自己拼 id（分区表主键是 (id, ts)）。
 */
export async function writeAuditLog(db: Db, entry: AuditEntry): Promise<AuditLog> {
  return db.auditLog.create({ data: entry });
}
