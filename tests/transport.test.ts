import assert from "node:assert/strict";
import { test } from "node:test";
import { isInsecureTransport, isLoopbackHost } from "../src/lib/transport";

const base = {
  cookieSecure: true,
  appUrl: "http://localhost:3000",
  forwardedProto: "http",
  host: "203.0.113.5:25565",
};

test("blocks sign-in on a plain-HTTP public address when cookies are HTTPS-only", () => {
  assert.equal(isInsecureTransport(base), true);
  assert.equal(isInsecureTransport({ ...base, host: "nexus.example.com" }), true);
  assert.equal(isInsecureTransport({ ...base, forwardedProto: "HTTP, https" }), true);
});

test("does not block when the connection is HTTPS", () => {
  assert.equal(isInsecureTransport({ ...base, forwardedProto: "https" }), false);
  assert.equal(isInsecureTransport({ ...base, forwardedProto: "https, http" }), false);
});

test("does not block when plain HTTP was explicitly allowed", () => {
  assert.equal(isInsecureTransport({ ...base, cookieSecure: false }), false);
});

test("does not block when the operator declared an https:// APP_URL", () => {
  assert.equal(isInsecureTransport({ ...base, appUrl: "https://nexus.example.com" }), false);
  assert.equal(isInsecureTransport({ ...base, appUrl: "  HTTPS://nexus.example.com" }), false);
});

test("does not block when the scheme or host is unknown", () => {
  assert.equal(isInsecureTransport({ ...base, forwardedProto: null }), false);
  assert.equal(isInsecureTransport({ ...base, host: null }), false);
});

test("loopback addresses are exempt because browsers keep Secure cookies there", () => {
  for (const host of ["localhost", "localhost:3000", "127.0.0.1:3000", "127.8.9.1", "[::1]:3000", "app.localhost:3000"]) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(isInsecureTransport({ ...base, host }), false, host);
  }
  for (const host of ["203.0.113.5:3000", "example.com", "localhost.example.com", "[2001:db8::1]:3000", "1127.0.0.1", "[", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
