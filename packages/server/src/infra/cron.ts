import { schedule, type ScheduledTask } from 'node-cron';
import { prisma } from './db.js';
import {
  dropExpiredPartitions,
  ensureUpcomingPartitions,
  RETENTION_DAYS,
  type PartitionedTable,
} from './partitions.js';
import { writeAuditLog } from '../modules/audit/audit-log.js';

/**
 * 分区边界按 +08 计算，定时任务也按 +08 触发，否则东八区 03:00 会被当成 UTC 03:00，
 * 实际在本地 11:00 才跑。
 */
const TIMEZONE = 'Asia/Shanghai';

/** 03:00 预建当月及未来两个月分区 */
export async function ensurePartitions(now = new Date()): Promise<string[]> {
  return ensureUpcomingPartitions(prisma, 2, now);
}

/** 03:10 清理超出保留期的整月分区，并逐条写审计（actor = system） */
export async function prunePartitions(now = new Date()): Promise<string[]> {
  const dropped: string[] = [];

  for (const table of Object.keys(RETENTION_DAYS) as PartitionedTable[]) {
    for (const name of await dropExpiredPartitions(prisma, table, now)) {
      dropped.push(name);
      await writeAuditLog(prisma, {
        actorId: 'system',
        actorName: 'system',
        action: 'partition.drop',
        targetType: 'partition',
        targetId: name,
        after: { table, retentionDays: RETENTION_DAYS[table] },
      });
    }
  }

  return dropped;
}

/**
 * 注册每日分区维护任务，返回停止函数。
 * 由服务启动入口调用，关闭时停止；当前尚无 Fastify 入口，先提供可测试的注册点。
 */
export function startPartitionMaintenance(): () => Promise<void> {
  const tasks: ScheduledTask[] = [
    schedule('0 3 * * *', () => ensurePartitions().catch(logFailure('预建')), {
      name: 'partitions.ensure',
      timezone: TIMEZONE,
      noOverlap: true,
    }),
    schedule('10 3 * * *', () => prunePartitions().catch(logFailure('清理')), {
      name: 'partitions.prune',
      timezone: TIMEZONE,
      noOverlap: true,
    }),
  ];

  return async () => {
    for (const task of tasks) {
      await task.stop();
    }
  };
}

/** 定时任务不能把异常抛回事件循环，否则会变成未处理拒绝 */
function logFailure(action: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[cron] 分区${action}失败`, error);
  };
}
