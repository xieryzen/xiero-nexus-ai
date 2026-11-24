import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUT_WEIGHT,
  DEFAULT_PLANS,
  FEATURES,
  changedSettings,
  defaultPlan,
  freeTokensFrom,
  hasFeature,
  inputWeightFrom,
  lowestPlanWith,
  notInPlan,
  planOf,
  planSettings,
  shippedSettings,
  type Feature,
} from "../src/lib/plan-rules";
import { PLANS, TIERS } from "../src/lib/roles";

const SHIPPED = shippedSettings({});

test("what the app ships with: ten million tokens a month for FREE, and more with each role above it", () => {
  assert.deepEqual(
    TIERS.map((tier) => [tier, DEFAULT_PLANS[tier].monthlyTokens]),
    [["free", 10_000_000], ["pro", 25_000_000], ["plus", 50_000_000], ["ultra", 100_000_000], ["admin", 250_000_000], ["owner", null]],
  );
  assert.equal(DEFAULT_INPUT_WEIGHT, 0.25);
  assert.equal(SHIPPED.inputWeight, 0.25);
});

test("the plans are a hierarchy: each has what the one below it has, and something more", () => {
  for (let i = 1; i < TIERS.length; i++) {
    const below = DEFAULT_PLANS[TIERS[i - 1]!];
    const above = DEFAULT_PLANS[TIERS[i]!];
    for (const feature of below.features) assert.equal(above.features.includes(feature), true, `${TIERS[i]} has ${feature}`);
    if (above.monthlyTokens !== null) assert.equal(above.monthlyTokens > (below.monthlyTokens ?? 0), true, TIERS[i]);
  }
  // Each plan of a user adds a feature to the one below.
  for (let i = 1; i < PLANS.length; i++) assert.equal(DEFAULT_PLANS[PLANS[i]!].features.length > DEFAULT_PLANS[PLANS[i - 1]!].features.length, true, PLANS[i]);
  assert.deepEqual(DEFAULT_PLANS.free.features, ["projects", "studio_image"]);
  assert.deepEqual(DEFAULT_PLANS.ultra.features, [...FEATURES]);
  assert.deepEqual(DEFAULT_PLANS.admin.features, [...FEATURES]);
  assert.deepEqual(DEFAULT_PLANS.owner.features, [...FEATURES]);
});

test("which role has what", () => {
  const has = (tier: string, feature: Feature) => hasFeature(SHIPPED, tier, feature);
  assert.deepEqual(["projects", "studio_image", "studio_voice", "knowledge", "studio_video", "automation", "api_keys"].map((f) => has("free", f as Feature)), [true, true, false, false, false, false, false]);
  assert.deepEqual([has("pro", "knowledge"), has("pro", "studio_voice"), has("pro", "studio_video"), has("pro", "api_keys")], [true, true, false, false]);
  assert.deepEqual([has("plus", "studio_video"), has("plus", "automation"), has("plus", "api_keys")], [true, true, false]);
  assert.equal(has("ultra", "api_keys"), true);
  for (const feature of FEATURES) assert.equal(has("admin", feature) && has("owner", feature), true, feature);
  // A role that is none has what FREE has.
  assert.equal(has("gold", "knowledge"), false);
  assert.equal(planOf(SHIPPED, null).monthlyTokens, 10_000_000);
  assert.deepEqual(FEATURES.map((f) => lowestPlanWith(SHIPPED, f)), ["free", "free", "pro", "plus", "pro", "plus", "ultra"]);
});

test("an account is told which plan has what it asked for, and which plan it is on", () => {
  assert.equal(notInPlan(SHIPPED, "free", "knowledge"), "Knowledge base: part of the Pro plan and the plans above it. Your plan is Free. The owner of this installation can change it.");
  assert.equal(notInPlan(SHIPPED, "plus", "api_keys"), "API keys: part of the Ultra plan. Your plan is Plus. The owner of this installation can change it.");
  // No plan has it: an owner took it away from all of them.
  const none = planSettings({ plans: { free: { features: [] }, pro: { features: [] }, plus: { features: [] }, ultra: { features: [] } } }, {});
  assert.equal(notInPlan(none, "ultra", "projects"), "Projects: not part of a plan. Your plan is Ultra. The owner of this installation can change it.");
});

test("the environment says what FREE has a month, and what a token of input counts", () => {
  assert.equal(freeTokensFrom("2500000"), 2_500_000);
  assert.equal(freeTokensFrom(" 2_500_000 "), 2_500_000);
  assert.equal(freeTokensFrom("2,500,000"), 2_500_000);
  assert.equal(freeTokensFrom("0"), 0);
  for (const raw of [undefined, "", "  ", "-1", "1.5", "ten", "1e30"]) assert.equal(freeTokensFrom(raw), null, String(raw));
  assert.equal(inputWeightFrom("0.5"), 0.5);
  assert.equal(inputWeightFrom("1"), 1);
  assert.equal(inputWeightFrom("0"), 0);
  for (const raw of [undefined, "", "2", "-0.1", "half"]) assert.equal(inputWeightFrom(raw), null, String(raw));
  const set = shippedSettings({ DEFAULT_TOKEN_LIMIT: "3000000", TOKEN_INPUT_WEIGHT: "1" });
  assert.deepEqual([set.plans.free.monthlyTokens, set.plans.pro.monthlyTokens, set.inputWeight], [3_000_000, 25_000_000, 1]);
  // What is not in order is not used.
  assert.deepEqual(shippedSettings({ DEFAULT_TOKEN_LIMIT: "lots", TOKEN_INPUT_WEIGHT: "9" }), SHIPPED);
});

test("what an owner saved holds over what the app ships with, and what is damaged is left out", () => {
  const saved = planSettings({ inputWeight: 0.5, plans: { free: { monthlyTokens: 1_000_000 }, pro: { features: ["projects", "api_keys", "no-such-feature"] } } }, {});
  assert.equal(saved.inputWeight, 0.5);
  assert.equal(saved.plans.free.monthlyTokens, 1_000_000);
  assert.deepEqual(saved.plans.free.features, ["projects", "studio_image"]);
  assert.deepEqual(saved.plans.pro.features, ["projects", "api_keys"]);
  assert.equal(saved.plans.pro.monthlyTokens, 25_000_000);
  // A row that cannot be read takes no limit away.
  for (const damaged of [null, "x", 7, [], { plans: "x" }, { inputWeight: "0.5" }, { inputWeight: 4 }, { plans: { free: { monthlyTokens: -1 } } }, { plans: { free: { monthlyTokens: 1.5 } } }]) {
    assert.deepEqual(planSettings(damaged, {}), SHIPPED, JSON.stringify(damaged));
  }
  // An admin has every feature and an owner no allowance, whatever was saved.
  const tried = planSettings({ plans: { admin: { features: [], monthlyTokens: 5 }, owner: { monthlyTokens: 5, features: [] } } }, {});
  assert.deepEqual([tried.plans.admin.features.length, tried.plans.admin.monthlyTokens, tried.plans.owner.monthlyTokens, tried.plans.owner.features.length], [FEATURES.length, 5, null, FEATURES.length]);
  // What the app ships with is not changed by reading.
  assert.equal(DEFAULT_PLANS.free.monthlyTokens, 10_000_000);
});

test("an owner changes the tokens of a role and what a token of input counts", () => {
  const changed = changedSettings(SHIPPED, { inputWeight: 0.333, plans: { free: { monthlyTokens: 20_000_000 }, admin: { monthlyTokens: 500_000_000 } } });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.deepEqual([changed.settings.inputWeight, changed.settings.plans.free.monthlyTokens, changed.settings.plans.pro.monthlyTokens, changed.settings.plans.admin.monthlyTokens], [0.33, 20_000_000, 25_000_000, 500_000_000]);
  // What holds now is not changed by trying.
  assert.equal(SHIPPED.plans.free.monthlyTokens, 10_000_000);
});

test("a role above another cannot have fewer tokens a month", () => {
  const more = changedSettings(SHIPPED, { plans: { free: { monthlyTokens: 30_000_000 } } });
  assert.deepEqual(more, { ok: false, error: "Pro is above Free: it cannot have fewer tokens a month" });
  const less = changedSettings(SHIPPED, { plans: { admin: { monthlyTokens: 1_000 } } });
  assert.deepEqual(less, { ok: false, error: "Admin is above Ultra: it cannot have fewer tokens a month" });
  // The same number is not fewer.
  assert.equal(changedSettings(SHIPPED, { plans: { free: { monthlyTokens: 25_000_000 } } }).ok, true);
});

test("a feature given to a plan is given to the plans above it; one taken away is taken from the plans below", () => {
  const given = changedSettings(SHIPPED, { plans: { free: { features: ["projects", "studio_image", "knowledge"] } } });
  assert.equal(given.ok, true);
  if (given.ok) {
    assert.deepEqual(given.settings.plans.free.features, ["projects", "studio_image", "knowledge"]);
    for (const plan of ["pro", "plus", "ultra"] as const) assert.equal(given.settings.plans[plan].features.includes("knowledge"), true, plan);
  }
  const taken = changedSettings(SHIPPED, { plans: { ultra: { features: ["projects", "studio_image", "studio_voice", "knowledge", "automation", "api_keys"] } } });
  assert.equal(taken.ok, true);
  if (taken.ok) {
    // Videos are gone from Ultra, and so from Plus, which had them.
    assert.equal(taken.settings.plans.plus.features.includes("studio_video"), false);
    assert.equal(taken.settings.plans.plus.features.includes("automation"), true);
    assert.equal(taken.settings.plans.admin.features.includes("studio_video"), true);
  }
});

test("two plans that are named must agree, and what cannot be changed is refused", () => {
  assert.deepEqual(changedSettings(SHIPPED, { plans: { free: { features: ["projects", "api_keys"] }, pro: { features: ["projects"] } } }), {
    ok: false,
    error: "Pro is above Free: it has api keys as well",
  });
  assert.deepEqual(changedSettings(SHIPPED, { plans: { owner: { monthlyTokens: 5 } } }), { ok: false, error: "The owner's role is not changed: it has every feature, and no allowance" });
  assert.deepEqual(changedSettings(SHIPPED, { plans: { admin: { features: ["projects"] } } }), { ok: false, error: "An admin has every feature: what is limited are the plans" });
  assert.deepEqual(changedSettings(SHIPPED, { plans: { pro: { features: ["projects", "flying"] } } }), { ok: false, error: '"flying" is no feature of a plan' });
  assert.deepEqual(changedSettings(SHIPPED, { inputWeight: 1.5 }), { ok: false, error: "What a token of input counts is a number from 0 to 1" });
  const tooMany = changedSettings(SHIPPED, { plans: { ultra: { monthlyTokens: 10 ** 13 } } });
  assert.equal(tooMany.ok, false);
  const half = changedSettings(SHIPPED, { plans: { pro: { monthlyTokens: 25_000_000.5 } } });
  assert.equal(half.ok, false);
});

test("nothing named changes nothing", () => {
  const same = changedSettings(SHIPPED, {});
  assert.deepEqual(same, { ok: true, settings: SHIPPED });
});

test("a new account is Free, unless the installation names another plan for new accounts", () => {
  assert.equal(defaultPlan({}), "free");
  assert.equal(defaultPlan({ DEFAULT_PLAN: "" }), "free");
  assert.equal(defaultPlan({ DEFAULT_PLAN: "pro" }), "pro");
  assert.equal(defaultPlan({ DEFAULT_PLAN: " Ultra " }), "ultra");
  // What is no plan of a user is not one: nobody becomes an admin by a setting.
  for (const raw of ["admin", "owner", "gold", "user"]) assert.equal(defaultPlan({ DEFAULT_PLAN: raw }), "free", raw);
});
