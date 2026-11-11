export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatCost(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  return `$${n < 0.01 ? n.toFixed(5) : n.toFixed(n < 1 ? 4 : 2)}`;
}

export function formatDateTime(d: Date | string | number): string {
  const date = new Date(d);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(d: Date | string | number): string {
  const date = new Date(d);
  const diff = Date.now() - date.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDateTime(date);
}
