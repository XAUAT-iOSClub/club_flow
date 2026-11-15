-- 修复 run_events 的 seq 唯一性：分区表上的唯一索引必须包含分区键，
-- (run_id, seq, ts) 无法阻止同一 run 写入重复 seq（ts 不同即视为不同行）。
-- 改为由 runs.event_seq 原子分配序号，并把原唯一索引降级为普通索引。

-- 1) 事件序号分配器：取值方式为 UPDATE runs SET event_seq = event_seq + 1 RETURNING event_seq
ALTER TABLE "runs" ADD COLUMN "event_seq" INTEGER NOT NULL DEFAULT 0;

-- 2) 唯一索引名来自 init 迁移；DROP IF EXISTS 兼容已手工调整过的库
DROP INDEX IF EXISTS "run_events_run_id_seq_ts_key";

-- 3) 普通索引：供 SSE 断点续传按 seq 增量拉取（父表建索引会自动传播到子分区）
CREATE INDEX "run_events_run_id_seq_idx" ON "run_events"("run_id", "seq");
