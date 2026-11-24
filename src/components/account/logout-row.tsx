"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { apiFetch } from "@/lib/client";

/** The last row of the Settings page: sign out of this browser. */
export function LogoutRow() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* signed out or not: the sign-in page says which */
    }
    router.push("/login");
    router.refresh();
  }
  return (
    <div className="list-group">
      <button type="button" className="list-row text-danger" onClick={logout} disabled={busy} data-testid="logout-row">
        <Icon name="logout" size={20} className="shrink-0" />
        <span className="flex-1">Log out</span>
      </button>
    </div>
  );
}
