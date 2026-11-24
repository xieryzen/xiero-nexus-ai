"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import type { ChatSummary } from "@/lib/chat/store";
import { RelativeTime } from "@/components/time";
import { Icon } from "@/components/icons";
import { Alert, Button, Input, cn } from "@/components/ui";

/** Tell the sidebar that the list of conversations changed. */
function changed() {
  window.dispatchEvent(new Event("nexus:chats"));
}

export function ChatsClient({ initialChats }: { initialChats: ChatSummary[] }) {
  const [chats, setChats] = useState(initialChats);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // The pinned ones first; each part stays in the order it came in: the ones written in last first.
    const ordered = [...chats.filter((chat) => chat.pinned), ...chats.filter((chat) => !chat.pinned)];
    if (words.length === 0) return ordered;
    return ordered.filter((chat) => {
      const title = chat.title.toLowerCase();
      return words.every((word) => title.includes(word));
    });
  }, [chats, query]);

  async function rename(chat: ChatSummary) {
    const title = draft.trim();
    if (!title || title === chat.title) {
      setRenaming(null);
      return;
    }
    setBusy(chat.id);
    setError(null);
    try {
      const res = await apiFetch<{ chat: { id: string; title: string } }>(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      setChats((list) => list.map((c) => (c.id === chat.id ? { ...c, title: res.chat.title } : c)));
      setRenaming(null);
      changed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The conversation could not be renamed");
    } finally {
      setBusy(null);
    }
  }

  async function pin(chat: ChatSummary) {
    setBusy(chat.id);
    setError(null);
    try {
      const res = await apiFetch<{ chat: { id: string; pinned: boolean } }>(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ pinned: !chat.pinned }) });
      setChats((list) => list.map((c) => (c.id === chat.id ? { ...c, pinned: res.chat.pinned } : c)));
      changed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The conversation could not be pinned");
    } finally {
      setBusy(null);
    }
  }

  async function remove(chat: ChatSummary) {
    if (!confirm(`Delete "${chat.title}"? What was remembered from it stays, on the Memory page.`)) return;
    setBusy(chat.id);
    setError(null);
    try {
      await apiFetch(`/api/chats/${chat.id}`, { method: "DELETE" });
      setChats((list) => list.filter((c) => c.id !== chat.id));
      changed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The conversation could not be deleted");
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    if (!confirm(`Delete all ${chats.length} conversations? What was remembered from them stays, on the Memory page.`)) return;
    setBusy("all");
    setError(null);
    try {
      await apiFetch("/api/chats", { method: "DELETE" });
      setChats([]);
      changed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The conversations could not be deleted");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl" id="chats">
      <div className="flex items-center justify-between gap-3 lg:mb-5">
        {/* On a phone the bar at the top says "Chats", and the button floats over the list, under the thumb. */}
        <h1 className="serif text-3xl font-medium tracking-tight text-ink max-lg:sr-only">Chats</h1>
        <Link href="/dashboard" className="btn-primary max-lg:fixed max-lg:bottom-5 max-lg:right-4 max-lg:z-20 max-lg:h-12 max-lg:px-5 max-lg:text-[15px] max-lg:shadow-pop" data-testid="chats-new">
          <Icon name="plus" size={17} /> New chat
        </Link>
      </div>

      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
          <Icon name="search" size={18} />
        </span>
        <Input
          type="search"
          aria-label="Search your chats"
          placeholder="Search your chats…"
          className="h-12 rounded-2xl pl-10 text-[16px]"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </div>

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 text-sm text-ink-3">
        <p data-testid="chats-count">
          {chats.length === 0
            ? "You have no conversation yet."
            : query.trim()
              ? `${shown.length} of ${chats.length} ${chats.length === 1 ? "conversation" : "conversations"}`
              : `${chats.length} ${chats.length === 1 ? "conversation" : "conversations"}`}
        </p>
        {chats.length > 0 && (
          <Button variant="ghost" className="text-xs" loading={busy === "all"} disabled={busy !== null} onClick={() => void removeAll()}>
            Delete all
          </Button>
        )}
      </div>

      <ul className="mt-2 divide-y divide-line border-t border-line" aria-label="All conversations">
        {shown.map((chat) => (
          <li key={chat.id} className="group flex items-center gap-2 py-1" data-chat-id={chat.id}>
            {renaming === chat.id ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename(chat);
                }}
              >
                <Input autoFocus aria-label="Title" value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} />
                <Button type="submit" loading={busy === chat.id}>
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <Link href={`/dashboard/chat?c=${chat.id}`} className="min-w-0 flex-1 rounded-xl px-2 py-2.5 hover:bg-ink/5">
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    {chat.pinned && <Icon name="pin" size={14} className="shrink-0 text-ink-3" />}
                    <span className="truncate">{chat.title}</span>
                  </span>
                  <span className="block text-xs text-ink-3">
                    Last message <RelativeTime at={new Date(chat.updatedAt)} /> · {chat.messages} {chat.messages === 1 ? "message" : "messages"}
                  </span>
                </Link>
                <button
                  type="button"
                  className={cn("icon-btn", chat.pinned && "text-accent-ink")}
                  aria-label={chat.pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
                  aria-pressed={chat.pinned}
                  title={chat.pinned ? "Unpin" : "Pin"}
                  disabled={busy !== null}
                  onClick={() => void pin(chat)}
                >
                  <Icon name="pin" size={17} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Rename ${chat.title}`}
                  title="Rename"
                  disabled={busy !== null}
                  onClick={() => {
                    setDraft(chat.title);
                    setRenaming(chat.id);
                  }}
                >
                  <Icon name="pencil" size={16} />
                </button>
                <button type="button" className="icon-btn hover:text-danger" aria-label={`Delete ${chat.title}`} title="Delete" disabled={busy !== null} onClick={() => void remove(chat)}>
                  <Icon name="trash" size={16} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {chats.length > 0 && shown.length === 0 && <p className="mt-6 text-center text-sm text-ink-3">No conversation has that in its title.</p>}
    </div>
  );
}
