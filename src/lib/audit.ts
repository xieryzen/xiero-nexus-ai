import "server-only";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export interface AuditInput {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Record an administrative/security event. Callers must never pass secrets in
 * `metadata`; this helper stores it verbatim as JSON.
 */
export function audit(input: AuditInput): void {
  try {
    db.insert(auditLogs)
      .values({
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ip: input.ip,
        userAgent: input.userAgent,
      })
      .run();
  } catch (err) {
    // Audit must never break the main flow.
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] audit write failed:", err);
  }
}
