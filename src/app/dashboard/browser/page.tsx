import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { accountsFor, listActions, serializeAccount } from "@/lib/browser/accounts";
import { maxPages, waitMinutes } from "@/lib/browser/rules";
import { browserStatus } from "@/lib/browser/service";
import { browserUse, liveFor } from "@/lib/browser/sessions";
import { seesSetup } from "@/lib/roles";
import { BrowserManager } from "@/components/browser/browser-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Browser" };

export default async function BrowserPage() {
  const user = getCurrentUser();
  // How the installation is set up is shown to administrators and owners (roles.ts: seesSetup).
  if (!user || !seesSetup(user.role)) redirect("/dashboard");
  const owner = user.role === "owner";
  return (
    <BrowserManager
      initialStatus={await browserStatus()}
      initialUse={browserUse()}
      initialWaiting={liveFor(user)}
      initialAccounts={accountsFor(user).map(serializeAccount)}
      // An owner reads all of the log; an administrator, what was done for their own projects.
      initialLog={listActions({ ...(owner ? {} : { userId: user.id }), limit: 30 })}
      canManage={owner}
      waitMinutes={waitMinutes(process.env.BROWSER_WAIT_MINUTES)}
      maxPages={maxPages(process.env.BROWSER_MAX_PAGES)}
    />
  );
}
