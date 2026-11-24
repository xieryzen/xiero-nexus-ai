/**
 * The pages of the admin area, in the order its menu shows them. Pure: used
 * by the shell and by the admin console. Who is shown which, and whether to
 * manage it or only to look at it, is in roles.ts (adminAccess).
 */
import { adminAccess, type AdminArea } from "./roles";

export interface AdminPage {
  area: AdminArea;
  href: string;
  label: string;
  /** One line under the label, on the console. */
  text: string;
  icon: "overview" | "users" | "plan" | "providers" | "models" | "skill" | "server" | "browser" | "usage" | "audit" | "test";
}

export const ADMIN_PAGES: AdminPage[] = [
  { area: "overview", href: "/dashboard/admin", label: "Overview", text: "The installation at a glance", icon: "overview" },
  { area: "users", href: "/dashboard/users", label: "Users & roles", text: "The accounts, their roles and their tokens", icon: "users" },
  { area: "plans", href: "/dashboard/plans", label: "Plans", text: "What each role has: tokens a month, and features", icon: "plan" },
  { area: "providers", href: "/dashboard/providers", label: "Providers", text: "Where the models come from, and their keys", icon: "providers" },
  { area: "models", href: "/dashboard/models", label: "Models", text: "Which models there are, and which role may choose them", icon: "models" },
  { area: "skills", href: "/dashboard/skills", label: "Skills", text: "What agents can be taught", icon: "skill" },
  { area: "servers", href: "/dashboard/servers", label: "Servers", text: "Machines the agents may work on", icon: "server" },
  { area: "browser", href: "/dashboard/browser", label: "Browser", text: "The browser agents work in, and its site accounts", icon: "browser" },
  { area: "usage", href: "/dashboard/usage", label: "Usage & costs", text: "What everyone used, and what it cost", icon: "usage" },
  { area: "observability", href: "/dashboard/observability", label: "Observability", text: "The server, its worker and its services", icon: "test" },
  { area: "audit", href: "/dashboard/audit", label: "Audit log", text: "Who changed what, and when", icon: "audit" },
];

/** The pages of the admin area a role is shown. */
export function adminPagesFor(role: string | null | undefined): (AdminPage & { access: "manage" | "view" })[] {
  return ADMIN_PAGES.flatMap((page) => {
    const access = adminAccess(role, page.area);
    return access ? [{ ...page, access }] : [];
  });
}

/** The page of the admin area an address belongs to. */
export function adminPageOf(pathname: string): AdminPage | undefined {
  return ADMIN_PAGES.find((page) => pathname === page.href || pathname.startsWith(`${page.href}/`));
}
