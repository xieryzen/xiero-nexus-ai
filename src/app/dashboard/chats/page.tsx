import { requirePageUser } from "@/lib/auth";
import { listChats } from "@/lib/chat/store";
import { ChatsClient } from "@/components/chat/chats-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chats" };

/** Every conversation of the account: to find one, open it, rename it, delete it. */
export default function ChatsPage() {
  const user = requirePageUser();
  return <ChatsClient initialChats={listChats(user.id, 500)} />;
}
