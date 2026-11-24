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

/**
 * The mark of a new conversation and of the assistant: a hub with eight
 * spokes that end in nodes, in the clay of the app. The "nexus", drawn large.
 */
export function NexusMark({ size = 44 }: { size?: number }) {
  const spokes = [0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => {
    const reach = i % 2 === 0 ? 19 : 13.5;
    const rad = (angle * Math.PI) / 180;
    // Rounded, so that the server and the browser write the same numbers.
    return { x: Math.round((24 + reach * Math.cos(rad)) * 100) / 100, y: Math.round((24 + reach * Math.sin(rad)) * 100) / 100, r: i % 2 === 0 ? 3.1 : 2.5 };
  });
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <g stroke="rgb(var(--signal))" strokeWidth="2.4" strokeLinecap="round">
        {spokes.map((s, i) => (
          <line key={i} x1="24" y1="24" x2={s.x} y2={s.y} />
        ))}
      </g>
      <g fill="rgb(var(--signal))">
        <circle cx="24" cy="24" r="4.6" />
        {spokes.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.r} />
        ))}
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <NexusMark size={30} />
      <span className="serif text-xl font-medium tracking-tight text-ink">
        Xiero Nexus <span className="text-signal">AI</span>
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
