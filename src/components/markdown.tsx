"use client";

import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Align, type Block, type Inline } from "@/lib/result/markdown";
import { cn } from "@/components/ui";

/**
 * A text written in Markdown, shown as the document it is: headings, lists,
 * tables, code. Nothing in the text becomes markup of the page: the text is
 * read into a tree (src/lib/result/markdown.ts) and the tree is drawn here.
 *
 * `files` and `onFile`: the paths of a project's files. Where the text names
 * one, as a link or as code, it opens that file instead of leading away.
 */
export function Markdown({
  source,
  files,
  onFile,
  className,
}: {
  source: string;
  files?: ReadonlySet<string>;
  onFile?: (path: string) => void;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const ctx: Ctx = { files, onFile };
  return <div className={cn("markdown min-w-0 text-sm leading-relaxed text-ink-2", className)}>{blocks.map((block, i) => renderBlock(block, `b${i}`, ctx))}</div>;
}

interface Ctx {
  files?: ReadonlySet<string>;
  onFile?: (path: string) => void;
}

/** The file of the project a piece of text names, if it names one. */
function fileNamed(text: string, ctx: Ctx): string | null {
  if (!ctx.files || !ctx.onFile) return null;
  const path = text.trim().replace(/^\.\//, "");
  return ctx.files.has(path) ? path : null;
}

function FileLink({ path, ctx, children, mono }: { path: string; ctx: Ctx; children: ReactNode; mono?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => ctx.onFile?.(path)}
      title={`Open ${path}`}
      className={cn("rounded text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal", mono && "mono bg-surface-2 px-1 py-0.5 text-[0.85em]")}
    >
      {children}
    </button>
  );
}

function renderInline(nodes: readonly Inline[], key: string, ctx: Ctx): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}.${i}`;
    switch (node.type) {
      case "text":
        return <span key={k}>{node.text}</span>;
      case "strong":
        return (
          <strong key={k} className="font-semibold text-ink">
            {renderInline(node.children, k, ctx)}
          </strong>
        );
      case "em":
        return <em key={k}>{renderInline(node.children, k, ctx)}</em>;
      case "del":
        return <del key={k}>{renderInline(node.children, k, ctx)}</del>;
      case "br":
        return <br key={k} />;
      case "code": {
        const file = fileNamed(node.text, ctx);
        if (file) {
          return (
            <FileLink key={k} path={file} ctx={ctx} mono>
              {node.text}
            </FileLink>
          );
        }
        return (
          <code key={k} className="mono break-words rounded bg-surface-2 px-1 py-0.5 text-[0.85em] text-ink">
            {node.text}
          </code>
        );
      }
      case "link": {
        const file = fileNamed(node.href, ctx);
        if (file) {
          return (
            <FileLink key={k} path={file} ctx={ctx}>
              {renderInline(node.children, k, ctx)}
            </FileLink>
          );
        }
        // A path that is no file of the project leads nowhere from this page: it is shown as text.
        if (!/^(https?:|mailto:)/i.test(node.href)) return <span key={k}>{renderInline(node.children, k, ctx)}</span>;
        return (
          <a key={k} href={node.href} target="_blank" rel="noreferrer noopener" className="break-words text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal">
            {renderInline(node.children, k, ctx)}
          </a>
        );
      }
    }
  });
}

const HEADING: Record<number, string> = {
  1: "mt-5 mb-2 text-lg font-semibold text-ink first:mt-0",
  2: "mt-5 mb-2 text-base font-semibold text-ink first:mt-0",
  3: "mt-4 mb-1.5 text-sm font-semibold text-ink first:mt-0",
  4: "mt-3 mb-1 text-sm font-semibold text-ink-2 first:mt-0",
  5: "mt-3 mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3 first:mt-0",
  6: "mt-3 mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3 first:mt-0",
};

function alignClass(align: Align): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

function renderBlock(block: Block, key: string, ctx: Ctx): ReactNode {
  switch (block.type) {
    case "heading": {
      const children = renderInline(block.children, key, ctx);
      const className = HEADING[block.level];
      if (block.level === 1) return <h3 key={key} className={className}>{children}</h3>;
      if (block.level === 2) return <h4 key={key} className={className}>{children}</h4>;
      if (block.level === 3) return <h5 key={key} className={className}>{children}</h5>;
      return <h6 key={key} className={className}>{children}</h6>;
    }
    case "paragraph":
      return (
        <p key={key} className="my-2 break-words first:mt-0 last:mb-0">
          {renderInline(block.children, key, ctx)}
        </p>
      );
    case "code":
      return (
        <pre key={key} className="mono my-3 max-h-96 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs leading-snug text-ink" data-lang={block.lang || undefined}>
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="my-3 border-l-2 border-line-strong pl-3 text-ink-3">
          {block.children.map((child, i) => renderBlock(child, `${key}.${i}`, ctx))}
        </blockquote>
      );
    case "rule":
      return <hr key={key} className="my-4 border-line" />;
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={`${key}.${i}`} className={cn("break-words", item.checked !== null && "list-none")}>
          {item.checked !== null && (
            <span aria-hidden="true" className={cn("mono -ml-5 mr-1.5 inline-block w-3.5 text-center text-xs", item.checked ? "text-ok" : "text-ink-3")}>
              {item.checked ? "✓" : "☐"}
            </span>
          )}
          {item.checked !== null && <span className="sr-only">{item.checked ? "Done: " : "Not done: "}</span>}
          {item.children.map((child, j) =>
            // The first paragraph of an item stands on the item's own line.
            child.type === "paragraph" && j === 0 ? <span key={`${key}.${i}.${j}`}>{renderInline(child.children, `${key}.${i}.${j}`, ctx)}</span> : renderBlock(child, `${key}.${i}.${j}`, ctx),
          )}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start} className="my-2 list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} className={cn("border border-line bg-surface-2 px-2 py-1.5 font-semibold text-ink", alignClass(block.align[i] ?? null))}>
                    {renderInline(cell, `${key}.h${i}`, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={cn("border border-line px-2 py-1.5 align-top", alignClass(block.align[c] ?? null))}>
                      {renderInline(cell, `${key}.${r}.${c}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
