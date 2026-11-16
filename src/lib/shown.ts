import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { AppError, isPlainError } from "./errors";
import { NOT_NOW, namesPattern, publicText } from "./public-text";
import { seesSetup } from "./roles";

/**
 * What someone is shown, by their role. Someone who is shown the setup
 * (roles.ts) gets every text as it is. Anyone else gets a text that names a
 * provider or a model of this installation, or speaks of them, replaced by a
 * sentence that says only that it did not work (public-text.ts).
 */

/** The pattern, and what the two tables looked like when it was made. */
interface Kept {
  signature: string;
  pattern: RegExp | null;
}
const store = globalThis as typeof globalThis & { __xnShownNames?: Kept };

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** How many providers and models there are and when one was last changed: it differs after one is added, renamed or removed. */
function signature(): string {
  const p = db
    .select({ n: sql<number>`count(*)`, at: sql<number | null>`max(${providers.updatedAt})` })
    .from(providers)
    .get();
  const m = db
    .select({ n: sql<number>`count(*)`, at: sql<number | null>`max(${models.updatedAt})` })
    .from(models)
    .get();
  return `${p?.n ?? 0}:${p?.at ?? 0}:${m?.n ?? 0}:${m?.at ?? 0}`;
}

/**
 * A pattern that finds the names of this installation's providers and models
 * in a text: what they are called, their ids, and where the providers are.
 * Made again when a provider or a model was added, changed or removed.
 */
export function setupNames(): RegExp | null {
  const now = signature();
  const kept = store.__xnShownNames;
  if (kept && kept.signature === now) return kept.pattern;
  const names: (string | null)[] = [];
  for (const p of db.select({ name: providers.name, baseUrl: providers.baseUrl }).from(providers).all()) {
    names.push(p.name, hostOf(p.baseUrl));
  }
  for (const m of db.select({ modelId: models.modelId, displayName: models.displayName }).from(models).all()) {
    names.push(m.modelId, m.displayName);
  }
  // "auto" is what a request sends that leaves the choice to the app: it is
  // said to everyone, also when a model goes by that name.
  const pattern = namesPattern(names, ["auto"]);
  store.__xnShownNames = { signature: now, pattern };
  return pattern;
}

/** Read the names again at the next question. */
export function forgetSetupNames(): void {
  store.__xnShownNames = undefined;
}

/** A text as someone with this role is shown it. Null stays null. */
export function textFor(
  role: string | null | undefined,
  text: string | null | undefined,
  instead: string = NOT_NOW,
): string | null {
  if (seesSetup(role)) return text ?? null;
  return publicText(text, setupNames(), instead);
}

/** An error as someone with this role is told it: the same status and code, and what they may read of the message. */
export function errorFor(role: string | null | undefined, err: AppError): AppError {
  if (seesSetup(role) || isPlainError(err)) return err;
  // Below 500 the app speaks of the request itself; from 500 on the message
  // can hold what a provider answered, and is looked through whole.
  const message = publicText(err.message, setupNames(), NOT_NOW, err.status < 500) ?? NOT_NOW;
  return message === err.message ? err : new AppError(err.status, err.code, message);
}
