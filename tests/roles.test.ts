import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, isAdminRole, isOwnerRole, isRole, roleLabel, whyNot } from "../src/lib/roles";

const owner = { id: "o1", role: "owner", status: "active" };
const secondOwner = { id: "o2", role: "owner", status: "active" };
const admin = { id: "a1", role: "admin", status: "active" };
const user = { id: "u1", role: "user", status: "active" };

test("an owner is an administrator too, and nobody else is an owner", () => {
  assert.deepEqual([...ROLES], ["owner", "admin", "user"]);
  assert.deepEqual(ROLES.map((role) => isAdminRole(role)), [true, true, false]);
  assert.deepEqual(ROLES.map((role) => isOwnerRole(role)), [true, false, false]);
  for (const value of [undefined, null, "", "root", "Owner", "ADMIN"]) {
    assert.equal(isAdminRole(value), false, String(value));
    assert.equal(isOwnerRole(value), false, String(value));
  }
  assert.equal(isRole("owner"), true);
  assert.equal(isRole("superuser"), false);
  assert.equal(isRole(1), false);
  assert.deepEqual(ROLES.map(roleLabel), ["Owner", "Administrator", "User"]);
});

test("only an owner changes accounts", () => {
  assert.equal(whyNot(admin, user, { role: "admin" }, 1), "Only an owner manages accounts");
  assert.equal(whyNot(user, user, { status: "disabled" }, 1), "Only an owner manages accounts");
  assert.equal(whyNot(admin, user, { remove: true }, 1), "Only an owner manages accounts");
  assert.equal(whyNot(owner, user, { role: "admin" }, 0), null);
  assert.equal(whyNot(owner, admin, { role: "owner" }, 0), null);
  assert.equal(whyNot(owner, admin, { status: "disabled" }, 0), null);
  assert.equal(whyNot(owner, user, { remove: true }, 0), null);
  // Nothing about the role or the status: a new name, a new password.
  assert.equal(whyNot(owner, user, {}, 0), null);
});

test("nobody changes their own role or status, or deletes themselves", () => {
  assert.equal(whyNot(owner, owner, { role: "admin" }, 1), "You cannot change your own role or status");
  assert.equal(whyNot(owner, owner, { status: "disabled" }, 1), "You cannot change your own role or status");
  assert.equal(whyNot(owner, owner, { remove: true }, 1), "You cannot delete your own account");
  assert.equal(whyNot(owner, owner, {}, 0), null);
});

test("there is always an owner who can sign in", () => {
  // One owner changes another: the one who acts is still there, and counted.
  assert.equal(whyNot(owner, secondOwner, { role: "admin" }, 1), null);
  assert.equal(whyNot(owner, secondOwner, { status: "disabled" }, 1), null);
  assert.equal(whyNot(owner, secondOwner, { remove: true }, 1), null);
  // Were there no other, it would be refused, whoever asks.
  assert.equal(whyNot(owner, secondOwner, { role: "user" }, 0), "At least one active owner must remain");
  assert.equal(whyNot(owner, secondOwner, { status: "disabled" }, 0), "At least one active owner must remain");
  assert.equal(whyNot(owner, secondOwner, { remove: true }, 0), "At least one active owner must remain");
  // Staying an owner, or an owner that is switched off already, takes nothing away.
  assert.equal(whyNot(owner, secondOwner, { role: "owner" }, 0), null);
  assert.equal(whyNot(owner, { id: "o3", role: "owner", status: "disabled" }, { remove: true }, 0), null);
  assert.equal(whyNot(owner, secondOwner, { status: "active" }, 0), null);
});
