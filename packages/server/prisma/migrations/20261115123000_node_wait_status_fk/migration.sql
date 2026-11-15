-- 1) node_waits.status 从自由字符串改为枚举，防止写入拼错的状态值
CREATE TYPE "node_wait_status" AS ENUM ('pending', 'resolved', 'expired');
ALTER TABLE "node_waits"
  ALTER COLUMN "status" TYPE "node_wait_status" USING "status"::"node_wait_status";

-- 2) node_waits.run_id 补外键：删除运行后等待记录应一并清理，
--    否则回调恢复时会命中不存在的 run；外键不自动建索引，同时补索引。
CREATE INDEX "node_waits_run_id_idx" ON "node_waits"("run_id");
ALTER TABLE "node_waits"
  ADD CONSTRAINT "node_waits_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) triggers.workflow_id 缺索引：删除工作流时外键检查会全表扫 triggers
CREATE INDEX "triggers_workflow_id_idx" ON "triggers"("workflow_id");
