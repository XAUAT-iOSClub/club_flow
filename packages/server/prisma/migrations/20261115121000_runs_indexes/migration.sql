-- 补齐运行表的两个查询索引
-- 1) runs(version_id)：外键不自动建索引，按版本查运行与删除版本时会全表扫；
-- 2) runs(status, created_at)：worker 抢占用 WHERE status = 'queued' ORDER BY created_at，
--    原有 runs(status, heartbeat_at) 只能过滤状态，排序仍需额外开销。

CREATE INDEX "runs_version_id_idx" ON "runs"("version_id");

CREATE INDEX "runs_status_created_at_idx" ON "runs"("status", "created_at");
