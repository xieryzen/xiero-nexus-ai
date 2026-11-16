/**
 * Providers a new provider can start from: the name, the address and how it
 * signs in, so that adding one is choosing it and pasting a key. Pure.
 *
 * What a provider gives away changes by the month. The words here are what
 * each said of itself when this list was read (PRESETS_READ_ON), from two
 * lists that track it:
 *   https://github.com/mvalentsev/awesome-free-ai-coding (probed twice a week)
 *   https://github.com/mnfst/awesome-free-llm-apis
 * The form says the date, and to check the provider's own site.
 */

export type PresetGroup = "keyless" | "free-key" | "paid";

export interface ProviderPreset {
  id: string;
  name: string;
  group: PresetGroup;
  adapter: "openai-compatible" | "anthropic" | "gemini";
  baseUrl: string;
  authType: "bearer" | "none";
  /** Where a key is made, when the provider takes one. */
  keyUrl?: string;
  /** What it gives without paying, in a few words. */
  free: string;
  /** What to know before using it. */
  note?: string;
}

export const PRESETS_READ_ON = "2026-11-15";

export const PRESET_GROUP_LABELS: Record<PresetGroup, string> = {
  keyless: "No key needed",
  "free-key": "A free key (sign up)",
  paid: "Paid",
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "kilo",
    name: "Kilo Gateway",
    group: "keyless",
    adapter: "openai-compatible",
    baseUrl: "https://api.kilo.ai/api/gateway",
    authType: "none",
    keyUrl: "https://app.kilo.ai/profile",
    free: "Its free models answer without a key, up to an hourly limit for one address.",
    note: "With the key of a free account, choose Bearer token: the same address then allows more. Free models may log what is sent.",
  },
  {
    id: "ovhcloud",
    name: "OVHcloud AI Endpoints",
    group: "keyless",
    adapter: "openai-compatible",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    authType: "none",
    free: "Open models without a key: 2 requests a minute for each model from one address.",
    note: "A key here is a billed one of an OVHcloud project; without one, leave the auth type at None.",
  },
  {
    id: "llm7",
    name: "LLM7",
    group: "keyless",
    adapter: "openai-compatible",
    baseUrl: "https://api.llm7.io/v1",
    authType: "none",
    keyUrl: "https://dash.llm7.io",
    free: "A few models without a key, with a small allowance for a day; a free token allows more.",
    note: "With a free token, choose Bearer token. Most models it lists need its paid plan.",
  },
  {
    id: "pollinations",
    name: "Pollinations",
    group: "keyless",
    adapter: "openai-compatible",
    baseUrl: "https://text.pollinations.ai/openai",
    authType: "none",
    free: "One chat model on its old open API, one request at a time.",
    note: "Its newer API takes a key and is billed.",
  },
  {
    id: "groq",
    name: "Groq",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authType: "bearer",
    keyUrl: "https://console.groq.com/keys",
    free: "A free plan without a card: a number of requests a day for each model.",
  },
  {
    id: "mistral",
    name: "Mistral",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authType: "bearer",
    keyUrl: "https://console.mistral.ai/api-keys",
    free: "A free mode without a card, with a monthly allowance it does not publish.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authType: "bearer",
    keyUrl: "https://openrouter.ai/settings/keys",
    free: "The models marked :free: 50 requests a day without credits.",
    note: "Free models may log what is sent.",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authType: "bearer",
    keyUrl: "https://build.nvidia.com",
    free: "Free endpoints for the models its site marks so, for trial use.",
    note: "Trial use only: nothing personal or confidential.",
  },
  {
    id: "github-models",
    name: "GitHub Models",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://models.github.ai/inference",
    authType: "bearer",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    free: "Free with a GitHub account, with low daily limits.",
    note: "The key is a personal access token that may read Models.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    authType: "bearer",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    free: "A free allowance each day.",
    note: "Put your account's ID in the address in place of ACCOUNT_ID.",
  },
  {
    id: "cohere",
    name: "Cohere",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    authType: "bearer",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    free: "Trial keys without a card.",
    note: "A trial key is not for commercial use.",
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    group: "free-key",
    adapter: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    authType: "bearer",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    free: "Its GLM Flash models are free on the API.",
  },
  {
    id: "google-ai-studio",
    name: "Google AI Studio",
    group: "free-key",
    adapter: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authType: "bearer",
    keyUrl: "https://aistudio.google.com/apikey",
    free: "A free tier for some Gemini models, each with its own daily limit.",
  },
  {
    id: "openai",
    name: "OpenAI",
    group: "paid",
    adapter: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    keyUrl: "https://platform.openai.com/api-keys",
    free: "",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    group: "paid",
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authType: "bearer",
    keyUrl: "https://console.anthropic.com/settings/keys",
    free: "",
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
