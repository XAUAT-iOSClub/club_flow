import type { Prisma, RunEvent } from '../../generated/prisma/client.js';
import type { Db } from '../../infra/db.js';

/**
 * 为某个 run 分配下一个事件序号。
 *
 * 分区表的唯一索引必须包含分区键 ts，所以 `(run_id, seq, ts)` 无法真正约束
 * 「同一 run 内 seq 唯一」。这里改成在 runs 行上做原子自增：
 * UPDATE runs SET event_seq = event_seq + 1 —— 行锁会让同一 run 的并发调用串行，
 * 不同 run 之间互不阻塞。事务回滚时自增也一起回滚，不会留下空洞。
 */
export async function nextEventSeq(db: Db, runId: string): Promise<number> {
  const run = await db.run.update({
    where: { id: runId },
    data: { eventSeq: { increment: 1 } },
    select: { eventSeq: true },
  });
  return run.eventSeq;
}

/**
 * 追加一条运行事件，seq 由 {@link nextEventSeq} 分配，调用方不要自己填。
 * ts 默认 now()，调用方一般也不用显式传；如果需要补历史数据可以传。
 * 必须与触发它的状态迁移放在同一事务里（AGENTS.md §5 第 11 条）。
 */
export async function appendRunEvent(
  db: Db,
  data: Omit<Prisma.RunEventUncheckedCreateInput, 'seq'>,
): Promise<RunEvent> {
  const seq = await nextEventSeq(db, data.runId);
  return db.runEvent.create({
    data: { ts: new Date(), ...data, seq },
  });
}
