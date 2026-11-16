import { requirePageUser } from "@/lib/auth";
import { listCollections } from "@/lib/knowledge/service";
import { kindsAvailable } from "@/lib/model-choice";
import { chatModels } from "@/lib/model-options";
import { seesSetup } from "@/lib/roles";
import { PageHeader } from "@/components/ui";
import { ChatClient, type ChatModelOption } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage() {
  const user = requirePageUser();
  // Someone who is shown the setup chooses the model. For a user the app
  // chooses, and the page is not handed the list.
  const chooses = seesSetup(user.role);
  // Media and embedding models cannot answer a chat request, so they are not offered.
  const options: ChatModelOption[] = chooses
    ? chatModels().map((m) => ({
        id: m.id,
        label: m.name,
        providerName: m.providerName,
      }))
    : [];

  return (
    <div>
      <PageHeader
        title="Chat"
        description={
          chooses
            ? "Talk to any enabled model through the gateway, with your knowledge base when you want it."
            : "Ask anything, with your knowledge base when you want it."
        }
      />
      <ChatClient
        models={options}
        chooses={chooses}
        ready={chooses || kindsAvailable().chat}
        collections={listCollections(user).map((c) => ({ id: c.id, name: c.name, documentCount: c.documentCount }))}
      />
    </div>
  );
}
