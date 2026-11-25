import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, connectionNotMade, notReached, wasNotReached } from "../src/lib/errors";
import { failureKind, outcomeOfUse } from "../src/lib/model-health-rules";
import {
  CONNECTION_WAIT,
  connectionText,
  connectionWaitNote,
  failureText,
  isConnectionFailure,
  nextLimitWait,
  noConnection,
} from "../src/lib/orchestrator/limit-wait";
import { mayBeAboutTools } from "../src/lib/orchestrator/plan";
import { NOT_NOW, WORKING, publicText } from "../src/lib/public-text";
import { CUT_OFF_NOTE, UNPROVEN_WITNESSES, WITNESSES, asksWitnesses, cutOff, isNear, originOf, witnessesFor } from "../src/lib/reach-rules";

/** What fetch throws: a TypeError whose cause holds the code. */
function fetchFailed(cause: unknown): Error {
  return Object.assign(new TypeError("fetch failed"), { cause });
}
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

// ─── A request that never got there ──────────────────────────────────────────

test("what fetch throws when no connection was made is told from an answer that could not be taken", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]) {
    assert.equal(connectionNotMade(fetchFailed(coded(code))), true, code);
  }
  // A name with several addresses: one error for each of them.
  assert.equal(connectionNotMade(fetchFailed(Object.assign(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")], ""), { code: "ECONNREFUSED" }))), true);
  assert.equal(connectionNotMade(fetchFailed(new AggregateError([coded("EHOSTUNREACH"), coded("ENETUNREACH")], ""))), true, "the code is only on the errors inside");
  // The other side was reached: a redirect that is not followed, a certificate that is not accepted.
  assert.equal(connectionNotMade(fetchFailed(new Error("unexpected redirect"))), false);
  assert.equal(connectionNotMade(fetchFailed(coded("CERT_HAS_EXPIRED", "certificate has expired"))), false);
  assert.equal(connectionNotMade(fetchFailed(coded("DEPTH_ZERO_SELF_SIGNED_CERT"))), false);
  assert.equal(connectionNotMade(new TypeError("fetch failed")), false, "nothing is known");
  assert.equal(connectionNotMade(null), false);
  assert.equal(connectionNotMade("ECONNREFUSED"), false);
  // An error that is its own cause does not go round for ever.
  const round: { code?: string; cause?: unknown } = {};
  round.cause = round;
  assert.equal(connectionNotMade(round), false);
});

test("an error for a request that never got there is an AppError like the others, with a mark", () => {
  const err = notReached("Could not reach provider");
  assert.ok(err instanceof AppError);
  assert.deepEqual([err.name, err.status, err.code, err.message], ["AppError", 502, "network_error", "Could not reach provider"], "a tool's error is told by this name");
  assert.equal(wasNotReached(err), true);
  assert.equal(wasNotReached(new AppError(400, "dns_error", "Could not resolve Base URL host")), true, "no address for the name: nothing was asked either");
  // The connection was there, and then something went wrong.
  assert.equal(wasNotReached(new AppError(502, "network_error", "Could not reach provider")), false, "a certificate, a redirect");
  assert.equal(wasNotReached(new AppError(502, "network_error", "Provider stream was interrupted")), false);
  assert.equal(wasNotReached(new AppError(504, "timeout", "Upstream request timed out")), false);
  assert.equal(wasNotReached(new AppError(502, "upstream_error", "Provider responded 503: busy")), false);
  assert.equal(wasNotReached(new Error("Could not reach provider")), false);
  assert.equal(wasNotReached(undefined), false);
});

test("a name without an address says nothing about a model's tools, and is not held against the model as an answer would be", () => {
  assert.equal(mayBeAboutTools({ code: "dns_error", message: "Could not resolve Base URL host" }), false);
  assert.equal(mayBeAboutTools({ code: "network_error", message: "Could not reach provider" }), false);
  assert.equal(mayBeAboutTools({ code: "upstream_error", message: "Provider responded 400: tools are not supported" }), true, "as before");
  assert.equal(failureKind({ code: "dns_error", message: "Could not resolve Base URL host" }), "temporary");
  assert.deepEqual(outcomeOfUse({ code: "network_error", message: "Could not reach provider" }), { kind: "down" }, "a provider that is out of reach rests, as before");
});

// ─── A task that could connect to none of its models ─────────────────────────

test("a task has no connection when every model it asked failed before its request got to a provider", () => {
  const out = (provider: string) => ({ provider, noConnection: true });
  assert.deepEqual(noConnection([out("Kilo Gateway"), out("BlockRun"), out("Kilo Gateway"), out("Gemini")]), { models: 4, providers: ["Kilo Gateway", "BlockRun", "Gemini"] });
  assert.deepEqual(noConnection([out("Kilo Gateway")]), { models: 1, providers: ["Kilo Gateway"] });
  // One provider was reached, whatever it said: the way out works.
  assert.equal(noConnection([out("Kilo Gateway"), { provider: "Gemini", noConnection: false }, out("BlockRun")]), null);
  // None was asked: a model that is switched off is not.
  assert.equal(noConnection([]), null);
  assert.equal(isConnectionFailure("network_error"), true);
  assert.equal(isConnectionFailure("dns_error"), true);
  assert.equal(isConnectionFailure("timeout"), false, "the provider was reached, and took too long");
  assert.equal(isConnectionFailure("upstream_error"), false);
  assert.equal(isConnectionFailure(null), false);
});

test("it waits for a connection as it waits for a limit that can end at any time", () => {
  const hour = 60 * 60_000;
  const waits: number[] = [];
  let waited = 0;
  for (let round = 0; round < 20; round++) {
    const wait = nextLimitWait({ round, waitedMs: waited, totalMs: hour, limited: [CONNECTION_WAIT] });
    if (wait === null) break;
    waits.push(wait / 60_000);
    waited += wait;
  }
  assert.deepEqual(waits, [1, 2, 5, 10, 15, 15, 12]);
  assert.equal(nextLimitWait({ round: 0, waitedMs: 0, totalMs: 0, limited: [CONNECTION_WAIT] }), null, "waiting is off");
  assert.equal(nextLimitWait({ round: 7, waitedMs: hour, totalMs: hour, limited: [CONNECTION_WAIT] }), null, "the time is used up");
});

test("while it waits it says what for: several providers out of reach at once point at this server, one can be either side", () => {
  const several = connectionWaitNote("2 minutes", { models: 6, providers: ["Kilo Gateway", "BlockRun", "Gemini"] });
  assert.equal(several.message, "Not answered just now. Trying again in 2 minutes");
  assert.equal(
    several.full,
    "This server could not connect to any of the 3 providers it asked: its connection to the internet, or its name lookup (DNS), seems to be down. Trying again in 2 minutes",
  );
  const one = connectionWaitNote("45 seconds", { models: 2, providers: ["Kilo Gateway"] });
  assert.equal(one.message, "Not answered just now. Trying again in 45 seconds");
  assert.equal(one.full, "This server could not connect to Kilo Gateway: the provider does not answer at its address, or this server's connection is down. Trying again in 45 seconds");
  // Someone who is not shown the setup reads the first, and "Working" for the second.
  for (const note of [several, one]) {
    assert.equal(publicText(note.message, null, WORKING), note.message);
    assert.equal(publicText(note.full, null, WORKING), WORKING);
  }
});

test("a task that failed without a connection says so before it lists its models", () => {
  const cut = { models: 3, providers: ["Kilo Gateway", "BlockRun"] };
  const failures = [
    { model: "Auto Free (Kilo Gateway)", error: "Could not resolve Base URL host" },
    { model: "Muse Glimmer 30B (Free) (BlockRun)", error: "Could not reach provider" },
    { model: "Glyph Cluster (Kilo Gateway)", error: "Could not reach provider" },
    { model: "claude-fable-5-2", error: "Model is disabled" },
  ];
  const sentence =
    "This server could not connect to any of the 2 providers it asked, so the cause is most likely its own connection to the internet or its name lookup (DNS), not the models.";
  assert.equal(connectionText(cut), sentence);
  assert.equal(
    failureText(failures, "Model is disabled", "", cut),
    "None of the 4 models of this task gave an answer.\n" +
      `${sentence}\n` +
      "• Auto Free (Kilo Gateway): Could not resolve Base URL host\n" +
      "• Muse Glimmer 30B (Free) (BlockRun): Could not reach provider\n" +
      "• Glyph Cluster (Kilo Gateway): Could not reach provider\n" +
      "• claude-fable-5-2: Model is disabled",
  );
  assert.match(
    failureText(failures, "Model is disabled", "1 hour", cut),
    /^None of the 4 models of this task gave an answer, also after the task waited 1 hour for a connection\.\nThis server could not connect to any of the 2 providers it asked, [^\n]*\n• Auto Free/,
  );
  // One model: what it said, then what that points at.
  const alone = { models: 1, providers: ["Kilo Gateway"] };
  assert.equal(
    failureText([{ model: "Auto Free (Kilo Gateway)", error: "Could not reach provider" }], "x", "", alone),
    "Could not reach provider\n\nThis server could not connect to Kilo Gateway: the provider does not answer at its address, or this server's own connection to the internet or its name lookup (DNS) is down.",
  );
  assert.match(
    failureText([{ model: "Auto Free (Kilo Gateway)", error: "Could not reach provider" }], "x", "6 seconds", alone),
    /is down\. The task waited 6 seconds for a connection, and there was none\.$/,
  );
  // With a connection, everything is as it was.
  assert.equal(failureText([{ model: "M (P)", error: "Provider responded 429: limited" }], "x", "60 minutes", null), "Provider responded 429: limited\n\nThe task waited 60 minutes for the limit to end, and it did not.");
  assert.match(failureText([{ model: "A (P)", error: "a" }, { model: "B (P)", error: "b" }], "b", "60 minutes"), /^None of the 2 models of this task gave an answer, also after the task waited 60 minutes for their limits\.\n• A \(P\): a\n• B \(P\): b$/);
  // Someone who is not shown the setup is told none of it.
  assert.equal(publicText(failureText(failures, "x", "", cut)), NOT_NOW);
});

// ─── Is this server cut off? ─────────────────────────────────────────────────

test("the address that tells two providers apart: scheme, host and port", () => {
  assert.equal(originOf("https://api.kilo.ai/api/gateway"), "https://api.kilo.ai");
  assert.equal(originOf("https://API.Kilo.ai:443/v1/"), "https://api.kilo.ai");
  assert.equal(originOf("http://127.0.0.1:4010/v1"), "http://127.0.0.1:4010");
  assert.notEqual(originOf("http://127.0.0.1:4010/v1"), originOf("http://127.0.0.1:4011/v1"));
  assert.equal(originOf("ftp://files.example/"), null);
  assert.equal(originOf("not an address"), null);
  assert.equal(originOf(""), null);
});

test("the witnesses are other providers that have answered before, each address once, the ones that answered last first", () => {
  const others = [
    { baseUrl: "https://api.kilo.ai/api/gateway", answeredAt: 500 },
    { baseUrl: "https://blockrun.ai/api/v1", answeredAt: 900 },
    { baseUrl: "https://generativelanguage.googleapis.com/v1beta", answeredAt: 700 },
    { baseUrl: "https://api.anthropic.com", answeredAt: null },
    { baseUrl: "https://blockrun.ai/api/v2", answeredAt: 950 },
    { baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", answeredAt: 100 },
    { baseUrl: "https://text.pollinations.ai/openai", answeredAt: 50 },
    { baseUrl: "not an address", answeredAt: 999 },
  ];
  assert.deepEqual([WITNESSES, UNPROVEN_WITNESSES], [3, 2]);
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", others), {
    proven: ["https://blockrun.ai/api/v2", "https://generativelanguage.googleapis.com/v1beta", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1"],
    // One that never answered is asked as well: it can say that the way out works.
    unproven: ["https://api.anthropic.com"],
  });
  // The one that failed is no witness for itself, at whatever path.
  const forBlockrun = witnessesFor("https://blockrun.ai/somewhere/else", others);
  assert.equal([...forBlockrun.proven, ...forBlockrun.unproven].some((url) => url.startsWith("https://blockrun.ai")), false);
  // Only providers that never answered: they are named, and nothing can be concluded from them (cutOff).
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", [{ baseUrl: "https://api.anthropic.com", answeredAt: null }]), { proven: [], unproven: ["https://api.anthropic.com"] });
  // Two at most of those that never answered, each address once.
  assert.deepEqual(
    witnessesFor("https://api.kilo.ai/api/gateway", [
      { baseUrl: "https://a.example/v1", answeredAt: null },
      { baseUrl: "https://a.example/v2", answeredAt: null },
      { baseUrl: "https://b.example/v1", answeredAt: null },
      { baseUrl: "https://c.example/v1", answeredAt: null },
    ]).unproven,
    ["https://a.example/v1", "https://b.example/v1"],
  );
  // Of two providers at one address, the one that answered speaks for the address.
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", [{ baseUrl: "https://a.example/v1", answeredAt: null }, { baseUrl: "https://a.example/v2", answeredAt: 7 }]), { proven: ["https://a.example/v2"], unproven: [] });
  // One provider, or all at one address: no witness.
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", [{ baseUrl: "https://api.kilo.ai/api/gateway", answeredAt: 5 }, { baseUrl: "https://api.kilo.ai/other", answeredAt: 9 }]), { proven: [], unproven: [] });
});

test("a witness is as far away as the provider that failed: a model next to the app answers with or without a way out", () => {
  for (const near of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://10.0.0.5:8000/v1", "http://192.168.1.20/v1", "http://[::1]:8080/v1", "http://ollama:11434/v1", "http://gpu-box.lan/v1", "https://llm.internal/v1", "http://models.local:8080"]) {
    assert.equal(isNear(near), true, near);
  }
  for (const far of ["https://api.kilo.ai/api/gateway", "https://generativelanguage.googleapis.com/v1beta", "http://8.8.8.8/v1", "https://blockrun.ai/api/v1", "not an address", ""]) {
    assert.equal(isNear(far), false, far);
  }
  const others = [
    { baseUrl: "http://ollama:11434/v1", answeredAt: 990 },
    { baseUrl: "https://blockrun.ai/api/v1", answeredAt: 900 },
    { baseUrl: "http://192.168.1.20:1234/v1", answeredAt: 800 },
    { baseUrl: "https://generativelanguage.googleapis.com/v1beta", answeredAt: 700 },
  ];
  // A provider out there failed: the model at home is not asked, though it answered last.
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", others).proven, ["https://blockrun.ai/api/v1", "https://generativelanguage.googleapis.com/v1beta"]);
  // The model at home failed: the other one at home is its witness, the ones out there are not.
  assert.deepEqual(witnessesFor("http://ollama:11434/v1", others).proven, ["http://192.168.1.20:1234/v1"]);
  // Only models at home, and a provider out there fails: nobody to ask.
  assert.deepEqual(witnessesFor("https://api.kilo.ai/api/gateway", [others[0]!, others[2]!]), { proven: [], unproven: [] });
});

test("cut off: a provider that answered before was asked, and none of them all was reached", () => {
  assert.equal(cutOff([false, false, false]), true);
  assert.equal(cutOff([false]), true);
  assert.equal(cutOff([false, true, false]), false, "one answer, and the way out works");
  assert.equal(cutOff([]), false, "nobody to ask: nothing is concluded");
  // One that never answered speaks for the way out, and not against it.
  assert.equal(cutOff([false, false], [true]), false, "it was reached: the two others are gone, the connection is not");
  assert.equal(cutOff([false], [false, false]), true, "nobody was reached");
  assert.equal(cutOff([], [false, false]), false, "that it cannot be reached says nothing: nobody knows that it ever could be");
  assert.equal(cutOff([], [true]), false);
  // The witnesses are asked after a request that got no answer, and after no other.
  assert.equal(asksWitnesses("network_error"), true);
  assert.equal(asksWitnesses("dns_error"), true);
  assert.equal(asksWitnesses("timeout"), true);
  assert.equal(asksWitnesses("upstream_error"), false);
  assert.equal(asksWitnesses("bad_request"), false);
  assert.equal(asksWitnesses(undefined), false);
  assert.equal(publicText(`Could not reach provider. ${CUT_OFF_NOTE}`), NOT_NOW, "for those who are shown the setup only");
});
