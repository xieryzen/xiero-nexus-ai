import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  generateRecoveryCodes,
  hashPassword,
  sha256,
  timingSafeEqualStr,
  verifyPassword,
} from "../src/lib/crypto";

const key = randomBytes(32);

test("AES-GCM round-trips", () => {
  const plain = "sk-super-secret-key-value";
  const enc = aesGcmEncrypt(plain, key);
  assert.notEqual(enc, plain);
  assert.equal(aesGcmDecrypt(enc, key), plain);
});

test("AES-GCM rejects tampered ciphertext", () => {
  const enc = aesGcmEncrypt("hello", key);
  const buf = Buffer.from(enc, "base64");
  const last = buf.length - 1;
  buf[last] = (buf[last] ?? 0) ^ 0xff; // flip a bit in the ciphertext
  assert.throws(() => aesGcmDecrypt(buf.toString("base64"), key));
});

test("AES-GCM fails with the wrong key", () => {
  const enc = aesGcmEncrypt("hello", key);
  assert.throws(() => aesGcmDecrypt(enc, randomBytes(32)));
});

test("password hashing verifies and salts", () => {
  const h1 = hashPassword("correct horse battery staple");
  const h2 = hashPassword("correct horse battery staple");
  assert.notEqual(h1, h2, "same password should produce different salted hashes");
  assert.ok(verifyPassword("correct horse battery staple", h1));
  assert.ok(!verifyPassword("wrong password", h1));
});

test("verifyPassword rejects malformed hashes", () => {
  assert.ok(!verifyPassword("x", "not-a-valid-hash"));
});

test("recovery codes are unique and shaped", () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  const seen = new Set<string>();
  for (const { code, hash } of codes) {
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(hash, sha256(code));
    assert.ok(!seen.has(code), "codes should be unique");
    seen.add(code);
  }
});

test("timingSafeEqualStr", () => {
  assert.ok(timingSafeEqualStr("abc", "abc"));
  assert.ok(!timingSafeEqualStr("abc", "abd"));
  assert.ok(!timingSafeEqualStr("abc", "abcd"));
});
