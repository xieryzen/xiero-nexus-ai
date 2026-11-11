import { Badge, StatusDot } from "@/components/ui";

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "signal";

const map: Record<string, Tone> = {
  draft: "neutral",
  queued: "neutral",
  ready: "info",
  planning: "info",
  running: "signal",
  review: "warn",
  blocked: "warn",
  needs_approval: "warn",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
};

export function StateBadge({ state }: { state: string }) {
  const tone = map[state] ?? "neutral";
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} />
      {state.replace(/_/g, " ")}
    </Badge>
  );
}
