import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { runtime } from "./runtime";

/**
 * Values that belong to the request being handled and are needed far from
 * where the request is read. So far there is one: the API key a request to
 * the public API came in with, which usage is recorded under.
 */

interface RequestContext {
  apiKeyId: string | null;
}

function storage(): AsyncLocalStorage<RequestContext> {
  const rt = runtime();
  rt.requestContext ??= new AsyncLocalStorage<RequestContext>();
  return rt.requestContext as AsyncLocalStorage<RequestContext>;
}

/** Handle a request that came in with this API key. */
export function withApiKey<T>(apiKeyId: string, work: () => T): T {
  return storage().run({ apiKeyId }, work);
}

/** The API key of the request being handled, or null. */
export function currentApiKeyId(): string | null {
  return storage().getStore()?.apiKeyId ?? null;
}
