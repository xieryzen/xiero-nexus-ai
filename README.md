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

Open the site and create the first account; it becomes the owner. If
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
- **Roles (RBAC)** — `owner` / `admin` / `user`, enforced on every protected
  endpoint. The first account on a fresh instance is its owner
  ([Accounts and roles](#accounts-and-roles-v170)).
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
  model, bounded execution (max tasks, bounded steps and attempts, and the
  [tokens of the project's account](#tokens-of-an-account-v180)),
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
  An agent that can write files saves that file itself and then says in a
  few lines what it did; the file keeps what the agent saved. An agent
  without that tool answers with the file, and an answer that holds it in a
  code fence is saved without the fence and the words around it.
- **File management** — view/edit/create/delete files through the dashboard;
  paths are validated (no absolute paths, no `..` traversal, safe characters).
- **Sandboxed execution** — run a build/test command against the workspace. Code
  runs **only** in an external isolated runner (see [`scripts/host/runner/`](scripts/host/runner)),
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
  available. It is shown the files of the workspace as well as what each
  agent said, with the room shared between them (8,000 characters each,
  64,000 together) and every cut said, so that a file is judged and not the
  sentence "I wrote the file". Advisory — it annotates the project, it does
  not block.
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
- **Limits** — per-project max tasks and max parallelism. A project has no
  token budget of its own (it had one until v1.8.1): a run is held to the
  [tokens of its account](#tokens-of-an-account-v180), and to nothing else.
  What the tasks used streams live to the project view.
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
  - *Servers over SSH* (v1.8): run commands on the servers a project names;
    see [Servers over SSH](#servers-over-ssh-v180).
  - *Browser* (v1.8): open web pages, read them, click and type, and sign in
    with the site accounts a project names. Needs `BROWSER_URL`; see
    [The browser](#the-browser-v180).
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

## Skills (v1.7.0)

A skill is a way of working, written down: what a `SKILL.md` says. An agent
that is given a skill reads it with every task it works on, so that the same
kind of work is done the same way each time, by whichever model answers.

- **Add one** under **Skills**: upload it, or write it on the page. What is
  taken:

  | File | What it is read as |
  |---|---|
  | `SKILL.md`, or any Markdown or text file | One skill. Front matter (`name`, `description`) is used when it is there; without it the first heading is the name and the first paragraph the description. |
  | `.skill` or `.zip` | An archive of a folder with a `SKILL.md` in it, and the files the instructions refer to. Several such folders in one archive give several skills. Without a `SKILL.md`, an archive with exactly one Markdown file is that skill. |
  | `.json` | `{"name", "description", "instructions", "files": [{"path", "content"}]}`, one or a list. |

  The kind is read from the file's bytes, not from its name. Only text is
  kept, because an agent reads a skill and does not run it: pictures, fonts
  and programs in an archive are left out, and the page says which. A file
  whose path leaves the folder, a link and an encrypted entry are left out
  too. An upload is at most 8 MB, the instructions 100,000 characters, a file
  of a skill 256 KB, and a skill keeps 60 files of 2 MB together. A skill of a
  name that is taken is refused, unless *Replace* is ticked: then the skill
  gets the new text and files and stays with the agents and teams that have
  it.
- **Give it** to an agent or to a team on the **Agents** page. A team's
  skills are every member's while it works in a project of that team, on top
  of its own.
- **At work**, the agent's instructions for a task are followed by its
  skills, its own first, each in full while there is room (16,000 characters
  a skill, 40,000 together, twelve skills). What does not fit is named with
  its description. An agent with tools gets one more, `read_skill`, for the
  rest of a long skill and for a skill's files; it reads only the skills it
  was given. A task that writes the prompt of a picture or the words of a
  voice-over is given the skills as well.
- **The one who plans** sees each agent with the names of its skills, and
  **the reviewer** of a project reviews by its own skills and the team's: a
  checklist is what a review is made of.
- A skill can be switched off without taking it from anyone, read on its
  page with its files, and downloaded again as a `.skill` or as its
  `SKILL.md`. Adding, replacing, changing and deleting a skill is in the
  audit log. Every signed-in user can read the skills; an administrator
  changes them.

The skills that come with this repository are in
[`scripts/host/skills`](scripts/host/skills): one folder each, put into a
running app with its agents and teams by the
[workforce file](scripts/host#the-workforce-workforcesh-and-workforcejson).

What was tested: the archive reader against archives made by another
program, damaged ones and ones that announce less than they unpack to; the
upload, the tool and a project run in the end-to-end checks, against the
mock. **How well a given model follows a skill was not measured.**

## Accounts and roles (v1.7.0)

| Role | What it does |
|---|---|
| **Owner** | Everything an administrator does, the accounts, how many tokens each account may use, the [servers](#servers-over-ssh-v180) agents work on, and the [site accounts](#the-browser-v180) they sign in with. |
| **Administrator** | Providers, models, agents, teams, workflows, skills, the audit log, and everyone's projects, media and usage. Sees the accounts and their tokens, and changes none: no role, no token limit. |
| **User** | Their own projects, chats, media, knowledge and API keys. Sees no provider and no model, and chooses none ([below](#what-a-user-is-shown-v180)). |

- **The first account is the owner.** An installation from before 1.7 has no
  owner: at its first start with 1.7 its first administrator becomes the
  owner, and the audit log says so (`system.owner.assigned`).
- **An owner manages the accounts** under **Users & Roles**: makes one with
  its role and first password, changes a username, an email, a password, a
  role, switches an account off and on again, switches a lost second factor
  off, signs an account out everywhere, and deletes it. A new password, a
  second factor that was switched off, and an account that was switched off
  sign that account out everywhere. Deleting an account takes its sessions,
  keys and recovery codes with it; what it made (projects, files, skills)
  stays, without an owner.
- **What an owner cannot do:** change their own role or status, or delete
  themselves. There is always an owner who can sign in.
- **Everyone changes their own username, email and password** under
  **Settings**, each time with their current password. A new password signs
  every other session out.
- Every change is in the audit log with what changed, by name. A password is
  never in the log, nor in an answer of the API.
- `GET /api/admin/users` (administrators), `POST /api/admin/users`, `PATCH`
  and `DELETE /api/admin/users/{id}` (owners), `PATCH /api/account/me` (one's
  own account).

Anyone who can reach the site can still register an account of their own,
as an ordinary user: there is no switch for that yet.

## Models that answer (v1.8.0)

The app checks by itself that its models answer, and offers only the ones
that do.

- **The check.** The background worker asks every chat model that is switched
  on (on a provider that is switched on) for one word. It is the check the
  **Test** button of the Models page makes. A new model is asked soon after it
  is added; a model that answers, again every six hours.
- **A model that fails is left out** of the model lists (chat, projects,
  agents, settings), of `GET /api/v1/models`, and of the automatic choice of
  the cheapest model. It is not switched off: the Models page shows it as
  "left out of the lists" with what its provider said, and a request that
  names it is still passed on.
- **A model that answers again is back.** A failing model is asked again
  after 15 minutes, then after twice as long each time, up to the interval.
  **Test** and **Check all now** on the Models page bring it back at once.
- **A busy moment is not a failure.** A model that worked and now answers
  "too many requests", "busy" or not at all is asked once more after 20
  seconds; only when that fails too is it left out. A refusal (no credit, no
  access, no such model) is not asked twice.
- **What an agent is set to stays.** An agent whose model is left out keeps
  it; its form shows the model with the reason. Until v1.10.0 a task still
  asked that model first; now it asks it last (see the next section).

`MODEL_HEALTH_INTERVAL_MINUTES` sets how often a working model is checked
(default 360, between 5 minutes and a week); `0` switches the automatic check
off, and models are then checked with the two buttons only. Each check is one
small request, recorded under Usage as a test. Administrators can also read
and start checks over the API: `GET /api/models/health`, and
`POST /api/models/health` with `{"modelIds": [...], "wait": true}` (both
optional).

Not checked: image, video, speech and embedding models, since a check would
generate (and bill) one each time. They are offered as before. Nor a model
that only writes down what is said (marked for audio and not for text): it
cannot answer a chat request, and from v1.10.0 it is not asked one.

## A run goes on with a model that works (v1.10.0)

Until v1.10.0 a task asked the two models of its agent and the manager model
of its project, in that order, whatever was known about them. On one server
a task failed that way while twelve other models answered: its first model
did not answer within five minutes, its second had been failing its checks
for days, and so had the manager model.

- **Stand-ins.** A task asks the models it is set to that can be used now;
  then **stand-ins**, other chat models of the installation that work; and
  only then the ones it is set to that are failing or resting. The run's own
  requests (its plan, its result, its review) do the same in place of the
  manager model, and a project whose manager model is switched off or gone
  runs with a model that works. The task's card says which model did not
  answer and which one went on, and
  `GET /api/projects/{id}/attempts` lists each attempt as before.
- **Which models stand in.** As for the app's own choice (see "What a user
  is shown"): where models are marked **for users**, only they; otherwise
  every chat model that is switched on. Never one that is failing or
  resting. **Never one that costs more** than the dearest model the task
  was set to: a task set to models priced at nothing is done by one priced
  at nothing, and a model without a price is taken to cost more (where a
  task's own model has no price, there is nothing to compare with, and any
  may stand in: mark the ones you want, or set prices). For a task with
  tools, a model marked as taking tools before one that is not; then the
  cheapest. One of each provider before a second of any, four at most.
- **A project says whether it wants them**: **Go on with another model**,
  in the project form and on the project page (`standIns` in
  `POST /api/projects` and `PATCH /api/projects/{id}`). A project that says
  nothing does what the installation is set to: stand-ins are on unless
  `MODEL_STAND_INS=0`. Switched off, a task fails when its own models do not
  answer (or waits, where they are limited: v1.9.0).
- **Real work counts as a check.** What a chat request ends with is written
  down for its model, whoever made it: a chat, a task, the API. A model that
  answers is known to work, and the check need not ask it. A model that does
  not answer for something its provider did (no answer in time, no
  connection, 429, an error of the provider) **rests**: the app does not
  choose it by itself for as long as the provider says, or for a minute,
  doubled each time up to a quarter of an hour. It stays in the lists, and
  the check asks it when its rest is over. **Three such requests in a row
  put it away** as a failed check does, and so does one answer that asking
  again does not change: no such model, a key that is not accepted, no
  credit, a quota that is used up for the day. A request that is refused for
  what it asked (too long, a parameter the model does not take) says nothing
  about the model.
- **Back by itself.** A model that was put away is asked by the check after
  15 minutes, then after twice as long, and not before the time its provider
  named ("retry in 17 hours"); when it answers, a check or a request that
  names it, it is back. One that real work had put away comes back on
  probation: it passed a check of one word, and the next request of real
  work that fails puts it away again.
- **The Models page** says how many of the models that are switched on work,
  rest and are left out, shows "rests until 14:05" on a model that rests,
  and when a failing one is asked again.

What stand-ins cannot do: answer where no model of the installation works,
or judge whether another model is as good as the one that was chosen. A
small model that stands in for a large one delivers what a small model
delivers. Where that matters, switch them off for the project, or mark the
models the app may choose.

## Tokens of an account (v1.8.0)

Every account has a number of tokens it may use, and an owner sets it.

- **A new account may use 10,000,000 tokens** in all, whether it registers
  or an owner makes it (`DEFAULT_TOKEN_LIMIT` changes that number). Nothing
  is given back by the calendar: what was used stays counted, and there is
  more when an owner raises the limit.
- **Everything the account does is counted:** chat, the runs of its projects
  with every task in them, images, videos, voice-overs, the knowledge base,
  and the public API with its keys. A run of a project spends the tokens of
  the account the project belongs to, whoever starts it.
- **An owner sets the limit** under **Users & Roles**: the Tokens column
  shows each account with what it used and may use, and **Change** sets the
  limit. An administrator sees the numbers and changes none; nobody changes
  their own. **An owner is not held to a limit**, since the tokens are spent
  on the keys the owner brought; what an owner uses is counted all the same.
- **With no tokens left, new work is refused**: 402 `token_limit_reached`
  (to an API client `insufficient_quota`), with a sentence that says how much
  was used, of how much, and that an owner can raise the limit. Nothing is
  asked of a provider. What the account made stays, and can be read.
- **A run in progress stops.** The tasks that have not started are not
  started and say why; an agent in the middle of a task is asked once more,
  without its tools, to hand over what it has; no second model is tried for
  a task whose first failed; the result is not put together and not reviewed
  when that would need tokens; the run ends "for a look" with what its
  finished tasks made. The account is told in its notifications.
- **A project has no token budget of its own** (v1.8.1; until then a run was
  stopped at 200,000 tokens unless the project said otherwise). The tokens
  of its account are all that a run is held to, and the project page says
  how many are left. **A run of an owner's project is held to no number of
  tokens**: what ends it is the number of its tasks (at most 40), the steps
  an agent takes in a task (at most 40 with each of its models), and what
  the provider allows.
- **Everyone sees their own tokens** under **Settings**, and in short next
  to their name on every page.

The limit is not exact to the token. The request in progress when the last
tokens go is finished and counted in full, and so is the one more that an
agent is asked to hand over its work: an account ends above its limit by
those requests, for each task that was in progress. Tasks that work side by
side are held to one balance: each call of an agent is counted the moment it
is answered. A check of a model is counted for nobody, and neither is a
request the provider failed; of an agent whose model failed in the middle of
a task, the calls that were answered are counted. An image or a video is
counted with the tokens of its prompt, which is little: a limit in tokens
holds chat and runs back, and media hardly.

Over the API: `tokenLimit`, `tokensUsed` and `tokensLeft` are in
`GET /api/account/me` and `GET /api/admin/users` (`tokenLimit` and
`tokensLeft` are `null` for an owner). An owner sets a limit with
`PATCH /api/admin/users/{id}` and `{"tokenLimit": 25000000}`, and gives a new
account one with `tokenLimit` in `POST /api/admin/users`. Every change is in
the audit log, with the limit before and after.

## What a user is shown (v1.8.0)

A user works with the installation and is not shown how it is set up. That is
for administrators and owners.

| | A user | An administrator, an owner |
|---|---|---|
| Menu | Overview, AI Manager, Agents & Teams, Workflows, Chat, Creative Studio, Knowledge, Usage, Settings | the same, and Providers, Models, Servers, Browser, Skills, Audit, Observability, Users & Roles |
| Providers and models | not shown: no name, no list, no price | everything |
| Which model does the work | the app chooses | they choose |
| Agents, teams, workflows | who they are and what they are for | also what they are told, their models, tools and skills |
| Skills | not shown | everything |
| Servers | not shown. Their assistant and the runs of their projects work on the machines they handed over themselves ([v1.11.0](#access-you-hand-over-in-a-conversation-and-memory-v1110)), and on no other | an owner registers them; an administrator sees the ones opened to administrators |
| Browser | not shown. Their assistant and their agents sign in with the site accounts they handed over themselves (v1.11.0), and open nothing else in it | their agents work in it; an owner saves the site accounts, an administrator sees the ones opened to administrators |
| Chat and Memory | their conversations, what they handed over and what is remembered about them; no model to choose | the same of their own, and the model can be chosen |
| Usage | their tokens and requests | everyone's, with providers, models and costs |
| When something fails | that it did not work, and what to do | what the provider answered |

- **The app chooses the model for a user:** in Chat, for the manager of a
  project and its images, videos and voice-overs, in Creative Studio, for a
  knowledge base that is searched by meaning, and with an API key. A model a
  user names in a request is not used.
- **An administrator says which.** On the Models page every model has a
  switch **for users**. When models of a kind (chat, images, videos,
  voice-overs, embeddings) are marked, users work with those only: the
  cheapest first, and one whose last check failed after the ones that answer.
  While none of a kind is marked, the app takes the cheapest of that kind
  that is switched on; a model without a price comes after the ones with
  one. The page says which model users work with now, kind by kind. In
  **Chat** on the site, when the first choice fails, up to two more are
  asked before the user is told; everywhere else the first choice is the one
  that is asked.
- **Agents work with the models they are set to**, for everyone: marking a
  model for users does not change an agent.
- **A failure is told without the setup.** An error, a failed task, a
  notification or a progress note that names a provider or a model of this
  installation, or uses the words provider, model, upstream, adapter or
  gateway, is replaced for a user by "This could not be done just now. Try
  again in a moment; if it stays that way, tell an administrator." What is
  about the request itself is said as it is: no tokens left, a file too
  large, a name that is taken. An administrator who opens the user's project
  reads what the provider said.
- **When nothing can do the job** (no image model, say), a user is answered
  503 `not_set_up`: "This installation cannot do that yet. An administrator
  has to set it up." A user's project that cannot start for that reason
  says the same; one whose team has no agent that is switched on says that.
- **What the app writes about its own work names nothing either.** The line
  an image, a video or a voice-over leaves in a task ("Generated image.
  Asset …") is written without the model for a user's project, and read
  without it by a user where an older line has it. A result that could not
  be put together says so, and where the work of the tasks is; an
  administrator reads what the provider said.
- It is left out on the server: what a user is not shown is in no page and
  in no answer of the API, also when asked for directly. `GET /api/providers`,
  `/api/models`, `/api/skills` and `/api/agents/tools` answer a user 403.

Not hidden:

- **What a model wrote.** A chat's answer and a task's result are the user's
  own work and are shown as they are, also when a model names itself in
  them.
- **What an administrator wrote for people to read:** the names and
  descriptions of agents, teams and workflows, and the titles of a
  workflow's steps. They are shown to users as written, so they are the
  place to say what something makes and which team goes with which
  workflow, and not which model does it. (The Reel template used to end a
  workflow's description with what a project needs; it no longer does, and
  a user reads an older one without that sentence.)

## Servers over SSH (v1.8.0)

Agents can work on your servers: install, configure, look at logs, restart a
service. They do it over SSH, on the machines an owner registered and
nowhere else, and everything they run is written down.

- **One connection, kept open until the work is done.** A run opens one
  connection to a server with its first command and keeps it: through every
  task that follows, through the minutes in which a model thinks and nothing
  is sent, through a command that says nothing for half an hour. Every 15
  seconds the connection says that it is still there
  (`SSH_KEEPALIVE_SECONDS`), so that no firewall or router in between forgets
  it. When the run has ended, however it ended, the connection is closed.
- **A connection that is lost is opened again.** If the network fails or the
  server restarts, the next command connects again (three tries, 2 and 5
  seconds apart), and the agent is told what happened to the command that
  was running: that it is not known whether it finished.
- **Only machines an owner registered** (**Servers** page). The app reads the
  machine's host key first, without signing in, and shows its fingerprint to
  compare (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the machine
  prints the same line). Registering accepts that key: from then on the app
  signs in only to a machine that shows it, and sends nothing to one that
  shows another. Before anything is saved the app signs in once and runs one
  harmless command. A password or a private key (with its passphrase) is
  kept encrypted and is never shown again.
- **A project names its servers**, up to 5, in the project form or on its
  page; and an agent has to be given the tool **Work on servers** on the
  Agents page. An agent without the tool, or in a project that names no
  server, cannot reach one. An agent names a server by its name: it has no
  way to give an address. The project's page says which of its agents can
  work there, and warns when none can. The AI Manager is told which servers
  the project has and which agents can work on them, and gives those tasks
  to them.
- **Every command is written down**: the command, how it ended (exit code,
  time was up, connection lost, run stopped, not started and why), what it
  printed (the end of it), how long it took, and the project, task, agent and
  account it was for. So is every connection: opened, lost, opened again,
  closed. The Servers page shows the log, by machine; the newest 5,000
  entries per machine are kept, and they stay when the project or the
  machine is deleted.
- **Whose projects may work on a server.** An owner's always. An
  administrator's when the owner opened the machine to administrators. A
  user's never, and a user is not shown that there are servers. Whoever tells
  the agents of a project what to do can have anything done on its servers,
  so a project is run, changed, scheduled and approved only by an account
  whose own projects may use every server it names; an administrator who may
  not can still read it.
- **What an agent can do there** is whatever the registered account can.
  Register an account with the rights the work needs, and no more; the notes
  of a machine ("Runs the panel: leave /var/www alone") are told to the
  agents.

How a command is run:

- Each command gets a new shell in the account's home directory: bash where
  the machine has one, else sh. A `cd` or a variable does not carry over to
  the next command; `cd /path && …` in one command does.
- Nobody is at a keyboard. There is no terminal, the input is empty, and
  `DEBIAN_FRONTEND=noninteractive` is set: a program that asks a question
  gets no answer, so the agent is told to pass `-y`.
- A command may take 300 seconds, or what the agent asks for, up to an hour
  (`timeout_seconds`). When the time is up, or the run is stopped, the
  command and everything it started are ended on the machine (asked to end,
  and ended two seconds later if they are still there). For longer work the
  agent is told to start it with `nohup` in the background and look at it
  with later calls.
- The agent reads the exit code and what was printed: the first 2,000 and
  the last 5,000 characters of the output, and 800 and 2,200 of the errors,
  without the colour codes and progress bars of a terminal.
- A task that starts over (its model failed, or the app was restarted) is
  told which commands it has already run, and that they are not undone.
- Four commands of a run work on one machine at a time; more wait their
  turn. A machine that opens fewer sessions on a connection (`MaxSessions`
  of sshd) gets as many as it opens. Where it opens only one, a command
  whose time is up is ended through its own channel, which sshd passes on
  from version 7.9, and the agent is told to look whether it still runs.

`GET /api/servers` (administrators: the machines their projects may use),
`POST /api/servers/host-key`, `POST /api/servers`, `PATCH` and
`DELETE /api/servers/{id}`, `POST /api/servers/{id}/test` (owners),
`GET /api/servers/commands` (the log). A project takes `serverIds`.

Not there: file transfer (an agent writes a file with a here-document, up to
16,000 characters a command), port forwarding, a terminal for programs that
need one, and signing in through another machine (a jump host). The machine
needs `sh`, as every Linux, BSD and macOS has; the check when a machine is
registered says so when it does not. It was tested against an SSH server on
the machine of the tests, with a password and with a key, **not against a
server of yours**.

## The browser (v1.8.0)

Agents can work on web sites the way a person does: open a page, read it,
click, type, choose from a list, and sign in with an account you saved. They
do it in a real Chromium that runs **apart from the app**, the browser
service ([scripts/host/browser](scripts/host/browser/README.md)).

**What a site checks of a person is left to a person.** The app does not
solve a CAPTCHA and does not get around one, and it does not make the
browser look like something it is not: a site puts those checks there to
turn automated visitors away. What the app does instead:

- **The agent stops, and you take the page over.** When a sign-in form has a
  CAPTCHA, when a site asks for a code it sent to your phone, when a page is
  nothing but "verify that you are human", or when the agent itself sees
  that a person is needed, the task waits. You are told (the bell, and your
  webhook when you have one), you open the page in the app, see it as it
  is, click and type on it there, and hand it back. The agent goes on from
  where you left it. A page waits 15 minutes (`BROWSER_WAIT_MINUTES`); then
  the agent is told that nobody came, finishes with what it has, and says
  what is waiting.
- **The session is kept, so you are not asked often.** What a sign-in leaves
  behind (the site's cookies) is kept, encrypted, with the account. The next
  run, of this project or another one, is let in without signing in again:
  no form, no CAPTCHA, no code, until the site ends the session. A new
  password, another user name or another site drops it; a run that was at
  work with the account as it was does not bring it back.
- **Sign in by hand, once.** On the **Browser** page an owner opens the site
  of an account in the same browser: the app fills in the form, you do what
  the site asks of a person, and keep the session. Agents then find the site
  signed in.

How signing in works:

- **Only an owner saves a site account** (Browser page): a name, the address
  of the page where one signs in, the user name and the password. The
  password is kept encrypted and never shown again.
- **The app types the password; an agent is never shown it.** An agent says
  "sign in with `shop-admin`", and the app finds the form, fills it in and
  sends it. The password is typed only on the account's own site (the host
  of its address and what is under it), never on a plain-http page of a
  site that was saved with https, and only into the password field itself
  with the cursor in it: where a page passes the cursor on to something
  else, nothing is typed, the agent is told, and an owner signs in by hand.
  No answer of the tool holds the password: if a page shows it (a "show
  password" button, an error that repeats it), the agent reads `[hidden]`
  in its place, in whatever form the page is read (with its white space
  drawn together, as the value of a field, inside an address), from
  wherever in a long page the agent reads on, and whoever typed it: also a
  person who took the page over and signed in by hand. An agent presses no
  key that copies or pastes.
- **A project names its site accounts**, up to 5, in the project form or on
  its page; and an agent has to be given the tool **Work in a browser** on
  the Agents page. The project's page says which of its agents can sign in,
  and the AI Manager is told the same when it plans.
- **One account of a site in a project.** A run has one browser, and a
  browser is signed in to a site as one account at a time: what the sign-in
  of one account leaves is what another account of that site would be let
  in with. So a project names one of them (the host of the address, with
  everything under it, is the site), and the other gets a project of its
  own. Where two accounts of a run are on sites under one domain
  (`app.example.com`, `shop.example.com`), each keeps the cookies of its
  own host, and a cookie for the domain above them is kept for neither.
- **Whose projects.** Agents work in the browser in the projects of owners
  and administrators. An owner's projects may sign in with any account; an
  administrator's with the ones the owner opened to administrators; a
  user's projects get the browser only to sign in with the site accounts
  that user handed over in a conversation (v1.11.0), and only while the
  browser service keeps pages from private networks. A project that names site accounts is
  run, changed, scheduled and approved only by an account whose own
  projects may use them.
- **What an agent can do on a site** is whatever the account can. Save an
  account with the rights the work needs, and say in its notes what to
  leave alone: agents are told.
- **Who sees a password.** An agent never does. A person who takes a page
  over sees what the site shows: where a site has a button that shows what
  is typed, a form the app filled in shows the password to that person. An
  owner knows it anyway; an administrator takes over the pages of their own
  projects, so open to administrators only the accounts whose password they
  may know.

What an agent is given:

- One action per call: `open`, `read`, `click`, `type`, `select`, `press`,
  `back`, `sign_in`, `ask_person`. Every call answers with the page as text:
  its address, its title, what it says, and everything that can be acted on
  with a number (`[4: button "Sign in"]`). The model is sent the page as it
  is now once: older answers keep what was done, not what the page showed.
- A frame of the same site, and what a page keeps in a part of its own, are
  read and used; a frame from another site is not, which is where a CAPTCHA
  lives. A tab the site opens is followed. A question the page asks in a
  box is answered Cancel unless the agent says otherwise with the action.
- A task that starts over (its model failed, or the app was restarted) is
  told what it already did in the browser, and that a form that was sent
  stays sent.
- **Every action is written down** (Browser page): the page, what was
  clicked, typed and chosen, every sign-in, and every time a person took a
  page over, with the project, task, agent and account. What is typed into
  a password field, by the app or by an agent, is never written down.

Where pages may go:

- The app opens only `http://` and `https://` addresses, never a file or a
  page of the browser, and never an address on a private network; the hosts
  agents may reach are the ones of `AGENT_HTTP_ALLOWED_HOSTS`, as for the
  other web tools.
- **The browser service refuses private networks for everything a page
  loads**: a redirect, a picture, a request of the page's own scripts. It
  connects to the address it looked at, so a name cannot lead somewhere
  else in between. The Browser page says whether the service it is
  connected to does this.
- The service takes requests only with its token, which is part of
  `BROWSER_URL` and is shown nowhere.

Setting it up: `BROWSER_URL` in `.env` names the service. On a Pterodactyl
node, the Deploy workflow's action `browser` (or
`scripts/host/browser-service.sh` on the node) builds the image, starts the
container on the server's network with a limit on memory and nothing
published, and writes `BROWSER_URL`; by hand it is one `docker run`
([README of the service](scripts/host/browser/README.md)). Without a
browser service agents are not handed the tool, and the Agents page says
so.

`GET /api/browser` (the service and the pages that wait),
`GET` and `POST /api/browser/accounts`, `PATCH` and
`DELETE /api/browser/accounts/{id}`, `POST` and
`DELETE /api/browser/accounts/{id}/session` (sign in by hand; drop the
session), `GET /api/browser/live/{id}` with `/screen` and `/input` (a page
that waits), `GET /api/browser/actions` (the log). A project takes
`siteAccountIds`.

Not there: solving or passing a CAPTCHA, by the app or by a service;
anything that hides that the browser is automated; uploads and downloads of
files; pictures of a page for the model (agents read pages as text); what is
inside a frame of another site; sessions of sites that keep the sign-in in
the page's storage instead of cookies (they sign in again each run); two
accounts of one site in one project; a browser for the projects of users. A
password shorter than four characters is not taken out of what an agent
reads when a page shows it. It was tested against a site the tests
start on their own machine, with a real Chromium, **not against the sites
you will use it on**: how a site's form is recognised differs from site to
site, and where the app does not find a form, signing in by hand is the way.

## Runs that meet a limit (v1.9.0)

A provider with a small allowance (a free tier above all) stops answering in
the middle of a run: "429, you exceeded your current quota". Until v1.9.0
the task failed with that, every task behind it was not started, and the
only way on was to run the project again from its first task.

- **Continue** — a run that ended with tasks that did not succeed (failed,
  not started behind a failed one, or cancelled) can be taken up again. The
  project page then has **Continue** next to **Re-run**: Continue does the
  tasks that are left and keeps the others with what they made, their files
  and their tokens; Re-run plans anew and does everything again. The run
  that continues is a run of its own in the history ("continued the run
  before it"), with the instruction of the run it continues unless it is
  given another, and it counts the tokens it used itself. What a task did on
  a server or in the browser the last time stays in the logs, and the agent
  that does it again is told which commands the task already ran. Over the
  API: `{"continue": true}` in the body of `POST /api/projects/{id}/run`
  and of `POST /api/v1/projects/{id}/runs`; `409 nothing_to_continue` when
  the project was never run or every task of its last run succeeded. A run
  that a schedule starts always starts anew.
- **A task waits for a limit that ends** — when none of a task's models
  answered and at least one of them said "not now" (429, 503 or 529), the
  task is not failed: it waits and asks its models again, after one minute,
  two, five, ten and then every quarter of an hour, **for an hour in all**
  (`RUN_LIMIT_WAIT_MINUTES`; the waits grow with it; `0` turns it off, and
  the task then fails at once as before). Where its providers say how long,
  the task does not ask before the first of those waits is over. Its card
  says that it waits and when it asks again; **Cancel** ends the wait at once. A task that waited the whole
  time in vain fails and says so, and the other tasks of that run do not
  wait a second time: what is left is for Continue. While it waits, a task
  keeps its place among the runs that work at the same time
  (`RUN_CONCURRENCY`).
- **It does not wait for a limit that does not end in that time**: a quota
  that is counted per day, an allowance of nothing ("limit: 0", a model that
  the tier does not include), an account without credit
  (`insufficient_quota`), or a wait that the provider puts at longer than
  the time that is left. Such a task fails at once. What helps then is
  another model for the agent, a provider with a larger allowance, or
  Continue the next day.
- **What the provider said, in few words** — Gemini's answer to a used-up
  quota is some hundred words with two addresses in it. It is now told as
  "Provider responded 429: You exceeded your current quota, please check
  your plan and billing details. Quota exceeded: generate content free tier
  requests, limit 20 per day, model gemini-2.5-flash. Please retry in 17
  hours and 18 minutes." A task that failed after more than one of its
  models was asked says what **each** of them answered, a line for each,
  where it used to say only what the last one did.

Only the tasks wait. The requests that plan a run, put its result together
and review it are sent again for seconds (`PROVIDER_RETRIES`) and go on with
the next model, as before. What was tested is the app against providers of
the tests that answer the way Gemini and the OpenAI-style providers are
documented and reported to answer; **no run was waited through against a
live provider's quota**.

## Access you hand over in a conversation, and memory (v1.11.0)

In **Chat**, write how to sign in to your server, to a web site or to an API,
and say what you want done:

```text
ini vps ku, tolong cek kenapa nginx mati
IP: 203.0.113.7
User: root
Pass: ********
```

The app takes the password out of the message **before any model is asked and
before the message is stored**, signs in once to try it, keeps it encrypted,
and gives the assistant a name for it (`vps-203-0-113-7`). The assistant then
does the work with its tools, in that conversation and in every later one,
and so do the agents in the runs of your projects. Nothing has to be set up
on the Servers or the Browser page, and no agent needs a tool ticked for it.

- **What is recognised**, by its shape and without a model:
  - *a server*: a password or a private key that comes with an IP address,
    or with a host name and words such as `ssh`, `vps`, `root`
    (`ssh deploy@srv.example.com -p 2200 pw: …`, a form of `IP:` / `User:` /
    `Pass:` lines, a JSON object, `203.0.113.7 root ********`, Indonesian
    `usernya … passwordnya …`). Without a user name it is `root`;
  - *an account on a web site*: a web address, a name and a password
    (`https://panel.example.com/login user budi pass …`); a panel on a bare
    address (`panel 203.0.113.7:8080 user admin pass …`) is asked as
    `http://203.0.113.7:8080`;
  - *a key*: what is called a token, an API key, a secret or a bearer, and
    what has the shape of one (GitHub, Discord, Telegram, Slack, Stripe,
    OpenAI-style `sk-…` and others). `OPENAI_API_KEY=…` and
    `DISCORD_TOKEN=…` are understood by the name of the setting;
  - *the password of something else on a machine*: a database, FTP, a
    mailbox (`db mysql: host … user app password …`, `MYSQL_PASSWORD=…`).
    The app cannot try such a sign-in; it keeps the password as a key
    (`mysql-password`) that a command on a server can name.

  A password that comes with nothing it opens (`password: …` alone) is left
  where it is. So is everything in a shape the app does not know: **that goes
  to the model as you wrote it**, and the assistant is told to keep it with
  its tool `keep_access` first, after which it is taken out of the stored
  conversation as well. Look at what the page shows under your message: it
  says what was kept under which name, and what was not and why.
- **What becomes of it.**
  - A server is tried before it is kept: the app reads its host key, signs
    in, and runs one harmless command. The key the machine showed then is the
    one it has to show from then on (remove the server on the Memory page
    when the machine was set up anew). A sign-in that fails is not kept, and
    the password is taken out of the message all the same.
  - A site account is kept, and tried when it is first used: in the
    [browser](#the-browser-v180), where the app types the password on the
    site's own sign-in page. It needs the browser service; without one the
    account is kept and the assistant says that it cannot sign in from here.
  - A key is written by the assistant as `{{key:name}}`, and the app puts the
    value in. **In a web request** (`http_request`) only to the site the key
    is tied to: the site you named with it, the one its shape says
    (`github.com` for a GitHub token), or the one you set on the Memory page;
    a key tied to no site is sent in no web request. **In a command on a
    server** it can be written anywhere. What comes back from the site or
    the machine is shown with the name in place of the value.
  - In the text as it is stored and shown, the secret is
    `[password kept by the app as "vps-203-0-113-7"]`, or
    `[password taken out by the app]` when it was not kept.
  - The same server (address, port and user), the same site and user, or a
    key of the same name handed over again **replaces** what signs in. An
    account keeps up to 20 servers, 20 site accounts and 50 keys.
- **It is yours alone.** What an account hands over is used by that
  account's conversations and by the runs of its own projects. It is not on
  the Servers or the Browser page, no project can name it, and nobody else,
  no administrator and no owner, is shown it or works with it. Two accounts
  can hand over the same machine: each has it under the same name, as its
  own. An account that is deleted takes all of it along.
  One thing an owner does see, because the owner answers for what the
  installation does: **what was run**. The log on the Servers page has
  "Servers handed over in conversations", with every command, the account it
  was run for and its output, and never what signs in; the log of the
  Browser page lists what was opened. Both stay after the machine or the
  account is removed.
- **Who may.** Every account, by default. `OWN_ACCESS` narrows it:
  `admins`, `owners`, or `off`. Anyone but an owner hands over machines and
  sites **on the public internet only**: an address on a private network, or
  a name that leads to one, is refused before anything is tried
  (`AGENT_HTTP_PRIVATE_HOSTS` lists exceptions). A user's assistant gets the
  browser only for the site accounts the user handed over, and only when the
  browser service says that it keeps pages from private networks (the one
  that comes with the app does).
  The app tries at most 12 sign-ins a minute for an account, and after six
  that **failed** within 15 minutes it tries no more for that account until
  they are over: a conversation is not a way to guess passwords from this
  installation's address. What was kept, replaced, switched off or removed
  is in the audit log, and so is every sign-in to a server that failed:
  who, where, and never the password.

**Chat keeps its conversations.** They are listed beside the transcript,
renamed and deleted there, and the address (`?c=…`) opens one again. The
assistant has these tools: `run_on_server` and `use_browser` (when there is
something to work on), `fetch_url`, `http_request`, `web_search` (when a
search is set up), `remember`, `recall` and `keep_access`. Each call is shown
with the answer, with what it was called with and the start of what came
back. One answer takes up to 16 steps and half an hour.

- **An answer is not the page's.** A command on a server can take minutes,
  and a phone sleeps. When the page goes away the answer goes on, is written
  to the conversation, and is there when the page is opened again; a
  conversation that is still being answered says so and takes no second
  message. **Stop** ends it: a command that is running is killed, the
  connection and the browser are closed, and what was done until then stays.
- **A page that needs a person** (a CAPTCHA, a code that was sent to you)
  waits for the account whose conversation it is, whatever its role: the
  conversation shows the link, and a notification is sent.
- **Which model.** An owner or an administrator picks one, or leaves it to
  the app. For a user the app chooses: the models marked **Tool calling**
  first, the ones that work before the ones that rest; up to three are
  asked. A step a model does not answer is asked of the next one, which
  goes on from what was done so far. Every model is offered the tools.
  Where a provider refuses a request because of them, the model is asked
  again without, and is told so, so that it does not write as if it had
  done anything. A model that takes the tools and never calls one only
  talks: which models of an installation do call them is found out with
  `workforce.sh --try-assistant-all`
  ([scripts/host/README.md](scripts/host/README.md)).
- The former form of `POST /api/chat`, the whole conversation in `messages`,
  is answered as before: one answer, no tools, nothing kept.

**Memory.** Two things are put in front of the assistant at the start of
every answer, without anyone asking: the **notes** that were kept about you
(by the assistant with `remember`, or by you on the Memory page; up to ten
that fit the message), and **what your other conversations said** about the
same thing (up to four passages, found by their words). A new conversation
therefore starts with what the earlier ones established. The planner and the
agents of your projects are told the notes as well. The **Memory** page
(for every account) lists the notes and everything you handed over, without
what signs in: a note is written or forgotten there, a server, site account
or key is switched off or removed, a key is tied to its site. A note holds
no password: what looks like one is taken out. Deleting a conversation
removes its messages from what is remembered; a note it left stays, and so
does what another conversation quoted from it.

**Projects.** How to sign in can be written into a project's goal, into the
instruction of one run, or into the instruction of a schedule, on the pages
and through the API: it goes the same way, the text is stored without it,
and the page says what was kept. A run is handed what its goal is about (a
server that is named, by its name or address, or the only one there is when
the goal says "my VPS"); each task is handed what its own text names, and
every task all of it when no task names any. The agent then has
`run_on_server`, `use_browser` or `http_request` for it, whatever tools are
ticked on it, and the project page says under the goal what that is.

What this is not, and what was tested:

- **The assistant acts with the rights you hand it.** With `root` it can do
  on that machine whatever root can. It is told to look before it changes
  anything and not to destroy data unless asked for exactly that; a model can
  still be wrong, and a page or a file it reads can try to talk it into
  something. Hand over an account with the rights the work needs, and keep
  backups.
- **A key written into a command goes where the command sends it.** The app
  limits where a key goes in a web request; on a server the command decides.
- **Finding by shape misses things and takes some wrongly.** A password in a
  sentence the app does not understand reaches the model in plain text. A
  password for something that is not SSH, written like a server's
  (`203.0.113.7 user app pass …`), is tried over SSH once, fails, and is
  taken out; say what it is for (`mysql password: …`) and send it again.
- A password you wrote into a chat was typed, sent and shown once. It is
  kept encrypted (AES-256-GCM, `ENCRYPTION_KEY`) and is in no log, no
  message and no request to a model, **but change it when the work is done**
  if it is one that matters, and hand over the new one when you need the
  assistant again.
- Tested: the whole way against the checks' own provider, SSH server and
  web site (`npm run test:e2e`, part `handover`, and the page checks), and
  the finder on some sixty messages in English and Indonesian
  (`tests/access-find.test.ts`). **Not tested: how well a particular real
  model uses these tools.** That depends on the model: one that does not
  take tools can only answer. On the machine the app runs on,
  `workforce.sh --try-assistant` asks the assistant of that installation
  for one thing it needs a tool for and says whether its model called it,
  and `--try-ssh <host>` whether the app reaches a machine over SSH from
  where it runs ([scripts/host/README.md](scripts/host/README.md)).

## What a project made (v1.12.0)

Until v1.12.0 a project that ended said "succeeded" and showed text: what
each agent wrote about its work, and a summary. The site, the plugin, the
pictures were in the workspace, behind a button. Now the project page starts
with **what was made**.

- **The result, on top of the project page.** A web site is shown the way a
  browser shows it, with its style sheets and its scripts, at full width or
  as wide as a phone, and opens in a tab of its own. Every file is listed by
  folder and looked at in place: a document as a document (headings, tables,
  lists, code), a page as the page or as its source, pictures, sound and
  video as themselves, anything else as text. Each file is downloaded by
  itself, and **Download all (.zip)** hands over everything in one file, the
  project's pictures and voice-overs under `media/` included. A task's card
  says which files it wrote, and the final deliverable is rendered, not
  shown as the marks it is written with.
- **The site runs in a sandbox, apart from the dashboard.** It is served
  under `/site/<token>/…`, where the token names the project, ends after 24
  hours and is signed by the server. The pages there get no cookie of the
  dashboard and no access to it: they are sent with `Content-Security-Policy:
  sandbox` (scripts and forms allowed, the origin of the app not), and only
  the app's own pages may frame them. Whoever has the address can look at
  the files of that project until it ends, without signing in: that is what
  the tab is for, and what to keep in mind before passing the address on.
- **A project that is built is built.** The files of a Gradle or a Maven
  project (a Minecraft plugin above all) are built **in the runner** when
  the run's tasks are done: `gradle build -x test` or `mvn package`, never
  the project's own wrapper. The package (`build/libs/*.jar`,
  `target/*.jar`, an add-on's `.mcaddon`, a `.zip` under `dist/`) is kept
  and **downloaded from the project page**, which says whether it is from
  the files as they are now. **Build** builds again at any time.
- **A build that fails goes back to the agent.** The agent that wrote the
  build file gets a task "Make the project build" with what the build
  printed, and the tool to run commands for that task, whether or not it was
  ticked for the agent; then the project is built again, twice at most. The
  manager and the reviewer are told how the build ended. A project that
  still does not build ends in `review` and says so, with the end of the
  build's output; **Let the AI fix it** on the page does the same once more.
- **Pictures and voice-overs without a model being chosen.** A goal that asks
  for images, voice-overs or videos gets them from a model the app chooses
  when the project names none (`AUTO_MEDIA`; a project whose media limit is
  0 gets none). A piece is planned with the file name it is kept under, so a
  page can refer to it: `media/hero.png`.
- **The runner.** Builds need the runner ([`scripts/host/runner/`](scripts/host/runner)):
  a container with JDK 17, 21 and 25, Gradle 8 and 9, Maven, Node.js and
  Python, where every program runs as a user without rights, and whose
  network reaches the internet and no private address. On a Pterodactyl node
  `runner-service.sh` sets it up next to the server and writes `SANDBOX_URL`
  into its `.env` (the actions `runner-plan` and `runner` of the Deploy
  workflow). **Without a runner nothing is built**, and the page says so; the
  files are shown and downloaded all the same.

| | |
|---|---|
| `GET /api/projects/{id}/result` | What there is: the files with their kinds and sizes, the site and the address of its preview, the media, what was built, and how the project is built. |
| `GET /api/projects/{id}/download` | Everything as one `.zip`. |
| `GET /api/projects/{id}/file?path=` | One file, as a download. |
| `POST /api/projects/{id}/build` | Build now. `400 nothing_to_build` when the files are no Gradle or Maven project, `400 execution_disabled` without a runner, `409 build_active` while a build of the project runs. |
| `GET` / `DELETE /api/projects/{id}/built/{fileId}` | A package, and removing it. |

Limits: a project keeps up to 40 built files and 256 MB of them, and a new
package takes the place of the ones from the same folder. A build may run as
long as `SANDBOX_MAX_SECONDS` allows (900 seconds on a node set up by the
script). What is built is what the build file says: a build that needs a
private repository, or a JDK other than 17, 21 or 25, fails and says why.

What was tested: the pages and the API against the providers and the runner
of the tests, in a real browser; the runner's image built in CI, with real
builds of a Paper plugin (Gradle 8 and 9) and a Maven project in it, its
network rules, and one run after another.

## Provider adapters

A new provider can **start from** a known one: the form's first field fills in
the name, the address and how the provider signs in, for providers that take
no key, ones that give a free key, and the paid ones. It says in a line what
each gave for nothing when the list was read, and where a key is made; what a
provider gives away changes, and its own site says what holds now. A provider
of your own is filled in by hand, as before.

A provider's adapter is the protocol the gateway speaks to it.

| Adapter | Chat | Tools | Embeddings | Images | Speech | Videos |
|---|---|---|---|---|---|---|
| `openai-compatible` | ✓ streaming | ✓ | ✓ | ✓ | ✓ | ✓ |
| `anthropic` | ✓ streaming | ✓ | | | | |
| `gemini` | ✓ streaming | ✓ | ✓ | ✓ | ✓ | |
| `custom-http` | ✓ | | | | | |

All four are tested against local mocks written from the providers' public
documentation. Against live services, on one server on 2026-11-15:
`openai-compatible` for chat, agents with tools and images (Kilo Gateway,
OVHcloud AI Endpoints, LLM7), and `gemini` for chat and speech. `anthropic`
got as far as the provider's refusal of an account without credit, and
`custom-http` was **not run against a live service**; nor were embeddings and
videos with any provider. A feature that is not ticked is not offered for
models of that provider.

### A provider that says "not now"

A provider answers 429 when its requests for the minute are used up, and 503
when it is busy; a tier that costs nothing does so all the time. The app then
waits and sends the request again: as long as the provider asks, or 3, 10, 25
and 45 seconds, for a busy provider twice and no more. `PROVIDER_RETRIES`
sets how often (4 unless set; 0 turns it off). A model that was waited for in
vain, because its quota is used up for the day, is not waited for again for
five minutes, then a quarter of an hour, then an hour at a time: a request
gets the provider's answer at once, until the model answers again.

In a project, an agent whose model still does not answer goes on with its
second model, and then with the project's manager model; so does the review.
The agent keeps its tools on the way: only a request that the model refused
is tried once more without them. `GET /api/projects/{id}/attempts` lists
every attempt of the last run's tasks, with the model that was asked, the
time it took, and what the provider said.

When none of a task's models answers, the task waits for their limits and
asks again, for an hour unless set otherwise, and a run that stopped all the
same is taken up again with **Continue**: see
[Runs that meet a limit](#runs-that-meet-a-limit-v190).

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
- certain models (an administrator's key);
- a number of requests a minute (120 when nothing is set);
- a number of tokens a month, and for an administrator's key an estimated
  cost a month, counted from the first of the month (UTC);
- a date after which it no longer works.

A key can be revoked at any time, and a user can have up to 20.

**A user's key names no model.** `GET /models` lists one, `auto`, and every
request sends `"model": "auto"`: the app chooses, as it does on the pages
([What a user is shown](#what-a-user-is-shown-v180)). Another name is answered
404 `model_not_found`, and the answers say `auto` where they would say the
model. An administrator's key names the models as listed, and can send `auto`
as well.

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
| `POST /projects/{id}/runs` | Projects | Start a run. The body is optional: `{"input": "an instruction for this run"}`, and `{"continue": true}` to take up the last run again, doing only its tasks that did not succeed (v1.9.0). Answers `202` with the run `queued`, `409` when the project is already running (`run_active`) or has nothing to continue (`nothing_to_continue`), and `200` with the reason when the run cannot start. A run says `"continued": true` when it continued the one before it. How to sign in to a server, a site or an API, written into `input`, is taken out before the run is stored (v1.11.0): the answer then has `access_kept`, a list of `{kind, name, where, kept, replaced, note}`. |
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
| 1.3.0 | Advanced Orchestration (parallel, limits, approval, observability, auto-routing, workflows; the token budget of a project went in v1.8.1) | ✅ implemented (step-based workflow builder) |
| 1.4.0 | Creative Workflows (image and video generation, Creative Studio, media tasks, Reel template) | ✅ implemented (tested against a mock provider, not a live one) |
| 1.5.0 | Automation, tools and knowledge (background runs, schedules, notifications, agent tools and memory, knowledge base, voice-over, joined videos, Gemini and custom HTTP adapters, API) | ✅ implemented (tested against mock providers, not live ones) |
| 1.6.0 | Free providers (waiting for a provider that is limited or busy, the next model with its tools, every attempt of a task, the host scripts) | ✅ implemented (seen at work on one real server) |
| 1.7.0 | Skills and owners (SKILL.md, .skill and .zip uploads; skills of agents and of teams; the read_skill tool; an owner who manages the accounts; a reviewer that is shown the files) | ✅ implemented (seen at work on one real server; how well a model follows a skill was not measured) |
| 1.8.0 | Models that answer (an automatic check of every chat model; a failing model is left out of the lists until it answers again); tokens of an account (a limit for every account, set by an owner); what a user is shown (no provider and no model: the app chooses); servers over SSH (one connection that stays open until a run has ended; only machines an owner registered; every command logged); the browser (agents open sites and sign in with saved accounts; a CAPTCHA or a code is left to a person, who does it in the same browser; the session is kept) | ✅ implemented (five candidates ran on one real server, where the browser service was set up; what the parts do was tested against mock providers, an SSH server and a web site of the tests, and not seen on that server) |
| 1.9.0 | Runs that meet a limit (Continue: a run is taken up again with what it finished; a task waits for a limit of its models that ends; a quota answer in few words, and what each model of a task said) | ✅ implemented (tested against providers of the tests; not waited through against a live provider's quota) |
| 1.10.0 | A run goes on with a model that works (stand-ins for the models a task and a run are set to; what real work says about a model: resting, put away, back by itself; a switch for each project; the host signs in as owner without a password; a report of the app's models) | ✅ implemented (tested against providers of the tests; the report of the models was read from one real server, whose failed run it explains) |
| 1.11.0 | Access handed over in a conversation (a server, a site account or a key written into a message is taken out before a model sees it, tried, kept encrypted, and worked with by the assistant and by the agents of the account's runs); Chat keeps its conversations and has tools; memory of an account across conversations and projects; an answer that goes on without its page | ✅ implemented (tested against the checks' own provider, SSH server and site) |

---

## Tech stack

- **Next.js 14** (App Router) + **TypeScript** + **Tailwind CSS**
- **Drizzle ORM** + **better-sqlite3** (SQLite — single file, no external DB)
- **otplib** (TOTP) + **qrcode**, **zod** (validation), **unpdf** (reading
  PDF text), **ssh2** (the connections to servers; without its optional
  compiled parts)
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

On first boot, if the users table is empty and `BOOTSTRAP_ADMIN_*` are set, the
owner's account is created from those values. **Log in and change the password
immediately** (Settings). Alternatively, leave bootstrap unset and the first
account you register through the UI becomes the owner.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SECRET_ENCRYPTION_KEY` | **yes (prod)** | base64 of 32 bytes; encrypts provider keys, TOTP secrets and what signs in to servers at rest. Keep it out of the DB and out of git, and keep it across upgrades. |
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
| `MODEL_HEALTH_INTERVAL_MINUTES` | no | How often the app checks that a chat model still answers, in minutes: default 360, between 5 and 10080; `0` = no automatic check. A model that fails is left out of the model lists until a check passes. |
| `MODEL_HEALTH_RETRY_SECONDS` | no | Before a model that worked is left out for "too many requests", "busy" or no answer, it is asked once more after this many seconds: default 20, at most 300. |
| `DEFAULT_TOKEN_LIMIT` | no | How many tokens a new account may use in all: default 10000000. An owner changes the limit of an account under Users & Roles; an owner is not limited. |
| `SSH_KEEPALIVE_SECONDS` | no | How often an open connection to a server says that it is still there: default 15, between 1 and 300. Lower it for a network that forgets a quiet connection sooner. |
| `BROWSER_URL` | no | Where the browser service is, with its token: `http://host:9223/?token=…`. **Unset = no browser** (agents are not handed the tool "Work in a browser"). See `scripts/host/browser/`. |
| `BROWSER_WAIT_MINUTES` | no | How long a page waits for a person who has to pass a CAPTCHA or enter a code: default 15, between 1 and 240. |
| `BROWSER_MAX_PAGES` | no | How many pages all agents together may have open in the browser: default 8, between 1 and 50. |
| `PROVIDER_RETRIES` | no | How often a request to a model provider is sent again when the answer is 429 (too many requests): 0 to 8, default 4; `0` = never. It waits as long as the provider asks (up to 90 seconds), else 3, 10, 25 and 45 seconds; two and a half minutes at most for one request. A provider that says it is busy (503, 529) is asked again twice. A model that was waited for in vain is not waited for again for five minutes, then for longer, until it answers. |
| `RUN_LIMIT_WAIT_MINUTES` | no | How long a task of a project waits for its models when all of them say "not now" (429, 503, 529), asking them again meanwhile: 0 to 1440 minutes, default 60; `0` = it does not wait and fails at once. It never waits for a limit that does not end in that time (a quota per day, an account without credit). |
| `MODEL_STAND_INS` | no | Whether a run goes on with another model that works when the models a task, or the run itself, is set to do not answer: on unless `0` (also `off`, `false`, `no`). A project can say for itself (**Go on with another model**). A stand-in never costs more than the dearest model the task was set to. |
| `BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD` | no | first-run admin (only used when no users exist) |
| `ALLOW_PRIVATE_PROVIDER_HOSTS` | no | comma list of hosts allowed to bypass the private-range block, for local model endpoints or the sandbox runner (e.g. `127.0.0.1,ollama.local`) |
| `SANDBOX_URL` | no | URL of an isolated runner. **Unset = execution disabled** (nothing runs on the app host, and no project is built). See [`scripts/host/runner/`](scripts/host/runner); on a Pterodactyl node `runner-service.sh` sets it up. |
| `SANDBOX_TOKEN` | no | bearer token the app sends to the runner |
| `SANDBOX_ALLOWED_COMMANDS` | no | comma list overriding the default command allowlist |
| `SANDBOX_MAX_SECONDS` | no | The longest a program or a build may run in the runner: default 120, between 10 and 3600. `runner-service.sh` sets 900, for Gradle. |
| `BUILT_PATH` | no | Folder for what builds made, the packages that are downloaded from a project's page (default: a `built` folder next to the database file, so `./data/built`). Back it up together with the database. |
| `AUTO_MEDIA` | no | Whether a project that names no model for pictures, voice-overs or videos gets them from a model the app chooses, when its goal asks for them: on unless `0` (also `off`, `false`, `no`). |
| `SEARCH_PROVIDER` | no | The search service behind the agent tool *Search the web*: `brave`, `tavily` or `searxng`. **Unset = the tool is unavailable.** |
| `SEARCH_API_KEY` | no | The key of that service (not needed for SearXNG). |
| `SEARCH_URL` | no | The search address: required for `searxng` (its `/search`), optional otherwise. |
| `AGENT_HTTP_ALLOWED_HOSTS` | no | comma list of hosts, subdomains included, that agents may reach with *Read web pages* and *Call HTTP APIs*. Unset = any public host. |
| `AGENT_HTTP_PRIVATE_HOSTS` | no | comma list of hosts on a private network that agents may reach all the same. |
| `OWN_ACCESS` | no | Who may hand over a server, a site account or a key in a conversation or in a project's goal ([v1.11.0](#access-you-hand-over-in-a-conversation-and-memory-v1110)): `everyone` (default), `admins`, `owners`, or `off`. Narrowing it keeps what was handed over, unused, until it is widened again. |
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
puts the workforce of a file into the running app (providers that take no
key, models with their prices, agents, teams and workflows), signed in as its
administrator. It can ask each model for one word to see whether the provider
lets it be called, and have the agents do a small project. The file of this
repository uses [providers that cost nothing](scripts/host#providers-that-cost-nothing).

The same folder has a read-only disk report for tidying up a node, and a way
to run all of these without signing in to the node yourself: `over-ssh.sh`
from another machine, or the workflow **Deploy to a Pterodactyl node** from
GitHub Actions, which is started by hand and signs in with secrets of the
repository ([how](scripts/host#from-somewhere-else-over-sshsh)).

## Security model

- Passwords: scrypt (salted, memory-hard), constant-time comparison.
- What an account hands over in a conversation (v1.11.0): the password, the
  private key or the key is taken out of the text before a model is asked
  and before anything is stored, and kept with the other secrets
  (AES-256-GCM). No model, no message, no log and no page holds it; a key's
  value is put in by the app where the AI writes its name, and is struck
  from what comes back. It is used by its own account's conversations and
  runs only. Anyone but an owner reaches public addresses only, and sign-ins
  that fail are counted and limited.
- Secrets at rest: AES-256-GCM with a key kept **outside** the database.
- API keys are never serialized to the client — only `configured` + last 4.
- Sessions: `HttpOnly`, `SameSite=Lax`, and `Secure` (HTTPS-only) in
  production; rotated after login and 2FA, destroyed on logout / 2FA change /
  password change / account disable.
- Accounts are changed by an owner only, and one's own sign-in details only
  with the current password. No password is logged or returned.
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
- Servers over SSH: only an owner registers a machine, and an agent reaches
  only the machines its project names, by name. The password or private key
  is stored encrypted and never returned. The machine's host key is read and
  shown before anything is sent to it, and pinned: a machine that shows
  another key is not signed in to. A project that names servers is run,
  changed and scheduled only by an account whose own projects may use them.
  Every command and every connection is logged, and the log outlives the
  project and the machine.
- The browser: it runs apart from the app, behind a token, and refuses
  private networks for everything a page loads. Only an owner saves a site
  account; its password is stored encrypted, typed by the app on the
  account's own site only, and kept out of everything an agent reads, also
  when a page shows it. The session a sign-in leaves is stored encrypted.
  Each run has a browser of its own inside the service (its own cookies),
  closed when the run has ended. A page that waits for a person is shown to
  the account the run works for and to owners, to nobody else. No CAPTCHA
  is solved or passed by the app. Every action is logged.
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
- What has run against live providers, on one server in November 2026: the
  `openai-compatible` adapter (chat with tools at four providers that take
  no key, pictures at one of them) and the `gemini` adapter (chat, speech).
  The `anthropic` adapter was only refused there, for a key without credit;
  video generation, embeddings and `custom-http` have run against the mock
  alone.
- **Prompt injection.** A web page, a search result or a document that an
  agent reads is text someone else wrote, and it can try to talk the model
  into misusing the agent's other tools. Nothing in the app can rule that
  out. Give an agent only the tools its role needs, keep *Call HTTP APIs*
  and *Run commands* away from agents that read the open web, and use
  `AGENT_HTTP_ALLOWED_HOSTS` where you can.
- Agent memory and the knowledge base are stored unencrypted in the database.
- **An agent on a server can do what the registered account can**, and it
  decides by itself which commands to run. The app does not look at a
  command before it is sent, and cannot tell a harmful one from a useful
  one: `rm -rf` is both. What limits an agent is the account you register
  (not root, where the work does not need it), the servers a project names,
  and which agents have the tool. Keep that tool away from agents that read
  the open web. A command is logged as it was written, with a password in
  it if the agent wrote one there, and what it printed is kept in the log
  unencrypted.
- The host key of a machine is trusted from the moment an owner accepts it.
  The app shows the fingerprint and how to compare it; it cannot know by
  itself that the first answer came from the right machine.
- **An agent in the browser can do on a site what the account can**, and it
  reads pages other people wrote: a page can try to talk the model into
  doing something else with the account it is signed in with. The app keeps
  the password from the agent and writes down what the agent does; it does
  not judge an action before it is taken. What limits an agent is the
  account you save (one with the rights the work needs), the accounts a
  project names, and which agents have the tool.
- How the app finds a sign-in form, and how it sees that a page asks for a
  person, are rules of thumb: a form it does not recognise is not filled
  in, and a check it does not recognise is seen by the agent or not at all.
  Either way the page can be handed to a person. Sites that turn automated
  browsers away will turn this one away too.
- The browser service is a Chromium without its own sandbox (a container
  does not give it the rights for one): the container is the boundary. The
  runs that are in the browser at one time share that Chromium, each with
  its own cookies. Keep the image up to date (`--rebuild`).

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
                           # agent (tools, memory), knowledge, skills, worker, schedules, notifications, public-api, usage, stats…
  instrumentation.ts       # starts the background worker with the server
assets/fonts/              # the font for subtitles (Noto Sans Bold, SIL Open Font License)
drizzle/                   # generated SQL migrations
scripts/                   # release tooling: package, smoke-test, publish, download
scripts/e2e/               # mock provider and end-to-end checks
scripts/host/              # for a Pterodactyl node: install, upgrade, the site in nginx, disk report, the workforce from a file
                           # with its skills (scripts/host/skills), running them over SSH, and their tests
scripts/host/runner/       # the runner programs and builds run in (Docker), set up by scripts/host/runner-service.sh
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
custom HTTP adapter's templates, waiting for a provider that says "not now"
(which answers are asked again, the waits, a model waited for in vain), cron
expressions and time zones, the agent's tool loop, skills (the ZIP reader
with archives that lie about their size or leave their folder, front matter,
what an upload is read as, what an agent is told), document reading and
passage ranking for the knowledge base, the timeline, subtitles and ffmpeg
command line of a joined video, the API's request and response format,
servers over SSH (who may use one, host keys and their fingerprints, the
line a command is sent as and the one that ends it, both run in a real
shell, what a command printed, what an agent is told), the browser (which
host is a site's, where a password may be typed, which cookies are a
site's session, what asks for a person, what an agent reads of a page and
what is kept out of it; the gate of the browser service: private addresses
however they are written, where a page may go, its proxy with real
connections, the token), access handed over in a conversation (what is found
in a message and what is left where it is, in English and Indonesian; who
may hand access over; where a key may be sent; what a run is handed; the
marks the app writes are nobody's password), the upgrade of a 1.10
database, what a project made (the kinds of files, what is a web site and
what is built how, the ZIP that is written, Markdown, the token of a
preview, what is kept of a build), the turns a build takes back to its
agent, the runner's server, and the release tooling
(channels, version ordering, release selection, checksums).

On every push, CI runs typecheck, lint and these tests, the end-to-end checks
below, and the tests of the [host scripts](scripts/host#tests). It then builds
each release bundle and starts it: the bundle must refuse to run without its
key, serve pages on a panel-assigned port, sign in (SQLite + migrations), keep
the session, read a PDF into the knowledge base, sign in to a machine over SSH
and run a command there, connect to a browser service, have its background
worker running, and stop within seconds when told to. Last, the bundle of v1.4.0 is
upgraded to the new one on a made-up Pterodactyl host.

The provider/model/gateway/streaming paths **and** the full plan → delegate →
execute → synthesize orchestration loop have been verified end-to-end against a
local OpenAI-compatible mock. The Anthropic adapter was run through the same
paths against a local mock written from Anthropic's API reference; since
v1.5.0 that is part of the end-to-end run below. It has not been run against
the live API beyond a refused request. What was run against live providers
is said under [Provider adapters](#provider-adapters).

The end-to-end run is part of this repository:

```bash
npm run build
npm run test:e2e
```

It starts a mock provider ([`scripts/e2e/mock-provider.mjs`](scripts/e2e/mock-provider.mjs))
and the built app on a throwaway database in the system's temporary folder,
and makes about 1,500 checks through the app's HTTP API. From v1.4.0: the
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
signed webhooks; and the API with its keys and limits. From v1.6.0: the
record of every attempt, an agent that keeps its tools when its model is
limited, and a review by the reviewer's second model. From v1.8.0: servers
over SSH, against a real SSH server on the machine of the tests
([`scripts/e2e/mock-ssh.mjs`](scripts/e2e/mock-ssh.mjs)) that runs what it is
told with `sh` in a folder of its own: one connection for a whole run, kept
open while a firewall of the test cuts every connection that says nothing
for three seconds; a connection that is cut and opened again; a command
whose time is up and a run that is stopped, with nothing left running; a
machine that shows another host key, takes another password, or does not
answer; and who may register, see, use and run what. And the browser,
with a real Chromium behind the gate of the browser service and a site the
tests start themselves ([`scripts/e2e/mock-site.mjs`](scripts/e2e/mock-site.mjs)):
an agent that reads a page and acts on it; signing in with a saved account,
with the password in nothing the model is sent and nothing that is kept;
the session that lets the next run in; a CAPTCHA on a form, a code after
the password and a page that is nothing but a check, each handed to a
person whom the tests play (a click on the page's picture, in a frame of
another site that no agent reaches); a page nobody takes over; private
addresses and files that are not opened; and who may. From v1.9.0: a run
that stops at the limits of its models and is continued, with what it had
done kept and not asked for again; a task that waits for a limit and goes
on, one that waits in vain, one that is stopped while it waits; and quota
answers in the shape Google sends them, for a quota per minute (waited for)
and per day (not waited for). From v1.10.0: a task whose models do not
answer done by a stand-in, and the run's result with it; a model that rests
after one request without an answer, is put away after three or after one
answer that asking again does not change, and is back when it answers; a
model that is put away asked last; a project that wants no stand-in; and
never a stand-in that costs more. From v1.11.0: a server, a site account
and a key written into a message of Chat, by a user and by an owner: taken
out before the provider is asked (the mock records every request, and none
holds a password), tried against the SSH server and the site of the tests,
used by the assistant in that conversation and in a new one, by the
account's project runs, and by nobody else; a wrong password, an address
on a private network, sign-ins that keep failing; a key that is sent to its
site and to no other; notes and earlier conversations in front of the
assistant; an answer that goes on when its page goes away, and one that is
stopped. From v1.12.0: what a project made, with a runner of the tests that
builds what it is sent ([the result](#what-a-project-made-v1120)): a site
served under its token, with a token that is forged, ended or of another
project refused, and no way from one project's address to another's files;
the download of everything and of one file; a plugin that is built at the
end of its run, a build that fails and is made to work by the agent that
wrote it, one that never works, and a build asked for from the page; and
pictures made for a project that names no model. At the end the server
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

The browser part needs a Chromium: the one `E2E_CHROME` names, else the one
of `E2E_BROWSER`, else one that is installed. Without any, it checks what the
app says when there is no browser; `E2E_REQUIRE_CHROME=1` makes that an
error. CI runs it twice: with the runner's Chrome, and against the browser
service in its container, built from `scripts/host/browser`.

`E2E_BROWSER=<folder with puppeteer-core and @sparticuz/chromium>` also
opens every dashboard page in a headless browser and clicks through the new
parts; that pass is not part of CI.

---

Designed by Xiero · Xiero Nexus AI
