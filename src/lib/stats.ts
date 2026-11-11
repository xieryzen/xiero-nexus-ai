import "server-only";
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRuns,
  agents,
  auditLogs,
  models,
  projects,
  providers,
  usageRecords,
  users,
} from "@/db/schema";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function sumTokens(where?: SQL): number {
  const row = db
    .select({ v: sql<number>`coalesce(sum(${usageRecords.totalTokens}), 0)` })
    .from(usageRecords)
    .where(where)
    .get();
  return row?.v ?? 0;
}

export interface UsageSummary {
  totals: { tokens: number; cost: number; requests: number };
  today: { tokens: number };
  month: { tokens: number; cost: number };
  recent: {
    id: string;
    kind: string;
    status: string;
    totalTokens: number;
    estimatedCost: number | null;
    latencyMs: number | null;
    providerName: string | null;
    modelId: string | null;
    createdAt: Date;
  }[];
}

export function getUsageSummary(scopeUserId: string | null): UsageSummary {
  const scope = scopeUserId ? eq(usageRecords.userId, scopeUserId) : undefined;

  const totals = db
    .select({
      tokens: sql<number>`coalesce(sum(${usageRecords.totalTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`,
      requests: sql<number>`count(*)`,
    })
    .from(usageRecords)
    .where(scope)
    .get();

  const monthCost = db
    .select({ cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)` })
    .from(usageRecords)
    .where(and(scope, gte(usageRecords.createdAt, startOfMonth())))
    .get();

  const recent = db
    .select({
      id: usageRecords.id,
      kind: usageRecords.kind,
      status: usageRecords.status,
      totalTokens: usageRecords.totalTokens,
      estimatedCost: usageRecords.estimatedCost,
      latencyMs: usageRecords.latencyMs,
      providerName: providers.name,
      modelId: models.modelId,
      createdAt: usageRecords.createdAt,
    })
    .from(usageRecords)
    .leftJoin(providers, eq(usageRecords.providerId, providers.id))
    .leftJoin(models, eq(usageRecords.modelRowId, models.id))
    .where(scope)
    .orderBy(desc(usageRecords.createdAt))
    .limit(50)
    .all();

  return {
    totals: {
      tokens: totals?.tokens ?? 0,
      cost: totals?.cost ?? 0,
      requests: totals?.requests ?? 0,
    },
    today: { tokens: sumTokens(and(scope, gte(usageRecords.createdAt, startOfToday()))) },
    month: {
      tokens: sumTokens(and(scope, gte(usageRecords.createdAt, startOfMonth()))),
      cost: monthCost?.cost ?? 0,
    },
    recent,
  };
}

export interface OverviewStats {
  providers: { total: number; enabled: number };
  models: { total: number; enabled: number };
  users: number;
  tokensToday: number;
  tokensMonth: number;
  requestsTotal: number;
  errors24h: number;
}

export function getOverviewStats(): OverviewStats {
  const countOf = (table: typeof providers | typeof models | typeof users, where?: SQL) =>
    db.select({ v: sql<number>`count(*)` }).from(table).where(where).get()?.v ?? 0;

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return {
    providers: {
      total: countOf(providers),
      enabled: countOf(providers, eq(providers.status, "enabled")),
    },
    models: {
      total: countOf(models),
      enabled: countOf(models, eq(models.enabled, true)),
    },
    users: countOf(users),
    tokensToday: sumTokens(gte(usageRecords.createdAt, startOfToday())),
    tokensMonth: sumTokens(gte(usageRecords.createdAt, startOfMonth())),
    requestsTotal:
      db.select({ v: sql<number>`count(*)` }).from(usageRecords).get()?.v ?? 0,
    errors24h:
      db
        .select({ v: sql<number>`count(*)` })
        .from(usageRecords)
        .where(and(eq(usageRecords.status, "error"), gte(usageRecords.createdAt, dayAgo)))
        .get()?.v ?? 0,
  };
}

export function getAgentStats() {
  return db
    .select({
      agentId: agentRuns.agentId,
      name: agents.name,
      role: agents.role,
      runs: sql<number>`count(*)`,
      ok: sql<number>`sum(case when ${agentRuns.status} = 'ok' then 1 else 0 end)`,
      errors: sql<number>`sum(case when ${agentRuns.status} = 'error' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`coalesce(round(avg(${agentRuns.latencyMs})), 0)`,
      tokens: sql<number>`coalesce(sum(coalesce(${agentRuns.promptTokens}, 0) + coalesce(${agentRuns.completionTokens}, 0)), 0)`,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agentRuns.agentId, agents.id))
    .groupBy(agentRuns.agentId)
    .all();
}

export function getRecentAgentRuns(limit = 25) {
  return db
    .select({
      id: agentRuns.id,
      agentName: agents.name,
      projectTitle: projects.title,
      status: agentRuns.status,
      attempt: agentRuns.attempt,
      latencyMs: agentRuns.latencyMs,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agentRuns.agentId, agents.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit)
    .all();
}

export function getRecentAudit(limit = 20) {
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      actorUsername: users.username,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .all();
}
