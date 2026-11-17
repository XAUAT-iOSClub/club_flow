import { afterAll, describe, expect, it } from 'vitest';
import { prisma, disconnectDb } from '../../src/infra/db.js';
import {
  scanInterruptedRuns,
  expireStaleWaits,
} from '../../src/infra/cron.js';

/** 测试数据用 guard_ 前缀，afterAll 统一清理 */
const PREFIX = 'guard_';

afterAll(async () => {
  // run 对 workflow 是 RESTRICT，必须先删 run 才能删 workflow
  await prisma.run.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.workflow.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { targetId: { startsWith: PREFIX } } });
  await disconnectDb();
});

async function makeRun(opts: { heartbeatAt?: Date; status?: 'QUEUED' | 'RUNNING' } = {}) {
  const wfId = `${PREFIX}wf_${Math.random().toString(36).slice(2, 8)}`;
  const wvId = `${PREFIX}wv_${Math.random().toString(36).slice(2, 8)}`;
  const runId = `${PREFIX}run_${Math.random().toString(36).slice(2, 8)}`;
  await prisma.workflow.create({
    data: { id: wfId, name: wfId, slug: wfId, ownerId: 'u', draft: {} },
  });
  await prisma.workflowVersion.create({
    data: { id: wvId, workflowId: wfId, version: 1, dsl: {}, yaml: '', layout: {}, hash: 'h' },
  });
  const run = await prisma.run.create({
    data: {
      id: runId, workflowId: wfId, versionId: wvId, mode: 'TEST',
      status: opts.status ?? 'RUNNING', trigger: {}, inputs: {}, vars: {},
      heartbeatAt: opts.heartbeatAt ?? new Date(),
    },
  });
  return { wfId, wvId, run };
}

async function makeWait(opts: { deadline: Date; runId: string; nodeId: string }) {
  return prisma.nodeWait.create({
    data: {
      id: `${PREFIX}nw_${Math.random().toString(36).slice(2, 8)}`,
      runId: opts.runId, nodeId: opts.nodeId, attempt: 1,
      connectorId: 'http', externalTaskId: `task_${Math.random()}`,
      correlationId: `corr_${Math.random()}`,
      deadline: opts.deadline,
      status: 'PENDING',
    },
  });
}

describe('崩溃扫描 scanInterruptedRuns', () => {
  it('TC-017 heartbeat 超时的 RUNNING run 被标记 FAILED + 有事件 + 有审计', async () => {
    const past = new Date(Date.now() - 10 * 60_000); // 10 分钟前（> threshold=2）
    const { run } = await makeRun({ heartbeatAt: past, status: 'RUNNING' });

    const ids = await scanInterruptedRuns(2, 50);
    expect(ids).toContain(run.id);

    const updated = await prisma.run.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe('FAILED');

    const events = await prisma.runEvent.findMany({
      where: { runId: run.id, type: 'worker.interrupted' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const audits = await prisma.auditLog.findMany({
      where: { targetId: run.id, action: 'run.interrupted' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('TC-017b heartbeat 未超时的 RUNNING run 不动', async () => {
    const recent = new Date(); // 刚更新过
    const { run } = await makeRun({ heartbeatAt: recent, status: 'RUNNING' });

    const ids = await scanInterruptedRuns(2, 50);
    expect(ids).not.toContain(run.id);

    const updated = await prisma.run.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe('RUNNING');
  });

  it('TC-017c QUEUED run 不会被扫描', async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const { run } = await makeRun({ heartbeatAt: past, status: 'QUEUED' });

    const ids = await scanInterruptedRuns(2, 50);
    expect(ids).not.toContain(run.id);
  });

  it('TC-019 SKIP LOCKED 并发安全：多个 worker 不重复处理', async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const { run } = await makeRun({ heartbeatAt: past, status: 'RUNNING' });

    const [a, b] = await Promise.all([
      scanInterruptedRuns(2, 50),
      scanInterruptedRuns(2, 50),
    ]);
    // 至少有一个拿到了这个 run，两个不会同时都拿到
    const total = (a.includes(run.id) ? 1 : 0) + (b.includes(run.id) ? 1 : 0);
    expect(total).toBeLessThanOrEqual(1);
  });
});

describe('等待超时扫描 expireStaleWaits', () => {
  it('TC-018 deadline 已过期的 PENDING wait 被标记 EXPIRED + 有事件 + 有审计', async () => {
    const { run } = await makeRun({ status: 'RUNNING' });
    const past = new Date(Date.now() - 60_000); // 1 分钟前
    const wait = await makeWait({ deadline: past, runId: run.id, nodeId: 'n_expired' });

    const processed = await expireStaleWaits();
    const hit = processed.find((p) => p.waitId === wait.id);
    expect(hit).toBeTruthy();
    expect(hit?.runId).toBe(run.id);
    expect(hit?.nodeId).toBe('n_expired');

    const updated = await prisma.nodeWait.findUnique({ where: { id: wait.id } });
    expect(updated?.status).toBe('EXPIRED');
    expect(updated?.resolvedAt).not.toBeNull();

    const events = await prisma.runEvent.findMany({
      where: { runId: run.id, type: 'wait.expired', nodeId: 'n_expired' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const audits = await prisma.auditLog.findMany({
      where: { targetId: wait.id, action: 'wait.expired' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('TC-018b deadline 未过的 PENDING wait 不动', async () => {
    const { run } = await makeRun({ status: 'RUNNING' });
    const future = new Date(Date.now() + 60_000);
    const wait = await makeWait({ deadline: future, runId: run.id, nodeId: 'n_future' });

    const processed = await expireStaleWaits();
    expect(processed.find((p) => p.waitId === wait.id)).toBeFalsy();

    const updated = await prisma.nodeWait.findUnique({ where: { id: wait.id } });
    expect(updated?.status).toBe('PENDING');
  });

  it('TC-018c 已 RESOLVED 的 wait 不会被扫', async () => {
    const { run } = await makeRun({ status: 'RUNNING' });
    const past = new Date(Date.now() - 60_000);
    // 先手动标记 RESOLVED
    const wait = await makeWait({ deadline: past, runId: run.id, nodeId: 'n_resolved' });
    await prisma.nodeWait.update({ where: { id: wait.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

    const processed = await expireStaleWaits();
    expect(processed.find((p) => p.waitId === wait.id)).toBeFalsy();
  });
});

describe('P1-1 node_runs.skip_reason', () => {
  it('TC-020 skip_reason 可写入并保留完整 JSON', async () => {
    const { run } = await makeRun({ status: 'RUNNING' });
    const skipReason = {
      condition: '$inputs.need_approval',
      expression: 'false',
      evaluated: false,
      exit: 'else',
    };
    const nr = await prisma.nodeRun.create({
      data: {
        runId: run.id, nodeId: 'n_skipped', attempt: 1,
        status: 'SKIPPED', skipReason,
      },
    });
    const back = await prisma.nodeRun.findUnique({ where: { id: nr.id } });
    expect(back?.status).toBe('SKIPPED');
    expect(back?.skipReason).toEqual(skipReason);
  });
});
