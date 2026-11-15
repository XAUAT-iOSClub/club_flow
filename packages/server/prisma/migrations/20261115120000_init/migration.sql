-- 首版基线迁移
-- 由 `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` 生成后手工改写：
--   run_events / audit_logs 改为按 ts 月分区的分区父表（Prisma 不支持 PARTITION BY）。
--   分区表不能用 BIGSERIAL / identity，改用显式 SEQUENCE + 默认值。
-- 注意：这两张表的物理结构与 schema.prisma 的普通模型声明不完全一致，禁止使用 prisma db push。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'timed_out');

-- CreateEnum
CREATE TYPE "node_run_status" AS ENUM ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'canceled');

-- CreateEnum
CREATE TYPE "run_mode" AS ENUM ('real', 'test');

-- CreateEnum
CREATE TYPE "trigger_type" AS ENUM ('manual', 'cron', 'webhook');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('in_flight', 'completed');

-- CreateEnum
CREATE TYPE "run_event_level" AS ENUM ('info', 'warn', 'error');

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draft_revision" INTEGER NOT NULL DEFAULT 1,
    "published_version" INTEGER,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "dsl" JSONB NOT NULL,
    "yaml" TEXT NOT NULL,
    "layout" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id","version")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "mode" "run_mode" NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "trigger" JSONB NOT NULL,
    "triggered_by" TEXT,
    "triggered_by_name" TEXT,
    "inputs" JSONB NOT NULL,
    "vars" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "waited_ms" INTEGER,
    "error" JSONB,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_runs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "node_run_status" NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "output" JSONB,
    "output_ref" TEXT,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "waited_ms" INTEGER,

    CONSTRAINT "node_runs_pkey" PRIMARY KEY ("id")
);

-- CreateSequence：分区父表的主键必须包含分区列，自增由显式序列提供
CREATE SEQUENCE "run_events_id_seq";

-- CreateTable：分区父表（子分区见下一个迁移）
CREATE TABLE "run_events" (
    "id" BIGINT NOT NULL DEFAULT nextval('run_events_id_seq'),
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "level" "run_event_level" NOT NULL,
    "node_id" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id","ts")
) PARTITION BY RANGE ("ts");

-- CreateTable
CREATE TABLE "secrets" (
    "name" TEXT NOT NULL,
    "cipher" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "type" "trigger_type" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateSequence
CREATE SEQUENCE "audit_logs_id_seq";

-- CreateTable：分区父表（子分区见下一个迁移）
CREATE TABLE "audit_logs" (
    "id" BIGINT NOT NULL DEFAULT nextval('audit_logs_id_seq'),
    "actor_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id","ts")
) PARTITION BY RANGE ("ts");

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'in_flight',
    "response" JSONB,
    "exp" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "node_waits" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "connector_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "external_task_id" TEXT,
    "event_id" TEXT,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "deadline" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "node_waits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflows_slug_key" ON "workflows"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_key" ON "workflow_versions"("workflow_id", "version");

-- CreateIndex
CREATE INDEX "runs_workflow_id_created_at_idx" ON "runs"("workflow_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "runs_status_heartbeat_at_idx" ON "runs"("status", "heartbeat_at");

-- CreateIndex
CREATE UNIQUE INDEX "node_runs_run_id_node_id_attempt_key" ON "node_runs"("run_id", "node_id", "attempt");

-- CreateIndex（分区父表上的索引会自动传播到每个子分区）
CREATE INDEX "run_events_run_id_ts_idx" ON "run_events"("run_id", "ts" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_seq_ts_key" ON "run_events"("run_id", "seq", "ts");

-- CreateIndex
CREATE INDEX "triggers_enabled_next_run_at_idx" ON "triggers"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_ts_idx" ON "audit_logs"("target_type", "target_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "idempotency_keys_exp_idx" ON "idempotency_keys"("exp");

-- CreateIndex
CREATE UNIQUE INDEX "node_waits_correlation_id_key" ON "node_waits"("correlation_id");

-- CreateIndex
CREATE INDEX "node_waits_status_deadline_idx" ON "node_waits"("status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "node_waits_connector_id_event_id_key" ON "node_waits"("connector_id", "event_id");

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_runs" ADD CONSTRAINT "node_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
