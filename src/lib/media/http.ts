/**
 * Reading a provider's response body with a size cap and a deadline.
 *
 * `fetch` timeouts in this app end when the response headers arrive, so a body
 * that never finishes, or one far larger than expected, has to be stopped
 * here. No database or framework imports: this is unit-tested as it is.
 */
import { open, rm } from "node:fs/promises";
import { AppError } from "../errors";

export interface BodyLimits {
  maxBytes: number;
  /** Time allowed for the whole body, from the first read. */
  timeoutMs: number;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(
    502,
    "upstream_too_large",
    `The provider's response is larger than the ${megabytes(maxBytes)} limit`,
  );
}

function timedOut(): AppError {
  return new AppError(504, "timeout", "The provider's response took too long to download");
}

/** Reject early when the declared length is already over the limit. */
function checkDeclaredLength(res: Response, maxBytes: number): void {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw tooLarge(maxBytes);
  }
}

/**
 * Feed the body to `onChunk` piece by piece. Stops, and throws, when the body
 * passes `maxBytes` or is not finished within `timeoutMs`.
 */
async function pump(
  res: Response,
  limits: BodyLimits,
  onChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<number> {
  checkDeclaredLength(res, limits.maxBytes);
  if (!res.body) return 0;

  const reader = res.body.getReader();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, limits.timeoutMs);

  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge(limits.maxBytes);
      }
      await onChunk(value);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (expired) throw timedOut();
    throw new AppError(502, "network_error", "The connection to the provider was lost");
  } finally {
    clearTimeout(timer);
  }
  // A cancelled reader ends the loop with `done`, without an error.
  if (expired) throw timedOut();
  return total;
}

/** The whole body in memory. For JSON answers and images. */
export async function readBodyCapped(res: Response, limits: BodyLimits): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await pump(res, limits, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

export interface WrittenBody {
  bytes: number;
  /** The first bytes of the file, for identifying its type. */
  head: Uint8Array;
}

/**
 * Stream the body into a new file at `path`, for videos, which are too large
 * to hold in memory. The file must not exist yet, and is removed again when
 * the download fails.
 */
export async function writeBodyToFile(
  res: Response,
  path: string,
  limits: BodyLimits,
  headBytes = 16,
): Promise<WrittenBody> {
  checkDeclaredLength(res, limits.maxBytes);
  const file = await open(path, "wx", 0o600);
  const head = new Uint8Array(headBytes);
  let headLength = 0;
  try {
    const bytes = await pump(res, limits, async (chunk) => {
      if (headLength < headBytes) {
        const take = Math.min(headBytes - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      await file.write(chunk);
    });
    await file.close();
    return { bytes, head: head.subarray(0, headLength) };
  } catch (err) {
    await file.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw err;
  }
}
