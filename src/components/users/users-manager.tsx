"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import type { PublicUser } from "@/lib/auth";
import { apiFetch, ApiError } from "@/lib/client";
import { ROLES, roleLabel, type Role } from "@/lib/roles";
import { DateTime } from "@/components/time";
import { Alert, Badge, Button, Card, Field, Input, Select, StatusDot } from "@/components/ui";

type Patch = {
  username?: string;
  email?: string;
  password?: string;
  role?: Role;
  status?: "active" | "disabled";
  resetTwoFactor?: true;
  signOut?: true;
};

/** A password to hand to someone: 18 characters, none that look alike. */
function randomPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const roleTone = (role: string) => (role === "owner" ? "signal" : role === "admin" ? "info" : "neutral");

export function UsersManager({
  initialUsers,
  currentUserId,
  canManage,
}: {
  initialUsers: PublicUser[];
  currentUserId: string;
  /** An owner manages the accounts; an administrator sees them. */
  canManage: boolean;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // The form for a new account.
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState({ username: "", email: "", password: "", role: "user" as Role });
  const [showPassword, setShowPassword] = useState(false);

  // What is typed for the account that is open.
  const [draft, setDraft] = useState({ username: "", email: "", password: "" });

  const fail = (err: unknown, fallback: string) => {
    setDone(null);
    setError(err instanceof ApiError ? err.message : fallback);
  };

  function manage(u: PublicUser) {
    setError(null);
    setConfirmDelete(null);
    if (open === u.id) {
      setOpen(null);
      return;
    }
    setOpen(u.id);
    setDraft({ username: u.username, email: u.email, password: "" });
  }

  async function update(u: PublicUser, patch: Patch, said: string): Promise<boolean> {
    setBusy((b) => ({ ...b, [u.id]: true }));
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ user: PublicUser }>(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setUsers((list) => list.map((x) => (x.id === u.id ? res.user : x)));
      setDone(said);
      return true;
    } catch (err) {
      fail(err, "The account could not be changed");
      return false;
    } finally {
      setBusy((b) => ({ ...b, [u.id]: false }));
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ user: PublicUser }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(fresh),
      });
      setUsers((list) => [res.user, ...list]);
      setDone(`The account "${res.user.username}" was made. Give its owner the password: it is not shown again.`);
      setFresh({ username: "", email: "", password: "", role: "user" });
      setShowPassword(false);
      setAdding(false);
    } catch (err) {
      fail(err, "The account could not be made");
    } finally {
      setCreating(false);
    }
  }

  async function remove(u: PublicUser) {
    setBusy((b) => ({ ...b, [u.id]: true }));
    setError(null);
    setDone(null);
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      setUsers((list) => list.filter((x) => x.id !== u.id));
      setOpen(null);
      setConfirmDelete(null);
      setDone(`The account "${u.username}" was deleted. What it made is still there.`);
    } catch (err) {
      fail(err, "The account could not be deleted");
    } finally {
      setBusy((b) => ({ ...b, [u.id]: false }));
    }
  }

  return (
    <div className="space-y-6">
      {!canManage && (
        <Alert tone="neutral">Accounts are managed by an owner. You can see them here, and change none.</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="ok">{done}</Alert>}

      {canManage && (
        <Card
          title="New account"
          description="For someone who is to work here. They sign in with the username or the email, and the password you give them."
          actions={
            <Button id="new-account" variant={adding ? "ghost" : "primary"} onClick={() => setAdding((v) => !v)}>
              {adding ? "Close" : "New account"}
            </Button>
          }
        >
          {adding ? (
            <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
              <Field label="Username" htmlFor="new-username" hint="3 to 32 letters, numbers, and . _ -">
                <Input
                  id="new-username"
                  value={fresh.username}
                  onChange={(e) => setFresh({ ...fresh, username: e.target.value })}
                  autoComplete="off"
                  required
                />
              </Field>
              <Field label="Email" htmlFor="new-email">
                <Input
                  id="new-email"
                  type="email"
                  value={fresh.email}
                  onChange={(e) => setFresh({ ...fresh, email: e.target.value })}
                  autoComplete="off"
                  required
                />
              </Field>
              <Field label="Password" htmlFor="new-password" hint="At least 10 characters. It is not shown again after this.">
                <div className="flex gap-2">
                  <Input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    value={fresh.password}
                    onChange={(e) => setFresh({ ...fresh, password: e.target.value })}
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setFresh({ ...fresh, password: randomPassword() });
                      setShowPassword(true);
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </Field>
              <Field label="Role" htmlFor="new-role" hint={roleHint(fresh.role)}>
                <Select id="new-role" value={fresh.role} onChange={(e) => setFresh({ ...fresh, role: e.target.value as Role })}>
                  {[...ROLES].reverse().map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Button id="create-account" type="submit" loading={creating}>
                  Make the account
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-ink-2">
              {users.length} {users.length === 1 ? "account" : "accounts"}:{" "}
              {ROLES.map((role) => {
                const count = users.filter((u) => u.role === role).length;
                return `${count} ${roleLabel(role).toLowerCase()}${count === 1 ? "" : "s"}`;
              }).join(", ")}
              .
            </p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="-m-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                <th className="px-5 py-2.5 font-medium">User</th>
                <th className="px-5 py-2.5 font-medium">2FA</th>
                <th className="px-5 py-2.5 font-medium">Role</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium">Joined</th>
                {canManage && <th className="px-5 py-2.5 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                const editable = canManage && !isSelf;
                return (
                  <Fragment key={u.id}>
                    <tr data-user={u.username}>
                      <td className="px-5 py-3">
                        <div className="font-medium text-ink">
                          {u.username}
                          {isSelf && <span className="ml-2 text-xs text-ink-3">(you)</span>}
                        </div>
                        <div className="text-xs text-ink-3">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={u.twoFactorEnabled ? "ok" : "neutral"}>{u.twoFactorEnabled ? "on" : "off"}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        {editable ? (
                          <Select
                            className="w-36"
                            aria-label={`Role of ${u.username}`}
                            value={u.role}
                            disabled={busy[u.id]}
                            onChange={(e) =>
                              update(u, { role: e.target.value as Role }, `"${u.username}" is ${roleLabel(e.target.value).toLowerCase()} now.`)
                            }
                          >
                            {[...ROLES].reverse().map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone={roleTone(u.role)}>{roleLabel(u.role)}</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {editable ? (
                          <Button
                            variant="ghost"
                            loading={busy[u.id]}
                            title={u.status === "active" ? "Switch the account off: it can no longer sign in" : "Switch the account on again"}
                            onClick={() =>
                              update(
                                u,
                                { status: u.status === "active" ? "disabled" : "active" },
                                u.status === "active"
                                  ? `"${u.username}" is switched off and signed out.`
                                  : `"${u.username}" can sign in again.`,
                              )
                            }
                          >
                            <StatusDot tone={u.status === "active" ? "ok" : "danger"} />
                            {u.status}
                          </Button>
                        ) : (
                          <span className="inline-flex items-center gap-2 text-ink-2">
                            <StatusDot tone={u.status === "active" ? "ok" : "danger"} /> {u.status}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-ink-3">
                        <DateTime at={u.createdAt} />
                      </td>
                      {canManage && (
                        <td className="px-5 py-3 text-right">
                          {isSelf ? (
                            <Link href="/dashboard/settings" className="text-sm text-signal hover:underline">
                              Your account
                            </Link>
                          ) : (
                            <Button variant="ghost" onClick={() => manage(u)} aria-expanded={open === u.id}>
                              {open === u.id ? "Close" : "Manage"}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                    {editable && open === u.id && (
                      <tr data-manage={u.username} className="bg-surface-2">
                        <td colSpan={6} className="px-5 py-4">
                          <div className="grid gap-5 lg:grid-cols-2">
                            <form
                              className="space-y-3"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void update(u, { username: draft.username, email: draft.email }, "The username and the email were saved.");
                              }}
                            >
                              <Field label="Username" htmlFor={`username-${u.id}`}>
                                <Input
                                  id={`username-${u.id}`}
                                  value={draft.username}
                                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                                  autoComplete="off"
                                  required
                                />
                              </Field>
                              <Field label="Email" htmlFor={`email-${u.id}`}>
                                <Input
                                  id={`email-${u.id}`}
                                  type="email"
                                  value={draft.email}
                                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                                  autoComplete="off"
                                  required
                                />
                              </Field>
                              <Button
                                type="submit"
                                variant="ghost"
                                loading={busy[u.id]}
                                disabled={draft.username === u.username && draft.email === u.email}
                              >
                                Save the name and the email
                              </Button>
                            </form>

                            <div className="space-y-4">
                              <form
                                className="space-y-3"
                                onSubmit={async (e) => {
                                  e.preventDefault();
                                  const ok = await update(
                                    u,
                                    { password: draft.password },
                                    `"${u.username}" has a new password and was signed out everywhere. Give it to them: it is not shown again.`,
                                  );
                                  if (ok) setDraft((d) => ({ ...d, password: "" }));
                                }}
                              >
                                <Field
                                  label="New password"
                                  htmlFor={`password-${u.id}`}
                                  hint="At least 10 characters. Setting it signs the account out everywhere."
                                >
                                  <div className="flex gap-2">
                                    <Input
                                      id={`password-${u.id}`}
                                      type="text"
                                      value={draft.password}
                                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                                      autoComplete="off"
                                      minLength={10}
                                      required
                                    />
                                    <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, password: randomPassword() })}>
                                      Generate
                                    </Button>
                                  </div>
                                </Field>
                                <Button type="submit" variant="ghost" loading={busy[u.id]} disabled={draft.password.length < 10}>
                                  Set the password
                                </Button>
                              </form>

                              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                                <Button
                                  variant="ghost"
                                  loading={busy[u.id]}
                                  onClick={() => update(u, { signOut: true }, `"${u.username}" was signed out everywhere.`)}
                                >
                                  Sign out everywhere
                                </Button>
                                {u.twoFactorEnabled && (
                                  <Button
                                    variant="ghost"
                                    loading={busy[u.id]}
                                    title="For someone who lost their authenticator: two-factor sign-in is switched off, and they set it up again"
                                    onClick={() =>
                                      update(u, { resetTwoFactor: true }, `Two-factor sign-in of "${u.username}" is switched off. They were signed out everywhere.`)
                                    }
                                  >
                                    Switch two-factor off
                                  </Button>
                                )}
                                {confirmDelete === u.id ? (
                                  <>
                                    <span className="text-sm text-ink-2">Delete &quot;{u.username}&quot;? What it made stays.</span>
                                    <Button variant="danger" loading={busy[u.id]} onClick={() => remove(u)}>
                                      Delete
                                    </Button>
                                    <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                                      Keep
                                    </Button>
                                  </>
                                ) : (
                                  <Button variant="ghost" onClick={() => setConfirmDelete(u.id)}>
                                    Delete the account
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function roleHint(role: Role): string {
  if (role === "owner") return "Everything an administrator does, and the accounts.";
  if (role === "admin") return "Providers, models, agents, teams, workflows, skills, and everyone's projects.";
  return "Their own projects, chats, media and keys.";
}
