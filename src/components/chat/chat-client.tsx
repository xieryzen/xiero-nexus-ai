"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";
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

/** A passage of the knowledge base that was put in front of the model. */
interface Source {
  n: number;
  documentTitle: string;
  collectionName: string;
  excerpt: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  /** Assistant: what was looked up for this answer. Empty when nothing matched. */
  sources?: Source[];
  /** Assistant: why nothing could be looked up. */
  knowledgeError?: string | null;
}

export function ChatClient({
  models,
  collections,
  chooses = true,
  ready = true,
}: {
  /** The models to choose from. Empty for someone who chooses none. */
  models: ChatModelOption[];
  /** Knowledge collections the user can read. */
  collections: ChatCollectionOption[];
  /** Whether the model is chosen here. For a user it is not: the app chooses. */
  chooses?: boolean;
  /** For someone who chooses no model: whether the installation can answer a chat. */
  ready?: boolean;
}) {
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft]);

  async function send() {
    const text = input.trim();
    if (!text || streaming || (chooses && !modelId)) return;
    setError(null);
    setUsage(null);
    const nextMessages: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setStreaming(true);
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          modelRowId: chooses ? modelId : undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          // Only what was said: the sources of earlier answers are not sent back.
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
          collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let streamError: string | null = null;
      let sources: Source[] | undefined;
      let knowledgeError: string | null = null;

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
          try {
            const evt = JSON.parse(payload) as {
              delta?: string;
              done?: boolean;
              error?: string;
              usage?: { promptTokens: number; completionTokens: number };
              sources?: Source[];
              knowledgeError?: string | null;
            };
            if (Array.isArray(evt.sources)) {
              sources = evt.sources;
              knowledgeError = evt.knowledgeError ?? null;
            } else if (evt.delta) {
              acc += evt.delta;
              setDraft(acc);
            } else if (evt.error) {
              streamError = evt.error;
            } else if (evt.done && evt.usage) {
              setUsage(evt.usage);
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (streamError) {
        setError(streamError);
        // keep the user's message; drop the (empty) assistant turn
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: acc, sources, knowledgeError }]);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setStreaming(false);
      setDraft("");
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clear() {
    if (streaming) return;
    setMessages([]);
    setError(null);
    setUsage(null);
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

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col">
      {/* Controls */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        {chooses && (
          <div className="sm:w-80">
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.providerName}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setShowSystem((s) => !s)}>
            System prompt
          </Button>
          <Button variant="ghost" onClick={() => setShowKnowledge((s) => !s)} aria-expanded={showKnowledge}>
            <Icon name="knowledge" size={16} /> Knowledge{collectionIds.length > 0 ? ` (${collectionIds.length})` : ""}
          </Button>
          <Button variant="ghost" onClick={clear} disabled={streaming || messages.length === 0}>
            Clear
          </Button>
        </div>
      </div>

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
      <div
        ref={scrollRef}
        className="card flex-1 space-y-4 overflow-y-auto p-4"
      >
        {messages.length === 0 && !draft && (
          <div className="flex h-full items-center justify-center text-center text-sm text-ink-3">
            Send a message to start. Responses reflect the selected provider’s own
            policies — Nexus passes them through unmodified.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            <Bubble role={m.role} content={m.content} />
            {m.role === "assistant" && (m.sources || m.knowledgeError) && (
              <Sources sources={m.sources ?? []} error={m.knowledgeError ?? null} />
            )}
          </div>
        ))}
        {streaming && <Bubble role="assistant" content={draft} streaming />}
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
  );
}

/** What was looked up in the knowledge base for an answer. */
function Sources({ sources, error }: { sources: Source[]; error: string | null }) {
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
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2.5 text-sm leading-relaxed",
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
