import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticator } from "otplib";
import { generateTotpSecret, totpKeyUri, verifyTotp } from "../src/lib/totp";

test("generated secret verifies against a current token", () => {
  const secret = generateTotpSecret();
  const token = authenticator.generate(secret);
  assert.ok(verifyTotp(token, secret));
});

test("wrong token fails", () => {
  const secret = generateTotpSecret();
  assert.ok(!verifyTotp("000000", secret));
  assert.ok(!verifyTotp("abcdef", secret));
});

test("key URI is well-formed", () => {
  const secret = generateTotpSecret();
  const uri = totpKeyUri(secret, "user@example.com");
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=Xiero%20Nexus%20AI/);
});
