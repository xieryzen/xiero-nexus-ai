import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOICE_KINDS,
  CHOICE_LABEL,
  choicesFor,
  fitsKind,
  priceFor,
  type ChoiceModel,
} from "../src/lib/model-choice-rules";

function model(id: string, over: Partial<ChoiceModel> = {}): ChoiceModel {
  return { id, name: id, capabilities: ["text"], forUsers: false, failing: false, price: null, ...over };
}

test("a model does the kind of work its capabilities say", () => {
  assert.equal(fitsKind(["text"], "chat"), true);
  assert.equal(fitsKind([], "chat"), true);
  assert.equal(fitsKind(["text", "vision"], "chat"), true);
  assert.equal(fitsKind(["image_generation"], "chat"), false);
  assert.equal(fitsKind(["embeddings"], "chat"), false);
  assert.equal(fitsKind(["text", "image_generation"], "chat"), true);

  assert.equal(fitsKind(["image_generation"], "image"), true);
  assert.equal(fitsKind(["text"], "image"), false);
  assert.equal(fitsKind(["video_generation"], "video"), true);
  assert.equal(fitsKind(["image_generation"], "video"), false);
  assert.equal(fitsKind(["speech_generation"], "audio"), true);
  assert.equal(fitsKind(["text"], "audio"), false);
  assert.equal(fitsKind(["embeddings"], "embeddings"), true);
  assert.equal(fitsKind(["text"], "embeddings"), false);
});

test("without a mark, every model of the kind can be used: the cheapest first", () => {
  const all = [
    model("dear", { price: 30 }),
    model("free", { price: 0 }),
    model("cheap", { price: 1.5 }),
    model("unknown"),
    model("painter", { capabilities: ["image_generation"], price: 0 }),
  ];
  assert.deepEqual(choicesFor(all, "chat"), ["free", "cheap", "dear", "unknown"]);
  assert.deepEqual(choicesFor(all, "image"), ["painter"]);
  assert.deepEqual(choicesFor(all, "video"), []);
  assert.deepEqual(choicesFor([], "chat"), []);
});

test("when models of a kind are marked, only they are used for it", () => {
  const all = [
    model("free", { price: 0 }),
    model("marked-dear", { price: 30, forUsers: true }),
    model("marked-cheap", { price: 2, forUsers: true }),
    model("painter", { capabilities: ["image_generation"], price: 0.01 }),
    model("painter-two", { capabilities: ["image_generation"], price: 0.02 }),
  ];
  assert.deepEqual(choicesFor(all, "chat"), ["marked-cheap", "marked-dear"]);
  // A mark on a chat model says nothing about images.
  assert.deepEqual(choicesFor(all, "image"), ["painter", "painter-two"]);
});

test("a model whose check failed comes after one that answers, and is still a choice", () => {
  const all = [
    model("free-but-failing", { price: 0, failing: true }),
    model("dear", { price: 30 }),
    model("unknown"),
  ];
  assert.deepEqual(choicesFor(all, "chat"), ["dear", "unknown", "free-but-failing"]);
  assert.deepEqual(choicesFor([model("only", { failing: true })], "chat"), ["only"]);
  // A marked model that fails is not replaced by an unmarked one.
  assert.deepEqual(
    choicesFor([model("marked", { forUsers: true, failing: true }), model("other", { price: 0 })], "chat"),
    ["marked"],
  );
});

test("among equals the order is by name, then by id, and is the same every time", () => {
  const all = [
    model("b", { name: "Beta", price: 1 }),
    model("a", { name: "Beta", price: 1 }),
    model("c", { name: "Alpha", price: 1 }),
  ];
  assert.deepEqual(choicesFor(all, "chat"), ["c", "a", "b"]);
  assert.deepEqual(choicesFor(all.slice().reverse(), "chat"), ["c", "a", "b"]);
  // The list given is not changed.
  assert.deepEqual(all.map((m) => m.id), ["b", "a", "c"]);
});

test("a model's price is the one of the kind of work", () => {
  const prices = {
    inputPricePerMTok: 1,
    outputPricePerMTok: 4,
    pricePerImage: 0.02,
    pricePerSecond: 0.1,
    pricePerMChars: 15,
  };
  assert.equal(priceFor(prices, "chat"), 5);
  assert.equal(priceFor(prices, "image"), 0.02);
  assert.equal(priceFor(prices, "video"), 0.1);
  assert.equal(priceFor(prices, "audio"), 15);
  assert.equal(priceFor(prices, "embeddings"), 1);
  const none = {
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    pricePerImage: null,
    pricePerSecond: null,
    pricePerMChars: null,
  };
  for (const kind of CHOICE_KINDS) assert.equal(priceFor(none, kind), null, kind);
  assert.equal(priceFor({ ...none, outputPricePerMTok: 2 }, "chat"), 2);
  assert.equal(priceFor({ ...none, inputPricePerMTok: 0, outputPricePerMTok: 0 }, "chat"), 0);
});

test("every kind has a name for the Models page", () => {
  assert.deepEqual([...CHOICE_KINDS], ["chat", "image", "video", "audio", "embeddings"]);
  for (const kind of CHOICE_KINDS) assert.ok(CHOICE_LABEL[kind].length > 0, kind);
});
