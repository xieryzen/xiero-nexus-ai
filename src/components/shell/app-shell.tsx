"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark, DesignedByXiero } from "@/components/brand";
import { Icon, type IconName } from "@/components/icons";
import { apiFetch } from "@/lib/client";
import { APP_VERSION, BUILD_SHA, releaseChannel } from "@/lib/version";
import { Alert, cn } from "@/components/ui";
import { NotificationBell } from "./notification-bell";
import { isAdminRole, roleLabel, type Role } from "@/lib/roles";
import { formatTokens, shortTokens } from "@/lib/token-rules";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** For those who are shown how the installation is set up (roles.ts). */
  adminOnly?: boolean;
  /** For everyone else: the same page under the name it has for them. */
  userOnly?: boolean;
}

const groups: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: "overview" },
      { href: "/dashboard/projects", label: "AI Manager", icon: "manager" },
      { href: "/dashboard/agents", label: "Agents", icon: "agents" },
      { href: "/dashboard/workflows", label: "Workflows", icon: "workflow" },
      { href: "/dashboard/skills", label: "Skills", icon: "skill", adminOnly: true },
      { href: "/dashboard/chat", label: "Chat", icon: "chat" },
      { href: "/dashboard/studio", label: "Creative Studio", icon: "studio" },
      { href: "/dashboard/knowledge", label: "Knowledge", icon: "knowledge" },
    ],
  },
  {
    heading: "Infrastructure",
    items: [
      { href: "/dashboard/providers", label: "Providers", icon: "providers", adminOnly: true },
      { href: "/dashboard/models", label: "Models", icon: "models", adminOnly: true },
      { href: "/dashboard/servers", label: "Servers", icon: "server", adminOnly: true },
      { href: "/dashboard/browser", label: "Browser", icon: "browser", adminOnly: true },
      { href: "/dashboard/usage", label: "Usage & Costs", icon: "usage", adminOnly: true },
    ],
  },
  {
    heading: "Governance",
    items: [
      { href: "/dashboard/observability", label: "Observability", icon: "usage", adminOnly: true },
      { href: "/dashboard/audit", label: "Audit Log", icon: "audit", adminOnly: true },
      { href: "/dashboard/users", label: "Users & Roles", icon: "users", adminOnly: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { href: "/dashboard/usage", label: "Usage", icon: "usage", userOnly: true },
      { href: "/dashboard/settings", label: "Settings", icon: "settings" },
    ],
  },
];

export interface ShellUser {
  username: string;
  email: string;
  role: Role;
  /** What is left of the account's tokens. Null: it is not limited. */
  tokensLeft: number | null;
}

export function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // What is left of the account's tokens: as the server said when the page
  // was loaded, and asked again on every page, since work uses them up.
  const [tokensLeft, setTokensLeft] = useState(user.tokensLeft);
  useEffect(() => setTokensLeft(user.tokensLeft), [user.tokensLeft]);
  useEffect(() => {
    let alive = true;
    apiFetch<{ user: { tokensLeft: number | null } }>("/api/account/me")
      .then((res) => {
        if (alive) setTokensLeft(res.user.tokensLeft);
      })
      .catch(() => {
        /* the number of the page load stays */
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  async function logout() {
    setLoggingOut(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
      {groups.map((group) => {
        const sees = isAdminRole(user.role);
        const items = group.items.filter((i) => (sees ? !i.userOnly : !i.adminOnly));
        if (items.length === 0) return null;
        return (
          <div key={group.heading}>
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              {group.heading}
            </p>
            <ul className="space-y-0.5">
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition",
                      isActive(item.href)
                        ? "bg-surface-2 font-medium text-ink"
                        : "text-ink-2 hover:bg-surface-2/60 hover:text-ink",
                    )}
                  >
                    <span className={isActive(item.href) ? "text-signal" : "text-ink-3"}>
                      <Icon name={item.icon} />
                    </span>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  const sidebarInner = (
    <>
      <div className="flex h-14 items-center border-b border-line px-5">
        <Wordmark />
      </div>
      {nav}
      <div className="border-t border-line px-5 py-4">
        <DesignedByXiero />
        <p className="mono mt-1 text-[10px] text-ink-3" title="Version and build">
          v{APP_VERSION}
          {releaseChannel() !== "stable" && <span className="text-warn"> · {releaseChannel()}</span>}
          {BUILD_SHA && <span> · {BUILD_SHA}</span>}
        </p>
      </div>
    </>
  );

  return (
    <div className="min-h-screen lg:pl-60">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface lg:flex">
        {sidebarInner}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-line bg-surface animate-fade-in">
            {sidebarInner}
          </aside>
        </div>
      )}

      {/* Topbar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur sm:px-6">
        <button
          type="button"
          className="btn-ghost -ml-1 p-2 lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
        >
          <Icon name="menu" />
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <NotificationBell />
          <div className="text-right leading-tight">
            <p className="text-sm font-medium text-ink">{user.username}</p>
            <p className="text-xs text-ink-3">
              {roleLabel(user.role)}
              {tokensLeft !== null && (
                <>
                  {" · "}
                  <Link
                    href="/dashboard/settings"
                    id="tokens-left"
                    title={`${formatTokens(tokensLeft)} tokens left`}
                    className={tokensLeft === 0 ? "text-danger hover:underline" : "hover:text-ink hover:underline"}
                  >
                    {tokensLeft === 0 ? "no tokens left" : `${shortTokens(tokensLeft)} tokens left`}
                  </Link>
                </>
              )}
            </p>
          </div>
          <div
            className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface-2 text-sm font-semibold text-signal"
            aria-hidden="true"
          >
            {user.username.slice(0, 1).toUpperCase()}
          </div>
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="btn-ghost p-2"
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-content px-4 py-7 sm:px-6">
        {tokensLeft === 0 && (
          <div className="mb-6" id="tokens-used-up">
            <Alert tone="danger">
              Your token balance is used up. New work is refused until an owner of this installation raises your
              limit. What you made is still here.
            </Alert>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
