import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents as agentsTable, models, providers, teams } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { adapterIsImplemented } from "@/lib/adapters";
import { serializeAgents, serializeTeam } from "@/lib/workforce";
import { PageHeader } from "@/components/ui";
import { AgentsManager, type ModelOption } from "@/components/agents/agents-manager";
import { TeamsManager } from "@/components/agents/teams-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default function AgentsPage() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";

  const agentRows = db.select().from(agentsTable).orderBy(asc(agentsTable.name)).all();
  const teamRows = db.select().from(teams).orderBy(asc(teams.name)).all();

  const modelRows = db
    .select({ id: models.id, modelId: models.modelId, displayName: models.displayName, providerName: providers.name, adapter: providers.adapter })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .orderBy(asc(models.modelId))
    .all();

  const modelOptions: ModelOption[] = modelRows
    .filter((m) => adapterIsImplemented(m.adapter))
    .map((m) => ({ id: m.id, label: `${m.displayName || m.modelId} · ${m.providerName}` }));

  const serializedAgents = serializeAgents(agentRows);

  return (
    <div className="space-y-6">
      <PageHeader title="Agents & Teams" description="Define the specialists the AI Manager can delegate to." />
      <AgentsManager initialAgents={serializedAgents} models={modelOptions} isAdmin={isAdmin} />
      <TeamsManager
        initialTeams={teamRows.map(serializeTeam)}
        agents={serializedAgents.map((a) => ({ id: a.id, name: a.name, role: a.role }))}
        isAdmin={isAdmin}
      />
    </div>
  );
}
