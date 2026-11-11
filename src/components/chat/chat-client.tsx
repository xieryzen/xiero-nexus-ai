"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";
import { Alert, Button, EmptyState, Select, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ChatModelOption {
  id: string;
  label: string;
  providerName: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function ChatClient({ models }: { models: ChatModelOption[] }) {
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft]);

  async function send() {
    const text = input.trim();
    if (!text || streaming || !modelId) return;
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
          modelRowId: modelId,
          systemPrompt: systemPrompt.trim() || undefined,
          messages: nextMessages,
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
            };
            if (evt.delta) {
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
        setMessages((prev) => [...prev, { role: "assistant", content: acc }]);
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

  if (models.length === 0) {
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
        <div className="sm:w-80">
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label="Model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.providerName}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setShowSystem((s) => !s)}>
            System prompt
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
          <Bubble key={i} role={m.role} content={m.content} />
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
