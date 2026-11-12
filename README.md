# Xiero Nexus AI

**One Command. Infinite Intelligence.**

A configurable, multi-provider AI control plane. Connect AI providers, manage
their credentials and models from a dashboard, and talk to any model through a
single internal gateway — with security, usage tracking, and auditing built in.

[![Build and release](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml/badge.svg)](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml)

> **Status: v1.0.0 through v1.3.0 are implemented; v1.4.0 (creative/media) is not built.**
> Three honest caveats: the **remote Git** push (GitHub API) is wired and
> error-handled but has **not been tested against a live repository**; the
> **workflow builder** is step-based (a reusable ordered plan), not a
> drag-and-drop canvas; and of the provider adapters only `openai-compatible`
> and `anthropic` work (the others are stubs), with the **Anthropic** adapter
> tested against a local mock of the API, **not against the live service**.
> See [Roadmap](#roadmap) and [Provider adapters](#provider-adapters).
> Code is **never executed on the app host**: execution needs a separately
> deployed sandbox runner and is off otherwise.
> Nothing in this README describes a feature as working unless it actually is.

Designed by Xiero.

---

## Download and run

Every version is published on the
[Releases](https://github.com/xieryzen/xiero-nexus-ai/releases) page as a
ready-to-run bundle: stable releases, `rc` / `beta` / `alpha` pre-releases, and
a `dev-build` of the newest commit. A bundle needs only Node.js 20 or 22 on
Linux x64. There is no `npm install` and no build step:

```bash
curl -fLO https://github.com/xieryzen/xiero-nexus-ai/releases/latest/download/xiero-nexus-ai-linux-x64-node22.zip
unzip -q xiero-nexus-ai-linux-x64-node22.zip
cd xiero-nexus-ai
cp .env.example .env
sed -i "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")|" .env
node start.js
```

Open the site and create the first account; it becomes the administrator. If
you will open it over plain `http://` rather than HTTPS, add
`COOKIE_SECURE=false` to `.env` first (see [Security model](#security-model)).

[RELEASING.md](RELEASING.md) covers the channels, downloading a specific
version, Pterodactyl, upgrading, rolling back, and publishing a new version.

## What's implemented (v1.0.0)

- **Authentication** — username/email/password registration & login, scrypt
  password hashing, DB-backed `HttpOnly` session cookies with rotation, logout,
  and session invalidation on security changes.
- **Per-user two-factor auth (TOTP)** — optional per account, QR enrolment,
  encrypted secret at rest, single-use recovery codes, login challenge, disable
  flow — all enforced server-side.
- **Roles (RBAC)** — `admin` / `user`, enforced on every protected endpoint.
  The first account on a fresh instance becomes admin.
- **Provider management** — CRUD provider connections, Base URL + conditional
  auth config, API keys **encrypted at rest** (AES-256-GCM) and never returned
  to the browser (only a masked `••••last4`), rotate/disable, server-side
  **Test Connection** with sanitized errors.
- **SSRF defense** — Base URLs validated against loopback, private, link-local
  and cloud-metadata ranges (with DNS resolution); redirects refused; optional
  explicit allowlist for local model endpoints.
- **Model catalog** — discover models via the provider API or register manually,
  capability registry, enable/disable, per-model **Test Model**, price metadata.
- **Model gateway + OpenAI-compatible adapter** — one internal interface;
  streaming and non-streaming chat; the gateway is **provider-neutral** (it
  forwards each provider's own behavior and policies unchanged — it neither adds
  its own content filter nor attempts to remove a provider's safety systems).
- **Chat** — multi-model chat UI with live token streaming and an optional
  per-conversation system prompt.
- **Usage & cost** — per-request token logging; cost shown as an **estimate**
  derived from your model price metadata (never presented as authoritative
  billing).
- **Audit log** — administrative/security events recorded without secrets.

## AI Workforce (v1.1.0)

- **Agents** — configurable specialists (name, role, system instructions,
  primary + fallback model, temperature), managed from the dashboard.
- **Teams** — group agents into a workforce you can assign to a project.
- **AI Manager + orchestration** — describe a goal; the Manager decomposes it
  into tasks (JSON plan), assigns each to an agent, and executes them in
  dependency order through the gateway, with a per-agent **primary→fallback**
  model, bounded execution (max tasks, token budget, bounded attempts),
  cooperative **cancellation**, and a final synthesized deliverable.
- **Task states & evidence** — every task tracks status
  (`queued`/`running`/`succeeded`/`failed`/`blocked`/`cancelled`), its artifact,
  attempts, and tokens; each attempt is logged as an `agent_run`. Progress
  **streams live** to the project view over SSE.
- **Scope** — agents produce written artifacts. Running code against them is a
  separate, sandboxed step (see Development Execution below).

## Development Execution (v1.2.0)

- **Workspaces** — each project has a workspace of text files. Agents can write
  a task's deliverable to a file (the Manager sets `outputFile` in the plan).
- **File management** — view/edit/create/delete files through the dashboard;
  paths are validated (no absolute paths, no `..` traversal, safe characters).
- **Sandboxed execution** — run a build/test command against the workspace. Code
  runs **only** in an external isolated runner (see [`sandbox-runner/`](sandbox-runner)),
  never on the app host. If `SANDBOX_URL` is unset, execution is disabled and
  returns a clear message.
- **Guardrails** — command **allowlist** (first token must be an allowed
  binary), shell-metacharacter rejection (no chaining/piping/substitution), and
  per-run timeout + output caps. The reference runner is meant to run in a
  container with `--network none` and CPU/memory/PID limits.
- **Version snapshots** — commit the current workspace files with a message and
  restore any snapshot (lightweight local history; not remote Git).
- **QA / Security review** — after a run, a reviewer agent (a QA/Security-role
  agent if present, else the Manager) assesses each deliverable against its
  acceptance criteria, grounded in the latest sandbox execution output when
  available. Advisory — it annotates the project, it does not block.
- **Hard QA gate** — a project can require a passing reviewer verdict; the
  reviewer ends with `VERDICT: pass|concerns|fail`, and a non-pass verdict keeps
  the project in `review` instead of `succeeded`.
- **Remote Git** — configure a per-project GitHub remote (owner/repo/branch +
  encrypted PAT, host-allowlisted) and push the workspace as one atomic commit
  via the GitHub Git Data API (blobs → tree → commit → ref) — no shell, no git
  binary. *Not tested against a live repo here; the failure path (bad token /
  missing branch) is handled and returns a safe error.*

## Advanced Orchestration (v1.3.0)

- **Parallel execution** — independent tasks (no dependency between them) run
  concurrently in dependency-ordered waves, capped by a per-project
  `maxParallel`.
- **Budget & limits** — per-project token budget, max tasks, and max
  parallelism; a run stops and cancels remaining tasks when the token budget is
  exceeded. Budget usage streams live to the project view.
- **Approval policy** — a project can require admin approval before each run; an
  unapproved run stops at `needs_approval` until an admin approves (approval is
  consumed per run).
- **Observability** — an admin dashboard of per-agent run metrics (runs, success
  vs error, average latency, tokens) plus recent agent runs, from `agent_runs`.
- **Automatic model routing** — an agent can route in `auto` mode: the router
  picks the cheapest enabled model (optionally constrained to a capability),
  ahead of the agent's explicit primary/fallback.
- **Workflow builder** — reusable, step-based workflows (ordered tasks with
  roles, dependencies, and output files). A project can run a workflow instead
  of AI-Manager planning, giving a deterministic plan. (Step-based, not a visual
  canvas.)
- **RBAC & audit** — present since v1.0.0.

## Provider adapters

A provider's adapter is the protocol the gateway speaks to it.

| Adapter | Status |
|---|---|
| `openai-compatible` | works |
| `anthropic` | works against a local mock of Anthropic's API; **not yet run against the live API** |
| `gemini`, `custom-http` | not implemented — the provider can be saved but not tested or used |

### Anthropic

Add a provider with the **Anthropic** adapter, Base URL
`https://api.anthropic.com/v1` and an Anthropic API key. **Test** it,
**Discover** its models, import the ones you want, and they can be used in
chat, by agents and in projects.

- **Auth type** — *Bearer token* (the default) sends the key as
  `Authorization: Bearer`. If the API, or a proxy in front of it, does not
  accept that, choose *Custom header* with the header name `x-api-key`.
- **API version** — sent as the `anthropic-version` header. Blank means
  `2026-10-21`.
- **Text chat only.** Tools, images and the model's thinking output are not
  passed through. Thinking itself is left at each model's default.
- **Temperature is not sent**, because API version `2026-10-21` rejects it.
  The chat and agent temperature settings have no effect on Anthropic models.
- **Reply length** — every request allows up to 16,000 output tokens
  (`max_tokens`), thinking included. The cap is fixed in the code
  (`ANTHROPIC_MAX_TOKENS`). A reply that reaches it is cut off, and the chat
  view does not say so.
- **Refusals** — when a model declines a request, the reason Anthropic gives
  is shown as an error instead of an empty reply, and a project task moves on
  to the agent's next model.
- **Discovery** imports model ids. Context window and prices are entered by
  hand, as for any provider.
- **Timeout** — as with any provider, Test Model and project runs wait for
  the complete reply, which must arrive within the provider's Timeout (60 s by
  default). Raise it, up to 300,000 ms, if long replies time out. A streamed
  chat reply only has to start within it.

## Roadmap

| Version | Milestone | Status |
|--------|-----------|--------|
| 1.0.0 | Multi-Provider Foundation | ✅ implemented |
| 1.1.0 | AI Workforce (AI Manager, agents, teams, tasks, delegation) | ✅ implemented |
| 1.2.0 | Development Execution (sandbox, snapshots, QA review, hard QA gate, remote Git) | ✅ implemented (remote Git untested-live) |
| 1.3.0 | Advanced Orchestration (parallel, budgets, approval, observability, auto-routing, workflows) | ✅ implemented (step-based workflow builder) |
| 1.4.0 | Creative Workflows (image/video/Reels) | ⏳ planned |

The Gemini and custom HTTP provider adapters are stubbed in the UI but not
implemented. A provider on an unimplemented adapter can be saved but not tested
or used. See [Provider adapters](#provider-adapters).

---

## Tech stack

- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- **Drizzle ORM** + **better-sqlite3** (SQLite — single file, no external DB)
- **otplib** (TOTP) + **qrcode**, **zod** (validation)
- Node's built-in `crypto` for AES-256-GCM and scrypt (no native crypto addons)

Single process, SQLite, zero external services — so it deploys cleanly on a
Pterodactyl server. The data layer is behind Drizzle, so moving to PostgreSQL
later is largely a driver/connection change.

## Develop from source

```bash
npm install
cp .env.example .env
# generate the encryption key and paste it into .env as SECRET_ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm run dev            # http://localhost:3000
```

Production from source (the [release bundles](#download-and-run) are the easier
way to deploy):

```bash
npm run build
npm run start          # honors $PORT (default 3000)
```

Migrations are applied **automatically on first boot**. To run them explicitly
(e.g. in CI): `npm run db:migrate`.

### First run

On first boot, if the users table is empty and `BOOTSTRAP_ADMIN_*` are set, an
admin account is created from those values. **Log in and change the password
immediately.** Alternatively, leave bootstrap unset and the first account you
register through the UI becomes the admin.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SECRET_ENCRYPTION_KEY` | **yes (prod)** | base64 of 32 bytes; encrypts provider keys & TOTP secrets at rest. Keep it out of the DB and out of git, and keep it across upgrades. |
| `COOKIE_SECURE` | no | Session cookies are HTTPS-only in production. Set `false` to allow sign-in over plain HTTP. |
| `APP_URL` | no | Public address. Set it to your `https://` address when an HTTPS proxy in front does not pass `X-Forwarded-Proto`. |
| `PORT` | no | Listen port (default 3000). Release bundles also accept a panel's `SERVER_PORT`. |
| `BIND_HOST` | no | Release bundles only: address to bind (default `0.0.0.0`). |
| `DATABASE_PATH` | no | SQLite file path (default `./data/nexus.db`) |
| `BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD` | no | first-run admin (only used when no users exist) |
| `ALLOW_PRIVATE_PROVIDER_HOSTS` | no | comma list of hosts allowed to bypass the private-range block, for local model endpoints or the sandbox runner (e.g. `127.0.0.1,ollama.local`) |
| `SANDBOX_URL` | no | URL of an isolated sandbox runner. **Unset = execution disabled** (nothing runs on the app host). See `sandbox-runner/`. |
| `SANDBOX_TOKEN` | no | bearer token the app sends to the sandbox runner |
| `SANDBOX_ALLOWED_COMMANDS` | no | comma list overriding the default command allowlist |

In development a missing key falls back to an insecure placeholder, with a
warning, so the app boots. In production the app is unusable without a valid
`SECRET_ENCRYPTION_KEY`: a release bundle stops at start-up with instructions,
and a source install fails every request that needs the database (sign-in
included), with the reason in the server log.

## Deploying on Pterodactyl

Use a release bundle with a Node.js 20 or 22 egg: upload the zip that matches
the egg's Node.js version, unarchive it, create `xiero-nexus-ai/.env`, and set
the startup file to `xiero-nexus-ai/start.js`. The port the panel assigns is
used automatically. The steps are in
[RELEASING.md](RELEASING.md#on-pterodactyl).

## Security model

- Passwords: scrypt (salted, memory-hard), constant-time comparison.
- Secrets at rest: AES-256-GCM with a key kept **outside** the database.
- API keys are never serialized to the client — only `configured` + last 4.
- Sessions: `HttpOnly`, `SameSite=Lax`, and `Secure` (HTTPS-only) in
  production; rotated after login and 2FA, destroyed on logout / 2FA change /
  account disable.
- Plain HTTP: a browser drops HTTPS-only cookies on an `http://` address, so
  sign-in there is turned off with an explanation rather than failing silently.
  `COOKIE_SECURE=false` is the explicit opt-out for deployments without HTTPS;
  passwords and sessions then cross the network unencrypted.
- 2FA enforced server-side; a password-verified session stays *pending* until
  the second factor is satisfied.
- SSRF: scheme + private/metadata-range checks on provider Base URLs; redirects
  refused on outbound calls.
- Rate limiting on login, 2FA, and sensitive account actions.
- Security headers set globally; audit log excludes secrets.

**Known limitations (be honest about these):**

- SSRF validation resolves DNS before the request; a determined DNS-rebinding
  attacker could still bypass it (TOCTOU). Add network-egress policy at the
  infrastructure layer for defense in depth.
- The rate limiter is in-memory (fine for a single process; use a shared store
  if you run multiple instances).
- Costs are **estimates** from your own price metadata, not provider billing.
- Only the `openai-compatible` and `anthropic` adapters are implemented, and
  the Anthropic adapter has not been run against the live API.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | dev server |
| `npm run build` / `npm run start` | production build / serve |
| `npm run db:generate` | regenerate SQL migrations from the schema |
| `npm run db:migrate` | apply migrations explicitly |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | unit tests |
| `npm run build:standalone` + `npm run package` | build a release bundle into `dist/` |
| `npm run package:test` | start that bundle and sign in to it |
| `npm run release:info` | version, tag and channel that a push would publish |
| `npm run version:patch` / `minor` / `major` / `alpha` / `beta` / `rc` | raise the version (see [RELEASING.md](RELEASING.md)) |

## Project structure

```
src/
  app/                     # routes (pages + /api route handlers)
  components/              # UI: shell, auth, providers, models, chat, account, users
  db/                      # Drizzle schema, client (auto-migrate), migrate script
  lib/                     # crypto, secrets, auth, session, ssrf, adapters, gateway, usage, stats…
drizzle/                   # generated SQL migrations
sandbox-runner/            # reference external code-execution runner (Docker)
scripts/                   # release tooling: package, smoke-test, publish, download
.github/workflows/         # CI: check, bundle, publish releases
tests/                     # node:test unit tests
```

## Testing

`npm test` runs unit tests for the security-critical pure functions
(AES-GCM round-trip & tamper rejection, password hashing, recovery codes,
SSRF range detection + allowlist, TOTP verification, the plain-HTTP sign-in
check), the orchestrator plan parser (JSON extraction, validation, dependency
remap, topological order), the execution guardrails (workspace path
validation, command allowlist, shell-metacharacter rejection), the router + QA
verdict parser (cheapest/capability selection, `VERDICT:` parsing), the
Anthropic wire format (headers, request body, response and usage parsing,
model-list paging, the event-stream parser, refusals, stream errors), and the
release tooling (channels, version ordering, release selection, checksums).

On every push, CI runs typecheck, lint and these tests, then builds each
release bundle and starts it: the bundle must refuse to run without its key,
serve pages on a panel-assigned port, sign in (SQLite + migrations), and keep
the session.

The provider/model/gateway/streaming paths **and** the full plan → delegate →
execute → synthesize orchestration loop have been verified end-to-end against a
local OpenAI-compatible mock. The Anthropic adapter was run through the same
paths against a local mock written from Anthropic's API reference (the mock is
not part of this repository); it has not been run against the live API.

---

Designed by Xiero · Xiero Nexus AI
