import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { CAPABILITIES } from "@/lib/capabilities";
import { MEDIA_API_SETTINGS } from "@/lib/adapters/media-protocol";
import { TASK_KINDS } from "@/lib/creative/prompt";
import { SERVER_ACCESS, SERVER_COMMAND_STATES } from "@/lib/ssh/rules";

export { CAPABILITIES } from "@/lib/capabilities";
export type { Capability } from "@/lib/capabilities";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

// ─── Identity ────────────────────────────────────────────────────────────────

export const users = sqliteTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    email: text("email").notNull(), // stored normalized (lowercase, trimmed)
    passwordHash: text("password_hash").notNull(),
    // owner: an administrator who also manages the accounts (src/lib/roles.ts).
    role: text("role", { enum: ["owner", "admin", "user"] })
      .notNull()
      .default("user"),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // Encrypted TOTP secret (null until a setup flow is confirmed).
    twoFactorSecret: text("two_factor_secret"),
    twoFactorConfirmedAt: integer("two_factor_confirmed_at", {
      mode: "timestamp_ms",
    }),
    // The tokens of the account (v1.8, src/lib/token-rules.ts): how many it
    // may use in all, which an owner sets, and how many it has used. The
    // count only grows; an owner is not held to the limit.
    tokenLimit: integer("token_limit").notNull().default(10_000_000),
    tokensUsed: integer("tokens_used").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    usernameUnique: uniqueIndex("users_username_unique").on(t.username),
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    // Primary key is the SHA-256 hash of the opaque token held in the cookie.
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // When true, the password step passed but the 2FA challenge has not yet
    // been satisfied — the session is NOT fully authenticated.
    twoFactorPending: integer("two_factor_pending", { mode: "boolean" })
      .notNull()
      .default(false),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    byUser: index("sessions_user_idx").on(t.userId),
  }),
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => ({
    byUser: index("recovery_codes_user_idx").on(t.userId),
  }),
);

// ─── Providers & credentials ──────────────────────────────────────────────────

export const providers = sqliteTable(
  "providers",
  {
    id: id(),
    name: text("name").notNull(),
    adapter: text("adapter", {
      enum: ["openai-compatible", "anthropic", "gemini", "custom-http"],
    }).notNull(),
    baseUrl: text("base_url").notNull(),
    authType: text("auth_type", { enum: ["bearer", "header", "none"] })
      .notNull()
      .default("bearer"),
    authHeaderName: text("auth_header_name"), // for authType = 'header'
    apiVersion: text("api_version"),
    // Which image/video wire format the provider speaks (v1.4). 'auto' decides
    // from the Base URL host. Only the openai-compatible adapter uses it.
    mediaApi: text("media_api", { enum: MEDIA_API_SETTINGS }).notNull().default("auto"),
    timeoutMs: integer("timeout_ms").notNull().default(60_000),
    // JSON object of safe, allowlisted static headers.
    extraHeaders: text("extra_headers"),
    // JSON: how the custom-http adapter writes requests and reads responses
    // (v1.5). See src/lib/adapters/custom-http-protocol.ts.
    config: text("config"),
    status: text("status", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("enabled"),
    priority: integer("priority").notNull().default(100),
    notes: text("notes"),
    lastTestedAt: integer("last_tested_at", { mode: "timestamp_ms" }),
    lastTestStatus: text("last_test_status", { enum: ["ok", "error"] }),
    lastTestError: text("last_test_error"), // sanitized
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byStatus: index("providers_status_idx").on(t.status),
  }),
);

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("default"),
    // AES-256-GCM ciphertext (base64: iv|tag|ciphertext). Never leaves the server.
    ciphertext: text("ciphertext").notNull(),
    last4: text("last4").notNull().default(""),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    byProvider: index("provider_credentials_provider_idx").on(t.providerId),
  }),
);

// ─── Models & capabilities ────────────────────────────────────────────────────

export const models = sqliteTable(
  "models",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(), // upstream id, e.g. "gpt-4o-mini"
    displayName: text("display_name"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    contextWindow: integer("context_window"),
    inputPricePerMTok: real("input_price_per_mtok"),
    outputPricePerMTok: real("output_price_per_mtok"),
    // Media price metadata (v1.4): per generated image, per second of video.
    pricePerImage: real("price_per_image"),
    pricePerSecond: real("price_per_second"),
    // Speech price metadata (v1.5): per one million characters of input text.
    pricePerMChars: real("price_per_mchars"),
    source: text("source", { enum: ["discovered", "manual"] })
      .notNull()
      .default("manual"),
    lastTestedAt: integer("last_tested_at", { mode: "timestamp_ms" }),
    lastTestStatus: text("last_test_status", { enum: ["ok", "error"] }),
    lastTestError: text("last_test_error"),
    // Checks failed in a row (v1.8): 0 when the last one passed. Decides how soon a failing model is asked again.
    checkFailures: integer("check_failures").notNull().default(0),
    // What real work says about the model (v1.10): requests that failed in a
    // row because of the provider, 0 when the last one was answered. Three
    // put the model away as a failed check does (model-health-rules.ts).
    useFailures: integer("use_failures").notNull().default(0),
    // Not before this time is the model chosen by the app or asked by the
    // check (v1.10): it said "not now", and until when where it said so.
    retryAt: integer("retry_at", { mode: "timestamp_ms" }),
    // Marked for the work of users (v1.8): a user does not choose a model, the
    // app does, among the marked ones when there are any (model-choice.ts).
    forUsers: integer("for_users", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    providerModelUnique: uniqueIndex("models_provider_model_unique").on(
      t.providerId,
      t.modelId,
    ),
  }),
);

export const modelCapabilities = sqliteTable(
  "model_capabilities",
  {
    id: id(),
    modelRowId: text("model_row_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    capability: text("capability", { enum: CAPABILITIES }).notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    modelCapUnique: uniqueIndex("model_capabilities_unique").on(
      t.modelRowId,
      t.capability,
    ),
  }),
);

// ─── Chat ─────────────────────────────────────────────────────────────────────

export const chats = sqliteTable(
  "chats",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    modelRowId: text("model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    systemPrompt: text("system_prompt"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byUser: index("chats_user_idx").on(t.userId),
  }),
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    createdAt: createdAt(),
  },
  (t) => ({
    byChat: index("chat_messages_chat_idx").on(t.chatId),
  }),
);

// ─── Usage & audit ──────────────────────────────────────────────────────────

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").references(() => providers.id, {
      onDelete: "set null",
    }),
    modelRowId: text("model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    kind: text("kind", {
      enum: ["chat", "test", "embedding", "image", "video", "speech", "other"],
    })
      .notNull()
      .default("chat"),
    // The API key the request came in with (v1.5), for per-key quotas.
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    estimatedCost: real("estimated_cost"),
    costIsEstimated: integer("cost_is_estimated", { mode: "boolean" })
      .notNull()
      .default(true),
    status: text("status", { enum: ["ok", "error"] })
      .notNull()
      .default("ok"),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => ({
    byUser: index("usage_user_idx").on(t.userId),
    byCreated: index("usage_created_idx").on(t.createdAt),
    byApiKey: index("usage_api_key_idx").on(t.apiKeyId, t.createdAt),
  }),
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: text("metadata"), // JSON, never contains secrets
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => ({
    byCreated: index("audit_created_idx").on(t.createdAt),
    byActor: index("audit_actor_idx").on(t.actorUserId),
  }),
);

// ─── AI Workforce (v1.1.0) ────────────────────────────────────────────────────

export const agents = sqliteTable(
  "agents",
  {
    id: id(),
    name: text("name").notNull(),
    role: text("role").notNull(), // free-text role label, e.g. "Backend Engineer"
    instructions: text("instructions").notNull().default(""),
    primaryModelRowId: text("primary_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    fallbackModelRowId: text("fallback_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    // Model routing (v1.3): 'manual' uses primary/fallback; 'auto' lets the
    // router pick the cheapest enabled model (optionally matching a capability).
    routingMode: text("routing_mode", { enum: ["manual", "auto"] }).notNull().default("manual"),
    requiredCapability: text("required_capability", { enum: CAPABILITIES }),
    temperature: real("temperature").notNull().default(0.7),
    // Tools (v1.5): JSON array of tool names the agent may call while it works
    // on a task. Empty means the agent answers in one pass, as before.
    tools: text("tools").notNull().default("[]"),
    // Most model calls one task may take when the agent uses tools.
    maxSteps: integer("max_steps").notNull().default(12),
    // Memory (v1.5): notes the agent saved are recalled in later tasks.
    memoryEnabled: integer("memory_enabled", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byStatus: index("agents_status_idx").on(t.status) }),
);

export const teams = sqliteTable("teams", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const teamAgents = sqliteTable(
  "team_agents",
  {
    id: id(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => ({ unique: uniqueIndex("team_agents_unique").on(t.teamId, t.agentId) }),
);

export const PROJECT_STATES = [
  "draft",
  // Waiting for the background worker to start the run (v1.5).
  "queued",
  "planning",
  "running",
  "review",
  "needs_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status", { enum: PROJECT_STATES }).notNull().default("draft"),
    managerModelRowId: text("manager_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    finalDeliverable: text("final_deliverable"),
    reviewNotes: text("review_notes"),
    error: text("error"),
    // Limits (v1.3). A project has no token budget since v1.8.1: a run is held
    // to the tokens of its account (token-rules.ts). The column of the budget
    // stays, unread, so that the table is not rebuilt for it.
    maxTokens: integer("max_tokens").notNull().default(200_000),
    maxTasks: integer("max_tasks").notNull().default(12),
    maxParallel: integer("max_parallel").notNull().default(3),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Approval policy (v1.3)
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    // Hard QA gate: block 'succeeded' unless the reviewer verdict is pass.
    hardQaGate: integer("hard_qa_gate", { mode: "boolean" }).notNull().default(false),
    // Optional reusable workflow to run instead of AI-Manager planning.
    workflowId: text("workflow_id"),
    // Creative workflows (v1.4): the models that image / video tasks generate
    // with. Null means that kind of task is not available in this project.
    imageModelRowId: text("image_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    videoModelRowId: text("video_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    // Most images + videos one run may generate.
    maxMedia: integer("max_media").notNull().default(10),
    // Voice-over tasks (v1.5) generate with this model.
    speechModelRowId: text("speech_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    // Remember earlier runs (v1.5): the results of the last runs are given to
    // the next one, so a scheduled project does not repeat itself.
    memory: integer("memory", { mode: "boolean" }).notNull().default(false),
    // Whether a run goes on with another model that works when the models it
    // is set to do not answer (v1.10, model-choice.ts). Null: as the
    // installation is set (MODEL_STAND_INS, on unless switched off).
    standIns: integer("stand_ins", { mode: "boolean" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => ({ byCreator: index("projects_creator_idx").on(t.createdBy) }),
);

export const TASK_STATES = [
  "queued",
  "ready",
  "running",
  "blocked",
  "review",
  "succeeded",
  "failed",
  "cancelled",
  "needs_approval",
] as const;

export { TASK_KINDS };

export const projectTasks = sqliteTable(
  "project_tasks",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    acceptanceCriteria: text("acceptance_criteria"),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status", { enum: TASK_STATES }).notNull().default("queued"),
    // What the task delivers (v1.4): written text, or a generated image / video
    // whose prompt the agent writes.
    kind: text("kind", { enum: TASK_KINDS }).notNull().default("text"),
    mediaOptions: text("media_options"), // JSON: { aspectRatio, durationSeconds, resolution, size, … }
    // Workspace path the artifact is saved to (v1.5: kept on the task so that
    // a run can be resumed after a restart).
    outputFile: text("output_file"),
    // Model calls and tool calls the task took (v1.5).
    steps: integer("steps").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    dependsOn: text("depends_on"), // JSON array of task seq numbers
    artifact: text("artifact"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byProject: index("project_tasks_project_idx").on(t.projectId) }),
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => projectTasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms"),
    steps: integer("steps"),
    toolCallCount: integer("tool_call_count"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => ({ byProject: index("agent_runs_project_idx").on(t.projectId) }),
);

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  // JSON array of steps: { seq, title, objective, acceptanceCriteria, role, dependsOn, outputFile, kind, media }
  steps: text("steps").notNull().default("[]"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const gitRemotes = sqliteTable(
  "git_remotes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    host: text("host").notNull().default("api.github.com"),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull().default("main"),
    tokenCiphertext: text("token_ciphertext").notNull(),
    last4: text("last4").notNull().default(""),
    lastPushAt: integer("last_push_at", { mode: "timestamp_ms" }),
    lastPushSha: text("last_push_sha"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ projectUnique: uniqueIndex("git_remotes_project_unique").on(t.projectId) }),
);

// ─── Workspaces & execution (v1.2.0) ─────────────────────────────────────────

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: id(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("workspace"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byProject: uniqueIndex("workspaces_project_unique").on(t.projectId) }),
);

export const workspaceFiles = sqliteTable(
  "workspace_files",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(), // relative, validated (no traversal)
    content: text("content").notNull().default(""),
    size: integer("size").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ pathUnique: uniqueIndex("workspace_files_path_unique").on(t.workspaceId, t.path) }),
);

export const workspaceSnapshots = sqliteTable(
  "workspace_snapshots",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    message: text("message").notNull().default(""),
    files: text("files").notNull(), // JSON: [{ path, content }]
    fileCount: integer("file_count").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => ({ byWorkspace: index("workspace_snapshots_workspace_idx").on(t.workspaceId) }),
);

export const execRuns = sqliteTable(
  "exec_runs",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    status: text("status", { enum: ["ok", "error", "blocked", "disabled"] }).notNull(),
    exitCode: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    durationMs: integer("duration_ms"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => ({ byWorkspace: index("exec_runs_workspace_idx").on(t.workspaceId) }),
);

// ─── Creative media (v1.4.0) ──────────────────────────────────────────────────

/**
 * A generated image, video or voice-over. The bytes live on disk under the media folder
 * (see src/lib/media/store.ts); this row holds the metadata and the file name.
 * A video is created `pending` and becomes `ready` once the provider's job has
 * finished and the file has been downloaded.
 */
export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // Set when a project run produced the asset. Deleting the project or
    // re-running it keeps the asset in the owner's library.
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => projectTasks.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["image", "video", "audio"] }).notNull(),
    // Where the file comes from (v1.5): a provider's model, this server's own
    // ffmpeg (a video joined from clips), or an upload.
    source: text("source", { enum: ["provider", "render", "upload"] })
      .notNull()
      .default("provider"),
    status: text("status", { enum: ["pending", "ready", "failed"] })
      .notNull()
      .default("pending"),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    modelLabel: text("model_label").notNull().default(""), // kept after the model is deleted
    prompt: text("prompt").notNull(),
    params: text("params"), // JSON: what was requested (aspect ratio, duration, …)
    providerJobId: text("provider_job_id"), // video: the provider's job id while pending
    // The API key the media was requested with (v1.5), so that a video's cost
    // counts against that key when it is finished.
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    fileName: text("file_name"), // "<id>.<ext>" inside the media folder
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    durationSeconds: real("duration_seconds"),
    error: text("error"), // sanitized
    estimatedCost: real("estimated_cost"),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    byUser: index("media_assets_user_idx").on(t.userId, t.createdAt),
    byProject: index("media_assets_project_idx").on(t.projectId),
  }),
);

// ─── Background work (v1.5.0) ────────────────────────────────────────────────

export const RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "review",
  "needs_approval",
  "failed",
  "cancelled",
] as const;

/**
 * One run of a project. Runs are executed by the background worker, so they
 * continue without a page open and are picked up again after a restart. The
 * project's own `status` always mirrors its latest run.
 */
export const projectRuns = sqliteTable(
  "project_runs",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", { enum: RUN_STATES }).notNull().default("queued"),
    trigger: text("trigger", { enum: ["manual", "schedule", "api"] })
      .notNull()
      .default("manual"),
    scheduleId: text("schedule_id"),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    // Extra instruction for this run only (from the API or a schedule).
    input: text("input"),
    deliverable: text("deliverable"),
    reviewNotes: text("review_notes"),
    error: text("error"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    // The server process executing the run, and when it last said so.
    workerId: text("worker_id"),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    // Times the run was picked up again after a restart.
    resumes: integer("resumes").notNull().default(0),
    // The run goes on with the tasks of the run before it (v1.9): the tasks
    // that had succeeded are kept, the others are done again.
    continued: integer("continued", { mode: "boolean" }).notNull().default(false),
    // What the tasks it kept had used before it. `tokensUsed` is what the run
    // used itself: the project's tasks together, without this.
    tokensBefore: integer("tokens_before").notNull().default(0),
    createdAt: createdAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    byProject: index("project_runs_project_idx").on(t.projectId, t.createdAt),
    byStatus: index("project_runs_status_idx").on(t.status),
  }),
);

/** Runs a project on a cron schedule, in a time zone. */
export const schedules = sqliteTable(
  "schedules",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(), // five fields: minute hour day-of-month month day-of-week
    timezone: text("timezone").notNull().default("UTC"), // IANA name
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    input: text("input"), // extra instruction given to every run it starts
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastRunId: text("last_run_id"),
    lastStatus: text("last_status", { enum: ["started", "skipped", "error"] }),
    lastError: text("last_error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    byProject: index("schedules_project_idx").on(t.projectId),
    byDue: index("schedules_due_idx").on(t.enabled, t.nextRunAt),
  }),
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["run", "media", "schedule", "knowledge", "system"] }).notNull(),
    level: text("level", { enum: ["info", "success", "warning", "error"] })
      .notNull()
      .default("info"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"), // a path inside the dashboard
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    // Delivery to the user's webhook, when one is set.
    webhookStatus: text("webhook_status", { enum: ["none", "pending", "sent", "failed"] })
      .notNull()
      .default("none"),
    webhookAttempts: integer("webhook_attempts").notNull().default(0),
    webhookNextAt: integer("webhook_next_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => ({
    byUser: index("notifications_user_idx").on(t.userId, t.createdAt),
    byWebhook: index("notifications_webhook_idx").on(t.webhookStatus),
  }),
);

/** Where a user's notifications are also sent. One per user. */
export const notificationWebhooks = sqliteTable(
  "notification_webhooks",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Signs each delivery (HMAC-SHA256). Encrypted at rest.
    secretCiphertext: text("secret_ciphertext").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastStatus: text("last_status", { enum: ["ok", "error"] }),
    lastError: text("last_error"),
    lastDeliveredAt: integer("last_delivered_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ userUnique: uniqueIndex("notification_webhooks_user_unique").on(t.userId) }),
);

/** Work the background worker does outside a project run. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    kind: text("kind", { enum: ["render", "embed"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    payload: text("payload").notNull().default("{}"), // JSON
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: integer("run_after", { mode: "timestamp_ms" }),
    workerId: text("worker_id"),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => ({ byStatus: index("jobs_status_idx").on(t.status, t.runAfter) }),
);

// ─── Agent tools (v1.5.0) ────────────────────────────────────────────────────

/** One tool call an agent made while working on a task. */
export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => projectTasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    step: integer("step").notNull().default(0),
    name: text("name").notNull(),
    arguments: text("arguments"), // JSON, shortened
    result: text("result"), // shortened
    isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => ({ byTask: index("tool_calls_task_idx").on(t.taskId) }),
);

// ─── Knowledge base and agent memory (v1.5.0) ────────────────────────────────

export const knowledgeCollections = sqliteTable(
  "knowledge_collections",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    // 'shared' collections can be read by every user and attached to agents.
    visibility: text("visibility", { enum: ["private", "shared"] })
      .notNull()
      .default("private"),
    // Optional: also search by meaning, with this embedding model.
    embeddingModelRowId: text("embedding_model_row_id").references(() => models.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byCreator: index("knowledge_collections_creator_idx").on(t.createdBy) }),
);

export const knowledgeDocuments = sqliteTable(
  "knowledge_documents",
  {
    id: id(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: text("source_type", { enum: ["upload", "text", "url"] }).notNull(),
    sourceName: text("source_name"), // file name or address
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    charCount: integer("char_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    // Embeddings are computed in the background after the text is indexed.
    embeddingStatus: text("embedding_status", { enum: ["none", "pending", "ready", "failed"] })
      .notNull()
      .default("none"),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byCollection: index("knowledge_documents_collection_idx").on(t.collectionId) }),
);

/**
 * A passage of a document. `knowledge_chunks_fts` (an FTS5 table created in
 * the migration, kept in step by triggers) indexes `content` by this row's id.
 */
export const knowledgeChunks = sqliteTable(
  "knowledge_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    content: text("content").notNull(),
    // Float32 vector, when the collection has an embedding model.
    embedding: blob("embedding", { mode: "buffer" }),
    embeddingModelRowId: text("embedding_model_row_id"),
  },
  (t) => ({
    byCollection: index("knowledge_chunks_collection_idx").on(t.collectionId),
    byDocument: index("knowledge_chunks_document_idx").on(t.documentId, t.seq),
  }),
);

export const agentKnowledge = sqliteTable(
  "agent_knowledge",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => knowledgeCollections.id, { onDelete: "cascade" }),
  },
  (t) => ({ unique: uniqueIndex("agent_knowledge_unique").on(t.agentId, t.collectionId) }),
);

/**
 * A note an agent keeps across tasks and projects. `agent_memories_fts`
 * indexes `content` by this row's id.
 */
export const agentMemories = sqliteTable(
  "agent_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    source: text("source", { enum: ["agent", "manual"] }).notNull().default("agent"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => ({ byAgent: index("agent_memories_agent_idx").on(t.agentId, t.createdAt) }),
);

// ─── Public API (v1.5.0) ─────────────────────────────────────────────────────

/** A key for /api/v1. Only its SHA-256 hash is stored. */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(), // the first characters, for telling keys apart
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").notNull().default("[]"), // JSON array
    // JSON array of model row ids the key may use; null means every model.
    modelRowIds: text("model_row_ids"),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    monthlyTokenLimit: integer("monthly_token_limit"),
    monthlyCostLimit: real("monthly_cost_limit"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => ({
    hashUnique: uniqueIndex("api_keys_hash_unique").on(t.keyHash),
    byUser: index("api_keys_user_idx").on(t.userId),
  }),
);

// ─── Skills (v1.7.0) ─────────────────────────────────────────────────────────

/**
 * A way of working, written down: what a SKILL.md says. Agents and teams are
 * given skills; an agent reads them with each task it works on.
 */
export const skills = sqliteTable(
  "skills",
  {
    id: id(),
    name: text("name").notNull(),
    // The name in lower case: two skills cannot differ by case only.
    nameKey: text("name_key").notNull(),
    description: text("description").notNull().default(""),
    // The body of SKILL.md, without its front matter.
    instructions: text("instructions").notNull().default(""),
    // Other front matter (license, version, ...), as a JSON object of strings.
    metadata: text("metadata").notNull().default("{}"),
    // The file it was uploaded as, when it was.
    sourceName: text("source_name"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ nameUnique: uniqueIndex("skills_name_unique").on(t.nameKey) }),
);

/** A text file that came with a skill: a reference, a template, a script to read. */
export const skillFiles = sqliteTable(
  "skill_files",
  {
    id: id(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
  },
  (t) => ({ unique: uniqueIndex("skill_files_unique").on(t.skillId, t.path) }),
);

export const agentSkills = sqliteTable(
  "agent_skills",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => ({
    unique: uniqueIndex("agent_skills_unique").on(t.agentId, t.skillId),
    bySkill: index("agent_skills_skill_idx").on(t.skillId),
  }),
);

/** A skill of a team: every agent has it while it works in a project of the team. */
export const teamSkills = sqliteTable(
  "team_skills",
  {
    id: id(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => ({
    unique: uniqueIndex("team_skills_unique").on(t.teamId, t.skillId),
    bySkill: index("team_skills_skill_idx").on(t.skillId),
  }),
);

// ─── Servers over SSH (v1.8.0) ───────────────────────────────────────────────

/**
 * A machine agents may work on over SSH. An owner registers it; a project
 * names the ones it works on; an agent that has the tool run_on_server runs
 * commands there, over one connection that stays open until the run has
 * ended (src/lib/ssh).
 */
export const servers = sqliteTable(
  "servers",
  {
    id: id(),
    // How a project and an agent name it: lower-case letters, digits, ".", "_", "-".
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    authType: text("auth_type", { enum: ["password", "key"] }).notNull(),
    // AES-256-GCM ciphertext of the password, or of the private key. Never leaves the server.
    secretCiphertext: text("secret_ciphertext").notNull(),
    // The same of the private key's passphrase, when it has one.
    passphraseCiphertext: text("passphrase_ciphertext"),
    // The host key the machine showed when an owner accepted it ("ssh-ed25519 AAAA…").
    // A machine that shows another key is not signed in to.
    hostKey: text("host_key").notNull(),
    access: text("access", { enum: SERVER_ACCESS }).notNull().default("owners"),
    status: text("status", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("enabled"),
    // What the owner says about it: agents are told (the system it runs, what it is for).
    notes: text("notes"),
    lastConnectedAt: integer("last_connected_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byName: uniqueIndex("servers_name_unique").on(t.name) }),
);

/** The servers a project works on. */
export const projectServers = sqliteTable(
  "project_servers",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
  (t) => ({
    unique: uniqueIndex("project_servers_unique").on(t.projectId, t.serverId),
    byServer: index("project_servers_server_idx").on(t.serverId),
  }),
);

/**
 * What was done on a server: every command an agent ran there and how it
 * ended, and every connection that was opened and closed for a run. A row
 * stays when its project or its server is deleted.
 */
export const serverCommands = sqliteTable(
  "server_commands",
  {
    id: id(),
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    serverName: text("server_name").notNull(),
    // command: an agent's; session: a connection opened, lost or closed; test: an owner's check.
    kind: text("kind", { enum: ["command", "session", "test"] })
      .notNull()
      .default("command"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    projectTitle: text("project_title"),
    runId: text("run_id"),
    // No reference: the tasks of a project are replaced by its next run.
    taskId: text("task_id"),
    taskTitle: text("task_title"),
    agentName: text("agent_name"),
    // The account the work was done for (the project's), or who made the check.
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // The command line. For a session: what happened to the connection.
    command: text("command").notNull(),
    status: text("status", { enum: SERVER_COMMAND_STATES }).notNull(),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    // What it printed, shortened to its end.
    output: text("output"),
    outputBytes: integer("output_bytes").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => ({
    byServer: index("server_commands_server_idx").on(t.serverId, t.createdAt),
    byTask: index("server_commands_task_idx").on(t.taskId),
    byRun: index("server_commands_run_idx").on(t.runId),
    byTime: index("server_commands_time_idx").on(t.createdAt),
  }),
);

/**
 * An account on a web site that agents may sign in with, in the browser
 * they work in (src/lib/browser). An owner saves it; a project names the
 * ones it works with. The app fills in the password; an agent never reads
 * it. The session a sign-in left (the site's cookies) is kept with the
 * account, so that the next run is let in without signing in again.
 */
export const siteAccounts = sqliteTable(
  "site_accounts",
  {
    id: id(),
    // How a project and an agent name it: lower-case letters, digits, ".", "_", "-".
    name: text("name").notNull(),
    // The page where one signs in. The site is its host, with everything under it.
    siteUrl: text("site_url").notNull(),
    username: text("username").notNull(),
    // AES-256-GCM ciphertext of the password. Never leaves the server.
    secretCiphertext: text("secret_ciphertext").notNull(),
    // The same of the site's cookies as the last sign-in left them (JSON).
    sessionCiphertext: text("session_ciphertext"),
    sessionSavedAt: integer("session_saved_at", { mode: "timestamp_ms" }),
    sessionCookies: integer("session_cookies").notNull().default(0),
    access: text("access", { enum: SERVER_ACCESS }).notNull().default("owners"),
    status: text("status", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("enabled"),
    // What the owner says about it: agents are told (what it is for, what to leave alone).
    notes: text("notes"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    // What stood in the way of the last sign-in, when something did.
    lastProblem: text("last_problem"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ byName: uniqueIndex("site_accounts_name_unique").on(t.name) }),
);

/** The site accounts a project works with. */
export const projectSiteAccounts = sqliteTable(
  "project_site_accounts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => siteAccounts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    unique: uniqueIndex("project_site_accounts_unique").on(t.projectId, t.accountId),
    byAccount: index("project_site_accounts_account_idx").on(t.accountId),
  }),
);

export const BROWSER_ACTION_STATES = ["ok", "failed", "refused", "waited", "timeout", "cancelled"] as const;

/**
 * What agents did in the browser: every page they opened and everything
 * they clicked, typed and chose, every sign-in, and every time a page was
 * handed to a person. A row stays when its project or its account is
 * deleted. What was typed into a password field is never in it.
 */
export const browserActions = sqliteTable(
  "browser_actions",
  {
    id: id(),
    // open, click, type, select, press, back: an agent's; sign_in; person: a page handed to a person; session: an owner's sign-in by hand.
    kind: text("kind").notNull(),
    accountId: text("account_id").references(() => siteAccounts.id, { onDelete: "set null" }),
    accountName: text("account_name"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    projectTitle: text("project_title"),
    runId: text("run_id"),
    // No reference: the tasks of a project are replaced by its next run.
    taskId: text("task_id"),
    taskTitle: text("task_title"),
    agentName: text("agent_name"),
    // The account the work was done for (the project's), or the owner who signed in by hand.
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    // The address of the page, without what follows "?".
    url: text("url"),
    // What was acted on, and with what: the button, the field and the text.
    detail: text("detail"),
    status: text("status", { enum: BROWSER_ACTION_STATES }).notNull(),
    // What was said about how it ended.
    note: text("note"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => ({
    byTime: index("browser_actions_time_idx").on(t.createdAt),
    byTask: index("browser_actions_task_idx").on(t.taskId),
    byRun: index("browser_actions_run_idx").on(t.runId),
    byAccount: index("browser_actions_account_idx").on(t.accountId, t.createdAt),
  }),
);

// Convenience exported types
export type User = typeof users.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type Model = typeof models.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceFile = typeof workspaceFiles.$inferSelect;
export type ExecRun = typeof execRuns.$inferSelect;
export type WorkspaceSnapshot = typeof workspaceSnapshots.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type GitRemote = typeof gitRemotes.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type ProjectRun = typeof projectRuns.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationWebhook = typeof notificationWebhooks.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type KnowledgeCollection = typeof knowledgeCollections.$inferSelect;
export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillFile = typeof skillFiles.$inferSelect;
export type Server = typeof servers.$inferSelect;
export type ServerCommand = typeof serverCommands.$inferSelect;
export type SiteAccount = typeof siteAccounts.$inferSelect;
export type BrowserAction = typeof browserActions.$inferSelect;

export const _sqlKeepalive = sql``;
