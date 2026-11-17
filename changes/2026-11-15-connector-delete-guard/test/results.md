# 连接器版本删除引用保护 · 测试执行记录

## 执行汇总

| 日期 | Commit | 环境 | 套件 / 命令 | 通过 / 总数 | 失败用例 | 备注 |
|---|---|---|---|---|---|---|
| 2026-11-15 | 未提交 | Node 22.23.5 + PostgreSQL 17 | `npm test -w @clubflow/server -- tests/connectors/delete-connector-version.test.ts` | 6 / 6 | 无 | 1 个文件，定向集成测试通过 |
| 2026-11-15 | 未提交 | Node 22.23.5 + PostgreSQL 17 | `npm test -w @clubflow/server` | 26 / 26 | 无 | 7 个文件，全量测试通过 |

## 详细记录

### 2026-11-15 · TRAE

- 命令：`npm test -w @clubflow/server -- tests/connectors/delete-connector-version.test.ts`
- 结果：`1 passed`，`6 passed`，耗时 1.94s。
- 失败用例与原因：无。
- 数据清理：`afterAll` 先删除测试工作流并级联清理冻结版本，再删除测试连接器。

### 2026-11-15 · 全量验证

- `npm test -w @clubflow/server`：7 个文件、26 个用例全部通过，耗时 8.29s。
- `npm run typecheck`：通过，无 TypeScript 错误。
- `npm run build`：server 与 schema 均构建成功，Prisma Client 7.10.1 生成成功。

## 遗留问题

发布/回滚模块尚未实现，`FOR SHARE` 的真实联动验证随该模块计划执行；本轮已验证删除侧并发协议。
