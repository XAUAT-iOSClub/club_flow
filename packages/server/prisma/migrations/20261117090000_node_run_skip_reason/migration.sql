-- P1-1 修复：node_runs 补 skip_reason 字段
-- runtime 执行器在把节点标记 SKIPPED（条件分支未命中）时，
-- 同时写记录到 skip_reason，便于未来「从失败节点继续」恢复时
-- 重新评估条件是否真的跳过，还是恢复逻辑本身需要覆盖 skipped 分支。

ALTER TABLE "node_runs" ADD COLUMN "skip_reason" jsonb;
