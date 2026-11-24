"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DesignedByXiero } from "@/components/brand";
import { Icon, type IconName } from "@/components/icons";
import { ThemeChoice, useTheme } from "@/components/theme";
import { apiFetch } from "@/lib/client";
import { adminPageOf, adminPagesFor } from "@/lib/admin-nav";
import { APP_VERSION, BUILD_SHA, releaseChannel } from "@/lib/version";
import { Alert, cn } from "@/components/ui";
import { NotificationBell } from "./notification-bell";
import { isAdminRole, isOwnerRole, tierLine, type Role, type Tier } from "@/lib/roles";
import { formatTokens, renewalDay, shortTokens } from "@/lib/token-rules";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** What everyone is shown, whatever their role. */
const NAV: NavItem[] = [
  { href: "/dashboard/chats", label: "Chats", icon: "chat" },
  { href: "/dashboard/projects", label: "Projects", icon: "manager" },
  { href: "/dashboard/studio", label: "Creative Studio", icon: "studio" },
  { href: "/dashboard/knowledge", label: "Knowledge", icon: "knowledge" },
  { href: "/dashboard/memory", label: "Memory", icon: "memory" },
  { href: "/dashboard/agents", label: "Agents", icon: "agents" },
  { href: "/dashboard/workflows", label: "Workflows", icon: "workflow" },
];

const NEW_CHAT = "/dashboard/chat";
const CHATS = "/dashboard/chats";

/**
 * What the bar at the top calls a page on a phone, where the page's own
 * heading is not shown. The pages of the account and of the admin area are
 * set in the serif, as a settings page is; the pages one works on in the sans.
 */
const ACCOUNT_PAGES: { href: string; title: string }[] = [
  { href: "/dashboard/settings/security", title: "Security" },
  { href: "/dashboard/settings", title: "Settings" },
  { href: "/dashboard/usage", title: "Usage" },
  { href: "/dashboard/plans", title: "Plans" },
  { href: "/dashboard/teams", title: "Teams" },
];

function titleOf(pathname: string, admin: boolean): { title: string; serif: boolean } | null {
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const work = NAV.find((item) => under(item.href));
  if (work) return { title: work.label, serif: false };
  const adminPage = admin ? adminPageOf(pathname) : undefined;
  if (adminPage) return { title: adminPage.area === "overview" ? "Admin console" : adminPage.label, serif: true };
  const own = ACCOUNT_PAGES.find((page) => under(page.href));
  if (own) return { title: own.title, serif: own.href !== "/dashboard/teams" };
  // Any other page: its place in the address, as a word.
  const part = pathname.split("/")[2];
  return part ? { title: part.slice(0, 1).toUpperCase() + part.slice(1).replace(/-/g, " "), serif: false } : null;
}
/** How many conversations the sidebar lists: the rest are on the Chats page. */
const RECENTS = 30;

export interface ShellTokens {
  /** What the account may use in a month. Null: it is not limited. */
  limit: number | null;
  /** What it used this month, as it is counted. */
  used: number;
  /** Null: it is not limited. */
  left: number | null;
  /** When the count starts again, in milliseconds. */
  renewsAt: number;
}

export interface ShellUser {
  username: string;
  email: string;
  /** owner, admin or user. */
  role: Role;
  /** The role as the pages say it: free, pro, plus, ultra, admin or owner. */
  tier: Tier;
  tokens: ShellTokens;
}

interface Recent {
  id: string;
  title: string;
  /** Pinned by the account: listed first, under a heading of its own. */
  pinned: boolean;
}

/** Whether a page lays itself out over the whole height: a conversation does. */
function isConversation(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === NEW_CHAT || pathname.startsWith(`${NEW_CHAT}/`);
}

export function AppShell({
  user,
  collapsed: collapsedAtLoad = false,
  children,
}: {
  user: ShellUser;
  /** Whether the sidebar was folded away when the page was loaded (a cookie says so). */
  collapsed?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  useTheme(); // follows the device while the theme is "as the device"
  const [collapsed, setCollapsed] = useState(collapsedAtLoad);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [recents, setRecents] = useState<Recent[] | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  // The row of the admin area's pages: the one that is open is brought into view, on a phone it may be far to the right.
  const adminTabs = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = adminTabs.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (row && current) row.scrollLeft = Math.max(0, current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2);
  }, [pathname]);
  const openChat = isConversation(pathname) ? params.get("c") : null;

  // What is left of the account's tokens: as the server said when the page
  // was loaded, and asked again on every page, since work uses them up.
  const [tokens, setTokens] = useState(user.tokens);
  useEffect(() => setTokens(user.tokens), [user.tokens]);
  const loadTokens = useCallback(() => {
    apiFetch<{ user: { tokenLimit: number | null; tokensUsed: number; tokensLeft: number | null; tokensRenewAt: string } }>("/api/account/me")
      .then((res) => {
        setTokens({ limit: res.user.tokenLimit, used: res.user.tokensUsed, left: res.user.tokensLeft, renewsAt: new Date(res.user.tokensRenewAt).getTime() });
      })
      .catch(() => {
        /* the numbers of the page load stay */
      });
  }, []);
  useEffect(() => {
    loadTokens();
  }, [pathname, loadTokens]);

  // The conversations, the ones written in last first. Asked again when a
  // page says that one was started, renamed or deleted.
  const loadRecents = useCallback(() => {
    apiFetch<{ chats: Recent[] }>("/api/chats")
      .then((res) => setRecents(res.chats.map((c) => ({ id: c.id, title: c.title, pinned: c.pinned === true }))))
      .catch(() => {
        /* the list as it was stays */
      });
  }, []);
  useEffect(() => {
    loadRecents();
    // An answer was given, or a conversation renamed or deleted: the list, and what the answer used.
    const onChats = () => {
      loadRecents();
      loadTokens();
    };
    window.addEventListener("nexus:chats", onChats);
    return () => window.removeEventListener("nexus:chats", onChats);
  }, [loadRecents, loadTokens]);

  // The drawer and the menu close when the page changes, and on Escape.
  useEffect(() => {
    setDrawer(false);
    setMenu(false);
  }, [pathname, openChat]);
  useEffect(() => {
    if (!drawer && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawer(false);
      setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, menu]);
  // A page under an open drawer does not scroll.
  useEffect(() => {
    if (!drawer) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [drawer]);

  function fold(next: boolean) {
    setCollapsed(next);
    setMenu(false);
    // Kept for a year, so that the next page is rendered as this one was left.
    document.cookie = `nexus-sidebar=${next ? "closed" : "open"}; path=/; max-age=31536000; samesite=lax`;
  }

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

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const admin = isAdminRole(user.role);
  const adminPages = admin ? adminPagesFor(user.role) : [];
  const adminPage = admin ? adminPageOf(pathname) : undefined;
  const inAdmin = Boolean(adminPage && adminPages.some((p) => p.area === adminPage.area));
  const initial = user.username.slice(0, 1).toUpperCase();
  const usedUp = tokens.left === 0;
  const bare = isConversation(pathname);
  const pageTitle = bare ? null : titleOf(pathname, admin);
  const pinned = (recents ?? []).filter((chat) => chat.pinned);
  const others = (recents ?? []).filter((chat) => !chat.pinned);

  const tokensLine =
    tokens.limit === null
      ? "No limit on tokens"
      : usedUp
        ? `No tokens left · again on ${renewalDay(tokens.renewsAt)}`
        : `${shortTokens(tokens.left ?? 0)} of ${shortTokens(tokens.limit)} tokens left`;

  /** The menu behind the profile: the account's own pages, the admin area for those who have it, the theme, signing out. */
  const accountMenu = (
    <nav aria-label="Account" data-testid="account-menu" className="popover absolute bottom-full left-0 z-50 mb-2 w-[min(18rem,calc(100vw-1.5rem))] animate-fade-in p-1.5">
      <div className="px-3 pb-2.5 pt-2">
        <p className="truncate text-[13px] text-ink-3" title={user.email}>
          {user.email}
        </p>
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className={cn("truncate", usedUp ? "text-danger" : "text-ink-2")} title={tokens.left === null ? undefined : `${formatTokens(tokens.left)} tokens left this month`}>
              {tokensLine}
            </span>
            {tokens.limit !== null && !usedUp && <span className="shrink-0 text-ink-3">again {renewalDay(tokens.renewsAt)}</span>}
          </div>
          {tokens.limit !== null && tokens.limit > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent-soft" aria-hidden="true">
              <div className={cn("h-full rounded-full", usedUp ? "bg-danger" : "bg-accent")} style={{ width: `${Math.min(100, Math.max(0, (tokens.used / tokens.limit) * 100))}%` }} />
            </div>
          )}
        </div>
      </div>
      <div className="my-1 border-t border-line" />
      <Link href="/dashboard/settings" className="nav-row" aria-current={isActive("/dashboard/settings") ? "page" : undefined}>
        <Icon name="settings" size={18} /> Settings
      </Link>
      {!admin && (
        <Link href="/dashboard/usage" className="nav-row" aria-current={isActive("/dashboard/usage") ? "page" : undefined}>
          <Icon name="usage" size={18} /> Usage
        </Link>
      )}
      <Link href="/dashboard/plans" className="nav-row" aria-current={!admin && isActive("/dashboard/plans") ? "page" : undefined}>
        <Icon name="plan" size={18} /> {admin || user.tier === "ultra" ? "Plans" : "Upgrade plan"}
      </Link>
      {admin && (
        <>
          <div className="my-1 border-t border-line" />
          <Link href="/dashboard/admin" className="nav-row" data-testid="admin-entry" aria-current={inAdmin ? "page" : undefined}>
            <Icon name="admin" size={18} />
            <span className="flex-1">Admin console</span>
            {!isOwnerRole(user.role) && <span className="rounded-full bg-ink/[0.08] px-2 py-px text-[11px] font-medium text-ink-2">limited</span>}
          </Link>
        </>
      )}
      <div className="my-1 border-t border-line" />
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-sm text-ink">Theme</span>
        <ThemeChoice compact />
      </div>
      <button type="button" className="nav-row text-danger" onClick={logout} disabled={loggingOut}>
        <Icon name="logout" size={18} /> Log out
      </button>
    </nav>
  );

  /** The account, at the foot of the sidebar: who is signed in and with which role. It opens the menu. */
  const profile = (rail: boolean) => (
    <div className="relative min-w-0 flex-1">
      {menu && accountMenu}
      <button
        type="button"
        onClick={() => setMenu((open) => !open)}
        aria-haspopup="true"
        aria-expanded={menu}
        aria-label={`${user.username}, ${tierLine(user.tier)}: account menu`}
        data-testid="profile"
        className={cn("flex w-full items-center gap-2.5 rounded-full text-left transition hover:bg-ink/[0.07]", rail ? "justify-center p-1" : "py-1 pl-1 pr-2")}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-signal text-[15px] font-semibold text-white" aria-hidden="true">
          {initial}
        </span>
        {!rail && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-ink">{user.username}</span>
            <span className="block truncate text-xs text-ink-3" data-testid="profile-role">
              {tierLine(user.tier)}
            </span>
          </span>
        )}
      </button>
    </div>
  );

  const chatRow = (chat: Recent, inDrawer: boolean) => (
    <li key={chat.id}>
      <Link
        href={`${NEW_CHAT}?c=${chat.id}`}
        className={cn("nav-row", inDrawer ? "min-h-[2.75rem] gap-3.5 text-[16px]" : "py-1.5")}
        aria-current={openChat === chat.id ? "true" : undefined}
        title={chat.title}
      >
        <Icon name="bubble" size={inDrawer ? 19 : 16} className="shrink-0 text-ink-2" />
        <span className="truncate">{chat.title}</span>
      </Link>
    </li>
  );

  /** The sidebar, as it is on a wide screen and in the drawer of a phone. `rail`: folded to its icons. */
  const sidebar = (rail: boolean, inDrawer: boolean) => (
    <>
      <div className={cn("flex shrink-0 items-center", inDrawer ? "h-[4.5rem] justify-between pl-5 pr-3" : rail ? "h-14 justify-center" : "h-14 justify-between pl-4 pr-2")}>
        {!rail && (
          <Link href="/dashboard" className={cn("serif font-medium tracking-tight text-ink", inDrawer ? "text-[27px]" : "text-[21px]")} aria-label="Xiero Nexus AI: home">
            Xiero Nexus
          </Link>
        )}
        <div className="flex items-center">
          {!rail && (
            <Link href={CHATS} className="icon-btn text-ink" aria-label="Search your chats" title="Search your chats">
              <Icon name="search" size={inDrawer ? 23 : 18} />
            </Link>
          )}
          {!inDrawer && (
            <button type="button" className="icon-btn" onClick={() => fold(!rail)} aria-label={rail ? "Open the sidebar" : "Close the sidebar"} title={rail ? "Open the sidebar" : "Close the sidebar"}>
              <Icon name="sidebar" size={18} />
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Main" className={cn("flex min-h-0 flex-1 flex-col", rail ? "items-center px-2" : inDrawer ? "px-3" : "px-2.5")}>
        <ul className={cn("shrink-0 space-y-0.5", rail && "w-full")}>
          {!inDrawer && (
            <li>
              <Link
                href={NEW_CHAT}
                onClick={() => window.dispatchEvent(new Event("nexus:new-chat"))}
                className={cn("nav-row group", rail && "justify-center px-0")}
                title={rail ? "New chat" : undefined}
                data-testid="new-chat"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-primary-ink transition group-hover:scale-105">
                  <Icon name="plus" size={15} strokeWidth={2.2} />
                </span>
                {rail ? <span className="sr-only">New chat</span> : <span className="font-medium">New chat</span>}
              </Link>
            </li>
          )}
          {NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn("nav-row", rail && "justify-center px-0", inDrawer && "min-h-[3.25rem] gap-4 rounded-full px-4 text-[17px]")}
                aria-current={isActive(item.href) ? "page" : undefined}
                title={rail ? item.label : undefined}
              >
                <Icon name={item.icon} size={inDrawer ? 23 : 18} className="shrink-0" />
                {rail ? <span className="sr-only">{item.label}</span> : item.label}
              </Link>
            </li>
          ))}
        </ul>

        {!rail && (
          <div className={cn("flex min-h-0 flex-1 flex-col border-t border-line", inDrawer ? "mt-3 pt-3" : "mt-2.5 pt-2.5")}>
            <div className={cn("min-h-0 flex-1 overflow-y-auto", inDrawer ? "pb-24" : "pb-2")}>
              {pinned.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setPinnedOpen((open) => !open)}
                    aria-expanded={pinnedOpen}
                    className={cn("flex w-full items-center justify-between rounded-lg px-3 text-left font-medium text-ink-2 hover:text-ink", inDrawer ? "py-2 text-[15px]" : "py-1 text-xs")}
                  >
                    Pinned
                    <Icon name="chevron" size={inDrawer ? 18 : 14} className={cn("transition-transform", pinnedOpen && "rotate-180")} />
                  </button>
                  {pinnedOpen && (
                    <ul className="space-y-px pb-2" aria-label="Pinned conversations">
                      {pinned.map((chat) => chatRow(chat, inDrawer))}
                    </ul>
                  )}
                </>
              )}
              <p className={cn("px-3 font-medium text-ink-2", inDrawer ? "py-2 text-[15px]" : "py-1 text-xs")}>Recents</p>
              <ul className="space-y-px" aria-label="Conversations">
                {recents !== null && recents.length === 0 && <li className="px-3 py-1.5 text-sm text-ink-3">No conversation yet.</li>}
                {others.slice(0, RECENTS).map((chat) => chatRow(chat, inDrawer))}
                {others.length > RECENTS && (
                  <li>
                    <Link href={CHATS} className="nav-row py-1.5 text-ink-3">
                      All chats
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
        {rail && <div className="flex-1" />}
      </nav>

      {inDrawer ? (
        // On a phone: the account to the left, and the button that starts a conversation under the thumb.
        <div className="pb-safe pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-sidebar from-60% to-transparent px-3 pt-8">
          <div className="pointer-events-auto flex items-center gap-2">
            {profile(false)}
            <Link
              href={NEW_CHAT}
              onClick={() => {
                window.dispatchEvent(new Event("nexus:new-chat"));
                setDrawer(false);
              }}
              className="btn-primary h-12 shrink-0 px-5 text-[15px] shadow-pop"
              data-testid="new-chat"
            >
              <Icon name="plus" size={18} strokeWidth={2} /> New chat
            </Link>
          </div>
          <div className="pointer-events-auto mt-2 flex items-center justify-between gap-2 px-1">
            <DesignedByXiero className="text-[11px]" />
            <p className="mono truncate text-[10px] text-ink-3" title="Version and build">
              v{APP_VERSION}
            </p>
          </div>
        </div>
      ) : (
        <div className={cn("shrink-0 border-t border-line", rail ? "px-2 py-2" : "px-2.5 py-2")}>
          <div className="flex">{profile(rail)}</div>
          {!rail && (
            <div className="mt-1.5 flex items-center justify-between gap-2 px-2">
              <DesignedByXiero className="text-[11px]" />
              <p className="mono truncate text-[10px] text-ink-3" title="Version and build">
                v{APP_VERSION}
                {releaseChannel() !== "stable" && <span className="text-warn"> · {releaseChannel()}</span>}
                {BUILD_SHA && <span> · {BUILD_SHA}</span>}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className={cn("min-h-screen-d", collapsed ? "lg:pl-14" : "lg:pl-[17.5rem]")}>
      {/* The sidebar of a wide screen */}
      <aside
        className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-sidebar lg:flex", collapsed ? "w-14" : "w-[17.5rem]")}
        data-testid="sidebar"
        data-collapsed={collapsed ? "true" : "false"}
      >
        {sidebar(collapsed, false)}
      </aside>

      {/* The drawer of a phone */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade bg-black/55" onClick={() => setDrawer(false)} aria-hidden="true" />
          <aside className="pt-safe absolute inset-y-0 left-0 flex w-[min(22rem,86vw)] animate-drawer-in flex-col bg-sidebar shadow-pop" data-testid="drawer">
            {sidebar(false, true)}
          </aside>
        </div>
      )}
      {/* A click beside the account menu closes it. */}
      {menu && <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} aria-hidden="true" />}

      <header className="pt-safe sticky top-0 z-20 bg-canvas/90 backdrop-blur">
        <div className="flex h-14 items-center gap-0.5 px-2 sm:px-4">
          <button type="button" className="icon-btn text-ink lg:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation">
            <Icon name="menu" size={24} />
          </button>
          {/* The name of the page, on a phone; a conversation puts its own name and menu here (ShellTitle). */}
          <div className="flex min-w-0 flex-1 items-center justify-center px-1 lg:justify-start">
            {pageTitle && (
              <p className={cn("truncate text-ink lg:hidden", pageTitle.serif ? "serif text-[21px] font-medium" : "text-[18px] font-semibold")} aria-hidden="true" data-testid="page-title">
                {pageTitle.title}
              </p>
            )}
            <div id="shell-title" className="flex min-w-0 max-w-full items-center" />
          </div>
          {tokens.left !== null && (
            <Link
              href="/dashboard/usage"
              id="tokens-left"
              title={`${formatTokens(tokens.left)} tokens left this month`}
              className={cn(
                "mr-1 hidden whitespace-nowrap rounded-full px-3 py-1 text-xs transition sm:block",
                usedUp ? "bg-danger/10 text-danger hover:bg-danger/20" : "bg-ink/[0.06] text-ink-2 hover:bg-ink/[0.1] hover:text-ink",
              )}
            >
              {usedUp ? "no tokens left" : `${shortTokens(tokens.left)} tokens left`}
            </Link>
          )}
          <Link href={NEW_CHAT} onClick={() => window.dispatchEvent(new Event("nexus:new-chat"))} className="icon-btn text-ink lg:hidden" aria-label="New chat">
            <Icon name="edit" size={22} />
          </Link>
          {/* Last, so that its list opens within the screen of a phone. */}
          <NotificationBell />
        </div>
      </header>

      <main className={bare ? "flex min-w-0 flex-col" : "mx-auto w-full max-w-content px-4 pb-24 pt-2 sm:px-6 sm:pt-4 lg:pb-10"}>
        {usedUp && (
          <div className={bare ? "mx-auto w-full max-w-3xl px-4 pb-2" : "mb-6"} id="tokens-used-up">
            <Alert tone="danger">
              Your tokens for this month are used up. New work is refused until {renewalDay(tokens.renewsAt)}, when they are there again, or until an
              owner of this installation gives you more. What you made is still here.
            </Alert>
          </div>
        )}
        {inAdmin && !bare && (
          <nav ref={adminTabs} aria-label="Admin console" className="no-scrollbar relative -mx-4 mb-5 overflow-x-auto px-4 sm:-mx-6 sm:px-6" data-testid="admin-tabs">
            <ul className="flex w-max items-center gap-1.5">
              {adminPages.map((page) => {
                const current = page.area === adminPage?.area;
                return (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex items-center whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition",
                        current ? "bg-primary font-medium text-primary-ink" : "bg-ink/[0.06] text-ink-2 hover:bg-ink/[0.1] hover:text-ink",
                      )}
                    >
                      {page.label}
                      {page.access === "view" && <span className="sr-only"> (to look at)</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        {children}
      </main>
    </div>
  );
}
