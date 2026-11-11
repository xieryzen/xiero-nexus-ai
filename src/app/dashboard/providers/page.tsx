import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { serializeProvider } from "@/lib/providers";
import { ProvidersManager } from "@/components/providers/providers-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Providers" };

export default function ProvidersPage() {
  const user = getCurrentUser();
  const rows = db
    .select()
    .from(providers)
    .orderBy(asc(providers.priority), asc(providers.name))
    .all();

  const countRows = db
    .select({ providerId: models.providerId, count: sql<number>`count(*)` })
    .from(models)
    .groupBy(models.providerId)
    .all();
  const modelCounts: Record<string, number> = {};
  for (const r of countRows) modelCounts[r.providerId] = r.count;

  return (
    <ProvidersManager
      initialProviders={rows.map(serializeProvider)}
      modelCounts={modelCounts}
      isAdmin={user?.role === "admin"}
    />
  );
}
