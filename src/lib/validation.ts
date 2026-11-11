import { z } from "zod";
import { CAPABILITIES } from "@/lib/capabilities";

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
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  extraHeaders: z
    .record(z.string().regex(safeHeaderName), z.string().max(500))
    .optional(),
  priority: z.number().int().min(1).max(1000).default(100),
  notes: z.string().trim().max(1000).optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
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
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const modelUpdateSchema = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(100_000_000).nullable().optional(),
  inputPricePerMTok: z.number().nonnegative().max(100_000).nullable().optional(),
  outputPricePerMTok: z.number().nonnegative().max(100_000).nullable().optional(),
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
  maxTasks: z.number().int().min(1).max(20).optional(),
  maxParallel: z.number().int().min(1).max(8).optional(),
  requiresApproval: z.boolean().optional(),
  hardQaGate: z.boolean().optional(),
  workflowId: z.string().min(1).nullable().optional(),
});

const workflowStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.string().max(2000).optional().default(""),
  role: z.string().trim().min(1).max(80),
  dependsOn: z.array(z.number().int()).max(20).optional().default([]),
  outputFile: z.string().trim().max(256).optional(),
});

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  steps: z.array(workflowStepSchema).max(20).optional().default([]),
});

export const workflowUpdateSchema = workflowCreateSchema.partial();

export const gitRemoteSchema = z.object({
  host: z.string().trim().max(200).optional(),
  owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "Invalid owner"),
  repo: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "Invalid repo"),
  branch: z.string().trim().min(1).max(100).optional(),
  token: z.string().trim().min(1).max(500),
});

export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ModelCreate = z.infer<typeof modelCreateSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
