"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";
import type { Kept } from "@/lib/access/rules";
import type { PickerGroup } from "@/lib/chat-model-rules";
import type { MessageDetails, SourceNote, ToolNote } from "@/lib/chat/rules";
import { NexusMark } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Sheet, ShellTitle } from "@/components/sheet";
import { Alert, EmptyState, Spinner, Toggle, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ModelPicker } from "./model-picker";

export interface ChatCollectionOption {
  id: string;
  name: string;
  documentCount: number;
}

export interface ChatListItem {
  id: string;
  title: string;
  messages: number;
  updatedAt: number;
}

export interface ChatMessageItem {
  /** The id it is kept under. Absent while it is on its way. */
  id?: number;
  role: "user" | "assistant";
  content: string;
  details?: MessageDetails | null;
  /** When it was written, in milliseconds. */
  createdAt?: number;
}

/** What the account can reach from a conversation, in numbers: for the line under the composer. */
export interface ChatReach {
  servers: number;
  sites: number;
  keys: number;
  notes: number;
  /** Whether this account may hand access over in a conversation. */
  handsOver: boolean;
}

const KIND_LABEL: Record<Kept["kind"], string> = { server: "Server", site: "Site account", key: "Key" };
const KIND_ICON: Record<Kept["kind"], "server" | "browser" | "key"> = { server: "server", site: "browser", key: "key" };

const TOOL_LABEL: Record<string, string> = {
  run_on_server: "Ran on a server",
  use_browser: "In the browser",
  fetch_url: "Read a page",
  http_request: "Called an API",
  web_search: "Searched the web",
  remember: "Remembered",
  recall: "Looked up its memory",
  keep_access: "Kept access",
};

/** What a new conversation can start with: a word to click, and the beginning of a message. */
const STARTERS: { label: string; icon: "pencil" | "manager" | "api" | "knowledge"; text: string }[] = [
  { label: "Write", icon: "pencil", text: "Help me write " },
  { label: "Plan", icon: "manager", text: "Make a plan for " },
  { label: "Code", icon: "api", text: "Write the code for " },
  { label: "Learn", icon: "knowledge", text: "Explain to me " },
];

/** The page address of a conversation. */
const CHAT_PATH = "/dashboard/chat";

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Tell the sidebar that the list of conversations changed. */
function conversationsChanged(): void {
  window.dispatchEvent(new Event("nexus:chats"));
}

export function ChatClient({
  username,
  groups,
  collections,
  knowledge = true,
  ready = true,
  seesSetup = false,
  initial = null,
  reach,
}: {
  /** Who is greeted. */
  username: string;
  /** The models the account is offered, in categories. Empty: only the app's choice. */
  groups: PickerGroup[];
  /** Knowledge collections the user can read. */
  collections: ChatCollectionOption[];
  /** Whether the plan of the account has answers from one's documents. */
  knowledge?: boolean;
  /** Whether the installation can answer a conversation at all. */
  ready?: boolean;
  /** Whether the reader is shown how the installation is set up: an empty installation is explained to them. */
  seesSetup?: boolean;
  /** The conversation the page was opened with. */
  initial?: { id: string; title: string; systemPrompt: string | null; pinned?: boolean; messages: ChatMessageItem[]; answering?: boolean } | null;
  reach?: ChatReach;
}) {
  // "" is the app's own choice: the models in turn, the ones that take tools first.
  const [modelId, setModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  // What is added to the conversation: knowledge to answer from, instructions of one's own.
  const [showAdd, setShowAdd] = useState(false);
  const [pinnedChat, setPinnedChat] = useState(initial?.pinned === true);
  /** The name being typed in the dialog that renames; null while it is closed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [outline, setOutline] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState("");
  const titleMenuRef = useRef<HTMLDivElement>(null);
  const [chatId, setChatIdState] = useState<string | null>(initial?.id ?? null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [messages, setMessages] = useState<ChatMessageItem[]>(initial?.messages ?? []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<{ text: string; link?: string } | null>(null);
  const [liveTools, setLiveTools] = useState<ToolNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [greeting, setGreeting] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The conversation the page shows, known at once (a state is only known at the next render).
  const chatIdRef = useRef<string | null>(initial?.id ?? null);
  const setChatId = useCallback((id: string | null) => {
    chatIdRef.current = id;
    setChatIdState(id);
  }, []);
  // A new number with every conversation the page turns to: what still
  // arrives for the one before is dropped.
  const turn = useRef(0);
  const asked = useSearchParams().get("c");

  useEffect(() => {
    const hour = new Date().getHours();
    setGreeting(hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening");
  }, []);

  // New text keeps the end of the conversation in view, unless the reader scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages, draft, liveTools, progress, loading]);

  // The message field grows with what is written, up to a part of the screen.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [input]);

  /** The address says which conversation is open, so that a reload opens it again. */
  const address = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    url.pathname = CHAT_PATH;
    if (id) url.searchParams.set("c", id);
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url.toString());
  }, []);

  /** The conversation as it is kept now. Resolves to whether it is still being answered. */
  const reload = useCallback(async (id: string): Promise<boolean> => {
    const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { chat: { title: string; systemPrompt: string | null }; messages: ChatMessageItem[]; answering?: boolean };
    if (chatIdRef.current !== id) return false;
    setMessages(data.messages);
    if (data.chat?.title) setTitle(data.chat.title);
    return data.answering === true;
  }, []);

  /**
   * An answer goes on when the page stops listening: a phone that slept, a
   * connection that dropped, a page that was opened again. The page then
   * asks now and then until the answer is in the conversation.
   */
  const following = useRef<string | null>(null);
  const follow = useCallback(
    async (id: string) => {
      if (following.current === id) return;
      following.current = id;
      setStreaming(true);
      setProgress({ text: "The assistant is still working on this. What it does is kept here as it goes." });
      try {
        for (let round = 0; round < 1200 && following.current === id; round++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (following.current !== id) return;
          const still = await reload(id).catch(() => true);
          if (!still) break;
        }
      } finally {
        if (following.current === id) {
          following.current = null;
          setStreaming(false);
          setProgress(null);
        }
      }
    },
    [reload],
  );
  const openedWith = useRef(initial?.answering ? initial.id : null);
  useEffect(() => {
    if (openedWith.current) void follow(openedWith.current);
    openedWith.current = null;
    return () => {
      // The page is left: nothing is listened to any more. An answer goes on by itself.
      following.current = null;
      // A counter, not a node of the page: its value when the page is left is the one that is meant.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      turn.current++;
      abortRef.current?.abort();
    };
  }, [follow]);

  /** Leave what the page shows: stop listening to an answer (it goes on, and is kept). */
  const leave = useCallback((): number => {
    const mine = ++turn.current;
    abortRef.current?.abort();
    abortRef.current = null;
    following.current = null;
    setStreaming(false);
    setDraft("");
    setLiveTools([]);
    setProgress(null);
    setError(null);
    setUsage(null);
    setTitleMenu(false);
    pinned.current = true;
    return mine;
  }, []);

  const open = useCallback(
    async (id: string) => {
      const mine = leave();
      setChatId(id);
      setLoading(true);
      try {
        const res = await fetch(`/api/chats/${id}`, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (turn.current !== mine) return;
        if (!res.ok) throw new Error(data?.error?.message ?? "The conversation could not be opened");
        setMessages(data.messages as ChatMessageItem[]);
        setSystemPrompt(data.chat?.systemPrompt ?? "");
        setTitle(data.chat?.title ?? "");
        setPinnedChat(data.chat?.pinned === true);
        if (data.answering === true) void follow(id);
      } catch (err) {
        if (turn.current !== mine) return;
        // Not there, or someone else's: the page is a new conversation, and says why.
        setChatId(null);
        setMessages([]);
        setTitle("");
        address(null);
        setError(err instanceof Error ? err.message : "The conversation could not be opened");
      } finally {
        if (turn.current === mine) setLoading(false);
      }
    },
    [address, follow, leave, setChatId],
  );

  const startNew = useCallback(() => {
    leave();
    setChatId(null);
    setMessages([]);
    setTitle("");
    setPinnedChat(false);
    setSystemPrompt("");
    setLoading(false);
    // Not on a phone: the keyboard would cover the page that was just opened.
    if (window.matchMedia("(min-width: 640px)").matches) setTimeout(() => inputRef.current?.focus(), 0);
  }, [leave, setChatId]);

  // The address leads: a conversation chosen in the sidebar, "New chat", the
  // back button. What the page itself wrote into the address is what it shows.
  useEffect(() => {
    if (asked === chatIdRef.current) return;
    if (asked) void open(asked);
    else startNew();
  }, [asked, open, startNew]);
  // "New chat" where the address is a new conversation's already.
  useEffect(() => {
    const onNew = () => {
      if (chatIdRef.current === null) startNew();
    };
    window.addEventListener("nexus:new-chat", onNew);
    return () => window.removeEventListener("nexus:new-chat", onNew);
  }, [startNew]);

  async function remove() {
    const id = chatId;
    if (!id) return;
    setTitleMenu(false);
    if (!confirm(`Delete the conversation "${title || "New chat"}"? What the assistant remembered from it stays on the Memory page.`)) return;
    const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "The conversation could not be deleted");
      return;
    }
    conversationsChanged();
    startNew();
    address(null);
  }

  async function pin() {
    const id = chatId;
    if (!id) return;
    setTitleMenu(false);
    const next = !pinnedChat;
    const res = await fetch(`/api/chats/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: next }) });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "The conversation could not be pinned");
      return;
    }
    setPinnedChat(next);
    conversationsChanged();
  }

  async function rename() {
    const id = chatId;
    const next = renaming?.trim();
    setRenaming(null);
    if (!id || !next || next === title) return;
    const res = await fetch(`/api/chats/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: next }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "The conversation could not be renamed");
      return;
    }
    setTitle((data?.chat?.title as string | undefined) ?? next);
    conversationsChanged();
  }

  async function send(written?: string) {
    const text = (written ?? input).trim();
    if (!text || streaming) return;
    const mine = turn.current;
    const live = () => turn.current === mine;
    setError(null);
    setUsage(null);
    pinned.current = true;
    // Shown at once; replaced by the message as it was kept, without what signs in.
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setStreaming(true);
    setDraft("");
    setLiveTools([]);
    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;
    let current = chatIdRef.current;
    let finished = false;
    let resume: string | null = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chatId: current ?? undefined,
          message: text,
          modelRowId: modelId || undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        if (!live()) return;
        // Nothing was kept of it: the message goes back to where it was written.
        setMessages((prev) => prev.slice(0, -1));
        setInput(text);
        throw new Error(data?.error?.message ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let streamError: string | null = null;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!live()) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload) continue;
          let evt: {
            chat?: { id: string; title: string };
            user?: ChatMessageItem;
            progress?: string;
            link?: string;
            reset?: boolean;
            delta?: string;
            tool?: ToolNote;
            done?: boolean;
            error?: string;
            usage?: { promptTokens: number; completionTokens: number };
            message?: ChatMessageItem | null;
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.chat) {
            // Said twice: at once, and again when the conversation has its name.
            const { id, title: named } = evt.chat;
            current = id;
            setChatId(id);
            setTitle(named);
            address(id);
            conversationsChanged();
          } else if (evt.user) {
            const kept = evt.user;
            setMessages((prev) => [...prev.slice(0, -1), kept]);
          } else if (typeof evt.progress === "string") {
            setProgress({ text: evt.progress, link: evt.link });
          } else if (evt.reset) {
            acc = "";
            setDraft("");
          } else if (evt.delta) {
            acc += evt.delta;
            setDraft(acc);
            setProgress(null);
          } else if (evt.tool) {
            const note = evt.tool;
            setLiveTools((list) => [...list, note]);
            setProgress(null);
          } else if (evt.error) {
            streamError = evt.error;
          } else if (evt.done) {
            finished = true;
            if (evt.usage) setUsage(evt.usage);
            const answer = evt.message;
            if (answer) setMessages((prev) => [...prev, answer]);
          }
        }
      }

      if (!live()) return;
      if (streamError) {
        setError(streamError);
        // What was done before it failed is in the conversation.
        if (current) await reload(current);
      } else if (!finished && current) {
        // The connection ended before the answer did: the answer goes on, and is followed.
        resume = (await reload(current)) ? current : null;
      }
    } catch (err) {
      if (!live()) return;
      // The connection broke. The answer goes on where the conversation is known; it is followed.
      if (current) resume = (await reload(current).catch(() => false)) ? current : null;
      else if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (live()) {
        setStreaming(false);
        setDraft("");
        setLiveTools([]);
        setProgress(null);
        abortRef.current = null;
        // The conversation's place in the sidebar, and the tokens left in the top bar.
        conversationsChanged();
      }
    }
    if (resume && live()) void follow(resume);
  }

  /** Stop the answer: the app ends what it is doing, and keeps what was done. */
  async function stop() {
    const id = chatId ?? following.current;
    if (!id) {
      // Nothing is known of the conversation yet: nothing was asked of a model either.
      abortRef.current?.abort();
      return;
    }
    setProgress({ text: "Stopping…" });
    try {
      await fetch(`/api/chats/${id}/stop`, { method: "POST" });
    } catch {
      setError("The answer could not be stopped: the app did not answer. It goes on, and is kept in this conversation.");
    }
  }

  // The menu of a conversation closes with a click beside it.
  useEffect(() => {
    if (!titleMenu) return;
    const away = (e: MouseEvent) => {
      if (!titleMenuRef.current?.contains(e.target as Node)) setTitleMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [titleMenu]);

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <EmptyState
          title={seesSetup ? "No models available" : "Chat is not available yet"}
          description={
            seesSetup
              ? "Enable at least one model on an enabled provider (with an implemented adapter) to start chatting."
              : "An administrator has to set this installation up."
          }
        />
      </div>
    );
  }

  const empty = !loading && messages.length === 0 && !draft && !streaming;

  const added = collectionIds.length + (systemPrompt.trim() ? 1 : 0);

  const composer = (
    <div
      className="rounded-3xl border border-line-strong bg-surface transition focus-within:border-ink-3 sm:shadow-composer"
      data-testid="composer"
      onClick={(e) => {
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}
    >
      <textarea
        ref={inputRef}
        className="block max-h-[40vh] min-h-[3.25rem] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-[17px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
        placeholder={messages.length === 0 ? "How can I help you today?" : "Reply…"}
        aria-label="Message"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter starts a line. Not while a word is being composed (an input method).
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        rows={1}
        disabled={streaming}
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          aria-haspopup="dialog"
          aria-label={added > 0 ? `Add to chat (${added} added)` : "Add to chat: knowledge, instructions, memory"}
          title="Add to chat"
          data-testid="add-to-chat"
          data-added={added}
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-2 text-ink transition hover:bg-surface-3"
        >
          <Icon name="plus" size={20} />
          {added > 0 && <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden="true" />}
        </button>
        <ModelPicker groups={groups} value={modelId} onChange={setModelId} disabled={streaming} />
        <div className="flex-1" />
        {streaming ? (
          <button type="button" onClick={stop} title="Stop the answer" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-ink transition hover:opacity-90">
            <Icon name="stop" size={15} />
            <span className="sr-only">Stop</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim()}
            title="Send"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-signal text-white transition hover:brightness-105 disabled:opacity-40"
          >
            <Icon name="up" size={19} strokeWidth={2.2} />
            <span className="sr-only">Send</span>
          </button>
        )}
      </div>
    </div>
  );

  /** What is added to the conversation: documents to answer from, instructions, and what is remembered. */
  const addSheet = (
    <Sheet open={showAdd} onClose={() => setShowAdd(false)} title="Add to chat" testId="add-sheet">
      <div className="space-y-5 pb-5">
        <section data-testid="knowledge-panel">
          <p className="list-title">Knowledge</p>
          {!knowledge ? (
            <div className="list-group">
              <p className="list-row block text-ink-2">
                Answers that are based on your own documents are not part of your plan.{" "}
                <Link href="/dashboard/plans" className="text-accent-ink underline underline-offset-2">
                  See the plans
                </Link>
              </p>
            </div>
          ) : collections.length === 0 ? (
            <div className="list-group">
              <p className="list-row block text-ink-2">
                No knowledge collection yet. Add documents on the{" "}
                <Link href="/dashboard/knowledge" className="text-accent-ink underline underline-offset-2">
                  Knowledge
                </Link>{" "}
                page, then answers here can be based on them.
              </p>
            </div>
          ) : (
            <>
              <ul className="list-group">
                {collections.map((c) => (
                  <li key={c.id} className="list-row">
                    <Icon name="knowledge" size={20} className="shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.name}</span>
                      <span className="block text-[13px] text-ink-3">
                        {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
                      </span>
                    </span>
                    <Toggle
                      label={`Answer from ${c.name}`}
                      checked={collectionIds.includes(c.id)}
                      onChange={() => setCollectionIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id].slice(0, 10)))}
                    />
                  </li>
                ))}
              </ul>
              <p className="px-4 pt-2 text-[13px] leading-snug text-ink-3">
                Before each answer, the passages of the collections that are switched on and fit your question are put in front of the assistant, and the
                answer names the ones it used.
              </p>
            </>
          )}
        </section>
        <section>
          <p className="list-title">Instructions</p>
          <textarea
            className="input min-h-[96px] resize-y rounded-2xl text-[15px]"
            placeholder="Optional instructions for this conversation: how to answer, what to keep in mind…"
            aria-label="Instructions for this conversation"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </section>
        <section>
          <p className="list-title">Memory and access</p>
          <div className="list-group">
            <Link href="/dashboard/memory" className="list-row">
              <Icon name="memory" size={20} className="shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1">
                <span className="block">Memory</span>
                {reach && (
                  <span className="block text-[13px] text-ink-3">
                    {count(reach.notes, "note")}, {count(reach.servers + reach.sites + reach.keys, "access", "accesses")} kept
                  </span>
                )}
              </span>
              <Icon name="right" size={18} className="shrink-0 text-ink-3" />
            </Link>
          </div>
          <p className="px-4 pt-2 text-[13px] leading-snug text-ink-3">
            The assistant can act, not only answer. What you tell it is remembered: a new conversation starts with what the earlier ones established.
            {reach?.handsOver !== false &&
              " Write how to sign in to a server, a web site or an API (address, user name, password or key) in a message and say what to do: the app takes the password out before the AI sees it, keeps it encrypted, and the assistant works with it from then on."}
          </p>
        </section>
      </div>
    </Sheet>
  );

  const notices = (
    <>
      {error && (
        <div className="mb-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </>
  );

  const needle = outlineQuery.trim().toLowerCase();

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 w-full flex-col supports-[height:100dvh]:h-[calc(100dvh-3.5rem)]" data-testid="chat">
      {addSheet}
      {empty ? (
        // A new conversation: the mark and a greeting in the middle of the page. The field to write in is at the
        // bottom edge on a phone, under the thumb, and under the greeting on a wider screen.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4" data-testid="transcript">
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col sm:justify-center sm:pb-[10vh]">
            <div className={cn("flex flex-1 flex-col items-center justify-center py-6 transition-opacity duration-300 sm:flex-none sm:pb-9", greeting ? "opacity-100" : "opacity-0")}>
              <NexusMark size={46} />
              <h1 className="serif mt-5 text-center text-[1.75rem] font-normal leading-tight tracking-tight text-ink sm:text-[2.5rem]" data-testid="greeting">
                {greeting ?? "Hello"}, {username}
              </h1>
            </div>
            <div className="pb-safe shrink-0 sm:pb-0">
              {notices}
              {composer}
              <div className="mt-4 hidden flex-wrap justify-center gap-2 sm:flex">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    onClick={() => {
                      setInput(starter.text);
                      setTimeout(() => {
                        const el = inputRef.current;
                        el?.focus();
                        el?.setSelectionRange(starter.text.length, starter.text.length);
                      }, 0);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-ink/[0.06] px-3.5 py-1.5 text-sm text-ink-2 transition hover:bg-ink/[0.1] hover:text-ink"
                  >
                    <Icon name={starter.icon} size={15} className="text-ink-3" />
                    {starter.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* The name of the conversation and what can be done with it, in the bar at the top. */}
          <ShellTitle>
            <div className="relative flex min-w-0 items-center" ref={titleMenuRef}>
              <button
                type="button"
                onClick={() => setTitleMenu((v) => !v)}
                disabled={!chatId}
                aria-haspopup="menu"
                aria-expanded={titleMenu}
                className="flex min-w-0 items-center gap-1 rounded-full px-3 py-1.5 text-[17px] font-semibold text-ink transition hover:bg-ink/[0.07] disabled:hover:bg-transparent"
                data-testid="chat-title"
              >
                {pinnedChat && <Icon name="pin" size={15} className="shrink-0 text-ink-3" />}
                <span className="truncate">{title || "New chat"}</span>
                {chatId && <Icon name="chevron" size={16} className="shrink-0 text-ink-3" />}
              </button>
              {titleMenu && chatId && (
                <div role="menu" data-testid="chat-menu" className="popover absolute left-1/2 top-full z-40 mt-1.5 w-64 -translate-x-1/2 animate-fade p-1.5 lg:left-0 lg:translate-x-0">
                  <p className="truncate px-3 pb-1.5 pt-1 text-[13px] text-ink-3">{title || "New chat"}</p>
                  <button type="button" role="menuitem" className="nav-row py-2.5 text-[15px]" onClick={() => void pin()}>
                    <Icon name="pin" size={19} /> {pinnedChat ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="nav-row py-2.5 text-[15px]"
                    onClick={() => {
                      setTitleMenu(false);
                      setRenaming(title);
                    }}
                  >
                    <Icon name="pencil" size={19} /> Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="nav-row py-2.5 text-[15px]"
                    onClick={() => {
                      setTitleMenu(false);
                      setOutlineQuery("");
                      setOutline(true);
                    }}
                  >
                    <Icon name="list" size={19} /> Conversation outline
                  </button>
                  <button type="button" role="menuitem" className="nav-row py-2.5 text-[15px] text-danger" onClick={() => void remove()}>
                    <Icon name="trash" size={19} /> Delete
                  </button>
                </div>
              )}
            </div>
          </ShellTitle>

          <Sheet dialog open={renaming !== null} onClose={() => setRenaming(null)} title="Rename" testId="rename-dialog">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <input className="input text-[16px]" value={renaming ?? ""} onChange={(e) => setRenaming(e.target.value)} maxLength={80} autoFocus aria-label="Name of the conversation" />
              <div className="mt-4 flex gap-2.5">
                <button type="button" className="btn-ghost h-11 flex-1 text-[15px]" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary h-11 flex-1 text-[15px]" disabled={!renaming?.trim() || renaming.trim() === title}>
                  Save
                </button>
              </div>
            </form>
          </Sheet>

          <Sheet open={outline} onClose={() => setOutline(false)} title="Conversation outline" testId="outline">
            <label className="mb-3 flex items-center gap-2.5 rounded-2xl border border-line-strong bg-field px-3.5 py-2.5 text-ink-3">
              <Icon name="search" size={18} />
              <input
                value={outlineQuery}
                onChange={(e) => setOutlineQuery(e.target.value)}
                placeholder="A word from a message"
                aria-label="Search this conversation"
                className="min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none"
              />
            </label>
            <ul className="list-group mb-5">
              {messages
                .map((m, i) => ({ m, i }))
                .filter(({ m }) => !needle || m.content.toLowerCase().includes(needle))
                .map(({ m, i }) => (
                  <li key={m.id ?? `o-${i}`}>
                    <button
                      type="button"
                      className="list-row items-start"
                      onClick={() => {
                        setOutline(false);
                        setTimeout(() => document.getElementById(`msg-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
                      }}
                    >
                      {m.role === "user" ? (
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-signal text-xs font-semibold text-white" aria-hidden="true">
                          {username.slice(0, 1).toUpperCase()}
                        </span>
                      ) : (
                        <span className="grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
                          <NexusMark size={24} />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-ink-2">{m.role === "user" ? "You" : "Assistant"}</span>
                        <span className="block truncate text-[15px] text-ink">{firstLine(m.content) || (m.details?.tools?.length ? "(worked with tools)" : "(empty message)")}</span>
                        {m.createdAt && <span className="block text-[12px] text-ink-3">{outlineTime(m.createdAt)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </Sheet>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4"
            data-testid="transcript"
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="mx-auto w-full max-w-3xl space-y-6 pb-6 pt-2">
              {loading && (
                <div className="flex justify-center py-16 text-ink-3">
                  <Spinner />
                </div>
              )}
              {!loading &&
                messages.map((m, i) => (
                  <div key={m.id ?? `new-${i}`} id={`msg-${i}`} className="scroll-mt-4">
                    {m.role === "assistant" && m.details?.tools && m.details.tools.length > 0 && <Tools tools={m.details.tools} />}
                    {(m.content || m.role === "user") && <Bubble role={m.role} content={m.content} />}
                    {m.role === "user" && m.details?.kept && m.details.kept.length > 0 && <KeptList kept={m.details.kept} />}
                    {m.role === "assistant" && m.details && <Footnote details={m.details} />}
                    {m.role === "assistant" && m.content && <Actions content={m.content} />}
                  </div>
                ))}
              {streaming && (
                <div>
                  {liveTools.length > 0 && <Tools tools={liveTools} live />}
                  <Bubble role="assistant" content={draft} streaming />
                  {progress && (
                    <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-3" data-testid="chat-progress">
                      <Spinner size={12} /> {progress.text}
                      {progress.link && (
                        <Link href={progress.link} target="_blank" className="font-medium text-accent-ink hover:underline">
                          Open the page
                        </Link>
                      )}
                    </p>
                  )}
                </div>
              )}
              {usage && !streaming && (
                <p className="text-xs text-ink-3">
                  Last response · {formatNumber(usage.promptTokens)} prompt + {formatNumber(usage.completionTokens)} completion tokens
                </p>
              )}
            </div>
          </div>

          <div className="pb-safe shrink-0 px-4 pt-1">
            <div className="mx-auto w-full max-w-3xl">
              {notices}
              {composer}
              <p className="mt-1.5 hidden text-center text-[11px] text-ink-3 sm:block">The assistant is an AI and can make mistakes. Check what matters.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The start of a message, as one line. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, 160);
}

/** "07.49, 23 Nov": when a message was written, in the outline. */
function outlineTime(at: number): string {
  const d = new Date(at);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}.${two(d.getMinutes())}, ${d.getDate()} ${months[d.getMonth()]}`;
}

/** What the app kept from a message: under the message it was taken out of. */
function KeptList({ kept }: { kept: Kept[] }) {
  return (
    <ul className="mt-1.5 flex flex-col items-end gap-1" data-testid="kept">
      {kept.map((k, i) => (
        <li
          key={`${k.kind}-${k.name}-${i}`}
          className={cn("max-w-[85%] rounded-xl border px-3 py-1.5 text-xs", k.ok ? "border-ok/30 bg-ok/10 text-ink-2" : "border-warn/30 bg-warn/10 text-ink-2")}
        >
          <p className={cn("flex flex-wrap items-center gap-1.5 font-medium", k.ok ? "text-ok" : "text-warn")}>
            <Icon name={k.ok ? KIND_ICON[k.kind] : "warning"} size={13} />
            {k.ok ? `${KIND_LABEL[k.kind]} kept${k.updated ? " again" : ""}: ${k.name}` : `${KIND_LABEL[k.kind]} not kept`}
            <span className="break-all font-normal text-ink-3">· {k.where}</span>
          </p>
          <p className="mt-0.5 break-words">{k.note}</p>
        </li>
      ))}
    </ul>
  );
}

/** What the assistant did with its tools for an answer. */
function Tools({ tools, live = false }: { tools: ToolNote[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = tools.filter((t) => t.isError).length;
  const shown = open || live;
  return (
    <div className="mb-2 text-xs text-ink-3" data-testid="tools">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 font-medium text-ink-2 transition hover:bg-ink/[0.06] hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={shown}
      >
        <Icon name="tool" size={13} />
        {live ? "Working" : open ? "Hide" : "Show"} · {count(tools.length, "step")} with tools{failed > 0 ? `, ${failed} failed` : ""}
      </button>
      {shown && (
        <ol className="mt-1.5 space-y-1.5">
          {tools.map((t, i) => (
            <li key={i} className={cn("rounded-lg border px-2.5 py-1.5", t.isError ? "border-warn/30 bg-warn/5" : "border-line bg-surface-2/50")}>
              <p className="break-words text-ink-2">
                <span className="font-medium">{TOOL_LABEL[t.name] ?? t.name}</span>
                {t.summary && <span className="mono"> · {t.summary}</span>}
                {t.isError && <span className="text-warn"> · failed</span>}
              </p>
              {t.result && <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug">{t.result}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Under an answer: what was looked up, what was remembered, how it ended. */
function Footnote({ details }: { details: MessageDetails }) {
  const remembered = details.remembered;
  const parts: string[] = [];
  if (remembered && remembered.notes + remembered.passages > 0) {
    parts.push(
      `From memory: ${[remembered.notes > 0 ? count(remembered.notes, "note") : "", remembered.passages > 0 ? `${count(remembered.passages, "passage")} of other conversations` : ""]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (details.model) parts.push(details.model);
  if (details.stopped === "cancelled") parts.push("stopped before it was finished");
  if (details.stopped === "time") parts.push("ended after half an hour of work, the longest one answer may take");
  if (details.stopped === "max_steps") parts.push("ended at the most steps one answer may take");
  if (details.stopped === "tokens") parts.push("ended because the tokens of the account are used up");
  if (details.stopped === "length") parts.push("cut off at the length limit of the model: write “go on” for the rest");
  return (
    <>
      {(details.sources || details.knowledgeError) && <Sources sources={details.sources ?? []} error={details.knowledgeError ?? null} />}
      {parts.length > 0 && (
        <p className="mt-2 text-xs text-ink-3" data-testid="footnote">
          {parts.join(" · ")}
        </p>
      )}
      {details.error && <p className="mt-2 text-xs text-warn">The answer was not finished: {details.error}</p>}
    </>
  );
}

/** What was looked up in the knowledge base for an answer. */
function Sources({ sources, error }: { sources: SourceNote[]; error: string | null }) {
  const [open, setOpen] = useState(false);
  if (error) {
    return <p className="mt-2 text-xs text-warn">The knowledge base was not searched: {error}</p>;
  }
  if (sources.length === 0) {
    return <p className="mt-2 text-xs text-ink-3">Nothing in the chosen collections matched this question.</p>;
  }
  return (
    <div className="mt-2 text-xs text-ink-3">
      <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide" : "Show"} the {sources.length} {sources.length === 1 ? "passage that was" : "passages that were"} looked up
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1.5">
          {sources.map((s) => (
            <li key={s.n} className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-1.5">
              <p className="text-ink-2">
                <span className="mono text-ink-3">[{s.n}]</span> {s.documentTitle}
                <span className="text-ink-3"> · {s.collectionName}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{s.excerpt}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Under an answer: take it along. */
function Actions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-1 text-ink-3">
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition hover:bg-ink/[0.06] hover:text-ink"
        aria-label="Copy the answer"
        title="Copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(content)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => undefined);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
        {copied && <span>Copied</span>}
      </button>
    </div>
  );
}

function Bubble({ role, content, streaming }: { role: "user" | "assistant"; content: string; streaming?: boolean }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-bubble px-4 py-2.5 text-[16px] leading-relaxed text-ink">{content}</div>
      </div>
    );
  }
  // An answer is a text to read: no box around it, set as a document.
  return (
    <div className="min-w-0" data-role="assistant">
      {content ? (
        <Markdown source={content} className="prose-chat break-words" />
      ) : streaming ? (
        <span className="inline-flex items-center gap-2 text-ink-3">
          <span className="inline-block h-2.5 w-2.5 animate-pulse-soft rounded-full bg-signal" />
        </span>
      ) : null}
      {streaming && content && <span className="ml-0.5 inline-block h-2.5 w-2.5 animate-pulse-soft rounded-full bg-signal align-middle" />}
    </div>
  );
}
