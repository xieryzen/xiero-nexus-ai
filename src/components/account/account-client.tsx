"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PublicUser } from "@/lib/auth";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

/**
 * A person's own sign-in details: username, email and password. Each change
 * asks for the current password.
 */
export function AccountClient({ username, email }: { username: string; email: string }) {
  const router = useRouter();
  const [identity, setIdentity] = useState({ username, email, currentPassword: "" });
  const [saved, setSaved] = useState({ username, email });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", again: "" });
  const [busy, setBusy] = useState<"identity" | "password" | null>(null);
  const [error, setError] = useState<{ form: "identity" | "password"; message: string } | null>(null);
  const [done, setDone] = useState<{ form: "identity" | "password"; message: string } | null>(null);

  async function send(form: "identity" | "password", body: Record<string, string>, said: string): Promise<boolean> {
    setBusy(form);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ user: PublicUser }>("/api/account/me", { method: "PATCH", body: JSON.stringify(body) });
      setSaved({ username: res.user.username, email: res.user.email });
      setDone({ form, message: said });
      router.refresh();
      return true;
    } catch (err) {
      setError({ form, message: err instanceof ApiError ? err.message : "That could not be saved" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const identityChanged = identity.username !== saved.username || identity.email !== saved.email;
  const mismatch = password.again !== "" && password.again !== password.newPassword;

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <Card title="Username and email" description="What you sign in with. Either of the two works.">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await send(
              "identity",
              { username: identity.username, email: identity.email, currentPassword: identity.currentPassword },
              "Saved.",
            );
            if (ok) setIdentity((v) => ({ ...v, currentPassword: "" }));
          }}
        >
          {error?.form === "identity" && <Alert tone="danger">{error.message}</Alert>}
          {done?.form === "identity" && <Alert tone="ok">{done.message}</Alert>}
          <Field label="Username" htmlFor="account-username" hint="3 to 32 letters, numbers, and . _ -">
            <Input
              id="account-username"
              value={identity.username}
              onChange={(e) => setIdentity({ ...identity, username: e.target.value })}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Email" htmlFor="account-email">
            <Input
              id="account-email"
              type="email"
              value={identity.email}
              onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Your password" htmlFor="account-current" hint="To confirm that it is you.">
            <Input
              id="account-current"
              type="password"
              value={identity.currentPassword}
              onChange={(e) => setIdentity({ ...identity, currentPassword: e.target.value })}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button id="account-save" type="submit" loading={busy === "identity"} disabled={!identityChanged || !identity.currentPassword}>
            Save
          </Button>
        </form>
      </Card>

      <Card title="Password" description="A new password signs you out everywhere else.">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (password.newPassword !== password.again) return;
            const ok = await send(
              "password",
              { currentPassword: password.currentPassword, newPassword: password.newPassword },
              "Your password was changed. Other sessions were signed out.",
            );
            if (ok) setPassword({ currentPassword: "", newPassword: "", again: "" });
          }}
        >
          {error?.form === "password" && <Alert tone="danger">{error.message}</Alert>}
          {done?.form === "password" && <Alert tone="ok">{done.message}</Alert>}
          <Field label="Current password" htmlFor="password-current">
            <Input
              id="password-current"
              type="password"
              value={password.currentPassword}
              onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="New password" htmlFor="password-new" hint="At least 10 characters.">
            <Input
              id="password-new"
              type="password"
              value={password.newPassword}
              onChange={(e) => setPassword({ ...password, newPassword: e.target.value })}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </Field>
          <Field label="New password, again" htmlFor="password-again" error={mismatch ? "The two are not the same" : null}>
            <Input
              id="password-again"
              type="password"
              value={password.again}
              onChange={(e) => setPassword({ ...password, again: e.target.value })}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </Field>
          <Button
            id="password-save"
            type="submit"
            loading={busy === "password"}
            disabled={!password.currentPassword || password.newPassword.length < 10 || password.newPassword !== password.again}
          >
            Change the password
          </Button>
        </form>
      </Card>
    </div>
  );
}
