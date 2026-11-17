# 底层数据库构建 · 技术设计

## 1. 方案概述

用 Prisma 7.10.x 作为唯一 ORM 与迁移工具，模型全部声明在 `packages/server/prisma/schema.prisma`。10 张业务表中，`run_events` 与 `audit_logs` 需要按月分区，而 Prisma 无法表达 `PARTITION BY`，因此这两张表在 Prisma 中只声明为普通模型（用于生成类型与查询能力），物理 DDL 改由手写 SQL 迁移创建：分区父表 + 分区维护函数 + 初始分区。分区的新建与过期清理由 node-cron 每日任务调用数据库函数完成，过期分区一律 `DROP` 而非逐行 `DELETE`。

## 2. 关键设计

### 2.1 数据模型

#### 通用约定

| 约定 | 取值 | 理由 |
|---|---|---|
| 主键 | 应用侧实体用 `cuid()`；事件/审计用 `bigint` 序列 | cuid 可应用侧生成、不暴露自增规模；事件表量大，int 主键更省空间 |
| 时间列 | 统一 `timestamptz(3)` | 毫秒精度足够，带时区避免跨时区歧义 |
| JSON 列 | `jsonb` | 可索引、可查询 |
| 命名 | Prisma 驼峰 + `@map` / `@@map` 映射到 snake_case | 与 PRD 表结构一致，SQL 侧可读 |
| 用户标识 | 裸字符串，**无外键** | §6.2：引擎只做 resource server，不维护用户表 |
| 密文 | `Bytes`（PG `bytea`） | `secrets.cipher` / `nonce` |
| 枚举 | 类型名 `@@map` 成 snake_case，值一律 `@map` 成小写 | SQL 里可直接写 `status = 'queued'`，也便于手写分区 DDL 引用类型 |

#### 表清单（11 张：PRD §5.4 的 10 张 + `node_waits`，已剔除废弃审批 4 表）

| # | 表 | 主键 | 唯一约束 | 索引 |
|---|---|---|---|---|
| 1 | `workflows` | `id` | `slug` | — |
| 2 | `workflow_versions` | `id` | `(workflow_id, version)` | — |
| 3 | `connectors` | `(id, version)` | — | — |
| 4 | `runs` | `id` | — | `(workflow_id, created_at DESC)`、`(status, heartbeat_at)`、`(version_id)`、`(status, created_at)` |
| 5 | `node_runs` | `id` | `(run_id, node_id, attempt)` | 复合唯一键前缀即 `(run_id)` |
| 6 | `run_events` | `(id, ts)` | —（分区表无法约束 run 内 `seq` 唯一，改由 `runs.event_seq` 原子分配） | `(run_id, seq)`、`(run_id, ts DESC)` |
| 7 | `secrets` | `name` | — | — |
| 8 | `triggers` | `id` | — | `(workflow_id)`、`(enabled, next_run_at)` |
| 9 | `audit_logs` | `(id, ts)` | — | `(target_type, target_id, ts DESC)` |
| 10 | `idempotency_keys` | `(scope, key)` | — | `(exp)` |
| 11 | `node_waits` | `id` | `correlation_id`、`(connector_id, event_id)` | `(run_id)`、`(status, deadline)` |

#### 关键模型（已确认，落地 schema.prisma）

```prisma
enum RunStatus { QUEUED RUNNING WAITING SUCCEEDED FAILED CANCELED TIMED_OUT }
enum NodeRunStatus { PENDING RUNNING WAITING SUCCEEDED FAILED SKIPPED CANCELED }
enum RunMode { REAL TEST }
enum TriggerType { MANUAL CRON WEBHOOK }
enum IdempotencyStatus { IN_FLIGHT COMPLETED }
enum RunEventLevel { INFO WARN ERROR }

model Workflow {
  id               String    @id @default(cuid())
  name             String
  slug             String    @unique
  ownerId          String    @map("owner_id")           // 学号快照，无外键
  draft            Json      @db.JsonB
  draftRevision    Int       @default(1) @map("draft_revision")
  publishedVersion Int?      @map("published_version")
  archivedAt       DateTime? @map("archived_at") @db.Timestamptz(3)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)
  versions         WorkflowVersion[]
  runs             Run[]
  triggers         Trigger[]
  @@map("workflows")
}

model WorkflowVersion {
  id         String   @id @default(cuid())
  workflowId String   @map("workflow_id")
  version    Int
  dsl        Json     @db.JsonB
  yaml       String
  layout     Json     @db.JsonB
  hash       String
  createdBy  String?  @map("created_by")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  workflow   Workflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  runs       Run[]
  @@unique([workflowId, version])
  @@map("workflow_versions")
}

model Connector {
  id        String                      // 全名 = {id}.{actionKey}
  version   Int
  kind      String                      // 首版仅 http
  manifest  Json     @db.JsonB          // 含 actions / triggers
  createdBy String?  @map("created_by")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  @@id([id, version])
  @@map("connectors")
}

model Run {
  id              String        @id @default(cuid())
  workflowId      String        @map("workflow_id")
  versionId       String        @map("version_id")
  mode            RunMode
  status          RunStatus     @default(QUEUED)
  trigger         Json          @db.JsonB
  triggeredBy     String?       @map("triggered_by")
  triggeredByName String?       @map("triggered_by_name")  // 姓名快照
  inputs          Json          @db.JsonB
  vars            Json          @db.JsonB
  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  startedAt       DateTime?     @map("started_at") @db.Timestamptz(3)
  finishedAt      DateTime?     @map("finished_at") @db.Timestamptz(3)
  heartbeatAt     DateTime?     @map("heartbeat_at") @db.Timestamptz(3)
  durationMs      Int?          @map("duration_ms")
  waitedMs        Int?          @map("waited_ms")
  error           Json?         @db.JsonB
  eventSeq        Int           @default(0) @map("event_seq")  // 事件序号分配器
  workflow        Workflow      @relation(fields: [workflowId], references: [id])
  version         WorkflowVersion @relation(fields: [versionId], references: [id])
  nodes           NodeRun[]
  events          RunEvent[]
  @@index([workflowId, createdAt(sort: Desc)])
  @@index([status, heartbeatAt])
  @@index([versionId])
  @@index([status, createdAt])
  @@map("runs")
}

model NodeRun {
  id         String        @id @default(cuid())
  runId      String        @map("run_id")
  nodeId     String        @map("node_id")
  attempt    Int           @default(1)
  status     NodeRunStatus @default(PENDING)
  input      Json?         @db.JsonB
  output     Json?         @db.JsonB
  outputRef  String?       @map("output_ref")   // >256KB 时正文进 COS
  error      Json?         @db.JsonB
  startedAt  DateTime?     @map("started_at") @db.Timestamptz(3)
  finishedAt DateTime?     @map("finished_at") @db.Timestamptz(3)
  waitedMs   Int?          @map("waited_ms")
  run        Run           @relation(fields: [runId], references: [id], onDelete: Cascade)
  @@unique([runId, nodeId, attempt])
  @@map("node_runs")
}

model RunEvent {
  id      BigInt   @default(autoincrement())
  runId   String   @map("run_id")
  seq     Int
  ts      DateTime @db.Timestamptz(3)
  level   RunEventLevel               // 已定：info / warn / error
  nodeId  String?  @map("node_id")
  type    String
  message String?
  data    Json?    @db.JsonB
  run     Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  @@id([id, ts])                       // 主键必须含分区键
  @@index([runId, seq])                // 断点续传按 seq 增量拉取
  @@index([runId, ts(sort: Desc)])
  @@map("run_events")
}

model Secret {
  name       String   @id
  cipher     Bytes                     // AES-256-GCM 密文
  nonce      Bytes                     // 每次加密随机 12 字节
  keyVersion Int      @map("key_version")
  createdBy  String?  @map("created_by")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  @@map("secrets")
}

model Trigger {
  id         String      @id @default(cuid())
  workflowId String      @map("workflow_id")
  type       TriggerType
  config     Json        @db.JsonB
  enabled    Boolean     @default(true)
  nextRunAt  DateTime?   @map("next_run_at") @db.Timestamptz(3)
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime    @updatedAt @map("updated_at") @db.Timestamptz(3)
  workflow   Workflow    @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  @@index([enabled, nextRunAt])
  @@map("triggers")
}

model AuditLog {
  id         BigInt   @default(autoincrement())
  actorId    String?  @map("actor_id")
  actorName  String?  @map("actor_name")   // 姓名快照
  action     String
  targetType String   @map("target_type")
  targetId   String   @map("target_id")
  before     Json?    @db.JsonB
  after      Json?    @db.JsonB
  ip         String?
  ts         DateTime @default(now()) @db.Timestamptz(3)
  @@id([id, ts])
  @@index([targetType, targetId, ts(sort: Desc)])
  @@map("audit_logs")
}

model IdempotencyKey {
  scope       String            // 'user:<sub>' / 'service:<client_id>'
  key         String            // sha256(Idempotency-Key) hex
  requestHash String            @map("request_hash")   // 已定：同键不同 body 拒绝
  status      IdempotencyStatus @default(IN_FLIGHT)    // 已定：ON CONFLICT DO NOTHING 抢占
  response    Json?             @db.JsonB
  exp         DateTime          @db.Timestamptz(3)
  createdAt   DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  @@id([scope, key])
  @@index([exp])
  @@map("idempotency_keys")
}
```

#### `node_waits`（§4.1.1 的落地缺口，已确认新增）

§4.1.1 要求引擎「持久化等待关联 → 调 connector 创建 → 验签回调去重 → 条件更新恢复」，但 §5.4 迁移到新基线后没有给出对应表。经确认首版建表：

```prisma
model NodeWait {
  id             String    @id @default(cuid())
  runId          String    @map("run_id")
  nodeId         String    @map("node_id")
  attempt        Int
  connectorId    String    @map("connector_id")
  correlationId  String    @unique @map("correlation_id")   // 回调随带，先到也能落位
  externalTaskId String?   @map("external_task_id")
  eventId        String?   @map("event_id")
  status         NodeWaitStatus                              // pending / resolved / expired（枚举 node_wait_status）
  result         Json?     @db.JsonB
  deadline       DateTime? @db.Timestamptz(3)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  resolvedAt     DateTime? @map("resolved_at") @db.Timestamptz(3)
  run            Run       @relation(fields: [runId], references: [id], onDelete: Cascade)
  @@unique([connectorId, eventId])                          // 回调去重
  @@index([runId])
  @@index([status, deadline])
  @@map("node_waits")
}
```

**约束补充**：`status` 用枚举而不是自由字符串，避免回调处理时写错值；`run_id` 加外键并级联删除，否则运行删除后等待记录成孤儿、回调恢复会命中不存在的 run。

**已确认写入 schema**；PRD §5.4 的表清单尚缺此表，需在 PRD 下一次修订时补齐（本计划不改 PRD 正文，只在交付说明中标注）。

#### 分区设计（`run_events` / `audit_logs`）

**Prisma 侧**：只声明普通模型，作用是为 Prisma Client 提供类型。分区键 `ts` 必须进主键（PostgreSQL 硬约束：分区表的唯一约束必须包含全部分区列），因此是 `@@id([id, ts])` 而非 `@@id([id])`。

**物理 DDL**：由手写 SQL 迁移创建，三要素——父表、序列、初始分区。注意**不能用 `bigserial` / identity**，因为在分区父表上使用序列 + 默认值最稳妥：

```sql
CREATE TYPE run_event_level AS ENUM ('info', 'warn', 'error');
CREATE SEQUENCE run_events_id_seq;

CREATE TABLE run_events (
  id       bigint       NOT NULL DEFAULT nextval('run_events_id_seq'),
  run_id   text         NOT NULL,
  seq      integer      NOT NULL,
  ts       timestamptz(3) NOT NULL,
  level    run_event_level NOT NULL,
  node_id  text,
  message  text,
  type     text         NOT NULL,
  data     jsonb,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX run_events_run_id_seq_idx ON run_events (run_id, seq);
CREATE INDEX run_events_run_id_ts_idx ON run_events (run_id, ts DESC);

CREATE TABLE run_events_202611 PARTITION OF run_events
  FOR VALUES FROM ('2026-11-01 00:00:00+08') TO ('2026-12-01 00:00:00+08');
```

> **`seq` 唯一性**：分区表的唯一索引必须包含分区键，`(run_id, seq, ts)` 并不能阻止同一 run 写入重复 `seq`（`ts` 不同就是不同行）。因此不建该唯一索引，改由 `runs.event_seq` 原子分配：`UPDATE runs SET event_seq = event_seq + 1 RETURNING event_seq`，行锁保证同一 run 串行、不同 run 互不阻塞，事务回滚时自增一并回滚。落地位置 `src/modules/runtime/run-events.ts` 的 `nextEventSeq` / `appendRunEvent`。

`audit_logs` 同构（`audit_logs_id_seq`、`PRIMARY KEY (id, ts)`、按 `ts` 分区）。

**BigInt 主键的序列化**：`run_events.id` / `audit_logs.id` 在运行时是 JS `bigint`，直接 `JSON.stringify` 会抛 `TypeError: Do not know how to serialize a BigInt`。对外出口（REST 响应、SSE 帧）统一走 `src/infra/json.ts` 的 `stringifyJson`，id 按十进制字符串输出；不要转 `Number`，超过 2^53 会丢精度。

**分区维护函数**：

```sql
CREATE OR REPLACE FUNCTION ensure_month_partition(
  parent regclass, month_start timestamptz, month_end timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  part_name text;
BEGIN
  -- 分区名从 relname 取：regclass::text 在 search_path 不含 public 时会带 schema 前缀
  -- 必须把 timestamptz 转到 +08 再取年月，否则 UTC 会话下会得到上一个月
  SELECT c.relname || '_' || to_char(month_start AT TIME ZONE 'Asia/Shanghai', 'YYYYMM')
    INTO part_name FROM pg_class c WHERE c.oid = parent;

  -- 存在性检查限定 public：其他 schema 的同名表会让预建被静默跳过
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = part_name AND n.nspname = 'public'
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, month_start, month_end);
  END IF;
  RETURN part_name;
END $$;
```

返回值用 `text` 而**不是 `void`**：Prisma 的 `$queryRaw` 无法反序列化 `void` 列，返回分区名可以顺带拿到结果。

**两个必须守住的细节**：

1. 分区边界必须显式带 `+08`。`timestamptz` 的边界按会话时区解释，服务器跑 UTC 时用裸字符串会整体错 8 小时，表现为「月末最后几小时的写入找不到分区」。
2. 子分区不出现在 schema.prisma 中。Prisma 只管理和 schema 一致的模型，不会去 DROP 未声明的表，两者可共存；但**这两张表永远不能用 `prisma db push`**。

### 2.2 接口

本计划不新增接口。表结构需满足后续接口的读取需求：`runs` 列表分页依赖 `(workflow_id, created_at DESC)`；运行详情的事件流依赖 `(run_id, ts DESC)`；观测页的审计检索依赖 `(target_type, target_id, ts DESC)`。

### 2.3 模块改动

| 文件 | 职责 |
|---|---|
| `packages/server/prisma/schema.prisma` | 全部模型与枚举；生成器输出到 `src/generated/prisma` |
| `packages/server/prisma.config.ts` | Prisma 7 的连接串配置（schema 里已不能写 `url`），并从仓库根 `.env` 读取环境变量 |
| `packages/server/prisma/migrations/<ts>_init/migration.sql` | Prisma 生成后手工改写两张分区表的建表语句 |
| `packages/server/prisma/migrations/<ts>_partitions/migration.sql` | `ensure_month_partition`、序列、初始分区、清理辅助函数 |
| `packages/server/prisma/migrations/<ts>_runs_indexes/migration.sql` | 补 `runs(version_id)`、`runs(status, created_at)` |
| `packages/server/prisma/migrations/<ts>_run_event_seq/migration.sql` | `runs.event_seq` 分配器；删除无效的 `(run_id, seq, ts)` 唯一索引，改为 `(run_id, seq)` 普通索引 |
| `packages/server/prisma/migrations/<ts>_node_wait_status_fk/migration.sql` | `node_waits` 状态枚举、`run_id` 外键与索引、`triggers(workflow_id)` 索引 |
| `packages/server/prisma/migrations/<ts>_ensure_partition_schema/migration.sql` | 加固 `ensure_month_partition`：分区名取自 `relname`、存在性检查限定 `public` |
| `packages/server/prisma/migrations/<ts>_updated_at_defaults/migration.sql` | 给 `workflows` / `secrets` / `triggers` 的 `updated_at` 补数据库默认值（Prisma 的 `@updatedAt` 只在客户端填充） |
| `packages/server/src/infra/db.ts` | PrismaClient 单例（连接池 20、会话时区 UTC）、`Db` 事务客户端类型、`withTransaction()` 事务入口、`disconnectDb()` |
| `packages/server/src/index.ts` | 数据库层公共接口：`prisma` / `withTransaction` / 分区维护 / 审计 / 事件追加，以及模型类型与枚举；上层模块不直接 import `src/generated/prisma` |
| `packages/server/src/infra/json.ts` | BigInt 安全序列化：`stringifyJson` / `jsonReplacer`，所有 REST/SSE 出口必须走这里 |
| `packages/server/src/infra/partitions.ts` | 预建未来 2 个月分区、DROP 超期分区（事件 90 天 / 审计 180 天） |
| `packages/server/src/infra/cron.ts` | `startPartitionMaintenance()` 注册每日任务（03:00 预建 / 03:10 清理），返回停止函数供 Fastify 关闭时调用 |
| `packages/server/src/modules/audit/audit-log.ts` | `writeAuditLog(db, entry)`：审计写入统一入口，清理动作在此落库 |
| `packages/server/src/modules/runtime/run-events.ts` | `nextEventSeq` / `appendRunEvent`，seq 由 `runs.event_seq` 原子分配 |
| `packages/server/tests/infra/db.test.ts` | 抢任务并发、状态迁移原子性、事件 seq 分配 |
| `packages/server/tests/infra/json.test.ts` | BigInt 序列化 |
| `packages/server/tests/infra/partitions.test.ts` | 分区边界、预建幂等、DROP 后查询 |
| `packages/server/tests/infra/cron.test.ts` | 清理写审计、保留期内不清理、任务可注册并停止 |

### 2.4 关键流程

**迁移执行顺序**（实际落地为 7 个迁移，全部用 `prisma migrate deploy` 应用）

```
1. init：prisma migrate diff --from-empty 生成基线后手工改写两张分区表
2. partitions：ensure_month_partition + 序列 + 初始 3 个月分区
3. runs_indexes：补 version_id、status+created_at
4. run_event_seq：runs.event_seq 分配器 + run_events 索引调整
5. node_wait_status_fk：node_waits 状态枚举、run_id 外键、triggers 外键索引
6. ensure_partition_schema：加固 ensure_month_partition（分区名取自 relname、限定 public）
7. updated_at_defaults：三张表的 updated_at 补数据库默认值
```

禁止使用 `prisma migrate dev` / `reset`：分区父表与 schema.prisma 的普通模型声明不完全一致，会被判为 drift 并提示重库。

**抢任务（§5.4 实现约束）**

```sql
-- 短事务内一条语句认领，立即提交；HTTP 调用必须在事务外
SELECT id FROM runs
WHERE status = 'queued'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

**每日分区维护**

| 任务 | 时间 | 动作 |
|---|---|---|
| 预建 | 03:00 | 对两张表各 `ensure_month_partition` 未来 2 个月，幂等 |
| 清理 | 03:10 | 枚举子分区，上界早于 `now() - 保留期` 的整月分区 `DROP TABLE` |

清理只 DROP **完整过期月**，不裁剪当月；副作用是最多多留约 1 个月数据，可接受。

**落地方式**：`src/infra/cron.ts` 的 `startPartitionMaintenance()` 用 node-cron 注册两个任务，`timezone: 'Asia/Shanghai'`、`noOverlap: true`（上一轮未结束则跳过本轮），任务内异常只记日志、不抛回事件循环，避免拖垮进程。它返回一个停止函数，等 Fastify 入口落地后在 `onClose` 里调用。单独导出的 `ensurePartitions()` / `prunePartitions()` 便于测试与手工触发，`prunePartitions()` 每 DROP 一个分区就写一条 `audit_logs`：`actor_id = actor_name = 'system'`、`action = 'partition.drop'`、`target_type = 'partition'`、`target_id` 为分区名、`after = { table, retentionDays }`。

## 3. 安全与权限

- **不建用户表**：`owner_id` / `triggered_by` / `actor_id` / `created_by` 全是字符串快照，无外键，用户删除不影响历史。
- **`secrets` 只存密文**：`cipher` + `nonce` + `key_version`，AES-256-GCM 加解密在上层 `packages/server/src/infra/crypto.ts`（不在本计划范围），主密钥只来自 `CLUBFLOW_MASTER_KEY`，数据库层不使用 pgcrypto。
- **数据库账号最小权限**：应用账号仅需 `SELECT/INSERT/UPDATE/DELETE` 与 DDL 权限分离；生产环境迁移用独立账号执行。
- **审计不落敏感值**：`audit_logs.before/after` 禁止包含密钥明文、完整请求头、token。
- **连接**：生产 `DATABASE_URL` 强制 TLS；连接池上限 20（与 §4.3 部署约束一致）。

## 4. 备选方案与取舍

| 方案 | 优点 | 缺点 | 是否采用 |
|---|---|---|---|
| Prisma 7.10.x 稳定线 | 版本稳定、文档与生成器行为确定 | 不是最新 | **采用** |
| Prisma 8.0.0-rc | 新特性 | RC 阶段 CLI/迁移格式可能变，6 天工期风险高 | 否 |
| 用 Prisma 声明分区 | 一处维护 | Prisma 不支持 `PARTITION BY`，做不到 | 否 |
| 手写 SQL 迁移建分区表 | 完全满足 PG 约束 | 需人工维护 DDL，有 drift 风险 | **采用**（配 `migrate diff` 校验） |
| 分区父表用 `bigserial` | 写法短 | 分区表上序列/identity 行为受版本限制，易踩坑 | 否，改用显式 `SEQUENCE` |
| 行锁队列（`SKIP LOCKED`） | 零额外组件，事务内原子 | 吞吐上限低于专用队列 | **采用**（PRD 明确） |
| pg-boss / BullMQ | 功能完整 | 引入 Redis 或额外表，偏离 PRD 技术栈 | 否 |
| `run_events` 不分区 | 简单 | 事件表无界增长，清理靠 DELETE 会锁表 | 否 |

## 5. 兼容、迁移与回滚

- **无存量数据**：这是首版 schema，不涉及数据迁移。
- **部署顺序**：先执行迁移，再启动服务；服务启动时不做隐式建表。
- **回滚**：开发期直接 `prisma migrate reset`；生产回滚即 `DROP DATABASE clubflow` 后用备份恢复（首版无业务数据，风险为零）。
- **对在跑运行的影响**：无（尚无运行数据）。

## 6. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| Prisma 与迁移 SQL 出现 drift | 后续迁移失败或误改分区表 | 每次改 DDL 后跑 `prisma migrate diff` 校验；分区表禁止 `db push` |
| 分区边界时区写错 | 月末数据无法插入 | 边界统一显式 `+08`，用例覆盖跨月插入 |
| 忘记预建分区 | 新月首日写入报「no partition found」 | 每日预建未来 2 个月；再加写入前兜底 `ensure_month_partition` |
| `@@id([id, ts])` 导致 Prisma 主键语义变化 | 按 `id` 单查需带 `ts`，部分查询写起来更繁琐 | 对外查询统一走 `run_id` 索引；必要时用 `findFirst` 代替 `findUnique` |
| `node_waits` 与 PRD §5.4 表清单不一致 | 后续对表时出现分歧 | 已在 spec / design 记录为经确认的补充项，PRD 下次修订补齐 |
| Prisma 版本升级到 8 GA | 需重写迁移 | 单独开变更计划，不与首版混做 |

## 7. 测试策略

- **单元**：分区名生成、保留期计算、时区边界换算（纯函数，无需 DB）。
- **集成（真实 PG）**：迁移空库可重建；跨月写入落正确分区；并发 `SKIP LOCKED` 不重复认领；`run`/`node_run`/`run_event` 同事务原子性；幂等键冲突分支；`secrets` 落库无明文。
- **手工**：`psql` 查 `pg_class` 确认父表与子分区；观察 03:00 / 03:10 任务日志。
- 详细用例见 [test/cases.md](test/cases.md)。
