# 底层数据库构建 · 规格说明

| 项目 | 内容 |
|---|---|
| 计划目录 | `changes/2026-11-16-db-foundation/` |
| 状态 | draft |
| 负责人 | 陈智祥 |
| 创建日期 | 2026-11-16 |
| 关联 PRD | [PRD-通用工作流引擎](../../docs/PRD-通用工作流引擎.md) §4.1.1、§5.3、§5.4、§6.2、FR-12.x |
| 关联验收项 | FR-2.x、FR-4.x、FR-12.1～12.5、§13 发布前检查 |

## 1. 背景与问题

仓库当前是空骨架：`packages/server` 与 `packages/schema` 只有 `package.json`，没有 `prisma/` 目录、没有 schema、没有迁移，也没有任何业务代码。PRD 已把数据模型写到表与关键列一级（§5.4），但**尚未落成可执行的 schema 与迁移**，因此：

- 编译器的 DSL 校验、运行时的状态机、连接器与密钥管理都没有持久化底座；
- 其他人（鉴权、编译器、运行时、前端）无法并行开工，全部卡在表结构上；
- `run_events` / `audit_logs` 的分区要求无法用 Prisma 声明，必须先确定 SQL 迁移的写法，否则后续补分区要重建表。

## 2. 目标

1. 产出与 PRD §5.3 / §5.4 一致、且能通过 `prisma validate` + `prisma generate` 的 `schema.prisma`。
2. 产出可在空库上一次性执行成功的初始迁移，其中 `run_events`、`audit_logs` 为按 `ts` 月分区的分区表，并附带分区维护函数。
3. 产出分区维护任务（预建未来 2 个月、按 90/180 天 DROP 过期分区）的可运行实现与测试。

## 3. 非目标

- **不建** `approvals` / `approval_approvers` / `approval_tokens` / `approval_sessions`：审批已整体迁至独立审批服务（§4.1.1，以新基线为准）。
- **不建** `workflow_members`（P1，§5.4 明确首版不建）。
- **不建用户表**、不做用户外键，不实现 JWT 验签（属鉴权模块）。
- 不实现连接器出站调用、DSL 编译、运行时调度（只提供它们依赖的表与客户端）。
- 不写任何 REST 接口。

## 4. 范围

| 类型 | 内容 |
|---|---|
| 涉及模块 | `packages/server/prisma/`、`packages/server/src/infra/db.ts`、`packages/server/src/infra/partitions.ts` |
| 数据模型变更 | 有：新增 11 张表（详见 design.md §2.1），其中 2 张为分区表；另新增 `node_waits` 以落地 §4.1.1 的等待关联 |
| 接口变更 | 无 |
| 前端配合 | 无 |
| 外部依赖 | PostgreSQL（独立实例，专库 `clubflow`）、Prisma 7.10.x、node-cron |

## 5. 方案要点

先把 Prisma CLI 与 `@prisma/client` 统一到 7.10.x 稳定线（当前分别是 `8.0.0-rc.33` 与 `7.10.1`，跨大版本无法可靠生成）。模型层用 Prisma 声明以获得类型与查询能力；两张分区表在 Prisma 中声明为普通模型（主键含 `ts` 以满足 PostgreSQL 分区约束），物理 DDL 由手写 SQL 迁移创建，分区维护由 node-cron 定时任务调用数据库函数完成。细节与取舍见 design.md。

## 6. 验收标准

- [x] `npx prisma generate` 成功，且 CLI 与 `@prisma/client` 同为 7.10.x
- [x] `npx prisma migrate deploy` 在空库上一次通过，11 张表全部创建（禁用 `migrate reset`：分区父表会被判 drift）
- [x] `node_waits` 的 `(connector_id, event_id)` 唯一约束可拒绝重复回调
- [x] `idempotency_keys` 的 `request_hash` 不一致时拒绝，`status` 可支撑 `ON CONFLICT DO NOTHING` 抢占
- [x] `run_events`、`audit_logs` 在 `pg_class.relkind` 中为分区父表，且未被 DROP 的当月分区可正常插入
- [x] 跨月边界写入落到正确分区（含 `+08` 时区边界）
- [x] 并发抢任务用例：两个 worker 同时取队首，拿到不同 `run`，无重复
- [x] `idempotency_keys` 同键不同 body 被拒绝，同键同 body 返回快照
- [x] `secrets` 表中不存在明文（写入后直接查库只看到 bytea）
- [x] 过期分区可被 DROP，且 DROP 后不影响其他月份查询；清理动作写入 `audit_logs(actor_id='system')`
- [x] `npx tsc --noEmit` 通过

## 7. 开放问题

| 问题 | 结论 | 决策人 | 日期 |
|---|---|---|---|
| §4.1.1 要求持久化「等待关联」，但 §5.4 未定义对应表，是否新增 `node_waits` | **已定：新增**，字段见 design.md「`node_waits`」一节 | 陈智祥 | 2026-11-15 |
| `run_events.level` 的取值集合 | **已定：枚举 `info` / `warn` / `error`** | 陈智祥 | 2026-11-15 |
| `idempotency_keys` 是否在 PRD 4 列外补 `request_hash`、`status` | **已定：补两列**，支撑「同键不同 body 拒绝」与 `ON CONFLICT DO NOTHING` 抢占 | 陈智祥 | 2026-11-15 |
| Prisma 统一到 7.10.x 还是等 8.0.0 GA | **已定：7.10.x 稳定线**，根与 server 版本已对齐 | 陈智祥 | 2026-11-15 |
| 对象存储（COS）实际供应商与 SDK | 待定，不阻塞本计划：只定义 `output_ref` 字段与格式约定，不接 SDK | 李嘉俊 | 2026-11-22 |

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 首版 |
| 2026-11-15 | 关闭 4 个开放问题：新增 `node_waits`、`level` 用枚举、幂等表补两列、Prisma 定 7.10.x |
