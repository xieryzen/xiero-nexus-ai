import "server-only";

/**
 * The text of a PDF, page after page. The library is loaded when the first
 * PDF arrives, not with the server.
 */
export async function readPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // The reader keeps the array it is given: hand it a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  return text
    .map((page) => page.trim())
    .filter(Boolean)
    .join("\n\n");
}
