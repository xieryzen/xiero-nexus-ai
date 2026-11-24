import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { serializeModels } from "@/lib/models";
import { whatUsersGet } from "@/lib/model-choice";
import { healthStatus } from "@/lib/model-health";
import { adapterAbilities, adapterIsImplemented, adapterSupportsMedia } from "@/lib/adapters";
import { ModelsManager } from "@/components/models/models-manager";
import { isOwnerRole, seesSetup } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Models" };

export default function ModelsPage() {
  const user = getCurrentUser();
  // How the installation is set up is shown to administrators (roles.ts: seesSetup).
  if (!seesSetup(user?.role)) redirect("/dashboard");
  const modelRows = db.select().from(models).orderBy(asc(models.modelId)).all();
  const providerRows = db
    .select()
    .from(providers)
    .orderBy(asc(providers.priority), asc(providers.name))
    .all();

  return (
    <ModelsManager
      initialModels={serializeModels(modelRows)}
      providers={providerRows.map((p) => ({
        id: p.id,
        name: p.name,
        adapterImplemented: adapterIsImplemented(p.adapter),
        supportsMedia: adapterSupportsMedia(p.adapter),
        abilities: adapterAbilities(p.adapter),
        status: p.status,
        priority: p.priority,
      }))}
      // An owner changes the models (v2.0); an admin is shown them.
      isAdmin={isOwnerRole(user?.role)}
      initialHealth={healthStatus()}
      initialUsers={whatUsersGet()}
    />
  );
}
