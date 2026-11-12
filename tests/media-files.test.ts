import assert from "node:assert/strict";
import { test } from "node:test";
import { computeImageCost, computeVideoCost } from "../src/lib/media/cost";
import {
  downloadName,
  isMediaFileName,
  mediaFileName,
  mimeForFileName,
  parseRange,
  sniffMedia,
} from "../src/lib/media/files";

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

// ─── What a stored file may be ───────────────────────────────────────────────

test("sniffMedia recognises the image formats providers return", () => {
  assert.deepEqual(sniffMedia(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], "....")), {
    kind: "image",
    mime: "image/png",
    ext: "png",
  });
  assert.deepEqual(sniffMedia(bytes([0xff, 0xd8, 0xff, 0xe0], "..JFIF")), {
    kind: "image",
    mime: "image/jpeg",
    ext: "jpg",
  });
  assert.equal(sniffMedia(bytes("GIF89a", [1, 0, 1, 0]))?.mime, "image/gif");
  assert.equal(sniffMedia(bytes("GIF87a"))?.mime, "image/gif");
  assert.equal(sniffMedia(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "))?.mime, "image/webp");
});

test("sniffMedia recognises video containers", () => {
  assert.deepEqual(sniffMedia(bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0])), {
    kind: "video",
    mime: "video/mp4",
    ext: "mp4",
  });
  assert.equal(sniffMedia(bytes([0, 0, 0, 0x18], "ftypmp42"))?.mime, "video/mp4");
  assert.deepEqual(sniffMedia(bytes([0, 0, 0, 0x14], "ftypqt  ")), {
    kind: "video",
    mime: "video/quicktime",
    ext: "mov",
  });
  assert.equal(sniffMedia(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))?.mime, "video/webm");
});

test("sniffMedia refuses everything else, whatever it claims to be", () => {
  // Files that could run script when served from the app's origin.
  assert.equal(sniffMedia(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffMedia(bytes("<?xml version=\"1.0\"?><svg>")), null);
  assert.equal(sniffMedia(bytes("<!DOCTYPE html><script>")), null);
  // Still images in a video-style container.
  assert.equal(sniffMedia(bytes([0, 0, 0, 0x18], "ftypheic")), null);
  assert.equal(sniffMedia(bytes([0, 0, 0, 0x1c], "ftypavif")), null);
  // A RIFF file that is not WebP (WAV, AVI).
  assert.equal(sniffMedia(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ")), null);
  assert.equal(sniffMedia(bytes('{"error":"nope"}')), null);
  assert.equal(sniffMedia(new Uint8Array(0)), null);
  assert.equal(sniffMedia(bytes([0x89], "PN")), null);
});

// ─── File names ──────────────────────────────────────────────────────────────

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b";

test("media file names are an id plus an allowed extension", () => {
  assert.equal(mediaFileName(ID, "png"), `${ID}.png`);
  assert.ok(isMediaFileName(`${ID}.mp4`));
  assert.ok(isMediaFileName(`${ID}.webm`));
  assert.throws(() => mediaFileName(ID, "svg"));
  assert.throws(() => mediaFileName("../../etc/passwd", "png"));
  assert.throws(() => mediaFileName(ID.toUpperCase(), "png"));
});

test("isMediaFileName rejects anything that could leave the media folder", () => {
  for (const name of [
    "../nexus.db",
    `../${ID}.png`,
    `sub/${ID}.png`,
    `${ID}.png/..`,
    `${ID}.png\u0000.txt`,
    `${ID}.html`,
    `${ID}`,
    "",
    "nexus.db",
  ]) {
    assert.equal(isMediaFileName(name), false, name);
  }
});

test("mimeForFileName answers only for names this app stored", () => {
  const id = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b";
  assert.equal(mimeForFileName(`${id}.png`), "image/png");
  assert.equal(mimeForFileName(`${id}.jpg`), "image/jpeg");
  assert.equal(mimeForFileName(`${id}.gif`), "image/gif");
  assert.equal(mimeForFileName(`${id}.webp`), "image/webp");
  assert.equal(mimeForFileName(`${id}.mp4`), "video/mp4");
  assert.equal(mimeForFileName(`${id}.mov`), "video/quicktime");
  assert.equal(mimeForFileName(`${id}.webm`), "video/webm");
  // Never a type a browser would run or render as a page.
  for (const name of [`${id}.svg`, `${id}.html`, `${id}.js`, "evil.png", `../${id}.png`, `${id}.png.html`, ""]) {
    assert.equal(mimeForFileName(name), null, name);
  }
});

test("downloadName is neutral and keeps the extension", () => {
  assert.equal(downloadName("video", ID, `${ID}.mp4`), "xiero-video-3f2b8c1e.mp4");
  assert.equal(downloadName("image", ID, `${ID}.jpg`), "xiero-image-3f2b8c1e.jpg");
});

// ─── Byte ranges ─────────────────────────────────────────────────────────────

test("parseRange handles the forms a video player sends", () => {
  assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
  assert.deepEqual(parseRange("bytes=500-999", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
  assert.deepEqual(parseRange(" bytes=10-20 ", 1000), { start: 10, end: 20 });
  // An end past the file is clamped; a suffix longer than the file is the file.
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=0-0", 1000), { start: 0, end: 0 });
});

test("parseRange answers 416 for ranges outside the file", () => {
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=5000-6000", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
});

test("parseRange falls back to the whole file for anything else", () => {
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("", 1000), null);
  assert.equal(parseRange("bytes=-", 1000), null);
  assert.equal(parseRange("bytes=0-99,200-299", 1000), null); // several ranges
  assert.equal(parseRange("items=0-5", 1000), null);
  assert.equal(parseRange("bytes=abc-def", 1000), null);
  assert.equal(parseRange("bytes=50-10", 1000), null);
  assert.equal(parseRange("bytes=1e3-", 1000), null);
});

// ─── Cost estimates ──────────────────────────────────────────────────────────

const noPrices = {
  inputPricePerMTok: null,
  outputPricePerMTok: null,
  pricePerImage: null,
  pricePerSecond: null,
};

test("image cost is null without a matching price", () => {
  assert.equal(computeImageCost(noPrices, { images: 4 }), null);
  // Token prices alone do not price an image when no tokens were reported.
  assert.equal(
    computeImageCost({ ...noPrices, inputPricePerMTok: 5, outputPricePerMTok: 40 }, { images: 1 }),
    null,
  );
  // Reported tokens alone do not either.
  assert.equal(computeImageCost(noPrices, { images: 1, inputTokens: 10, outputTokens: 4000 }), null);
});

test("image cost per image", () => {
  assert.equal(computeImageCost({ ...noPrices, pricePerImage: 0.04 }, { images: 3 }), 0.12);
  assert.equal(computeImageCost({ ...noPrices, pricePerImage: 0 }, { images: 3 }), 0);
});

test("image cost per token, for models billed that way", () => {
  const cost = computeImageCost(
    { ...noPrices, inputPricePerMTok: 5, outputPricePerMTok: 40 },
    { images: 1, inputTokens: 1_000, outputTokens: 4_000 },
  );
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - (0.005 + 0.16)) < 1e-12);
});

test("image cost adds both when both prices are set", () => {
  const cost = computeImageCost(
    { ...noPrices, pricePerImage: 0.01, outputPricePerMTok: 10 },
    { images: 2, outputTokens: 1_000_000 },
  );
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - 10.02) < 1e-9);
});

test("video cost is seconds times the per-second price", () => {
  assert.equal(computeVideoCost({ pricePerSecond: 0.5 }, 8), 4);
  assert.equal(computeVideoCost({ pricePerSecond: 0 }, 8), 0);
  assert.equal(computeVideoCost({ pricePerSecond: null }, 8), null);
  assert.equal(computeVideoCost({ pricePerSecond: 0.5 }, null), null);
  assert.equal(computeVideoCost({ pricePerSecond: 0.5 }, 0), null);
});
