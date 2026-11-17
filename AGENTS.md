# AGENTS.md · ClubFlow 通用工作流引擎

> 所有 AI 编码代理（Claude Code、Codex、Cursor 等）在本仓库工作时的统一入口。
> `CLAUDE.md` 通过 `@AGENTS.md` 引用本文件，因此规则只维护这一份。
>
> 最后更新：2026-11-15

---

## 1. 项目是什么

ClubFlow 是西建大 iOS Club 的**通用工作流引擎**：把「流程」从硬编码的状态机变成数据（画布 + YAML → 同一份 DSL），由引擎负责编译、调度、通用异步等待、运行事件与观测。

系统由三部分组成：

| 部分 | 职责 | 归属 |
|---|---|---|
| 引擎（本仓库） | 流程定义、版本冻结、调度执行、异步等待与恢复、运行事件、连接器出站/入站 | `packages/server` |
| 官网后台 Vue 3 模块 | 画布、运行详情、Connector / 密钥 / 审计，路由 `/Centre/Flow` | 官网仓库，不在本仓库 |
| 独立审批服务 | 审批任务、审批人、决定、链接、通知与审批审计，通过 connector 接入 | 独立部署 |

**唯一权威文档**：[docs/PRD-通用工作流引擎.md](docs/PRD-通用工作流引擎.md)（v0.13，2026-11-14）。

本文件只做导航与约束提炼，**不替代 PRD**。两者冲突时以 PRD 为准，并顺手修正本文件。

---

## 2. 开始任何任务前

1. 读 PRD 的以下部分（其余按需查阅）：
   - §2 目标与非目标
   - §4.1.1 审批连接器方案（**审批相关唯一有效基线**）
   - §5 核心概念、状态机与数据模型
   - §6 身份、登录与权限
   - §7 功能需求（按任务查对应 F 章节）
   - §13 验收标准
2. 检查 [changes/](changes/) 下是否有活跃计划；非平凡任务必须先建计划，规则见 [changes/README.md](changes/README.md)。
3. 确认任务不落在 §2.3 的非目标里。

### 2.1 PRD 内部冲突的处理规则（重要）

PRD 的 v0.13 只改写了部分章节，**当前文档是混合状态**：

- **§4.1.1 是审批相关的唯一实现依据。**
- 其他章节中残留的以下内容属于 v0.12 旧方案，**只能作为 UX 参考，不能作为实现依据**：
  - 内置 `approval` 节点类型（§5.1、附录 A.2）
  - 引擎侧审批表 `approvals` / `approval_approvers` / `approval_tokens` / `approval_sessions`（§5.4）
  - 引擎签发审批 token、自托管审批页、`/public/approvals/*` 与 `/approvals/*` 接口（§6.3、§9.1）
  - 审批状态机归属引擎的表述（§5.3）
  - F8 中要求引擎实现审批业务逻辑的条目
- 新方案下，引擎实现的是**通用异步等待**：持久化等待关联 → 调用 connector 的创建 action → 校验签名回调并去重 → 条件更新恢复运行。审批人、token、会签/或签、截止与提醒、取消、链接和审批审计都在审批服务侧。

实现任何审批相关能力前，先在 change plan 的 `spec.md` 里写清楚「本计划依赖的审批服务契约」，不要默认旧章节有效。

---

## 3. 仓库现状（2026-11-15）

仓库处于**骨架阶段**，尚无业务代码：

```
package.json            npm workspaces（server / schema）
tsconfig.json           ES2022 + NodeNext + strict + noUncheckedIndexedAccess
.nvmrc                  Node 22
packages/schema/        @clubflow/schema：zod DSL 契约（入口占位，编译器未接入）
packages/server/        @clubflow/server：引擎本体
  src/infra/            db.ts（连接池/时区）、json.ts（BigInt 序列化）、partitions.ts（分区维护）、cron.ts（分区定时任务）
  src/modules/auth/     官网 JWT / JWKS 验签与角色映射（空）
  src/modules/compiler/ 解析、三档校验、归一化、冻结版本（空）
  src/modules/runtime/  run-events.ts（事件 seq 分配）；抢占、DAG、SSE 未开始
  src/modules/waits/    通用异步等待与恢复（审批是其中一个场景）（空）
  src/modules/connectors/ manifest、出站白名单、鉴权、入站 trigger（空）
  src/modules/workflows/ 工作流、草稿、版本、发布与回滚（空）
  src/modules/audit/    审计日志（audit-log.ts 已落地，其余待补）
  prisma/               11 张表的 schema.prisma + 7 个 SQL 迁移（分区表为手写 DDL）
  tests/                infra 集成测试（20 个用例，跑在 clubflow_test）
docs/PRD-通用工作流引擎.md
changes/                变更计划（本文件新增）
```

已知待对齐项：

- 根 `devDependencies` 的 `prisma` 与 `packages/server` 的 `@prisma/client` 已统一到 `^7.10.1`。Prisma 7 需要 driver adapter（`@prisma/adapter-pg`）才能实例化 Client。
- 根 `package.json` 是 `"type": "commonjs"`，两个 workspace 是 `"type": "module"`；这是合法的分层，但新增根级脚本时注意 ESM/CJS 差异。
- PRD 提到 `pnpm audit`，但仓库实际使用 **npm workspaces + package-lock.json**。以仓库现状为准，不要引入 pnpm。

---

## 4. 技术栈（已定，不要自行更换）

| 用途 | 选型 | 备注 |
|---|---|---|
| 运行时 | Node 22 LTS | 生产跑编译产物，不用 ts-node |
| 语言 | TypeScript 5.9，`strict` | 子包为 ESM（`type: module`） |
| Web | Fastify 5 | pino 日志、schema 校验 |
| DSL 契约 | zod（`@clubflow/schema`） | 前后端共用同一份 |
| JWT | jose | 验官网 access token（JWKS / RS256） |
| YAML | `yaml` | 必须保序、保留注释 |
| ORM / 迁移 | Prisma + SQL 迁移文件 | 分区表用 SQL |
| 队列抢占 | `FOR UPDATE SKIP LOCKED` | 不引入 Redis / pg-boss |
| 定时 | node-cron | 超时扫描、分区清理、幂等键清理 |
| 表达式 | 自研 AST | 禁止 `eval` / `Function` |
| SSE | Fastify `reply.raw` | 关闭压缩，30 秒心跳 |
| 指标 | prom-client | `/api/v1/metrics`，仅内网 |
| 测试 | vitest + 真实 PG | 集成测试不 mock 数据库 |
| 构建 | tsup | ESM 单 entry |

**基址约定**：API `https://flowapi.<域名>/api/v1`；后台 `/Centre/Flow`；时间统一 RFC 3339 带 `+08:00`。

---

## 5. 不可违反的架构约束

以下约束来自 PRD，改动它们需要先改 PRD 和验收标准，而不是在代码里绕开。

1. **流程即数据**：画布与 YAML 都是编辑器，编译成同一份规范 DSL；运行只绑定**冻结版本**，草稿改动不影响在跑的运行。
2. **单向编译**：解析 → zod 校验 → 语义校验 → 归一化 → 冻结（hash + version）。`layout` 只存库，永不写入 YAML。
3. **不支持并行分支**：同一个 `on` 值下只允许一条出边，编译期报错（CF-4002）。
4. **只做 HTTP 连接器**：节点不允许内联 `url`，只能 `uses: {connectorId}.{actionKey}@version`；出站必须过白名单、防 SSRF（内网/回环/云元数据拒绝、解析后 IP 直连、重定向逐跳复检）。
5. **密钥只写不读**：`secrets` 只能出现在 connector manifest 的 `auth` 字段，不得出现在 `with`、表达式、日志、事件、审计或响应体里。
6. **幂等语义**：出站带 `X-Idempotency-Key: {runId}:{nodeId}:{attempt}`；`idempotent: true` 才允许自动重试；人工重试必须产生新 attempt 和新幂等键。
7. **崩溃不自动重跑**：worker 5 秒心跳，2 分钟判死，标记 `failed(interrupted)`；由人决定「从失败节点继续」，避免 HTTP 副作用重放。
8. **单线程三条硬约束**：请求路径禁止同步 CPU 重活；表达式求值必须有步数（默认 10 万）与深度（默认 32）上限；进程异常记录后优雅退出。
9. **引擎是 resource server**：只验官网 JWT，不签发；标准 `RS256` + JWKS（B1/B2），校验 `iss` / `aud` / `exp` / `nbf` / `usage=access`，拒绝 `none` 与 `HS*`；**不建用户表**，展示姓名用签名时快照。
10. **权限在服务端强制**：rank ≥ 30 为 `admin` 可读写；rank = 20（Department）为 `member` 只读，唯一写操作是提交被指派的审批决定；rank < 20 一律 403。前端隐藏菜单不算授权。
11. **数据层纪律**：独立 PostgreSQL 实例（库名 `clubflow`）；同一状态迁移的 run / node_run / run_events 放一个事务；HTTP 调用一律在事务外；`run_events` / `audit_logs` 按 `ts` 月分区，用 SQL 迁移建表。连接会话时区固定为 UTC（Prisma 7 的 query compiler 把 Date 序列化成不带偏移的 UTC 墙上时间，会话时区非 UTC 会让 `timestamptz` 整体偏移），分区边界一律写显式 `+08`。
12. **异步等待的取消与恢复**：先持久化取消状态，再幂等请求外部取消；迟到结果不得恢复已取消运行；回调验签、时间窗、去重、条件更新缺一不可。

---

## 6. 非目标（本期明确不做）

不要实现、也不要为它们预留过度抽象：

- Git 仓库同步 / CI 集成
- 容器执行、脚本执行
- 并行分支、matrix 展开、子工作流
- BPMN 2.0 兼容
- 多租户、计费、流程模板市场
- 移动端 App
- 自动重跑崩溃的运行
- 版本可视化 diff（P2）
- 自建账号体系

---

## 7. 开发流程：变更计划（必读）

所有非平凡改动都必须在 [changes/](changes/) 下建立计划目录，包含 `spec.md`、`design.md`、`plan.md` 与 `test/`。完成后用 `git mv` 移入 [changes/archive/](changes/archive/)。

详细规则与模板见 [changes/README.md](changes/README.md) 与 [changes/_template/](changes/_template/)。

最低要求：

1. 计划目录名 `YYYY-MM-DD-<kebab-slug>`。
2. `spec.md` 写「为什么、做什么、不做什么、怎么验收」，并引用 PRD 条款。
3. `design.md` 写技术方案、数据/接口变更、取舍与回滚。
4. `plan.md` 写可勾选任务、依赖、状态与时间。
5. `test/` 随开发同步更新用例与执行记录，不要事后补。
6. 计划过期（已交付、已放弃、被新计划取代）就归档，不在原地堆历史。

---

## 8. 常用命令

```bash
npm install                 # 安装 workspace 依赖（server 的 postinstall 会自动 prisma generate）
npm run typecheck           # 类型检查（含 prisma.config.ts / vitest.config.ts）
npm run build               # 构建两个 workspace
npm test                    # 按 workspace 聚合跑测试
npm test -w @clubflow/server # 只跑引擎测试（vitest）
npx tsx <file.ts>           # 直接运行 TS
npm run -w @clubflow/server prisma:generate   # 生成 Prisma Client
npm run -w @clubflow/server prisma:migrate    # 应用迁移（migrate deploy，禁止 migrate dev）
```

不要在仓库根目录直接跑 `npx vitest run`：它会连同 `.agents/skills/**` 一起扫描，报 “No test suite found”。用 `npm test` 或进 `packages/server` 再跑。

Prisma 7 的两点差异：连接串写在 `packages/server/prisma.config.ts`（schema 里不再支持 `url`）；Prisma 命令必须在 `packages/server` 目录下执行，否则读不到该配置文件。

新增脚本时写入对应 workspace 的 `package.json`，不要在根目录复制一份。

---

## 9. 编码规范

- TypeScript 严格模式；不使用 `any`（确有必要时写明理由并局部收窄）。
- NodeNext + ESM：包内相对导入**必须带 `.js` 扩展名**。
- 外部输入（HTTP body、YAML、webhook）一律视为不可信，在边界用 zod 校验。
- 错误使用 PRD §9.2 的错误码（`CF-4001`、`CF-4220` 等），不临时发明字符串。
- 日志与事件遵循 FR-10.8 脱敏清单：`secrets`、`Authorization` / `Cookie`、审批 token、webhook token、`Idempotency-Key`、签名 query、请求响应体中的密钥字段。
- 不引入新依赖除非必要；锁文件必须入库。
- 代码注释、文档、提交说明使用中文，与仓库现有文档保持一致。

---

## 10. 测试要求

- 单元测试用 vitest；集成测试用真实 PostgreSQL（docker-compose 起库），不 mock 数据库。
- 引擎核心（编译 / 调度 / 执行）单测覆盖率目标 ≥ 70%（NFR-13）。
- 每个 change plan 的 `test/` 下维护：测试范围与环境、用例清单、执行记录与证据。
- 安全类改动必须覆盖对应验收项：伪造 JWT、越权、SSRF、脱敏、幂等、重放。

---

## 11. 交付前检查清单

- [ ] change plan 的 `spec.md` / `design.md` / `plan.md` / `test/` 已更新
- [ ] `npx tsc --noEmit` 通过
- [ ] 相关测试通过，`test/results.md` 记录了执行结果
- [ ] 改动逐条对应 PRD 验收项
- [ ] 未越界实现 §6 非目标
- [ ] 密钥、token、个人信息未出现在日志与文档中
- [ ] 行为变化已同步到 `design.md` 或 PRD（如需改 PRD，先征得用户同意）
- [ ] 计划完成或放弃后已归档

---

## 12. 文档维护

- PRD 变更后，检查本文件第 2、5、6 节是否仍然成立。
- 本文件只写「长期有效的规则」；一次性的方案细节放 `changes/`，不要写进来。
- 发现 PRD 与代码、文档与代码不一致时，先记录到 change plan 的「开放问题」，再决定改哪一边。
