"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, Field, Input, StatusDot } from "@/components/ui";

type Mode = "view" | "enroll" | "disable" | "regen";

export function SecurityClient({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [mode, setMode] = useState<Mode>("view");
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // form fields
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  function reset() {
    setError(null);
    setPassword("");
    setToken("");
    setRecoveryCode("");
  }

  async function startEnroll() {
    reset();
    setLoading(true);
    try {
      const res = await apiFetch<{ secret: string; qr: string }>("/api/account/2fa/setup", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSetup({ secret: res.secret, qr: res.qr });
      setMode("enroll");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start setup");
    } finally {
      setLoading(false);
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ recoveryCodes: string[] }>("/api/account/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ password, token }),
      });
      setRecoveryCodes(res.recoveryCodes);
      setEnabled(true);
      setSetup(null);
      setMode("view");
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enable 2FA");
    } finally {
      setLoading(false);
    }
  }

  async function doDisable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/account/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ password, ...(token ? { token } : { recoveryCode }) }),
      });
      setEnabled(false);
      setMode("view");
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disable 2FA");
    } finally {
      setLoading(false);
    }
  }

  async function doRegen(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ recoveryCodes: string[] }>("/api/account/2fa/recovery", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setRecoveryCodes(res.recoveryCodes);
      setMode("view");
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not regenerate codes");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card
      title="Two-factor authentication"
      description="Protect your account with a time-based one-time code (TOTP)."
      actions={
        <Badge tone={enabled ? "ok" : "neutral"}>
          <StatusDot tone={enabled ? "ok" : "neutral"} />
          {enabled ? "On" : "Off"}
        </Badge>
      }
    >
      {recoveryCodes && (
        <div className="mb-5">
          <RecoveryCodes codes={recoveryCodes} onDismiss={() => setRecoveryCodes(null)} />
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {/* VIEW */}
      {mode === "view" && !enabled && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-ink-2">
            Add a second factor using an authenticator app (Google Authenticator,
            1Password, Aegis, etc.). You’ll confirm your password and a code to turn it on.
          </p>
          <Button onClick={startEnroll} loading={loading}>
            Set up authenticator
          </Button>
        </div>
      )}

      {mode === "view" && enabled && (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => { reset(); setMode("regen"); }}>
            Regenerate recovery codes
          </Button>
          <Button variant="danger" onClick={() => { reset(); setMode("disable"); }}>
            Disable 2FA
          </Button>
        </div>
      )}

      {/* ENROLL */}
      {mode === "enroll" && setup && (
        <form onSubmit={confirmEnroll} className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={setup.qr}
              alt="TOTP QR code"
              width={176}
              height={176}
              className="rounded-md border border-line bg-white p-2"
            />
            <div className="text-sm text-ink-2">
              <p>1. Scan the QR code with your authenticator app.</p>
              <p className="mt-2">Or enter this key manually:</p>
              <code className="mono mt-1 block break-all rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink">
                {setup.secret}
              </code>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Confirm password" htmlFor="s-pw">
              <Input id="s-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="6-digit code" htmlFor="s-code">
              <Input
                id="s-code"
                inputMode="numeric"
                className="mono tracking-[0.4em]"
                placeholder="000000"
                value={token}
                onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setMode("view"); setSetup(null); reset(); }}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Verify &amp; enable
            </Button>
          </div>
        </form>
      )}

      {/* DISABLE */}
      {mode === "disable" && (
        <form onSubmit={doDisable} className="space-y-4">
          <p className="text-sm text-ink-2">
            Confirm your password and a current code (or a recovery code) to turn
            off two-factor authentication.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Password" htmlFor="d-pw">
              <Input id="d-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="6-digit code" htmlFor="d-code">
              <Input id="d-code" inputMode="numeric" className="mono" placeholder="000000" value={token} onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            </Field>
            <Field label="or recovery code" htmlFor="d-rec">
              <Input id="d-rec" className="mono uppercase" placeholder="XXXX-XXXX" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setMode("view"); reset(); }}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={loading}>
              Disable 2FA
            </Button>
          </div>
        </form>
      )}

      {/* REGEN */}
      {mode === "regen" && (
        <form onSubmit={doRegen} className="space-y-4">
          <p className="text-sm text-ink-2">
            Regenerating invalidates all previous recovery codes. Confirm your password.
          </p>
          <Field label="Password" htmlFor="r-pw">
            <Input id="r-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setMode("view"); reset(); }}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Regenerate codes
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function RecoveryCodes({ codes, onDismiss }: { codes: string[]; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  function copy() {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }
  function download() {
    const blob = new Blob([`Xiero Nexus AI — recovery codes\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "xiero-nexus-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-md border border-signal/40 bg-signal/10 p-4">
      <p className="text-sm font-medium text-ink">Save your recovery codes</p>
      <p className="mt-1 text-xs text-ink-2">
        Each code works once. Store them somewhere safe — they’re shown only now.
      </p>
      <div className="mono mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-ink">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" onClick={download}>
          Download
        </Button>
        <Button onClick={onDismiss}>I’ve saved them</Button>
      </div>
    </div>
  );
}
