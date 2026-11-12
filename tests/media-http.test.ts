import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/lib/errors";
import { readBodyCapped, writeBodyToFile } from "../src/lib/media/http";

/** A response whose body arrives in the given pieces, `gapMs` apart. */
function streamed(chunks: Uint8Array[], opts: { gapMs?: number; headers?: Record<string, string> } = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) return controller.close();
      if (opts.gapMs) await new Promise((resolve) => setTimeout(resolve, opts.gapMs));
      controller.enqueue(chunks[i++]!);
    },
  });
  return new Response(body, { headers: opts.headers });
}

/** A response whose body never ends: one byte, then silence. */
function stalled(): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(Uint8Array.of(1));
        return;
      }
      return new Promise<void>(() => undefined); // never resolves
    },
  });
  return new Response(body);
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

async function expectAppError(run: Promise<unknown>, code: string, status: number): Promise<AppError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return err;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but nothing was thrown` });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "xiero-media-http-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LIMITS = { maxBytes: 1000, timeoutMs: 5000 };

// ─── In memory ───────────────────────────────────────────────────────────────

test("readBodyCapped returns the whole body, however it is chunked", async () => {
  const res = streamed([filled(300, 1), filled(300, 2), filled(400, 3)]);
  const body = await readBodyCapped(res, LIMITS);
  assert.equal(body.byteLength, 1000); // exactly at the limit is allowed
  assert.equal(body[0], 1);
  assert.equal(body[300], 2);
  assert.equal(body[999], 3);
});

test("readBodyCapped handles an empty body and a missing body", async () => {
  assert.equal((await readBodyCapped(new Response(""), LIMITS)).byteLength, 0);
  assert.equal((await readBodyCapped(new Response(null), LIMITS)).byteLength, 0);
});

test("readBodyCapped stops a body that grows past the limit", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(filled(400, 7));
    },
  });
  const err = await expectAppError(readBodyCapped(new Response(endless), LIMITS), "upstream_too_large", 502);
  assert.match(err.message, /larger than the .* limit/);
  // It stopped reading soon after the limit instead of draining the stream.
  assert.ok(pulled < 10, `pulled ${pulled} chunks`);
});

test("readBodyCapped refuses a declared length over the limit without reading", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(filled(10, 1));
      controller.close();
    },
  });
  const res = new Response(body, { headers: { "content-length": "1001" } });
  await expectAppError(readBodyCapped(res, LIMITS), "upstream_too_large", 502);
  assert.ok(pulled <= 1);
});

test("readBodyCapped does not trust a declared length that is too small", async () => {
  const res = streamed([filled(600, 1), filled(600, 2)], { headers: { "content-length": "10" } });
  await expectAppError(readBodyCapped(res, LIMITS), "upstream_too_large", 502);
});

test("readBodyCapped gives up on a body that never finishes", async () => {
  const started = Date.now();
  await expectAppError(readBodyCapped(stalled(), { maxBytes: 1000, timeoutMs: 80 }), "timeout", 504);
  assert.ok(Date.now() - started < 2000);
});

test("readBodyCapped gives up on a body that is too slow overall", async () => {
  // Every piece arrives in time, but the whole body does not.
  const res = streamed(Array.from({ length: 50 }, () => filled(1, 1)), { gapMs: 20 });
  await expectAppError(readBodyCapped(res, { maxBytes: 1000, timeoutMs: 100 }), "timeout", 504);
});

test("readBodyCapped reports a broken connection as a network error", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("socket hang up: secret-internal-detail"));
    },
  });
  const err = await expectAppError(readBodyCapped(new Response(body), LIMITS), "network_error", 502);
  assert.ok(!err.message.includes("secret-internal-detail"));
});

// ─── To a file ───────────────────────────────────────────────────────────────

test("writeBodyToFile streams the body to a new file and returns its first bytes", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "video.part");
    // The first chunk is shorter than the head, so the head spans two chunks.
    const res = streamed([Uint8Array.of(0, 0, 0, 0x18), filled(20, 9), filled(476, 5)]);
    const written = await writeBodyToFile(res, path, LIMITS, 16);
    assert.equal(written.bytes, 500);
    assert.deepEqual([...written.head], [0, 0, 0, 0x18, ...Array<number>(12).fill(9)]);
    const onDisk = await readFile(path);
    assert.equal(onDisk.byteLength, 500);
    assert.equal(onDisk[3], 0x18);
    assert.equal(onDisk[499], 5);
  });
});

test("writeBodyToFile returns a short head for a short body", async () => {
  await withTempDir(async (dir) => {
    const written = await writeBodyToFile(streamed([Uint8Array.of(1, 2, 3)]), join(dir, "short"), LIMITS, 16);
    assert.equal(written.bytes, 3);
    assert.deepEqual([...written.head], [1, 2, 3]);
  });
});

test("writeBodyToFile removes the partial file when the body is too large", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "big.part");
    const res = streamed([filled(600, 1), filled(600, 2)]);
    await expectAppError(writeBodyToFile(res, path, LIMITS), "upstream_too_large", 502);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("writeBodyToFile removes the partial file when the download stalls", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "stalled.part");
    await expectAppError(writeBodyToFile(stalled(), path, { maxBytes: 1000, timeoutMs: 80 }), "timeout", 504);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("writeBodyToFile creates nothing when the declared length is over the limit", async () => {
  await withTempDir(async (dir) => {
    const res = streamed([filled(10, 1)], { headers: { "content-length": "5000" } });
    await expectAppError(writeBodyToFile(res, join(dir, "declared"), LIMITS), "upstream_too_large", 502);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("writeBodyToFile never overwrites an existing file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "taken");
    await writeFile(path, "original");
    await assert.rejects(writeBodyToFile(streamed([filled(10, 1)]), path, LIMITS), /EEXIST/);
    // The file that was there is left as it was.
    assert.equal(await readFile(path, "utf8"), "original");
  });
});
