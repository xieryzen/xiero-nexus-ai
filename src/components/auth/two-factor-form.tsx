"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input, cn } from "@/components/ui";

export function TwoFactorForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const [token, setToken] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/2fa", {
        method: "POST",
        body: JSON.stringify(
          mode === "totp" ? { token } : { recoveryCode },
        ),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
      setLoading(false);
    }
  }

  return (
    <div className="card p-6">
      <h1 className="text-base font-semibold text-ink">Two-factor verification</h1>
      <p className="mt-1 text-sm text-ink-2">
        {mode === "totp"
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of your single-use recovery codes."}
      </p>

      <div className="mt-4 flex gap-1 rounded-md border border-line bg-surface-2 p-1 text-sm">
        {(["totp", "recovery"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cn(
              "flex-1 rounded px-3 py-1.5 font-medium transition",
              mode === m ? "bg-signal text-signal-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {m === "totp" ? "Authenticator" : "Recovery code"}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {mode === "totp" ? (
          <Field label="Authenticator code" htmlFor="token">
            <Input
              id="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="mono tracking-[0.4em]"
              value={token}
              onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
            />
          </Field>
        ) : (
          <Field label="Recovery code" htmlFor="recovery">
            <Input
              id="recovery"
              placeholder="XXXX-XXXX"
              className="mono uppercase tracking-widest"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              required
              autoFocus
            />
          </Field>
        )}
        <Button type="submit" loading={loading} className="w-full">
          Verify
        </Button>
      </form>
    </div>
  );
}
