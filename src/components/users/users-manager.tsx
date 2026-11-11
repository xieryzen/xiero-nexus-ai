"use client";

import { useState } from "react";
import type { PublicUser } from "@/lib/auth";
import { apiFetch, ApiError } from "@/lib/client";
import { formatDateTime } from "@/lib/format";
import { Alert, Badge, Button, Card, Select, StatusDot } from "@/components/ui";

export function UsersManager({
  initialUsers,
  currentUserId,
}: {
  initialUsers: PublicUser[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function update(u: PublicUser, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) {
    setBusy((b) => ({ ...b, [u.id]: true }));
    setError(null);
    try {
      const res = await apiFetch<{ user: PublicUser }>(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setUsers((list) => list.map((x) => (x.id === u.id ? res.user : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusy((b) => ({ ...b, [u.id]: false }));
    }
  }

  return (
    <Card className="overflow-hidden">
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="-m-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
              <th className="px-5 py-2.5 font-medium">User</th>
              <th className="px-5 py-2.5 font-medium">2FA</th>
              <th className="px-5 py-2.5 font-medium">Role</th>
              <th className="px-5 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              return (
                <tr key={u.id}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-ink">
                      {u.username}
                      {isSelf && <span className="ml-2 text-xs text-ink-3">(you)</span>}
                    </div>
                    <div className="text-xs text-ink-3">{u.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={u.twoFactorEnabled ? "ok" : "neutral"}>
                      {u.twoFactorEnabled ? "on" : "off"}
                    </Badge>
                  </td>
                  <td className="px-5 py-3">
                    {isSelf ? (
                      <span className="capitalize text-ink-2">{u.role}</span>
                    ) : (
                      <Select
                        className="w-28"
                        value={u.role}
                        disabled={busy[u.id]}
                        onChange={(e) => update(u, { role: e.target.value as "admin" | "user" })}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </Select>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {isSelf ? (
                      <span className="inline-flex items-center gap-2 text-ink-2">
                        <StatusDot tone="ok" /> active
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        loading={busy[u.id]}
                        onClick={() =>
                          update(u, { status: u.status === "active" ? "disabled" : "active" })
                        }
                      >
                        <StatusDot tone={u.status === "active" ? "ok" : "danger"} />
                        {u.status}
                      </Button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-ink-3">{formatDateTime(u.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
