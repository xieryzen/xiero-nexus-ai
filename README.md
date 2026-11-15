# Xiero Nexus AI

**One Command. Infinite Intelligence.**

A configurable, multi-provider AI control plane. Connect AI providers, manage
their credentials and models from a dashboard, and talk to any model through a
single internal gateway — chat, agents with tools, a knowledge base, and
image, video and speech generation — with security, usage tracking, and
auditing built in. Other programs can use the same models through an API in
OpenAI's format.

[![Build and release](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml/badge.svg)](https://github.com/xieryzen/xiero-nexus-ai/actions/workflows/release.yml)

> **Status: v1.0.0 through v1.5.0 are implemented.**
> The honest caveats: all four provider adapters (`openai-compatible`,
> `anthropic`, `gemini`, `custom-http`) and everything built on them — chat,
> tools, embeddings, and image, video and speech generation — were tested
> against **local mocks** written from the providers' public documentation,
> **not against a live provider**; the **remote Git** push (GitHub API) has
> likewise **not been tested against a live repository**; the
> [scripts for a Pterodactyl host](scripts/host) are tested against a
> stand-in for Wings and were used on **one real node**, where going back
> after a failed upgrade has not happened yet; and the **workflow builder** is
> step-based (a reusable ordered plan), not a drag-and-drop canvas. Joining
> clips into one video is done by ffmpeg on the server, and was tested with a
> real ffmpeg on generated test clips.
> See [Roadmap](#roadmap), [Provider adapters](#provider-adapters),
> [Creative Workflows](#creative-workflows-v140) and
> [Automation, tools and knowledge](#automation-tools-and-knowledge-v150).
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
  separate, sandboxed step (see Development Execution below). Since v1.5.0 an
  agent can also be given tools: files, commands in the sandbox, the web.

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
  progress*; the server asks the provider every few seconds and the player
  appears when the file is ready. Since v1.5.0 this happens in the
  background, whether or not a page that shows the video is open. A video
  that is still not finished after one hour is given up on.
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

- It is not a video editor. Since v1.5.0 clips can be joined into one video
  with voice-overs and subtitles (see
  [Voice-over and joined videos](#voice-over-and-joined-videos)); there are no
  transitions, no music track and no trimming.
- No image-to-image. Since v1.5.0 a video can start from an image, and
  speech can be generated.
- Videos are generated only through the `openai-compatible` adapter; images
  and speech also through `gemini`. A model on an `anthropic` or
  `custom-http` provider generates no media.
- An agent cannot look at a generated file. Later tasks and the reviewer see
  the prompt it was generated from, not the picture.
- Generated media is not part of a project's workspace files, snapshots or
  Git push.

## Automation, tools and knowledge (v1.5.0)

- **Runs in the background** — a project run is carried out by a worker
  inside the server, not by the page that started it. Close the page and it
  goes on; open the project from any browser and the page shows the state so
  far and follows the rest. If the server stops in the middle, the run is
  picked up again when it is back: finished tasks are kept, unfinished ones
  are done again, and a video that was already ordered is not ordered a
  second time. A run is given up on when the server has stopped four times
  during it. Three runs work at the same time (`RUN_CONCURRENCY`, 1 to 10);
  further ones wait their turn. There is no second process and no queue
  service to set up: the worker starts with the app.
- **Run history, instructions and memory** — every run is kept in the
  project's history with its state, what started it (a person, a schedule,
  the API) and what it delivered. A run can be given an instruction of its
  own, up to 4,000 characters. With a project's **Memory** switched on, a
  run is told what the earlier runs delivered, so that a daily run does not
  repeat yesterday's.
- **Schedules** — a project can run by itself: a cron expression (five
  fields; names such as `MON` and `JAN` are understood) read in a time zone
  of your choice, with an instruction for those runs. The form says the
  schedule in words and lists the next times. Up to five schedules per
  project. A time that passed while the server was down is still run if the
  server is back within 15 minutes, and skipped after that. A scheduled run
  of a project that requires approval waits for the approval, and its owner
  is told.
- **Notifications** — the bell in the dashboard says when a run finished,
  needs a look, failed or waits for approval, when a video or a joined video
  is ready or failed, and when a document could not be embedded. The newest
  200 are kept per user. Under **Settings → Notification webhook** each user
  can also have them sent to an address of their own; see
  [Webhooks](#webhooks).
- **Tools for agents** — an agent can be allowed to use tools, chosen one by
  one on the agent's form:
  - *Project workspace*: list, read, write, edit and delete the files of the
    project's workspace (the files the Workspace page shows; at most 400).
  - *Code execution*: run a command, such as tests or a build, on those files
    in the sandbox runner. Needs `SANDBOX_URL`; the command allowlist applies.
  - *Web and APIs*: read a web page as text, call an HTTP API, and search the
    web. Search needs `SEARCH_PROVIDER` (Brave, Tavily, or your own SearXNG).

  An agent with tools works in steps: the model asks for a tool, gets the
  result and goes on, until it has its deliverable or reaches the agent's
  **Steps per task** (12 by default, at most 40). Every call is shown under
  its task, with what was asked and what came back. Tools need a model that
  supports tool calling, on the OpenAI-compatible, Anthropic or Gemini
  adapter; an agent whose model cannot call tools works as before, without
  them.
- **Memory for agents** — an agent with **Memory** on can keep short notes
  (up to 1,000 characters each) and gets the fitting ones back in later
  tasks. A note belongs to the agent and to the user whose project it was
  written in: what an agent learned in one person's project is never shown
  to it in another person's. The notes can be read and deleted on the Agents
  page, where an administrator can also add notes that apply to everyone.
  300 notes are kept per agent and user.
- **Knowledge base** — the **Knowledge** page holds collections of documents
  that agents and the chat can look things up in. See
  [Knowledge base](#knowledge-base).
- **Voice-over and joined videos** — Creative Studio has a **Voice** tab
  (text to speech) and a **Join clips** tab, and projects and workflows have
  the matching task kinds. See
  [Voice-over and joined videos](#voice-over-and-joined-videos).
- **More providers** — the Google Gemini adapter and a custom HTTP adapter;
  tool calling on the OpenAI-compatible and Anthropic adapters. See
  [Provider adapters](#provider-adapters).
- **An API for other programs** — see [API](#api).
- **Stopping and health** — the server stops within a few seconds when it is
  told to (a panel's Stop button, `docker stop`), also while pages are
  connected to it, and hands the runs it was working on to the next start.
  `GET /api/health` answers `{"status":"ok"}` without signing in when the
  server and its database work, for uptime checks.

**What it does not do:**

- Agents get text. An agent cannot look at an image, a video or a PDF's
  pictures, and chat is text only.
- Tools were tested against a mock model that asks for them in the three
  providers' formats, **not against a live model**. How well a real model
  uses them is up to the model.
- The background worker is part of the server process. If the server is not
  running, nothing runs: a schedule does not wake a stopped server.
- One server process does the work. A second process on the same database
  must run with `NEXUS_WORKER=0`.

### Knowledge base

A collection holds documents on one subject. Add documents by pasting text,
uploading a file, or giving the address of a web page. Text, Markdown, CSV,
JSON, HTML, PDF and .docx files are read, up to 15 MB and two million
characters of text each; a collection holds up to 500 documents.

- **Search by words works at once**, without any model: every document is cut
  into passages that are indexed in the database (SQLite FTS5).
- **Search by meaning** is added when the collection has an **embedding
  model**: the passages are embedded in the background, and a search then
  combines both rankings. Embedding costs tokens at the provider; the usage
  is listed under Usage & Costs.
- **In chat**, tick collections under the **Knowledge** button: the passages
  that fit the question are given to the model, and the answer lists its
  sources.
- **For agents**, tick collections on the agent's form. The agent can then
  search them while it works. Only collections set to **Shared** can be given
  to an agent, because agents are shared by everyone on the server.
- A collection is **private** to whoever made it until it is set to Shared;
  shared collections can be read by every user and changed by their owner
  and by administrators.
- A PDF that is a scan has no text, and is refused with that explanation:
  pictures are not read. Old Word files (`.doc`) are not supported.

### Voice-over and joined videos

- **Voice** — choose a speech model, write the text (up to 4,096
  characters), and optionally a voice and a speed. The voice names are the
  provider's. Works with speech models on the OpenAI-compatible adapter
  (`POST /audio/speech`, asking for MP3) and on the Gemini adapter (whose
  bare samples are stored as WAV). A model can have a price per million
  characters for the cost estimate.
- **Start a video from an image** — in the Video tab, choose an image of the
  library or upload one (PNG, JPEG, GIF or WebP). It is sent to the provider
  with the prompt. Whether a model accepts a starting image is up to the
  provider.
- **Join clips** — choose clips and still images of the library in the order
  they should play, and optionally voice-overs. The result is one MP4 (H.264
  and AAC, 30 frames a second) in the library:
  - every clip is scaled into the same frame, either fitted with bars or
    cropped to fill it;
  - clips follow each other without a transition;
  - with as many voice-overs as clips, each voice-over starts with its clip,
    and a clip that is shorter than its voice-over holds its last frame until
    the voice-over ends; with any other number, the voice-overs follow each
    other from the start;
  - the words of the voice-overs can be burned in as subtitles;
  - a still image is shown for four seconds, or as long as its voice-over;
  - up to 40 clips and 15 minutes.
- **Joining needs ffmpeg on the server.** The app uses the `ffmpeg` program
  on the PATH, or the one `FFMPEG_PATH` names: version 4.2 or newer, with
  libx264 and, for subtitles, libass, which the ffmpeg packages of Debian
  and Ubuntu have. Without it everything else works; the Join tab and the
  status page say what is missing. Joining is done one video at a time, in
  the background, and can take as long as the video is. On Pterodactyl, see
  [scripts/host](scripts/host#upgrading-pterodactyl-upgradesh).
- **Subtitles** are drawn with the font that comes with the app (Noto Sans
  Bold: Latin, Greek, Cyrillic and Devanagari). For another script, set
  `SUBTITLE_FONT_FILE`.
- **In projects and workflows** — a task can deliver a voice-over (its agent
  writes the words) or a joined video (of the clips and voice-overs of the
  tasks it depends on). A project needs a speech model for voice-overs. The
  **Reel template** can add a voice-over per scene and a final cut with
  subtitles.

### Webhooks

Under **Settings → Notification webhook**, give an address. Every
notification is then also sent there as a JSON `POST`:

```json
{
  "id": "…",
  "event": "run.success",
  "kind": "run",
  "level": "success",
  "title": "Run finished: Daily brief",
  "body": "All 5 tasks succeeded.",
  "url": "https://nexus.example.com/dashboard/projects/…",
  "createdAt": "2026-11-15T08:00:12.000Z",
  "text": "Run finished: Daily brief\nAll 5 tasks succeeded.\nhttps://…",
  "content": "Run finished: Daily brief\nAll 5 tasks succeeded.\nhttps://…"
}
```

- `kind` is `run`, `media`, `schedule`, `knowledge` or `system`; `level` is
  `info`, `success`, `warning` or `error`; `event` is the two joined by a dot,
  and is also sent as the `x-nexus-event` header.
- **Signature** — the header `x-nexus-signature: t=<unix time>,v1=<hex>`
  carries the HMAC-SHA256, with the webhook's secret, of
  `<unix time>.<request body>`. The secret is shown once, when the webhook is
  saved, and can be replaced.
- **Retries** — a delivery that fails, or is answered with an error, is tried
  again after 1, 5, 30 and 120 minutes, and then given up on. **Send a test**
  sends one now and says whether it arrived.
- `text` and `content` carry the same message as one text, because those are
  the fields the incoming webhooks of Slack and Discord read. That was **not
  tried against either service**.
- `url` is built from `APP_URL`. An address on a private network is refused
  unless its host is listed in `ALLOW_PRIVATE_WEBHOOK_HOSTS`.

## Provider adapters

A provider's adapter is the protocol the gateway speaks to it.

| Adapter | Chat | Tools | Embeddings | Images | Speech | Videos |
|---|---|---|---|---|---|---|
| `openai-compatible` | ✓ streaming | ✓ | ✓ | ✓ | ✓ | ✓ |
| `anthropic` | ✓ streaming | ✓ | | | | |
| `gemini` | ✓ streaming | ✓ | ✓ | ✓ | ✓ | |
| `custom-http` | ✓ | | | | | |

All four were run against local mocks written from the providers' public
documentation, and **none against the live service**. A feature that is not
ticked is not offered for models of that provider.

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
- **Text and tools.** Since v1.5.0 tool calls are passed through, so agents
  on Anthropic models can use tools. Images and the model's thinking output
  are not passed through. Thinking itself is left at each model's default.
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

### Google Gemini

Add a provider with the **Google Gemini** adapter, Base URL
`https://generativelanguage.googleapis.com/v1beta` and a Gemini API key.
**Test** it, **Discover** its models and import the ones you want.

- **Chat** with streaming, a system prompt, temperature and tool calling.
  Text only: images are not passed to the model.
- **Embeddings**, **image generation** and **speech** for the models that
  offer them. Speech arrives as raw audio and is stored as a WAV file.
- **No video generation** through this adapter.
- **Discovery** sets a model's type from what the API says the model can do
  and from its name. Check the type of image and speech models after
  importing them.

### Custom HTTP

For a JSON API that follows none of the other protocols. The provider's
**Configuration** says how a chat request is written and where the answer is
in the response:

```json
{
  "chat": {
    "path": "/api/chat",
    "body": { "model": "{{model}}", "messages": "{{messages}}", "stream": false },
    "responsePath": "message.content",
    "promptTokensPath": "prompt_eval_count",
    "completionTokensPath": "eval_count"
  },
  "models": { "path": "/api/tags", "listPath": "models", "idPath": "name" }
}
```

- Placeholders in `body`: `{{model}}`, `{{messages}}` (the conversation as
  `[{ "role", "content" }]`, system message first), `{{chat_messages}}` (the
  same without the system message), `{{system}}`, `{{prompt}}` (the whole
  conversation as one text), `{{last_user_message}}`, `{{temperature}}` and
  `{{max_tokens}}`. A value that is exactly one placeholder gets the value in
  its own type; a key whose placeholder has no value is left out.
- `responsePath` is where the answer is, such as `choices[0].message.content`.
  `errorPath` names where an error message is when the API answers `200` with
  an error inside.
- `models` is optional: with it, **Discover** lists the provider's models.
- The answer is taken whole: no streaming, and tools are not passed on. The
  provider's auth settings (bearer token, custom header, none) apply as for
  any provider.

### Image and video generation

Images and videos use a provider on the **OpenAI-compatible** adapter (images
also work on the Gemini adapter, which needs none of the settings below).
There is no single standard for image and video requests the way there is for
chat, so each provider has an **Image / video API** setting that says how its
requests are written:

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
   second of video for the cost estimates. Since v1.5.0 discovery sets the
   type of a model it recognises by its name, marked as unverified; check it
   and correct it with **Edit** where the guess is wrong.
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

## API

Other programs can use the models and projects of this server through an API
under `/api/v1`, in the format of OpenAI's API, so that a client library
written for that API works by changing its base URL and key. It was tested
with plain HTTP requests, **not with a particular client library**.

Make a key under **Settings → API keys**. The key (it starts with `xn_`) is
shown once; the server keeps only a hash of it. A key acts as the user who
made it, and can be limited to:

- what it may do: *Chat*, *Embeddings*, *Media*, *Projects*;
- certain models;
- a number of requests a minute (120 when nothing is set);
- a number of tokens and an estimated cost a month, counted from the first
  of the month (UTC);
- a date after which it no longer works.

A key can be revoked at any time, and a user can have up to 20.

```bash
curl https://nexus.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer xn_…" \
  -H "Content-Type: application/json" \
  -d '{"model": "<a name from GET /api/v1/models>", "messages": [{"role": "user", "content": "Hello"}]}'
```

| Endpoint | The key needs | |
|---|---|---|
| `GET /models` | any | The models the key may use, under the names the other endpoints take: a model's own id, or `<provider name>/<model id>` when two providers have the same id. |
| `POST /chat/completions` | Chat | `messages`, `tools`, `tool_choice`, `temperature`, `max_tokens`, `stream` (with `stream_options.include_usage`). One answer per request (`n` is 1). Messages are text: a content part that is not text is refused. |
| `POST /embeddings` | Embeddings | `input` (a text, or up to 256 texts), `dimensions`, `encoding_format` (`float` or `base64`). |
| `POST /images/generations` | Media | `prompt`, `n`, `size` or `aspect_ratio` and `resolution`, `response_format`: `url` (a link to fetch with the same key) or `b64_json`. |
| `POST /audio/speech` | Media | `input`, `voice`, `response_format` (`mp3`, `wav`, `opus`, `aac`, `flac`), `speed`, `instructions`. The answer is the audio itself; its id in the library comes in the `x-nexus-asset-id` header. |
| `POST /videos` | Media | `prompt`, `seconds`, `size` or `aspect_ratio` and `resolution`, and `image_asset_id` to start from an image of the library. Answers at once, with the video `in_progress`. |
| `GET /videos/{id}` | Media | The video's `status`: `in_progress`, `completed` or `failed`. |
| `GET /videos/{id}/content` | Media | The finished file. Byte ranges are supported. |
| `GET /media/{id}`, `GET /media/{id}/content` | Media | An image, a voice-over or a video of the key's user, and its file. |
| `GET /projects` | Projects | The user's projects (all projects, for an administrator's key). |
| `POST /projects/{id}/runs` | Projects | Start a run. The body is optional: `{"input": "an instruction for this run"}`. Answers `202` with the run `queued`, `409` when the project is already running, and `200` with the reason when the run cannot start. |
| `GET /projects/{id}/runs` | Projects | The project's runs, newest first. |
| `GET /runs/{id}` | Projects | A run's `status` (`queued`, `running`, `succeeded`, `review`, `needs_approval`, `failed`, `cancelled`) and, once it has finished, its `deliverable` and tasks. |

Errors have OpenAI's shape, `{"error": {"message", "type", "code", "param"}}`,
with the matching HTTP status. Everything a key does is counted under Usage &
Costs like the same request from the dashboard, and media it generates is in
its user's library. `APP_URL` must be the public address of the site for the
links in the answers to be right.

## Roadmap

| Version | Milestone | Status |
|--------|-----------|--------|
| 1.0.0 | Multi-Provider Foundation | ✅ implemented |
| 1.1.0 | AI Workforce (AI Manager, agents, teams, tasks, delegation) | ✅ implemented |
| 1.2.0 | Development Execution (sandbox, snapshots, QA review, hard QA gate, remote Git) | ✅ implemented (remote Git untested-live) |
| 1.3.0 | Advanced Orchestration (parallel, budgets, approval, observability, auto-routing, workflows) | ✅ implemented (step-based workflow builder) |
| 1.4.0 | Creative Workflows (image and video generation, Creative Studio, media tasks, Reel template) | ✅ implemented (tested against a mock provider, not a live one) |
| 1.5.0 | Automation, tools and knowledge (background runs, schedules, notifications, agent tools and memory, knowledge base, voice-over, joined videos, Gemini and custom HTTP adapters, API) | ✅ implemented (tested against mock providers, not live ones) |

---

## Tech stack

- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- **Drizzle ORM** + **better-sqlite3** (SQLite — single file, no external DB)
- **otplib** (TOTP) + **qrcode**, **zod** (validation), **unpdf** (reading
  PDF text)
- Node's built-in `crypto` for AES-256-GCM and scrypt (no native crypto addons)
- **ffmpeg**, optional and not included: only joining clips needs it

Single process, SQLite and a folder of generated media files, zero external
services — so it deploys cleanly on a Pterodactyl server. Background work
(runs, schedules, videos, webhooks) is done inside that one process. The data
layer is behind Drizzle, so moving to PostgreSQL later is largely a
driver/connection change.

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
| `APP_URL` | no | Public address of the site. Links in webhook messages and the file links the API returns are built from it. It also says that the site is served over HTTPS when the proxy in front does not pass `X-Forwarded-Proto`. |
| `PORT` | no | Listen port (default 3000). Release bundles also accept a panel's `SERVER_PORT`. |
| `BIND_HOST` | no | Release bundles only: address to bind (default `0.0.0.0`). |
| `DATABASE_PATH` | no | SQLite file path (default `./data/nexus.db`) |
| `MEDIA_PATH` | no | Folder for generated images, voice-overs and videos (default: a `media` folder next to the database file, so `./data/media`). Back it up together with the database. |
| `FFMPEG_PATH` | no | The ffmpeg program that joins clips (default: `ffmpeg` on the PATH). Without ffmpeg only joining is unavailable. |
| `SUBTITLE_FONT_FILE` / `SUBTITLE_FONT_NAME` | no | A `.ttf` or `.otf` font for subtitles, instead of the bundled Noto Sans Bold; the name is only needed when it cannot be read from the file. |
| `RUN_CONCURRENCY` | no | Project runs worked on at the same time: 1 to 10, default 3. |
| `NEXUS_WORKER` | no | `0` switches the background worker off, for a second server process on the same database. |
| `BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD` | no | first-run admin (only used when no users exist) |
| `ALLOW_PRIVATE_PROVIDER_HOSTS` | no | comma list of hosts allowed to bypass the private-range block, for local model endpoints or the sandbox runner (e.g. `127.0.0.1,ollama.local`) |
| `SANDBOX_URL` | no | URL of an isolated sandbox runner. **Unset = execution disabled** (nothing runs on the app host). See `sandbox-runner/`. |
| `SANDBOX_TOKEN` | no | bearer token the app sends to the sandbox runner |
| `SANDBOX_ALLOWED_COMMANDS` | no | comma list overriding the default command allowlist |
| `SEARCH_PROVIDER` | no | The search service behind the agent tool *Search the web*: `brave`, `tavily` or `searxng`. **Unset = the tool is unavailable.** |
| `SEARCH_API_KEY` | no | The key of that service (not needed for SearXNG). |
| `SEARCH_URL` | no | The search address: required for `searxng` (its `/search`), optional otherwise. |
| `AGENT_HTTP_ALLOWED_HOSTS` | no | comma list of hosts, subdomains included, that agents may reach with *Read web pages* and *Call HTTP APIs*. Unset = any public host. |
| `AGENT_HTTP_PRIVATE_HOSTS` | no | comma list of hosts on a private network that agents may reach all the same. |
| `ALLOW_PRIVATE_WEBHOOK_HOSTS` | no | comma list of hosts on a private network that notification webhooks may be sent to. |

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

Whoever has root on the node can leave those steps to
[`scripts/host/pterodactyl-install.sh`](scripts/host#installing-pterodactyl-installsh),
which also writes the key, a password for the first administrator, and the
file the common Node.js egg starts.

To upgrade, there is
[`scripts/host/pterodactyl-upgrade.sh`](scripts/host): it stops the server,
backs up the database and the program files, installs the new release, starts
it, and goes back by itself when the new version does not answer.

For the public address there is
[`scripts/host/nginx-site.sh`](scripts/host#the-public-address-nginx-sitesh):
it adds the site to the node's nginx with a certificate from Let's Encrypt,
passed on to the server's port, and leaves the other sites of that nginx as
they are.

A new installation has no agents. [`scripts/host/workforce.sh`](scripts/host#the-workforce-workforcesh-and-workforcejson)
puts the workforce of a file into the running app (models with their prices,
agents, teams and workflows), signed in as its administrator, and can ask
each model for one word to see whether the provider's key may call it.

The same folder has a read-only disk report for tidying up a node, and a way
to run all of these without signing in to the node yourself: `over-ssh.sh`
from another machine, or the workflow **Deploy to a Pterodactyl node** from
GitHub Actions, which is started by hand and signs in with secrets of the
repository ([how](scripts/host#from-somewhere-else-over-sshsh)).

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
- Rate limiting on login, 2FA, sensitive account actions, media requests and
  uploads, and on every API key.
- Generated media: a file a provider links to is downloaded by the server with
  the same SSRF checks as any provider call, applied again to every redirect
  (at most three). The API key is sent only to the provider's own address,
  never to another host a link points at. A file is kept only if its own bytes
  say it is one of a few image or video types, so an HTML or SVG answer is
  never stored or served, and downloads are capped in size and time. Files are
  served only to their owner or an administrator.
- API keys: the server keeps only a SHA-256 hash; the key itself is shown
  once. A key acts as its user, within what it was allowed, and is refused
  once it is revoked or has expired.
- Webhooks: the signing secret is stored encrypted. The address goes through
  the same checks as a provider's (no private ranges unless listed), and
  redirects are refused.
- Agent tools: what a model writes as a tool's input is trusted no more than
  any other request. Workspace paths are validated, commands only run in the
  sandbox runner and through its allowlist, and web requests are checked
  against private and cloud-metadata address ranges, every redirect included.
  `AGENT_HTTP_ALLOWED_HOSTS` limits them to named hosts.
- Knowledge: an uploaded file is read as text, by what its own bytes say it
  is, and nothing in it is run. A private collection is not disclosed to
  other users, not even that it exists.
- Security headers set globally; audit log excludes secrets.

**Known limitations (be honest about these):**

- SSRF validation resolves DNS before the request; a determined DNS-rebinding
  attacker could still bypass it (TOCTOU). Add network-egress policy at the
  infrastructure layer for defense in depth.
- The rate limiter is in-memory (fine for a single process; use a shared store
  if you run multiple instances). That includes the requests a minute of an
  API key; a key's monthly limits are counted from the usage log.
- Generated files are stored unencrypted in the media folder, and are not
  removed when their owner's account is deleted; an administrator can delete
  them from Creative Studio.
- Costs are **estimates** from your own price metadata, not provider billing.
- No provider adapter, and nothing built on them (tools, embeddings, image,
  video and speech generation), has been run against a live provider.
- **Prompt injection.** A web page, a search result or a document that an
  agent reads is text someone else wrote, and it can try to talk the model
  into misusing the agent's other tools. Nothing in the app can rule that
  out. Give an agent only the tools its role needs, keep *Call HTTP APIs*
  and *Run commands* away from agents that read the open web, and use
  `AGENT_HTTP_ALLOWED_HOSTS` where you can.
- Agent memory and the knowledge base are stored unencrypted in the database.

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
| `npm run test:e2e` | end-to-end checks of the whole app against a mock provider (needs `npm run build` first) |
| `npm run build:standalone` + `npm run package` | build a release bundle into `dist/` |
| `npm run package:test` | start that bundle and sign in to it |
| `npm run release:info` | version, tag and channel that a push would publish |
| `npm run version:patch` / `minor` / `major` / `alpha` / `beta` / `rc` | raise the version (see [RELEASING.md](RELEASING.md)) |

## Project structure

```
src/
  app/                     # routes (pages + /api route handlers; /api/v1 is the API for other programs)
  components/              # UI: shell, auth, providers, models, chat, studio, media, projects, workflows, knowledge, account, users
  db/                      # Drizzle schema, client (auto-migrate), migrate script
  lib/                     # crypto, secrets, auth, session, ssrf, adapters, gateway, media, creative, orchestrator,
                           # agent (tools, memory), knowledge, worker, schedules, notifications, public-api, usage, stats…
  instrumentation.ts       # starts the background worker with the server
assets/fonts/              # the font for subtitles (Noto Sans Bold, SIL Open Font License)
drizzle/                   # generated SQL migrations
sandbox-runner/            # reference external code-execution runner (Docker)
scripts/                   # release tooling: package, smoke-test, publish, download
scripts/e2e/               # mock provider and end-to-end checks
scripts/host/              # for a Pterodactyl node: install, upgrade, the site in nginx, disk report, running them over SSH, and their tests
.github/workflows/         # CI: check, end-to-end, bundle, publish releases
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
size and time limits, media tasks in a plan, the Reel template), the OpenAI
and Gemini wire formats (tools, streaming, embeddings, images, speech), the
custom HTTP adapter's templates, cron expressions and time zones, the agent's
tool loop, document reading and passage ranking for the knowledge base, the
timeline, subtitles and ffmpeg command line of a joined video, the API's
request and response format, and the release tooling (channels, version
ordering, release selection, checksums).

On every push, CI runs typecheck, lint and these tests, the end-to-end checks
below, and the tests of the [host scripts](scripts/host#tests). It then builds
each release bundle and starts it: the bundle must refuse to run without its
key, serve pages on a panel-assigned port, sign in (SQLite + migrations), keep
the session, read a PDF into the knowledge base, have its background worker
running, and stop within seconds when told to. Last, the bundle of v1.4.0 is
upgraded to the new one on a made-up Pterodactyl host.

The provider/model/gateway/streaming paths **and** the full plan → delegate →
execute → synthesize orchestration loop have been verified end-to-end against a
local OpenAI-compatible mock. The Anthropic adapter was run through the same
paths against a local mock written from Anthropic's API reference; since
v1.5.0 that is part of the end-to-end run below. It has not been run against
the live API.

The end-to-end run is part of this repository:

```bash
npm run build
npm run test:e2e
```

It starts a mock provider ([`scripts/e2e/mock-provider.mjs`](scripts/e2e/mock-provider.mjs))
and the built app on a throwaway database in the system's temporary folder,
and makes about 590 checks through the app's HTTP API. From v1.4.0: the
three request styles for images and videos, files returned inline, as links
and behind redirects, the API key never leaving the provider's address,
refused file types and oversized downloads, the life of a video job, access
to other users' media, rate limits, and project runs with media tasks,
including a Reel workflow. From v1.5.0: the Anthropic, Gemini and custom
HTTP adapters; agents that work in steps with tools, in the OpenAI,
Anthropic and Gemini formats, and their memory; the knowledge base with
search by words and by meaning, in chat and for agents; speech; joining
clips with a voice-over and subtitles; runs that go on without a page, are
started by a schedule and are picked up after a restart; notifications and
signed webhooks; and the API with its keys and limits. At the end the server
is told to stop in the middle of a run and started again. No real provider
is called and nothing is billed. The mock is written from the providers'
public documentation, so passing it shows that the app is consistent with
that reading of the documentation, **not** that a live provider accepts the
requests.

Joining clips is checked for real when ffmpeg is there (`FFMPEG_PATH`, or
`ffmpeg` on the PATH), and for its explanation of what is missing when not:
the joined files are decoded again, and their picture and sound counted. It
was run with ffmpeg 4.2 and 9.0; CI uses the ffmpeg package of its runner,
and with `E2E_REQUIRE_FFMPEG=1` stops when there is none instead of
checking less.

`E2E_BROWSER=<folder with puppeteer-core and @sparticuz/chromium>` also
opens every dashboard page in a headless browser and clicks through the new
parts; that pass is not part of CI.

---

Designed by Xiero · Xiero Nexus AI
