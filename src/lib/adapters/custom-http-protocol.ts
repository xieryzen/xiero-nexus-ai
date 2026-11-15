import { z } from "zod";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import type { ChatMessage, ChatRequest, ChatResult, ListedModel } from "./types";

/**
 * The custom HTTP adapter: chat with a JSON API that follows none of the known
 * protocols. The provider's configuration says how a request is written and
 * where the answer is in the response. Pure, so it can be unit-tested; the I/O
 * lives in ./custom-http.ts.
 *
 *   {
 *     "chat": {
 *       "path": "/api/chat",
 *       "body": { "model": "{{model}}", "messages": "{{messages}}", "stream": false },
 *       "responsePath": "message.content",
 *       "promptTokensPath": "prompt_eval_count",
 *       "completionTokensPath": "eval_count"
 *     },
 *     "models": { "path": "/api/tags", "listPath": "models", "idPath": "name" }
 *   }
 *
 * Placeholders in `body` (and `{{model}}` in `path`):
 *
 *   {{model}}              the model id
 *   {{messages}}           the conversation as [{ "role", "content" }], system first
 *   {{chat_messages}}      the same without the system message
 *   {{system}}             the system prompt, or ""
 *   {{prompt}}             the whole conversation as one text
 *   {{last_user_message}}  the newest user message
 *   {{temperature}}        the temperature, when the request sets one
 *   {{max_tokens}}         the answer limit, when the request sets one
 *
 * A value that is exactly one placeholder gets the value in its own type (a
 * list, a number); a key whose placeholder has no value is left out. Inside a
 * longer text a placeholder is replaced by its text. The answer is sent whole:
 * such an API is not streamed, and tools are not passed on.
 */

const PATH = z
  .string()
  .max(300)
  .refine((p) => p === "" || p.startsWith("/"), "A path must start with /")
  .refine((p) => !/\s/.test(p), "A path must not contain spaces");

/** Where a value is in a JSON document: "choices[0].message.content". */
const JSON_PATH = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_$\-.[\]]+$/, "Use a path such as choices[0].message.content");

const chatSchema = z.object({
  path: PATH.default(""),
  method: z.enum(["POST", "PUT"]).default("POST"),
  body: z.record(z.unknown()),
  responsePath: JSON_PATH,
  promptTokensPath: JSON_PATH.optional(),
  completionTokensPath: JSON_PATH.optional(),
  /** Where an error message is when the API answers 200 with an error inside. */
  errorPath: JSON_PATH.optional(),
});

const modelsSchema = z.object({
  path: PATH,
  /** Where the list is; leave out when the response itself is the list. */
  listPath: JSON_PATH.optional(),
  /** Where the id is in an item; leave out when the items are the ids. */
  idPath: JSON_PATH.optional(),
});

export const customHttpConfigSchema = z.object({
  chat: chatSchema,
  models: modelsSchema.optional(),
  /** A path that answers a GET when the service is up, for the connection test. */
  healthPath: PATH.optional(),
});

export type CustomHttpConfig = z.infer<typeof customHttpConfigSchema>;

export const MAX_CUSTOM_CONFIG_CHARS = 8000;

/** What a new custom HTTP provider starts from: Ollama's own chat API. */
export const CUSTOM_HTTP_EXAMPLE: CustomHttpConfig = {
  chat: {
    path: "/api/chat",
    method: "POST",
    body: {
      model: "{{model}}",
      messages: "{{messages}}",
      stream: false,
      options: { temperature: "{{temperature}}" },
    },
    responsePath: "message.content",
    promptTokensPath: "prompt_eval_count",
    completionTokensPath: "eval_count",
    errorPath: "error",
  },
  models: { path: "/api/tags", listPath: "models", idPath: "name" },
};

/** Read and check a provider's configuration. Throws a 400 that says what is wrong. */
export function parseCustomHttpConfig(raw: string | null | undefined): CustomHttpConfig {
  if (!raw || !raw.trim()) {
    throw Errors.badRequest(
      "This provider has no configuration yet. Edit it and describe the request and the response.",
    );
  }
  if (raw.length > MAX_CUSTOM_CONFIG_CHARS) {
    throw Errors.badRequest(`The configuration is longer than ${MAX_CUSTOM_CONFIG_CHARS} characters`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Errors.badRequest("The configuration is not valid JSON");
  }
  const parsed = customHttpConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".");
    throw Errors.badRequest(
      `Configuration: ${where ? `${where}: ` : ""}${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

// ─── Templates ───────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

/** Messages as plain role/content pairs: such APIs know nothing about tools. */
function plainMessages(messages: ChatMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "user", content: `Tool result${m.name ? ` (${m.name})` : ""}:\n${m.content}` });
    } else if (m.content.trim()) {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** The conversation as one text, for APIs that take a single prompt. */
export function flattenPrompt(messages: ChatMessage[]): string {
  const visible = messages.filter((m) => m.content.trim());
  // A lone user message needs no labels.
  if (visible.length === 1 && visible[0]!.role === "user") return visible[0]!.content;
  return (
    visible.map((m) => `${ROLE_LABEL[m.role]}: ${m.content}`).join("\n\n") + "\n\nAssistant:"
  );
}

export type TemplateVars = Record<string, unknown>;

export function templateVars(req: ChatRequest): TemplateVars {
  const plain = plainMessages(req.messages);
  const system = req.messages
    .filter((m) => m.role === "system" && m.content.trim())
    .map((m) => m.content.trim())
    .join("\n\n");
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  return {
    model: req.model,
    messages: plain,
    chat_messages: plain.filter((m) => m.role !== "system"),
    system,
    prompt: flattenPrompt(req.messages),
    last_user_message: lastUser?.content ?? "",
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
}

const WHOLE = /^\{\{\s*([a-z_]+)\s*\}\}$/;
const INLINE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const DROP = Symbol("drop");

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function render(node: unknown, vars: TemplateVars): unknown {
  if (typeof node === "string") {
    const whole = node.match(WHOLE);
    if (whole) {
      const name = whole[1]!;
      if (!(name in vars)) return node; // not a placeholder of ours: keep the text
      const value = vars[name];
      return value === undefined || value === null ? DROP : value;
    }
    return node.replace(INLINE, (match, name: string) => (name in vars ? asText(vars[name]) : match));
  }
  if (Array.isArray(node)) {
    return node.map((item) => render(item, vars)).filter((item) => item !== DROP);
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const rendered = render(value, vars);
      if (rendered === DROP) continue;
      // An object that lost all its keys to missing values is left out too.
      if (
        typeof rendered === "object" &&
        rendered !== null &&
        !Array.isArray(rendered) &&
        Object.keys(rendered).length === 0 &&
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length > 0
      ) {
        continue;
      }
      out[key] = rendered;
    }
    return out;
  }
  return node;
}

/** Fill a body template. */
export function renderTemplate(template: Record<string, unknown>, vars: TemplateVars): Record<string, unknown> {
  return render(template, vars) as Record<string, unknown>;
}

/** Fill `{{model}}` in a path, keeping the slashes of an id such as "@cf/meta/llama". */
export function renderPath(path: string, model: string): string {
  return path.replace(/\{\{\s*model\s*\}\}/g, () => model.split("/").map(encodeURIComponent).join("/"));
}

// ─── Responses ───────────────────────────────────────────────────────────────

/** The value at a path such as `choices[0].message.content`, or undefined. */
export function getPath(doc: unknown, path: string): unknown {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((k) => k !== "");
  let current: unknown = doc;
  for (const key of keys) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function tokenCount(doc: unknown, path: string | undefined): number | undefined {
  if (!path) return undefined;
  const value = getPath(doc, path);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface CustomWireRequest {
  path: string;
  method: "POST" | "PUT";
  body: Record<string, unknown>;
}

export function buildChatRequest(config: CustomHttpConfig, req: ChatRequest): CustomWireRequest {
  return {
    path: renderPath(config.chat.path, req.model),
    method: config.chat.method,
    body: renderTemplate(config.chat.body, templateVars(req)),
  };
}

export function parseChatResponse(config: CustomHttpConfig, json: unknown): ChatResult {
  const value = getPath(json, config.chat.responsePath);
  let content: string | null = null;
  if (typeof value === "string") content = value;
  else if (typeof value === "number") content = String(value);
  else if (Array.isArray(value) && value.every((v) => typeof v === "string")) content = value.join("");

  if (content === null) {
    const error = config.chat.errorPath ? getPath(json, config.chat.errorPath) : undefined;
    if (error !== undefined && error !== null && error !== "") {
      throw new AppError(502, "upstream_error", `Provider error: ${sanitizeUpstreamError(asText(error))}`);
    }
    throw new AppError(
      502,
      "upstream_error",
      `The response has no text at "${config.chat.responsePath}". Check the response path in the provider's configuration.`,
    );
  }
  const promptTokens = tokenCount(json, config.chat.promptTokensPath);
  const completionTokens = tokenCount(json, config.chat.completionTokensPath);
  return {
    content,
    usage:
      promptTokens === undefined && completionTokens === undefined
        ? undefined
        : {
            promptTokens,
            completionTokens,
            totalTokens:
              promptTokens !== undefined && completionTokens !== undefined
                ? promptTokens + completionTokens
                : undefined,
          },
  };
}

export function parseModelList(config: CustomHttpConfig, json: unknown): ListedModel[] {
  const settings = config.models;
  if (!settings) return [];
  const list = settings.listPath ? getPath(json, settings.listPath) : json;
  if (!Array.isArray(list)) {
    throw new AppError(
      502,
      "upstream_error",
      "The model list is not where the provider's configuration says it is",
    );
  }
  const ids = new Set<string>();
  for (const item of list) {
    const id = settings.idPath ? getPath(item, settings.idPath) : item;
    if (typeof id === "string" && id && id.length <= 200) ids.add(id);
  }
  return [...ids].map((id) => ({ id }));
}
