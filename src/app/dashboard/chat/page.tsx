import { chatModels } from "@/lib/model-options";
import { PageHeader } from "@/components/ui";
import { ChatClient, type ChatModelOption } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage() {
  // Image / video models cannot answer a chat request, so they are not offered.
  const options: ChatModelOption[] = chatModels().map((m) => ({
    id: m.id,
    label: m.name,
    providerName: m.providerName,
  }));

  return (
    <div>
      <PageHeader title="Chat" description="Talk to any enabled model through the gateway." />
      <ChatClient models={options} />
    </div>
  );
}
