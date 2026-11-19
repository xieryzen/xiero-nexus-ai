import { asc } from "drizzle-orm";
import { db } from "@/db";
import { agents as agentsTable, teams } from "@/db/schema";
import { memoryCounts } from "@/lib/agent/memory";
import { toolStatus } from "@/lib/agent/tools";
import { getCurrentUser } from "@/lib/auth";
import { agentCollectionMap, sharedCollections } from "@/lib/knowledge/service";
import { chatModels, setButNotOffered } from "@/lib/model-options";
import { agentSkillMap, listSkills } from "@/lib/skills/service";
import { serializeAgents, serializeTeam } from "@/lib/workforce";
import { PageHeader } from "@/components/ui";
import { AgentsManager, type ModelOption } from "@/components/agents/agents-manager";
import { TeamsManager } from "@/components/agents/teams-manager";
import { isAdminRole } from "@/lib/roles";
import { agentFor, teamFor } from "@/lib/for-viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default function AgentsPage() {
  const user = getCurrentUser();
  const isAdmin = isAdminRole(user?.role);

  const agentRows = db.select().from(agentsTable).orderBy(asc(agentsTable.name)).all();
  const teamRows = db.select().from(teams).orderBy(asc(teams.name)).all();

  // How an agent is set up (what it is told, its models, tools, skills and
  // collections) is for those who are shown the setup. A user is handed who
  // the agents are, and their own notes (for-viewer.ts).

  // Agents think in text: only chat models are offered here.
  const modelOptions: ModelOption[] = isAdmin
    ? chatModels().map((m) => ({
        id: m.id,
        label: `${m.name} · ${m.providerName}`,
        tools: m.tools,
      }))
    : [];

  const serializedAgents = serializeAgents(agentRows, {
    collections: agentCollectionMap(),
    skills: agentSkillMap(),
    // An administrator sees how many notes there are; everyone else, their own.
    memories: memoryCounts(isAdmin ? undefined : user?.id),
  }).map((agent) => agentFor(user?.role, agent));
  const status = isAdmin ? toolStatus() : { sandbox: true, search: "", browser: true };
  const skills = isAdmin
    ? listSkills({ withInstructions: false }).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
      }))
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents & Teams"
        description={isAdmin ? "Define the specialists the AI Manager can delegate to." : "The specialists the AI Manager delegates to, and the teams they work in."}
      />
      <AgentsManager
        initialAgents={serializedAgents}
        models={modelOptions}
        setModels={isAdmin ? setButNotOffered(agentRows.flatMap((a) => [a.primaryModelRowId, a.fallbackModelRowId]), modelOptions) : []}
        toolSetup={{ sandbox: status.sandbox, search: status.search, browser: status.browser }}
        collections={isAdmin ? sharedCollections() : []}
        skills={skills}
        isAdmin={isAdmin}
      />
      <TeamsManager
        initialTeams={teamRows.map((team) => teamFor(user?.role, serializeTeam(team)))}
        agents={serializedAgents.map((a) => ({ id: a.id, name: a.name, role: a.role }))}
        skills={skills}
        isAdmin={isAdmin}
      />
    </div>
  );
}
