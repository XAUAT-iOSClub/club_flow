// 生成 HANDOVER.docx
// 运行：node scripts/gen-handover.js
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  VerticalAlign,
} = require('docx');
const fs = require('fs');
const path = require('path');

const FONT_CJK = 'Microsoft YaHei';
const FONT_EN = 'Arial';

const font = { ascii: FONT_EN, hAnsi: FONT_EN, eastAsia: FONT_CJK };

const BASE_RUN = { font, size: 22 }; // 11pt
const BOLD_RUN = { font, size: 22, bold: true };

const border = { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" };
const borders = { top: border, bottom: border, left: border, right: border };
const headerShading = { fill: "E8F0FE", type: ShadingType.CLEAR };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, font, size: 32, bold: true })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, font, size: 28, bold: true })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, font, size: 24, bold: true })],
  });
}

function p(text, opts = {}) {
  const runs = Array.isArray(text)
    ? text
    : [new TextRun({ text, ...BASE_RUN, ...opts })];
  return new Paragraph({ spacing: { before: 60, after: 60 }, children: runs });
}

function run(text, opts = {}) {
  return new TextRun({ text, font, size: 22, ...opts });
}

function code(text) {
  return run(text, { font: { ascii: "Consolas", hAnsi: "Consolas", eastAsia: FONT_CJK } });
}

function divider() {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    children: [run('+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++', { color: "888888" })],
  });
}

function headerCell(text, width) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: headerShading,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [run(text, { bold: true })] })],
  });
}

function cell(text, width, opts = {}) {
  const runObj = typeof text === 'string'
    ? [run(text, opts)]
    : text;
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: runObj })],
  });
}

function table(colWidths, rows) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: rows.map((row, i) => new TableRow({
      cantSplit: true,
      children: row.map((c, j) => typeof c === 'string' ? cell(c, colWidths[j]) : c),
    })),
  });
}

function bullet(items) {
  return items.map(text => new Paragraph({
    spacing: { before: 40, after: 40 },
    children: [run('• '), run(text)],
  }));
}

// ============ 文档内容 ============

const children = [];

// 标题
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 120 },
  children: [new TextRun({ text: "底层数据库层 · 交接", font, size: 40, bold: true })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 0, after: 200 },
  children: [
    run("交付人：陈智祥  "),
    run("实际完成：2026-11-17", { color: "555555" }),
  ],
}));

children.push(divider());

// ===== 零、干活前对仓库骨架的修改 =====
children.push(h1("干活前对仓库骨架的修改"));
children.push(p("李嘉俊 clone 下来的仓库（commit 392bec1）是个空壳——只有 package.json 骨架 + workspace 配置 + PRD 文档 + 一堆 AI 技能模板，没有任何源码、没有 schema、没有迁移、没有测试配置。先把脚手架拉起来才能干活。"));

children.push(h3("降级 Prisma 版本"));
children.push(p("根 package.json 里 Prisma 挂的是 ^8.0.0-rc.33（beta），Prisma 8 还在开发中，API 随时可能变。改成 ^7.10.1 稳定版。"));

children.push(h3("新建文件（之前完全不存在）"));
children.push(table(
  [2400, 6626],
  [
    ["文件", "为什么要建"],
    [".env.example", "Prisma 7 的 prisma.config.ts + vitest 都要读 DATABASE_URL / TEST_DATABASE_URL，之前没这个文件"],
    ["server/prisma.config.ts", "Prisma 7 必须有——连接串、schema 路径、迁移路径都从这里读，之前完全没有"],
    ["server/vitest.config.ts", "vitest 跑测试需要配置，之前没有"],
    ["server/tests/setup.ts", "测试统一入口，加载 TEST_DATABASE_URL，之前没有"],
    ["schema/src/index.ts", "空壳占位（schema 模块后续由编译器开工），之前没有 src 目录"],
    ["server/src/generated/", "Prisma Client 生成目录，加进 gitignore"],
  ]
));

children.push(h3("修改文件"));
children.push(table(
  [2600, 6426],
  [
    ["文件", "改了什么"],
    ["根 package.json", "scripts：去掉 echo no test，加 build/test/typecheck（workspace 聚合）；加 engines.node >=22；prisma ^8.0.0-rc.33 → ^7.10.1"],
    ["server package.json", "加 build/test/typecheck/postinstall/prisma:* 脚本；main 从 index.js → dist/index.js；加 @prisma/adapter-pg 依赖（Prisma 7 不再内置 PG 驱动）"],
    ["schema package.json", "加 exports 字段（ESM 包需要）+ build/test/typecheck 脚本"],
    ["tsconfig.json", "include 从 src 扩展到 tests/ + prisma.config.ts + vitest.config.ts"],
    [".gitignore", "补 generated/、tsbuildinfo、日志、编辑器目录"],
    ["AGENTS.md", "李嘉俊写了初始 165 行，我补了 §3 仓库现状、§5 架构约束第 11/12 条、§8 Prisma 7 命令位置差异、§11 交付前检查清单"],
  ]
));

children.push(divider());

// ===== 我都干了些什么 =====
children.push(h1("我都干了些什么"));

// 一、11 张业务表
children.push(h2("一、11 张业务表 + 7 枚举（schema.prisma）"));
children.push(table(
  [600, 2200, 6226],
  [
    ["#", "表", "关键设计"],
    ["1", "workflows", "slug @unique；ownerId 学号快照"],
    ["2", "workflow_versions", "unique([workflowId, version])；级联删 workflow 时一起删"],
    ["3", "connectors", "复合主键 (id, version)——连接器版本是第一等公民"],
    ["4", "runs", "eventSeq(@default 0) 事件序号分配器；RESTRICT 删除策略——有 run 时 workflow / workflow_versions 删不掉，从数据库层硬保数据完整性"],
    ["5", "node_runs", "unique([runId, nodeId, attempt])；skipReason jsonb（条件分支未命中时记录原因）"],
    ["6", "run_events（分区表）", "PARTITION BY RANGE(ts) 按月分区，保留 90 天；分区主键 (id, ts)；ts @default(now())"],
    ["7", "secrets", "cipher / nonce / keyVersion 三字段"],
    ["8", "triggers", "(enabled, nextRunAt) 复合索引——cron 扫待触发项走这个"],
    ["9", "audit_logs（分区表）", "PARTITION BY RANGE(ts) 按月分区，保留 180 天"],
    ["10", "idempotency_keys", "复合主键 (scope, key)；exp 索引"],
    ["11", "node_waits", "correlationId @unique（回调先到也能落位）；unique([connectorId, eventId])（回调去重）"],
  ]
));
children.push(p("外键删除策略：workflows → runs / workflow_versions / triggers 全 CASCADE；runs → node_runs / run_events / node_waits 全 CASCADE；runs → workflows / workflow_versions 是 RESTRICT——有 run 在跑时删不了 workflow。"));

// 二、9 个迁移
children.push(h2("二、9 个 SQL 迁移（手写 DDL，Prisma 不写的我都写了）"));
children.push(table(
  [3200, 5826],
  [
    ["迁移", "我做了什么"],
    ["20261115120000_init", "建 7 枚举 + 11 表骨架 + 分区父表（Prisma 不支持 PARTITION BY，手写）+ 序列 + 索引 + 外键"],
    ["20261115120100_partitions", "run_events / audit_logs 的首个月度子分区"],
    ["20261115121000_runs_indexes", "runs 上补两个索引（心跳扫描、状态查询）"],
    ["20261115122000_run_event_seq", "runs.event_seq 字段——原子分配事件序号，解决分区表唯一索引的天生缺陷"],
    ["20261115123000_node_wait_status_fk", "node_waits.status 从 TEXT 升级成枚举 + 补外键"],
    ["20261115130000_ensure_partition_schema", "数据库函数 ensure_month_partition(regclass, timestamptz, timestamptz)——幂等建分区，分区边界按 +08 写死显式 SQL 字面量"],
    ["20261115131000_updated_at_defaults", "三张表补 updated_at @default(now())"],
    ["20261117090000_node_run_skip_reason", "P1 修复：node_runs 加 skip_reason jsonb"],
    ["20261117100000_run_event_ts_default", "P1 修复：run_events.ts SET DEFAULT now()——裸 SQL 插入时也能自动填时间"],
  ]
));

// 三、8 个源码模块
children.push(h2("三、8 个源码模块"));
children.push(table(
  [2400, 6626],
  [
    ["文件", "我写了什么"],
    ["infra/db.ts", "PrismaPg driver adapter，-c timezone=UTC 强制会话时区（Prisma 7 把 Date 序列化成 UTC 墙上时间，会话时区非 UTC 会让 timestamptz 整体偏移）；withTransaction 暴露 timeout / isolationLevel"],
    ["infra/partitions.ts", "预建分区、枚举现有分区、过期判断、DROP 过期分区；assertMonthStart 防御性断言（不是 +08 视角下当月 1 号 00:00 就直接抛）；monthLiteral 显式拼 2026-12-01 00:00:00+08 格式，不依赖驱动"],
    ["infra/cron.ts", "4 个 node-cron 全部注册在 Asia/Shanghai：每日 03:00 预建未来 2 个月分区；每日 03:10 DROP 过期分区（90/180 天）+ 写 system 审计；每分钟 scanInterruptedRuns——心跳 2 分钟超时的 RUNNING run 标记 FAILED + 写事件 + 写审计；每分钟 expireStaleWaits——deadline 过期的 PENDING node_wait 标记 EXPIRED + 写事件 + 写审计。全部用 FOR UPDATE SKIP LOCKED LIMIT 50 抢行，多进程不重复。返回 stop 函数。"],
    ["infra/json.ts", "BigInt → 十进制字符串的序列化工具。run_events.id 和 audit_logs.id 是 BIGINT，直接 JSON.stringify 会炸，进 HTTP 响应/SSE 帧前必须过这里。"],
    ["modules/runtime/run-events.ts", "nextEventSeq 用 UPDATE runs SET event_seq = event_seq + 1 原子分配——行锁让同一 run 的并发调用串行，不同 run 互不阻塞，事务回滚时自增也回滚。appendRunEvent 内部自动补 ts 和 seq，调用方只管传业务字段。"],
    ["modules/audit/audit-log.ts", "writeAuditLog(db, entry) 一行封装。id 和 ts 都由数据库默认值生成。"],
    ["modules/connectors/delete-connector-version.ts", "deleteConnectorVersion(id, version) 事务内先 FOR UPDATE 锁目标 connector 行，再 jsonb_each 全表扫所有冻结 workflow_versions 的 DSL steps，解析 uses: connectorId.actionKey@version 格式，有引用就抛 ConnectorVersionInUseError 并返回完整 references 数组（workflowId / version / stepId / actionKey）。超时 15s，扛 jsonb_each 全表扫描。"],
    ["index.ts", "统一导出入口。上层模块从这里 import，不直连 generated/prisma。"],
  ]
));

// 四、测试
children.push(h2("四、34 个集成测试（全部真实 PostgreSQL，无 mock）"));
children.push(code("Test Files  8 passed (8)\n     Tests  34 passed (34)\n  Duration  13.66s"));
children.push(p("覆盖：崩溃扫描正/反/并发、等待超时正/反/已 RESOLVED、连接器删除保护 6 用例、SKIP LOCKED 并发认领不重复、事务 timeout、分区边界断言、导出面守卫。"));

children.push(divider());

// ===== 为后续各模块做了哪些铺垫 =====
children.push(h1("为后续各模块做了哪些铺垫"));

children.push(h2("给刘华鑫（runtime / 工作流解析 / 状态机）"));
children.push(p("可以直接用的函数："));
children.push(...bullet([
  "appendRunEvent(tx, {...}) —— 事务内追加运行事件，seq 自动分配、ts 自动补，唯一约束由 runs.event_seq 的 UPDATE 行锁保证",
  "writeAuditLog(tx, {...}) —— 事务内写审计",
  "withTransaction(async (tx) => {...}) —— 同一次状态迁移的 run / node_run / run_events 放一个事务（AGENTS.md §5 硬约束）",
  "ensureMonthPartition(prisma, 'run_events', monthStartOf(new Date())) —— 写 run_events 前确保当月分区存在",
]));
children.push(p("已经替他实现的定时扫描："));
children.push(...bullet([
  "崩溃扫描（心跳超时 → FAILED + 事件 + 审计）已经只改 run 层状态，node_runs 层哪些节点仍在 running 留给他的「从失败节点继续」恢复逻辑处理",
  "等待超时扫描（deadline 过期 → EXPIRED + 事件 + 审计）已经只改 node_waits，关联节点状态留给他",
]));
children.push(p("schema 已经预好的扩展位："));
children.push(...bullet([
  "node_runs.attempt（重试计数，retry 间隔等持久化字段他开工时评估要不要加）",
  "node_runs.skipReason（条件分支未命中的记录，「从失败节点继续」恢复时能知道哪些节点是真 skipped）",
]));
children.push(p("一个建议：SKIP LOCKED 抢任务的通用封装（cron 已裸 SQL 用了 FOR UPDATE SKIP LOCKED），runtime 执行器需要时可以提一下我补。"));

children.push(h2("给刘华新 / 刘嘉玲（连接器模板）"));
children.push(p("可以直接用的函数："));
children.push(...bullet([
  "deleteConnectorVersion(id, version) —— 删除逻辑直接调，事务内 FOR UPDATE + jsonb_each 全表扫描冻结 DSL 引用",
  "发布/回滚写 workflow_versions 时，需要在同一事务内对引用的 connectors 行加 FOR SHARE 锁——AGENTS.md §5 有说明，和 deleteConnectorVersion 的 FOR UPDATE 配合避免检查期间新增引用",
]));
children.push(p("连接器版本数据模型："));
children.push(...bullet([
  "connectors 表是 (id, version) 复合主键，删除保护就是按这个复合键做的",
  "manifest 字段是 JSONB，存 actions / triggers / auth 配置",
]));
children.push(p("schema 已预好："));
children.push(...bullet([
  "secrets 表 cipher / nonce / keyVersion 三字段——加解密函数（AES-256-GCM，轮换期双版本解密）留给他们模块",
  "idempotency_keys 表 + exp 索引——HTTP 出站幂等可以直接用，过期清理 cron 待补",
]));

children.push(h2("给李嘉俊（项目统筹）"));
children.push(...bullet([
  "地基已交付：11 表 + 9 迁移 + 8 模块文件 + 34 测试全绿",
  "typecheck 通过：tsc --noEmit 零错误，strict 模式",
  "Git 远程同步：HEAD = origin/main = refs/heads/main，零差异",
]));
children.push(code("ed6b26a fix(server): address P1 gaps in runtime watchdog and schema defaults\n79303e9 feat(server): add connector version delete protection\n5d3370e feat(server): 落地数据库基础层与分区维护"));

children.push(divider());

// ===== 相关文件 =====
children.push(h1("相关文件"));
children.push(table(
  [3000, 6026],
  [
    ["文件", "路径"],
    ["Schema", "packages/server/prisma/schema.prisma"],
    ["迁移目录", "packages/server/prisma/migrations/（9 个）"],
    ["源码目录", "packages/server/src/（8 个 .ts 文件）"],
    ["测试结果", "changes/2026-11-16-db-foundation/test/results.md"],
    ["原始 PRD", "docs/PRD-通用工作流引擎.md"],
    ["本次 change plan", "changes/2026-11-16-db-foundation/"],
    ["连接器删除保护 change plan", "changes/2026-11-15-connector-delete-guard/"],
    ["项目规范", "AGENTS.md"],
  ]
));

// ============ 组装文档 ============

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: { ascii: FONT_EN, hAnsi: FONT_EN, eastAsia: FONT_CJK }, size: 22 },
      },
    },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0, keepNext: false, keepLines: false } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1, keepNext: false, keepLines: false } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2, keepNext: false, keepLines: false } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1440, right: 1200, bottom: 1440, left: 1200 },
      },
    },
    children,
  }],
});

const outPath = path.join(__dirname, '..', 'changes', '2026-11-16-db-foundation', 'HANDOVER.docx');
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  console.log('✅ 已生成：', outPath);
});
