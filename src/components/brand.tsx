import Link from "next/link";

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      {/* A single signal routed outward to many nodes — the "nexus". */}
      <path
        d="M16 3 28 16 16 29 4 16 16 3Z"
        stroke="rgb(var(--line-strong))"
        strokeWidth="1.5"
      />
      <path
        d="M16 9v14M9 16h14"
        stroke="rgb(var(--signal))"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="16" cy="16" r="3.4" fill="rgb(var(--signal))" />
      <circle cx="16" cy="16" r="6.5" stroke="rgb(var(--signal))" strokeWidth="1.2" opacity="0.35" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-ink">
        Xiero Nexus{" "}
        <span className="text-signal">AI</span>
      </span>
    </span>
  );
}

/**
 * Required design credit. A restrained, selectable footer line — never an
 * overlay, never obstructing controls.
 */
export function DesignedByXiero({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-ink-3 ${className}`}>
      Designed by{" "}
      <Link
        href="https://github.com/xieryzen"
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ink-2 underline-offset-2 hover:text-signal hover:underline"
      >
        Xiero
      </Link>
    </p>
  );
}
