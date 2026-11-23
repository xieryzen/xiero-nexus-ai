"use client";

import Link from "next/link";
import { useState } from "react";
import type { NoteDTO } from "@/lib/account-memory";
import type { AccessDTO } from "@/lib/access/store";
import type { OwnAccessMode } from "@/lib/access/rules";
import { ApiError, apiFetch } from "@/lib/client";
import { Alert, Badge, Button, Card, EmptyState, Input, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/time";

const KIND_LABEL: Record<AccessDTO["kind"], string> = { server: "Server", site: "Site account", key: "Key" };
const KIND_ICON: Record<AccessDTO["kind"], "server" | "browser" | "key"> = { server: "server", site: "browser", key: "key" };

interface Loaded {
  notes: NoteDTO[];
  access: AccessDTO[];
}

export function MemoryManager({
  notes: initialNotes,
  access: initialAccess,
  handsOver,
  mode,
  chats,
  browser,
}: {
  notes: NoteDTO[];
  access: AccessDTO[];
  /** Whether this account may hand access over in a conversation. */
  handsOver: boolean;
  mode: OwnAccessMode;
  /** How many conversations the account has. */
  chats: number;
  /** Whether a browser is set up on this installation. */
  browser: boolean;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [access, setAccess] = useState(initialAccess);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteFor, setSiteFor] = useState<Record<string, string>>({});

  async function refresh() {
    const data = await apiFetch<Loaded>("/api/memory");
    setNotes(data.notes);
    setAccess(data.access);
  }

  async function act(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const addNote = () =>
    act("add", async () => {
      await apiFetch("/api/memory", { method: "POST", body: JSON.stringify({ content: text }) });
      setText("");
    });

  const forgetAll = () => {
    if (!confirm(`Forget all ${notes.length} notes? The assistant starts later conversations without them. This cannot be undone.`)) return;
    void act("clear", () => apiFetch("/api/memory", { method: "DELETE" }));
  };

  const removeAccess = (item: AccessDTO) => {
    if (!confirm(`Remove ${KIND_LABEL[item.kind].toLowerCase()} "${item.name}"? What signs in is deleted, and the assistant cannot reach it any more.`)) return;
    void act(`remove-${item.id}`, () => apiFetch(`/api/access/${item.kind}/${item.id}`, { method: "DELETE" }));
  };

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card
        title="Access you handed over"
        description="Servers, site accounts and keys you wrote in a conversation or in a project. The app took the password out of the text before any model saw it and keeps it encrypted; the assistant and the agents of your projects work with it by name."
      >
        {!handsOver && (
          <div className="mb-4">
            <Alert tone="warn">
              Handing access over in a conversation is not switched on for your account on this installation
              {mode === "off" ? "" : mode === "owners" ? " (it is for owners)" : " (it is for owners and administrators)"}. Nothing you write is kept as access,
              and what is listed here is not used.
            </Alert>
          </div>
        )}
        {access.length === 0 ? (
          <EmptyState
            title="Nothing handed over yet"
            description="In Chat, write for example: “VPS 203.0.113.7, user root, password …, check why nginx is down”. The app signs in once to try it, keeps it, and the assistant does the work."
            action={
              <Link href="/dashboard/chat" className="btn btn-primary">
                Open Chat
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="access-list">
            {access.map((item) => (
              <li key={`${item.kind}-${item.id}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <Icon name={KIND_ICON[item.kind]} size={15} />
                    <span className="mono font-medium">{item.name}</span>
                    <Badge tone={item.status === "enabled" ? "ok" : "neutral"}>{item.status === "enabled" ? KIND_LABEL[item.kind] : `${KIND_LABEL[item.kind]}, switched off`}</Badge>
                  </p>
                  <p className="mt-0.5 text-sm text-ink-2">{item.where}</p>
                  {item.detail && <p className="mt-0.5 text-xs text-ink-3">{item.detail}</p>}
                  {item.problem && <p className="mt-0.5 text-xs text-warn">Last problem: {item.problem}</p>}
                  <p className="mt-0.5 text-xs text-ink-3">
                    Kept <RelativeTime at={item.createdAt} />
                    {item.lastUsedAt ? (
                      <>
                        {" · used "}
                        <RelativeTime at={item.lastUsedAt} />
                      </>
                    ) : (
                      " · not used yet"
                    )}
                    {item.kind === "site" && !browser ? " · no browser is set up on this installation, so it cannot be signed in to from here" : ""}
                  </p>
                  {item.kind === "key" && (
                    <form
                      className="mt-2 flex max-w-md items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(`site-${item.id}`, () =>
                          apiFetch(`/api/access/key/${item.id}`, { method: "PATCH", body: JSON.stringify({ site: siteFor[item.id] ?? "" }) }),
                        );
                      }}
                    >
                      <Input
                        aria-label={`Site of ${item.name}`}
                        placeholder="The site it is for: api.example.com"
                        value={siteFor[item.id] ?? ""}
                        onChange={(e) => setSiteFor((s) => ({ ...s, [item.id]: e.target.value }))}
                      />
                      <Button type="submit" variant="ghost" loading={busy === `site-${item.id}`}>
                        Set site
                      </Button>
                    </form>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    loading={busy === `status-${item.id}`}
                    onClick={() =>
                      void act(`status-${item.id}`, () =>
                        apiFetch(`/api/access/${item.kind}/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: item.status === "enabled" ? "disabled" : "enabled" }) }),
                      )
                    }
                  >
                    {item.status === "enabled" ? "Switch off" : "Switch on"}
                  </Button>
                  <Button variant="danger" loading={busy === `remove-${item.id}`} onClick={() => removeAccess(item)}>
                    <Icon name="trash" size={15} /> Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-ink-3">
          A key is sent in a web request only to the site it is tied to, and can be written into a command on your own server. To replace a password, send the
          new one in a conversation: the same server or account is kept again. Change a password you sent here whenever you like: the app then asks for the new one.
        </p>
      </Card>

      <Card
        title="What the assistant remembers"
        description={`Short notes it kept in your conversations, and the ones you write here. They are put in front of it at the start of every conversation and of every run of your projects, together with what your other conversations (${chats}) said about the same thing.`}
        actions={
          notes.length > 0 ? (
            <Button variant="danger" onClick={forgetAll} loading={busy === "clear"}>
              Forget all
            </Button>
          ) : undefined
        }
      >
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void addNote();
          }}
        >
          <Textarea
            aria-label="A note for the assistant"
            className="min-h-[44px] flex-1"
            placeholder="Something it should know in every conversation: “My shop runs on the VPS in Jakarta, deploys go through GitHub Actions.”"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
          />
          <Button type="submit" loading={busy === "add"} disabled={!text.trim()}>
            <Icon name="plus" size={16} /> Add note
          </Button>
        </form>
        <p className="mt-1.5 text-xs text-ink-3">Never a password or a key: what looks like one is taken out of a note.</p>

        {notes.length === 0 ? (
          <p className="mt-4 text-sm text-ink-3">Nothing is remembered yet. Tell the assistant something about you or your work, and it keeps what will matter later.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line" data-testid="notes-list">
            {notes.map((note) => (
              <li key={note.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="whitespace-pre-wrap break-words text-sm text-ink">{note.content}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {note.source === "manual" ? "Written by you" : "Kept by the assistant"} <RelativeTime at={note.createdAt} />
                    {note.chatId && (
                      <>
                        {" · "}
                        <Link href={`/dashboard/chat?c=${note.chatId}`} className="text-signal hover:underline">
                          the conversation
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  aria-label="Forget this note"
                  loading={busy === `note-${note.id}`}
                  onClick={() => void act(`note-${note.id}`, () => apiFetch(`/api/memory/${note.id}`, { method: "DELETE" }))}
                >
                  <Icon name="trash" size={15} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
