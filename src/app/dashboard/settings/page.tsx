import { apiKeyFor } from "@/lib/for-viewer";
import Link from "next/link";
import { listApiKeys, serializeApiKey } from "@/lib/apikeys";
import { requirePageUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { DateTime } from "@/components/time";
import { usableModels } from "@/lib/model-options";
import { serializeWebhook, webhookFor } from "@/lib/notifications";
import { Badge, Card, PageHeader, StatusDot } from "@/components/ui";
import { Icon } from "@/components/icons";
import { AccountClient } from "@/components/account/account-client";
import { IntegrationsClient } from "@/components/account/integrations-client";
import { isAdminRole, isOwnerRole, roleLabel, seesSetup } from "@/lib/roles";
import { formatTokens, tokenSummary } from "@/lib/token-rules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default function SettingsPage() {
  const user = requirePageUser();
  const tokens = tokenSummary(user);
  return (
    <div>
      <PageHeader title="Settings" description="Your account, its security, API keys and notifications." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Account">
          <dl className="space-y-3 text-sm">
            <Row label="Username" value={user.username} />
            <Row label="Email" value={user.email} />
            <div className="flex items-center justify-between">
              <dt className="text-ink-3">Role</dt>
              <dd>
                <Badge tone={isOwnerRole(user.role) ? "signal" : isAdminRole(user.role) ? "info" : "neutral"}>{roleLabel(user.role)}</Badge>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-3">Two-factor</dt>
              <dd>
                <Badge tone={user.twoFactorEnabled ? "ok" : "neutral"}>
                  <StatusDot tone={user.twoFactorEnabled ? "ok" : "neutral"} />
                  {user.twoFactorEnabled ? "On" : "Off"}
                </Badge>
              </dd>
            </div>
            <Row label="Member since" value={<DateTime at={new Date(user.createdAt).getTime()} />} />
          </dl>
        </Card>

        <Card
          title="Tokens"
          description={
            tokens.limit === null
              ? "What your work has used. An owner is not held to a limit, and sets the limit of every other account under Users & Roles."
              : "What your work may use in all, and what it has used: chat, the runs of your projects, media, knowledge, and your API keys. An owner of this installation sets the limit."
          }
        >
          <dl className="space-y-3 text-sm" id="token-balance">
            <Row label="Used" value={formatTokens(tokens.used)} />
            <Row label="Limit" value={tokens.limit === null ? "No limit" : formatTokens(tokens.limit)} />
            {tokens.left !== null && (
              <Row
                label="Left"
                value={<span className={tokens.usedUp ? "font-medium text-danger" : "font-medium"}>{formatTokens(tokens.left)}</span>}
              />
            )}
          </dl>
          {tokens.left !== null && tokens.limit !== null && (
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <div
                className={tokens.usedUp ? "h-full bg-danger" : "h-full bg-signal"}
                style={{ width: `${tokens.limit === 0 ? 100 : Math.min(100, Math.round((tokens.used / tokens.limit) * 100))}%` }}
              />
            </div>
          )}
        </Card>

        <Card title="Security" description="Protect your account.">
          <Link
            href="/dashboard/settings/security"
            className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-4 py-3 text-sm transition hover:border-line-strong"
          >
            <span className="flex items-center gap-3 text-ink">
              <span className="text-signal">
                <Icon name="lock" />
              </span>
              Two-factor authentication
            </span>
            <span className="text-ink-3">Manage →</span>
          </Link>
        </Card>
      </div>

      <AccountClient username={user.username} email={user.email} />

      <IntegrationsClient
        webhook={serializeWebhook(webhookFor(user.id))}
        apiKeys={listApiKeys(user.id).map((key) => apiKeyFor(user.role, serializeApiKey(key)))}
        // Someone who is shown the setup limits a key to models by name; a user's key names none.
        models={seesSetup(user.role) ? usableModels().map((m) => ({ id: m.id, label: `${m.name} · ${m.providerName}` })) : []}
        chooses={seesSetup(user.role)}
        baseUrl={env.appUrl.replace(/\/+$/, "")}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
