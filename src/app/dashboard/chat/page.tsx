import { requirePageUser } from "@/lib/auth";
import { listCollections } from "@/lib/knowledge/service";
import { chatModels } from "@/lib/model-options";
import { PageHeader } from "@/components/ui";
import { ChatClient, type ChatModelOption } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage() {
  const user = requirePageUser();
  // Media and embedding models cannot answer a chat request, so they are not offered.
  const options: ChatModelOption[] = chatModels().map((m) => ({
    id: m.id,
    label: m.name,
    providerName: m.providerName,
  }));

  return (
    <div>
      <PageHeader title="Chat" description="Talk to any enabled model through the gateway, with your knowledge base when you want it." />
      <ChatClient
        models={options}
        collections={listCollections(user).map((c) => ({ id: c.id, name: c.name, documentCount: c.documentCount }))}
      />
    </div>
  );
}
