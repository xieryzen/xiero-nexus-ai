"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input } from "@/components/ui";

export function LoginForm({ blocked = false }: { blocked?: boolean }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ twoFactorRequired?: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });
      if (res.twoFactorRequired) {
        router.push("/login/2fa");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in");
      setLoading(false);
    }
  }

  return (
    <div className="card p-6">
      <h1 className="text-base font-semibold text-ink">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">Access your Nexus control plane.</p>
      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Username or email" htmlFor="identifier">
          <Input
            id="identifier"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" loading={loading} disabled={blocked} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-2">
        No account?{" "}
        <Link href="/register" className="font-medium text-signal hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
