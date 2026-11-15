# 底层数据库构建 · 测试用例

> 状态：`未开始` / `进行中` / `通过` / `失败` / `阻塞`
> 每个用例尽量映射到 `spec.md` 的验收项或 PRD 的 FR / NFR 编号。

## 自动化用例

| ID | 层级 | 前置条件 | 步骤 / 输入 | 期望结果 | 对应验收项 | 自动化位置 | 状态 |
|---|---|---|---|---|---|---|---|
| TC-001 | 单元 | 无 | 输入 `2026-11-16T00:00:00+08`，生成分区名 | 得到 `run_events_202611`，跨年月份为 `run_events_202701` | spec §6 跨月边界 | `tests/infra/partitions.test.ts` | 通过 |
| TC-002 | 单元 | 无 | 保留期计算：事件 90 天、审计 180 天 | 正确判断「整月分区是否过期」，当月永不过期 | spec §6 过期分区 | `tests/infra/partitions.test.ts` | 通过 |
| TC-003 | 单元 | 无 | 时区换算：UTC 会话下用裸字符串 vs `+08` | 带 `+08` 的边界与预期落点一致；裸字符串偏 8 小时（作为反例断言） | spec §6 跨月边界 | `tests/infra/partitions.test.ts` | 通过 |
| TC-004 | 集成 | 空测试库 | `prisma migrate deploy` 后检查 `pg_class` | 一次通过；11 张业务表存在；`run_events` / `audit_logs` 的 `relkind='p'` | spec §6 迁移通过 | `tests/infra/schema.test.ts` | 通过 |
| TC-005 | 集成 | 已迁移 | 写入 11-30 23:59:59+08 与 12-01 00:00:00+08 的事件 | 落入不同分区，无「no partition found」 | spec §6 跨月边界 | `tests/infra/db.test.ts` | 通过 |
| TC-006 | 集成 | 队列中有 ≥2 条 `queued` | 两个连接并发执行 `SKIP LOCKED` 认领 | 两个 worker 拿到不同 `run.id`，无重复 | spec §6 并发抢任务 | `tests/infra/db.test.ts` | 通过 |
| TC-007 | 集成 | 有 1 条运行中的 `run` | 同一事务内更新 `run.status` + `node_run.status` + 插入 `run_event`，随后人为抛错 | 事务回滚后三者均未变更 | spec §6 原子性 | `tests/infra/db.test.ts` | 通过 |
| TC-008 | 集成 | 无 | 同一 `(scope,key)` 插入两次：先不同 `request_hash`，再相同 | 不同 hash 被拒绝；相同 hash 返回首次 `response` 快照 | spec §6 幂等 | `tests/infra/db.test.ts` | 通过 |
| TC-009 | 集成 | 存在 3 个历史月份分区 | 执行 `dropExpiredPartitions()` | 仅超期整月分区被 DROP；其余月份查询正常 | spec §6 DROP 过期 | `tests/infra/partitions.test.ts` | 通过 |
| TC-010 | 集成 | 已存在当月分区 | 连续两次执行 `ensureUpcomingPartitions()` | 不报错、不重复建表（幂等） | spec §6 预建 | `tests/infra/partitions.test.ts` | 通过 |
| TC-011 | 单元 | 无 | `stringifyJson({ id: 9007199254740993n })` 及嵌套 BigInt | 不抛 `TypeError`，id 按十进制字符串输出，非 BigInt 字段不变 | spec §6 事件可序列化 | `tests/infra/json.test.ts` | 通过 |
| TC-012 | 集成 | 有 1 条 `queued` 的 run | 并发调用两次 `appendRunEvent` | 得到 `seq` 1 与 2，不重复；`runs.event_seq` 为 2 | spec §6 run 内 seq 唯一 | `tests/infra/db.test.ts` | 通过 |
| TC-013 | 集成 | 已迁移 | 查 `node_waits.status` 的 `udt_name`、`node_waits_run_id_fkey` 的 `confdeltype`、关键索引是否存在 | 状态为 `node_wait_status` 枚举；外键为 `c`（级联）；5 个索引齐全，失效的 `run_events_run_id_seq_ts_key` 不存在 | spec §6 约束完整 | `tests/infra/schema.test.ts` | 通过 |
| TC-014 | 集成 | 已迁移；存在一个超期分区 | ① 造 `run_events_202501` 后调用 `prunePartitions(now)`；② 同上但分区在保留期内；③ 调用 `startPartitionMaintenance()` 后立即停止 | ① 分区被 DROP 且写入 `audit_logs`（`actor_id='system'`、`action='partition.drop'`、`after={table,retentionDays}`）；② 分区保留、无审计；③ 注册与停止均不抛错 | spec §6 清理 | `tests/infra/cron.test.ts` | 通过 |
| TC-015 | 集成 | 已迁移 | 在 `shadow` schema 建同名表 `run_events_209901`，再调用 `ensureMonthPartition('run_events', 2099-01)` | `public` 下仍建出分区；`ensure_month_partition` 不因其他 schema 的同名表跳过预建 | spec §6 预建 | `tests/infra/partitions.test.ts` | 通过 |

## 手工 / E2E 用例

| ID | 场景 | 前置条件 | 步骤 | 期望结果 | 对应验收项 | 状态 |
|---|---|---|---|---|---|---|
| MT-001 | 确认分区物理形态 | 已迁移 | `psql` 查 `pg_class` / `pg_inherits` | 父表 `relkind='p'`，子分区挂载正确，边界符合 `+08` | spec §6 分区形态 | 未开始 |
| MT-002 | 定时任务执行 | 服务已启动（Fastify 入口接线后） | 观察 03:00 / 03:10 任务日志 | 预建与清理各有成功日志；清理写入 `audit_logs(actor_id='system')`。任务逻辑已由 TC-014 覆盖，本条只验证进程内实际触发 | spec §6 清理 | 未开始 |

## 安全与异常用例

| ID | 场景 | 步骤 | 期望结果 | 状态 |
|---|---|---|---|---|
| SEC-001 | `secrets` 不落明文 | 写入一条凭证后直接 `SELECT cipher, nonce FROM secrets` | 仅见 bytea 密文与 nonce，无任何明文片段 | 未开始 |
| SEC-002 | 凭证不可读接口 | 检查 schema 与模块导出 | 不存在任何返回明文的方法；`secrets` 只写与引用 | 未开始 |
| SEC-003 | 审计不落敏感值 | 代码评审 + 断言 | `audit_logs.before/after` 不含 token、密钥、完整请求头 | 未开始 |
| SEC-004 | 未声明的子分区不被 Prisma 误删 | 迁移后执行 `prisma migrate diff` | 无 DROP 子分区的差异输出 | 未开始 |
| SEC-005 | 分区缺失时的写入兜底 | 手工 DROP 下个月分区后写入下月时间 | 触发兜底建分区或明确报错，不静默丢数据 | 未开始 |
