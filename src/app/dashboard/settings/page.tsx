import Link from "next/link";
import { listApiKeys, serializeApiKey } from "@/lib/apikeys";
import { requirePageUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { DateTime } from "@/components/time";
import { usableModels } from "@/lib/model-options";
import { serializeWebhook, webhookFor } from "@/lib/notifications";
import { Badge, Card, PageHeader, StatusDot } from "@/components/ui";
import { Icon } from "@/components/icons";
import { IntegrationsClient } from "@/components/account/integrations-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default function SettingsPage() {
  const user = requirePageUser();
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
                <Badge tone={user.role === "admin" ? "signal" : "neutral"}>{user.role}</Badge>
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

      <IntegrationsClient
        webhook={serializeWebhook(webhookFor(user.id))}
        apiKeys={listApiKeys(user.id).map(serializeApiKey)}
        models={usableModels().map((m) => ({ id: m.id, label: `${m.name} · ${m.providerName}` }))}
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
