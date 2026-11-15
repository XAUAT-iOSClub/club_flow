-- 加固 ensure_month_partition：
-- 1) 分区名改为从 pg_class.relname 取。原实现用 parent::text，search_path 不含 public 时
--    会得到 "public.run_events"，拼出的分区名带点号，CREATE TABLE 直接失败。
-- 2) 存在性检查限定 public schema（与 listPartitions 的修复一致）。原实现只按 relname 匹配，
--    其他 schema 里的同名表会让预建被静默跳过，新月首日写入报 "no partition found"。
CREATE OR REPLACE FUNCTION ensure_month_partition(
  parent regclass,
  month_start timestamptz,
  month_end timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  part_name text;
BEGIN
  -- 必须把 timestamptz 转到 +08 再取年月，否则 UTC 会话下会得到上一个月
  SELECT c.relname || '_' || to_char(month_start AT TIME ZONE 'Asia/Shanghai', 'YYYYMM')
    INTO part_name
  FROM pg_class c
  WHERE c.oid = parent;

  IF part_name IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: unknown parent relation %', parent;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = part_name AND n.nspname = 'public'
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, month_start, month_end
    );
  END IF;

  RETURN part_name;
END;
$$;
