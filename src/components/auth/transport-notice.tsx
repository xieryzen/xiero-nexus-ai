import { Alert } from "@/components/ui";

/** Explains why sign-in is turned off on a plain-HTTP address (see lib/transport.ts). */
export function TransportNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4">
      <Alert tone="warn">{message}</Alert>
    </div>
  );
}
