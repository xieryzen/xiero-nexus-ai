import { listAccountNotes } from "@/lib/account-memory";
import { accessMode, accessOf, handsOver } from "@/lib/access/store";
import { requirePageUser } from "@/lib/auth";
import { browserConfigured } from "@/lib/browser/service";
import { chatCount } from "@/lib/chat/store";
import { PageHeader } from "@/components/ui";
import { MemoryManager } from "@/components/memory/memory-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Memory" };

/**
 * What the AI remembers about the account that looks, and what the account
 * handed over to it. Everyone has this page, and it shows nobody else's.
 */
export default function MemoryPage() {
  const user = requirePageUser();
  return (
    <div>
      <PageHeader
        title="Memory"
        description="What the assistant remembers about you across conversations, and the access you handed to it. It is yours alone: nobody else's chat or project is shown it."
      />
      <MemoryManager
        notes={listAccountNotes(user.id)}
        access={accessOf(user.id)}
        handsOver={handsOver(user)}
        mode={accessMode()}
        chats={chatCount(user.id)}
        browser={browserConfigured()}
      />
    </div>
  );
}
