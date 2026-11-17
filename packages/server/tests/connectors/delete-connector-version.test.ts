import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConnectorVersionInUseError,
  ConnectorVersionNotFoundError,
  deleteConnectorVersion,
  disconnectDb,
  prisma,
  type Prisma,
} from '../../src/index.js';

const prefix = `guard_${randomUUID().replaceAll('-', '')}`;
let sequence = 0;

function nextId(label: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${label}`;
}

async function createConnector(id: string, version = 1) {
  return prisma.connector.create({
    data: { id, version, kind: 'http', manifest: { actions: {} } },
  });
}

interface TestVersion {
  version: number;
  dsl: Prisma.InputJsonValue;
}

async function createWorkflow(
  id: string,
  versions: TestVersion[],
  options: { draft?: Prisma.InputJsonValue; publishedVersion?: number } = {},
) {
  return prisma.workflow.create({
    data: {
      id,
      name: '连接器删除保护测试',
      slug: id,
      ownerId: '2509030323',
      draft: options.draft ?? {},
      publishedVersion: options.publishedVersion,
      versions: {
        create: versions.map((version) => ({
          id: `${id}_v${version.version}`,
          version: version.version,
          dsl: version.dsl,
          yaml: '',
          layout: {},
          hash: `hash_${version.version}`,
        })),
      },
    },
  });
}

describe('连接器版本删除保护（真实测试库）', () => {
  it('删除未被引用的版本，并保留同 ID 的其他版本', async () => {
    const connectorId = nextId('free');
    await createConnector(connectorId, 1);
    await createConnector(connectorId, 2);

    await expect(deleteConnectorVersion(connectorId, 1)).resolves.toMatchObject({
      id: connectorId,
      version: 1,
    });

    expect(await prisma.connector.findUnique({ where: { id_version: { id: connectorId, version: 1 } } })).toBeNull();
    expect(await prisma.connector.findUnique({ where: { id_version: { id: connectorId, version: 2 } } })).not.toBeNull();
  });

  it('删除不存在的版本时返回领域错误', async () => {
    const connectorId = nextId('missing');
    const deletion = deleteConnectorVersion(connectorId, 1);

    await expect(deletion).rejects.toBeInstanceOf(ConnectorVersionNotFoundError);
    await expect(deletion).rejects.toMatchObject({ connectorId, version: 1 });
  });

  it('当前冻结版本引用任一 action 时拒绝删除并返回定位信息', async () => {
    const connectorId = nextId('current');
    const workflowId = nextId('workflow');
    const uses = `${connectorId}.activity.create@1`;
    await createConnector(connectorId);
    await createWorkflow(
      workflowId,
      [{ version: 1, dsl: { steps: { create_activity: { uses } } } }],
      { publishedVersion: 1 },
    );

    const deletion = deleteConnectorVersion(connectorId, 1);
    await expect(deletion).rejects.toBeInstanceOf(ConnectorVersionInUseError);
    await expect(deletion).rejects.toMatchObject({
      connectorId,
      version: 1,
      references: [
        {
          workflowId,
          workflowVersionId: `${workflowId}_v1`,
          workflowVersion: 1,
          stepId: 'create_activity',
          actionKey: 'activity.create',
          uses,
        },
      ],
    });
    expect(await prisma.connector.findUnique({ where: { id_version: { id: connectorId, version: 1 } } })).not.toBeNull();
  });

  it('历史冻结版本仍可指定运行或回滚，因此同样阻止删除', async () => {
    const connectorId = nextId('history');
    const workflowId = nextId('workflow');
    await createConnector(connectorId);
    await createWorkflow(
      workflowId,
      [
        { version: 1, dsl: { steps: { fetch: { uses: `${connectorId}.plan.detail@1` } } } },
        { version: 2, dsl: { steps: {} } },
      ],
      { publishedVersion: 2 },
    );

    const deletion = deleteConnectorVersion(connectorId, 1);
    await expect(deletion).rejects.toBeInstanceOf(ConnectorVersionInUseError);
    await expect(deletion).rejects.toMatchObject({
      references: [{ workflowVersionId: `${workflowId}_v1`, workflowVersion: 1 }],
    });
  });

  it('草稿、其他版本及非步骤 uses 不误报，非法引用格式也不误报', async () => {
    const connectorId = nextId('ignored');
    const workflowId = nextId('workflow');
    const target = `${connectorId}.activity.create@1`;
    await createConnector(connectorId);
    await createWorkflow(
      workflowId,
      [
        {
          version: 1,
          dsl: {
            steps: {
              other_connector: { uses: 'other.activity.create@1' },
              other_version: { uses: `${connectorId}.activity.create@2` },
              leading_zero: { uses: `${connectorId}.activity.create@01` },
              decimal_version: { uses: `${connectorId}.activity.create@1.0` },
              invalid_version: { uses: `${connectorId}.activity.create@1x` },
              missing_action: { uses: `${connectorId}@1` },
              empty_action: { uses: `${connectorId}.@1` },
              missing_version: { uses: `${connectorId}.activity.create` },
              empty_version: { uses: `${connectorId}.activity.create@` },
              non_string: { uses: 1 },
              nested: { with: { uses: target } },
              renamed: { notUses: target },
            },
          },
        },
      ],
      { draft: { steps: { draft_step: { uses: target } } }, publishedVersion: 1 },
    );

    await expect(deleteConnectorVersion(connectorId, 1)).resolves.toMatchObject({ id: connectorId, version: 1 });
  });

  it('两个并发删除最终一个成功、一个得到不存在错误', async () => {
    const connectorId = nextId('concurrent');
    await createConnector(connectorId);

    const results = await Promise.allSettled([
      deleteConnectorVersion(connectorId, 1),
      deleteConnectorVersion(connectorId, 1),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConnectorVersionNotFoundError);
    expect(await prisma.connector.findUnique({ where: { id_version: { id: connectorId, version: 1 } } })).toBeNull();
  });

  afterAll(async () => {
    await prisma.workflow.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.connector.deleteMany({ where: { id: { startsWith: prefix } } });
    await disconnectDb();
  });
});
