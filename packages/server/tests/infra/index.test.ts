import { afterAll, describe, expect, it } from 'vitest';
import * as api from '../../src/index.js';
import { disconnectDb } from '../../src/infra/db.js';

// 各模块只从 src/index.ts 取数据库能力；这里守住导出面，避免后续重构时悄悄删掉某个接入点。
describe('数据库层对外接口', () => {
  it('TC-016 导出的能力覆盖各模块的接入点', () => {
    const exportedFunctions = [
      'createPrismaClient',
      'disconnectDb',
      'withTransaction',
      'ensurePartitions',
      'prunePartitions',
      'startPartitionMaintenance',
      'ensureUpcomingPartitions',
      'dropExpiredPartitions',
      'listPartitions',
      'writeAuditLog',
      'appendRunEvent',
      'nextEventSeq',
      'stringifyJson',
      'jsonReplacer',
    ];

    for (const name of exportedFunctions) {
      expect(typeof (api as unknown as Record<string, unknown>)[name], name).toBe('function');
    }

    expect(api.prisma).toBeDefined();
    expect(api.RETENTION_DAYS).toEqual({ run_events: 90, audit_logs: 180 });

    // 枚举给状态机与连接器用，值必须与 Prisma 生成的常量一致
    expect(api.RunStatus.QUEUED).toBe('QUEUED');
    expect(api.NodeRunStatus.PENDING).toBe('PENDING');
    expect(api.NodeWaitStatus.PENDING).toBe('PENDING');
    expect(api.TriggerType.WEBHOOK).toBe('WEBHOOK');
  });

  afterAll(async () => {
    await disconnectDb();
  });
});
