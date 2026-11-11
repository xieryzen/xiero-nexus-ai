import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { adapterIsImplemented } from "@/lib/adapters";
import { PageHeader } from "@/components/ui";
import { ChatClient, type ChatModelOption } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage() {
  const rows = db
    .select({
      id: models.id,
      modelId: models.modelId,
      displayName: models.displayName,
      providerName: providers.name,
      providerStatus: providers.status,
      adapter: providers.adapter,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .orderBy(asc(models.modelId))
    .all();

  const options: ChatModelOption[] = rows
    .filter((r) => adapterIsImplemented(r.adapter))
    .map((r) => ({
      id: r.id,
      label: r.displayName || r.modelId,
      providerName: r.providerName,
    }));

  return (
    <div>
      <PageHeader title="Chat" description="Talk to any enabled model through the gateway." />
      <ChatClient models={options} />
    </div>
  );
}
