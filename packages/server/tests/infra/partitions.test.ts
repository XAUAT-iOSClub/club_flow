import { afterAll, describe, expect, it } from 'vitest';
import { disconnectDb, prisma } from '../../src/infra/db.js';
import {
  RETENTION_DAYS,
  dropExpiredPartitions,
  ensureMonthPartition,
  ensureUpcomingPartitions,
  isPartitionExpired,
  listPartitions,
  monthStartOf,
  partitionName,
} from '../../src/infra/partitions.js';

describe('分区名与时区换算（单元）', () => {
  it('TC-001 生成月分区名', () => {
    expect(partitionName('run_events', monthStartOf(new Date('2026-11-16T00:00:00+08:00')))).toBe(
      'run_events_202611',
    );
    // 跨年
    expect(partitionName('audit_logs', monthStartOf(new Date('2027-01-05T00:00:00+08:00')))).toBe(
      'audit_logs_202701',
    );
  });

  it('TC-003 月末边界按 +08 切分', () => {
    // 同一瞬间的两种视角：10-31 23:59:59+08 与 11-01 00:00:00+08
    const lastMomentOfOct = new Date('2026-10-31T15:59:59Z');
    const firstMomentOfNov = new Date('2026-10-31T16:00:00Z');

    expect(partitionName('run_events', monthStartOf(lastMomentOfOct))).toBe('run_events_202610');
    expect(partitionName('run_events', monthStartOf(firstMomentOfNov))).toBe('run_events_202611');
  });

  it('TC-002 保留期判断', () => {
    const now = new Date('2026-11-15T12:00:00+08:00');

    expect(RETENTION_DAYS.run_events).toBe(90);
    expect(RETENTION_DAYS.audit_logs).toBe(180);

    // run_events：截止点 2026-08-17 12:00+08
    expect(isPartitionExpired('run_events', new Date('2026-07-01T00:00:00+08:00'), now)).toBe(true);
    expect(isPartitionExpired('run_events', new Date('2026-08-01T00:00:00+08:00'), now)).toBe(false);
    expect(isPartitionExpired('run_events', new Date('2026-11-01T00:00:00+08:00'), now)).toBe(false);

    // audit_logs：截止点 2026-05-19 12:00+08
    expect(isPartitionExpired('audit_logs', new Date('2026-04-01T00:00:00+08:00'), now)).toBe(true);
    expect(isPartitionExpired('audit_logs', new Date('2026-05-01T00:00:00+08:00'), now)).toBe(false);
  });
});

describe('分区维护（真实测试库）', () => {
  it('TC-010 预建分区幂等', async () => {
    const now = new Date();
    await ensureUpcomingPartitions(prisma, 2, now);
    const first = await listPartitions(prisma, 'run_events');

    const returned = await ensureUpcomingPartitions(prisma, 2, now);
    const second = await listPartitions(prisma, 'run_events');

    // 第二次调用不新增任何分区
    expect(second).toEqual(first);
    // 返回值里的目标分区确实都建出来了（当月及后两个月）
    const expected = [0, 1, 2].map((i) => partitionName('run_events', monthStartOf(now, i)));
    expect(returned.filter((name) => name.startsWith('run_events_'))).toEqual(expected);
    expect(second).toEqual(expect.arrayContaining(expected));
  });

  it('TC-009 只删除整月已过期的分区', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "run_events_202001" PARTITION OF "run_events"
         FOR VALUES FROM ('2020-01-01 00:00:00+08') TO ('2020-02-01 00:00:00+08')`,
    );

    const dropped = await dropExpiredPartitions(
      prisma,
      'run_events',
      new Date('2026-11-15T12:00:00+08:00'),
    );

    expect(dropped).toContain('run_events_202001');
    const names = await listPartitions(prisma, 'run_events');
    expect(names).not.toContain('run_events_202001');
    expect(names).toContain('run_events_202611');
  });

  it('TC-015 其他 schema 的同名表不会让预建被误判为已存在', async () => {
    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS shadow');
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS shadow."run_events_209901" (id int)');

    try {
      await ensureMonthPartition(prisma, 'run_events', new Date('2099-01-01T00:00:00+08:00'));

      expect(await listPartitions(prisma, 'run_events')).toContain('run_events_209901');

      // public 下确实建出了分区表，而不是把 shadow 里的同名表当成已有分区
      const rows = await prisma.$queryRaw<Array<{ nspname: string }>>`
        SELECT n.nspname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'run_events_209901'
        ORDER BY n.nspname`;
      expect(rows.map((row) => row.nspname)).toEqual(['public', 'shadow']);
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public."run_events_209901"');
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS shadow CASCADE');
    }
  });

  afterAll(async () => {
    await disconnectDb();
  });
});
