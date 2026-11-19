import "server-only";
import { PageProblem, type BrowserPage, type SignInForm } from "./page";
import { hostOfSite, mayFillPassword, verificationOf, type Verification } from "./rules";

/**
 * Signing in to a site with an account an owner saved. The app finds the
 * form and fills it in; the password goes from the app into the page and
 * nowhere else. Where the site asks for a person (a CAPTCHA on the form, a
 * code afterwards), this stops and says so: that part is a person's.
 */

export type SignInOutcome =
  /** The form was sent and is gone. */
  | { state: "signed_in" }
  /** No form is shown: with a saved session the site lets its visitor in as it is. */
  | { state: "no_form" }
  /** The site asks for a person. `filled`: the name and the password are in the form already. */
  | { state: "needs_person"; verification: Verification; filled: boolean }
  /** The form is still there after it was sent. */
  | { state: "refused" }
  /** The password is asked for on another site than the account's. */
  | { state: "other_site"; host: string }
  /** The page of the account could not be opened. */
  | { state: "error"; message: string };

export interface SignInAccount {
  siteUrl: string;
  username: string;
}

const ENTER = { key: "Enter", code: "Enter", keyCode: 13, text: "\r" } as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function send(page: BrowserPage, form: SignInForm): Promise<void> {
  if (form.go) {
    try {
      await page.click("go");
      return;
    } catch (err) {
      // The button cannot be clicked as it is (something in front of it): Enter sends a form too.
      if (!(err instanceof PageProblem) || err.kind === "closed") throw err;
    }
  }
  await page.key(ENTER);
  await page.afterAction();
}

/**
 * Sign in on the page: the account's address is opened, and the form it
 * shows is filled in and sent. A site that lets its visitor in as it is,
 * because the saved session still holds, shows no form.
 */
export async function signIn(page: BrowserPage, account: SignInAccount, password: string): Promise<SignInOutcome> {
  const opened = await page.goto(account.siteUrl);
  if (opened.error) return { state: "error", message: opened.error };

  let named = false;
  for (let step = 0; step < 3; step++) {
    const shot = await page.shot();
    const verification = verificationOf(shot.signals);
    const form: SignInForm = await page.signInForm();
    if (!form.pass && !form.user) {
      if (verification && (verification.blocks || verification.kind === "code")) return { state: "needs_person", verification, filled: false };
      return step === 0 ? { state: "no_form" } : { state: "signed_in" };
    }

    if (form.pass) {
      if (!mayFillPassword(form.url, account.siteUrl)) return { state: "other_site", host: hostOf(form.url) };
      if (form.user && !named) {
        await page.type("user", account.username);
        named = true;
      }
      await page.type("pass", password);
      // A CAPTCHA on the form: a person ticks it and sends the form.
      if (verification && verification.kind === "captcha") return { state: "needs_person", verification, filled: true };
      await send(page, form);

      const after = await page.shot();
      const next = verificationOf(after.signals);
      const still = await page.signInForm();
      if (still.pass) {
        if (next) return { state: "needs_person", verification: next, filled: false };
        return { state: "refused" };
      }
      if (next && (next.kind === "code" || next.blocks)) return { state: "needs_person", verification: next, filled: false };
      return { state: "signed_in" };
    }

    // The name on one page, the password on the next.
    if (!hostOfSite(hostOf(form.url), account.siteUrl)) return { state: "other_site", host: hostOf(form.url) };
    if (named) return { state: "refused" };
    await page.type("user", account.username);
    named = true;
    await send(page, form);
  }
  return { state: "refused" };
}
