import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUT_MARK,
  deletedPath,
  deliverableOfSavedFile,
  fileBody,
  fileList,
  pathsWritten,
  reviewMaterial,
  savedPath,
} from "../src/lib/orchestrator/deliverable";

// ─── The files a task wrote ──────────────────────────────────────────────────

test("the path of a saved file is read from what the tool answered", () => {
  assert.equal(savedPath("Saved docs/README.md (1204 characters)."), "docs/README.md");
  assert.equal(savedPath("Saved a file with spaces.txt (3 characters).\n"), "a file with spaces.txt");
  assert.equal(savedPath("There is no file \"docs/README.md\"."), null);
  assert.equal(savedPath(null), null);
  assert.equal(deletedPath("Deleted old/notes.md."), "old/notes.md");
  assert.equal(deletedPath("Saved old/notes.md (3 characters)."), null);
});

test("the files a task wrote are the ones it saved and did not delete again", () => {
  const calls = [
    { name: "list_files", result: "The workspace is empty.", isError: false },
    { name: "write_file", result: "Saved src/Main.java (900 characters).", isError: false },
    { name: "write_file", result: "Saved scratch.txt (10 characters).", isError: false },
    { name: "edit_file", result: "Saved plugin.yml (120 characters).", isError: false },
    { name: "write_file", result: "A file can be at most 256 KB. Split it.", isError: true },
    { name: "delete_file", result: "Deleted scratch.txt.", isError: false },
    { name: "edit_file", result: "Saved src/Main.java (950 characters).", isError: false },
    // Another tool that happens to say "Saved" is not a file.
    { name: "remember", result: "Saved nothing.txt (1 characters).", isError: false },
  ];
  assert.deepEqual(pathsWritten(calls), ["src/Main.java", "plugin.yml"]);
  assert.deepEqual(pathsWritten([]), []);
});

// ─── A task's output file ────────────────────────────────────────────────────

test("a file of code or data is the one fenced block of the answer", () => {
  const answer = 'Here is the file:\n\n```yaml\nname: FlyPass\nmain: dev.example.FlyPass\n```\n\nI could not start a server to try it.';
  assert.equal(fileBody("src/main/resources/plugin.yml", answer), "name: FlyPass\nmain: dev.example.FlyPass\n");
  assert.equal(fileBody("manifest.json", '```json\n{"format_version": 2}\n```'), '{"format_version": 2}\n');
  assert.equal(fileBody("a.py", "~~~python\nprint(1)\n~~~\n"), "print(1)\n");
  assert.equal(fileBody("win.cfg", "```\r\na=1\r\n```\r\n"), "a=1\n");
});

test("an answer without a fence is saved as it was answered", () => {
  assert.equal(fileBody("plugin.yml", "name: FlyPass\n"), "name: FlyPass\n");
  assert.equal(fileBody("README.md", "# FlyPass\n\nText.\n"), "# FlyPass\n\nText.\n");
});

test("an answer with more than one block is not guessed at", () => {
  const two = "```java\nclass A {}\n```\n\nand its test:\n\n```java\nclass ATest {}\n```";
  assert.equal(fileBody("src/A.java", two), two);
  // A fence that never closes, and one that closes with another mark.
  assert.equal(fileBody("a.js", "```js\nlet a = 1;\n"), "```js\nlet a = 1;\n");
  assert.equal(fileBody("a.js", "```js\nlet a = 1;\n~~~"), "```js\nlet a = 1;\n~~~");
  // A block with nothing in it is not a file.
  assert.equal(fileBody("a.js", "```js\n\n```"), "```js\n\n```");
});

test("a document keeps its code blocks, and loses only a fence around all of it", () => {
  const readme = "# FlyPass\n\nInstall:\n\n```bash\ncp FlyPass.jar plugins/\n```\n\nDone.";
  assert.equal(fileBody("README.md", readme), readme);
  // Wrapped as a whole, the way models hand over Markdown.
  assert.equal(fileBody("README.md", "```markdown\n" + readme + "\n```"), readme + "\n");
  assert.equal(fileBody("docs/guide.md", "```md\n# Guide\n```\n"), "# Guide\n");
  assert.equal(fileBody("NOTES.txt", "```\nplain notes\n```"), "plain notes\n");
  // With a word before it, the document is left alone: what is the document is not certain.
  const chatty = "Here it is:\n\n```markdown\n# FlyPass\n```";
  assert.equal(fileBody("README.md", chatty), chatty);
  // A document that is one block of code is not a wrapper.
  const snippet = "```java\nclass A {}\n```";
  assert.equal(fileBody("EXAMPLE.md", snippet), snippet);
  // A document that begins and ends with a block of its own, without a label, is left alone.
  const blocks = "```\nfirst\n```\n\ntext\n\n```\nlast\n```";
  assert.equal(fileBody("README.md", blocks), blocks);
  // A file without an extension is taken for a document.
  assert.equal(fileBody("LICENSE", "```text\nMIT\n```"), "MIT\n");
});

test("a task whose agent saved the file hands over the file, then what the agent said", () => {
  const file = "name: FlyPass\nversion: 1.0.0\n";
  const said = "I wrote plugin.yml with the two commands. I could not start a server to try it.";
  const deliverable = deliverableOfSavedFile("plugin.yml", file, said);
  assert.ok(deliverable.startsWith("name: FlyPass\nversion: 1.0.0\n\n[Saved as plugin.yml by the agent, which said: I wrote"));
  assert.ok(deliverable.endsWith("try it.]"));
  // Nothing said, or the file said again: the file alone.
  assert.equal(deliverableOfSavedFile("plugin.yml", file, "  "), file);
  assert.equal(deliverableOfSavedFile("plugin.yml", file, "name: FlyPass\nversion: 1.0.0"), file);
  // An agent that answered with the file as well is taken at its word.
  const both = "The file:\n\nname: FlyPass\nversion: 1.0.0\n\nNot tried on a server.";
  assert.equal(deliverableOfSavedFile("plugin.yml", file, both), both);
});

// ─── What the reviewer reads ─────────────────────────────────────────────────

test("two files with the same words: each deliverable is the file of its own task", () => {
  const words = "# Notes\n\nThe same words in two files.\n";
  const material = reviewMaterial(
    [
      { seq: 1, title: "First", acceptanceCriteria: "", artifact: words, outputFile: "a/notes.md", wrote: ["a/notes.md"] },
      { seq: 2, title: "Second", acceptanceCriteria: "", artifact: words, outputFile: "b/notes.md" },
      { seq: 3, title: "Third", acceptanceCriteria: "", artifact: `Copied here: ${words}` },
    ],
    [
      { path: "a/notes.md", content: words },
      { path: "b/notes.md", content: words },
      { path: "c/unclaimed.md", content: words },
    ],
  );
  assert.match(material, /## 1\. First\n.*\nFiles of this task: a\/notes\.md\nDeliverable \(it holds the files a\/notes\.md, c\/unclaimed\.md, as saved in the workspace\):/);
  assert.match(material, /## 2\. Second\n.*\nFiles of this task: b\/notes\.md\nDeliverable \(it holds the files b\/notes\.md, c\/unclaimed\.md, as saved in the workspace\):/);
  // A task that names no file holds only what no task says is its own.
  assert.match(material, /## 3\. Third\n.*\nDeliverable \(it holds the file c\/unclaimed\.md, as saved in the workspace\):/);
  assert.ok(!material.includes("#### File:"));
});

test("the reviewer is shown the files that the deliverables only speak of", () => {
  const material = reviewMaterial(
    [
      { seq: 1, title: "Write the README", acceptanceCriteria: "Has a commands table.", artifact: "I wrote README.md with five sections.", wrote: ["README.md"] },
      { seq: 2, title: "plugin.yml", acceptanceCriteria: "", artifact: "name: FlyPass\n\n[Saved as plugin.yml by the agent, which said: done]", outputFile: "plugin.yml", wrote: ["plugin.yml"] },
    ],
    [
      { path: "plugin.yml", content: "name: FlyPass\n" },
      { path: "README.md", content: "# FlyPass\n\n| Command | Permission |\n" },
      { path: "empty.txt", content: "  \n" },
    ],
  );
  assert.match(material, /^## 1\. Write the README\nAcceptance criteria: Has a commands table\.\nFiles of this task: README\.md\nDeliverable:\nI wrote README\.md with five sections\./);
  assert.match(material, /## 2\. plugin\.yml\nAcceptance criteria: \(none\)\nFiles of this task: plugin\.yml\nDeliverable:\nname: FlyPass/);
  // The file of task 2 is thirteen characters: too short to be looked for in a deliverable, so it is shown as a file.
  assert.match(material, /#### File: plugin\.yml \(14 characters\)\nname: FlyPass/);
  assert.match(material, /### Files in the project workspace, as they are now\n\n#### File: /);
  assert.match(material, /#### File: README\.md \(36 characters\)\n# FlyPass\n\n\| Command \| Permission \|/);
  // An empty file is not shown at all.
  assert.equal(material.match(/#### File:/g)?.length, 2);
  assert.ok(!material.includes("empty.txt"));
  assert.ok(!material.includes(CUT_MARK));
});

test("a deliverable that is the file says so, and the file is not shown a second time", () => {
  const yml = "name: FlyPass\nversion: 1.0.0\nmain: dev.example.FlyPass\n";
  const material = reviewMaterial(
    [
      { seq: 1, title: "plugin.yml", acceptanceCriteria: "Valid.", artifact: `${yml.trimEnd()}\n\n[Saved as plugin.yml by the agent, which said: done]`, outputFile: "plugin.yml", wrote: ["plugin.yml"] },
      { seq: 2, title: "Notes", acceptanceCriteria: "", artifact: "Nothing to add." },
    ],
    [{ path: "plugin.yml", content: yml }],
  );
  assert.match(material, /Files of this task: plugin\.yml\nDeliverable \(it holds the file plugin\.yml, as saved in the workspace\):\nname: FlyPass\nversion: 1\.0\.0/);
  assert.match(material, /## 2\. Notes\nAcceptance criteria: \(none\)\nDeliverable:\nNothing to add\./);
  assert.ok(!material.includes("#### File:"));
  assert.equal(material.split("main: dev.example.FlyPass").length - 1, 1);
  assert.ok(material.endsWith("### Files in the project workspace, as they are now\n\nShown above, in the deliverable that holds it, and not again here: plugin.yml"));
});

test("a project without files is reviewed by its deliverables alone", () => {
  const material = reviewMaterial([{ seq: 1, title: "Answer", acceptanceCriteria: "One sentence.", artifact: "Yes." }], []);
  assert.equal(material, "## 1. Answer\nAcceptance criteria: One sentence.\nDeliverable:\nYes.");
});

test("what does not fit is cut, and the reviewer is told how much it did not see", () => {
  const long = "x".repeat(10_000);
  const material = reviewMaterial([{ seq: 1, title: "Long", acceptanceCriteria: null, artifact: long }], [{ path: "big.txt", content: "y".repeat(9_000) }]);
  assert.ok(material.includes(`${"x".repeat(8_000)}\n${CUT_MARK} 2000 more characters were not shown to you]`));
  assert.ok(material.includes(`#### File: big.txt (9000 characters)\n${"y".repeat(8_000)}\n${CUT_MARK} 1000 more characters were not shown to you]`));
});

test("many tasks and files share the room, and a file that has none is named", () => {
  const limits = { item: 1_000, total: 3_000, least: 500 };
  const tasks = [1, 2].map((seq) => ({ seq, title: `Task ${seq}`, acceptanceCriteria: null, artifact: "t".repeat(2_000) }));
  const files = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((path) => ({ path, content: path.charAt(0).repeat(2_000) }));
  const material = reviewMaterial(tasks, files, limits);
  // Seven things in 3,000 characters: 500 each, the least, until the room is used up.
  assert.equal(material.match(/t{500}\n\[cut here: 1500 more/g)?.length, 2);
  assert.ok(material.includes(`#### File: a.txt (2000 characters)\n${"a".repeat(500)}\n[cut here: 1500 more`));
  assert.ok(material.includes(`#### File: d.txt (2000 characters)\n${"d".repeat(500)}\n`));
  assert.ok(!material.includes("#### File: e.txt"));
  assert.ok(material.endsWith("Not shown to you, for want of room: e.txt (2000 characters)"));
  // Never more than the room there is.
  const shown = ["t", "a", "b", "c", "d", "e"].reduce((sum, letter) => sum + (material.match(new RegExp(`${letter}{500}`, "g"))?.length ?? 0) * 500, 0);
  assert.equal(shown, 3_000);
});

test("the manager is given the files by name and size", () => {
  assert.equal(fileList([]), "");
  assert.equal(fileList([{ path: "b.md", size: 20 }, { path: "a/x.java", size: 1200 }]), "- a/x.java (1200 characters)\n- b.md (20 characters)");
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, size: i }));
  assert.equal(fileList(many, 3).split("\n").at(-1), "- and 2 more");
});
