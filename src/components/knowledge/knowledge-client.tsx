"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, apiUpload, ApiError } from "@/lib/client";
import { formatBytes, formatNumber } from "@/lib/format";
import { Dotted, RelativeTime } from "@/components/time";
import type { CollectionDTO, DocumentDTO, KnowledgeHit } from "@/lib/knowledge/service";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";

interface ModelOption {
  id: string;
  label: string;
}

const ACCEPT = ".txt,.md,.markdown,.csv,.json,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/csv,application/json,text/html,application/pdf";

const EMBEDDING_LABEL: Record<DocumentDTO["embeddingStatus"], string> = {
  none: "words only",
  pending: "being embedded",
  ready: "embedded",
  failed: "embedding failed",
};

function CollectionForm({
  initial,
  embeddingModels,
  chooses,
  onSaved,
  onCancel,
}: {
  initial?: CollectionDTO;
  /** The embedding models to choose from. For someone who chooses none: one entry ("yes") when the installation has one. */
  embeddingModels: ModelOption[];
  /** Whether the model is chosen here. For a user it is not: the app chooses. */
  chooses: boolean;
  onSaved: (c: CollectionDTO) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [visibility, setVisibility] = useState<"private" | "shared">(initial?.visibility ?? "private");
  const [modelId, setModelId] = useState(initial?.embeddingModelRowId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A model that is no longer offered stays selectable, so saving does not drop it silently.
  const options =
    initial?.embeddingModelRowId && !embeddingModels.some((m) => m.id === initial.embeddingModelRowId)
      ? [
          {
            id: initial.embeddingModelRowId,
            label: chooses ? `${initial.embeddingModelLabel ?? "the current model"} (not available)` : "By meaning as well (cannot be done now)",
          },
          ...embeddingModels,
        ]
      : embeddingModels;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = JSON.stringify({
      name,
      description: description.trim() || null,
      visibility,
      embeddingModelRowId: modelId || null,
    });
    try {
      const res = initial
        ? await apiFetch<{ collection: CollectionDTO }>(`/api/knowledge/${initial.id}`, { method: "PATCH", body })
        : await apiFetch<{ collection: CollectionDTO }>("/api/knowledge", { method: "POST", body });
      onSaved(res.collection);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the collection");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="k-name">
          <Input id="k-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Product handbook" />
        </Field>
        <Field label="Description" htmlFor="k-desc">
          <Input id="k-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="optional" />
        </Field>
        <Field
          label="Who can use it"
          htmlFor="k-vis"
          hint={
            visibility === "shared"
              ? "Everyone on this server can search it, and an administrator can give it to agents."
              : "Only you (and administrators). Agents cannot be given a private collection."
          }
        >
          <Select id="k-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "shared")}>
            <option value="private">Private</option>
            <option value="shared">Shared</option>
          </Select>
        </Field>
        <Field
          label="Search by meaning"
          htmlFor="k-model"
          hint={
            !chooses
              ? embeddingModels.length === 0
                ? "The collection is searched by its words."
                : modelId
                  ? "A question also finds passages that say the same in other words. Reading the documents for that uses some of your tokens."
                  : "The collection is searched by its words."
              : embeddingModels.length === 0
                ? "No embedding model is set up (Models page, type “Embedding model”). The collection is searched by its words, which works without one."
                : modelId
                  ? "Documents are also embedded with this model, so a question finds passages that say the same in other words. Embedding is billed by the provider."
                  : "Without a model the collection is searched by its words."
          }
        >
          <Select id="k-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">{chooses ? "Words only (no model)" : "Words only"}</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {initial && modelId !== (initial.embeddingModelRowId ?? "") && initial.documentCount > 0 && (
        <Alert tone="info">
          {modelId
            ? chooses
              ? "Changing the model embeds every document of this collection again."
              : "Every document of this collection is read again for its meaning."
            : chooses
              ? "Without a model the stored embeddings of this collection are dropped."
              : "What was kept for searching by meaning is dropped."}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {initial ? "Save" : "Create collection"}
        </Button>
      </div>
    </form>
  );
}

export function KnowledgeClient({
  initialCollections,
  embeddingModels,
  initialSelectedId,
  isAdmin,
}: {
  initialCollections: CollectionDTO[];
  embeddingModels: ModelOption[];
  initialSelectedId: string | null;
  isAdmin: boolean;
}) {
  const [collections, setCollections] = useState(initialCollections);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [form, setForm] = useState<"new" | "edit" | null>(initialCollections.length === 0 ? "new" : null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"text" | "link" | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<{ name: string; error?: string }[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const selected = collections.find((c) => c.id === selectedId) ?? null;
  const canManage = selected?.canManage ?? false;

  const loadCollection = useCallback(async (id: string, quiet = false) => {
    try {
      const res = await apiFetch<{ collection: CollectionDTO; documents: DocumentDTO[] }>(`/api/knowledge/${id}`);
      setDocuments(res.documents);
      setCollections((list) => list.map((c) => (c.id === id ? res.collection : c)));
    } catch (err) {
      if (!quiet) setError(err instanceof ApiError ? err.message : "Could not load the collection");
    }
  }, []);

  useEffect(() => {
    setDocuments(null);
    setHits(null);
    setQuery("");
    setAdding(null);
    setUploads([]);
    if (selectedId) void loadCollection(selectedId);
  }, [selectedId, loadCollection]);

  // Embedding happens in the background: look again while any document is waiting for it.
  const waiting = (documents ?? []).some((d) => d.embeddingStatus === "pending");
  useEffect(() => {
    if (!waiting || !selectedId) return;
    const timer = setInterval(() => void loadCollection(selectedId, true), 4000);
    return () => clearInterval(timer);
  }, [waiting, selectedId, loadCollection]);

  function select(id: string) {
    setSelectedId(id);
    setForm(null);
    setError(null);
    // Keeps the choice on reload, and gives the collection an address to link to.
    window.history.replaceState(null, "", `/dashboard/knowledge?collection=${id}`);
  }

  async function upload(files: FileList | File[]) {
    if (!selected) return;
    setError(null);
    for (const file of Array.from(files)) {
      setUploads((list) => [...list, { name: file.name }]);
      try {
        const res = await apiUpload<{ document: DocumentDTO }>(`/api/knowledge/${selected.id}/documents/upload`, file);
        setDocuments((list) => [res.document, ...(list ?? [])]);
        setUploads((list) => list.filter((u) => u.name !== file.name));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "The upload failed";
        setUploads((list) => list.map((u) => (u.name === file.name ? { ...u, error: message } : u)));
      }
    }
    void loadCollection(selected.id, true);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function addDocument(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !adding) return;
    setError(null);
    setBusy("add");
    try {
      const res = await apiFetch<{ document: DocumentDTO }>(`/api/knowledge/${selected.id}/documents`, {
        method: "POST",
        body: JSON.stringify(adding === "text" ? { title, text } : { url, title: title.trim() || undefined }),
      });
      setDocuments((list) => [res.document, ...(list ?? [])]);
      setAdding(null);
      setTitle("");
      setText("");
      setUrl("");
      void loadCollection(selected.id, true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the document");
    } finally {
      setBusy(null);
    }
  }

  async function removeDocument(doc: DocumentDTO) {
    if (!selected || !confirm(`Remove "${doc.title}" from this collection?`)) return;
    setBusy(doc.id);
    try {
      await apiFetch(`/api/knowledge/${selected.id}/documents/${doc.id}`, { method: "DELETE" });
      setDocuments((list) => (list ?? []).filter((d) => d.id !== doc.id));
      void loadCollection(selected.id, true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the document");
    } finally {
      setBusy(null);
    }
  }

  async function retry(doc: DocumentDTO) {
    if (!selected) return;
    setBusy(doc.id);
    try {
      await apiFetch(`/api/knowledge/${selected.id}/documents/${doc.id}/embed`, { method: "POST" });
      setDocuments((list) => (list ?? []).map((d) => (d.id === doc.id ? { ...d, embeddingStatus: "pending", error: null } : d)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start embedding");
    } finally {
      setBusy(null);
    }
  }

  async function removeCollection() {
    if (!selected) return;
    if (!confirm(`Delete the collection "${selected.name}" with its ${selected.documentCount} documents? This cannot be undone.`)) return;
    setBusy("delete");
    try {
      await apiFetch(`/api/knowledge/${selected.id}`, { method: "DELETE" });
      const rest = collections.filter((c) => c.id !== selected.id);
      setCollections(rest);
      setSelectedId(rest[0]?.id ?? null);
      setForm(rest.length === 0 ? "new" : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the collection");
    } finally {
      setBusy(null);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await apiFetch<{ hits: KnowledgeHit[] }>("/api/knowledge/search", {
        method: "POST",
        body: JSON.stringify({ query, collectionIds: [selected.id], limit: 6 }),
      });
      setHits(res.hits);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The search failed");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Knowledge"
        description="Documents that the chat and your agents can look things up in. Upload files, paste text or add a link; answers then name the passages they used."
        actions={
          form !== "new" ? (
            <Button onClick={() => setForm("new")}>
              <Icon name="plus" /> New collection
            </Button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {form === "new" && (
        <div className="mb-6">
          <Card title="New collection">
            <CollectionForm
              embeddingModels={embeddingModels}
              chooses={isAdmin}
              onSaved={(c) => {
                setCollections((list) => [...list, c].sort((a, b) => a.name.localeCompare(b.name)));
                select(c.id);
              }}
              onCancel={() => setForm(null)}
            />
          </Card>
        </div>
      )}

      {collections.length === 0 ? (
        form !== "new" && (
          <EmptyState title="No collection yet" description="A collection holds documents on one subject: a handbook, a product's documentation, your notes." />
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label="Collections">
            <ul className="space-y-1.5">
              {collections.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => select(c.id)}
                    aria-current={c.id === selectedId ? "true" : undefined}
                    className={cn(
                      "w-full rounded-md border px-3 py-2.5 text-left transition",
                      c.id === selectedId ? "border-signal/50 bg-signal/10" : "border-line hover:border-ink-3",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                      <Badge tone={c.visibility === "shared" ? "info" : "neutral"}>{c.visibility}</Badge>
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-3">
                      {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
                      {!c.owner && " · not yours"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {selected && (
            <div className="min-w-0 space-y-6">
              {form === "edit" ? (
                <Card title={`Edit ${selected.name}`}>
                  <CollectionForm
                    key={selected.id}
                    initial={selected}
                    embeddingModels={embeddingModels}
                    chooses={isAdmin}
                    onSaved={(c) => {
                      setCollections((list) => list.map((x) => (x.id === c.id ? c : x)));
                      setForm(null);
                      void loadCollection(c.id, true);
                    }}
                    onCancel={() => setForm(null)}
                  />
                </Card>
              ) : (
                <Card
                  title={selected.name}
                  description={
                    <>
                      {selected.description ? `${selected.description} · ` : ""}
                      {selected.visibility === "shared" ? "Shared with everyone on this server" : "Private"}
                      {" · "}
                      {selected.embeddingModelRowId
                        ? `searched by words and by meaning${selected.embeddingModelLabel ? ` (${selected.embeddingModelLabel})` : ""}`
                        : "searched by its words"}
                    </>
                  }
                  actions={
                    canManage ? (
                      <>
                        <Button variant="ghost" onClick={() => setForm("edit")}>
                          Edit
                        </Button>
                        <Button variant="danger" onClick={removeCollection} loading={busy === "delete"} aria-label="Delete collection">
                          <Icon name="trash" />
                        </Button>
                      </>
                    ) : undefined
                  }
                >
                  <form onSubmit={search} className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field label="Try a question" htmlFor="k-query">
                        <Input id="k-query" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={1000} placeholder="What does this collection say about…" />
                      </Field>
                    </div>
                    <Button type="submit" variant="ghost" loading={searching} disabled={!query.trim()}>
                      <Icon name="search" size={16} /> Search
                    </Button>
                  </form>
                  {hits !== null &&
                    (hits.length === 0 ? (
                      <p className="mt-3 text-sm text-ink-3">Nothing in this collection matches that.</p>
                    ) : (
                      <ol className="mt-3 space-y-2">
                        {hits.map((hit, i) => (
                          <li key={hit.chunkId} className="rounded-md border border-line bg-surface-2/50 p-3">
                            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                              <span className="mono">[{i + 1}]</span>
                              <span className="font-medium text-ink-2">{hit.documentTitle}</span>
                              {hit.matched.map((m) => (
                                <Badge key={m} tone={m === "meaning" ? "signal" : "neutral"}>
                                  {m === "meaning" ? "by meaning" : "by words"}
                                </Badge>
                              ))}
                            </p>
                            <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap break-words text-sm text-ink-2">{hit.content}</p>
                          </li>
                        ))}
                      </ol>
                    ))}
                  <p className="mt-3 text-xs text-ink-3">
                    Use it in <Link href="/dashboard/chat" className="text-signal hover:underline">Chat</Link> (the Knowledge button)
                    {selected.visibility === "shared"
                      ? isAdmin
                        ? ", or give it to an agent on the Agents page."
                        : ", or ask an administrator to give it to an agent."
                      : ". To give it to agents, set it to Shared."}
                  </p>
                </Card>
              )}

              <Card
                title={`Documents${documents ? ` (${documents.length})` : ""}`}
                description="Only the text of a document is kept, cut into passages. Files: text, Markdown, CSV, JSON, HTML, PDF and .docx, up to 15 MB. A scanned PDF has no text to read."
                actions={
                  canManage ? (
                    <>
                      <Button variant="ghost" onClick={() => fileInput.current?.click()}>
                        <Icon name="upload" size={16} /> Upload
                      </Button>
                      <Button variant="ghost" onClick={() => setAdding(adding === "text" ? null : "text")} aria-expanded={adding === "text"}>
                        Paste text
                      </Button>
                      <Button variant="ghost" onClick={() => setAdding(adding === "link" ? null : "link")} aria-expanded={adding === "link"}>
                        <Icon name="link" size={16} /> From a link
                      </Button>
                    </>
                  ) : undefined
                }
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  multiple
                  className="hidden"
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={(e) => {
                    if (e.target.files?.length) void upload(e.target.files);
                  }}
                />

                {adding && (
                  <form onSubmit={addDocument} className="mb-4 space-y-3 rounded-md border border-line bg-surface-2/40 p-4">
                    {adding === "text" ? (
                      <>
                        <Field label="Title" htmlFor="k-doc-title">
                          <Input id="k-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
                        </Field>
                        <Field label="Text" htmlFor="k-doc-text">
                          <Textarea id="k-doc-text" value={text} onChange={(e) => setText(e.target.value)} required className="min-h-[160px]" />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field label="Address" htmlFor="k-doc-url" hint="A public page or file. The server fetches it once, now; it is not kept up to date.">
                          <Input id="k-doc-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/handbook" />
                        </Field>
                        <Field label="Title" htmlFor="k-doc-title" hint="Empty: the page's own title.">
                          <Input id="k-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
                        </Field>
                      </>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
                        Cancel
                      </Button>
                      <Button type="submit" loading={busy === "add"}>
                        Add document
                      </Button>
                    </div>
                  </form>
                )}

                {uploads.length > 0 && (
                  <ul className="mb-3 space-y-1">
                    {uploads.map((u) => (
                      <li key={u.name} className={cn("flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-xs", u.error ? "border-danger/30 bg-danger/10 text-danger" : "border-line text-ink-3")}>
                        <span className="min-w-0 truncate">
                          {u.name}: {u.error ?? "reading…"}
                        </span>
                        {u.error && (
                          <button type="button" onClick={() => setUploads((list) => list.filter((x) => x !== u))} aria-label="Dismiss">
                            <Icon name="x" size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {documents === null ? (
                  <p className="text-sm text-ink-3">Loading…</p>
                ) : documents.length === 0 ? (
                  <p className="text-sm text-ink-3">
                    No document yet.{canManage ? " Upload a file, paste text, or add a link." : ""}
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {documents.map((doc) => (
                      <li key={doc.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">{doc.title}</p>
                          <p className="mt-0.5 text-xs text-ink-3">
                            <Dotted
                              parts={[
                                doc.sourceType === "url" ? "from a link" : doc.sourceType === "upload" ? (doc.sourceName ?? "upload") : "pasted text",
                                `${formatNumber(doc.charCount)} characters`,
                                `${doc.chunkCount} ${doc.chunkCount === 1 ? "passage" : "passages"}`,
                                doc.sizeBytes != null && doc.sourceType !== "text" ? formatBytes(doc.sizeBytes) : null,
                                <RelativeTime key="when" at={doc.createdAt} />,
                              ]}
                            />
                          </p>
                          {doc.embeddingStatus === "failed" && doc.error && (
                            <p className="mt-1 text-xs text-danger">
                              {doc.error} It is still searched by its words.
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone={doc.embeddingStatus === "ready" ? "ok" : doc.embeddingStatus === "failed" ? "danger" : doc.embeddingStatus === "pending" ? "warn" : "neutral"}>
                            {EMBEDDING_LABEL[doc.embeddingStatus]}
                          </Badge>
                          {canManage && doc.embeddingStatus === "failed" && (
                            <Button variant="ghost" onClick={() => retry(doc)} loading={busy === doc.id}>
                              Try again
                            </Button>
                          )}
                          {canManage && (
                            <Button variant="danger" onClick={() => removeDocument(doc)} disabled={busy === doc.id} aria-label={`Remove ${doc.title}`}>
                              <Icon name="trash" />
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
