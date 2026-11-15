/**
 * HTML to readable text, for pages an agent fetches and for documents added
 * to a knowledge base. Pure and dependency-free. It is not a browser: it
 * drops what is not content (scripts, styles, markup) and keeps the words,
 * the paragraph breaks and where links point.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  deg: "°",
  euro: "€",
  pound: "£",
  times: "×",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

/** Elements whose content is not text for a reader. */
const DROPPED = ["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas", "head"];
/** Elements that end a line. */
const BLOCK =
  "p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|blockquote|pre|form|figure|figcaption|h[1-6]|dl|dt|dd|address|hr|details|summary";

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ExtractedPage {
  title: string;
  text: string;
}

export function htmlToText(html: string): ExtractedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? tidy(decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, ""))).slice(0, 300) : "";

  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROPPED) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  }
  // Links keep their address when it is a web address and differs from the text.
  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, a?: string, b?: string, c?: string, inner?: string) => {
      const href = decodeEntities((a ?? b ?? c ?? "").trim());
      const label = (inner ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (!label) return " ";
      if (!/^https?:\/\//i.test(href) || href === label || href.length > 300) return ` ${label} `;
      return ` ${label} (${href}) `;
    },
  );
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n\n")
    .replace(/<[^>]*>/g, " ");
  return { title, text: tidy(decodeEntities(s)) };
}

/** True when a text looks like an HTML document rather than plain text. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(head);
}
