import { afterAll, describe, expect, it } from 'vitest';
import { disconnectDb, prisma } from '../../src/infra/db.js';

const BUSINESS_TABLES = [
  'workflows',
  'workflow_versions',
  'connectors',
  'runs',
  'node_runs',
  'run_events',
  'secrets',
  'triggers',
  'audit_logs',
  'idempotency_keys',
  'node_waits',
];

describe('库结构（真实测试库）', () => {
  it('TC-004 业务表齐全，两张表是分区父表', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; relkind: string }[]>`
      SELECT c.relname, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    `;
    const kinds = new Map(rows.map((row) => [row.relname, row.relkind]));

    for (const table of BUSINESS_TABLES) {
      expect(kinds.has(table), `缺少表 ${table}`).toBe(true);
    }
    expect(kinds.get('run_events')).toBe('p');
    expect(kinds.get('audit_logs')).toBe('p');
    expect(kinds.get('runs')).toBe('r');
  });

  it('TC-013 node_waits 的状态是枚举，run_id 外键级联删除', async () => {
    const [column] = await prisma.$queryRaw<{ udt_name: string }[]>`
      SELECT udt_name::text AS udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'node_waits' AND column_name = 'status'
    `;
    expect(column?.udt_name).toBe('node_wait_status');

    const [fk] = await prisma.$queryRaw<{ confdeltype: string }[]>`
      SELECT confdeltype::text AS confdeltype
      FROM pg_constraint
      WHERE conname = 'node_waits_run_id_fkey'
    `;
    expect(fk?.confdeltype).toBe('c'); // c = CASCADE
  });

  it('TC-013 查询索引与事件序号索引齐全', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const names = rows.map((row) => row.indexname);

    expect(names).toEqual(
      expect.arrayContaining([
        'runs_version_id_idx',
        'runs_status_created_at_idx',
        'run_events_run_id_seq_idx',
        'node_waits_run_id_idx',
        'triggers_workflow_id_idx',
      ]),
    );
    // 失效的 run 内 seq 唯一索引必须已被删除
    expect(names).not.toContain('run_events_run_id_seq_ts_key');
  });

  afterAll(async () => {
    await disconnectDb();
  });
});
