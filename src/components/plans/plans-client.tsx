"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import type { Feature } from "@/lib/plan-rules";
import { PLANS, tierLabel, tierRank, type Tier } from "@/lib/roles";
import { formatTokens, parseTokens, renewalDay, shortTokens } from "@/lib/token-rules";
import { Icon } from "@/components/icons";
import { Alert, Badge, Button, Card, Input, cn } from "@/components/ui";

export interface PlanRow {
  tier: Tier;
  /** Null: not limited. */
  monthlyTokens: number | null;
  features: Feature[];
}

interface FeatureRow {
  id: Feature;
  name: string;
  text: string;
}

interface Answer {
  inputWeight: number;
  plans: PlanRow[];
  changed: boolean;
}

/** One line under the name of a plan. */
const TAGLINE: Record<Tier, string> = {
  free: "To try it, and for light use",
  pro: "For everyday work",
  plus: "For those who make a lot",
  ultra: "Everything, with the most room",
  admin: "Helps run the installation",
  owner: "Runs the installation",
};

export function PlansClient({
  tier,
  canManage,
  changed: changedAtLoad,
  inputWeight: weightAtLoad,
  plans: plansAtLoad,
  features,
  own,
}: {
  /** The role of the reader. */
  tier: Tier;
  /** An owner changes the plans. */
  canManage: boolean;
  /** Whether the plans differ from what the app ships with. */
  changed: boolean;
  inputWeight: number;
  plans: PlanRow[];
  features: FeatureRow[];
  /** The reader's own tokens this month. */
  own: { limit: number | null; used: number; left: number | null; custom: boolean; renewsAt: number };
}) {
  const [plans, setPlans] = useState(plansAtLoad);
  const [inputWeight, setInputWeight] = useState(weightAtLoad);
  const [changed, setChanged] = useState(changedAtLoad);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // What is typed while editing: tokens as text, features as sets, the weight in percent.
  const [draftTokens, setDraftTokens] = useState<Record<string, string>>({});
  const [draftFeatures, setDraftFeatures] = useState<Record<string, Feature[]>>({});
  const [draftWeight, setDraftWeight] = useState("");

  const byTier = (t: Tier) => plans.find((p) => p.tier === t)!;
  const userPlans = PLANS.map(byTier);
  const editable: Tier[] = ["free", "pro", "plus", "ultra", "admin"];

  function startEditing() {
    setError(null);
    setDone(null);
    setDraftTokens(Object.fromEntries(editable.map((t) => [t, formatTokens(byTier(t).monthlyTokens ?? 0)])));
    setDraftFeatures(Object.fromEntries(PLANS.map((t) => [t, [...byTier(t).features]])));
    setDraftWeight(String(Math.round(inputWeight * 100)));
    setEditing(true);
  }

  /** Ticking a feature for a plan ticks it for the plans above; unticking it unticks it below. */
  function toggle(plan: Tier, feature: Feature) {
    setDraftFeatures((draft) => {
      const has = draft[plan]?.includes(feature) ?? false;
      const next: Record<string, Feature[]> = { ...draft };
      for (const other of PLANS) {
        const list = new Set(next[other] ?? []);
        if (!has && tierRank(other) >= tierRank(plan)) list.add(feature);
        if (has && tierRank(other) <= tierRank(plan)) list.delete(feature);
        next[other] = features.map((f) => f.id).filter((id) => list.has(id));
      }
      return next;
    });
  }

  const tokensOk = editable.every((t) => parseTokens(draftTokens[t] ?? "") !== null);
  const weightValue = Number(draftWeight);
  const weightOk = draftWeight.trim() !== "" && Number.isFinite(weightValue) && weightValue >= 0 && weightValue <= 100;

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const body = {
        inputWeight: Math.round(weightValue) / 100,
        plans: Object.fromEntries(
          editable.map((t) => [t, { monthlyTokens: parseTokens(draftTokens[t] ?? "") ?? 0, ...(t === "admin" ? {} : { features: draftFeatures[t] ?? [] }) }]),
        ),
      };
      const res = await apiFetch<Answer>("/api/admin/plans", { method: "PUT", body: JSON.stringify(body) });
      setPlans(res.plans);
      setInputWeight(res.inputWeight);
      setChanged(res.changed);
      setEditing(false);
      setDone("The plans were saved. They hold from now on, for every account.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The plans could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm("Set every plan back to what the app ships with?")) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<Answer>("/api/admin/plans", { method: "DELETE" });
      setPlans(res.plans);
      setInputWeight(res.inputWeight);
      setChanged(res.changed);
      setEditing(false);
      setDone("The plans are what the app ships with again.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The plans could not be set back");
    } finally {
      setBusy(false);
    }
  }

  const percent = Math.round(inputWeight * 100);

  return (
    <div className="space-y-6" id="plans">
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="ok">{done}</Alert>}

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="plan-cards">
        {userPlans.map((plan) => {
          const mine = plan.tier === tier;
          return (
            <li
              key={plan.tier}
              data-plan={plan.tier}
              className={cn("card flex flex-col p-5", mine && "border-accent ring-1 ring-accent/40")}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="serif text-2xl font-medium tracking-tight text-ink">{tierLabel(plan.tier)}</h2>
                {mine && <Badge tone="signal">Your plan</Badge>}
              </div>
              <p className="mt-0.5 text-sm text-ink-3">{TAGLINE[plan.tier]}</p>
              <p className="mt-4 text-ink">
                <span className="text-3xl font-semibold tracking-tight" title={`${formatTokens(plan.monthlyTokens ?? 0)} tokens`}>
                  {shortTokens(plan.monthlyTokens ?? 0)}
                </span>
                <span className="ml-1.5 text-sm text-ink-3">tokens a month</span>
              </p>
              <ul className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
                <li className="flex items-start gap-2 text-ink-2">
                  <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" />
                  <span>Chat with the assistant: it acts, remembers, and works with what you hand it</span>
                </li>
                {features.map((feature) => {
                  const has = plan.features.includes(feature.id);
                  return (
                    <li key={feature.id} data-feature={feature.id} data-has={has ? "true" : "false"} className={cn("flex items-start gap-2", has ? "text-ink-2" : "text-ink-3")}>
                      <Icon name={has ? "check" : "x"} size={16} className={cn("mt-0.5 shrink-0", has ? "text-ok" : "text-ink-3/60")} />
                      <span className={cn(!has && "line-through decoration-ink-3/40")} title={feature.text}>
                        {feature.name}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Your tokens this month">
          {own.limit === null ? (
            <p className="text-sm text-ink-2">
              You are the owner: your work is held to no allowance. It is counted all the same: {formatTokens(own.used)} tokens this month.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-2">
                <span className="font-medium text-ink">{formatTokens(own.left ?? 0)}</span> of {formatTokens(own.limit)} left
                {own.custom ? " (an allowance of your own, set by the owner)" : ""}. They are there again on {renewalDay(own.renewsAt)}.
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
                <div
                  className={cn("h-full rounded-full", own.left === 0 ? "bg-danger" : "bg-accent")}
                  style={{ width: `${own.limit === 0 ? 100 : Math.min(100, Math.round((own.used / own.limit) * 100))}%` }}
                />
              </div>
            </>
          )}
        </Card>
        <Card title="How tokens are counted">
          <p className="text-sm text-ink-2">
            What the assistant writes counts in full. What it is sent, your message and everything before it, counts{" "}
            <span className="font-medium text-ink" data-testid="input-percent">
              {percent} percent
            </span>
            . An agent that works with tools sends the same conversation again with every step, so a long piece of work is mostly text that was sent
            before: counted in full, an allowance would be gone half way through one document. On the first of each month the count starts again.
          </p>
        </Card>
      </div>

      {(tier === "admin" || tier === "owner") && (
        <Card title="Admin and owner">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-ink">Admin</dt>
              <dd className="mt-0.5 text-ink-2">
                {formatTokens(byTier("admin").monthlyTokens ?? 0)} tokens a month, every feature, and a limited admin area: agents, teams, workflows
                and skills to manage, the rest to look at.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink">Owner</dt>
              <dd className="mt-0.5 text-ink-2">No allowance, every feature, and the whole admin area: accounts, plans, providers and models.</dd>
            </div>
          </dl>
        </Card>
      )}

      {canManage && (
        <Card
          title="Change the plans"
          description="A higher plan has at least what the one below it has: ticking a feature ticks it for the plans above, and tokens cannot go down from one plan to the next."
          actions={
            !editing ? (
              <Button id="edit-plans" variant="ghost" onClick={startEditing}>
                <Icon name="pencil" size={16} /> Change
              </Button>
            ) : undefined
          }
        >
          {!editing ? (
            <p className="text-sm text-ink-2">
              {changed ? "These plans were changed on this installation." : "These plans are what the app ships with."}{" "}
              {changed && (
                <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => void reset()} disabled={busy}>
                  Set them back
                </button>
              )}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-5"
            >
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full min-w-[40rem] text-sm" data-testid="plans-editor">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-3">
                      <th className="py-2 pr-3 font-medium">Role</th>
                      <th className="py-2 pr-3 font-medium">Tokens a month</th>
                      {features.map((feature) => (
                        <th key={feature.id} className="px-1.5 py-2 text-center font-medium" title={feature.text}>
                          {feature.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {editable.map((t) => (
                      <tr key={t} data-edit-plan={t}>
                        <td className="py-2 pr-3 font-medium text-ink">{tierLabel(t)}</td>
                        <td className="py-2 pr-3">
                          <Input
                            className="w-36"
                            inputMode="text"
                            aria-label={`Tokens a month of ${tierLabel(t)}`}
                            value={draftTokens[t] ?? ""}
                            onChange={(e) => setDraftTokens((d) => ({ ...d, [t]: e.target.value }))}
                            autoComplete="off"
                          />
                          <div className="mt-0.5 text-[11px] text-ink-3">
                            {parseTokens(draftTokens[t] ?? "") === null ? "A whole number: 10,000,000 or 10M." : formatTokens(parseTokens(draftTokens[t] ?? "") ?? 0)}
                          </div>
                        </td>
                        {features.map((feature) => (
                          <td key={feature.id} className="px-1.5 py-2 text-center">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-current"
                              aria-label={`${tierLabel(t)}: ${feature.name}`}
                              checked={t === "admin" ? true : (draftFeatures[t]?.includes(feature.id) ?? false)}
                              disabled={t === "admin"}
                              onChange={() => toggle(t, feature.id)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="max-w-md">
                <label htmlFor="input-weight" className="label">
                  What a token of input counts, in percent
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input id="input-weight" className="w-24" inputMode="numeric" value={draftWeight} onChange={(e) => setDraftWeight(e.target.value)} autoComplete="off" />
                  <span className="text-sm text-ink-3">% of a token of output</span>
                </div>
                <p className="mt-1.5 text-xs text-ink-3">
                  100: every token counts in full, as before version 2. 25 is what the app ships with: an allowance lasts about three times as long for
                  work with tools. 0: only what the assistant writes counts.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button id="save-plans" type="submit" loading={busy} disabled={!tokensOk || !weightOk}>
                  Save the plans
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
                {changed && (
                  <Button type="button" variant="ghost" onClick={() => void reset()} disabled={busy}>
                    Back to what the app ships with
                  </Button>
                )}
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
