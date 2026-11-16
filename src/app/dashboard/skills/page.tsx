import { asc } from "drizzle-orm";
import { db } from "@/db";
import { agents, teams } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { listSkills } from "@/lib/skills/service";
import { PageHeader } from "@/components/ui";
import { SkillsManager } from "@/components/skills/skills-manager";
import { isAdminRole } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skills" };

export default function SkillsPage() {
  const user = getCurrentUser();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Skills"
        description="Ways of working, written down. An agent or a team that is given a skill reads it with every task."
      />
      <SkillsManager
        initialSkills={listSkills({ withInstructions: false })}
        agents={db.select({ id: agents.id, name: agents.name }).from(agents).orderBy(asc(agents.name)).all()}
        teams={db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)).all()}
        isAdmin={isAdminRole(user?.role)}
      />
    </div>
  );
}
