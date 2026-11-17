# 底层数据库构建 · 执行计划

> 勾选即可跟踪进度。标 **[阻塞]** 的任务未完成前不要开始后续依赖项。

## 阶段 0：前置对齐（阻塞）

- [x] **[阻塞]** 统一 Prisma 版本：根 `prisma` 与 `packages/server` 的 `@prisma/client` 同为 `^7.10.1`，重新 `npm install` 并提交 `package-lock.json`
- [x] **[阻塞]** 确认 spec.md §7 的 4 个开放问题（`node_waits`、`run_events.level` 取值、幂等表补列、Prisma 版本线）
- [x] 确认本地与测试环境可访问独立 PostgreSQL 实例，库名 `clubflow`

## 阶段 1：schema 骨架

- [x] 创建 `packages/server/prisma/schema.prisma`，含 datasource、generator（输出 `../src/generated/prisma`）、6 个枚举
- [x] 写入 11 张表的模型（按 design.md §2.1），`npx prisma validate` 通过
- [x] `npx prisma generate` 成功，CLI 与 Client 版本一致
- [x] `npx prisma format` 后提交

## 阶段 2：迁移与分区

- [x] 生成基线：`prisma migrate diff --from-empty --to-schema` 生成 init，另手写 `partitions`、`runs_indexes`、`run_event_seq`、`node_wait_status_fk`
- [x] 手工改写 `run_events` / `audit_logs` 为 `PARTITION BY RANGE (ts)`，主键改 `(id, ts)`，主键外键索引同步调整
- [x] 新增迁移 `partitions`：`run_events_id_seq` / `audit_logs_id_seq`、`ensure_month_partition`、初始 3 个月分区
- [x] 新增迁移 `runs_indexes`：补 `runs(version_id)`、`runs(status, created_at)`
- [x] 新增迁移 `run_event_seq`：`runs.event_seq` 分配器，删除失效的 `(run_id, seq, ts)` 唯一索引
- [x] 新增迁移 `node_wait_status_fk`：`node_waits` 状态枚举、`run_id` 外键、`triggers(workflow_id)` 索引
- [x] 新增迁移 `ensure_partition_schema`：加固 `ensure_month_partition`（分区名取自 relname、存在性检查限定 public）
- [x] 新增迁移 `updated_at_defaults`：`workflows` / `secrets` / `triggers` 的 `updated_at` 补数据库默认值
- [x] `prisma migrate deploy` 在 `clubflow` 与 `clubflow_test` 上各应用 7 个迁移
- [x] 结构校验：18 个关系、跨月路由、`ensure_month_partition` 幂等、唯一冲突均符合预期

## 阶段 3：应用层接入

- [x] `src/infra/db.ts`：PrismaClient 单例、连接池上限 20、导出 `disconnectDb()` 供入口在 SIGTERM / `onClose` 时调用；连接固定 `options: '-c timezone=UTC'`
- [x] `src/infra/db.ts` 导出 `Db` 事务客户端类型与 `withTransaction()`；`src/index.ts` 统一导出数据库层能力、模型类型与枚举，供其他模块接入
- [x] `src/infra/partitions.ts`：`ensureUpcomingPartitions()` / `dropExpiredPartitions()`
- [x] `src/modules/runtime/run-events.ts`：`nextEventSeq` / `appendRunEvent`，seq 由 `runs.event_seq` 原子分配
- [x] `src/infra/json.ts`：BigInt 安全序列化（REST / SSE 出口统一使用）
- [x] 工程可用性：`prisma.config.ts` 不强依赖 `DATABASE_URL`，`postinstall` / `build` 前置 `prisma generate`，新克隆可直接构建
- [x] 注册 node-cron：03:00 预建、03:10 清理（事件 90 天、审计 180 天），`startPartitionMaintenance()` 返回停止函数，等 Fastify 入口在 `onClose` 调用
- [x] 清理动作写入 `audit_logs`（`actor_id = 'system'`，`action = 'partition.drop'`）

## 阶段 4：测试

- [x] 单测：分区名、保留期、时区边界换算、BigInt 序列化
- [x] 集成：跨月写入落区、并发 `SKIP LOCKED`、状态迁移原子性、幂等冲突、`secrets` 无明文、事件 seq 分配
- [x] 集成：DROP 过期分区后其余月份查询不受影响（TC-009）；表结构校验（TC-004，`tests/infra/schema.test.ts`）
- [x] 集成：清理任务写 system 审计、保留期内不清理、定时任务可注册并停止（TC-014，`tests/infra/cron.test.ts`）
- [x] 集成：其他 schema 同名表不影响预建（TC-015，`tests/infra/partitions.test.ts`）
- [x] 单测：对外导出面守卫，14 个函数 / 枚举 / 保留期常量齐全（TC-016，`tests/infra/index.test.ts`）
- [x] 手工：裸 SQL 验收（结构 / 约束 / 级联 / 状态 / 长文本 / 事务 / 分区路由，MT-003）
- [x] `npx tsc --noEmit` 通过；`npm test` 全绿

## 阶段 5：交付

- [x] 更新 `changes/2026-11-16-db-foundation/test/results.md` 执行记录
- [x] 在 `spec.md` 勾选验收标准
- [ ] 提交并在 PR 描述里链接本计划

## 依赖关系

```
阶段0 ──▶ 阶段1 ──▶ 阶段2 ──▶ 阶段3 ──▶ 阶段4 ──▶ 阶段5
                      │
                      └──▶ 其他模块（鉴权/编译器/运行时）可在此后并行开工
```

阶段 2 完成即解锁其他人：表结构可用，即使应用层代码还没写。

## 风险缓冲

- 若 11-17 仍未确定 `node_waits`：先交付 10 张表，`node_waits` 单独开变更计划补。
- 若 Prisma 分区表出现 drift 且难消除：退化为「分区表完全由 SQL 迁移管理，schema.prisma 中用 `view`/忽略策略」，需在 design.md 追加决策记录。
