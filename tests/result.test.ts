import test from "node:test";
import assert from "node:assert/strict";
import { buildOf, byFolder, downloadSlug, fileKind, isPackage, keepPatterns, matchesPattern, safePattern, siteContentType, siteOf, sizeLabel } from "../src/lib/result/kinds";
import { parseInline, parseMarkdown, plainText, safeHref, looksLikeMarkdown } from "../src/lib/result/markdown";
import { readSiteToken, signSiteToken, siteKeyFrom } from "../src/lib/result/site-token";
import { zipBuffer, archivePath } from "../src/lib/result/zip";
import { readZip } from "../src/lib/skills/zip";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("kinds", () => {
  assert.equal(fileKind("index.html"), "page");
  assert.equal(fileKind("a/b/Main.java"), "code");
  assert.equal(fileKind("plugin.yml"), "data");
  assert.equal(fileKind("README.md"), "document");
  assert.equal(fileKind("logo.svg"), "image");
  assert.equal(fileKind("Dockerfile"), "code");
  assert.equal(fileKind("LICENSE"), "text");
  assert.deepEqual(siteOf(["a.css", "docs/x.md"]), null);
  assert.deepEqual(siteOf(["site/about.html", "site/index.html", "x/y/index.html"]), { entry: "site/index.html", pages: ["site/index.html", "site/about.html", "x/y/index.html"] });
  assert.equal(siteOf(["page.html", "site/index.html"])?.entry, "site/index.html");
  assert.equal(siteOf(["index.html", "site/index.html"])?.entry, "index.html");
  assert.equal(siteOf(["b.html", "a.html"])?.entry, "a.html");
  assert.equal(siteContentType("a.css"), "text/css; charset=utf-8");
  assert.equal(siteContentType("a.java"), "text/plain; charset=utf-8");
});

test("build", () => {
  assert.equal(buildOf(["src/main/java/A.java"]), null);
  assert.deepEqual(buildOf(["build.gradle.kts", "settings.gradle.kts", "pom.xml"])?.command, "gradle build -x test --console=plain -q");
  assert.deepEqual(buildOf(["pom.xml"])?.command, "mvn -B -ntp -q -DskipTests package");
  assert.deepEqual(buildOf(["CEnchantGUI/build.gradle.kts"]), { tool: "gradle", label: "Gradle", file: "CEnchantGUI/build.gradle.kts", command: "gradle -p CEnchantGUI build -x test --console=plain -q", outputs: ["CEnchantGUI/build/libs/*.jar", "CEnchantGUI/*/build/libs/*.jar"] });
  assert.equal(buildOf(["plugin/pom.xml"])?.command, "mvn -B -ntp -q -DskipTests -f plugin/pom.xml package");
  assert.equal(buildOf(["my plugin/pom.xml"]), null);
  assert.equal(buildOf(["core/build.gradle", "pom.xml"])?.tool, "maven");
  assert.equal(buildOf(["build/pom.xml"]), null);
});

test("patterns", () => {
  assert.equal(matchesPattern("build/libs/*.jar", "build/libs/a-1.0.jar"), true);
  assert.equal(matchesPattern("build/libs/*.jar", "build/libs/x/a.jar"), false);
  assert.equal(matchesPattern("*/build/libs/*.jar", "core/build/libs/a.jar"), true);
  assert.equal(matchesPattern("**/target/*.jar", "target/a.jar"), true);
  assert.equal(matchesPattern("**/target/*.jar", "a/b/target/a.jar"), true);
  assert.equal(matchesPattern("dist/**", "dist/a/b.txt"), true);
  assert.equal(matchesPattern("a.b", "aXb"), false);
  assert.equal(matchesPattern("a?c", "abc"), true);
  assert.equal(matchesPattern("a?c", "a/c"), false);
  assert.equal(matchesPattern("(x)+[y]", "(x)+[y]"), true);
  assert.equal(isPackage("build/libs/a-1.0.jar"), true);
  assert.equal(isPackage("build/libs/a-1.0-sources.jar"), false);
  assert.equal(isPackage("target/original-a-1.0.jar"), false);
  assert.equal(safePattern("../x"), null);
  assert.equal(safePattern("/etc/*"), null);
  assert.equal(safePattern("a/$(x)"), null);
  assert.equal(safePattern(" out/*.zip "), "out/*.zip");
  assert.equal(keepPatterns(["out/*.zip", "../x", "target/*.jar"])[0], "out/*.zip");
  assert.equal(keepPatterns(["target/*.jar"]).filter((p) => p === "target/*.jar").length, 1);
});

test("folders, sizes, names", () => {
  assert.deepEqual(byFolder([{ path: "b/x" }, { path: "a" }, { path: "b/a" }, { path: "a/z/q" }]).map((g) => [g.folder, g.files.map((f) => f.path)]), [["", ["a"]], ["a/z", ["a/z/q"]], ["b", ["b/a", "b/x"]]]);
  assert.equal(sizeLabel(12), "12 B");
  assert.equal(sizeLabel(2048), "2.0 KB");
  assert.equal(sizeLabel(48_213), "47 KB");
  assert.equal(sizeLabel(5 * 1024 * 1024), "5.0 MB");
  assert.equal(downloadSlug("Website Portofolio Xiero"), "Website-Portofolio-Xiero");
  assert.equal(downloadSlug("日本"), "project");
});

test("token", () => {
  const key = siteKeyFrom(Buffer.alloc(32, 3));
  const id = "0a98f8fe-91a4-4a57-a863-7c02afa85149";
  const now = 1_800_000_000_000;
  const token = signSiteToken(key, id, now + 3600_000);
  assert.deepEqual(readSiteToken(key, token, now), { projectId: id, expiresAt: Math.floor((now + 3600_000) / 1000) * 1000 });
  assert.equal(readSiteToken(key, token, now + 3600_001), null);
  assert.equal(readSiteToken(siteKeyFrom(Buffer.alloc(32, 4)), token, now), null);
  assert.equal(readSiteToken(key, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), now), null);
  const [a, b, c] = token.split(".");
  assert.equal(readSiteToken(key, `${a}.${(Number.parseInt(b!, 36) + 999).toString(36)}.${c}`, now), null);
  assert.equal(readSiteToken(key, "x.y.z", now), null);
  assert.throws(() => signSiteToken(key, "../../etc", now));
});

test("zip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const big = Buffer.alloc(300_000, 7);
  writeFileSync(join(dir, "a.jar"), big);
  writeFileSync(join(dir, "empty.bin"), "");
  const buf = await zipBuffer([
    { path: "index.html", data: Buffer.from("<h1>hi</h1>".repeat(100)) },
    { path: "src/main/A.java", data: Buffer.from("class A {}") },
    { path: "build/libs/a.jar", file: join(dir, "a.jar"), size: big.length },
    { path: "empty.bin", file: join(dir, "empty.bin"), size: 0 },
    { path: "gone.bin", file: join(dir, "nope"), size: 5 },
    { path: "../evil", data: Buffer.from("x") },
    { path: "index.html", data: Buffer.from("second") },
    { path: "ü/naïve.txt", data: Buffer.from("") },
  ]);
  const read = readZip(buf, { maxEntries: 100, maxEntryBytes: 1_000_000, maxTotalBytes: 5_000_000 });
  assert.deepEqual(read.leftOut, []);
  assert.deepEqual(read.entries.map((e) => [e.path, e.data.length]), [["index.html", 1100], ["src/main/A.java", 10], ["build/libs/a.jar", 300_000], ["empty.bin", 0], ["ü/naïve.txt", 0]]);
  assert.equal(read.entries[0]!.data.toString(), "<h1>hi</h1>".repeat(100));
  assert.ok(read.entries[2]!.data.equals(big));
  assert.equal(archivePath("a//b/./c"), "a/b/c");
  assert.equal(archivePath("a/../b"), null);
});

test("markdown blocks", () => {
  const md = parseMarkdown("# Title\n\nSome **bold** and `code` text\nsecond line.\n\n- one\n- two\n  - nested `x`\n- [x] done\n\n1. first\n2. second\n\n```java\nclass A {}\n```\n\n> quote\n> more\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |\n\n---\n");
  assert.deepEqual(md.map((b) => b.type), ["heading", "paragraph", "list", "list", "code", "quote", "table", "rule"]);
  const list = md[2] as Extract<(typeof md)[number], { type: "list" }>;
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[1]!.children.map((b) => b.type), ["paragraph", "list"]);
  assert.equal(list.items[2]!.checked, true);
  const ordered = md[3] as Extract<(typeof md)[number], { type: "list" }>;
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.items.length, 2);
  const code = md[4] as Extract<(typeof md)[number], { type: "code" }>;
  assert.deepEqual([code.lang, code.text], ["java", "class A {}"]);
  const table = md[6] as Extract<(typeof md)[number], { type: "table" }>;
  assert.deepEqual(table.align, [null, "center"]);
  assert.equal(table.rows.length, 2);
  assert.equal(plainText(table.rows[1]![1]!), "");
  const para = md[1] as Extract<(typeof md)[number], { type: "paragraph" }>;
  assert.equal(plainText(para.children), "Some bold and code text second line.");
});

test("markdown inline", () => {
  assert.deepEqual(parseInline("a **b** c"), [{ type: "text", text: "a " }, { type: "strong", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }]);
  assert.deepEqual(parseInline("file_name_here.md and snake_case"), [{ type: "text", text: "file_name_here.md and snake_case" }]);
  assert.deepEqual(parseInline("_it_ works"), [{ type: "em", children: [{ type: "text", text: "it" }] }, { type: "text", text: " works" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ type: "text", text: "x" }]);
  assert.deepEqual(parseInline("[x](https://e.com/a_(b))"), [{ type: "link", href: "https://e.com/a_(b)", children: [{ type: "text", text: "x" }] }]);
  assert.deepEqual(parseInline("see https://example.com/a?b=1."), [{ type: "text", text: "see " }, { type: "link", href: "https://example.com/a?b=1", children: [{ type: "text", text: "https://example.com/a?b=1" }] }, { type: "text", text: "." }]);
  assert.deepEqual(parseInline("<script>alert(1)</script>"), [{ type: "text", text: "<script>alert(1)</script>" }]);
  assert.deepEqual(parseInline("`a_b_c` \\*x\\*"), [{ type: "code", text: "a_b_c" }, { type: "text", text: " *x*" }]);
  assert.deepEqual(parseInline("![alt](https://e.com/p.png)"), [{ type: "link", href: "https://e.com/p.png", children: [{ type: "text", text: "alt" }] }]);
  assert.deepEqual(parseInline("[spec](design/xiero-spec.md)"), [{ type: "link", href: "design/xiero-spec.md", children: [{ type: "text", text: "spec" }] }]);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("//evil.com"), null);
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(looksLikeMarkdown("plain words\nmore"), false);
  assert.equal(looksLikeMarkdown("# T\nx"), true);
  assert.equal(parseInline("***both***").length, 1);
  assert.deepEqual(parseInline("~~no~~"), [{ type: "del", children: [{ type: "text", text: "no" }] }]);
});

test("markdown: hard cases do not hang or lose text", () => {
  const nasty = "* ".repeat(2000) + "\n" + "**a".repeat(2000) + "\n" + "_".repeat(3000) + "\n" + "- ".repeat(500) + "\n" + "> ".repeat(50) + "x\n" + "|".repeat(500) + "\n|-|\n";
  const started = Date.now();
  const blocks = parseMarkdown(nasty);
  assert.ok(blocks.length > 0);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.deepEqual(parseMarkdown("1. a\n\n   still a\n\n2. b\n\ntext").map((b) => b.type), ["list", "paragraph"]);
  assert.deepEqual(parseMarkdown("para\n- item\nlazy\n\n```\nunclosed").map((b) => b.type), ["paragraph", "list", "code"]);
  assert.deepEqual(parseMarkdown("2024. was a year\nnext").map((b) => b.type), ["list"]);
});
