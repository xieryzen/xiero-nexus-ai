import "server-only";
import type { SiteAccount } from "@/db/schema";
import { ToolError, type LoopTool } from "../agent/loop";
import { AppError } from "../errors";
import { agentHostAllowed, assertWebAddress } from "../web-fetch";
import { actionsOfTask, logAction } from "./accounts";
import { PageProblem, type Acted, type BrowserPage, type PageShot } from "./page";
import {
  AGENT_KEYS,
  BROWSER_TOOL,
  HANDOVERS_PER_TASK,
  agentKey,
  earlierNote,
  oneLine,
  redact,
  shortened,
  shownUrl,
  siteHost,
  took,
  toolDescription,
  verificationOf,
  viewText,
  type Verification,
} from "./rules";
import { BrowserProblem } from "./service";
import { currentPage, handOver, keepSessions, runBrowser, signInOn, taskPages, visited, type RunBrowser, type RunSpec, type TaskSpec } from "./sessions";

/** What the tool needs to know of the run and the task it works in. */
export interface BrowserToolContext {
  runId: string;
  projectId: string;
  projectTitle: string;
  /** The account of the app the project belongs to. */
  userId: string | null;
  taskId: string;
  taskTitle: string;
  agentName: string | null;
  /** The site accounts the run may sign in with: the project's, checked when the task started. */
  accounts: SiteAccount[];
  isCancelled?: () => boolean;
  /** A note on the page of the run; with `link`, where a person does what the task waits for. */
  progress?: (message: string, link?: string) => void;
  /** Which attempt at the task this is. A new attempt starts over, and is told what the earlier ones did. */
  attempt?: () => number;
}

const ACTIONS = ["open", "read", "click", "type", "select", "press", "back", "sign_in", "ask_person"] as const;
type Action = (typeof ACTIONS)[number];

const NOBODY =
  "Do not ask again for the same thing. Finish with what you have, and say in your answer exactly what is waiting for a person and on which page.";

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * The tool an agent works in a browser with. It names an account of its
 * project, never a password: what signs in is saved by an owner and typed by
 * the app, and no answer of this tool holds it.
 */
export function browserTool(ctx: BrowserToolContext): LoopTool {
  const names = ctx.accounts.map((a) => a.name);
  const run: RunSpec = { runId: ctx.runId, projectId: ctx.projectId, projectTitle: ctx.projectTitle, userId: ctx.userId, accounts: ctx.accounts };
  const task: TaskSpec = { taskId: ctx.taskId, taskTitle: ctx.taskTitle, agentName: ctx.agentName };
  // The attempt at the task that made the last call: null before the first.
  let attempt: number | null = null;

  const entry = (kind: string, extra: Partial<Parameters<typeof logAction>[0]> & { status: Parameters<typeof logAction>[0]["status"] }) =>
    logAction({
      kind,
      projectId: ctx.projectId,
      projectTitle: ctx.projectTitle,
      runId: ctx.runId,
      taskId: ctx.taskId,
      taskTitle: ctx.taskTitle,
      agentName: ctx.agentName,
      userId: ctx.userId,
      ...extra,
    });

  /** Hand the page to a person, and say afterwards what became of it. */
  async function person(browser: RunBrowser, reason: string, account: SiteAccount | null): Promise<string> {
    const pages = await taskPages(browser, ctx.taskId);
    if (pages.handovers >= HANDOVERS_PER_TASK) {
      throw new ToolError(`This task has handed its page to a person ${HANDOVERS_PER_TASK} times, which is as often as it may. ${NOBODY}`);
    }
    const page = currentPage(pages);
    const site = page ? siteHost(page.lastUrl) : "";
    const result = await handOver(browser, pages, task, {
      reason,
      account,
      isCancelled: ctx.isCancelled,
      onWaiting: (link) => ctx.progress?.(`Waiting for a person${site ? ` on ${site}` : ""}: ${oneLine(reason, 90)}`, link),
    });
    ctx.progress?.("Working in the browser");
    if (result.outcome === "cancelled") throw new ToolError("The run was stopped.");
    if (result.outcome === "closed") throw new ToolError("The page was closed while it waited for a person. Open it again if the task still needs it.");
    if (result.outcome === "timeout") return `Nobody took the page over within ${took(result.waitMs)}. ${NOBODY}`;
    if (result.outcome === "give_up") return `A person looked at the page and said that it cannot be done now. ${NOBODY}`;
    // What the person did may have signed an account in: its session is kept.
    if (page) visited(browser, page.lastUrl);
    await keepSessions(browser);
    return `A person took the page over for ${took(result.waitedMs)} and handed it back. Go on from what it shows now.`;
  }

  /**
   * What the page shows after something was done, as the agent reads it.
   * A page that is nothing but a check is given a moment to pass by itself,
   * and is then handed to a person, once.
   */
  async function after(browser: RunBrowser, note: string, opts: { handOverChecks?: boolean } = {}): Promise<string> {
    const pages = await taskPages(browser, ctx.taskId);
    let page = currentPage(pages);
    if (!page) throw new ToolError("The page was closed. Open it again.");
    pages.actedAt = Date.now();
    // A tab the site has just opened is shown once it has loaded.
    if (pages.notes.length > 0) await page.settle();
    let said = note;
    let shot: PageShot = await page.shot();
    let verification: Verification | null = verificationOf(shot.signals);

    if (verification?.blocks && opts.handOverChecks !== false) {
      // Some checks let a visitor through by themselves after a few seconds.
      for (let waited = 0; waited < 4 && verification?.blocks; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        page = currentPage(pages) ?? page;
        shot = await page.shot();
        verification = verificationOf(shot.signals);
      }
      if (verification?.blocks) {
        const outcome = await person(browser, `${siteHost(shot.url) || "The page"} shows ${verification.label} before anything else.`, null);
        said = said ? `${said}\n${outcome}` : outcome;
        page = currentPage(pages);
        if (!page) throw new ToolError("The page was closed. Open it again.");
        await page.settle();
        shot = await page.shot();
        verification = verificationOf(shot.signals);
      }
    }

    // Only the web, and only where agents may go.
    let host = "";
    try {
      const url = new URL(shot.url);
      host = url.hostname;
      if (url.protocol !== "http:" && url.protocol !== "https:" && shot.url !== "about:blank" && !shot.url.startsWith("about:blank#")) {
        await page.goto("about:blank").catch(() => undefined);
        throw new ToolError("The page led to something that is not a web page; it was closed.");
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
    }
    if (host && !agentHostAllowed(host)) {
      await page.goto("about:blank").catch(() => undefined);
      throw new ToolError(`The page led to ${host}, which is not among the hosts this server lets agents reach. It was closed.`);
    }
    visited(browser, shot.url);
    pages.text = shot.text;
    const notes = pages.notes.splice(0);
    const open = pages.pages.filter((p) => !p.closed).length;
    return viewText({
      url: shot.url,
      title: shot.title,
      text: shot.text,
      tab: { index: open, count: open },
      verification,
      dialogs: page.takeDialogs(),
      note: [said, ...notes].filter(Boolean).join("\n") || undefined,
    });
  }

  return {
    definition: {
      name: BROWSER_TOOL,
      description: toolDescription(ctx.accounts),
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS], description: "What to do." },
          url: { type: "string", description: "For open: the full address, starting with https://" },
          element: { type: "integer", description: "For click, type and select: the number of the element, from the latest answer." },
          text: { type: "string", description: "For type: what to type. It takes the place of what the field holds." },
          submit: { type: "boolean", description: "For type: press Enter after typing, which sends most forms." },
          option: { type: "string", description: "For select: the option, as it is written in the list." },
          key: { type: "string", description: `For press: one of ${Object.keys(AGENT_KEYS).join(", ")}.` },
          offset: { type: "integer", description: "For read: the character to read on from, in a long page." },
          account: {
            type: "string",
            description: names.length > 0 ? `For sign_in: the account's name: ${names.join(", ")}.` : "For sign_in: the account's name. This project has none.",
          },
          reason: { type: "string", description: "For ask_person: what the person has to do on the page, in a sentence." },
          accept_dialogs: { type: "boolean", description: "For click and press: answer OK when the page asks to confirm what the action does." },
        },
        required: ["action"],
      },
    },
    shorten: shortened,
    async run(args) {
      try {
        return await act(args);
      } catch (err) {
        if (!(err instanceof ToolError)) {
          // What the model is told is that the tool failed; why is for whoever looks after the server.
          // eslint-disable-next-line no-console
          console.error("[xiero-nexus] the browser tool failed unexpectedly:", err);
        }
        throw err;
      }
    },
  };

  async function act(args: Record<string, unknown>): Promise<string> {
    {
      const action = (typeof args.action === "string" ? args.action.trim().toLowerCase() : "") as Action;
      if (!ACTIONS.includes(action)) throw new ToolError(`"action" is one of ${ACTIONS.join(", ")}.`);

      // An attempt that starts over is told what the task has already done in
      // the browser: starting over does not undo a form that was sent.
      let before = "";
      const now = ctx.attempt?.() ?? 1;
      if (attempt !== now) {
        attempt = now;
        before = earlierNote(actionsOfTask(ctx.taskId));
      }

      let browser: RunBrowser;
      let page: BrowserPage;
      try {
        browser = await runBrowser(run);
        const pages = await taskPages(browser, ctx.taskId);
        const front = currentPage(pages);
        if (!front) throw new BrowserProblem("The page was closed by the browser.");
        page = front;
      } catch (err) {
        if (err instanceof BrowserProblem) throw new ToolError(`The browser cannot be used just now: ${err.message} A later call tries again.`);
        throw err;
      }
      const started = Date.now();
      const finish = (text: string) => redact(before ? `${before}\n\n${text}` : text, browser.secrets);
      const failed = (kind: string, err: unknown, detail: string, url: string | null): never => {
        const message =
          err instanceof PageProblem || err instanceof ToolError
            ? err.message
            : err instanceof BrowserProblem
              ? `The browser cannot be used just now: ${err.message}`
              : err instanceof AppError
                ? err.message
                : "The browser did not do it.";
        entry(kind, { status: "failed", url, detail, note: message, durationMs: Date.now() - started });
        if (err instanceof PageProblem || err instanceof ToolError || err instanceof BrowserProblem || err instanceof AppError) {
          throw new ToolError(redact(before ? `${before}\n\n${message}` : message, browser.secrets));
        }
        throw err;
      };
      const done = (kind: string, acted: Acted, detail: string) =>
        entry(kind, { status: "ok", url: shownUrl(acted.url), detail, durationMs: Date.now() - started });

      switch (action) {
        case "open": {
          const address = typeof args.url === "string" ? args.url.trim() : "";
          if (!address) throw new ToolError('"url" is required for open.');
          if (address.length > 2000) throw new ToolError("That address is too long.");
          let url: URL;
          try {
            url = await assertWebAddress(/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`);
          } catch (err) {
            return failed("open", err instanceof AppError ? new ToolError(`${err.message}.`) : err, shownUrl(address), null);
          }
          ctx.progress?.(`Opening ${url.hostname}`);
          try {
            const opened = await page.goto(url.toString());
            if (opened.error) throw new ToolError(`${shownUrl(url.toString())} was not opened: ${opened.error}.`);
            const text = await after(browser, opened.slow ? "The page was still loading after 30 seconds: this is what it shows so far." : "");
            entry("open", { status: "ok", url: shownUrl(page.lastUrl), detail: shownUrl(url.toString()), durationMs: Date.now() - started });
            return finish(text);
          } catch (err) {
            return failed("open", err, shownUrl(url.toString()), shownUrl(url.toString()));
          }
        }

        case "read": {
          const offset = Math.max(0, int(args.offset) ?? 0);
          try {
            const pages = await taskPages(browser, ctx.taskId);
            if (offset > 0 && pages.text) {
              if (offset >= pages.text.length) throw new ToolError(`The page ends at character ${pages.text.length}.`);
              const where = await page.where();
              return finish(viewText({ url: where.url, title: where.title, text: pages.text }, offset));
            }
            return finish(await after(browser, "", { handOverChecks: false }));
          } catch (err) {
            if (err instanceof PageProblem || err instanceof BrowserProblem) throw new ToolError(redact(err.message, browser.secrets));
            throw err;
          }
        }

        case "click": {
          const element = int(args.element);
          if (element === null || element < 1) throw new ToolError('"element" is required for click: the number of the element, from the latest answer.');
          page.acceptDialogs = args.accept_dialogs === true;
          try {
            const acted = await page.click(element);
            const what = `${acted.kind} "${oneLine(acted.label, 80)}"`;
            ctx.progress?.(`Clicking ${what}`);
            const text = await after(browser, `Clicked ${what}.`);
            done("click", acted, what);
            return finish(text);
          } catch (err) {
            return failed("click", err, `element ${element}`, shownUrl(page.lastUrl));
          } finally {
            page.acceptDialogs = false;
          }
        }

        case "type": {
          const element = int(args.element);
          if (element === null || element < 1) throw new ToolError('"element" is required for type: the number of the field, from the latest answer.');
          if (typeof args.text !== "string") throw new ToolError('"text" is required for type. An empty text empties the field.');
          if (args.text.length > 10_000) throw new ToolError("A text can be at most 10,000 characters.");
          const submit = args.submit === true;
          try {
            const acted = await page.type(element, args.text, submit);
            // What goes into a password field is not written down, whoever typed it.
            const typed = acted.password ? "(not written down: a password field)" : `"${oneLine(args.text, 80)}"`;
            const what = `field "${oneLine(acted.label, 60)}": ${typed}${submit ? ", then Enter" : ""}`;
            const text = await after(browser, `Typed into the field "${oneLine(acted.label, 60)}"${submit ? " and pressed Enter" : ""}.`);
            done("type", acted, what);
            return finish(text);
          } catch (err) {
            return failed("type", err, `element ${element}`, shownUrl(page.lastUrl));
          }
        }

        case "select": {
          const element = int(args.element);
          if (element === null || element < 1) throw new ToolError('"element" is required for select: the number of the list, from the latest answer.');
          if (typeof args.option !== "string" || !args.option.trim()) throw new ToolError('"option" is required for select: the option as the list writes it.');
          try {
            const acted = await page.choose(element, args.option);
            const what = `list "${oneLine(acted.label, 60)}": "${oneLine(acted.chosen, 60)}"`;
            const text = await after(browser, `Chose "${oneLine(acted.chosen, 60)}" in the list "${oneLine(acted.label, 60)}".`);
            done("select", acted, what);
            return finish(text);
          } catch (err) {
            return failed("select", err, `element ${element}`, shownUrl(page.lastUrl));
          }
        }

        case "press": {
          const spec = agentKey(args.key);
          if (!spec) throw new ToolError(`"key" is one of ${Object.keys(AGENT_KEYS).join(", ")}.`);
          const name = Object.keys(AGENT_KEYS).find((key) => AGENT_KEYS[key] === spec) ?? spec.key;
          page.acceptDialogs = args.accept_dialogs === true;
          try {
            await page.key(spec);
            await page.afterAction();
            const text = await after(browser, `Pressed ${name}.`);
            entry("press", { status: "ok", url: shownUrl(page.lastUrl), detail: name, durationMs: Date.now() - started });
            return finish(text);
          } catch (err) {
            return failed("press", err, name, shownUrl(page.lastUrl));
          } finally {
            page.acceptDialogs = false;
          }
        }

        case "back": {
          try {
            const went = await page.back();
            if (!went) throw new ToolError("There is no page before this one in this tab.");
            const text = await after(browser, "Went back one page.");
            entry("back", { status: "ok", url: shownUrl(page.lastUrl), durationMs: Date.now() - started });
            return finish(text);
          } catch (err) {
            return failed("back", err, "", shownUrl(page.lastUrl));
          }
        }

        case "sign_in": {
          const wanted = typeof args.account === "string" ? args.account.trim().toLowerCase() : "";
          const account = wanted ? ctx.accounts.find((a) => a.name === wanted) : ctx.accounts.length === 1 ? ctx.accounts[0] : undefined;
          if (!account) {
            throw new ToolError(
              names.length === 0
                ? "No account is saved for this project, so there is nothing to sign in with. An owner saves accounts on the Browser page and names them in the project."
                : wanted
                  ? `This project has no account "${wanted}". Its accounts: ${names.join(", ")}.`
                  : `Say which account: ${names.join(", ")}.`,
            );
          }
          const site = siteHost(account.siteUrl);
          ctx.progress?.(`Signing in to ${site} as ${account.username}`);
          const log = (status: "ok" | "failed" | "refused" | "waited", note: string) =>
            entry("sign_in", { account, status, url: shownUrl(page.lastUrl), detail: `${account.name} (${account.username})`, note, durationMs: Date.now() - started });
          try {
            const outcome = await signInOn(browser, page, account);
            switch (outcome.state) {
              case "signed_in": {
                log("ok", "The form was filled in and sent, and it is gone.");
                return finish(await after(browser, `Signed in to ${site} as ${account.username}: the form was filled in and sent, and it is gone. Look at the page to see that you are in.`));
              }
              case "no_form": {
                log("ok", "The site showed no sign-in form: the session that is kept still holds.");
                return finish(
                  await after(browser, `${site} shows no sign-in form: the session that was kept from an earlier sign-in still holds, so nothing was filled in. Look at the page to see that you are in as ${account.username}.`),
                );
              }
              case "needs_person": {
                const reason = outcome.filled
                  ? `The sign-in form of ${site} is filled in for ${account.username}, and shows ${outcome.verification.label}: do that, and send the form.`
                  : `${site} asks for ${outcome.verification.label} to sign in as ${account.username}.`;
                const said = await person(browser, reason, account);
                log("waited", said);
                return finish(await after(browser, `${outcome.filled ? `The app filled in the sign-in form of ${site}. It` : `${site}`} asks for ${outcome.verification.label}, which is a person's to do.\n${said}`, { handOverChecks: false }));
              }
              case "refused": {
                log("refused", "The form was still there after it was sent.");
                const text = await after(browser, "", { handOverChecks: false });
                throw new ToolError(
                  `${site} did not take the sign-in of "${account.name}": the form is still there after it was sent. Trying again does not help; an owner has to look at the account (Browser page). The page says:\n${text}`,
                );
              }
              case "other_site": {
                log("refused", `The password is asked for on ${outcome.host}, which is not the site of the account.`);
                throw new ToolError(
                  `The password of "${account.name}" is asked for on ${outcome.host}, which is not the site it was saved for (${site}): the app does not type it there. An owner has to save the account with that address.`,
                );
              }
              case "error": {
                log("failed", outcome.message);
                throw new ToolError(`The sign-in page of "${account.name}" was not opened: ${outcome.message}.`);
              }
            }
          } catch (err) {
            if (err instanceof ToolError) throw new ToolError(redact(before ? `${before}\n\n${err.message}` : err.message, browser.secrets));
            return failed("sign_in", err, `${account.name} (${account.username})`, shownUrl(page.lastUrl));
          }
          return finish("");
        }

        case "ask_person": {
          const reason = typeof args.reason === "string" ? oneLine(args.reason, 300) : "";
          if (!reason) throw new ToolError('"reason" is required for ask_person: what the person has to do on the page, in a sentence.');
          try {
            const said = await person(browser, reason, null);
            return finish(await after(browser, said, { handOverChecks: false }));
          } catch (err) {
            if (err instanceof ToolError) throw new ToolError(redact(before ? `${before}\n\n${err.message}` : err.message, browser.secrets));
            if (err instanceof PageProblem || err instanceof BrowserProblem) throw new ToolError(redact(err.message, browser.secrets));
            throw err;
          }
        }
      }
    }
  }
}
