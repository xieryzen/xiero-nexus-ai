import { listAccountNotes } from "@/lib/account-memory";
import { handsOver } from "@/lib/access/store";
import { requirePageUser } from "@/lib/auth";
import { chatPicker } from "@/lib/chat-models";
import { loadChat, messagesOf } from "@/lib/chat/store";
import { reachOf } from "@/lib/chat/tools";
import { isAnswering } from "@/lib/chat/turn";
import { listCollections } from "@/lib/knowledge/service";
import { kindsAvailable } from "@/lib/model-choice";
import { accountHas } from "@/lib/plans";
import { seesSetup } from "@/lib/roles";
import { ChatClient, type ChatMessageItem } from "@/components/chat/chat-client";

/**
 * A conversation, as the page shows it: the one the address names, or a new
 * one. The home page and the Chat page are both this.
 */
export function ChatScreen({ chatId }: { chatId?: string }) {
  const user = requirePageUser();
  // The models the account is offered, in categories; media and embedding
  // models cannot answer a conversation, so they are not among them.
  const groups = chatPicker(user);

  // The conversation the address names, when it is one of this account's.
  let initial: { id: string; title: string; systemPrompt: string | null; pinned: boolean; messages: ChatMessageItem[]; answering: boolean } | null = null;
  if (chatId) {
    try {
      const chat = loadChat(user.id, chatId);
      // An answer that is still being worked on (the page was closed meanwhile) is followed by the page.
      initial = { id: chat.id, title: chat.title, systemPrompt: chat.systemPrompt, pinned: chat.pinnedAt !== null, messages: messagesOf(chat.id), answering: isAnswering(chat.id) };
    } catch {
      // Not there, or someone else's: the page says so, and opens a new conversation.
    }
  }
  const reach = reachOf(user);
  const knowledge = accountHas(user, "knowledge");

  return (
    <ChatClient
      // Another conversation is another page: nothing of the one before stays.
      key={initial?.id ?? "new"}
      username={user.username}
      groups={groups}
      seesSetup={seesSetup(user.role)}
      ready={kindsAvailable().chat}
      knowledge={knowledge}
      collections={knowledge ? listCollections(user).map((c) => ({ id: c.id, name: c.name, documentCount: c.documentCount })) : []}
      initial={initial}
      reach={{
        servers: reach.servers.length,
        sites: reach.accounts.length,
        keys: reach.keys.length,
        notes: listAccountNotes(user.id).length,
        handsOver: handsOver(user),
      }}
    />
  );
}
