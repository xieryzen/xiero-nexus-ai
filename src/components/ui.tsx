import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "signal";

const toneBadge: Record<Tone, string> = {
  neutral: "bg-ink/[0.08] text-ink-2",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  info: "bg-accent-soft text-accent-ink",
  signal: "bg-signal/15 text-signal",
};

const toneDot: Record<Tone, string> = {
  neutral: "bg-ink-3",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  signal: "bg-signal",
};

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "primary",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  loading?: boolean;
}) {
  const base =
    variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-ghost";
  return (
    <button className={cn(base, className)} disabled={disabled || loading} {...props}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={htmlFor} className="label">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("input", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("input", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn("input", props.className)} />;
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** For a link that leads to this card. */
  id?: string;
}) {
  return (
    <section id={id} className={cn("card scroll-mt-20", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={cn("badge", toneBadge[tone])}>{children}</span>;
}

export function StatusDot({ tone = "neutral" }: { tone?: Tone }) {
  return <span className={cn("inline-block h-2 w-2 rounded-full", toneDot[tone])} />;
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const map: Record<Tone, string> = {
    neutral: "border-transparent bg-surface-2 text-ink-2",
    ok: "border-transparent bg-ok/10 text-ok",
    warn: "border-transparent bg-warn/15 text-warn",
    danger: "border-transparent bg-danger/10 text-danger",
    info: "border-transparent bg-accent-soft text-accent-ink",
    signal: "border-transparent bg-signal/10 text-signal",
  };
  return (
    <div className={cn("rounded-2xl border px-4 py-3 text-sm", map[tone])} role="alert">
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-[15px] leading-snug text-ink-2">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {/* On a phone the bar at the top says which page this is (app-shell.tsx): the heading is there for a reader that reads the page aloud. */}
        <h1 className="serif text-[1.7rem] font-medium tracking-tight text-ink max-lg:sr-only">{title}</h1>
        {description && <p className="text-sm leading-relaxed text-ink-2 lg:mt-1">{description}</p>}
      </div>
      {/* A long description must not squeeze the buttons onto two lines. */}
      {actions && <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">{actions}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-50",
        checked ? "bg-accent" : "bg-surface-3",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}
