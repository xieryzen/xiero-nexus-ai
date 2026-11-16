import "server-only";
import { createHmac } from "node:crypto";
import { and, asc, count, desc, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  notificationWebhooks,
  notifications,
  users,
  type Notification,
  type NotificationWebhook,
} from "@/db/schema";
import { randomToken } from "./crypto";
import { env } from "./env";
import { AppError, sanitizeUpstreamError } from "./errors";
import { safeFetch } from "./http-client";
import { decryptSecret, encryptSecret } from "./secrets";
import { textFor } from "./shown";
import { assertSafeProviderUrl } from "./ssrf";

/**
 * Notifications: what happened while nobody was looking (a run finished, a
 * video is ready, a schedule could not start). They are shown in the
 * dashboard's bell and, when the user set a webhook, also sent there.
 */

export type NotificationKind = Notification["kind"];
export type NotificationLevel = Notification["level"];

export interface NotifyInput {
  kind: NotificationKind;
  level?: NotificationLevel;
  title: string;
  body?: string | null;
  /**
   * What went wrong, in the system's words. It is put in front of the body.
   * Someone who is not shown the setup is told it without what names a
   * provider or a model (shown.ts); the title and the body are not looked
   * through, since they hold what the user wrote: a title, a prompt.
   */
  problem?: string | null;
  /** A path inside the dashboard, such as /dashboard/projects/<id>. */
  link?: string | null;
}

const MAX_TITLE = 200;
const MAX_BODY = 1000;
/** Notifications kept per user; older ones are removed as new ones arrive. */
const KEEP_PER_USER = 200;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Hosts on a private network that webhooks may be sent to. */
function webhookAllowHosts(): string[] {
  return (process.env.ALLOW_PRIVATE_WEBHOOK_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function webhookFor(userId: string): NotificationWebhook | undefined {
  return db
    .select()
    .from(notificationWebhooks)
    .where(eq(notificationWebhooks.userId, userId))
    .get();
}

/** Record a notification for a user. Never throws: it must not break the work it reports on. */
export function notify(userId: string | null | undefined, input: NotifyInput): void {
  if (!userId) return;
  try {
    const hook = webhookFor(userId);
    // What names a provider or a model is said to those who are shown the
    // setup; anyone else is told that it did not work (shown.ts).
    const role = db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role;
    const title = input.title;
    const body = [input.problem ? textFor(role, input.problem) : null, input.body].filter(Boolean).join("\n") || null;
    db.insert(notifications)
      .values({
        userId,
        kind: input.kind,
        level: input.level ?? "info",
        title: cut(title, MAX_TITLE),
        body: body ? cut(body, MAX_BODY) : null,
        link: input.link ?? null,
        webhookStatus: hook?.enabled ? "pending" : "none",
      })
      .run();
    // Keep the newest; drop what is beyond the limit.
    const old = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(50)
      .offset(KEEP_PER_USER)
      .all();
    for (const row of old) db.delete(notifications).where(eq(notifications.id, row.id)).run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] notification write failed:", err);
  }
}

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: number;
}

export function serializeNotification(n: Notification): NotificationDTO {
  return {
    id: n.id,
    kind: n.kind,
    level: n.level,
    title: n.title,
    body: n.body,
    link: n.link,
    read: n.readAt !== null,
    createdAt: n.createdAt.getTime(),
  };
}

export function listNotifications(userId: string, limit = 30): NotificationDTO[] {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(Math.min(Math.max(1, limit), 100))
    .all()
    .map(serializeNotification);
}

export function unreadCount(userId: string): number {
  const row = db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .get();
  return row?.n ?? 0;
}

/** Mark one notification, or all of a user's, as read. */
export function markRead(userId: string, id?: string): void {
  db.update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        id ? eq(notifications.id, id) : undefined,
      ),
    )
    .run();
}

export function clearNotifications(userId: string): void {
  db.delete(notifications).where(eq(notifications.userId, userId)).run();
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

export interface WebhookDTO {
  url: string;
  enabled: boolean;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  lastDeliveredAt: number | null;
}

export function serializeWebhook(hook: NotificationWebhook | undefined): WebhookDTO | null {
  if (!hook) return null;
  return {
    url: hook.url,
    enabled: hook.enabled,
    lastStatus: hook.lastStatus,
    lastError: hook.lastError,
    lastDeliveredAt: hook.lastDeliveredAt ? hook.lastDeliveredAt.getTime() : null,
  };
}

export async function assertWebhookUrl(url: string): Promise<void> {
  try {
    await assertSafeProviderUrl(url, { allowHosts: webhookAllowHosts() });
  } catch (err) {
    if (err instanceof AppError) {
      // The shared check words its errors for provider settings.
      const messages: Record<string, string> = {
        invalid_url: "The webhook address is not a valid http or https address",
        dns_error: "The webhook address's host could not be found",
        blocked_host:
          "The webhook address is on a private network. An administrator can allow its host with ALLOW_PRIVATE_WEBHOOK_HOSTS.",
      };
      throw new AppError(400, err.code, messages[err.code] ?? err.message);
    }
    throw err;
  }
}

/**
 * Set a user's webhook. Resolves to the signing secret when one was created
 * (a new webhook, or `rotateSecret`); it is shown once and not again.
 */
export async function saveWebhook(
  userId: string,
  input: { url: string; enabled: boolean; rotateSecret?: boolean },
): Promise<{ hook: NotificationWebhook; secret: string | null }> {
  await assertWebhookUrl(input.url);
  const existing = webhookFor(userId);
  const secret = !existing || input.rotateSecret ? `whsec_${randomToken(24)}` : null;
  const now = new Date();
  if (existing) {
    const hook = db
      .update(notificationWebhooks)
      .set({
        url: input.url,
        enabled: input.enabled,
        ...(secret ? { secretCiphertext: encryptSecret(secret) } : {}),
        updatedAt: now,
      })
      .where(eq(notificationWebhooks.id, existing.id))
      .returning()
      .get();
    return { hook, secret };
  }
  const hook = db
    .insert(notificationWebhooks)
    .values({ userId, url: input.url, enabled: input.enabled, secretCiphertext: encryptSecret(secret!) })
    .returning()
    .get();
  return { hook, secret };
}

export function deleteWebhook(userId: string): void {
  db.delete(notificationWebhooks).where(eq(notificationWebhooks.userId, userId)).run();
  db.update(notifications)
    .set({ webhookStatus: "none" })
    .where(and(eq(notifications.userId, userId), eq(notifications.webhookStatus, "pending")))
    .run();
}

const DELIVERY_TIMEOUT_MS = 10_000;
/** Minutes to wait before each further attempt. */
const RETRY_MINUTES = [1, 5, 30, 120];

interface WebhookPayload {
  id: string;
  event: string;
  kind: string;
  level: string;
  title: string;
  body: string | null;
  url: string | null;
  createdAt: string;
  /** The same message as one line, under the names chat tools read. */
  text: string;
  content: string;
}

function payloadFor(n: Pick<Notification, "id" | "kind" | "level" | "title" | "body" | "link" | "createdAt">): WebhookPayload {
  const url = n.link ? `${env.appUrl.replace(/\/+$/, "")}${n.link}` : null;
  const line = [n.title, n.body, url].filter(Boolean).join("\n");
  return {
    id: n.id,
    event: `${n.kind}.${n.level}`,
    kind: n.kind,
    level: n.level,
    title: n.title,
    body: n.body,
    url,
    createdAt: n.createdAt.toISOString(),
    text: line,
    content: line,
  };
}

/** The signature header value: HMAC-SHA256 of "<timestamp>.<body>". */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function post(hook: NotificationWebhook, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await safeFetch(
    hook.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Xiero-Nexus-Webhook/1",
        "x-nexus-event": payload.event,
        "x-nexus-signature": signWebhook(decryptSecret(hook.secretCiphertext), timestamp, body),
      },
      body,
    },
    { timeoutMs: DELIVERY_TIMEOUT_MS, allowHosts: webhookAllowHosts() },
  );
  void res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new AppError(502, "webhook_error", `The webhook answered ${res.status}`);
}

function recordDelivery(hook: NotificationWebhook, error: string | null): void {
  db.update(notificationWebhooks)
    .set({
      lastStatus: error ? "error" : "ok",
      lastError: error,
      lastDeliveredAt: error ? hook.lastDeliveredAt : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(notificationWebhooks.id, hook.id))
    .run();
}

/** Send a test message to a user's webhook now. Throws when it does not arrive. */
export async function sendTestWebhook(userId: string): Promise<void> {
  const hook = webhookFor(userId);
  if (!hook) throw new AppError(400, "bad_request", "No webhook is set");
  try {
    await post(
      hook,
      payloadFor({
        id: "test",
        kind: "system",
        level: "info",
        title: "Test notification from Xiero Nexus AI",
        body: "If you can read this, the webhook works.",
        link: "/dashboard/settings",
        createdAt: new Date(),
      }),
    );
    recordDelivery(hook, null);
  } catch (err) {
    const message = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    recordDelivery(hook, message);
    throw new AppError(502, "webhook_error", message);
  }
}

/** Deliver the notifications that are waiting for their webhook. Called by the worker. */
export async function deliverPendingWebhooks(limit = 10): Promise<number> {
  const now = new Date();
  const due = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.webhookStatus, "pending"),
        or(isNull(notifications.webhookNextAt), lte(notifications.webhookNextAt, now)),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(limit)
    .all();

  let sent = 0;
  for (const n of due) {
    const hook = webhookFor(n.userId);
    if (!hook || !hook.enabled) {
      db.update(notifications).set({ webhookStatus: "none" }).where(eq(notifications.id, n.id)).run();
      continue;
    }
    try {
      await post(hook, payloadFor(n));
      db.update(notifications)
        .set({ webhookStatus: "sent", webhookAttempts: n.webhookAttempts + 1 })
        .where(eq(notifications.id, n.id))
        .run();
      recordDelivery(hook, null);
      sent++;
    } catch (err) {
      const message = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
      const attempts = n.webhookAttempts + 1;
      const wait = RETRY_MINUTES[attempts - 1];
      db.update(notifications)
        .set({
          webhookAttempts: attempts,
          webhookStatus: wait === undefined ? "failed" : "pending",
          webhookNextAt: wait === undefined ? null : new Date(Date.now() + wait * 60_000),
        })
        .where(eq(notifications.id, n.id))
        .run();
      recordDelivery(hook, message);
    }
  }
  return sent;
}
