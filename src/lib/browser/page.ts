import "server-only";
import { CdpError, type CdpConnection } from "./cdp";
import { pageCall } from "./page-script";
import { NAVIGATION_TIMEOUT_MS, VIEWPORT, captchaProvider, type KeySpec, type PageSignals } from "./rules";

/**
 * One page (tab) of the browser, and what can be done with it: open an
 * address, read what it shows, click, type, choose, press a key, take a
 * picture. Agents act through this, and so does a person who takes a page
 * over in the live view.
 */

/** Something about the page stands in the way of an action. The message is for the agent. */
export class PageProblem extends Error {
  constructor(
    /** "secret": a password the app was to type was not typed, because it would not have gone into the password field. */
    readonly kind: "gone" | "covered" | "disabled" | "wrong" | "closed" | "failed" | "secret",
    message: string,
  ) {
    super(message);
    this.name = "PageProblem";
  }
}

export interface PageShot {
  url: string;
  title: string;
  /** The page as text, with what can be acted on marked [N: …]. */
  text: string;
  signals: PageSignals;
}

interface RawSnapshot {
  url: string;
  title: string;
  text: string;
  refs: number;
  ready: string;
  signals: {
    frames: { src: string; title: string; width: number; height: number }[];
    widgets: string[];
    captchaField: boolean;
    codeField: boolean;
    checkPage: boolean;
    passwordFields: number;
    textLength: number;
  };
}

interface Located {
  gone?: boolean;
  kind?: string;
  label?: string;
  tag?: string;
  type?: string;
  disabled?: boolean;
  small?: boolean;
  clear?: boolean;
  cover?: string;
  x?: number;
  y?: number;
  url?: string;
}

export interface SignInForm {
  url: string;
  passwords: number;
  user: boolean;
  pass: boolean;
  go: boolean;
  looks: boolean;
  userHeld?: number;
}

/** What was acted on, for the log and for what the agent is told. */
export interface Acted {
  kind: string;
  label: string;
  url: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Said when a password was not typed, because it would not have gone into the password field. */
export const NOT_TYPED = "The page did not let its password field be entered, so the password was not typed: it would have gone somewhere else on the page.";

/** The CAPTCHA widgets a page shows, from its frames and marked elements. */
function captchasOf(raw: RawSnapshot["signals"]): string[] {
  const found: string[] = [];
  for (const frame of raw.frames) {
    const who = captchaProvider(frame.src, frame.title);
    if (!who) continue;
    // A badge that only says a site is protected asks nothing of the visitor.
    if (/size=invisible|[?&#]invisible/.test(frame.src)) continue;
    if (frame.width < 60 || frame.height < 30) continue;
    found.push(who);
  }
  for (const widget of raw.widgets) found.push(captchaProvider(widget) || "CAPTCHA");
  return [...new Set(found)];
}

/** Why an address could not be opened, in words. */
export function loadError(text: string): string {
  if (/ERR_NAME_NOT_RESOLVED/.test(text)) return "the name of the site could not be found";
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(text)) {
    return "the browser service did not open it: the address is on a private network, or its name could not be found";
  }
  if (/ERR_CONNECTION_REFUSED/.test(text)) return "the site refused the connection";
  if (/ERR_CONNECTION_(RESET|CLOSED)|ERR_EMPTY_RESPONSE/.test(text)) return "the site closed the connection";
  if (/ERR_(CONNECTION_)?TIMED_OUT/.test(text)) return "the site did not answer in time";
  if (/ERR_CERT|ERR_SSL/.test(text)) return "the site's certificate is not valid";
  if (/ERR_ABORTED/.test(text)) return "it is not a page: a download, or something the browser does not show";
  if (/ERR_TOO_MANY_REDIRECTS/.test(text)) return "the site sent the browser round in circles";
  if (/ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK/.test(text)) return "the site cannot be reached from the browser service";
  return `it could not be loaded (${text.replace(/^net::/, "")})`;
}

function contextGone(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot find context|context was destroyed|Cannot find default execution context|navigated or closed|No frame for given id|Frame with the given id/i.test(message);
}

export class BrowserPage {
  closed = false;
  crashed = false;
  /** When set, a question the page asks in a box of its own is answered OK instead of Cancel. */
  acceptDialogs = false;
  private frameId = "";
  private loading = false;
  private inFlight = new Set<string>();
  private dialogs: string[] = [];
  private stops: (() => void)[] = [];
  /** The address the page showed last, kept for when it cannot be asked. */
  lastUrl = "about:blank";

  private constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  /** A new, empty page in a browser context. */
  static async open(conn: CdpConnection, browserContextId: string, url = "about:blank"): Promise<BrowserPage> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url, browserContextId });
    return BrowserPage.adopt(conn, targetId);
  }

  /** A page that is there already: one a site opened by itself. */
  static async adopt(conn: CdpConnection, targetId: string): Promise<BrowserPage> {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new BrowserPage(conn, targetId, sessionId);
    await page.setup();
    return page;
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new PageProblem("closed", "The page is closed."));
    return this.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  private async setup(): Promise<void> {
    const on = (method: string, listener: (params: Record<string, unknown>) => void) => {
      this.stops.push(this.conn.on(method, this.sessionId, listener));
    };
    on("Page.frameStartedLoading", (p) => {
      if (p.frameId === this.frameId) this.loading = true;
    });
    on("Page.frameStoppedLoading", (p) => {
      if (p.frameId === this.frameId) this.loading = false;
    });
    on("Page.frameNavigated", (p) => {
      const frame = p.frame as { id?: string; parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && frame.url) {
        this.lastUrl = frame.url;
        this.inFlight.clear();
      }
    });
    on("Page.navigatedWithinDocument", (p) => {
      if (p.frameId === this.frameId && typeof p.url === "string") this.lastUrl = p.url;
    });
    on("Network.requestWillBeSent", (p) => {
      const type = String(p.type ?? "");
      if ((type === "XHR" || type === "Fetch" || type === "Document") && typeof p.requestId === "string") {
        if (this.inFlight.size < 200) this.inFlight.add(p.requestId);
      }
    });
    const finished = (p: Record<string, unknown>) => {
      if (typeof p.requestId === "string") this.inFlight.delete(p.requestId);
    };
    on("Network.loadingFinished", finished);
    on("Network.loadingFailed", finished);
    on("Network.responseReceived", (p) => {
      // A request that stays open on purpose (a stream of events) is not waited for.
      const response = p.response as { mimeType?: string } | undefined;
      if (response?.mimeType === "text/event-stream") finished(p);
    });
    on("Page.javascriptDialogOpening", (p) => {
      const type = String(p.type ?? "alert");
      const message = String(p.message ?? "").replace(/\s+/g, " ").slice(0, 300);
      const accept = type === "alert" || type === "beforeunload" || this.acceptDialogs;
      if (type !== "beforeunload") {
        this.dialogs.push(
          type === "alert"
            ? `The page showed a message in a box of its own: "${message}". It was closed.`
            : `The page asked in a box of its own: "${message}". It was answered ${accept ? "OK" : 'Cancel (to answer OK, repeat the action with "accept_dialogs": true)'}.`,
        );
        if (this.dialogs.length > 10) this.dialogs.shift();
      }
      void this.send("Page.handleJavaScriptDialog", { accept }).catch(() => undefined);
    });
    on("Inspector.targetCrashed", () => {
      this.crashed = true;
    });
    this.stops.push(
      this.conn.on("Target.detachedFromTarget", undefined, (p) => {
        if (p.sessionId === this.sessionId) this.ended();
      }),
    );
    this.stops.push(
      this.conn.on("Target.targetDestroyed", undefined, (p) => {
        if (p.targetId === this.targetId) this.ended();
      }),
    );
    this.stops.push(this.conn.onClose(() => this.ended()));

    await this.send("Page.enable");
    const tree = await this.send<{ frameTree: { frame: { id: string; url?: string } } }>("Page.getFrameTree");
    this.frameId = tree.frameTree.frame.id;
    if (tree.frameTree.frame.url) this.lastUrl = tree.frameTree.frame.url;
    await Promise.all([
      this.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
      this.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }),
      this.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
      // A file chooser is never opened: nothing here answers one.
      this.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined),
    ]);
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    this.conn.forget(this.sessionId);
  }

  /** Run one of the page script's functions in the page, in its own world. */
  private async call<T>(name: string, args: readonly unknown[] = []): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (this.closed) throw new PageProblem("closed", "The page is closed.");
      if (this.crashed) throw new PageProblem("closed", "The page crashed in the browser. Open it again.");
      try {
        const world = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: this.frameId, worldName: "xn" });
        const answer = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          "Runtime.evaluate",
          { expression: pageCall(name, args), contextId: world.executionContextId, returnByValue: true, awaitPromise: true },
          20_000,
        );
        if (answer.exceptionDetails) {
          const said = answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "it failed";
          if (contextGone(said)) throw new Error(said);
          throw new PageProblem("failed", `The page could not be read: ${said.split("\n")[0]?.slice(0, 200)}`);
        }
        return answer.result?.value as T;
      } catch (err) {
        if (err instanceof PageProblem) throw err;
        if (err instanceof CdpError && err.gone) throw new PageProblem("closed", "The connection to the browser was lost.");
        // The page is between two documents: a moment later there is one again.
        if (!contextGone(err)) throw err;
        last = err;
        await sleep(200);
      }
    }
    throw new PageProblem("failed", `The page kept changing and could not be read: ${last instanceof Error ? last.message.slice(0, 160) : "no reason given"}`);
  }

  /**
   * Wait until the page has come to rest: loaded, nothing it asked for still
   * on its way, and nothing in it changed for a moment. A page that never
   * rests is given a few seconds, and then taken as it is.
   */
  async settle(loadMs = NAVIGATION_TIMEOUT_MS, restMs = 5_000): Promise<{ slow: boolean }> {
    const started = Date.now();
    let loadedAt = 0;
    for (;;) {
      if (this.closed || this.crashed) return { slow: false };
      let state: { since: number; ready: string; url: string } | null = null;
      try {
        state = await this.call<{ since: number; ready: string; url: string }>("quiet");
        this.lastUrl = state.url;
      } catch (err) {
        if (err instanceof PageProblem && err.kind === "closed") return { slow: false };
        state = null;
      }
      const now = Date.now();
      const loaded = state !== null && state.ready === "complete" && !this.loading;
      if (loaded && loadedAt === 0) loadedAt = now;
      if (!loaded) loadedAt = 0;
      if (loaded && state !== null && state.since >= 400 && this.inFlight.size === 0) return { slow: false };
      if (loadedAt > 0 && now - loadedAt > restMs) return { slow: false };
      if (now - started > loadMs) return { slow: true };
      await sleep(150);
    }
  }

  /** Open an address. Resolves to what stood in the way, or null. */
  async goto(url: string): Promise<{ error: string | null; slow: boolean }> {
    // Only what is on the web: never a file of the machine the browser runs on, nor a page of the browser itself.
    if (!/^https?:\/\//i.test(url)) return { error: "only addresses that start with http:// or https:// are opened", slow: false };
    let answer: { loaderId?: string; errorText?: string };
    try {
      answer = await this.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url }, NAVIGATION_TIMEOUT_MS + 15_000);
    } catch (err) {
      if (err instanceof PageProblem) throw err;
      return { error: err instanceof CdpError && /did not answer/.test(err.message) ? "the site did not answer in time" : loadError(err instanceof Error ? err.message : String(err)), slow: false };
    }
    if (answer.errorText) return { error: loadError(answer.errorText), slow: false };
    await sleep(100);
    const { slow } = await this.settle();
    return { error: null, slow };
  }

  /** After something was done to the page: give it a moment to start what follows, then wait for it to rest. */
  async afterAction(): Promise<void> {
    await sleep(350);
    await this.settle(NAVIGATION_TIMEOUT_MS, 4_000);
  }

  /** What the page shows now. */
  async shot(): Promise<PageShot> {
    const raw = await this.call<RawSnapshot>("snapshot");
    this.lastUrl = raw.url;
    return {
      url: raw.url,
      title: raw.title,
      text: raw.text,
      signals: {
        captchas: captchasOf(raw.signals),
        captchaField: raw.signals.captchaField,
        codeField: raw.signals.codeField,
        checkPage: raw.signals.checkPage,
        passwordFields: raw.signals.passwordFields,
        textLength: raw.signals.textLength,
      },
    };
  }

  /** The address and the title, without reading the page. */
  async where(): Promise<{ url: string; title: string }> {
    try {
      const state = await this.call<{ url: string }>("quiet");
      this.lastUrl = state.url;
    } catch {
      // The last address that was seen is given.
    }
    let title = "";
    try {
      const info = await this.conn.send<{ targetInfo?: { title?: string; url?: string } }>("Target.getTargetInfo", { targetId: this.targetId });
      title = info.targetInfo?.title ?? "";
    } catch {
      // Without a title.
    }
    return { url: this.lastUrl, title };
  }

  /** Questions the page asked in a box of its own since this was last called. */
  takeDialogs(): string[] {
    return this.dialogs.splice(0);
  }

  // ─── Acting ────────────────────────────────────────────────────────────────

  async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, clickCount = 1): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : clickCount,
    });
  }

  /** A click at a point of the window, as a hand on a mouse does it. */
  async clickAt(x: number, y: number, clickCount = 1): Promise<void> {
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y, clickCount);
    await this.mouse("mouseReleased", x, y, clickCount);
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  /** Press a key and let it go. */
  async key(spec: KeySpec, modifiers = 0): Promise<void> {
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    };
    await this.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Type text where the cursor is, as if it were typed or pasted. */
  async insert(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** Click what a number of the last reading stands for. */
  async click(ref: number | string): Promise<Acted> {
    const found = await this.call<Located>("locate", [ref]);
    if (found.gone) throw new PageProblem("gone", "That element is not on the page any more. Use the numbers of the latest answer.");
    if (found.disabled) throw new PageProblem("disabled", `${found.kind || "That element"} "${found.label ?? ""}" is switched off on the page: it cannot be clicked now.`);
    const acted: Acted = { kind: found.kind || found.tag || "element", label: found.label ?? "", url: found.url ?? this.lastUrl };
    const boxed = found.kind === "checkbox" || found.kind === "radio";
    if (found.small || (!found.clear && boxed) || found.x === undefined || found.y === undefined) {
      // Something that takes no room of its own, as a box that a site draws itself: it is told that it was clicked.
      await this.call("press", [ref]);
    } else if (!found.clear) {
      throw new PageProblem("covered", `Something else is in front of it: ${found.cover ?? "another element"}. Close or answer that first.`);
    } else {
      await this.clickAt(found.x, found.y);
    }
    await this.afterAction();
    return acted;
  }

  /**
   * Empty a field and type into it. With `submit`, Enter is pressed after it.
   *
   * What is typed goes where the cursor is. Usually that is the field; a
   * page can see to it that it is not (a field that passes the cursor on,
   * something in front of it). For what an agent types that is the page's
   * own business, as it is for a person at a keyboard. With `secret`, the
   * text is a password the app types for an account: it is typed only when
   * the cursor is in that very field and the field is one for passwords,
   * and otherwise not at all.
   */
  async type(ref: number | string, text: string, submit = false, opts: { secret?: boolean } = {}): Promise<Acted & { password: boolean }> {
    const field = await this.call<{ gone?: boolean; wrong?: string; fixed?: boolean; ok?: boolean; focused?: boolean; password?: boolean; label?: string; url?: string }>("ready", [ref]);
    if (field.gone) throw new PageProblem("gone", "That field is not on the page any more. Use the numbers of the latest answer.");
    if (field.wrong) throw new PageProblem("wrong", `That is a ${field.wrong}, not a field to type in.`);
    if (field.fixed) throw new PageProblem("disabled", "That field cannot be changed on the page now.");
    if (!field.focused) {
      // The page did not let the field be entered directly: it is clicked, as a person would.
      const found = await this.call<Located>("locate", [ref]);
      if (found.clear && found.x !== undefined && found.y !== undefined) await this.clickAt(found.x, found.y);
    }
    if (opts.secret) {
      const held = await this.call<{ gone?: boolean; focused?: boolean; password?: boolean }>("holds", [ref]);
      if (held.gone || !held.focused || !held.password) throw new PageProblem("secret", NOT_TYPED);
    }
    if (text) await this.insert(text);
    if (submit) {
      await this.key({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
      await this.afterAction();
    } else {
      await this.settle(NAVIGATION_TIMEOUT_MS, 1_500);
    }
    return { kind: "field", label: field.label ?? "", url: field.url ?? this.lastUrl, password: Boolean(field.password) };
  }

  /** Choose an option of a list by what it says. */
  async choose(ref: number, option: string): Promise<Acted & { chosen: string }> {
    const answer = await this.call<{ gone?: boolean; wrong?: string; fixed?: boolean; options?: string[]; ok?: boolean; chosen?: string; label?: string; url?: string }>("choose", [ref, option]);
    if (answer.gone) throw new PageProblem("gone", "That list is not on the page any more. Use the numbers of the latest answer.");
    if (answer.wrong) throw new PageProblem("wrong", `That is a ${answer.wrong}, not a list to choose from. Click it instead.`);
    if (answer.fixed) throw new PageProblem("disabled", "That list, or that option, cannot be chosen on the page now.");
    if (answer.options) throw new PageProblem("wrong", `The list has no option "${option.slice(0, 60)}". Its options: ${answer.options.join(" | ")}.`);
    await this.afterAction();
    return { kind: "select", label: answer.label ?? "", url: answer.url ?? this.lastUrl, chosen: answer.chosen ?? option };
  }

  /** Go back one page. False when there is none before this one. */
  async back(): Promise<boolean> {
    const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex - 1];
    if (!entry) return false;
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.afterAction();
    return true;
  }

  /** Load the page again. */
  async reload(): Promise<void> {
    await this.send("Page.reload", {});
    await this.afterAction();
  }

  /** The fields to sign in with, as far as the page shows them. */
  signInForm(): Promise<SignInForm> {
    return this.call<SignInForm>("signIn");
  }

  /**
   * A picture of what the window shows. A picture that is asked for at the
   * moment a page gives way to the next one is never answered by the
   * browser: it is asked for again, once.
   */
  async picture(quality = 60): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false }, attempt === 0 ? 1_500 : 5_000);
        return Buffer.from(answer.data, "base64");
      } catch (err) {
        if (attempt >= 1 || this.closed || !(err instanceof CdpError) || err.gone) throw err;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5_000);
    } catch {
      // Gone already, or the connection is.
    }
    this.ended();
  }
}
