import { z } from "zod";
import {
  ASPECT_RATIO_PATTERN,
  MAX_IMAGES_PER_REQUEST,
  MAX_MEDIA_PROMPT_CHARS,
  MAX_VIDEO_SECONDS,
  MEDIA_API_SETTINGS,
  RESOLUTION_PATTERN,
  SIZE_PATTERN,
} from "@/lib/adapters/media-protocol";
import { MAX_CUSTOM_CONFIG_CHARS } from "@/lib/adapters/custom-http-protocol";
import { SPEECH_FORMATS } from "@/lib/adapters/types";
import { MAX_MAX_STEPS, MIN_MAX_STEPS, TOOL_NAMES } from "@/lib/agent/catalog";
import { CAPABILITIES } from "@/lib/capabilities";
import {
  MAX_MEDIA_PER_RUN,
  MAX_SPEECH_CHARS,
  MAX_SPEECH_SPEED,
  MIN_SPEECH_SPEED,
  TASK_KINDS,
  VOICE_PATTERN,
} from "@/lib/creative/prompt";
import { API_SCOPES, MAX_PROJECT_TASKS } from "@/lib/limits";
import { MAX_RENDER_CLIPS, MAX_STILL_SECONDS } from "@/lib/media/render-plan";

export { API_SCOPES, MAX_PROJECT_TASKS, type ApiScope } from "@/lib/limits";


export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "Username may only contain letters, numbers, and . _ -",
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .max(254);

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password is too long");

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  // Accepts either a username or an email in one field.
  identifier: z.string().trim().min(1, "Enter your username or email"),
  password: z.string().min(1, "Enter your password"),
});

export const totpTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/, "Enter a valid recovery code");

const safeHeaderName = /^[A-Za-z0-9-]{1,64}$/;

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  adapter: z.enum(["openai-compatible", "anthropic", "gemini", "custom-http"]),
  baseUrl: z.string().trim().url().max(500),
  authType: z.enum(["bearer", "header", "none"]).default("bearer"),
  authHeaderName: z
    .string()
    .trim()
    .regex(safeHeaderName, "Invalid header name")
    .optional(),
  apiVersion: z.string().trim().max(40).optional(),
  // Image / video request style (openai-compatible adapter only).
  mediaApi: z.enum(MEDIA_API_SETTINGS).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  extraHeaders: z
    .record(z.string().regex(safeHeaderName), z.string().max(500))
    .optional(),
  priority: z.number().int().min(1).max(1000).default(100),
  notes: z.string().trim().max(1000).optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
  // How to talk to the API, as JSON (custom-http adapter only). Checked by the
  // adapter's own parser when the provider is saved.
  config: z.string().trim().max(MAX_CUSTOM_CONFIG_CHARS).nullable().optional(),
});

export const providerUpdateSchema = providerCreateSchema
  .partial()
  .extend({ status: z.enum(["enabled", "disabled"]).optional() });

export const modelCreateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(120).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  inputPricePerMTok: z.number().nonnegative().max(100_000).optional(),
  outputPricePerMTok: z.number().nonnegative().max(100_000).optional(),
  pricePerImage: z.number().nonnegative().max(100_000).optional(),
  pricePerSecond: z.number().nonnegative().max(100_000).optional(),
  pricePerMChars: z.number().nonnegative().max(100_000).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const modelUpdateSchema = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(100_000_000).nullable().optional(),
  inputPricePerMTok: z.number().nonnegative().max(100_000).nullable().optional(),
  outputPricePerMTok: z.number().nonnegative().max(100_000).nullable().optional(),
  pricePerImage: z.number().nonnegative().max(100_000).nullable().optional(),
  pricePerSecond: z.number().nonnegative().max(100_000).nullable().optional(),
  pricePerMChars: z.number().nonnegative().max(100_000).nullable().optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const chatRequestSchema = z.object({
  modelRowId: z.string().min(1),
  systemPrompt: z.string().max(8000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(32_000),
      }),
    )
    .min(1)
    .max(100),
  temperature: z.number().min(0).max(2).optional(),
  // Knowledge collections to look the question up in before answering (v1.5).
  collectionIds: z.array(z.string().min(1)).max(10).optional(),
});

// ─── AI Workforce (v1.1.0) ────────────────────────────────────────────────────

export const agentCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(80),
  instructions: z.string().max(8000).optional().default(""),
  primaryModelRowId: z.string().min(1).nullable().optional(),
  fallbackModelRowId: z.string().min(1).nullable().optional(),
  routingMode: z.enum(["manual", "auto"]).optional(),
  requiredCapability: z.enum(CAPABILITIES).nullable().optional(),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  // Tools the agent may call while it works on a task (v1.5).
  tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).optional(),
  // Most model calls one task may take, the final answer included.
  maxSteps: z.number().int().min(MIN_MAX_STEPS).max(MAX_MAX_STEPS).optional(),
  // Keep notes between tasks and projects.
  memoryEnabled: z.boolean().optional(),
  // Shared knowledge collections the agent can search.
  collectionIds: z.array(z.string().min(1)).max(20).optional(),
});

export const agentUpdateSchema = agentCreateSchema
  .partial()
  .extend({ status: z.enum(["active", "disabled"]).optional() });

export const teamCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  agentIds: z.array(z.string().min(1)).max(50).optional().default([]),
});

export const teamUpdateSchema = teamCreateSchema.partial();

export const projectCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
  managerModelRowId: z.string().min(1),
  teamId: z.string().min(1).nullable().optional(),
  maxTokens: z.number().int().min(1000).max(5_000_000).optional(),
  maxTasks: z.number().int().min(1).max(MAX_PROJECT_TASKS).optional(),
  maxParallel: z.number().int().min(1).max(8).optional(),
  requiresApproval: z.boolean().optional(),
  hardQaGate: z.boolean().optional(),
  workflowId: z.string().min(1).nullable().optional(),
  // Creative workflows: the models image, video and voice-over tasks generate with.
  imageModelRowId: z.string().min(1).nullable().optional(),
  videoModelRowId: z.string().min(1).nullable().optional(),
  speechModelRowId: z.string().min(1).nullable().optional(),
  maxMedia: z.number().int().min(0).max(MAX_MEDIA_PER_RUN).optional(),
  // Give each run what the earlier runs delivered (v1.5).
  memory: z.boolean().optional(),
});

export const projectUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    goal: z.string().trim().min(1).max(8000).optional(),
    memory: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

const runInputSchema = z.string().trim().max(4000);

/** The body of a run request. It may be empty. */
export const runStartSchema = z.object({ input: runInputSchema.optional() });

export const scheduleCreateSchema = z.object({
  cron: z.string().trim().min(9, "Enter five fields, such as: 0 8 * * *").max(120),
  timezone: z.string().trim().min(1).max(64),
  input: runInputSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const scheduleUpdateSchema = scheduleCreateSchema.partial();

// ─── Creative media (v1.4.0) ──────────────────────────────────────────────────

const aspectRatioSchema = z.string().trim().regex(ASPECT_RATIO_PATTERN, "Use a ratio such as 9:16");
const resolutionSchema = z.string().trim().regex(RESOLUTION_PATTERN, "Use a value such as 720p or 2K");
const sizeSchema = z.string().trim().regex(SIZE_PATTERN, "Use WIDTHxHEIGHT, such as 1024x1536");
const durationSchema = z.number().int().min(1).max(MAX_VIDEO_SECONDS);

const voiceSchema = z.string().trim().regex(VOICE_PATTERN, "Use the voice's name, such as alloy");
const speedSchema = z.number().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED);

/** Options of a creative step or request. */
export const mediaOptionsSchema = z.object({
  aspectRatio: aspectRatioSchema.optional(),
  durationSeconds: durationSchema.optional(),
  resolution: resolutionSchema.optional(),
  size: sizeSchema.optional(),
  voice: voiceSchema.optional(),
  speed: speedSchema.optional(),
  // A video step: the number of the image step whose picture it starts from.
  imageFrom: z.number().int().min(1).max(MAX_PROJECT_TASKS).optional(),
  subtitles: z.boolean().optional(),
  keepClipAudio: z.boolean().optional(),
  fit: z.enum(["contain", "cover"]).optional(),
});

/** Provider-specific parameters: a small, flat-ish JSON object. */
const mediaExtraSchema = z
  .record(z.string().min(1).max(64), z.unknown())
  .refine((v) => Object.keys(v).length <= 20, "At most 20 extra parameters")
  .refine((v) => JSON.stringify(v).length <= 4000, "Extra parameters are too large");

const mediaPromptSchema = z
  .string()
  .trim()
  .min(1, "Enter a prompt")
  .max(MAX_MEDIA_PROMPT_CHARS, `A prompt can be at most ${MAX_MEDIA_PROMPT_CHARS} characters`);

export const imageGenerateSchema = z.object({
  modelRowId: z.string().min(1),
  prompt: mediaPromptSchema,
  n: z.number().int().min(1).max(MAX_IMAGES_PER_REQUEST).optional(),
  aspectRatio: aspectRatioSchema.optional(),
  resolution: resolutionSchema.optional(),
  size: sizeSchema.optional(),
  extra: mediaExtraSchema.optional(),
});

export const videoGenerateSchema = z.object({
  modelRowId: z.string().min(1),
  prompt: mediaPromptSchema,
  durationSeconds: durationSchema.optional(),
  aspectRatio: aspectRatioSchema.optional(),
  resolution: resolutionSchema.optional(),
  size: sizeSchema.optional(),
  // An image from the library that the video starts from (image-to-video).
  imageAssetId: z.string().uuid().optional(),
  extra: mediaExtraSchema.optional(),
});

export const speechGenerateSchema = z.object({
  modelRowId: z.string().min(1),
  text: z
    .string()
    .trim()
    .min(1, "Enter the text to speak")
    .max(MAX_SPEECH_CHARS, `One request can speak at most ${MAX_SPEECH_CHARS} characters`),
  voice: voiceSchema.optional(),
  format: z.enum(SPEECH_FORMATS).optional(),
  speed: speedSchema.optional(),
  instructions: z.string().trim().max(1000).optional(),
});

/** Joining clips into one video on this server. */
export const renderCreateSchema = z.object({
  clipIds: z.array(z.string().uuid()).min(1, "Choose at least one clip").max(MAX_RENDER_CLIPS),
  narrationIds: z.array(z.string().uuid()).max(MAX_RENDER_CLIPS).optional(),
  aspectRatio: aspectRatioSchema.optional(),
  fit: z.enum(["contain", "cover"]).optional(),
  subtitles: z.boolean().optional(),
  keepClipAudio: z.boolean().optional(),
  stillSeconds: z.number().min(1).max(MAX_STILL_SECONDS).optional(),
  title: z.string().trim().max(200).optional(),
});

const workflowStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.string().max(2000).optional().default(""),
  role: z.string().trim().min(1).max(80),
  dependsOn: z.array(z.number().int()).max(20).optional().default([]),
  outputFile: z.string().trim().max(256).optional(),
  // What the step delivers. A creative step's agent writes the prompt.
  kind: z.enum(TASK_KINDS).optional(),
  media: mediaOptionsSchema.optional(),
});

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  steps: z.array(workflowStepSchema).max(MAX_PROJECT_TASKS).optional().default([]),
});

export const workflowUpdateSchema = workflowCreateSchema.partial();

export const gitRemoteSchema = z.object({
  host: z.string().trim().max(200).optional(),
  owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "Invalid owner"),
  repo: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "Invalid repo"),
  branch: z.string().trim().min(1).max(100).optional(),
  token: z.string().trim().min(1).max(500),
});

// ─── Knowledge base (v1.5.0) ──────────────────────────────────────────────────

export const collectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["private", "shared"]).optional(),
  embeddingModelRowId: z.string().min(1).nullable().optional(),
});

export const collectionUpdateSchema = collectionCreateSchema.partial();

/** A document typed or pasted in, or fetched from a link. */
export const documentCreateSchema = z.union([
  z.object({
    title: z.string().trim().min(1).max(200),
    text: z.string().min(1, "Enter some text").max(2_000_000),
  }),
  z.object({
    title: z.string().trim().max(200).optional(),
    url: z.string().trim().url().max(2000),
  }),
]);

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  collectionIds: z.array(z.string().min(1)).min(1).max(20),
  limit: z.number().int().min(1).max(20).optional(),
});

export const memoryCreateSchema = z.object({ content: z.string().trim().min(1).max(1000) });

// ─── Notifications, webhooks and API keys (v1.5.0) ────────────────────────────

export const webhookSaveSchema = z.object({
  url: z.string().trim().url().max(500),
  enabled: z.boolean().optional(),
});

export const notificationsReadSchema = z.object({ id: z.string().min(1).optional() });

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Choose what the key may do").max(API_SCOPES.length),
  // Models the key may use. Left out: every model the user may use.
  modelRowIds: z.array(z.string().min(1)).max(200).nullable().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(6000).nullable().optional(),
  monthlyTokenLimit: z.number().int().min(1).max(1_000_000_000_000).nullable().optional(),
  monthlyCostLimit: z.number().positive().max(1_000_000_000).nullable().optional(),
  // Days until the key stops working. Left out: it does not expire.
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ModelCreate = z.infer<typeof modelCreateSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
