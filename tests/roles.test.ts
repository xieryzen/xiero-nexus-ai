import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_AREAS,
  PLANS,
  ROLES,
  TIERS,
  accountOfTier,
  adminAccess,
  atLeast,
  isAdminRole,
  isOwnerRole,
  isPlan,
  isRole,
  isTier,
  managesArea,
  roleLabel,
  seesAdminArea,
  seesSetup,
  tierLabel,
  tierLine,
  tierOf,
  tierOfInput,
  tierRank,
  whyNot,
} from "../src/lib/roles";

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

test("the setup is shown to administrators and owners, and to nobody else", () => {
  assert.deepEqual(ROLES.map((role) => seesSetup(role)), [true, true, false]);
  for (const value of ["user", "", "Admin", "OWNER", "root", null, undefined]) {
    assert.equal(seesSetup(value), false, String(value));
  }
});

// ─── The six roles of the pages (v2.0) ───────────────────────────────────────

test("the six roles, the lowest first: a user's plan, or admin, or owner", () => {
  assert.deepEqual([...TIERS], ["free", "pro", "plus", "ultra", "admin", "owner"]);
  assert.deepEqual([...PLANS], ["free", "pro", "plus", "ultra"]);
  assert.equal(tierOf({ role: "user", plan: "plus" }), "plus");
  // A user without a plan, or with one that is none, is FREE.
  assert.equal(tierOf({ role: "user" }), "free");
  assert.equal(tierOf({ role: "user", plan: null }), "free");
  assert.equal(tierOf({ role: "user", plan: "gold" }), "free");
  // An admin and an owner are that, whatever plan the account once had.
  assert.equal(tierOf({ role: "admin", plan: "pro" }), "admin");
  assert.equal(tierOf({ role: "owner", plan: "free" }), "owner");
  assert.deepEqual(TIERS.map(tierRank), [0, 1, 2, 3, 4, 5]);
  assert.equal(tierRank("gold"), 0);
  assert.equal(tierRank(undefined), 0);
  assert.equal(isTier("ultra") && isTier("owner") && isPlan("pro"), true);
  assert.equal(isTier("user") || isPlan("admin") || isPlan(3), false);
});

test("a role is another one or above it", () => {
  assert.equal(atLeast("plus", "pro"), true);
  assert.equal(atLeast("plus", "plus"), true);
  assert.equal(atLeast("plus", "ultra"), false);
  assert.equal(atLeast("admin", "ultra"), true);
  assert.equal(atLeast("owner", "admin"), true);
  assert.equal(atLeast("free", "pro"), false);
  assert.equal(atLeast(null, "free"), true);
});

test("what a role is called", () => {
  assert.deepEqual(TIERS.map(tierLabel), ["Free", "Pro", "Plus", "Ultra", "Admin", "Owner"]);
  assert.deepEqual(TIERS.map(tierLine), ["Free plan", "Pro plan", "Plus plan", "Ultra plan", "Admin", "Owner"]);
  assert.equal(tierLabel("gold"), "Free");
});

test("how one of the six is kept, and what a request may name", () => {
  assert.deepEqual(accountOfTier("owner"), { role: "owner" });
  assert.deepEqual(accountOfTier("admin"), { role: "admin" });
  assert.deepEqual(accountOfTier("ultra"), { role: "user", plan: "ultra" });
  assert.deepEqual(accountOfTier("free"), { role: "user", plan: "free" });
  // One of the six as the role.
  for (const tier of TIERS) assert.equal(tierOfInput(tier, undefined), tier);
  // "user", as before 2.0: FREE, unless a plan is named as well.
  assert.equal(tierOfInput("user", undefined), "free");
  assert.equal(tierOfInput("user", "plus"), "plus");
  // Only a plan: the account becomes a user of that plan.
  assert.equal(tierOfInput(undefined, "pro"), "pro");
  // An admin has no plan: the role counts.
  assert.equal(tierOfInput("admin", "pro"), "admin");
  // Nothing named changes nothing, and what is no role is none.
  assert.equal(tierOfInput(undefined, undefined), undefined);
  assert.equal(tierOfInput("root", undefined), undefined);
  assert.equal(tierOfInput(undefined, "gold"), undefined);
});

test("the admin area: an owner manages all of it, an admin a part, a user sees none", () => {
  for (const area of ADMIN_AREAS) {
    assert.equal(adminAccess("owner", area), "manage", area);
    assert.equal(adminAccess("user", area), null, area);
    assert.equal(adminAccess(undefined, area), null, area);
  }
  // What holds keys, costs money or decides who may do what is the owner's: an admin looks.
  for (const area of ["users", "plans", "providers", "models", "servers", "browser", "usage", "observability", "audit", "overview"] as const) {
    assert.equal(adminAccess("admin", area), "view", area);
    assert.equal(managesArea("admin", area), false, area);
  }
  assert.equal(adminAccess("admin", "skills"), "manage");
  assert.equal(managesArea("admin", "skills"), true);
  assert.deepEqual([seesAdminArea("owner"), seesAdminArea("admin"), seesAdminArea("user"), seesAdminArea(null)], [true, true, false, false]);
});
