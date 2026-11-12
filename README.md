# Xiero Nexus AI

**One Command. Infinite Intelligence.**

A configurable, multi-provider AI control plane. Connect AI providers, manage
their credentials and models from a dashboard, and talk to any model through a
single internal gateway — chat, agents, and image and video generation — with
security, usage tracking, and auditing built in.

[![Build and release](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml/badge.svg)](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml)

> **Status: v1.0.0 through v1.4.0 are implemented.**
> Four honest caveats: the **remote Git** push (GitHub API) is wired and
> error-handled but has **not been tested against a live repository**; the
> **workflow builder** is step-based (a reusable ordered plan), not a
> drag-and-drop canvas; of the provider adapters only `openai-compatible`
> and `anthropic` work (the others are stubs), with the **Anthropic** adapter
> tested against a local mock of the API, **not against the live service**; and
> **image and video generation** (v1.4.0) was likewise tested against a local
> mock written from the providers' public documentation, **not against a live
> provider**. A Reel is delivered as separate clips, not as one edited video.
> See [Roadmap](#roadmap), [Provider adapters](#provider-adapters) and
> [Creative Workflows](#creative-workflows-v140).
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

## Creative Workflows (v1.4.0)

- **Image and video generation through the gateway** — a model marked *Image
  generation* or *Video generation* generates media through the same provider
  connections, encrypted keys and SSRF checks as chat. Setup is under
  [Image and video generation](#image-and-video-generation).
- **Creative Studio** — a page to write a prompt, pick a model, an aspect
  ratio, the number of images or the length of a video, and generate. A cost
  estimate is shown before you send, from the price you set on the model.
- **Media library** — everything generated is kept: preview, play, download,
  copy the prompt, reuse the settings, delete. Each user sees their own media;
  an administrator can also see everyone's. Files are stored on the server (see
  `MEDIA_PATH`), so they stay available after the provider's link expires.
- **Videos are jobs** — a video request returns at once and shows as *in
  progress*; the library asks the provider every few seconds and the player
  appears when the file is ready. There is no background worker: a video in
  progress is only checked while a page that shows it is open, or while a
  project run is waiting for it. It can still be picked up up to an hour after
  it was started.
- **Image and video tasks in projects** — a project can have an image model
  and a video model. A task then delivers text, one image or one video: for a
  media task the assigned agent writes the prompt, and the project's model
  generates the file. The AI Manager plans media tasks only when the project
  has the model for them, and a per-project **media limit** (10 by default,
  at most 24) caps how many files one run may generate. A run waits up to 15
  minutes for each video. Cancelling a run stops the waiting, not the
  provider: a video already started stays in the library and finishes there.
  The models and the limit are chosen when a project is created.
- **Media steps in workflows** — a workflow step can deliver an image or a
  video, with its aspect ratio, length and resolution. A project that runs such
  a workflow must have the models it needs; that is checked when the project is
  created and again before a run spends anything.
- **Reel template** — the workflow builder can fill in a short-video plan:
  concept and script → storyboard → one clip per scene (9:16) → cover image →
  caption and hashtags. Choose the number of scenes (up to 8) and the seconds
  per clip (up to 20); every step can be edited afterwards.
- **Usage and cost** — each generation is logged under Usage & Costs as an
  `image` or `video` request. The estimate is images × price per image, or
  seconds × price per second, using the length the provider reports.

**What it does not do:**

- It does not edit video. A Reel run delivers its clips, cover and caption as
  separate files; joining the clips and adding the voice-over, music and
  on-screen text is done in a video editor.
- Text prompts only: no image-to-image, image-to-video, or audio generation.
- Only the `openai-compatible` adapter generates media. A model on an
  `anthropic` provider cannot.
- An agent cannot look at a generated file. Later tasks and the reviewer see
  the prompt it was generated from, not the picture.
- Generated media is not part of a project's workspace files, snapshots or
  Git push.

## Provider adapters

A provider's adapter is the protocol the gateway speaks to it.

| Adapter | Status |
|---|---|
| `openai-compatible` | works for chat; image and video generation work against a local mock of three providers' APIs, **not yet run against a live provider** |
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

### Image and video generation

Media uses a provider on the **OpenAI-compatible** adapter. There is no single
standard for image and video requests the way there is for chat, so each
provider has an **Image / video API** setting that says how its requests are
written:

| Setting | Images | Videos | The finished video |
|---|---|---|---|
| **OpenAI-style** | `POST /images/generations` with `size` | `POST /videos` with `seconds` and `size` | `GET /videos/{id}/content`, with the key |
| **OpenRouter** | `POST /images` with `aspect_ratio` and `resolution`, or `size` | `POST /videos` with `duration`, and the same sizing | the link in `unsigned_urls` |
| **xAI** | `POST /images/generations` with `aspect_ratio` and `resolution` | `POST /videos/generations` with `duration`, `aspect_ratio`, `resolution` | the link in `video.url` |

**Auto**, the default, chooses xAI for a Base URL on `x.ai`, OpenRouter for
one on `openrouter.ai`, and OpenAI-style for everything else. All three check
on a video with `GET /videos/{id}`.

To set it up:

1. **Providers** — add or edit a provider with the OpenAI-compatible adapter,
   and set *Image / video API* if Auto would guess wrong (for example a proxy
   in front of xAI).
2. **Models → Add model** — enter the provider's model id, choose the *Model
   type* (image or video generation), and optionally a price per image or per
   second of video for the cost estimates. Discovery imports model ids without
   a type, so an image or video model found that way needs its type set once
   with **Edit**.
3. **Creative Studio** — generate something. The first success marks the
   model's capability as verified.

Good to know:

- **Which models work is up to the provider.** The settings above describe
  what this app sends; check the provider's documentation for the model ids it
  offers and the sizes, lengths and resolutions each one accepts. A value the
  provider rejects comes back as its error message.
- **Aspect ratio with OpenAI-style providers** — the ratio is sent as one of
  three sizes (`1024x1024`, `1024x1536`, `1536x1024`) for images, and as exact
  pixels for videos (9:16 at 720p is `720x1280`). Use *Exact size* under the
  advanced options for anything else.
- **Extra parameters** — the advanced options take a JSON object that is added
  to the request as it is, for provider-specific settings such as a seed or a
  quality tier. `model`, `prompt` and `stream` cannot be set this way.
- **An image or video model is not a chat model.** A model marked for image or
  video generation and not for *Text* is left out of chat, agents, the AI
  Manager and automatic routing, and has **Try** (a link to Creative Studio)
  instead of **Test**. Tick *Text* as well for a model that does both.
- **Limits** — a prompt of up to 4,000 characters, up to 4 images per request,
  up to 60 seconds of video per request, files of up to 25 MB (image) and
  200 MB (video). Per user: 20 image requests and 10 video requests a minute,
  and 12 videos in progress at once.
- **Timeout** — an image request waits up to three minutes for the answer, or
  for the provider's Timeout when that is longer. A video request returns as
  soon as the provider accepts the job, which is then checked on until it
  finishes or one hour has passed.
- **File types** — PNG, JPEG, GIF and WebP images, and MP4, MOV and WebM
  videos are kept. Anything else a provider returns is refused.

## Roadmap

| Version | Milestone | Status |
|--------|-----------|--------|
| 1.0.0 | Multi-Provider Foundation | ✅ implemented |
| 1.1.0 | AI Workforce (AI Manager, agents, teams, tasks, delegation) | ✅ implemented |
| 1.2.0 | Development Execution (sandbox, snapshots, QA review, hard QA gate, remote Git) | ✅ implemented (remote Git untested-live) |
| 1.3.0 | Advanced Orchestration (parallel, budgets, approval, observability, auto-routing, workflows) | ✅ implemented (step-based workflow builder) |
| 1.4.0 | Creative Workflows (image and video generation, Creative Studio, media tasks, Reel template) | ✅ implemented (tested against a mock provider, not a live one; clips are not joined) |

The Gemini and custom HTTP provider adapters are stubbed in the UI but not
implemented. A provider on an unimplemented adapter can be saved but not tested
or used. See [Provider adapters](#provider-adapters).

---

## Tech stack

- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- **Drizzle ORM** + **better-sqlite3** (SQLite — single file, no external DB)
- **otplib** (TOTP) + **qrcode**, **zod** (validation)
- Node's built-in `crypto` for AES-256-GCM and scrypt (no native crypto addons)

Single process, SQLite and a folder of generated media files, zero external
services — so it deploys cleanly on a Pterodactyl server. The data layer is behind Drizzle, so moving to PostgreSQL
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
| `MEDIA_PATH` | no | Folder for generated images and videos (default: a `media` folder next to the database file, so `./data/media`). Back it up together with the database. |
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
- Rate limiting on login, 2FA, sensitive account actions, and image and video
  requests.
- Generated media: a file a provider links to is downloaded by the server with
  the same SSRF checks as any provider call, applied again to every redirect
  (at most three). The API key is sent only to the provider's own address,
  never to another host a link points at. A file is kept only if its own bytes
  say it is one of a few image or video types, so an HTML or SVG answer is
  never stored or served, and downloads are capped in size and time. Files are
  served only to their owner or an administrator.
- Security headers set globally; audit log excludes secrets.

**Known limitations (be honest about these):**

- SSRF validation resolves DNS before the request; a determined DNS-rebinding
  attacker could still bypass it (TOCTOU). Add network-egress policy at the
  infrastructure layer for defense in depth.
- The rate limiter is in-memory (fine for a single process; use a shared store
  if you run multiple instances). The same goes for run cancellation and the
  count of videos in progress.
- Generated files are stored unencrypted in the media folder, and are not
  removed when their owner's account is deleted; an administrator can delete
  them from Creative Studio.
- Costs are **estimates** from your own price metadata, not provider billing.
- Only the `openai-compatible` and `anthropic` adapters are implemented.
  Neither the Anthropic adapter nor image and video generation has been run
  against a live provider.

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
| `npm run test:e2e` | end-to-end checks of image and video generation against a mock provider (needs `npm run build` first) |
| `npm run build:standalone` + `npm run package` | build a release bundle into `dist/` |
| `npm run package:test` | start that bundle and sign in to it |
| `npm run release:info` | version, tag and channel that a push would publish |
| `npm run version:patch` / `minor` / `major` / `alpha` / `beta` / `rc` | raise the version (see [RELEASING.md](RELEASING.md)) |

## Project structure

```
src/
  app/                     # routes (pages + /api route handlers)
  components/              # UI: shell, auth, providers, models, chat, studio, media, projects, workflows, account, users
  db/                      # Drizzle schema, client (auto-migrate), migrate script
  lib/                     # crypto, secrets, auth, session, ssrf, adapters, gateway, media, creative, orchestrator, usage, stats…
drizzle/                   # generated SQL migrations
sandbox-runner/            # reference external code-execution runner (Docker)
scripts/                   # release tooling: package, smoke-test, publish, download
scripts/e2e/               # mock provider and end-to-end checks for image and video generation
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
model-list paging, the event-stream parser, refusals, stream errors), image
and video generation (the three request styles, response and job-status
parsing, file-type detection from a file's bytes, byte ranges, cost, download
size and time limits, media tasks in a plan, the Reel template), and the
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

Image and video generation has its own end-to-end run, which is part of this
repository:

```bash
npm run build
npm run test:e2e
```

It starts a mock provider ([`scripts/e2e/mock-provider.mjs`](scripts/e2e/mock-provider.mjs))
and the built app on a throwaway database in the system's temporary folder,
and makes about 270 checks through the app's HTTP API: the three request
styles for images and videos, files returned inline, as links and behind
redirects, the API key never leaving the provider's address, refused file
types and oversized downloads, the life of a video job, access to other
users' media, rate limits, and project runs with media tasks, including a Reel
workflow. No real provider is called and nothing is billed. It is not part of
CI. The mock is written from the providers' public documentation, so passing
it shows that the app is consistent with that reading of the documentation,
**not** that a live provider accepts the requests.

---

Designed by Xiero · Xiero Nexus AI
