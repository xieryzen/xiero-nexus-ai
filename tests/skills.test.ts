import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX,
  SkillParseError,
  decodeText,
  parseFrontMatter,
  parseSkillMarkdown,
  parseSkillUpload,
  skillMarkdown,
  splitFrontMatter,
} from "../src/lib/skills/parse";
import { SKILLS_PER_TASK_MAX, skillNames, skillsBlock, type PromptSkill } from "../src/lib/skills/prompt";
import { ZipError, crc32, looksLikeZip, readZip, safeArchivePath, writeZip } from "../src/lib/skills/zip";

const LIMITS = { maxEntries: 100, maxEntryBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 };

/**
 * An archive made by Python's zipfile, the way a person's computer makes one:
 * a folder entry, a SKILL.md, a reference, a picture, a "__MACOSX" leftover,
 * a symbolic link, and an entry whose path leaves the folder.
 */
const MADE_ELSEWHERE = Buffer.from(
  "UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAJAAAAbXktc2tpbGwvUEsDBBQAAAAIAJW+b12Xy4XJnAAAADUDAAARAAAAbXktc2tp" +
  "bGwvU0tJTEwubWTtzTEOwjAMheE9p3gSc8LekQ0BE3CAkLptRBtXjivU2xMqQFyArYMHf/qlZ601yQ9U4SYcuknI9n7mSU1NOUgc" +
  "NXKqcPQzCsJ/M4drJjw6SgXV5zvKZTQsPxGWL3j1PbcTOdPHQCmXtdP+YmzZNhvsPvF72JzVi6IRHqAdoZVYIyYINSSUAuXti9xQ" +
  "O3MgGpco8Dgjdyy64op/xidQSwMEFAAAAAgAlb5vXUBslnAoAAAAJgAAABsAAABteS1za2lsbC9yZWZlcmVuY2VzL2dyaWQubWRT" +
  "VnAvykzh4gopT80pS1VIzs8pzc0r1lGwUMjNVUgvLSlJLSrW4wIAUEsDBBQAAAAIAJW+b13o7X1qDAAAAAoAAAAYAAAAbXktc2tp" +
  "bGwvYXNzZXRzL2xvZ28ucG5n6wzwc2dgZGL+/w8AUEsDBBQAAAAIAJW+b105nPsGBgAAAAQAAAAcAAAAX19NQUNPU1gvbXktc2tp" +
  "bGwvLl9TS0lMTC5tZMsqzcsGAFBLAwQUAAAAAAAAACEACrkfKQsAAAALAAAAFAAAAG15LXNraWxsL2xpbmstdG8tZXRjL2V0Yy9w" +
  "YXNzd2RQSwMEFAAAAAAAAAAhABA/0asEAAAABAAAAA4AAAAuLi9vdXRzaWRlLnR4dG5vcGVQSwECFAMUAAAAAAAAACEAAAAAAAAA" +
  "AAAAAAAACQAAAAAAAAAAAAAAgAEAAAAAbXktc2tpbGwvUEsBAhQDFAAAAAgAlb5vXZfLhcmcAAAANQMAABEAAAAAAAAAAAAAAIAB" +
  "JwAAAG15LXNraWxsL1NLSUxMLm1kUEsBAhQDFAAAAAgAlb5vXUBslnAoAAAAJgAAABsAAAAAAAAAAAAAAIAB8gAAAG15LXNraWxs" +
  "L3JlZmVyZW5jZXMvZ3JpZC5tZFBLAQIUAxQAAAAIAJW+b13o7X1qDAAAAAoAAAAYAAAAAAAAAAAAAACAAVMBAABteS1za2lsbC9h" +
  "c3NldHMvbG9nby5wbmdQSwECFAMUAAAACACVvm9dOZz7BgYAAAAEAAAAHAAAAAAAAAAAAAAAgAGVAQAAX19NQUNPU1gvbXktc2tp" +
  "bGwvLl9TS0lMTC5tZFBLAQIUAxQAAAAAAAAAIQAKuR8pCwAAAAsAAAAUAAAAAAAAAAAAAAD/odUBAABteS1za2lsbC9saW5rLXRv" +
  "LWV0Y1BLAQIUAxQAAAAAAAAAIQAQP9GrBAAAAAQAAAAOAAAAAAAAAAAAAACAARICAAAuLi9vdXRzaWRlLnR4dFBLBQYAAAAABwAH" +
  "AM0BAABCAgAAAAA=",
  "base64",
);

const file = (path: string, text: string) => ({ path, data: Buffer.from(text, "utf8") });

// ─── ZIP ─────────────────────────────────────────────────────────────────────

test("crc32 is the checksum ZIP uses", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("what is packed comes out the same", () => {
  const long = "A line that repeats.\n".repeat(500);
  const packed = writeZip([file("SKILL.md", "# Hello\n"), file("references/long.md", long), file("empty.txt", "")]);
  assert.ok(looksLikeZip(packed));
  assert.ok(packed.length < long.length / 4, "text is stored packed");
  const { entries, leftOut } = readZip(packed, LIMITS);
  assert.deepEqual(leftOut, []);
  assert.deepEqual(
    entries.map((e) => [e.path, e.data.toString("utf8")]),
    [["SKILL.md", "# Hello\n"], ["references/long.md", long], ["empty.txt", ""]],
  );
  assert.deepEqual(writeZip([file("a.txt", "a")]), writeZip([file("a.txt", "a")]), "the same files give the same bytes");
});

test("an archive made by another program is read, and what does not belong is left out", () => {
  const { entries, leftOut } = readZip(MADE_ELSEWHERE, LIMITS);
  assert.deepEqual(entries.map((e) => e.path).sort(), [
    "__MACOSX/my-skill/._SKILL.md",
    "my-skill/SKILL.md",
    "my-skill/assets/logo.png",
    "my-skill/references/grid.md",
  ]);
  assert.match(entries.find((e) => e.path === "my-skill/SKILL.md")!.data.toString("utf8"), /^---\nname: brochure-layout/);
  assert.deepEqual(
    leftOut.map((l) => `${l.path} | ${l.reason}`).sort(),
    ["../outside.txt | its path leaves the archive's folder", "my-skill/link-to-etc | it is a link, not a file"],
  );
});

test("a path that leaves the folder is not a path", () => {
  for (const bad of ["../a", "a/../../b", "/etc/passwd", "C:\\Windows\\x", "c:/x", "a/\u0000b", "", "..", "a\\..\\..\\b"]) {
    assert.equal(safeArchivePath(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeArchivePath("./a//b/./c.md"), "a/b/c.md");
  assert.equal(safeArchivePath("dir\\sub\\file.txt"), "dir/sub/file.txt");
  assert.equal(safeArchivePath("x".repeat(401)), null);
});

test("an archive never unpacks to more than it announces, and not to more than is allowed", () => {
  const big = Buffer.alloc(300_000, 0x61);
  const packed = writeZip([{ path: "big.txt", data: big }]);
  assert.ok(packed.length < 2000, "three hundred thousand letters pack to almost nothing");

  // Larger than one entry may be: left out, not unpacked.
  const small = readZip(packed, { ...LIMITS, maxEntryBytes: 1000 });
  assert.deepEqual(small.entries, []);
  assert.match(small.leftOut[0]!.reason, /larger than/);

  // More than all entries together may be: refused before anything is unpacked.
  assert.throws(() => readZip(packed, { ...LIMITS, maxEntryBytes: 1_000_000, maxTotalBytes: 100_000 }), /unpacks to/);

  // An archive that says "10 bytes" of what unpacks to 300,000: the size is
  // written in two places, the table of contents is the one that counts.
  const lying = Buffer.from(packed);
  const central = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, central + 24);
  assert.throws(() => readZip(lying, { ...LIMITS, maxEntryBytes: 1_000_000 }), ZipError);

  // Too many entries.
  const many = writeZip(Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`, "x")));
  assert.throws(() => readZip(many, { ...LIMITS, maxEntries: 10 }), /lists 12 entries/);
});

test("what is not an archive, or a damaged one, is refused with words", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all, just text that is long enough"), LIMITS), ZipError);
  assert.throws(() => readZip(Buffer.alloc(5), LIMITS), ZipError);
  const packed = writeZip([file("a.txt", "some text that is in the archive ".repeat(20))]);
  assert.throws(() => readZip(packed.subarray(0, packed.length - 30), LIMITS), ZipError);
  const flipped = Buffer.from(packed);
  flipped[40] = flipped[40]! ^ 0xff;
  assert.throws(() => readZip(flipped, LIMITS), ZipError);
  assert.equal(looksLikeZip(Buffer.from("PK")), false);
  assert.equal(looksLikeZip(Buffer.from("hello")), false);
});

test("an encrypted entry is left out", () => {
  const packed = writeZip([file("secret.txt", "x"), file("plain.txt", "y")]);
  const central = packed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  packed.writeUInt16LE(packed.readUInt16LE(central + 8) | 1, central + 8);
  const { entries, leftOut } = readZip(packed, LIMITS);
  assert.deepEqual(entries.map((e) => e.path), ["plain.txt"]);
  assert.deepEqual(leftOut, [{ path: "secret.txt", reason: "it is encrypted" }]);
});

// ─── Front matter ────────────────────────────────────────────────────────────

test("front matter: the YAML that skills are written in", () => {
  const yaml = [
    "name: minecraft-plugin",
    'description: "Build a Paper plugin: commands, events, config."',
    "license: 'MIT'",
    "allowed-tools: [Read, Write, \"Bash\"]",
    "tags:",
    "  - minecraft",
    "  - java",
    "metadata:",
    "  version: \"1.2\"",
    "  author: Someone",
    "long: >",
    "  First line",
    "  goes on.",
    "",
    "  Second paragraph.",
    "kept: |",
    "  line one",
    "  line two",
    "going: starts here",
    "  and goes on here",
    "empty:",
    "# a comment",
  ].join("\n");
  assert.deepEqual(parseFrontMatter(yaml), {
    name: "minecraft-plugin",
    description: "Build a Paper plugin: commands, events, config.",
    license: "MIT",
    "allowed-tools": "Read, Write, Bash",
    tags: "minecraft, java",
    "metadata.version": "1.2",
    "metadata.author": "Someone",
    long: "First line goes on.\nSecond paragraph.",
    kept: "line one\nline two",
    going: "starts here and goes on here",
    empty: "",
  });
});

test("front matter is split from the instructions, and a text without it is all instructions", () => {
  const withIt = splitFrontMatter("---\nname: a\n---\n\n# Body\ntext\n");
  assert.deepEqual(withIt.frontMatter, { name: "a" });
  assert.equal(withIt.body, "\n# Body\ntext\n");
  const without = splitFrontMatter("# Only a body\n\n---\n\nA rule, not front matter.\n");
  assert.deepEqual(without.frontMatter, {});
  assert.match(without.body, /^# Only a body/);
  // Not closed: nothing is taken for front matter.
  assert.deepEqual(splitFrontMatter("---\nname: a\n\n# Body\n").frontMatter, {});
});

// ─── A skill ─────────────────────────────────────────────────────────────────

test("a SKILL.md: name and description from the front matter", () => {
  const skill = parseSkillMarkdown(
    "---\nname: product-video\ndescription: Plan a product video. Use when a task is a product film.\nlicense: MIT\n---\n\n# Product video\n\nSteps.\n",
    "fallback",
  );
  assert.equal(skill.name, "product-video");
  assert.equal(skill.description, "Plan a product video. Use when a task is a product film.");
  assert.equal(skill.instructions, "# Product video\n\nSteps.");
  assert.deepEqual(skill.metadata, { license: "MIT" });
});

test("a Markdown file without front matter: the heading is the name, the first paragraph the description", () => {
  const skill = parseSkillMarkdown("# Shop pages that sell\n\nHow we build product pages.\nNo filler.\n\n## Steps\n1. One\n", "from-file");
  assert.equal(skill.name, "Shop pages that sell");
  assert.equal(skill.description, "How we build product pages. No filler.");
  const plain = parseSkillMarkdown("Just do the thing well.\n", "from-file");
  assert.equal(plain.name, "from-file");
  assert.equal(plain.description, "Just do the thing well.");
});

test("a skill without a name, an empty one and one that is too long are refused", () => {
  assert.throws(() => parseSkillMarkdown("some text", ""), SkillParseError);
  assert.throws(() => parseSkillMarkdown("---\nname: x\n---\n", "x"), /is empty/);
  assert.throws(() => parseSkillMarkdown(`# Long\n${"word ".repeat(SKILL_INSTRUCTIONS_MAX / 4)}`, "x"), /at most/);
});

test("an upload is read by what it is, not by what it is called", () => {
  const md = parseSkillUpload("my_notes.MD", Buffer.from("\ufeff# Notes\r\n\r\nWindows line ends.\r\n"));
  assert.equal(md.skills.length, 1);
  assert.equal(md.skills[0]!.name, "Notes");
  assert.equal(md.skills[0]!.instructions, "# Notes\n\nWindows line ends.");

  const txt = parseSkillUpload("server setup.txt", Buffer.from("Install Java 21 first.\n"));
  assert.equal(txt.skills[0]!.name, "server setup");

  // A .skill is a ZIP, whatever its name says.
  const packed = writeZip([file("SKILL.md", "---\nname: zipped\ndescription: d\n---\nBody\n"), file("ref/a.md", "A\n")]);
  for (const name of ["thing.skill", "thing.zip", "thing.bin", "SKILL.md"]) {
    const parsed = parseSkillUpload(name, packed);
    assert.equal(parsed.skills[0]!.name, "zipped", name);
    assert.deepEqual(parsed.skills[0]!.files, [{ path: "ref/a.md", content: "A\n" }], name);
  }

  assert.throws(() => parseSkillUpload("x.md", Buffer.alloc(0)), /empty/);
  assert.throws(() => parseSkillUpload("picture.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0xff, 0xfe])), /neither text nor a ZIP/);
});

test("an archive made elsewhere becomes a skill with its text files; the rest is said", () => {
  const { skills, leftOut } = parseSkillUpload("brochure.skill", MADE_ELSEWHERE);
  assert.equal(skills.length, 1);
  const skill = skills[0]!;
  assert.equal(skill.name, "brochure-layout");
  assert.equal(skill.description, "Lay out a brochure. Use when a task asks for a brochure or a catalogue.");
  assert.match(skill.instructions, /^# Brochure layout/);
  assert.deepEqual(skill.metadata, { license: "MIT" });
  assert.deepEqual(skill.files, [{ path: "references/grid.md", content: "# Grid\n\nTwelve columns, 8 mm gutters.\n" }]);
  assert.equal(leftOut.length, 3);
  assert.ok(leftOut.some((l) => l.startsWith("my-skill/assets/logo.png: it is not text")));
  assert.ok(leftOut.some((l) => l.startsWith("../outside.txt")));
  assert.ok(leftOut.some((l) => l.startsWith("my-skill/link-to-etc")));
});

test("an archive of several skill folders gives several skills, each with its own files", () => {
  const packed = writeZip([
    file("pack/alpha/SKILL.md", "---\nname: alpha\ndescription: first\n---\nA\n"),
    file("pack/alpha/notes.md", "alpha notes\n"),
    file("pack/alpha/nested/SKILL.md", "---\nname: nested\ndescription: inside alpha\n---\nN\n"),
    file("pack/alpha/nested/deep.md", "deep\n"),
    file("pack/beta/skill.md", "# Beta\n\nSecond.\n"),
    file("pack/README.md", "about the pack\n"),
    file("pack/.git/config", "junk\n"),
  ]);
  const { skills } = parseSkillUpload("pack.zip", packed);
  assert.deepEqual(skills.map((s) => s.name).sort(), ["Beta", "alpha", "nested"]);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.deepEqual(byName.get("alpha")!.files, [{ path: "notes.md", content: "alpha notes\n" }]);
  assert.deepEqual(byName.get("nested")!.files, [{ path: "deep.md", content: "deep\n" }]);
  assert.deepEqual(byName.get("Beta")!.files, []);
});

test("an archive without a SKILL.md: one Markdown file is the skill, several are a question", () => {
  const one = parseSkillUpload("guide.zip", writeZip([file("guide/how-to.md", "# How to\n\nDo it.\n"), file("guide/data.csv", "a,b\n")]));
  assert.equal(one.skills[0]!.name, "How to");
  assert.deepEqual(one.skills[0]!.files, [{ path: "data.csv", content: "a,b\n" }]);
  assert.throws(() => parseSkillUpload("two.zip", writeZip([file("a.md", "# A\nx\n"), file("b.md", "# B\ny\n")])), /several Markdown files/);
  assert.throws(() => parseSkillUpload("none.zip", writeZip([file("a.txt", "x\n")])), /no SKILL\.md/);
});

test("a file of an archive that is too large is left out, and the skill is still taken", () => {
  const packed = writeZip([file("SKILL.md", "# S\n\nBody.\n"), file("huge.md", "x".repeat(SKILL_FILE_MAX_BYTES + 1)), file("ok.md", "fine\n")]);
  const { skills, leftOut } = parseSkillUpload("s.skill", packed);
  assert.deepEqual(skills[0]!.files.map((f) => f.path), ["ok.md"]);
  assert.match(leftOut[0]!, /^huge\.md: it is larger than/);
});

test("a skill as JSON, one or a list", () => {
  const one = parseSkillUpload(
    "s.json",
    Buffer.from(JSON.stringify({ name: "From JSON", description: "d", instructions: "Do it.\n", files: [{ path: "a/b.md", content: "B" }, { path: "../x", content: "no" }] })),
  );
  assert.equal(one.skills[0]!.name, "From JSON");
  assert.deepEqual(one.skills[0]!.files, [{ path: "a/b.md", content: "B" }]);
  assert.equal(one.leftOut.length, 1);
  const two = parseSkillUpload("list.json", Buffer.from(JSON.stringify([{ name: "A", instructions: "a" }, { name: "B", instructions: "b" }])));
  assert.deepEqual(two.skills.map((s) => s.name), ["A", "B"]);
  assert.throws(() => parseSkillUpload("bad.json", Buffer.from('{"name": "no instructions"}')), /JSON/);
  // Markdown that happens to start with a bracket is still Markdown.
  assert.equal(parseSkillUpload("list.md", Buffer.from("[x] a checklist\n")).skills[0]!.name, "list");
});

test("a skill written out as SKILL.md reads back as the same skill", () => {
  const skill = {
    name: "Name: with a colon",
    description: 'Says "hello" # and more',
    instructions: "# Title\n\nBody.",
    metadata: { license: "MIT", version: "1.0" },
  };
  const back = parseSkillMarkdown(skillMarkdown(skill), "x");
  assert.equal(back.name, skill.name);
  assert.equal(back.description, skill.description);
  assert.equal(back.instructions, skill.instructions);
  assert.deepEqual(back.metadata, skill.metadata);
});

test("bytes that are not text are told from bytes that are", () => {
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x00])), null);
  assert.equal(decodeText(Buffer.from("a\u0000b")), null);
  assert.equal(decodeText(Buffer.from("héllo\r\nwörld")), "héllo\nwörld");
});

// ─── The prompt ──────────────────────────────────────────────────────────────

const skill = (name: string, instructions: string, files: PromptSkill["files"] = []): PromptSkill => ({
  name,
  description: `What ${name} is for.`,
  instructions,
  files,
});

test("no skills, no words", () => {
  assert.equal(skillsBlock([], { canRead: true }), "");
  assert.equal(skillNames([]), "");
});

test("a skill is given in full, with its files named when they can be read", () => {
  const block = skillsBlock([skill("shop-design", "Use a real grid.\nNo filler copy.", [{ path: "refs/type.md", sizeBytes: 2048 }])], { canRead: true });
  assert.ok(block.startsWith("\n\nYou have a skill for this work"));
  assert.match(block, /### Skill: shop-design\nWhat shop-design is for\.\n\nUse a real grid\.\nNo filler copy\./);
  assert.match(block, /Files of this skill: refs\/type\.md \(2\.0 KB\)\. Read one with read_skill/);
  const noTool = skillsBlock([skill("shop-design", "Use a real grid.", [{ path: "refs/type.md", sizeBytes: 10 }])], { canRead: false });
  assert.doesNotMatch(noTool, /read_skill/);
});

test("what does not fit is cut at a line and said, and what has no room at all is named", () => {
  const long = Array.from({ length: 400 }, (_, i) => `Rule ${i}: do this exactly.`).join("\n");
  const block = skillsBlock([skill("first", long), skill("second", long), skill("third", "Short.")], {
    canRead: true,
    perSkillChars: 2000,
    totalChars: 2300,
  });
  const first = block.slice(block.indexOf("### Skill: first"), block.indexOf("### Skill: second"));
  assert.ok(first.length < 2400);
  assert.match(first, /Rule 0: do this exactly\./);
  assert.match(first, /\(The rest of this skill is not shown here: \d+ more characters\. Read all of it with read_skill/);
  assert.doesNotMatch(first, /Rule \d+: do this exac\n/, "not cut in the middle of a line");
  const second = block.slice(block.indexOf("### Skill: second"), block.indexOf("### Skill: third"));
  assert.match(second, /\(Not shown here\. Read it with read_skill when the task calls for it\.\)/);
  assert.doesNotMatch(second, /Rule 0/);
  // A short one still fits in what is left.
  assert.match(block.slice(block.indexOf("### Skill: third")), /Short\./);
  assert.match(skillsBlock([skill("a", long)], { canRead: false, perSkillChars: 500 }), /\(This skill is shortened here\.\)/);
});

test("an agent is told about a dozen skills at most, and how many more there are", () => {
  const many = Array.from({ length: SKILLS_PER_TASK_MAX + 3 }, (_, i) => skill(`s${i}`, "x"));
  const block = skillsBlock(many, { canRead: true });
  assert.equal(block.match(/### Skill: /g)!.length, SKILLS_PER_TASK_MAX);
  assert.match(block, /\(3 more skills are not shown/);
  assert.equal(skillNames(many, 2), `s0, s1, +${SKILLS_PER_TASK_MAX + 1}`);
});
