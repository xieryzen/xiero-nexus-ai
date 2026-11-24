import { test } from "node:test";
import assert from "node:assert/strict";
import { modelAboveRole, offeredModel, pickerGroups, type OfferedModel } from "../src/lib/chat-model-rules";

const model = (over: Partial<OfferedModel> & { id: string; modelId: string; providerId: string }): OfferedModel => ({
  name: over.modelId,
  providerName: over.providerId,
  providerPriority: 100,
  forUsers: false,
  minTier: "free",
  position: null,
  outputPrice: null,
  tools: true,
  ...over,
});

const ANTHROPIC = { providerId: "p-anthropic", providerName: "Anthropic", providerPriority: 10 };
const GATEWAY = { providerId: "p-gateway", providerName: "Kilo Gateway", providerPriority: 20 };
const GEMINI = { providerId: "p-gemini", providerName: "Gemini", providerPriority: 20 };

const CATALOG: OfferedModel[] = [
  model({ id: "g1", modelId: "google/gemini-2.5-flash:free", name: "Gemini 2.5 Flash", ...GATEWAY, forUsers: true }),
  model({ id: "a3", modelId: "claude-haiku-4-5", name: "Claude Haiku 4.5", ...ANTHROPIC, forUsers: true }),
  model({ id: "a1", modelId: "claude-opus-4-5", name: "Claude Opus 4.5", ...ANTHROPIC, forUsers: true, minTier: "ultra" }),
  model({ id: "m1", modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", ...GEMINI, forUsers: true, minTier: "pro" }),
  model({ id: "a2", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", ...ANTHROPIC, forUsers: true, minTier: "plus" }),
  model({ id: "g2", modelId: "dots3-note-preview:free", name: "Dots3 Note Preview", ...GATEWAY, tools: false }),
  model({ id: "a0", modelId: "claude-opus-4-1", name: "Claude Opus 4.1", ...ANTHROPIC, minTier: "admin" }),
];

const names = (groups: ReturnType<typeof pickerGroups>) => groups.map((g) => [g.name, g.models.map((m) => m.name)]);

test("the categories are the providers, in their order; in each the highest model first and the oldest last", () => {
  const groups = pickerGroups(CATALOG, { role: "owner", tier: "owner" });
  assert.deepEqual(names(groups), [
    ["Anthropic", ["Claude Opus 4.5", "Claude Sonnet 4.5", "Claude Haiku 4.5", "Claude Opus 4.1"]],
    // The same priority: by name.
    ["Gemini", ["Gemini 2.5 Pro"]],
    ["Kilo Gateway", ["Gemini 2.5 Flash", "Dots3 Note Preview"]],
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["p-anthropic", "p-gemini", "p-gateway"]);
  // An owner is above every model: none is locked.
  assert.equal(groups.every((g) => g.models.every((m) => !m.locked)), true);
});

test("a user is offered the models marked for users; an admin and an owner all of them", () => {
  const user = pickerGroups(CATALOG, { role: "user", tier: "free" });
  assert.deepEqual(names(user), [
    ["Anthropic", ["Claude Opus 4.5", "Claude Sonnet 4.5", "Claude Haiku 4.5"]],
    ["Gemini", ["Gemini 2.5 Pro"]],
    ["Kilo Gateway", ["Gemini 2.5 Flash"]],
  ]);
  const admin = pickerGroups(CATALOG, { role: "admin", tier: "admin" });
  assert.equal(admin.flatMap((g) => g.models).length, CATALOG.length);
  // While no model is marked, a user is offered every model.
  const unmarked = CATALOG.map((m) => ({ ...m, forUsers: false }));
  assert.equal(pickerGroups(unmarked, { role: "user", tier: "free" }).flatMap((g) => g.models).length, CATALOG.length);
});

test("a model above the role of the account is shown, with the role it takes, and cannot be chosen", () => {
  const locked = (tier: "free" | "pro" | "plus" | "ultra") =>
    pickerGroups(CATALOG, { role: "user", tier })
      .flatMap((g) => g.models)
      .filter((m) => m.locked)
      .map((m) => [m.name, m.minTier]);
  assert.deepEqual(locked("free"), [["Claude Opus 4.5", "ultra"], ["Claude Sonnet 4.5", "plus"], ["Gemini 2.5 Pro", "pro"]]);
  assert.deepEqual(locked("pro"), [["Claude Opus 4.5", "ultra"], ["Claude Sonnet 4.5", "plus"]]);
  assert.deepEqual(locked("plus"), [["Claude Opus 4.5", "ultra"]]);
  assert.deepEqual(locked("ultra"), []);
  // A model for admins is locked for an admin's work as nobody's: an admin is at that role.
  const admin = pickerGroups(CATALOG, { role: "admin", tier: "admin" }).flatMap((g) => g.models);
  assert.equal(admin.find((m) => m.name === "Claude Opus 4.1")?.locked, false);
  // A lowest role that is none is FREE: nobody is locked out by a slip.
  const odd = pickerGroups([model({ id: "x", modelId: "x-1", providerId: "p", minTier: "gold" })], { role: "user", tier: "free" });
  assert.deepEqual([odd[0]!.models[0]!.minTier, odd[0]!.models[0]!.locked], ["free", false]);
});

test("a model is found among what is offered, with its category and whether it works with tools", () => {
  const groups = pickerGroups(CATALOG, { role: "user", tier: "pro" });
  assert.deepEqual(offeredModel(groups, "m1"), { id: "m1", name: "Gemini 2.5 Pro", minTier: "pro", locked: false, tools: true, category: "Gemini" });
  assert.equal(offeredModel(groups, "a1")?.locked, true);
  // Not marked for users: not offered to one, so not found.
  assert.equal(offeredModel(groups, "g2"), undefined);
  assert.equal(offeredModel(groups, "no-such"), undefined);
  assert.equal(offeredModel(pickerGroups(CATALOG, { role: "owner", tier: "owner" }), "g2")?.tools, false);
});

test("an account that names a model above its role is told which role has it", () => {
  assert.equal(modelAboveRole({ name: "Claude Sonnet 4.5", minTier: "plus" }, "free"), '"Claude Sonnet 4.5" is part of the Plus plan and the plans above it. Your plan is Free. Choose another model, or leave the choice to the app.');
  assert.equal(modelAboveRole({ name: "Claude Opus 4.5", minTier: "ultra" }, "pro"), '"Claude Opus 4.5" is part of the Ultra plan. Your plan is Pro. Choose another model, or leave the choice to the app.');
  assert.equal(modelAboveRole({ name: "Claude Opus 4.1", minTier: "admin" }, "ultra"), '"Claude Opus 4.1" is for an admin and an owner. Your plan is Ultra. Choose another model, or leave the choice to the app.');
  assert.equal(modelAboveRole({ name: "Secret", minTier: "owner" }, "admin"), '"Secret" is for an owner. Your role is Admin. Choose another model, or leave the choice to the app.');
});

test("an owner's place for a model holds in the list of a conversation too", () => {
  const placed = CATALOG.map((m) => (m.id === "a3" ? { ...m, position: 0 } : m));
  assert.deepEqual(pickerGroups(placed, { role: "owner", tier: "owner" })[0]!.models.map((m) => m.name), ["Claude Haiku 4.5", "Claude Opus 4.5", "Claude Sonnet 4.5", "Claude Opus 4.1"]);
});
