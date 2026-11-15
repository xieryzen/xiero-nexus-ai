import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUSY_RETRIES,
  DEFAULT_PROVIDER_RETRIES,
  GIVE_UP_FOR_MS,
  MAX_PROVIDER_RETRIES,
  MAX_RETRY_WAIT_MS,
  Patience,
  fetchWithRetries,
  retryAfterMs,
  retryDelayMs,
  retryKey,
  retryLimit,
  sleep,
} from "../src/lib/retry";

/** A provider that gives these answers, one for each time it is asked. */
function provider(answers: { status: number; retryAfter?: string }[]) {
  let asked = 0;
  const closed: number[] = [];
  const once = async () => {
    const answer = answers[Math.min(asked, answers.length - 1)]!;
    const index = asked++;
    const res = new Response(`answer ${index}`, {
      status: answer.status,
      headers: answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter },
    });
    const cancel = res.body!.cancel.bind(res.body!);
    res.body!.cancel = async (reason?: unknown) => {
      closed.push(index);
      return cancel(reason);
    };
    return res;
  };
  return { once, asked: () => asked, closed };
}

/** In place of the clock: remembers the waits and takes no time. */
function clock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

// ─── The setting ─────────────────────────────────────────────────────────────

test("PROVIDER_RETRIES: a number, 0 for off, and the default for anything else", () => {
  assert.equal(retryLimit(undefined), DEFAULT_PROVIDER_RETRIES);
  assert.equal(retryLimit(""), DEFAULT_PROVIDER_RETRIES);
  assert.equal(retryLimit("many"), DEFAULT_PROVIDER_RETRIES);
  assert.equal(retryLimit("-1"), DEFAULT_PROVIDER_RETRIES);
  assert.equal(retryLimit("0"), 0);
  assert.equal(retryLimit(" 2 "), 2);
  assert.equal(retryLimit("500"), MAX_PROVIDER_RETRIES);
});

// ─── How long to wait ────────────────────────────────────────────────────────

test("Retry-After: seconds, a date, or nothing that can be read", () => {
  const now = Date.parse("2026-11-16T10:00:00Z");
  assert.equal(retryAfterMs("7", now), 7000);
  assert.equal(retryAfterMs("1.5", now), 1500);
  assert.equal(retryAfterMs("Mon, 16 Nov 2026 10:00:30 GMT", now), 30_000);
  assert.equal(retryAfterMs("Mon, 16 Nov 2026 09:59:00 GMT", now), 0, "a moment that has passed");
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs("", now), null);
  assert.equal(retryAfterMs("soon", now), null);
});

test("the wait: what the provider asks for and a little more, else a growing one", () => {
  assert.equal(retryDelayMs("20", 0), 20_250);
  assert.equal(retryDelayMs("0", 0), 1250, "never at once");
  assert.equal(retryDelayMs(String(MAX_RETRY_WAIT_MS / 1000), 0), MAX_RETRY_WAIT_MS + 250);
  assert.equal(retryDelayMs(String(MAX_RETRY_WAIT_MS / 1000 + 1), 0), null, "more than this app waits");
  const own = [0, 1, 2, 3, 4, 9].map((attempt) => retryDelayMs(null, attempt));
  assert.deepEqual(own, [3000, 10_000, 25_000, 45_000, 45_000, 45_000]);
  assert.ok(own.slice(0, 4).reduce((a, b) => a! + b!, 0)! > 60_000, "long enough for a limit counted per minute");
});

// ─── Sending again ───────────────────────────────────────────────────────────

test("an answer that is not \"not now\" is passed on at once, whatever it is", async () => {
  for (const status of [200, 201, 400, 401, 404, 500, 502, 504]) {
    const p = provider([{ status }]);
    const c = clock();
    const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
    assert.equal(res.status, status);
    assert.equal(p.asked(), 1);
    assert.deepEqual(c.waits, []);
    assert.equal(await res.text(), "answer 0", "its body is still there to read");
  }
});

test("a limit (429) is waited for until the answer comes", async () => {
  const p = provider([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "answer 4");
  assert.equal(p.asked(), 5);
  assert.deepEqual(c.waits, [3000, 10_000, 25_000, 45_000]);
  assert.deepEqual(p.closed, [0, 1, 2, 3], "the answers that were given up are closed");
});

test("a busy provider (503, 529) is asked again, and answers", async () => {
  for (const status of [503, 529]) {
    const p = provider([{ status }, { status }, { status: 200 }]);
    const c = clock();
    const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
    assert.equal(res.status, 200);
    assert.equal(p.asked(), 3);
    assert.deepEqual(c.waits, [3000, 10_000]);
  }
});

test("one that stays busy is given up sooner than a limit", async () => {
  const p = provider([{ status: 503 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 8, sleep: c.sleep });
  assert.equal(res.status, 503);
  assert.equal(p.asked(), 1 + BUSY_RETRIES);
  assert.deepEqual(c.waits, [3000, 10_000], "a quarter of a minute, and then the caller's next model");
  assert.equal(await res.text(), `answer ${BUSY_RETRIES}`, "and can still be read");
});

test("a limit that turns into a busy provider counts what was waited already", async () => {
  const p = provider([{ status: 429 }, { status: 429 }, { status: 503 }, { status: 200 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
  assert.equal(res.status, 503);
  assert.equal(p.asked(), 3);
});

test("the provider's own wait is the one that is taken", async () => {
  const p = provider([{ status: 429, retryAfter: "31" }, { status: 429, retryAfter: "2" }, { status: 200 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
  assert.equal(res.status, 200);
  assert.deepEqual(c.waits, [31_250, 2250]);
});

test("after the limit, the last \"not now\" is the answer", async () => {
  const p = provider([{ status: 429 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 2, sleep: c.sleep });
  assert.equal(res.status, 429);
  assert.equal(p.asked(), 3, "once, and twice again");
  assert.equal(await res.text(), "answer 2", "and can still be read");
});

test("a limit of 0 sends the request once", async () => {
  const p = provider([{ status: 429 }, { status: 200 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 0, sleep: c.sleep });
  assert.equal(res.status, 429);
  assert.equal(p.asked(), 1);
  assert.deepEqual(c.waits, []);
});

test("a provider that asks for a longer wait than this app takes is not waited for", async () => {
  const p = provider([{ status: 429, retryAfter: "3600" }, { status: 200 }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 4, sleep: c.sleep });
  assert.equal(res.status, 429);
  assert.equal(p.asked(), 1);
  assert.deepEqual(c.waits, []);
});

test("the waits of one request together have an end", async () => {
  const p = provider([{ status: 429, retryAfter: "80" }]);
  const c = clock();
  const res = await fetchWithRetries(p.once, { limit: 8, sleep: c.sleep });
  assert.equal(res.status, 429);
  assert.deepEqual(c.waits, [80_250], "a second wait of 80 seconds would be more than two and a half minutes");
  assert.equal(p.asked(), 2);
});

test("a caller that gives up ends the wait", async () => {
  const p = provider([{ status: 429 }, { status: 200 }]);
  const gone = new AbortController();
  const waiting = fetchWithRetries(p.once, { limit: 4, signal: gone.signal });
  setTimeout(() => gone.abort(), 20);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(p.asked(), 1);
  await assert.rejects(sleep(1000, gone.signal), { name: "AbortError" }, "and one that had given up before does not start it");
});

test("an error on the way is the caller's to deal with", async () => {
  let asked = 0;
  const once = async () => {
    asked++;
    throw new Error("Could not reach provider");
  };
  await assert.rejects(fetchWithRetries(once, { limit: 4, sleep: clock().sleep }), /Could not reach provider/);
  assert.equal(asked, 1, "it is not known whether the request arrived, so it is not sent again");
});

// ─── A model that is waited for in vain ──────────────────────────────────────

test("a request is counted under its address and its model", () => {
  const body = JSON.stringify({ model: "gpt-oss-120b", messages: [{ role: "user", content: 'say "model": "other"' }] });
  assert.equal(retryKey("https://api.example.test/v1/chat/completions", body), "https://api.example.test/v1/chat/completions gpt-oss-120b");
  assert.equal(
    retryKey("https://api.example.test/v1beta/models/gemini-4-carbon:generateContent?key=SECRET", "{}"),
    "https://api.example.test/v1beta/models/gemini-4-carbon:generateContent",
    "without the query, which may hold a key",
  );
  assert.equal(retryKey("https://api.example.test/v1/models"), "https://api.example.test/v1/models");
  assert.equal(retryKey("not an address", null), "not an address");
  assert.notEqual(
    retryKey("https://api.example.test/v1/chat/completions", JSON.stringify({ model: "a" })),
    retryKey("https://api.example.test/v1/chat/completions", JSON.stringify({ model: "b" })),
    "two models of one provider have a limit each",
  );
});

test("a model that was waited for in vain is not waited for again for a while", async () => {
  const patience = new Patience();
  let time = 1_000_000;
  const now = () => time;
  const key = "https://api.example.test/v1/chat/completions quota-is-used-up";

  const first = provider([{ status: 429 }]);
  const c1 = clock();
  assert.equal((await fetchWithRetries(first.once, { limit: 4, sleep: c1.sleep, now, key, patience })).status, 429);
  assert.equal(first.asked(), 5, "the first request takes all the waits");
  assert.deepEqual(c1.waits, [3000, 10_000, 25_000, 45_000]);

  const second = provider([{ status: 429 }, { status: 200 }]);
  const c2 = clock();
  assert.equal((await fetchWithRetries(second.once, { limit: 4, sleep: c2.sleep, now, key, patience })).status, 429);
  assert.equal(second.asked(), 1, "the next is answered at once");
  assert.deepEqual(c2.waits, []);

  const other = provider([{ status: 429 }, { status: 200 }]);
  const c3 = clock();
  assert.equal((await fetchWithRetries(other.once, { limit: 4, sleep: c3.sleep, now, key: key + "-not", patience })).status, 200);
  assert.deepEqual(c3.waits, [3000], "another model is waited for as before");

  time += GIVE_UP_FOR_MS[0]!;
  const later = provider([{ status: 429 }, { status: 200 }]);
  const c4 = clock();
  assert.equal((await fetchWithRetries(later.once, { limit: 4, sleep: c4.sleep, now, key, patience })).status, 200);
  assert.deepEqual(c4.waits, [3000], "and this one too, when the while is over");
});

test("each wait in vain makes the while longer, until the model answers", async () => {
  const patience = new Patience();
  let time = 5_000_000;
  const now = () => time;
  const key = "https://api.example.test/v1/chat/completions used-up-for-the-day";
  const inVain = async () => {
    const c = clock();
    await fetchWithRetries(provider([{ status: 429 }]).once, { limit: 4, sleep: c.sleep, now, key, patience });
    return c.waits.length;
  };
  assert.deepEqual(GIVE_UP_FOR_MS, [5 * 60_000, 15 * 60_000, 60 * 60_000]);
  for (const [index, length] of [...GIVE_UP_FOR_MS, GIVE_UP_FOR_MS.at(-1)!].entries()) {
    assert.equal(await inVain(), 4, `time ${index + 1}: the waits are taken`);
    time += length - 1;
    assert.equal(await inVain(), 0, `time ${index + 1}: not again within ${length / 60_000} minutes`);
    time += 1;
  }
  // One answer, and the count starts again.
  await fetchWithRetries(provider([{ status: 200 }]).once, { limit: 4, sleep: clock().sleep, now, key, patience });
  assert.equal(await inVain(), 4);
  time += GIVE_UP_FOR_MS[0]!;
  assert.equal(await inVain(), 4, "five minutes again, not an hour");
});

test("an answer ends it at once", async () => {
  const patience = new Patience();
  const key = "https://api.example.test/v1/chat/completions busy-then-fine";
  const busy = provider([{ status: 503 }]);
  await fetchWithRetries(busy.once, { limit: 4, sleep: clock().sleep, key, patience });
  assert.equal(patience.has(key, Date.now()), false);
  const fine = provider([{ status: 200 }]);
  assert.equal((await fetchWithRetries(fine.once, { limit: 4, sleep: clock().sleep, key, patience })).status, 200);
  assert.equal(patience.has(key, Date.now()), true);
});

test("an answer that was not waited for is not remembered", async () => {
  const patience = new Patience();
  const key = "https://api.example.test/v1/chat/completions x";
  // The provider asks for an hour: nothing was waited, so nothing was in vain.
  await fetchWithRetries(provider([{ status: 429, retryAfter: "3600" }]).once, { limit: 4, sleep: clock().sleep, key, patience });
  assert.equal(patience.has(key, Date.now()), true);
  // Retries are switched off: the same.
  await fetchWithRetries(provider([{ status: 429 }]).once, { limit: 0, sleep: clock().sleep, key, patience });
  assert.equal(patience.has(key, Date.now()), true);
  // An error that is not "not now" does not clear what is remembered either.
  await fetchWithRetries(provider([{ status: 429 }]).once, { limit: 1, sleep: clock().sleep, key, patience });
  assert.equal(patience.has(key, Date.now()), false);
  await fetchWithRetries(provider([{ status: 400 }]).once, { limit: 1, sleep: clock().sleep, key, patience });
  assert.equal(patience.has(key, Date.now()), false, "a refused request says nothing about the limit");
});

test("what is remembered does not grow without end", () => {
  const patience = new Patience();
  for (let i = 0; i < 2000; i++) patience.spent(`key ${i}`, 1000);
  assert.equal(patience.has("key 1999", 1001), false, "the newest is kept");
  assert.equal(patience.has("key 0", 1001), true, "the oldest made way");
});
