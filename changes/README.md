# changes · 变更计划目录

本目录存放**每一项非平凡改动的计划与过程文档**。计划从创建、执行到归档都留在这里，作为「为什么这么改、怎么改、怎么验证」的可追溯记录。

```
changes/
├── README.md            本文件
├── _template/           计划模板（不是计划，归档时不要带走）
│   ├── spec.md
│   ├── design.md
│   ├── plan.md
│   └── test/
│       ├── README.md
│       ├── cases.md
│       └── results.md
├── archive/             已完成的计划（只读）
│   └── README.md
└── YYYY-MM-DD-<slug>/   活跃计划
    ├── spec.md
    ├── design.md
    ├── plan.md
    └── test/
```

## 1. 什么时候建计划

满足任一条即需要计划：

- 改动跨多个模块，或涉及数据模型、接口契约、权限、安全策略；
- 需要分阶段交付，或预计超过半天；
- 需要和 PRD 的某个功能章节 / 验收项对应；
- 存在多个备选方案需要记录取舍。

纯文档修正、拼写、单行 bug 修复可以不建计划。

## 2. 创建计划

```bash
cp -r changes/_template changes/2026-11-15-example-change
```

目录名规则：`YYYY-MM-DD-<kebab-slug>`，日期取**创建日期**，slug 用英文小写短横线，能说明改动主题。

例如：`2026-11-20-dsl-compiler-m0`、`2026-12-01-jwks-auth-middleware`。

## 3. 必备文件

| 文件 | 回答的问题 | 必须包含 |
|---|---|---|
| `spec.md` | 为什么做、做到什么程度 | 背景、目标与非目标、范围与 PRD 引用、验收标准、开放问题 |
| `design.md` | 怎么实现 | 方案概述、数据模型、接口、模块改动、关键流程、安全与权限、取舍、迁移与回滚、风险 |
| `plan.md` | 谁在什么时候做什么 | 状态与元信息、任务分解（可勾选）、依赖、排期、进度日志 |
| `test/` | 怎么证明做对了 | 测试范围与环境、用例清单、执行记录与证据 |

**`test/` 是过程文档，不是交付前才写的总结。** 每完成一项任务就同步更新用例与结果；失败的运行也要记录，不要只留绿灯。

### test/ 目录约定

| 文件 | 内容 |
|---|---|
| `test/README.md` | 测试范围、环境与准备、自动化/手工划分、通过标准 |
| `test/cases.md` | 用例清单：ID、类型、前置条件、步骤、期望、对应验收项、自动化位置、状态 |
| `test/results.md` | 每次执行的日期、commit、环境、套件、结果、证据链接 |
| `test/evidence/` | 可选：截图、日志片段等证据（大文件不要入库） |

## 4. 计划状态

`plan.md` 顶部使用 frontmatter：

```yaml
---
status: active        # draft | active | blocked | done | abandoned
owner: 张三
created: 2026-11-15
updated: 2026-11-15
prd: docs/PRD-通用工作流引擎.md
---
```

状态含义：

| 状态 | 含义 |
|---|---|
| `draft` | 方案未定，尚未开始 |
| `active` | 进行中 |
| `blocked` | 等待外部依赖或决策 |
| `done` | 已交付并通过验收 |
| `abandoned` | 明确放弃（需在 `plan.md` 写原因） |

同一时间建议只保留 1～3 个 `active` 计划，避免多个半成品并行。

## 5. 归档

以下情况把整个计划目录移入 `archive/`：

- `done`：已交付并通过验收；
- `abandoned`：明确放弃，且原因已记录；
- 被新计划取代：旧计划标记 `abandoned`，在 `plan.md` 里链接新计划，然后归档。

```bash
git mv changes/2026-11-15-example-change changes/archive/
```

归档规则：

1. **归档目录只读**，修正历史请以新计划的形式追加，不要改旧文档。
2. 归档前确认 `plan.md` 的状态、验收结论和 `test/results.md` 已写完。
3. 归档时保留原目录名和全部文件，不裁剪、不合并。
4. 如果同一主题再次启动，新建计划，并在 `spec.md` 中链接被归档的旧计划。

## 6. 与 PRD 的关系

- `spec.md` 必须引用 PRD 章节与验收项；范围以 PRD §2.3 非目标为边界。
- 计划执行中发现 PRD 需要修改时：**先改 PRD（需用户确认），再改计划**，不要把偏离悄悄写进代码。
- PRD 的审批章节存在新旧方案并存，以 §4.1.1 为准，详见 [Agent.md](../Agent.md) 第 2.1 节。

## 7. 快速清单

- [ ] 目录名符合 `YYYY-MM-DD-<slug>`
- [ ] `spec.md` 引用了 PRD 条款并列出验收项
- [ ] `design.md` 写了取舍与回滚
- [ ] `plan.md` 的 frontmatter 状态正确
- [ ] `test/` 有用例与执行记录，且随进度更新
- [ ] 完成后 `git mv` 到 `archive/`
