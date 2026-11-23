"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";
import type { Kept } from "@/lib/access/rules";
import type { MessageDetails, SourceNote, ToolNote } from "@/lib/chat/rules";
import { Alert, Button, EmptyState, Select, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ChatModelOption {
  id: string;
  label: string;
  providerName: string;
}

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

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ChatClient({
  models,
  collections,
  chooses = true,
  ready = true,
  chats: initialChats = [],
  initial = null,
  reach,
}: {
  /** The models to choose from. Empty for someone who chooses none. */
  models: ChatModelOption[];
  /** Knowledge collections the user can read. */
  collections: ChatCollectionOption[];
  /** Whether the model is chosen here. For a user it is not: the app chooses. */
  chooses?: boolean;
  /** For someone who chooses no model: whether the installation can answer a chat. */
  ready?: boolean;
  /** The conversations of the account, the ones written in last first. */
  chats?: ChatListItem[];
  /** The conversation the page was opened with. */
  initial?: { id: string; title: string; systemPrompt: string | null; messages: ChatMessageItem[] } | null;
  reach?: ChatReach;
}) {
  // "" is the app's own choice: the models in turn, the ones that take tools first.
  const [modelId, setModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [showSystem, setShowSystem] = useState(false);
  const [chats, setChats] = useState<ChatListItem[]>(initialChats);
  const [chatId, setChatId] = useState<string | null>(initial?.id ?? null);
  const [messages, setMessages] = useState<ChatMessageItem[]>(initial?.messages ?? []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<{ text: string; link?: string } | null>(null);
  const [liveTools, setLiveTools] = useState<ToolNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showList, setShowList] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft, liveTools, progress]);

  /** The address says which conversation is open, so that a reload opens it again. */
  const address = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("c", id);
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url.toString());
  }, []);

  const reload = useCallback(async (id: string) => {
    const res = await fetch(`/api/chats/${id}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { chat: { title: string; systemPrompt: string | null }; messages: ChatMessageItem[] };
    setMessages(data.messages);
    return true;
  }, []);

  async function open(id: string) {
    if (streaming || id === chatId) {
      setShowList(false);
      return;
    }
    setLoading(true);
    setError(null);
    setUsage(null);
    try {
      const res = await fetch(`/api/chats/${id}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? "The conversation could not be opened");
      setChatId(id);
      setMessages(data.messages as ChatMessageItem[]);
      setSystemPrompt(data.chat?.systemPrompt ?? "");
      address(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The conversation could not be opened");
    } finally {
      setLoading(false);
      setShowList(false);
    }
  }

  function startNew() {
    if (streaming) return;
    setChatId(null);
    setMessages([]);
    setError(null);
    setUsage(null);
    setSystemPrompt("");
    setShowList(false);
    address(null);
  }

  async function remove(item: ChatListItem) {
    if (streaming) return;
    if (!confirm(`Delete the conversation "${item.title}"? What the assistant remembered from it stays on the Memory page.`)) return;
    const res = await fetch(`/api/chats/${item.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "The conversation could not be deleted");
      return;
    }
    setChats((list) => list.filter((c) => c.id !== item.id));
    if (item.id === chatId) startNew();
  }

  async function rename(item: ChatListItem) {
    const title = prompt("Name of the conversation", item.title)?.trim();
    if (!title || title === item.title) return;
    const res = await fetch(`/api/chats/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? "The conversation could not be renamed");
      return;
    }
    setChats((list) => list.map((c) => (c.id === item.id ? { ...c, title: data.chat.title as string } : c)));
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    setUsage(null);
    // Shown at once; replaced by the message as it was kept, without what signs in.
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setStreaming(true);
    setDraft("");
    setLiveTools([]);
    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;
    let current = chatId;
    let finished = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chatId: chatId ?? undefined,
          message: text,
          modelRowId: chooses && modelId ? modelId : undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
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
            const { id, title } = evt.chat;
            current = id;
            setChatId(id);
            address(id);
            setChats((list) => {
              const known = list.find((c) => c.id === id);
              const item: ChatListItem = { id, title, messages: (known?.messages ?? 0) + 1, updatedAt: Date.now() };
              return [item, ...list.filter((c) => c.id !== id)];
            });
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

      if (streamError) {
        setError(streamError);
        // What was done before it failed is in the conversation.
        if (current) await reload(current);
      } else if (!finished && current) {
        await reload(current);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Stopped: what there was of the answer is kept a moment later.
        if (current) {
          const id = current;
          await new Promise((resolve) => setTimeout(resolve, 700));
          await reload(id);
        }
      } else {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setStreaming(false);
      setDraft("");
      setLiveTools([]);
      setProgress(null);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  if (!chooses && !ready) {
    return (
      <EmptyState
        title="Chat is not available yet"
        description="An administrator has to set this installation up."
      />
    );
  }
  if (chooses && models.length === 0) {
    return (
      <EmptyState
        title="No models available"
        description="Enable at least one model on an enabled provider (with an implemented adapter) to start chatting."
      />
    );
  }

  const list = (
    <div className="flex min-h-0 flex-1 flex-col">
      <Button onClick={startNew} disabled={streaming} className="w-full justify-center">
        <Icon name="plus" size={16} /> New conversation
      </Button>
      <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" aria-label="Conversations">
        {chats.length === 0 && <li className="px-2 py-3 text-xs text-ink-3">No conversation yet. What you write is kept here, and the assistant remembers it in the next one.</li>}
        {chats.map((c) => (
          <li key={c.id} className={cn("group flex items-center gap-1 rounded-md", c.id === chatId ? "bg-signal/15" : "hover:bg-surface-2")}>
            <button
              type="button"
              className={cn("min-w-0 flex-1 truncate px-2.5 py-2 text-left text-sm", c.id === chatId ? "text-ink" : "text-ink-2")}
              onClick={() => void open(c.id)}
              title={c.title}
              aria-current={c.id === chatId ? "true" : undefined}
            >
              {c.title}
            </button>
            <button type="button" className="hidden shrink-0 p-1.5 text-ink-3 hover:text-ink group-hover:block" onClick={() => void rename(c)} aria-label={`Rename ${c.title}`}>
              <Icon name="settings" size={14} />
            </button>
            <button type="button" className="hidden shrink-0 p-1.5 text-ink-3 hover:text-danger group-hover:block" onClick={() => void remove(c)} aria-label={`Delete ${c.title}`}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <Link href="/dashboard/memory" className="mt-3 flex items-center gap-2 rounded-md border border-line px-2.5 py-2 text-xs text-ink-2 hover:text-ink">
        <Icon name="memory" size={14} />
        <span>
          Memory{reach ? `: ${count(reach.notes, "note")}, ${count(reach.servers + reach.sites + reach.keys, "access", "accesses")} kept` : ""}
        </span>
      </Link>
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-10rem)] gap-4">
      <aside className="hidden w-64 shrink-0 flex-col lg:flex">{list}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Controls */}
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          {chooses && (
            <div className="sm:w-80">
              <Select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
                <option value="">Automatic · the app chooses, and asks the next model when one fails</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.providerName}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" className="lg:hidden" onClick={() => setShowList((s) => !s)} aria-expanded={showList}>
              <Icon name="history" size={16} /> Conversations
            </Button>
            <Button variant="ghost" onClick={() => setShowSystem((s) => !s)}>
              System prompt
            </Button>
            <Button variant="ghost" onClick={() => setShowKnowledge((s) => !s)} aria-expanded={showKnowledge}>
              <Icon name="knowledge" size={16} /> Knowledge{collectionIds.length > 0 ? ` (${collectionIds.length})` : ""}
            </Button>
            <Button variant="ghost" onClick={startNew} disabled={streaming || (messages.length === 0 && !chatId)}>
              New
            </Button>
          </div>
        </div>

        {showList && <div className="mb-3 flex max-h-72 flex-col rounded-md border border-line bg-surface-2/40 p-3 lg:hidden">{list}</div>}

        {showSystem && (
          <textarea
            className="input mb-3 min-h-[72px] resize-y"
            placeholder="Optional system instructions for this conversation…"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        )}

        {showKnowledge && (
          <div className="mb-3 rounded-md border border-line bg-surface-2/40 p-3">
            {collections.length === 0 ? (
              <p className="text-sm text-ink-3">
                No knowledge collection yet. Add documents on the{" "}
                <Link href="/dashboard/knowledge" className="text-signal hover:underline">
                  Knowledge
                </Link>{" "}
                page, then answers here can be based on them.
              </p>
            ) : (
              <>
                <p className="text-xs text-ink-3">
                  Before each answer, the passages of the ticked collections that fit your question are put in front of
                  the model, and the answer names the ones it used.
                </p>
                <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
                  {collections.map((c) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                        <input
                          type="checkbox"
                          className="accent-current"
                          checked={collectionIds.includes(c.id)}
                          onChange={() =>
                            setCollectionIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id].slice(0, 10)))
                          }
                        />
                        {c.name}
                        <span className="text-xs text-ink-3">
                          {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* Transcript */}
        <div ref={scrollRef} className="card flex-1 space-y-4 overflow-y-auto p-4" data-testid="transcript">
          {loading && (
            <div className="flex h-full items-center justify-center text-ink-3">
              <Spinner />
            </div>
          )}
          {!loading && messages.length === 0 && !draft && !streaming && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-ink-3">
              <p>Send a message to start. The assistant can act, not only answer.</p>
              {reach?.handsOver !== false && (
                <p className="max-w-xl text-xs">
                  Write how to sign in to a server, a web site or an API (address, user name, password or key) in a message and say what to do: the app
                  takes the password out before any model sees it, keeps it encrypted, and the assistant works with it from then on, in every conversation.
                </p>
              )}
              <p className="max-w-xl text-xs">What you tell it is remembered: a new conversation starts with what the earlier ones established.</p>
            </div>
          )}
          {!loading &&
            messages.map((m, i) => (
              <div key={m.id ?? `new-${i}`}>
                {m.role === "assistant" && m.details?.tools && m.details.tools.length > 0 && <Tools tools={m.details.tools} />}
                {(m.content || m.role === "user") && <Bubble role={m.role} content={m.content} />}
                {m.role === "user" && m.details?.kept && m.details.kept.length > 0 && <KeptList kept={m.details.kept} />}
                {m.role === "assistant" && m.details && <Footnote details={m.details} />}
              </div>
            ))}
          {streaming && (
            <div>
              {liveTools.length > 0 && <Tools tools={liveTools} live />}
              <Bubble role="assistant" content={draft} streaming />
              {progress && (
                <p className="mt-1.5 flex max-w-[85%] items-center gap-2 text-xs text-ink-3" data-testid="chat-progress">
                  <Spinner size={12} /> {progress.text}
                  {progress.link && (
                    <Link href={progress.link} target="_blank" className="font-medium text-signal hover:underline">
                      Open the page
                    </Link>
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}

        {usage && (
          <p className="mt-2 text-xs text-ink-3">
            Last response · {formatNumber(usage.promptTokens)} prompt +{" "}
            {formatNumber(usage.completionTokens)} completion tokens
          </p>
        )}

        {/* Composer */}
        <div className="mt-3 flex items-end gap-2">
          <textarea
            className="input max-h-40 min-h-[48px] flex-1 resize-none"
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            disabled={streaming}
          />
          {streaming ? (
            <Button variant="ghost" onClick={stop} className="h-[48px]">
              <Spinner /> Stop
            </Button>
          ) : (
            <Button onClick={send} disabled={!input.trim()} className="h-[48px]">
              <Icon name="send" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the app kept from a message: under the message it was taken out of. */
function KeptList({ kept }: { kept: Kept[] }) {
  return (
    <ul className="mt-1.5 flex flex-col items-end gap-1" data-testid="kept">
      {kept.map((k, i) => (
        <li
          key={`${k.kind}-${k.name}-${i}`}
          className={cn(
            "max-w-[85%] rounded-md border px-3 py-1.5 text-xs",
            k.ok ? "border-ok/30 bg-ok/10 text-ink-2" : "border-warn/30 bg-warn/10 text-ink-2",
          )}
        >
          <p className={cn("flex items-center gap-1.5 font-medium", k.ok ? "text-ok" : "text-warn")}>
            <Icon name={k.ok ? KIND_ICON[k.kind] : "warning"} size={13} />
            {k.ok ? `${KIND_LABEL[k.kind]} kept${k.updated ? " again" : ""}: ${k.name}` : `${KIND_LABEL[k.kind]} not kept`}
            <span className="font-normal text-ink-3">· {k.where}</span>
          </p>
          <p className="mt-0.5">{k.note}</p>
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
    <div className="mb-1.5 max-w-[85%] text-xs text-ink-3" data-testid="tools">
      <button type="button" className="flex items-center gap-1.5 font-medium text-signal hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={shown}>
        <Icon name="tool" size={13} />
        {live ? "Working" : open ? "Hide" : "Show"} · {count(tools.length, "step")} with tools{failed > 0 ? `, ${failed} failed` : ""}
      </button>
      {shown && (
        <ol className="mt-1.5 space-y-1.5">
          {tools.map((t, i) => (
            <li key={i} className={cn("rounded border px-2.5 py-1.5", t.isError ? "border-warn/30 bg-warn/5" : "border-line bg-surface-2/60")}>
              <p className="text-ink-2">
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
  if (details.stopped === "max_steps") parts.push("ended at the most steps one answer may take");
  if (details.stopped === "tokens") parts.push("ended because the tokens of the account are used up");
  return (
    <>
      {(details.sources || details.knowledgeError) && <Sources sources={details.sources ?? []} error={details.knowledgeError ?? null} />}
      {parts.length > 0 && (
        <p className="mt-1.5 max-w-[85%] text-xs text-ink-3" data-testid="footnote">
          {parts.join(" · ")}
        </p>
      )}
      {details.error && <p className="mt-1.5 max-w-[85%] text-xs text-warn">The answer was not finished: {details.error}</p>}
    </>
  );
}

/** What was looked up in the knowledge base for an answer. */
function Sources({ sources, error }: { sources: SourceNote[]; error: string | null }) {
  const [open, setOpen] = useState(false);
  if (error) {
    return <p className="mt-1.5 max-w-[85%] text-xs text-warn">The knowledge base was not searched: {error}</p>;
  }
  if (sources.length === 0) {
    return <p className="mt-1.5 max-w-[85%] text-xs text-ink-3">Nothing in the chosen collections matched this question.</p>;
  }
  return (
    <div className="mt-1.5 max-w-[85%] text-xs text-ink-3">
      <button type="button" className="font-medium text-signal hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide" : "Show"} the {sources.length} {sources.length === 1 ? "passage that was" : "passages that were"} looked up
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1.5">
          {sources.map((s) => (
            <li key={s.n} className="rounded border border-line bg-surface-2/60 px-2.5 py-1.5">
              <p className="text-ink-2">
                <span className="mono text-ink-3">[{s.n}]</span> {s.documentTitle}
                <span className="text-ink-3"> · {s.collectionName}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap">{s.excerpt}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Bubble({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-signal/15 text-ink"
            : "border border-line bg-surface-2 text-ink",
        )}
      >
        {content || (streaming ? <span className="animate-pulse-soft text-ink-3">▍</span> : "")}
        {streaming && content && <span className="animate-pulse-soft">▍</span>}
      </div>
    </div>
  );
}
