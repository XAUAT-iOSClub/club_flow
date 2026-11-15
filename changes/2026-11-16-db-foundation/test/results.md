# 执行记录

## 2026-11-15 · 迁移落地到本地库

- 环境：Windows 11 / PostgreSQL 17（`D:\PostgreSQL\data`）/ Node 24.19.0 / Prisma 7.10.1
- 代码状态：工作区，尚未提交
- 数据库：`clubflow`（开发）、`clubflow_test`（测试），均为本机新库

| 步骤 | 命令 | 结果 |
|---|---|---|
| schema 校验 | `npx prisma validate` | 通过 |
| Client 生成 | `npx prisma generate` | 通过，输出 `packages/server/src/generated/prisma` |
| 开发库迁移 | `npm run -w @clubflow/server prisma:migrate`（`clubflow`） | 5 个迁移全部应用 |
| 测试库迁移 | `npm run -w @clubflow/server prisma:migrate`（`clubflow_test`） | 5 个迁移全部应用 |

## 结构验证（`clubflow`）

在事务内造数验证后回滚，未留脏数据。

| 检查项 | 期望 | 实测 |
|---|---|---|
| 表数量 | 11 张业务表 + `_prisma_migrations` + 6 个子分区 = 18 | 18 |
| 子分区 | `run_events` / `audit_logs` 各 202611、202612、202701 | 一致 |
| 分区路由 | 11 月事件落 `run_events_202611`，12 月落 `run_events_202612` | 一致 |
| `ensure_month_partition` | 创建 `run_events_202702`，重复调用不报错 | 返回 `run_events_202702`，第二次幂等 |
| 幂等键 `ON CONFLICT DO NOTHING` | 首次插入 1 行，同键第二次 0 行 | 1 / 0 |
| `node_waits` 回调去重 | 同 `(connector_id, event_id)` 第二次插入被拒 | `23505` 唯一冲突 |

## 2026-11-15 · 集成测试首轮（vitest）

- 命令：`npx vitest run`（cwd `packages/server`），`TEST_DATABASE_URL` 指向 `clubflow_test`
- 结果：2 个文件、9 个用例全部通过；`tsc --noEmit` 同时通过

| 用例 | 结果 |
|---|---|
| TC-001 / 002 / 003（分区名、时区、保留期） | 通过 |
| TC-005 / 006 / 007 / 008 / 009 / 010 | 通过 |
| TC-004 | 未自动化，迁移已用 `migrate deploy` 手工执行并通过结构校验 |

首轮失败并修掉的两个真问题：

1. `ensureMonthPartition` 用 Date 传边界。Prisma 7 的 query compiler 把 Date 序列化成不带偏移的 UTC 墙上时间，会话时区为 `Asia/Shanghai` 时边界整体前移 8 小时，生成的 `run_events_202610` 与 `202611` 区间重叠。改为显式 `+08` 字面量。
2. 同源问题影响所有 `timestamptz` 写入（12 月事件被写进 11 月分区）。已在 `createPrismaClient` 固定 `options: '-c timezone=UTC'`。

## 2026-11-15 · 构建入口与补索引

代码 review 发现两个交付阻断项，本轮修掉：

| 问题 | 现象 | 处理 |
|---|---|---|
| `build` 指向不存在的入口 | 两个 workspace 的 `tsup src/index.ts` 找不到文件，`npm run build` 直接失败 | 新建 `packages/server/src/index.ts`（导出 db / partitions 基础设施）与 `packages/schema/src/index.ts`（空导出占位） |
| `runs` 缺查询索引 | `version_id` 无索引，按版本查运行与删版本时全表扫；抢占用 `WHERE status ORDER BY created_at`，原索引只能过滤不能排序 | `schema.prisma` 的 `Run` 补 `@@index([versionId])`、`@@index([status, createdAt])`，并新增迁移 `20261115121000_runs_indexes` |

复跑结果（根目录）：

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过，server ESM 65.48 KB / schema DTS 13 B |
| `npm run typecheck` | 通过 |
| `npm test -w @clubflow/server` | 2 个文件、9 个用例全绿（3.32s） |

## 2026-11-15 · 事件 seq 唯一性与 BigInt 序列化

review 剩余项里的两条，本轮修掉：

| 问题 | 原因 | 处理 |
|---|---|---|
| `run_events` 的 `(run_id, seq, ts)` 唯一索引形同虚设 | PostgreSQL 要求分区表的唯一约束包含分区键，`ts` 不同即不同行，同一 run 可写入重复 `seq` | 新增 `runs.event_seq` 分配器，`appendRunEvent` 内 `UPDATE runs SET event_seq = event_seq + 1` 拿序号；迁移 `20261115122000_run_event_seq` 删除原唯一索引、补 `(run_id, seq)` 普通索引 |
| `RunEvent.id` / `AuditLog.id` 是 BigInt | Prisma 返回 JS `bigint`，`JSON.stringify` 直接抛 `TypeError`，进 REST/SSE 必然踩 | 新增 `src/infra/json.ts` 的 `stringifyJson` / `jsonReplacer`，id 统一按十进制字符串输出 |

迁移计划（4 个）：`init` → `partitions` → `runs_indexes` → `run_event_seq`，均已应用到 `clubflow` 与 `clubflow_test`。

结构校验（`clubflow_test`）：`run_events` 与 `run_events_202611` 上 `run_events_run_id_seq_ts_key` 已不存在，`run_events_run_id_seq_idx` 已建；`runs.event_seq` 为 `integer`。

复跑结果（根目录）：

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test -w @clubflow/server` | 3 个文件、12 个用例全绿（4.89s），新增 TC-011 / TC-012 |

## 2026-11-15 · 约束完整性与工程可用性

全量复查后修复的剩余问题：

| 问题 | 影响 | 处理 |
|---|---|---|
| `node_waits.status` 是自由字符串 | 回调处理写错值（如 `resolve`）不会被数据库拦下 | 新增枚举 `node_wait_status`（pending / resolved / expired），迁移 `20261115123000_node_wait_status_fk` |
| `node_waits.run_id` 无外键 | 运行删除后等待记录成孤儿；回调恢复会命中不存在的 run | 加 `ON DELETE CASCADE` 外键 + `(run_id)` 索引；`Run` 增加 `waits` 反向关系 |
| `triggers.workflow_id` 无索引 | 删除工作流时的外键检查全表扫 | 加 `(workflow_id)` 索引 |
| `listPartitions` 只按表名匹配 | 其他 schema 的同名表或普通表会被算成分区，清理逻辑可能误删 | 限定 `public` schema 且父表 `relkind='p'` |
| `DROP TABLE` 不带 schema | 结果依赖 `search_path` | 改为 `public."<name>"` |
| 生成的 Prisma Client 被 gitignore | 新克隆下 `build` / `typecheck` 直接失败 | `postinstall` 自动 generate；`build` 前置 `prisma generate`；`prisma.config.ts` 改用 `process.env.DATABASE_URL ?? ''`，让无 `.env` 环境也能生成 |
| `prisma.config.ts` / `vitest.config.ts` 未进类型检查 | 两个配置文件的类型错误不会被发现 | 根 `tsconfig.json` include 补上 |
| `AGENTS.md` §3 / §8 过期 | 文档仍称「脚本是占位、prisma 目录为空」 | 按当前落地状态重写 |

测试：TC-004 由手工改为自动化（`tests/infra/schema.test.ts`），TC-010 断言从「数量 ≥ 3」改为「第二次调用不新增分区且目标分区确实存在」，新增 TC-013（枚举 / 外键 / 索引）。

复跑结果（根目录）：

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `npm run typecheck` | 通过（现覆盖两个配置文件） |
| `npm test -w @clubflow/server` | 4 个文件、15 个用例全绿（8.37s） |
| `$env:DATABASE_URL=''; npx prisma generate` | 通过（无 `.env` 也能生成） |

## 2026-11-15 · Node 22 复跑

本机默认 Node 为 24.19.0，仓库 `.nvmrc` 为 22。用便携版 Node v22.23.5（npm 10.9.9）复跑，确认目标版本可用：

| 命令 | 结果 |
|---|---|
| `node -v` | v22.23.5 |
| `npm test -w @clubflow/server` | 4 个文件、15 个用例全绿（10.48s） |
| `npm run build` | 通过 |
| `npm run typecheck` | 通过 |

根 `package.json` 补 `engines: { node: ">=22" }`，避免在更低版本上误跑。

## 2026-11-15 · 分区定时维护

补齐阶段 3 遗留的两项：node-cron 注册与清理动作落审计。

| 文件 | 内容 |
|---|---|
| `src/infra/cron.ts`（新增） | `ensurePartitions()` / `prunePartitions()`（逐条写审计）/ `startPartitionMaintenance()`：03:00 预建、03:10 清理，`timezone: 'Asia/Shanghai'`、`noOverlap: true`，任务异常只记日志不抛回事件循环；返回停止函数供 Fastify `onClose` 调用 |
| `src/modules/audit/audit-log.ts`（新增） | `writeAuditLog(db, entry)`：审计写入统一入口 |
| `src/infra/partitions.ts`（修改） | 删除未使用的 `runPartitionMaintenance`，编排与审计只保留在 `cron.ts`，避免两条分叉实现 |
| `src/index.ts`（修改） | 导出 `infra/cron.js` 与 `modules/audit/audit-log.js` |
| `tests/infra/cron.test.ts`（新增） | TC-014 三个用例 |

`prunePartitions()` 每 DROP 一个分区写一条审计：`actor_id = actor_name = 'system'`、`action = 'partition.drop'`、`target_type = 'partition'`、`target_id` 为分区名、`after = { table, retentionDays }`。

复跑结果（根目录）：

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test -w @clubflow/server` | 5 个文件、18 个用例全绿（12.59s） |

## 2026-11-15 · 数据库层接口收口与复查

只做数据库层，其他模块的逻辑不实现，但把接入面收敛好。

| 改动 | 内容 |
|---|---|
| `src/infra/db.ts` | 新增 `Db`（`Prisma.TransactionClient`）与 `withTransaction()`；事务类型不再在各模块重复声明 |
| `src/modules/runtime/run-events.ts`、`src/modules/audit/audit-log.ts` | 改为复用 `Db`，不再各自定义 `Prisma.TransactionClient` |
| `src/index.ts` | 统一导出 `prisma` / `withTransaction` / 分区维护 / 审计 / 事件追加，以及 11 个模型类型与 7 个枚举；上层模块不直接 import `src/generated/prisma` |
| 新迁移 `20261115130000_ensure_partition_schema` | 加固 `ensure_month_partition`：分区名改从 `pg_class.relname` 取（`regclass::text` 在 search_path 不含 public 时会带 schema 前缀）；存在性检查限定 `public` schema，避免其他 schema 的同名表让预建被静默跳过 |

新增 TC-015：先在 `shadow` schema 造同名表，再预建 2099-01 分区，验证 `public` 下仍正常建出分区。该用例在旧函数下会失败，属于本次修复的回归用例。

迁移已用 `prisma migrate deploy` 应用到 `clubflow` 与 `clubflow_test`，两边均为 6 个迁移。

复跑结果（根目录，Node v22.23.5）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（server ESM 72.53 KB / schema DTS 13 B） |
| `npm test -w @clubflow/server` | 5 个文件、19 个用例全绿（15.37s） |

## 待办

- MT-002 仍为手工项：任务逻辑已由 TC-014 覆盖，但「进程内 03:00 / 03:10 实际触发」要等 Fastify 启动入口接线后观察日志。
