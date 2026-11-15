/**
 * Limits and names that both the server's validation and the forms use. Kept
 * apart from validation.ts so that a form does not have to load the
 * validation library to know a number.
 */

/** Most tasks a project run, and most steps a workflow, can have. */
export const MAX_PROJECT_TASKS = 40;

/** What an API key can be allowed to use. */
export const API_SCOPES = ["chat", "embeddings", "media", "projects"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
