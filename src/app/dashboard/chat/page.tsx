import { ChatScreen } from "./screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat" };

export default function ChatPage({ searchParams }: { searchParams?: { c?: string } }) {
  return <ChatScreen chatId={typeof searchParams?.c === "string" ? searchParams.c : undefined} />;
}
