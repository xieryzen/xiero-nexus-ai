#!/usr/bin/env node
// A web site to browse and sign in to, for the end-to-end checks of the
// browser agents work in.
//
//   node scripts/e2e/mock-site.mjs <port>
//
// It listens on 127.0.0.1. The same server answers as "localhost", which a
// browser takes for another site: the frames that stand for a CAPTCHA are
// served from there, as a real one comes from somebody else's site.
//
// Accounts: "budi" with the password "rahasia-budi-123", and "sari" with
// "sari-pass-456".
//
//   /                 a page to read: text, links, a search, a list, a box
//   /login            a form; signs in and goes to /account
//   /account          only when signed in: who is, and a form that adds a note
//   /two-step         the name on one page, the password on the next
//   /captcha-login    the form of /login with a CAPTCHA that has to be ticked
//   /code-login       after the password, a code that was "sent" (246810)
//   /checkpoint       a page that is nothing but a check; behind it /protected
//   /echo-login       a site that shows the password it was given, and has a
//                     button that shows what is typed
//   /dialogs, /shadow, /frames, /covered, /new-tab, /slow, /long
//   /redirect-private a redirect to an address on a private network
//
// The control, for the checks:
//
//   GET /__state      what happened: sign-ins, notes, checks that were passed
//   GET /__reset      forget it, and every session
import { randomBytes } from "node:crypto";
import http from "node:http";

const HOST = "127.0.0.1";
const port = Number(process.argv[2] ?? 4014);
const OTHER = `http://localhost:${port}`;

const ACCOUNTS = { budi: "rahasia-budi-123", sari: "sari-pass-456" };
const CODE = "246810";

const fresh = () => ({
  /** Forms that signed someone in, by the page they were on. */
  signIns: [],
  /** Sign-ins that were refused. */
  refused: 0,
  /** Notes added on /account: { user, text }. */
  notes: [],
  /** Checks a visitor passed: which kind. */
  passed: [],
  /** Pages that were asked for, with whether the visitor was signed in. */
  pages: [],
  searches: [],
  userAgents: [],
});
let state = fresh();
/** sid → { user, code: whether the code was given } */
const sessions = new Map();
/** Keys of checks that were shown, and whether each was passed. */
const checks = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, body, extra = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.5 sans-serif;margin:24px;max-width:900px}label{display:block;margin:8px 0}input,select,button,textarea{font:inherit;padding:6px}nav a{margin-right:12px}.error{color:#b00}</style>${extra}</head>
<body>${body}</body></html>`;
}

function cookiesOf(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function redirect(res, to, headers = {}) {
  res.writeHead(302, { location: to, "cache-control": "no-store", ...headers });
  res.end();
}

async function formOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function newCheck(kind) {
  const key = randomBytes(8).toString("hex");
  checks.set(key, { kind, passed: false });
  return key;
}

/**
 * The frame that stands for a CAPTCHA: from the other site, with a box to
 * tick. It is at a fixed place of the window (40, 300), and the box is at a
 * fixed place in it, so that the checks, which play the person, know where
 * to click whatever the browser's fonts are: the box is at (66, 326).
 */
function captchaFrame(key, kind = "recaptcha") {
  const path = kind === "turnstile" ? "/turnstile/widget" : "/recaptcha/api2/anchor";
  const title = kind === "turnstile" ? "Widget containing a Cloudflare security challenge" : "reCAPTCHA";
  return `<iframe src="${OTHER}${path}?k=${key}" title="${title}" width="304" height="78" style="position:fixed;left:40px;top:300px;border:1px solid #ccc;background:#fff"></iframe>`;
}
/** The button that sends the form of such a page, also at a fixed place: its middle is at (100, 420). */
const FIXED_SUBMIT = 'style="position:fixed;left:40px;top:400px;width:120px;height:40px"';

function signIn(res, user, from, remember) {
  const sid = randomBytes(12).toString("hex");
  sessions.set(sid, { user, code: false });
  state.signIns.push({ user, from });
  return { "set-cookie": `sid=${sid}; Path=/; HttpOnly${remember ? "; Max-Age=86400" : ""}` };
}

function loginForm({ action, error = "", extra = "", name = "Sign in", submit = "", typed = "" }) {
  return `<h1>${name}</h1>
${error ? `<p class="error">${error}</p>` : ""}
<form method="post" action="${action}">
  <label>User name <input name="username" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" id="pw" value="${esc(typed)}"></label>
  <label><input type="checkbox" name="remember" value="1"> Keep me signed in</label>
  ${extra}
  <button type="submit" ${submit}>Sign in</button>
</form>
<form method="get" action="/search"><input type="search" name="q" placeholder="Search the site"><button>Search</button></form>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${port}`}`);
  const path = url.pathname;
  const cookies = cookiesOf(req);
  const session = sessions.get(cookies.sid ?? "");
  const user = session?.user ?? null;

  if (path === "/__state") {
    return send(res, 200, { ...state, sessions: sessions.size, code: CODE, other: OTHER, accounts: ACCOUNTS });
  }
  if (path === "/__reset") {
    state = fresh();
    if (url.searchParams.get("sessions") !== "keep") sessions.clear();
    checks.clear();
    return send(res, 200, { ok: true });
  }
  if (!path.startsWith("/recaptcha") && !path.startsWith("/turnstile") && path !== "/favicon.ico" && path !== "/checkpoint/status") {
    state.pages.push({ path, user, method: req.method });
    const agent = String(req.headers["user-agent"] ?? "");
    if (!state.userAgents.includes(agent)) state.userAgents.push(agent);
  }

  // ─── The frames of a CAPTCHA, on the other site ─────────────────────────
  if (path === "/recaptcha/api2/anchor" || path === "/turnstile/widget") {
    const key = url.searchParams.get("k") ?? "";
    return send(
      res,
      200,
      page(
        "reCAPTCHA",
        `<input type="checkbox" id="box" aria-label="I'm not a robot" style="position:fixed;left:11px;top:11px;width:28px;height:28px;margin:0"><span style="position:fixed;left:52px;top:14px;font-size:18px">I'm not a robot</span>
<script>document.getElementById('box').addEventListener('change', function () { fetch('/recaptcha/solve?k=${esc(key)}').then(function () { document.body.append(' ✓'); }); });</script>`,
        "<style>body{margin:0}</style>",
      ),
    );
  }
  if (path === "/recaptcha/solve") {
    const check = checks.get(url.searchParams.get("k") ?? "");
    if (check && !check.passed) {
      check.passed = true;
      state.passed.push(check.kind);
    }
    return send(res, 200, { ok: Boolean(check) });
  }
  if (path === "/favicon.ico") return send(res, 404, "");

  // ─── Pages for everyone ─────────────────────────────────────────────────
  if (path === "/") {
    return send(
      res,
      200,
      page(
        "Toko Contoh",
        `<nav><a href="/">Home</a><a href="/login">Sign in</a><a href="/long">A long page</a><a href="https://example.com/elsewhere">Elsewhere</a></nav>
<h1>Toko Contoh</h1>
<p>Welcome to the example shop. Opening hours: 08:00 to 17:00.</p>
<h2>Products</h2>
<ul><li>Kopi Gayo, Rp 85.000</li><li>Teh Melati, Rp 40.000</li></ul>
<form method="get" action="/search"><label>Search <input type="search" name="q" placeholder="Search the site"></label><button type="submit">Search</button></form>
<label>Sort by <select id="sort" name="sort"><option value="name">Name</option><option value="price">Price</option><option value="new">Newest first</option></select></label>
<label><input type="checkbox" id="stock"> Only what is in stock</label>
<button id="more" type="button">Show more</button>
<div id="shown"></div>
<p><img src="/pixel.png" alt="A cup of coffee" width="20" height="20"></p>
<script>
document.getElementById('more').addEventListener('click', function () { setTimeout(function () { document.getElementById('shown').textContent = 'More: Gula Aren, Rp 30.000'; }, 300); });
document.getElementById('sort').addEventListener('change', function (e) { document.getElementById('shown').textContent = 'Sorted by ' + e.target.value; });
document.getElementById('stock').addEventListener('change', function (e) { document.getElementById('shown').textContent = e.target.checked ? 'In stock only' : 'Everything'; });
</script>`,
      ),
    );
  }
  if (path === "/pixel.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  }
  if (path === "/search") {
    const q = url.searchParams.get("q") ?? "";
    state.searches.push(q);
    return send(res, 200, page("Search", `<h1>Search</h1><p>Results for "${esc(q)}": ${q.toLowerCase().includes("kopi") ? "Kopi Gayo, Rp 85.000" : "nothing found"}.</p><a href="/">Home</a>`));
  }
  if (path === "/long") {
    const lines = [];
    for (let i = 1; i <= 700; i++) lines.push(`<p>Line ${i} of the long page, with enough words to take some room in it.</p>`);
    return send(res, 200, page("A long page", `<h1>A long page</h1>${lines.join("")}<a href="/">Back to the start</a>`));
  }
  if (path === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return send(res, 200, page("Slow", "<h1>Slow</h1><p>This page took its time.</p>"));
  }
  if (path === "/redirect-private") return redirect(res, "http://10.0.0.1/secret");
  if (path === "/dialogs") {
    return send(
      res,
      200,
      page(
        "Dialogs",
        `<h1>Dialogs</h1><button id="a" type="button">Say something</button><button id="c" type="button">Delete everything</button><p id="out">Nothing was done.</p>
<script>
document.getElementById('a').addEventListener('click', function () { alert('Hello from the page'); document.getElementById('out').textContent = 'The message was shown.'; });
document.getElementById('c').addEventListener('click', function () { document.getElementById('out').textContent = confirm('Really delete everything?') ? 'Everything was deleted.' : 'Nothing was deleted.'; });
</script>`,
      ),
    );
  }
  if (path === "/shadow") {
    return send(
      res,
      200,
      page(
        "Shadow",
        `<h1>A part of its own</h1><x-card></x-card><p id="out">Not pressed.</p>
<script>
customElements.define('x-card', class extends HTMLElement { connectedCallback() { const root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<p>Inside the part.</p><button type="button">Press inside</button>'; root.querySelector('button').addEventListener('click', function () { document.getElementById('out').textContent = 'Pressed inside.'; }); } });
</script>`,
      ),
    );
  }
  if (path === "/frames") {
    return send(res, 200, page("Frames", `<h1>Frames</h1><p>Above the frame.</p><iframe src="/frame-inner" width="500" height="160" title="A form"></iframe><p>Below the frame.</p><iframe src="${OTHER}/frame-inner" width="500" height="120" title="From elsewhere"></iframe>`));
  }
  if (path === "/frame-inner") {
    return send(res, 200, page("Inner", `<p>Inside the frame.</p><button type="button" id="b">Press in the frame</button><span id="o"></span><script>document.getElementById('b').addEventListener('click', function () { document.getElementById('o').textContent = ' Pressed in the frame.'; });</script>`));
  }
  if (path === "/covered") {
    return send(
      res,
      200,
      page(
        "Covered",
        `<h1>Covered</h1><button type="button" id="buy">Order now</button><p id="out">Nothing ordered.</p>
<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.6);color:#fff;padding:40px">We use cookies. <button type="button" id="ok">Accept cookies</button></div>
<script>
document.getElementById('ok').addEventListener('click', function () { document.getElementById('banner').remove(); });
document.getElementById('buy').addEventListener('click', function () { document.getElementById('out').textContent = 'Ordered.'; });
</script>`,
      ),
    );
  }
  if (path === "/new-tab") return send(res, 200, page("New tab", `<h1>Opens elsewhere</h1><a href="/popup" target="_blank">Open the receipt</a>`));
  if (path === "/popup") return send(res, 200, page("Receipt", `<h1>Receipt</h1><p>Receipt number 4711.</p>`));

  // ─── Signing in ─────────────────────────────────────────────────────────
  const refuse = (to) => {
    state.refused++;
    return redirect(res, to);
  };
  if (path === "/login" && req.method === "GET") {
    if (user) return redirect(res, "/account");
    return send(res, 200, page("Sign in", loginForm({ action: "/login", error: url.searchParams.has("error") ? "Wrong user name or password." : "" })));
  }
  if (path === "/login" && req.method === "POST") {
    const form = await formOf(req);
    if (ACCOUNTS[form.username] !== form.password) return refuse("/login?error=1");
    return redirect(res, "/account", signIn(res, form.username, "/login", form.remember === "1"));
  }
  if (path === "/logout") {
    sessions.delete(cookies.sid ?? "");
    return redirect(res, "/login", { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }
  if (path === "/account" && req.method === "GET") {
    if (!user) return redirect(res, "/login");
    const mine = state.notes.filter((n) => n.user === user);
    return send(
      res,
      200,
      page(
        "Your account",
        `<nav><a href="/">Home</a><a href="/logout">Sign out</a></nav><h1>Your account</h1><p>Signed in as ${esc(user)}.</p>
<h2>Notes</h2>${mine.length ? `<ul>${mine.map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>` : "<p>No notes yet.</p>"}
<form method="post" action="/account/note"><label>New note <textarea name="text" rows="2" cols="40"></textarea></label><button type="submit">Add note</button></form>`,
      ),
    );
  }
  if (path === "/account/note" && req.method === "POST") {
    if (!user) return redirect(res, "/login");
    const form = await formOf(req);
    state.notes.push({ user, text: String(form.text ?? "") });
    return redirect(res, "/account");
  }

  // The name first, the password on the next page.
  if (path === "/two-step" && req.method === "GET") {
    return send(res, 200, page("Sign in", `<h1>Sign in</h1><form method="post" action="/two-step"><label>E-mail or user name <input name="identifier" type="text" autocomplete="username"></label><button type="submit">Next</button></form>`));
  }
  if (path === "/two-step" && req.method === "POST") {
    const form = await formOf(req);
    return redirect(res, `/two-step/password?u=${encodeURIComponent(String(form.identifier ?? "").replace(/@.*/, ""))}`);
  }
  if (path === "/two-step/password" && req.method === "GET") {
    const name = url.searchParams.get("u") ?? "";
    return send(res, 200, page("Sign in", `<h1>Welcome, ${esc(name)}</h1><form method="post" action="/two-step/password"><input type="hidden" name="username" value="${esc(name)}"><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`));
  }
  if (path === "/two-step/password" && req.method === "POST") {
    const form = await formOf(req);
    if (ACCOUNTS[form.username] !== form.password) return refuse("/two-step");
    return redirect(res, "/account", signIn(res, form.username, "/two-step", false));
  }

  // The form with a CAPTCHA that has to be ticked before it is sent.
  if (path === "/captcha-login" && req.method === "GET") {
    if (user) return redirect(res, "/account");
    const key = newCheck("captcha");
    return send(
      res,
      200,
      page(
        "Sign in",
        loginForm({
          action: "/captcha-login",
          error: url.searchParams.has("error") ? "Tick the box first, and check the password." : "",
          extra: `<input type="hidden" name="k" value="${key}"><div class="g-recaptcha" data-sitekey="mock">${captchaFrame(key)}</div>`,
          submit: FIXED_SUBMIT,
        }),
      ),
    );
  }
  if (path === "/captcha-login" && req.method === "POST") {
    const form = await formOf(req);
    if (!checks.get(form.k)?.passed || ACCOUNTS[form.username] !== form.password) return refuse("/captcha-login?error=1");
    return redirect(res, "/account", signIn(res, form.username, "/captcha-login", true));
  }

  // After the password, a code that was sent to the person.
  if (path === "/code-login" && req.method === "GET") {
    if (user && session.code) return redirect(res, "/account");
    return send(res, 200, page("Sign in", loginForm({ action: "/code-login", error: url.searchParams.has("error") ? "Wrong user name or password." : "" })));
  }
  if (path === "/code-login" && req.method === "POST") {
    const form = await formOf(req);
    if (ACCOUNTS[form.username] !== form.password) return refuse("/code-login?error=1");
    const sid = randomBytes(12).toString("hex");
    sessions.set(sid, { user: null, pending: form.username, code: false });
    return redirect(res, "/code-login/code", { "set-cookie": `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
  }
  if (path === "/code-login/code" && req.method === "GET") {
    return send(res, 200, page("Enter the code", `<h1>Enter the code</h1><p>We sent a code to your phone.</p>${url.searchParams.has("error") ? '<p class="error">That is not the code.</p>' : ""}<form method="post" action="/code-login/code"><label>Verification code <input name="otp" autocomplete="one-time-code" inputmode="numeric" autofocus></label><button type="submit">Verify</button></form>`));
  }
  if (path === "/code-login/code" && req.method === "POST") {
    const form = await formOf(req);
    const waiting = sessions.get(cookies.sid ?? "");
    if (!waiting?.pending || String(form.otp ?? "").trim() !== CODE) return redirect(res, "/code-login/code?error=1");
    waiting.user = waiting.pending;
    waiting.code = true;
    state.signIns.push({ user: waiting.user, from: "/code-login" });
    state.passed.push("code");
    return redirect(res, "/account");
  }

  // A page that is nothing but a check.
  if (path === "/checkpoint") {
    if (cookies.cleared === "1") return redirect(res, "/protected");
    const key = newCheck("check");
    return send(
      res,
      200,
      page(
        "Just a moment...",
        `<div id="challenge-form"><h1>Verifying you are human</h1>${captchaFrame(key, "turnstile")}</div>
<script>setInterval(function () { fetch('/checkpoint/status?k=${key}').then(function (r) { return r.json(); }).then(function (s) { if (s.passed) { document.cookie = 'cleared=1; path=/; max-age=86400'; location.href = '/protected'; } }); }, 400);</script>`,
      ),
    );
  }
  if (path === "/checkpoint/status") return send(res, 200, { passed: Boolean(checks.get(url.searchParams.get("k") ?? "")?.passed) });
  if (path === "/protected") {
    if (cookies.cleared !== "1") return redirect(res, "/checkpoint");
    return send(res, 200, page("Behind the check", `<h1>Behind the check</h1><p>The price list: Kopi Luwak, Rp 900.000.</p>`));
  }

  // A site that is careless with a password.
  const SHOW = `<button type="button" id="show">Show password</button>
<script>document.getElementById('show').addEventListener('click', function () { var f = document.getElementById('pw'); f.type = f.type === 'password' ? 'text' : 'password'; });</script>`;
  if (path === "/echo-login" && req.method === "GET") {
    return send(res, 200, page("Sign in", `${loginForm({ action: "/echo-login", name: "Careless sign-in" })}${SHOW}`));
  }
  if (path === "/echo-login" && req.method === "POST") {
    // It says the password back, leaves it in the field, keeps a copy in another one, and has a button that shows it.
    const form = await formOf(req);
    state.refused++;
    return send(
      res,
      200,
      page(
        "Sign in",
        `<p class="error">The password "${esc(form.password)}" is not right for ${esc(form.username)}.</p>${loginForm({ action: "/echo-login", name: "Careless sign-in", typed: form.password })}
<input id="kept" name="kept" value="${esc(form.password)}" aria-label="What you typed">${SHOW}`,
      ),
    );
  }

  return send(res, 404, page("Not found", "<h1>Not found</h1><p>There is no such page here.</p>"));
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
server.listen(port, HOST, () => console.log(`mock site: http://${HOST}:${port} (and ${OTHER} as another site)`));
