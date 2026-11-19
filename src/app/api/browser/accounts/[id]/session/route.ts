import { handle, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireOwner } from "@/lib/auth";
import { forgetSession, getAccount, serializeAccount } from "@/lib/browser/accounts";
import { ONLY_OWNER, siteHost } from "@/lib/browser/rules";
import { BrowserProblem, browserConfigured } from "@/lib/browser/service";
import { liveLink, ownerSession } from "@/lib/browser/sessions";
import { AppError, Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Sign in to the site of an account by hand: the app opens the site in the
 * browser and fills in the form; the owner does what the site asks of a
 * person (a CAPTCHA, a code) on the page that is shown, and keeps the
 * session. The answer says where that page is shown.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const account = getAccount(params.id!);
  if (!account) throw Errors.notFound("Site account not found");
  if (!browserConfigured()) throw new AppError(400, "browser_not_set_up", "No browser service is set up on this server (BROWSER_URL).");
  const rate = rateLimit(`browser-session:${user.id}`, 20, 60_000);
  if (!rate.ok) throw Errors.rateLimited("Too many sign-ins were started. Try again in a minute.");
  try {
    const { id } = await ownerSession(account, user);
    audit({
      actorUserId: user.id,
      action: "site_account.sign_in",
      targetType: "site_account",
      targetId: account.id,
      metadata: { name: account.name, site: siteHost(account.siteUrl) },
      ip,
      userAgent,
    });
    return json({ id, link: liveLink(id) }, { status: 201 });
  } catch (err) {
    if (err instanceof BrowserProblem) throw new AppError(502, "browser_unreachable", err.message);
    throw err;
  }
});

/** Drop the session that is kept for an account: the next run signs in anew. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireOwner(ONLY_OWNER);
  const { ip, userAgent } = getClientMeta(req);
  const account = getAccount(params.id!);
  if (!account) throw Errors.notFound("Site account not found");
  forgetSession(account.id);
  audit({
    actorUserId: user.id,
    action: "site_account.forget_session",
    targetType: "site_account",
    targetId: account.id,
    metadata: { name: account.name, site: siteHost(account.siteUrl) },
    ip,
    userAgent,
  });
  return json({ account: serializeAccount(getAccount(account.id) ?? account) });
});
