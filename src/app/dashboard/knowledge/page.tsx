import { requirePageUser } from "@/lib/auth";
import { AUTO_MODEL, listCollections } from "@/lib/knowledge/service";
import { kindsAvailable } from "@/lib/model-choice";
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
      // Someone who is shown the setup chooses the embedding model. A user
      // says only whether a collection is searched by meaning as well.
      embeddingModels={
        isAdminRole(user.role)
          ? embeddingModelOptions()
          : kindsAvailable().embeddings
            ? [{ id: AUTO_MODEL, label: "By meaning as well" }]
            : []
      }
      initialSelectedId={collections.some((c) => c.id === wanted) ? wanted : (collections[0]?.id ?? null)}
      isAdmin={isAdminRole(user.role)}
    />
  );
}
