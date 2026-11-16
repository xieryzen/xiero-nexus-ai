import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS_READ_ON, PRESET_GROUP_LABELS, PROVIDER_PRESETS, presetById } from "../src/lib/provider-presets";

test("the providers to start from: each can be told from the others, and has a usable address", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  const names = PROVIDER_PRESETS.map((p) => p.name.toLowerCase());
  const urls = PROVIDER_PRESETS.map((p) => p.baseUrl);
  assert.equal(new Set(ids).size, ids.length, "no id twice");
  assert.equal(new Set(names).size, names.length, "no name twice");
  assert.equal(new Set(urls).size, urls.length, "no address twice");
  for (const preset of PROVIDER_PRESETS) {
    const url = new URL(preset.baseUrl);
    assert.equal(url.protocol, "https:", preset.id);
    assert.ok(!preset.baseUrl.endsWith("/"), `${preset.id}: the paths of the API are added to the address`);
    assert.ok(preset.name.length <= 80, preset.id);
    assert.ok(preset.group in PRESET_GROUP_LABELS, preset.id);
    if (preset.keyUrl) assert.equal(new URL(preset.keyUrl).protocol, "https:", preset.id);
  }
  assert.match(PRESETS_READ_ON, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(presetById("groq")?.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(presetById("nothing"), undefined);
});

test("how a provider signs in fits what it gives", () => {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.group === "keyless") {
      assert.equal(preset.authType, "none", `${preset.id}: answers without a key`);
      assert.ok(preset.free, `${preset.id}: says what it gives`);
    } else {
      assert.equal(preset.authType, "bearer", preset.id);
      assert.ok(preset.keyUrl, `${preset.id}: says where a key is made`);
    }
    if (preset.group === "free-key") assert.ok(preset.free, `${preset.id}: says what is free`);
    if (preset.group === "paid") assert.equal(preset.free, "", `${preset.id}: promises nothing for free`);
    // Nothing is promised in numbers that change by the month, beyond what the provider publishes itself.
    assert.doesNotMatch(preset.free + (preset.note ?? ""), /guarantee|unlimited|forever/i, preset.id);
  }
});
