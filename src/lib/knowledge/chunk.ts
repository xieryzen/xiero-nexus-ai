/**
 * Splitting a document into passages, and ranking passages for a question.
 * Pure, so it can be unit-tested.
 */

export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;

/** Positions where a text can be cut, best first. */
const BREAKS: RegExp[] = [/\n\s*\n/g, /\n/g, /(?<=[.!?。！？])\s+/g, /\s+/g];

/** The last break of a kind that ends between `min` and `max`. */
function lastBreak(text: string, min: number, max: number): number {
  for (const pattern of BREAKS) {
    pattern.lastIndex = min;
    let best = -1;
    for (;;) {
      const match = pattern.exec(text);
      if (!match) break;
      const end = match.index + match[0].length;
      if (end > max) break;
      best = end;
      if (match[0].length === 0) pattern.lastIndex++;
    }
    if (best !== -1) return best;
  }
  return max;
}

/**
 * Cut a text into passages of about `size` characters that end at a paragraph,
 * a line or a sentence where they can. Each passage starts a little before the
 * previous one ended, so a sentence that sits on a cut is whole in one of
 * them.
 */
export function chunkText(input: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const text = input.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= size) {
      chunks.push(text.slice(start).trim());
      break;
    }
    // Do not cut in the first half: that would make very small passages.
    const end = lastBreak(text, start + Math.floor(size / 2), start + size);
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    // Step back for the overlap, to a word boundary.
    let next = Math.max(end - overlap, start + 1);
    const space = text.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    else next = end;
    start = next;
  }
  return chunks.filter(Boolean);
}

/**
 * A question as a full-text query: its words, any of which may match. Words
 * are quoted so that punctuation in them is not read as query syntax. Returns
 * null when nothing searchable is left.
 */
export function ftsQuery(question: string, maxTerms = 24): string | null {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 2 && !/\p{N}/u.test(raw)) continue;
    if (STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(`"${raw}"`);
    if (terms.length >= maxTerms) break;
  }
  return terms.length > 0 ? terms.join(" OR ") : null;
}

/** Words that say nothing about what a question is about (English, Indonesian). */
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have how if in into is it its of on or that the their " +
    "then there these this to was were what when where which who why will with you your " +
    "ada adalah agar akan apa atau bagaimana bagi dan dari dengan di ini itu juga karena ke " +
    "kepada oleh pada saat saya sebagai sudah untuk yang"
  ).split(" "),
);

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Merge ranked lists into one (reciprocal rank fusion): an item scores
 * 1 / (k + rank) in every list it is in. Returns ids, best first.
 */
export function fuseRankings<T>(lists: T[][], k = 60): { id: T; score: number }[] {
  const scores = new Map<T, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** A vector as the bytes stored in the database (32-bit floats). */
export function vectorToBytes(vector: number[]): Uint8Array {
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  // Copy: the bytes may not start on a 4-byte boundary of their buffer.
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 4));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Float32Array(copy.buffer);
}
