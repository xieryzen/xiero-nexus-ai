"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input } from "@/components/ui";

export function RegisterForm({ blocked = false }: { blocked?: boolean }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, email, password }),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create account");
      setLoading(false);
    }
  }

  return (
    <div className="card p-6">
      <h1 className="text-base font-semibold text-ink">Create account</h1>
      <p className="mt-1 text-sm text-ink-2">
        The first account on a new instance becomes the administrator.
      </p>
      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Username" htmlFor="username" hint="3–32 chars: letters, numbers, . _ -">
          <Input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" loading={loading} disabled={blocked} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-2">
        Already registered?{" "}
        <Link href="/login" className="font-medium text-signal hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
