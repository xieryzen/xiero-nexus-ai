import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { maxPages, waitMinutes } from "@/lib/browser/rules";
import { browserStatus } from "@/lib/browser/service";
import { browserUse, liveFor } from "@/lib/browser/sessions";

export const dynamic = "force-dynamic";

/**
 * How the browser service is, what is open in it, and the pages that wait
 * for this person. `?fresh=1` asks the service anew.
 */
export const GET = handle(async (req) => {
  const user = requireAdmin(); // how the installation is set up is shown to administrators and owners
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  return json({
    status: await browserStatus(fresh),
    use: browserUse(),
    waiting: liveFor(user),
    waitMinutes: waitMinutes(process.env.BROWSER_WAIT_MINUTES),
    maxPages: maxPages(process.env.BROWSER_MAX_PAGES),
    canManage: user.role === "owner",
  });
});
