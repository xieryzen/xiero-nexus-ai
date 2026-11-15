/**
 * The family name inside a font file. Pure.
 *
 * The subtitle renderer chooses a font by its family name, not by its file:
 * with a name that matches nothing it silently uses some other font, or none.
 * So the name is read from the file that is going to be used.
 */

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** The family name (name ID 1) of a TrueType or OpenType font, or null. */
export function fontFamilyName(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  // TrueType outlines, OpenType with CFF outlines, or Apple's "true".
  if (version !== 0x00010000 && tag(bytes, 0) !== "OTTO" && tag(bytes, 0) !== "true") return null;
  const tables = view.getUint16(4);
  let nameAt = -1;
  let nameLength = 0;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.length) return null;
    if (tag(bytes, record) === "name") {
      nameAt = view.getUint32(record + 8);
      nameLength = view.getUint32(record + 12);
      break;
    }
  }
  if (nameAt < 0 || nameAt + 6 > bytes.length) return null;
  const end = Math.min(bytes.length, nameAt + nameLength);
  const count = view.getUint16(nameAt + 2);
  const strings = nameAt + view.getUint16(nameAt + 4);

  let fallback: string | null = null;
  for (let i = 0; i < count; i++) {
    const record = nameAt + 6 + i * 12;
    if (record + 12 > end) break;
    const platform = view.getUint16(record);
    const language = view.getUint16(record + 4);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = strings + view.getUint16(record + 10);
    if (nameId !== 1 || offset + length > bytes.length) continue;
    let text = "";
    if (platform === 3 || platform === 0) {
      // Windows and Unicode platforms: UTF-16, big-endian.
      for (let at = offset; at + 1 < offset + length; at += 2) {
        text += String.fromCharCode(view.getUint16(at));
      }
    } else {
      for (let at = offset; at < offset + length; at++) text += String.fromCharCode(bytes[at]!);
    }
    text = text.replace(/\u0000/g, "").trim();
    if (!text) continue;
    // English (United States) on Windows is the name every renderer knows.
    if (platform === 3 && language === 0x0409) return text;
    fallback ??= text;
  }
  return fallback;
}
