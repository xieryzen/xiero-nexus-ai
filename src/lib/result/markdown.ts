/**
 * Markdown, read into a tree a page can show: what a manager, a reviewer or
 * an agent wrote is a document, and is shown as one instead of as its source.
 *
 * It reads what models write: headings, paragraphs, lists (nested, numbered,
 * with check boxes), code blocks, quotes, tables, rules, and inside a line
 * bold, italic, struck out, code, links and bare addresses. HTML in the text
 * is not HTML here: it is shown as the characters it is written with, so that
 * nothing a model wrote can become markup of the page. A link is kept only
 * when it leads to http, https or mailto, or to a path without a scheme.
 * Pure: no React, no DOM.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export interface ListItem {
  /** A check box in front of it: ticked, not ticked, or none. */
  checked: boolean | null;
  children: Block[];
}

export type Align = "left" | "right" | "center" | null;

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

/** The longest text that is read as Markdown. Longer text is cut, and the last block says so. */
export const MARKDOWN_MAX_CHARS = 400_000;
/** How deep lists and quotes may be nested before the rest is read as plain text. */
const MAX_DEPTH = 8;

// ─── Inside a line ───────────────────────────────────────────────────────────

/** A link's address, when it is one a page may lead to; null otherwise. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href || href.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(href)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme) return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
  // No scheme: a path of the project, or a place in the document.
  if (href.startsWith("//")) return null;
  return href;
}

const INLINE = new RegExp(
  [
    // 1,2: code span, with as many backticks at its end as at its start
    "(`+)([\\s\\S]*?[^`])\\1(?!`)",
    // 3: picture mark, 4: link text, 5: address
    "(!?)\\[((?:[^\\[\\]\\\\]|\\\\.)*)\\]\\(\\s*<?([^\\s<>()]*(?:\\([^\\s<>()]*\\)[^\\s<>()]*)*)>?(?:\\s+(?:\"[^\"]*\"|'[^']*'))?\\s*\\)",
    // 6: address between angle brackets
    "<((?:https?:\\/\\/|mailto:)[^\\s<>]+)>",
    // 7,8: bold
    "(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\7",
    // 9: italic with stars
    "\\*(?=[^\\s*])([\\s\\S]*?[^\\s*])\\*(?!\\*)",
    // 10: italic with underscores; that it does not start inside a word is seen to below
    "_(?=[^\\s_])([\\s\\S]*?[^\\s_])_(?![A-Za-z0-9_])",
    // 11: struck out
    "~~(?=\\S)([\\s\\S]*?\\S)~~",
    // 12: a bare address
    "(https?:\\/\\/[^\\s<>\"'`]*[^\\s<>\"'`.,;:!?)\\]}*_])",
    // 13: an escaped character
    "\\\\([\\\\`*_{}\\[\\]()#+\\-.!|~<>])",
    // 14: a line break that is meant
    "( {2,}\\n|\\\\\\n)",
  ].join("|"),
  "g",
);

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** The text of a line, with what is marked in it. */
export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > 6) {
    pushText(out, source);
    return out;
  }
  const pattern = new RegExp(INLINE.source, "g");
  let at = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    pushText(out, source.slice(at, match.index).replace(/\n/g, " "));
    at = match.index + match[0].length;
    if (match[1] !== undefined) {
      // One space at each end belongs to the marks, as in "`` `a` ``".
      const text = match[2]!.replace(/\n/g, " ");
      out.push({ type: "code", text: /^ .* $/.test(text) && text.trim() ? text.slice(1, -1) : text });
    } else if (match[4] !== undefined) {
      const href = safeHref(match[5] ?? "");
      const label = match[4].replace(/\\([\[\]\\])/g, "$1");
      // A picture is not loaded from wherever a model points: it is a link to it.
      const children = parseInline(label || match[5] || "", depth + 1);
      if (href) out.push({ type: "link", href, children: children.length > 0 ? children : [{ type: "text", text: href }] });
      else pushText(out, label);
    } else if (match[6] !== undefined) {
      const href = safeHref(match[6]);
      if (href) out.push({ type: "link", href, children: [{ type: "text", text: match[6].replace(/^mailto:/, "") }] });
      else pushText(out, match[0]);
    } else if (match[7] !== undefined) {
      const inner = match[8]!;
      if (match[7] === "**" && inner.startsWith("*") && source[at] === "*") {
        // Three stars on each side: bold and italic.
        at += 1;
        pattern.lastIndex = at;
        out.push({ type: "strong", children: [{ type: "em", children: parseInline(inner.slice(1), depth + 1) }] });
      } else {
        out.push({ type: "strong", children: parseInline(inner, depth + 1) });
      }
    } else if (match[9] !== undefined) {
      out.push({ type: "em", children: parseInline(match[9], depth + 1) });
    } else if (match[10] !== undefined) {
      // An underscore inside a word is part of the word: snake_case_names, file_name.md.
      if (/[A-Za-z0-9_]/.test(source[match.index - 1] ?? "")) {
        pushText(out, "_");
        at = match.index + 1;
        pattern.lastIndex = at;
        continue;
      }
      out.push({ type: "em", children: parseInline(match[10], depth + 1) });
    } else if (match[11] !== undefined) {
      out.push({ type: "del", children: parseInline(match[11], depth + 1) });
    } else if (match[12] !== undefined) {
      const href = safeHref(match[12]);
      if (href) out.push({ type: "link", href, children: [{ type: "text", text: match[12] }] });
      else pushText(out, match[12]);
    } else if (match[13] !== undefined) {
      pushText(out, match[13]);
    } else {
      out.push({ type: "br" });
    }
  }
  pushText(out, source.slice(at).replace(/\n/g, " "));
  return out;
}

/** The words of a line without its marks: for a title, or to compare. */
export function plainText(inline: readonly Inline[]): string {
  return inline
    .map((node) => {
      if (node.type === "text" || node.type === "code") return node.text;
      if (node.type === "br") return " ";
      return plainText(node.children);
    })
    .join("");
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

function startsBlock(line: string, next: string | undefined): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  // A numbered list breaks into a paragraph only when it starts at 1, as "2024. was a year" is no list.
  if (item && item[1]!.length <= 3 && item[3] !== undefined && (/^[-*+]$/.test(item[2]!) || /^1[.)]$/.test(item[2]!))) return true;
  return line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-");
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      const closes = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      while (i < lines.length && !closes.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence, or the end of the text
      blocks.push({ type: "code", lang: (fence[2] ?? "").toLowerCase().slice(0, 40), text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline((heading[2] ?? "").trim()) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      blocks.push({ type: "quote", children: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ type: "paragraph", children: parseInline(body.join("\n")) }] });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]!).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      if (align.length === head.length) {
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
          const row = cells(lines[i++]!);
          // A row is as wide as the head: what is missing is empty, what is too much is left out.
          rows.push(head.map((_, column) => parseInline(row[column] ?? "")));
        }
        blocks.push({ type: "table", align, head: head.map((cell) => parseInline(cell)), rows });
        continue;
      }
    }

    const first = ITEM.exec(line);
    if (first && first[1]!.length <= 3) {
      const ordered = /\d/.test(first[2]!);
      const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
      const indent = first[1]!.length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]!);
        if (!item || item[1]!.length > indent + 1 || item[1]!.length < indent || /\d/.test(item[2]!) !== ordered) break;
        // What belongs to the item starts under its text.
        const width = item[1]!.length + item[2]!.length + 1;
        const body: string[] = [item[3] ?? ""];
        i++;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === "") {
            // A blank line stays in the item when what follows is still under it.
            let after = i + 1;
            while (after < lines.length && lines[after]!.trim() === "") after++;
            if (after < lines.length && /^ +/.test(lines[after]!) && lines[after]!.search(/\S/) >= Math.min(width, indent + 2)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const lead = next.search(/\S/);
          if (lead >= Math.min(width, indent + 2)) {
            body.push(next.slice(Math.min(lead, width)));
            i++;
            continue;
          }
          // A line of a paragraph that goes on, written without its indent.
          if (!startsBlock(next, lines[i + 1]) && !ITEM.test(next) && body[body.length - 1] !== "") {
            body.push(next.trim());
            i++;
            continue;
          }
          break;
        }
        let checked: boolean | null = null;
        const box = /^\[([ xX])\][ \t]+/.exec(body[0]!);
        if (box) {
          checked = box[1] !== " ";
          body[0] = body[0]!.slice(box[0].length);
        }
        items.push({
          checked,
          children: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ type: "paragraph", children: parseInline(body.join("\n")) }],
        });
        // Blank lines between the items of one list.
        let after = i;
        while (after < lines.length && lines[after]!.trim() === "") after++;
        const more = after < lines.length ? ITEM.exec(lines[after]!) : null;
        if (more && more[1]!.length >= indent && more[1]!.length <= indent + 1 && /\d/.test(more[2]!) === ordered) i = after;
        else break;
      }
      if (items.length > 0) {
        blocks.push({ type: "list", ordered, start, items });
        continue;
      }
    }

    const body: string[] = [line.replace(/^ {1,3}/, "")];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!, lines[i + 1])) body.push(lines[i++]!.trim());
    blocks.push({ type: "paragraph", children: parseInline(body.join("\n")) });
  }
  return blocks;
}

/** The blocks of a text written in Markdown. */
export function parseMarkdown(source: string): Block[] {
  let text = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  let cut = false;
  if (text.length > MARKDOWN_MAX_CHARS) {
    text = text.slice(0, MARKDOWN_MAX_CHARS);
    cut = true;
  }
  const blocks = parseBlocks(text.split("\n"), 0);
  if (cut) blocks.push({ type: "paragraph", children: [{ type: "em", children: [{ type: "text", text: "(The text goes on: it is longer than what is shown as a document.)" }] }] });
  return blocks;
}

/**
 * Whether a text reads as Markdown at all: it has a heading, a list, a code
 * block, a table, or bold in it. A text without any of it is shown as it is.
 */
export function looksLikeMarkdown(source: string): boolean {
  return /^ {0,3}#{1,6} \S/m.test(source) || /^ {0,3}(?:[-*+]|\d+[.)]) \S/m.test(source) || /^ {0,3}(?:```|~~~)/m.test(source) || /\*\*\S[^*\n]*\*\*/.test(source) || /^\|.+\|\s*\n\|[ :|-]+\|/m.test(source);
}
