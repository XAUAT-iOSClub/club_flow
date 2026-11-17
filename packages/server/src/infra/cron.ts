import { schedule, type ScheduledTask } from 'node-cron';
import { prisma } from './db.js';
import { writeAuditLog } from '../modules/audit/audit-log.js';
import { appendRunEvent } from '../modules/runtime/run-events.js';
import { withTransaction } from './db.js';
import {
  dropExpiredPartitions,
  ensureMonthPartition,
  ensureUpcomingPartitions,
  RETENTION_DAYS,
  type PartitionedTable,
} from './partitions.js';

/** 分区边界按 +08 计算，定时任务也按 +08 触发 */
const TIMEZONE = 'Asia/Shanghai';

/** 并发批处理上限：一次 cron 扫太多会拖慢其他操作，SKIP LOCKED 支持多进程不重复 */
const BATCH_LIMIT = 50;
/** 崩溃判定阈值：心跳超时多少分钟算 worker 挂了（PRD NFR-5） */
const INTERRUPT_THRESHOLD_MIN = 2;
/** 写 run_events 时确保当月分区存在（每天预建 3 个月几乎不会缺，这里 double check） */
async function ensureRunEventsPartition(): Promise<void> {
  await ensureMonthPartition(prisma, 'run_events', monthStartOf(new Date()));
}

function monthStartOf(date: Date): Date {
  const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + TZ_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - TZ_OFFSET_MS);
}

// ===== 分区维护 =====

export async function ensurePartitions(now = new Date()): Promise<string[]> {
  return ensureUpcomingPartitions(prisma, 2, now);
}

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

// ===== 运行时扫描 =====

/**
 * 崩溃检测（PRD NFR-5）：worker 心跳超时的 run 标记 FAILED(interrupted)。
 *
 * 边界说明：cron 只负责 run 层状态 + run_events + audit，
 * node_runs 层的处理（哪些节点仍在 running）留给 runtime 执行器在"从失败节点继续"时负责。
 * 两层职责分离，避免 cron 和 runtime 对同一状态机各改一半。
 *
 * @param thresholdMinutes 心跳超时阈值（分钟），默认 2（PRD NFR-5）
 * @param limit            单次最多处理多少个，默认 50
 * @returns 被标记失败的 run id 列表
 */
export async function scanInterruptedRuns(
  thresholdMinutes = INTERRUPT_THRESHOLD_MIN,
  limit = BATCH_LIMIT,
): Promise<string[]> {
  await ensureRunEventsPartition();

  const cut = `now() - interval '${thresholdMinutes} minutes'`;
  const victims = await withTransaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(`
      WITH locked AS (
        SELECT id FROM runs
        WHERE status = 'running' AND heartbeat_at < ${cut}
        ORDER BY heartbeat_at
        FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE runs SET status = 'failed' WHERE id IN (SELECT id FROM locked)
      RETURNING id
    `);
    return (rows as Array<{ id: string }>).map((r) => r.id);
  });

  if (victims.length === 0) return [];

  for (const runId of victims) {
    await withTransaction(async (tx) => {
      await appendRunEvent(tx, {
        runId,
        level: 'WARN',
        type: 'worker.interrupted',
        message: `worker heartbeat 超时 ${thresholdMinutes} 分钟，run 标记 failed`,
      });
      await writeAuditLog(tx, {
        actorId: 'system',
        actorName: 'system',
        action: 'run.interrupted',
        targetType: 'run',
        targetId: runId,
      });
    });
  }

  return victims;
}

/**
 * 等待超时扫描：node_waits.deadline 已过但仍 PENDING 的标记 EXPIRED。
 *
 * 边界说明：cron 只改 node_waits + run_events + audit，
 * node_run 层处理（把关联节点标 failed）留给 runtime 执行器。
 *
 * @param now 模拟当前时间（测试用），默认真实时间
 * @param limit 单次最多处理多少个，默认 50
 * @returns 被处理的 node_wait id 列表
 */
export async function expireStaleWaits(
  now = new Date(),
  limit = BATCH_LIMIT,
): Promise<Array<{ waitId: string; runId: string; nodeId: string }>> {
  await ensureRunEventsPartition();

  const victims = await withTransaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(`
      WITH locked AS (
        SELECT id, run_id, node_id FROM node_waits
        WHERE status = 'pending' AND deadline <= '${now.toISOString()}'::timestamptz
        ORDER BY deadline
        FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE node_waits nw
      SET status = 'expired', resolved_at = now()
      FROM locked l WHERE nw.id = l.id
      RETURNING nw.id AS wait_id, nw.run_id AS run_id, nw.node_id AS node_id
    `);
    return rows as Array<{ wait_id: string; run_id: string; node_id: string }>;
  });

  if (victims.length === 0) return [];

  const processed = victims.map((v) => ({ waitId: v.wait_id, runId: v.run_id, nodeId: v.node_id }));

  for (const v of processed) {
    await withTransaction(async (tx) => {
      await appendRunEvent(tx, {
        runId: v.runId,
        nodeId: v.nodeId,
        level: 'WARN',
        type: 'wait.expired',
        message: `node_wait ${v.waitId} 超时`,
      });
      await writeAuditLog(tx, {
        actorId: 'system',
        actorName: 'system',
        action: 'wait.expired',
        targetType: 'node_wait',
        targetId: v.waitId,
      });
    });
  }

  return processed;
}

// ===== 定时注册 =====

/**
 * 注册所有定时任务，返回停止函数。
 * 由服务启动入口调用，关闭时停止。当前尚无 Fastify 入口，先提供可测试的注册点。
 *
 * 每分钟扫描（崩溃 / 等待超时）+ 每日 03:00 预建分区 + 每日 03:10 清理分区，
 * 全部 Asia/Shanghai 时区，noOverlap 避免前一轮没跑完就触发下一轮。
 */
export function startPartitionMaintenance(): () => Promise<void> {
  const tasks: ScheduledTask[] = [
    schedule('0 3 * * *', () => ensurePartitions().catch(logFailure('预建分区')), {
      name: 'partitions.ensure', timezone: TIMEZONE, noOverlap: true,
    }),
    schedule('10 3 * * *', () => prunePartitions().catch(logFailure('清理分区')), {
      name: 'partitions.prune', timezone: TIMEZONE, noOverlap: true,
    }),
    schedule('* * * * *', () => scanInterruptedRuns().catch(logFailure('崩溃扫描')), {
      name: 'runs.scanInterrupted', timezone: TIMEZONE, noOverlap: true,
    }),
    schedule('* * * * *', () => expireStaleWaits().catch(logFailure('等待超时扫描')), {
      name: 'waits.expireStale', timezone: TIMEZONE, noOverlap: true,
    }),
  ];

  return async () => {
    for (const task of tasks) await task.stop();
  };
}

function logFailure(action: string): (error: unknown) => void {
  return (error) => console.error(`[cron] ${action}失败`, error);
}
