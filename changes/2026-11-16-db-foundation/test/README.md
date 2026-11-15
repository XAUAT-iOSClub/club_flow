# 底层数据库构建 · 测试说明

## 1. 测试范围

覆盖：schema 可生成、迁移可在空库重建、两张分区表的物理形态与写入路由、分区维护任务的预建与清理（含 system 审计）、抢任务的并发安全性、状态迁移的原子性、幂等键冲突分支、`secrets` 不落明文。

不测：DSL 编译、HTTP 连接器调用、JWT 验签、REST 接口语义——属其他变更计划。

## 2. 环境与准备

| 项目 | 内容 |
|---|---|
| Node | 22（`.nvmrc`） |
| 数据库 | 独立 PostgreSQL 实例（库 `clubflow`）；集成测试用独立库 `clubflow_test` |
| 环境变量 | 见仓库根 `.env.example`；集成测试需 `TEST_DATABASE_URL` |
| 启动命令 | `npm run -w @clubflow/server prisma:migrate`（`migrate deploy`）后 `npm test -w @clubflow/server`；禁止 `migrate reset`，分区父表会被判 drift |
| 前置数据 | 无；每个集成用例自建数据并在事务或 TRUNCATE 后清理 |

## 3. 测试分层

| 层级 | 工具 | 覆盖内容 |
|---|---|---|
| 单元 | vitest | 分区名生成、保留期计算、时区边界换算 |
| 集成 | vitest + 真实 PG | 迁移重建、分区路由、SKIP LOCKED、事务原子性、幂等、密文、清理分区写审计 |
| 手工 | psql / 日志 | `pg_class` 分区形态、定时任务执行记录 |

## 4. 通过标准

- [ ] 所有 P0 用例通过
- [ ] 新增逻辑有对应自动化用例
- [ ] 安全类（密文、越权访问、幂等重放）逐项覆盖
- [ ] `npx tsc --noEmit` 通过

## 5. 文件索引

- [cases.md](cases.md)：用例清单
- [results.md](results.md)：执行记录与证据
- `evidence/`：可选的截图、日志片段（大文件不入库）
