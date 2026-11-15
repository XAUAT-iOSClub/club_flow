import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectDb, prisma } from '../../src/infra/db.js';
import { appendRunEvent } from '../../src/modules/runtime/run-events.js';

const stamp = Date.now();
const workflowId = `wf_test_${stamp}`;
const versionId = `wv_test_${stamp}`;

async function createRun(id: string) {
  return prisma.run.create({
    data: {
      id,
      workflowId,
      versionId,
      mode: 'TEST',
      status: 'QUEUED',
      trigger: { type: 'manual' },
      inputs: {},
      vars: {},
    },
  });
}

describe('数据层纪律（真实测试库）', () => {
  beforeAll(async () => {
    await prisma.workflow.create({
      data: {
        id: workflowId,
        name: '测试流程',
        slug: `test-${stamp}`,
        ownerId: '20210001',
        draft: {},
        updatedAt: new Date(),
      },
    });
    await prisma.workflowVersion.create({
      data: { id: versionId, workflowId, version: 1, dsl: {}, yaml: '', layout: {}, hash: 'h1' },
    });
  });

  it('TC-005 跨月事件落到各自分区', async () => {
    const run = await createRun(`run_${stamp}_boundary`);

    await prisma.runEvent.create({
      data: {
        runId: run.id,
        seq: 1,
        ts: new Date('2026-11-30T23:59:59+08:00'),
        level: 'INFO',
        type: 'node.start',
      },
    });
    await prisma.runEvent.create({
      data: {
        runId: run.id,
        seq: 2,
        ts: new Date('2026-12-01T00:00:00+08:00'),
        level: 'INFO',
        type: 'node.start',
      },
    });

    const rows = await prisma.$queryRaw<Array<{ part: string; seq: number }>>`
      SELECT tableoid::regclass::text AS part, seq
      FROM run_events WHERE run_id = ${run.id} ORDER BY seq`;

    expect(rows.map((row) => row.part)).toEqual(['run_events_202611', 'run_events_202612']);

    await prisma.run.delete({ where: { id: run.id } });
  });

  it('TC-006 SKIP LOCKED 并发认领不重复', async () => {
    const runA = await createRun(`run_${stamp}_claim_a`);
    const runB = await createRun(`run_${stamp}_claim_b`);

    const connectionString = process.env.DATABASE_URL;
    expect(connectionString).toBeTruthy();
    const clientA = createPrismaClient(connectionString!);
    const clientB = createPrismaClient(connectionString!);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const claimA = clientA.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM runs WHERE status = 'queued'
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
          await hold; // 持锁等待第二个连接抢夺
          return rows;
        },
        { timeout: 10_000 },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      const rowsB = await clientB.$transaction(async (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM runs WHERE status = 'queued'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );

      release();
      const rowsA = await claimA;

      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]!.id).not.toBe(rowsB[0]!.id);
    } finally {
      release();
      await clientA.$disconnect();
      await clientB.$disconnect();
      await prisma.run.deleteMany({ where: { id: { in: [runA.id, runB.id] } } });
    }
  });

  it('TC-007 状态迁移与事件写入同事务，异常时整体回滚', async () => {
    const run = await createRun(`run_${stamp}_tx`);
    const node = await prisma.nodeRun.create({
      data: { id: `nr_${stamp}_tx`, runId: run.id, nodeId: 'n1', attempt: 1, status: 'PENDING' },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.run.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: new Date() } });
        await tx.nodeRun.update({ where: { id: node.id }, data: { status: 'RUNNING', startedAt: new Date() } });
        await tx.runEvent.create({
          data: { runId: run.id, seq: 1, ts: new Date(), level: 'INFO', type: 'node.start' },
        });
        throw new Error('rollback-probe');
      }),
    ).rejects.toThrow('rollback-probe');

    const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const nodeAfter = await prisma.nodeRun.findUniqueOrThrow({ where: { id: node.id } });
    const eventCount = await prisma.runEvent.count({ where: { runId: run.id } });

    expect(runAfter.status).toBe('QUEUED');
    expect(nodeAfter.status).toBe('PENDING');
    expect(eventCount).toBe(0);

    await prisma.run.delete({ where: { id: run.id } });
  });

  it('TC-008 幂等键冲突不覆盖首次记录', async () => {
    const key = randomUUID();
    const exp = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const first = await prisma.idempotencyKey.createMany({
      data: [{ scope: 'test', key, requestHash: 'h1', exp }],
      skipDuplicates: true,
    });
    const second = await prisma.idempotencyKey.createMany({
      data: [{ scope: 'test', key, requestHash: 'h2', exp }],
      skipDuplicates: true,
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    const stored = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { scope_key: { scope: 'test', key } },
    });
    expect(stored.requestHash).toBe('h1');

    await prisma.idempotencyKey.delete({ where: { scope_key: { scope: 'test', key } } });
  });

  it('TC-012 同一 run 并发追加事件 seq 不重复', async () => {
    const run = await createRun(`run_${stamp}_seq`);

    const [first, second] = await Promise.all([
      appendRunEvent(prisma, { runId: run.id, ts: new Date(), level: 'INFO', type: 'node.start' }),
      appendRunEvent(prisma, { runId: run.id, ts: new Date(), level: 'INFO', type: 'node.end' }),
    ]);

    expect([first.seq, second.seq].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await prisma.runEvent.count({ where: { runId: run.id } })).toBe(2);

    const runAfter = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfter.eventSeq).toBe(2);

    await prisma.run.delete({ where: { id: run.id } });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { workflowId } });
    await prisma.workflow.deleteMany({ where: { id: workflowId } });
    await disconnectDb();
  });
});
