import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prunePartitions, startPartitionMaintenance } from '../../src/infra/cron.js';
import { disconnectDb, prisma } from '../../src/infra/db.js';
import { listPartitions } from '../../src/infra/partitions.js';

/** 固定一个 +08 时间点，保证「过期」判断不随运行日期漂移 */
const NOW = new Date('2026-11-15T03:10:00+08:00');

describe('分区定时维护（真实测试库）', () => {
  afterEach(async () => {
    await prisma.auditLog.deleteMany({ where: { targetId: { startsWith: 'run_events_' } } });
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public."run_events_202501"');
  });

  it('TC-014 清理过期分区并写 system 审计', async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS public."run_events_202501" PARTITION OF public."run_events"
        FOR VALUES FROM ('2025-01-01 00:00:00+08') TO ('2025-02-01 00:00:00+08')
    `);

    const dropped = await prunePartitions(NOW);

    expect(dropped).toContain('run_events_202501');
    expect(await listPartitions(prisma, 'run_events')).not.toContain('run_events_202501');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'partition.drop', targetId: 'run_events_202501' },
    });
    expect(audit?.actorId).toBe('system');
    expect(audit?.actorName).toBe('system');
    expect(audit?.after).toEqual({ table: 'run_events', retentionDays: 90 });
  });

  it('TC-014 保留期内的分区不会被清理', async () => {
    const before = await listPartitions(prisma, 'run_events');

    const dropped = await prunePartitions(NOW);

    expect(dropped).toEqual([]);
    expect(await listPartitions(prisma, 'run_events')).toEqual(before);
  });

  it('TC-014 定时任务可注册并停止', async () => {
    const stop = startPartitionMaintenance();
    await expect(stop()).resolves.toBeUndefined();
  });

  afterAll(async () => {
    await disconnectDb();
  });
});
