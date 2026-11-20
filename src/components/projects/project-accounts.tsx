"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { ACCOUNTS_PER_PROJECT, ofOneSite } from "@/lib/browser/rules";
import { Alert, Button, Card } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface AccountOption {
  id: string;
  /** The account's name. */
  label: string;
  /** Who it signs in as, and where, for the one who chooses. */
  where: string;
  /** The site it signs in to: its host. A project names one account of a site. */
  site: string;
  /** Switched off on the Browser page: a project that names it does not run. */
  off: boolean;
}

const WHAT_IT_MEANS =
  "The agents of this project that have the tool “Work in a browser” can sign in to these sites, and do there whatever the account can. " +
  "The app fills in the password; an agent is never shown it. Where a site asks for a CAPTCHA or a code, the task waits for you. " +
  "One account of a site: a run has one browser, which is signed in to a site as one account at a time. " +
  "Everything that is done is written down on the Browser page.";

/** The account that is chosen already for the site of this one, if any: a project names one account of a site. */
function chosenOfSite(option: AccountOption, options: AccountOption[], chosen: string[]): AccountOption | undefined {
  return options.find((other) => other.id !== option.id && chosen.includes(other.id) && ofOneSite(`https://${other.site}/`, `https://${option.site}/`));
}

/** Names in one line: the first ones, and how many more there are. */
function namesOf(names: string[], shown = 6): string {
  return names.length <= shown ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/** The site accounts to choose from, as tick boxes. */
export function AccountChoice({
  options,
  chosen,
  onChange,
  disabled,
  idPrefix = "p-account",
}: {
  options: AccountOption[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const full = chosen.length >= ACCOUNTS_PER_PROJECT;
  return (
    <div className="space-y-2">
      <ul className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const checked = chosen.includes(option.id);
          // Another account of the same site is chosen: this one waits until that one is taken out.
          const taken = checked ? undefined : chosenOfSite(option, options, chosen);
          return (
            <li key={option.id}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-surface-2/40 px-3 py-2">
                <input
                  type="checkbox"
                  id={`${idPrefix}-${option.label}`}
                  className="mt-0.5"
                  checked={checked}
                  disabled={disabled || (!checked && (full || Boolean(taken)))}
                  onChange={(e) => onChange(e.target.checked ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {option.label}
                    {option.off && <span className="text-warn"> · switched off</span>}
                  </span>
                  <span className="mono block break-all text-xs text-ink-3">{option.where}</span>
                  {taken && <span className="block text-xs text-ink-3">The same site as {taken.label}: one of them.</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-ink-3">{WHAT_IT_MEANS}</p>
    </div>
  );
}

/** The site accounts of a project that is there already, and changing them. */
export function ProjectAccounts({
  projectId,
  options,
  initial,
  agents,
  ready,
  mayChange,
  busy,
}: {
  projectId: string;
  /** The accounts this user and the project's account may both use. */
  options: AccountOption[];
  /** The accounts the project names now. */
  initial: { id: string; name: string }[];
  /** The agents of this project that have the tool to work in a browser, by name. */
  agents: string[];
  /** Whether a browser service is set up on this server. */
  ready: boolean;
  /** Whether this user may run and change the project (they may use every account the project names). */
  mayChange: boolean;
  /** A run is in progress: the accounts are changed between runs. */
  busy: boolean;
}) {
  const [saved, setSaved] = useState(initial.map((a) => a.id));
  const [chosen, setChosen] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = chosen.length !== saved.length || chosen.some((id) => !saved.includes(id));

  if (options.length === 0 && initial.length === 0) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ siteAccountIds: chosen }) });
      setSaved(chosen);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The site accounts could not be changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={<span className="flex items-center gap-2"><Icon name="browser" size={16} /> Site accounts</span>}
      description="The accounts the agents of this project may sign in to web sites with."
      className="mb-6"
    >
      <div id="project-accounts" className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {mayChange ? (
          <>
            <AccountChoice options={options} chosen={chosen} onChange={setChosen} disabled={busy || saving} idPrefix="pa-account" />
            {changed && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setChosen(saved)} disabled={saving}>Cancel</Button>
                <Button onClick={save} loading={saving} disabled={busy}>Save site accounts</Button>
              </div>
            )}
            {/* Naming an account signs nobody in unless there is a browser, and an agent of the project that works in it. */}
            {saved.length > 0 &&
              (!ready ? (
                <Alert tone="warn">
                  No browser service is set up on this server (BROWSER_URL), so nothing can be opened or signed in to. See the Browser page.
                </Alert>
              ) : agents.length > 0 ? (
                <p className="text-xs text-ink-3" data-testid="account-agents">
                  Agents that can sign in with them: <span className="text-ink-2">{namesOf(agents)}</span>.
                </p>
              ) : (
                <Alert tone="warn">
                  None of the agents of this project has the tool “Work in a browser”, so nothing is signed in to. Give it to the agents that are to
                  work on these sites (Agents page, Edit), then run the project.
                </Alert>
              ))}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              Signs in with: <span className="text-ink">{initial.map((a) => a.name).join(", ")}</span>
            </p>
            <Alert tone="warn">
              A site account of this project is for owners only. You can read the project; an owner runs it, changes it and sets its schedules.
            </Alert>
          </>
        )}
      </div>
    </Card>
  );
}
