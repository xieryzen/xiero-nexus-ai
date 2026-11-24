import { apiKeyFor } from "@/lib/for-viewer";
import Link from "next/link";
import { listApiKeys, serializeApiKey } from "@/lib/apikeys";
import { requirePageUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { DateTime } from "@/components/time";
import { usableModels } from "@/lib/model-options";
import { serializeWebhook, webhookFor } from "@/lib/notifications";
import { Badge, Card, PageHeader, StatusDot } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { LogoutRow } from "@/components/account/logout-row";
import { AccountClient } from "@/components/account/account-client";
import { IntegrationsClient } from "@/components/account/integrations-client";
import { isAdminRole, isOwnerRole, seesSetup, tierLabel, tierOf } from "@/lib/roles";
import { notInPlan } from "@/lib/plan-rules";
import { accountHas, getPlanSettings } from "@/lib/plans";
import { tokensOf } from "@/lib/tokens";
import { ThemeChoice } from "@/components/theme";
import { TokenMeter } from "@/components/token-meter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default function SettingsPage() {
  const user = requirePageUser();
  const tokens = tokensOf(user);
  const tier = tierOf(user);
  const settings = getPlanSettings();
  const admin = isAdminRole(user.role);
  return (
    <div>
      <PageHeader title="Settings" />

      <div className="mx-auto max-w-2xl space-y-6 lg:mx-0">
        {/* Who is signed in, and with which role. */}
        <div className="list-group">
          <div className="list-row">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-signal text-base font-semibold text-white" aria-hidden="true">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{user.username}</span>
              <span className="block truncate text-[13px] text-ink-3">{user.email}</span>
            </span>
            <span id="account-role">
              <Badge tone={isOwnerRole(user.role) ? "signal" : admin ? "info" : "neutral"}>{tierLabel(tier)}</Badge>
            </span>
          </div>
        </div>

        {!admin && tier !== "ultra" && (
          <div className="card p-5">
            <p className="text-[17px] font-semibold text-ink">Want to do more?</p>
            <p className="mt-1 text-[15px] leading-snug text-ink-2">A higher plan has more tokens a month and more of what the app can do.</p>
            <Link href="/dashboard/plans" className="btn-primary mt-3.5">
              See the plans
            </Link>
          </div>
        )}

        <div>
          <p className="list-title">Account</p>
          <div className="list-group">
            <SettingsRow href="#profile" icon="users" label="Profile" />
            <SettingsRow href="/dashboard/plans" icon="plan" label="Plan" value={tierLabel(tier)} />
            <SettingsRow href="/dashboard/usage" icon="usage" label="Usage" />
            <SettingsRow href="/dashboard/settings/security" icon="lock" label="Security" value={user.twoFactorEnabled ? "2FA on" : "2FA off"} />
            <SettingsRow href="#notifications" icon="bell" label="Notifications" />
            <SettingsRow href="#api-keys" icon="key" label="API keys" />
          </div>
        </div>

        {admin && (
          <div>
            <p className="list-title">Installation</p>
            <div className="list-group">
              <SettingsRow href="/dashboard/admin" icon="admin" label="Admin console" value={isOwnerRole(user.role) ? undefined : "limited"} />
            </div>
          </div>
        )}

        <div>
          <p className="list-title">Appearance</p>
          <div className="card p-4">
            <p className="mb-3 flex items-center gap-2.5 text-[15px] text-ink">
              <Icon name="moon" size={20} className="text-ink-2" /> Colour mode
            </p>
            <ThemeChoice className="max-w-md" />
            <p className="mt-3 text-[13px] text-ink-3">Kept in this browser. “System” follows how the device is set.</p>
          </div>
        </div>

        <LogoutRow />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card
          title="Plan and tokens"
          description={
            tokens.limit === null
              ? "What your work has used. An owner sets what every role has under Plans."
              : "What your work may use in a month, and what it has used: chat, the runs of your projects, media, knowledge, and your API keys. On the first of the month the count starts again."
          }
          actions={
            <Link href="/dashboard/plans" className="btn-ghost px-3 py-1.5 text-xs">
              {admin ? "Plans" : "See the plans"}
            </Link>
          }
        >
          <TokenMeter tokens={tokens} id="token-balance" inputPercent={Math.round(settings.inputWeight * 100)} />
        </Card>

        <Card title="Account">
          <dl className="space-y-3 text-sm">
            <Row label="Username" value={user.username} />
            <Row label="Email" value={user.email} />
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
          <Link href="/dashboard/settings/security" className="btn-ghost mt-4 w-full justify-between">
            <span className="flex items-center gap-2.5">
              <Icon name="lock" size={17} /> Two-factor authentication
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
        keysInPlan={accountHas(user, "api_keys")}
        keysNotInPlan={notInPlan(settings, tier, "api_keys")}
      />
    </div>
  );
}

/** A row of a settings list: where it leads, and what is set there now. */
function SettingsRow({ href, icon, label, value }: { href: string; icon: IconName; label: string; value?: string }) {
  return (
    <Link href={href} className="list-row">
      <Icon name={icon} size={20} className="shrink-0 text-ink-2" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value && <span className="shrink-0 text-[15px] text-ink-3">{value}</span>}
      <Icon name="right" size={18} className="shrink-0 text-ink-3" />
    </Link>
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
