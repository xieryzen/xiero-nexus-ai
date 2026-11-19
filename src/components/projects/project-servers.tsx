"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { SERVERS_PER_PROJECT } from "@/lib/ssh/rules";
import { Alert, Button, Card } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ServerOption {
  id: string;
  /** The server's name. */
  label: string;
  /** Where it is and who signs in, for the one who chooses. */
  where: string;
  /** Switched off on the Servers page: a project that names it does not run. */
  off: boolean;
}

const WHAT_IT_MEANS =
  "The agents of this project that have the tool “Work on servers” can run any command there, as the account that is registered. " +
  "A run opens one connection to each server and keeps it open until the run has ended; every command is written down on the Servers page.";

/** Names in one line: the first ones, and how many more there are. */
function namesOf(names: string[], shown = 6): string {
  return names.length <= shown ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/** The servers to choose from, as tick boxes. */
export function ServerChoice({
  options,
  chosen,
  onChange,
  disabled,
  idPrefix = "p-server",
}: {
  options: ServerOption[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const full = chosen.length >= SERVERS_PER_PROJECT;
  return (
    <div className="space-y-2">
      <ul className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const checked = chosen.includes(option.id);
          return (
            <li key={option.id}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-surface-2/40 px-3 py-2">
                <input
                  type="checkbox"
                  id={`${idPrefix}-${option.label}`}
                  className="mt-0.5"
                  checked={checked}
                  disabled={disabled || (!checked && full)}
                  onChange={(e) => onChange(e.target.checked ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {option.label}
                    {option.off && <span className="text-warn"> · switched off</span>}
                  </span>
                  <span className="mono block break-all text-xs text-ink-3">{option.where}</span>
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

/** The servers of a project that is there already, and changing them. */
export function ProjectServers({
  projectId,
  options,
  initial,
  operators,
  mayChange,
  busy,
}: {
  projectId: string;
  /** The servers this account and the project's account may both use. */
  options: ServerOption[];
  /** The servers the project names now. */
  initial: { id: string; name: string }[];
  /** The agents of this project that have the tool to work on servers, by name. */
  operators: string[];
  /** Whether this account may run and change the project (it may use every server the project names). */
  mayChange: boolean;
  /** A run is in progress: the servers are changed between runs. */
  busy: boolean;
}) {
  const [saved, setSaved] = useState(initial.map((s) => s.id));
  const [chosen, setChosen] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = chosen.length !== saved.length || chosen.some((id) => !saved.includes(id));

  if (options.length === 0 && initial.length === 0) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ serverIds: chosen }) });
      setSaved(chosen);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The servers could not be changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={<span className="flex items-center gap-2"><Icon name="server" size={16} /> Servers</span>}
      description="The machines the agents of this project may work on over SSH."
      className="mb-6"
    >
      <div id="project-servers" className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {mayChange ? (
          <>
            <ServerChoice options={options} chosen={chosen} onChange={setChosen} disabled={busy || saving} idPrefix="ps-server" />
            {changed && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setChosen(saved)} disabled={saving}>Cancel</Button>
                <Button onClick={save} loading={saving} disabled={busy}>Save servers</Button>
              </div>
            )}
            {/* Naming a server reaches nothing unless an agent of the project has the tool. */}
            {saved.length > 0 &&
              (operators.length > 0 ? (
                <p className="text-xs text-ink-3" data-testid="server-operators">
                  Agents that can work there: <span className="text-ink-2">{namesOf(operators)}</span>.
                </p>
              ) : (
                <Alert tone="warn">
                  None of the agents of this project has the tool “Work on servers”, so nothing can be run on its servers. Give it to the agents
                  that are to work there (Agents page, Edit), then run the project.
                </Alert>
              ))}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              Works on: <span className="text-ink">{initial.map((s) => s.name).join(", ")}</span>
            </p>
            <Alert tone="warn">
              A server of this project is for owners only. You can read the project; an owner runs it, changes it and sets its schedules.
            </Alert>
          </>
        )}
      </div>
    </Card>
  );
}
