import type { Connector } from '../../generated/prisma/client.js';
import { withTransaction } from '../../infra/db.js';

export interface ConnectorVersionReference {
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  stepId: string;
  actionKey: string;
  uses: string;
}

export class ConnectorVersionNotFoundError extends Error {
  constructor(
    readonly connectorId: string,
    readonly version: number,
  ) {
    super(`连接器版本不存在：${connectorId}@${version}`);
    this.name = 'ConnectorVersionNotFoundError';
  }
}

export class ConnectorVersionInUseError extends Error {
  constructor(
    readonly connectorId: string,
    readonly version: number,
    readonly references: readonly ConnectorVersionReference[],
  ) {
    super(`连接器版本仍被 ${references.length} 个冻结工作流步骤引用，无法删除：${connectorId}@${version}`);
    this.name = 'ConnectorVersionInUseError';
  }
}

interface ConnectorUseRow {
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  stepId: string;
  uses: string;
}

interface ParsedUses {
  connectorId: string;
  actionKey: string;
  version: number;
}

function parseUses(uses: string): ParsedUses | null {
  const atIndex = uses.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === uses.length - 1) return null;

  const reference = uses.slice(0, atIndex);
  const versionText = uses.slice(atIndex + 1);
  if (!/^(0|[1-9]\d*)$/.test(versionText)) return null;

  const dotIndex = reference.indexOf('.');
  if (dotIndex <= 0 || dotIndex === reference.length - 1) return null;

  const version = Number(versionText);
  if (!Number.isSafeInteger(version)) return null;

  return {
    connectorId: reference.slice(0, dotIndex),
    actionKey: reference.slice(dotIndex + 1),
    version,
  };
}

/**
 * 删除未被任何冻结工作流版本引用的连接器版本。
 *
 * 发布与回滚模块必须在同一事务内按固定顺序对引用的连接器行加 FOR SHARE 锁，
 * 再写入 workflow_versions；与这里的 FOR UPDATE 配合，避免检查期间新增引用。
 */
/** 事务超时：含 FOR UPDATE + jsonb_each 全表扫冻结 DSL，15s 足以扛首版规模 */
const DELETE_CONNECTOR_TIMEOUT_MS = 15_000;

export async function deleteConnectorVersion(connectorId: string, version: number): Promise<Connector> {
  return withTransaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM connectors
      WHERE id = ${connectorId} AND version = ${version}
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new ConnectorVersionNotFoundError(connectorId, version);
    }

    const usesRows = await tx.$queryRaw<ConnectorUseRow[]>`
      SELECT
        wv.workflow_id AS "workflowId",
        wv.id AS "workflowVersionId",
        wv.version AS "workflowVersion",
        step.key AS "stepId",
        step.value->>'uses' AS "uses"
      FROM workflow_versions AS wv
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(wv.dsl->'steps') = 'object' THEN wv.dsl->'steps'
          ELSE '{}'::jsonb
        END
      ) AS step
      WHERE jsonb_typeof(step.value->'uses') = 'string'
    `;

    const references: ConnectorVersionReference[] = [];
    for (const row of usesRows) {
      const parsed = parseUses(row.uses);
      if (parsed?.connectorId !== connectorId || parsed.version !== version) continue;
      references.push({
        workflowId: row.workflowId,
        workflowVersionId: row.workflowVersionId,
        workflowVersion: row.workflowVersion,
        stepId: row.stepId,
        actionKey: parsed.actionKey,
        uses: row.uses,
      });
    }

    if (references.length > 0) {
      throw new ConnectorVersionInUseError(connectorId, version, references);
    }

    return tx.connector.delete({ where: { id_version: { id: connectorId, version } } });
  }, { timeout: DELETE_CONNECTOR_TIMEOUT_MS });
}
