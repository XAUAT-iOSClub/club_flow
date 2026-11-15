-- 分区维护：函数 + 初始分区
-- 所有分区边界显式带 +08：timestamptz 的区间边界按会话时区解释，
-- 服务器跑 UTC 时用裸字符串会整体错 8 小时，表现为月末最后几小时的写入找不到分区。

-- 幂等创建某月分区；返回值用于调用方记录（不用 void，Prisma 的 $queryRaw 无法反序列化 void）
CREATE OR REPLACE FUNCTION ensure_month_partition(
  parent regclass,
  month_start timestamptz,
  month_end timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  -- 必须把 timestamptz 转到 +08 再取年月，否则 UTC 会话下会得到上一个月
  part_name text := parent::text || '_' || to_char(month_start AT TIME ZONE 'Asia/Shanghai', 'YYYYMM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, month_start, month_end
    );
  END IF;
  RETURN part_name;
END;
$$;

-- 初始分区：当月 + 未来 2 个月
CREATE TABLE "run_events_202611" PARTITION OF "run_events"
  FOR VALUES FROM ('2026-11-01 00:00:00+08') TO ('2026-12-01 00:00:00+08');

CREATE TABLE "run_events_202612" PARTITION OF "run_events"
  FOR VALUES FROM ('2026-12-01 00:00:00+08') TO ('2027-01-01 00:00:00+08');

CREATE TABLE "run_events_202701" PARTITION OF "run_events"
  FOR VALUES FROM ('2027-01-01 00:00:00+08') TO ('2027-02-01 00:00:00+08');

CREATE TABLE "audit_logs_202611" PARTITION OF "audit_logs"
  FOR VALUES FROM ('2026-11-01 00:00:00+08') TO ('2026-12-01 00:00:00+08');

CREATE TABLE "audit_logs_202612" PARTITION OF "audit_logs"
  FOR VALUES FROM ('2026-12-01 00:00:00+08') TO ('2027-01-01 00:00:00+08');

CREATE TABLE "audit_logs_202701" PARTITION OF "audit_logs"
  FOR VALUES FROM ('2027-01-01 00:00:00+08') TO ('2027-02-01 00:00:00+08');
