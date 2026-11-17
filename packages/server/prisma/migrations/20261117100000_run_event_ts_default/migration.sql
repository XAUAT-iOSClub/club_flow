-- RunEvent.ts 加 @default(now())，裸 SQL 插入 run_events 时也能自动填充时间。
-- 分区父表 ALTER COLUMN 自动传播到所有已存在子分区。

ALTER TABLE "run_events" ALTER COLUMN "ts" SET DEFAULT now();
