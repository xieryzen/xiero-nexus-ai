import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_NOW,
  NOT_PUT_TOGETHER,
  NOT_SET_UP,
  WORKING,
  nameForms,
  namesPattern,
  namesSetup,
  publicText,
  synthesisFailure,
  withoutMaker,
  withoutNeeds,
  withoutQuoted,
} from "../src/lib/public-text";

const names = namesPattern([
  "Kilo Gateway",
  "api.kilo.ai",
  "google/gemini-2.0-flash",
  "llama-3.3-70b:free",
  "Claude Sonnet 4",
  "gpt",
  "auto",
]);

test("a model's id is looked for whole, without its prefix and without its suffix", () => {
  assert.deepEqual(nameForms("google/gemini-2.0-flash"), ["google/gemini-2.0-flash", "gemini-2.0-flash"]);
  assert.deepEqual(nameForms("meta/llama-3.3-70b:free"), ["meta/llama-3.3-70b:free", "llama-3.3-70b:free", "llama-3.3-70b"]);
  assert.deepEqual(nameForms("llama-3.3-70b:free"), ["llama-3.3-70b:free", "llama-3.3-70b"]);
  assert.deepEqual(nameForms("  plain  "), ["plain"]);
  assert.deepEqual(nameForms("   "), []);
});

test("a name is found as a word of its own, in any case", () => {
  assert.ok(names);
  assert.equal(names.test("It was done by gemini-2.0-flash today"), true);
  assert.equal(names.test("GEMINI-2.0-FLASH answered"), true);
  assert.equal(names.test("google/gemini-2.0-flash: 429"), true);
  assert.equal(names.test("llama-3.3-70b is busy"), true);
  assert.equal(names.test("asked api.kilo.ai twice"), true);
  assert.equal(names.test("(Claude Sonnet 4)"), true);
  // Inside another word it is not the name.
  assert.equal(names.test("xgemini-2.0-flashy"), false);
});

test("a name of fewer than four characters is not looked for, nor one that is excepted", () => {
  assert.equal(names!.test("the gpt of it"), false);
  assert.equal(namesPattern(["gpt", "o1", ""]), null);
  assert.equal(namesPattern([null, undefined]), null);
  // "auto" is long enough, and is looked for unless it is excepted.
  assert.equal(names!.test('send "auto" as the name'), true);
  const except = namesPattern(["auto", "Auto Router"], ["auto"]);
  assert.ok(except);
  assert.equal(except.test('send "auto" as the name'), false);
  assert.equal(except.test("Auto Router said no"), true);
  assert.equal(namesPattern(["auto"], ["AUTO"]), null);
});

test("a name with signs of a pattern is taken as it is written", () => {
  const odd = namesPattern(["c++ (beta)", "a.b*c"]);
  assert.ok(odd);
  assert.equal(odd.test("it ran on c++ (beta) again"), true);
  assert.equal(odd.test("it ran on a.b*c"), true);
  assert.equal(odd.test("it ran on aXbbbc"), false);
});

test("a text speaks of the setup by one of its words or by a name", () => {
  for (const text of [
    "Provider responded 429: slow down",
    "No API key configured for this provider",
    "Model is disabled",
    "The models are busy",
    "Upstream request timed out",
    "The Custom HTTP adapter has no embeddings API.",
    "the gateway refused",
  ]) {
    assert.equal(namesSetup(text, null), true, text);
  }
  for (const text of [
    "Your token balance is used up.",
    "The file is larger than the limit",
    "modelRowId: Required",
    "A remodelled plan",
    "Cancelled",
  ]) {
    assert.equal(namesSetup(text, null), false, text);
  }
  assert.equal(namesSetup("Asked llama-3.3-70b:free and got nothing", names), true);
  assert.equal(namesSetup("Asked nobody and got nothing", names), false);
});

test("a text that speaks of the setup is replaced, any other is said as it is", () => {
  assert.equal(publicText("Provider responded 500: boom", names), NOT_NOW);
  assert.equal(publicText("claude sonnet 4 is overloaded", names), NOT_NOW);
  assert.equal(publicText("The file is larger than the limit", names), "The file is larger than the limit");
  assert.equal(publicText("", names), "");
  assert.equal(publicText(null, names), null);
  assert.equal(publicText(undefined, names), null);
  assert.equal(publicText("Asking the model", names, WORKING), WORKING);
  assert.equal(publicText("Step 2 of 4", names, WORKING), "Step 2 of 4");
});

test("what the reader named themselves, in quotes, is not looked through in the app's own sentences", () => {
  assert.equal(withoutQuoted('The file "model.md" is too large'), 'The file "" is too large');
  assert.equal(withoutQuoted("The file \u201cmodel.md\u201d is too large"), 'The file "" is too large');
  assert.equal(withoutQuoted('one "a" and "b" more'), 'one "" and "" more');
  assert.equal(withoutQuoted("no quotes"), "no quotes");
  // An open quote without its end is left as it is.
  assert.equal(withoutQuoted('a "model'), 'a "model');

  const own = 'A collection called "Business model" already exists';
  assert.equal(publicText(own, names, NOT_NOW, true), own);
  assert.equal(publicText(own, names), NOT_NOW);
  // The word outside the quotes still counts.
  assert.equal(publicText('More than one provider has a model "x"', names, NOT_NOW, true), NOT_NOW);
  assert.equal(publicText('The workflow "Gemini-2.0-flash reel" has 9 steps', names, NOT_NOW, true), 'The workflow "Gemini-2.0-flash reel" has 9 steps');
  assert.equal(publicText("gemini-2.0-flash is not a chat model", names, NOT_NOW, true), NOT_NOW);
});

test("the sentences said instead name nothing of the setup themselves", () => {
  for (const text of [NOT_NOW, NOT_SET_UP, WORKING]) {
    assert.equal(namesSetup(text, names), false, text);
  }
});

test("the line a generated file leaves in writing is read without the model that made it", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const rest = "\nThe image itself is not visible to other agents; this is the prompt it was generated from:\nA lamp with FLUX.1 light";
  assert.equal(withoutMaker(`Generated image with FLUX.1 [schnell] (9:16). Asset ${id}.${rest}`), `Generated image. Asset ${id}.${rest}`);
  assert.equal(withoutMaker(`Generated image with Imagen 4 (fast). Asset ${id}.${rest}`), `Generated image. Asset ${id}.${rest}`);
  assert.equal(withoutMaker(`Generated video with veo-3.1 (16:9, 6s, starting from an image). Asset ${id}.`), `Generated video. Asset ${id}.`);
  assert.equal(withoutMaker(`Generated voice-over with tts-1 (voice alloy). Asset ${id}.\nHello.`), `Generated voice-over. Asset ${id}.\nHello.`);
  // A model whose name holds what looks like the end of the line.
  assert.equal(withoutMaker(`Generated image with odd. Asset one (1:1). Asset ${id}.`), `Generated image. Asset ${id}.`);
  // Written without a model: as it is.
  assert.equal(withoutMaker(`Generated image (9:16). Asset ${id}.${rest}`), `Generated image (9:16). Asset ${id}.${rest}`);
  // What an agent wrote itself: as it is, also when it starts alike or says the same further down.
  assert.equal(withoutMaker("Generated image with care, by hand."), "Generated image with care, by hand.");
  const own = `A report.\nGenerated image with FLUX.1 (9:16). Asset ${id}.`;
  assert.equal(withoutMaker(own), own);
  assert.equal(withoutMaker(""), "");
});

test("a result that could not be put together says what the provider said, and only then", () => {
  assert.equal(synthesisFailure("(Synthesis step failed: Provider responded 500: down)"), "Provider responded 500: down");
  assert.equal(synthesisFailure("(Synthesis step failed: two\nlines (with brackets))"), "two\nlines (with brackets)");
  assert.equal(synthesisFailure("(Synthesis step failed: error)"), "error");
  assert.equal(synthesisFailure("FINAL DELIVERABLE. (Synthesis step failed: x)"), null);
  assert.equal(synthesisFailure("(Synthesis step failed: x) and more"), null);
  assert.equal(synthesisFailure(""), null);
  // What is said in its place names nothing of the setup.
  assert.equal(namesSetup(NOT_PUT_TOGETHER, names), false);
  assert.ok(NOT_PUT_TOGETHER.includes(NOT_NOW));
});

test("a description is read without the sentence the Reel template once ended it with", () => {
  const made = "Script, storyboard, 3 vertical scenes of 8 s, a cover image and a caption.";
  for (const needs of [
    "The project needs a video model and an image model.",
    "The project needs a video model and an image model, and the server needs ffmpeg.",
    "The project needs a video model, an image model and a speech model.",
    "The project needs a video model, an image model and a speech model, and the server needs ffmpeg.",
  ]) {
    assert.equal(withoutNeeds(`${made} ${needs}`), made, needs);
    assert.equal(namesSetup(withoutNeeds(`${made} ${needs}`), names), false, needs);
  }
  // Only at the end, and only that sentence: what an administrator wrote stays as written.
  const own = "The project needs a video model and an image model. Then it is cut by hand.";
  assert.equal(withoutNeeds(own), own);
  assert.equal(withoutNeeds("The project needs a steady hand."), "The project needs a steady hand.");
  assert.equal(withoutNeeds("Use the team \"Reels\"; the project needs an image model."), "Use the team \"Reels\"; the project needs an image model.");
  assert.equal(withoutNeeds(made), made);
  assert.equal(withoutNeeds(""), "");
  // A description that was nothing else is empty.
  assert.equal(withoutNeeds("The project needs a video model and an image model."), "");
});
