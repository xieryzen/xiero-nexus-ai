import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
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
    role: text("role", { enum: ["admin", "user"] })
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
    source: text("source", { enum: ["discovered", "manual"] })
      .notNull()
      .default("manual"),
    lastTestedAt: integer("last_tested_at", { mode: "timestamp_ms" }),
    lastTestStatus: text("last_test_status", { enum: ["ok", "error"] }),
    lastTestError: text("last_test_error"),
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
    kind: text("kind", { enum: ["chat", "test", "embedding", "image", "video", "other"] })
      .notNull()
      .default("chat"),
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
    // Budget & limits (v1.3)
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
    mediaOptions: text("media_options"), // JSON: { aspectRatio, durationSeconds, resolution, size }
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
 * A generated image or video. The bytes live on disk under the media folder
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
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    status: text("status", { enum: ["pending", "ready", "failed"] })
      .notNull()
      .default("pending"),
    providerId: text("provider_id").references(() => providers.id, { onDelete: "set null" }),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    modelLabel: text("model_label").notNull().default(""), // kept after the model is deleted
    prompt: text("prompt").notNull(),
    params: text("params"), // JSON: what was requested (aspect ratio, duration, …)
    providerJobId: text("provider_job_id"), // video: the provider's job id while pending
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

export const _sqlKeepalive = sql``;
