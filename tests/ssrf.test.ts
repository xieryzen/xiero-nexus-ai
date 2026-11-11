import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSafeProviderUrl,
  isPrivateIp,
  parseProviderUrl,
} from "../src/lib/ssrf";

test("private/reserved IPs are detected", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1"]) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
});

test("public IPs are allowed", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "140.82.112.3"]) {
    assert.ok(!isPrivateIp(ip), `${ip} should be public`);
  }
});

test("parseProviderUrl rejects bad schemes and credentials", () => {
  assert.throws(() => parseProviderUrl("ftp://example.com"));
  assert.throws(() => parseProviderUrl("https://user:pass@example.com"));
  assert.throws(() => parseProviderUrl("not a url"));
  assert.ok(parseProviderUrl("https://api.example.com/v1"));
});

test("assertSafeProviderUrl blocks hosts that resolve to private ranges", async () => {
  const resolver = async () => [{ address: "10.1.2.3" }];
  await assert.rejects(
    assertSafeProviderUrl("https://evil.internal/v1", { resolver }),
  );
});

test("assertSafeProviderUrl allows public resolution", async () => {
  const resolver = async () => [{ address: "1.2.3.4" }];
  const url = await assertSafeProviderUrl("https://api.example.com/v1", { resolver });
  assert.equal(url.hostname, "api.example.com");
});

test("assertSafeProviderUrl honors the host allowlist", async () => {
  const resolver = async () => [{ address: "127.0.0.1" }];
  // Without allowlist: blocked.
  await assert.rejects(assertSafeProviderUrl("http://ollama.local:11434/v1", { resolver }));
  // With allowlist: permitted.
  const url = await assertSafeProviderUrl("http://ollama.local:11434/v1", {
    resolver,
    allowHosts: ["ollama.local"],
  });
  assert.equal(url.hostname, "ollama.local");
});

test("literal private IP host is blocked outright", async () => {
  await assert.rejects(assertSafeProviderUrl("http://169.254.169.254/latest/meta-data"));
});
