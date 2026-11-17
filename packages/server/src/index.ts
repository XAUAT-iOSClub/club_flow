// 引擎入口。Fastify 启动逻辑随接口层计划接入，当前导出已落地的数据库层与连接器服务。
// 其他模块（auth / compiler / runtime / waits / connectors / workflows）从这里取公共接口，
// 不要直接 import src/generated/prisma 下的文件。
export { createPrismaClient, disconnectDb, prisma, withTransaction } from './infra/db.js';
export type { Db } from './infra/db.js';
export * from './infra/cron.js';
export * from './infra/json.js';
export * from './infra/partitions.js';
export * from './modules/audit/audit-log.js';
export * from './modules/connectors/delete-connector-version.js';
export * from './modules/runtime/run-events.js';

// 模型类型与枚举：保证上层模块的入参/出参类型与 schema 一致
export type {
  AuditLog,
  Connector,
  IdempotencyKey,
  NodeRun,
  NodeWait,
  Prisma,
  Run,
  RunEvent,
  Secret,
  Trigger,
  Workflow,
  WorkflowVersion,
} from './generated/prisma/client.js';
export {
  IdempotencyStatus,
  NodeRunStatus,
  NodeWaitStatus,
  RunEventLevel,
  RunMode,
  RunStatus,
  TriggerType,
} from './generated/prisma/client.js';
