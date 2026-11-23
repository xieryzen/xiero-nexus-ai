import { listAccountNotes } from "@/lib/account-memory";
import { handsOver } from "@/lib/access/store";
import { requirePageUser } from "@/lib/auth";
import { listChats, loadChat, messagesOf } from "@/lib/chat/store";
import { reachOf } from "@/lib/chat/tools";
import { listCollections } from "@/lib/knowledge/service";
import { kindsAvailable } from "@/lib/model-choice";
import { chatModels } from "@/lib/model-options";
import { seesSetup } from "@/lib/roles";
import { PageHeader } from "@/components/ui";
import { ChatClient, type ChatMessageItem, type ChatModelOption } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage({ searchParams }: { searchParams?: { c?: string } }) {
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

  // The conversation the address names, when it is one of this account's.
  let initial: { id: string; title: string; systemPrompt: string | null; messages: ChatMessageItem[] } | null = null;
  const asked = typeof searchParams?.c === "string" ? searchParams.c : "";
  if (asked) {
    try {
      const chat = loadChat(user.id, asked);
      initial = { id: chat.id, title: chat.title, systemPrompt: chat.systemPrompt, messages: messagesOf(chat.id) };
    } catch {
      // Not there, or someone else's: the page opens with a new conversation.
    }
  }
  const reach = reachOf(user);

  return (
    <div>
      <PageHeader
        title="Chat"
        description={
          chooses
            ? "Talk to the assistant: it works on your servers, sites and APIs with what you hand it, and remembers what you tell it."
            : "Ask anything, or have it done: the assistant works with what you hand it, and remembers what you tell it."
        }
      />
      <ChatClient
        models={options}
        chooses={chooses}
        ready={chooses || kindsAvailable().chat}
        collections={listCollections(user).map((c) => ({ id: c.id, name: c.name, documentCount: c.documentCount }))}
        chats={listChats(user.id).map((c) => ({ id: c.id, title: c.title, messages: c.messages, updatedAt: c.updatedAt }))}
        initial={initial}
        reach={{
          servers: reach.servers.length,
          sites: reach.accounts.length,
          keys: reach.keys.length,
          notes: listAccountNotes(user.id).length,
          handsOver: handsOver(user),
        }}
      />
    </div>
  );
}
