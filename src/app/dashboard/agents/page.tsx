import { asc } from "drizzle-orm";
import { db } from "@/db";
import { agents as agentsTable, teams } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { chatModels } from "@/lib/model-options";
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

  // Agents think in text: image / video models are not offered here.
  const modelOptions: ModelOption[] = chatModels().map((m) => ({
    id: m.id,
    label: `${m.name} · ${m.providerName}`,
  }));

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
