import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  CHUNK_CHARS,
  bytesToVector,
  chunkText,
  cosineSimilarity,
  ftsQuery,
  fuseRankings,
  vectorToBytes,
} from "../src/lib/knowledge/chunk";
import {
  ExtractError,
  MAX_DOCUMENT_BYTES,
  decodeText,
  docxXmlToText,
  extensionOf,
  extractDocument,
  looksBinary,
  readZipEntry,
} from "../src/lib/knowledge/extract";
import { decodeEntities, htmlToText, looksLikeHtml } from "../src/lib/text/html";

const bytes = (text: string) => new TextEncoder().encode(text);

// ─── A small ZIP writer, to make .docx files for the tests ───────────────────

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: { name: string; data: Uint8Array; store?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = file.store ? Buffer.from(file.data) : deflateRawSync(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.store ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(file.data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

const DOCUMENT_XML =
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  "<w:p><w:r><w:t>Refund policy</w:t></w:r></w:p>" +
  '<w:p><w:r><w:t xml:space="preserve">Returns are accepted </w:t></w:r><w:r><w:t>within 30 days &amp; free.</w:t></w:r></w:p>' +
  "<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>Price</w:t><w:br/><w:t>Lamp</w:t></w:r></w:p>" +
  "</w:body></w:document>";

function docx(xml = DOCUMENT_XML): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", data: bytes("<Types/>"), store: true },
    { name: "word/document.xml", data: bytes(xml) },
  ]);
}

// ─── Passages ────────────────────────────────────────────────────────────────

test("a short text is one passage; an empty one is none", () => {
  assert.deepEqual(chunkText("  Hello.\r\n\r\n\r\n\r\nWorld.  "), ["Hello.\n\nWorld."]);
  assert.deepEqual(chunkText("   \n  "), []);
});

test("a long text is cut at paragraphs, and each passage starts a little before the last one ended", () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}. ${"word ".repeat(40).trim()}.`);
  const text = paragraphs.join("\n\n");
  const chunks = chunkText(text, 600, 80);
  assert.ok(chunks.length >= 4, String(chunks.length));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 600, `a passage of ${chunk.length} characters`);
    // Cut between paragraphs, not inside a word.
    assert.match(chunk, /\.$/);
  }
  // Nothing is lost: every paragraph's heading is in some passage.
  for (let i = 1; i <= 12; i++) assert.ok(chunks.some((c) => c.includes(`Paragraph ${i}.`)), `paragraph ${i}`);
  // The overlap: a passage begins with the end of the one before.
  const tail = chunks[0]!.slice(-30);
  assert.ok(chunks[1]!.includes(tail.trim().split(" ").slice(-2).join(" ")), "no overlap");
});

test("a text without any break is still cut, at the size limit", () => {
  const chunks = chunkText("x".repeat(3000), 1000, 100);
  assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 1000]);
  assert.equal(chunkText("y".repeat(CHUNK_CHARS)).length, 1);
});

// ─── Queries and ranking ─────────────────────────────────────────────────────

test("a question becomes its words, any of which may match", () => {
  assert.equal(ftsQuery("How long do I have to return an item?"), '"long" OR "do" OR "return" OR "item"');
  // Words are quoted, so query syntax in a question is only text.
  assert.equal(ftsQuery('refund* OR "policy" NEAR(x)'), '"refund" OR "policy" OR "near"');
  assert.equal(ftsQuery("Bagaimana cara mengembalikan barang yang rusak?"), '"cara" OR "mengembalikan" OR "barang" OR "rusak"');
  assert.equal(ftsQuery("Version 2 of 7"), '"version" OR "2" OR "7"');
  assert.equal(ftsQuery("the of and"), null);
  assert.equal(ftsQuery("?!"), null);
  // One-letter words say nothing; no more words than the limit.
  assert.equal(ftsQuery("a b c d e"), null);
  assert.equal(ftsQuery("alpha beta gamma delta", 2), '"alpha" OR "beta"');
  assert.equal(ftsQuery("refund refund Refund"), '"refund"');
});

test("two rankings are merged: what both found comes first", () => {
  const fused = fuseRankings([[1, 2, 3], [3, 1, 4]]);
  assert.deepEqual(fused.map((f) => f.id), [1, 3, 2, 4]);
  assert.ok(fused[0]!.score > fused[2]!.score);
  assert.deepEqual(fuseRankings([[], []]), []);
  assert.deepEqual(fuseRankings([["a"], []]).map((f) => f.id), ["a"]);
});

test("similarity of vectors, and vectors as stored bytes", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  const stored = vectorToBytes([0.5, -1.25, 3]);
  assert.equal(stored.byteLength, 12);
  assert.deepEqual([...bytesToVector(stored)], [0.5, -1.25, 3]);
  // Bytes that do not start on a 4-byte boundary of their buffer.
  const shifted = new Uint8Array(13);
  shifted.set(stored, 1);
  assert.deepEqual([...bytesToVector(shifted.subarray(1))], [0.5, -1.25, 3]);
});

// ─── HTML ────────────────────────────────────────────────────────────────────

test("a page becomes what a reader sees", () => {
  const page = htmlToText(
    "<!doctype html><html><head><title> The &amp; title </title><style>p{color:red}</style><script>track()</script></head>" +
      "<body><!-- note --><nav>Home</nav><h1>Lighthouses</h1><p>Keepers trimmed the wick&nbsp;every four hours &#38; logged it.</p>" +
      '<ul><li>One</li><li>Two</li></ul><p>See <a href="https://example.com/more">the history</a> or <a href="/local">this</a>.</p>' +
      "<table><tr><td>A</td><td>B</td></tr></table><svg><text>hidden</text></svg><noscript>enable JS</noscript></body></html>",
  );
  assert.equal(page.title, "The & title");
  assert.equal(
    page.text,
    "Home\n\nLighthouses\n\nKeepers trimmed the wick every four hours & logged it.\n\n- One\n- Two\n\nSee the history (https://example.com/more) or this .\n\nA | B |",
  );
  for (const hidden of ["track()", "color:red", "hidden", "enable JS", "note"]) assert.ok(!page.text.includes(hidden), hidden);
});

test("entities are decoded; what is not an entity is left alone", () => {
  assert.equal(decodeEntities("&lt;b&gt; &quot;x&quot; &#65;&#x42; &hellip; &unknown; &#0; AT&T"), '<b> "x" AB … &unknown; &#0; AT&T');
  assert.equal(looksLikeHtml("<!DOCTYPE html><html>"), true);
  assert.equal(looksLikeHtml("  <html lang=en>"), true);
  assert.equal(looksLikeHtml("A text that mentions <b>bold</b>."), false);
});

// ─── Documents ───────────────────────────────────────────────────────────────

test("text files are read as they are, in the encoding their first bytes name", async () => {
  const plain = await extractDocument("notes.txt", bytes("  Hello\nworld  "));
  assert.deepEqual(plain, { text: "Hello\nworld", mimeType: "text/plain" });
  assert.equal((await extractDocument("README.md", bytes("# Title"))).mimeType, "text/markdown");
  assert.equal((await extractDocument("data.csv", bytes("a,b\n1,2"))).mimeType, "text/csv");
  assert.equal((await extractDocument("data.json", bytes('{"a":1}'))).mimeType, "application/json");
  // A byte-order mark is not part of the text.
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69])), "Hi");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])), "Hi");
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), "Hi");
  assert.equal(extensionOf("Archive.TAR.GZ"), "gz");
  assert.equal(extensionOf("Makefile"), "");
});

test("an HTML file, or text that is HTML, is read as a page", async () => {
  const doc = await extractDocument("page.html", bytes("<html><head><title>Hours</title></head><body><p>Open nine to five.</p></body></html>"));
  assert.deepEqual(doc, { text: "Open nine to five.", title: "Hours", mimeType: "text/html" });
  const unnamed = await extractDocument("download", bytes("<!doctype html><html><body><h1>Hi</h1></body></html>"));
  assert.equal(unnamed.text, "Hi");
  // A source file that contains HTML stays a source file.
  const source = await extractDocument("view.tsx", bytes("<html><body>{x}</body></html>"));
  assert.equal(source.text, "<html><body>{x}</body></html>");
});

test("a Word document: paragraphs, tabs and line breaks", async () => {
  const doc = await extractDocument("policy.docx", docx());
  assert.equal(doc.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(doc.text, "Refund policy\nReturns are accepted within 30 days & free.\nName\tPrice\nLamp");
  assert.equal(docxXmlToText("<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p></w:p><w:p></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>"), "One\n\nTwo");
  // The archive reader finds a stored and a compressed entry, and says when one is not there.
  const archive = docx();
  assert.equal(new TextDecoder().decode(readZipEntry(archive, "[Content_Types].xml")!), "<Types/>");
  assert.equal(readZipEntry(archive, "word/missing.xml"), null);
});

test("a PDF is read by the reader that is passed in", async () => {
  const pdf = bytes("%PDF-1.4 …");
  const doc = await extractDocument("terms.pdf", pdf, { readPdf: async () => "Page one.\n\nPage two." });
  assert.deepEqual(doc, { text: "Page one.\n\nPage two.", mimeType: "application/pdf" });
  // The content decides, not the name.
  assert.equal((await extractDocument("terms.txt", pdf, { readPdf: async () => "Text" })).mimeType, "application/pdf");
});

test("what cannot be read says why", async () => {
  const fails = (name: string, data: Uint8Array, message: RegExp, opts = {}) =>
    assert.rejects(extractDocument(name, data, opts), (err: unknown) => err instanceof ExtractError && message.test(err.message), name);
  await fails("empty.txt", new Uint8Array(0), /empty/);
  await fails("blank.txt", bytes("   \n "), /No text was found/);
  await fails("tool.exe", new Uint8Array([0x4d, 0x5a, 0, 0, 1, 2, 3]), /not text/);
  await fails("old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), /Old Word files/);
  await fails("scan.pdf", bytes("%PDF-1.7"), /probably a scan/, { readPdf: async () => "  " });
  await fails("locked.pdf", bytes("%PDF-1.7"), /damaged or protected/, {
    readPdf: async () => {
      throw new Error("PasswordException");
    },
  });
  await fails("terms.pdf", bytes("%PDF-1.7"), /cannot be read on this server/);
  await fails("sheet.xlsx", zip([{ name: "xl/workbook.xml", data: bytes("<x/>") }]), /\.xlsx files are not supported/);
  await fails("letter.docx", zip([{ name: "other.xml", data: bytes("<x/>") }]), /not a Word document/);
  await fails("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]), /not a valid archive/);
  await fails("huge.txt", new Uint8Array(MAX_DOCUMENT_BYTES + 1), /larger than 15 MB/);
  assert.equal(looksBinary(bytes("plain text\nwith lines\tand tabs")), false);
  assert.equal(looksBinary(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), true);
  assert.equal(looksBinary(new Uint8Array(0)), false);
});
