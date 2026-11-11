import { asc } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { serializeModels } from "@/lib/models";
import { adapterIsImplemented } from "@/lib/adapters";
import { ModelsManager } from "@/components/models/models-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Models" };

export default function ModelsPage() {
  const user = getCurrentUser();
  const modelRows = db.select().from(models).orderBy(asc(models.modelId)).all();
  const providerRows = db
    .select()
    .from(providers)
    .orderBy(asc(providers.name))
    .all();

  return (
    <ModelsManager
      initialModels={serializeModels(modelRows)}
      providers={providerRows.map((p) => ({
        id: p.id,
        name: p.name,
        adapterImplemented: adapterIsImplemented(p.adapter),
        status: p.status,
      }))}
      isAdmin={user?.role === "admin"}
    />
  );
}
