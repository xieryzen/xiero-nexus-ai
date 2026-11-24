import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { formatTokens, renewalDay, type TokenSummary } from "@/lib/token-rules";

/**
 * The tokens of an account for this month, as numbers and as a bar: what it
 * may use, what it used, what is left, and when the count starts again.
 */
export function TokenMeter({
  tokens,
  id,
  inputPercent,
  children,
}: {
  tokens: TokenSummary;
  id?: string;
  /** What a token of input counts, in percent of a token of output: said under the numbers. */
  inputPercent?: number;
  /** Rows above the numbers. */
  children?: ReactNode;
}) {
  const share = tokens.limit === null ? 0 : tokens.limit === 0 ? 100 : Math.min(100, Math.round((tokens.used / tokens.limit) * 100));
  return (
    <div>
      {tokens.limit !== null ? (
        <div data-testid="token-bar">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[17px] font-medium text-ink">This month</p>
            <p className={cn("text-sm", tokens.usedUp ? "font-medium text-danger" : "text-ink-3")}>{share}% used</p>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-accent-soft" role="img" aria-label={`${share} percent of this month's tokens used`}>
            <div className={cn("h-full rounded-full", tokens.usedUp ? "bg-danger" : "bg-accent")} style={{ width: `${share > 0 ? Math.max(2, share) : 0}%` }} />
          </div>
          <p className="mt-2.5 text-sm text-ink-3">Resets on {renewalDay(tokens.renewsAt)}</p>
        </div>
      ) : (
        <div data-testid="token-bar">
          <p className="text-[17px] font-medium text-ink">No limit</p>
          <p className="mt-1 text-sm text-ink-3">An owner is not held to an allowance. What is used is counted all the same.</p>
        </div>
      )}
      <dl className="mt-4 space-y-2.5 border-t border-line pt-4 text-sm" id={id}>
        {children}
        <Row label="Used this month" value={formatTokens(tokens.used)} />
        <Row label="Allowance" value={tokens.limit === null ? "No limit" : `${formatTokens(tokens.limit)} a month${tokens.custom ? " (your own)" : ""}`} />
        {tokens.left !== null && <Row label="Left" value={<span className={cn("font-medium", tokens.usedUp && "text-danger")}>{formatTokens(tokens.left)}</span>} />}
        {tokens.left !== null && <Row label="There again on" value={renewalDay(tokens.renewsAt)} />}
        <Row label="Used in all" value={formatTokens(tokens.total)} />
      </dl>
      {inputPercent !== undefined && inputPercent < 100 && (
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          How it is counted: what the assistant writes counts in full, what it is sent counts {inputPercent} percent. Work with tools sends the same
          conversation again with every step, so most of what a run uses is counted at that part. “Used in all” is every token, uncounted.
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  );
}
