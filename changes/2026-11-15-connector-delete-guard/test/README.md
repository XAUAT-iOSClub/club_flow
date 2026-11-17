# 连接器版本删除引用保护 · 测试说明

## 1. 测试范围

覆盖删除服务、引用解析、事务行锁、领域错误和包根导出。不测试 REST 鉴权、发布/回滚接线或软删除，因为均不在本次范围内。

## 2. 环境与准备

| 项目 | 内容 |
|---|---|
| Node | 22.23.5 |
| 数据库 | PostgreSQL 17，独立测试库 `clubflowtest` |
| 环境变量 | 根目录 `.env` 中的 `TEST_DATABASE_URL` |
| 定向命令 | `npm test -w @clubflow/server -- tests/connectors/delete-connector-version.test.ts` |
| 全量命令 | `npm test -w @clubflow/server`、`npm run typecheck`、`npm run build` |
| 前置数据 | 测试自动造数，统一随机前缀，结束后清理 |

## 3. 测试分层

| 层级 | 工具 | 覆盖内容 |
|---|---|---|
| 集成 | Vitest + 真实 PG | 引用检查、物理删除、错误、事务行锁与并发 |
| 契约 | 从包根导入 | 公共服务与错误可正常访问 |
| 手工 / E2E | 无 | 本轮无 HTTP 或前端入口 |

## 4. 通过标准

- [x] 所有新增用例通过。
- [x] 新增逻辑有对应自动化用例。
- [x] 测试数据无残留。
- [x] 全量测试、类型检查与构建通过。

## 5. 文件索引

- [cases.md](cases.md)：用例清单
- [results.md](results.md)：执行记录与证据
