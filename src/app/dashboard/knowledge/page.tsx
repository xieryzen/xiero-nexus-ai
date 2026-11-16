import { requirePageUser } from "@/lib/auth";
import { listCollections } from "@/lib/knowledge/service";
import { embeddingModelOptions } from "@/lib/model-options";
import { KnowledgeClient } from "@/components/knowledge/knowledge-client";
import { isAdminRole } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Knowledge" };

export default function KnowledgePage({
  searchParams,
}: {
  searchParams: { collection?: string | string[] };
}) {
  const user = requirePageUser();
  const collections = listCollections(user);
  const wanted = typeof searchParams.collection === "string" ? searchParams.collection : null;
  return (
    <KnowledgeClient
      initialCollections={collections}
      embeddingModels={embeddingModelOptions()}
      initialSelectedId={collections.some((c) => c.id === wanted) ? wanted : (collections[0]?.id ?? null)}
      isAdmin={isAdminRole(user.role)}
    />
  );
}
