# Changelog

All notable changes to Xiero Nexus AI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Release channels (stable, rc, beta,
alpha, dev) are described in [RELEASING.md](RELEASING.md).

## [1.5.0] - 2026-11-15

Runs that go on in the background, tools and memory for agents, a knowledge
base, voice-over and joined videos, two more provider adapters, and an API.
As before, everything that talks to a provider was tested against a local
mock of the providers' APIs, written from their public documentation, and
**not against a live provider**. The two scripts for a Pterodactyl host were
tested against a stand-in for Wings, **not on a real node**. The README
describes each part under "Automation, tools and knowledge".

### Added

- **Runs in the background.** A project run is carried out by a worker inside
  the server instead of by the page that started it. It goes on when the page
  is closed, can be followed from any browser, and is picked up again after
  the server restarts. Three runs work at the same time (`RUN_CONCURRENCY`);
  further ones wait their turn.
- **Run history.** Every run of a project is kept with what it delivered. A
  run can be given an instruction of its own, and with *Memory* switched on a
  run is told what the earlier runs delivered.
- **Schedules.** A project can run by itself, at the times a cron expression
  names in a time zone, with an instruction for those runs. The form says the
  schedule in words and shows the next times.
- **Notifications.** A bell in the dashboard says when a run finished, failed
  or waits for approval, when a joined video is ready, and when something in
  the background went wrong. Each user can also have them sent to a
  **webhook**, signed with a secret.
- **Tools for agents.** An agent can be allowed to list, read, write, edit and
  delete files of the project's workspace, run commands in the sandbox runner,
  read web pages, call HTTP APIs and search the web (Brave, Tavily or
  SearXNG). It then works in steps, up to a limit set per agent, and every
  call is shown under its task. Needs a model that supports tool calling, on
  the OpenAI-compatible, Anthropic or Gemini adapter.
- **Memory for agents.** An agent with memory can keep short notes and look
  them up in later runs.
- **Knowledge base.** Collections of documents (pasted text, files, web
  pages) that agents and the chat can look things up in. Text, Markdown, CSV,
  JSON, HTML, PDF and .docx files are read. Search by words works at once and
  without a model; with an embedding model on the collection, search also
  goes by meaning.
- **Voice-over.** Text to speech in Creative Studio and as a task in
  projects, for speech models on the OpenAI-compatible and Gemini adapters.
- **Joining clips into one video.** Clips and still images are joined in
  order into one MP4, with voice-overs laid over them and, if wanted, their
  words as subtitles. This is done on the server and needs ffmpeg 4.2 or
  newer there (`FFMPEG_PATH`); without it everything else works and the page
  says what is missing.
- **A video can start from an image**: one from the library, or an uploaded
  one.
- **Reel template: voice-over and final cut.** The template can add a
  voice-over per scene and a last step that joins everything into one
  vertical video with subtitles.
- **Google Gemini adapter**: chat with streaming and tools, embeddings, image
  generation, speech, and model discovery.
- **Custom HTTP adapter**: chat with a JSON API that follows none of the
  known protocols. The provider's configuration says how a request is written
  and where the answer is in the response.
- **Tool calling** on the OpenAI-compatible and Anthropic adapters, and
  **embeddings** on the OpenAI-compatible adapter.
- **An API for other programs**, under `/api/v1`, in the format of OpenAI's
  API: models, chat completions (with tools and streaming), embeddings,
  images, speech and videos, plus starting project runs and reading their
  results. Access is by **API keys** made under Settings, each limited to
  what it may do, optionally to certain models, a number of requests a
  minute, and a number of tokens and an estimated cost a month.
- `GET /api/health` answers without signing in: `{"status":"ok"}` when the
  server and its database work. For uptime checks.
- Models have a price per million characters, for the cost estimate of
  speech. Usage & Costs lists speech and embedding requests.
- The status page (Observability) shows the background worker and what is
  waiting, and whether ffmpeg, the sandbox runner and a search provider are
  set up.
- **Two scripts for a Pterodactyl host**, in `scripts/host/`: one upgrades
  the app on a server from the node, with a backup, and goes back by itself
  when the new version does not come up; the other makes a read-only report
  of what fills the node's disk. See [RELEASING.md](RELEASING.md).
- `npm run test:e2e` now covers all of the above (about 590 checks) and the
  Anthropic adapter, which had no mock in this repository before. It can
  also click through the dashboard in a headless browser.

### Changed

- A video in progress is now checked on by the server, whether a page that
  shows it is open or not.
- The server stops within a few seconds when it is told to (the Stop button
  of a hosting panel, `docker stop`), also while pages are connected to it.
  Before, an open connection, such as a page following a run, could hold the
  stop until the panel killed the process.
- Dates and times are shown in the reader's own time zone and language, and
  "5m ago" stays current while a page is open.
- Model discovery sets the type of a model it recognises by its name as an
  image, video, speech or embedding model, marked as unverified. Before,
  every discovered model was imported as a chat model.
- A release bundle now carries a font for subtitles and the PDF reader, and is
  about 8 MB instead of 7 MB.
- CI runs the end-to-end checks and the tests of the host scripts.

### Fixed

- A project that was running when the server stopped stayed "running" for
  good and could not be run again. Runs are now picked up after a restart,
  and a project that an older version left like this is ended about a minute
  after the upgrade, with the message "The server stopped while this project
  was running. Run it again."
- The Copy button for recovery codes did nothing on a site opened over plain
  HTTP.
- An image or video model found by discovery showed up in chat and could not
  be chosen in Creative Studio until its type was set by hand.
- Some pages logged an error in the browser's console when the reader's time
  zone or language was not the server's.
- Buttons in page headers wrapped onto several lines on narrow screens.

### Upgrading

- The database is updated on the first start. **Back up `data/` first**: a
  database that 1.5 has opened cannot be used by 1.4 again.
- On Pterodactyl, `scripts/host/pterodactyl-upgrade.sh` does the upgrade with
  a backup; see "Upgrading on Pterodactyl" in [RELEASING.md](RELEASING.md).
- Set `APP_URL` to the public address of the site. Links in webhook messages
  and the file links the API returns are built from it.
- Nothing has to be configured for the new parts to appear. Joining clips
  needs ffmpeg on the server; web search needs `SEARCH_PROVIDER` and a key;
  running commands needs the sandbox runner, as before. The new settings are
  in `.env.example`.
- Agents keep working as before until they are given tools.

## [1.4.0] - 2026-11-12

Creative Workflows: image and video generation. It was tested against a local
mock of the providers' APIs, written from their public documentation, and
**not against a live provider**; the same goes for the Anthropic adapter. Setup
and limits are in the README under "Creative Workflows" and "Provider
adapters".

### Added

- Image and video generation through the gateway, for providers on the
  OpenAI-compatible adapter. A provider has a new **Image / video API** setting
  (Auto, OpenAI-style, OpenRouter, xAI) that says how its media requests are
  written.
- **Creative Studio**: write a prompt, choose a model, an aspect ratio, and
  the number of images or the length of a video, see a cost estimate, and
  generate. A video shows as in progress until the provider has finished it.
- **Media library**: generated files are stored on the server and can be
  previewed, played, downloaded, reused and deleted. Users see their own media;
  administrators can see everyone's. `MEDIA_PATH` sets the folder; the default
  is `media` next to the database file (`./data/media`).
- Models have a **Model type** (chat, image generation, video generation) and
  a price per image and per second of video, used for cost estimates. The new
  capability is *Video generation*.
- Projects can have an **image model**, a **video model** and a **media
  limit**. A task can then deliver an image or a video: its agent writes the
  prompt and the project's model generates the file, which is shown in the
  project. A running task says what it is doing.
- Workflow steps can deliver an image or a video, with an aspect ratio, a
  length and a resolution, and have a field for acceptance criteria.
- **Reel template** in the workflow builder: concept and script, storyboard,
  one vertical clip per scene, a cover image, and a caption with hashtags. The
  clips are separate files; they are not joined into one video.
- Usage & Costs lists image and video requests, with an estimated cost when
  the model has a price.
- `npm run test:e2e`: end-to-end checks of image and video generation against
  a mock provider that is part of the repository (`scripts/e2e/`).
- Anthropic provider adapter. A provider on the `anthropic` adapter can be
  tested, have its models discovered, and be used for chat (streaming
  included), agents and project runs, through Anthropic's Messages API with
  API version `2026-10-21` by default. Text chat only; temperature is not
  sent, because that API version rejects it.

### Changed

- A model marked *Image generation* (or *Video generation*) and not *Text* is
  now an image or video model: it is offered in Creative Studio and for media
  tasks, and no longer for chat, agents, the AI Manager or automatic routing.
  Earlier versions did not act on the mark, apart from automatic routing by
  capability. **After upgrading**, if a chat model carries that mark without
  *Text*, open Models, choose Edit and tick *Text*. Until then, an agent that
  uses such a model is answered by the project's manager model in project
  runs.
- Creating a project with a workflow that does not exist is refused. Before,
  the project was created and every run of it failed.
- The workflow builder renumbers "depends on" when a step is moved or removed.
  It no longer drops an unfinished step without saying so, and refuses a step
  that depends on a later one.

### Fixed

- Project runs: a task now receives the output of the tasks it depends on.
  That context was always empty before, so a task saw only its own objective.
- Opening some dashboard pages while signed out logged an error on the
  server, although the browser was correctly sent to the sign-in page.

### Upgrading

- The database is updated on the first start, as always. Generated files are
  kept in `data/media/`, so include that folder in backups.
- Existing projects have no image or video model, and a project's models are
  chosen when it is created: make a new project for media tasks.

## [1.3.1] - 2026-11-11

### Fixed

- `get-release.mjs` no longer depends on the GitHub API for the newest stable
  release, an exact version or `dev`. It uses GitHub's plain download links
  there, so it keeps working when the API's small anonymous allowance for a
  network address is used up. The `rc`, `beta` and `alpha` channels and
  `--list` still ask the API.

### Changed

- `get-release.mjs` rejects a word that is neither a channel nor a version,
  instead of searching for it.

## [1.3.0] - 2026-11-11

First published release. It includes everything from the 1.0.0–1.2.0
development milestones, which are listed further down in CHANGELOG.md.

### Added

- Parallel task execution: independent tasks run concurrently in
  dependency-ordered waves, capped by a per-project `maxParallel`.
- Per-project token budget, task limit and parallelism limit. A run stops and
  cancels its remaining tasks when the token budget is exceeded.
- Approval policy: a project can require an admin's approval before each run.
- Observability dashboard with per-agent run metrics (runs, success vs error,
  average latency, tokens) and recent agent runs.
- Automatic model routing: an agent in `auto` mode uses the cheapest enabled
  model, optionally restricted to a required capability.
- Step-based workflow builder: reusable ordered plans a project can run instead
  of AI-Manager planning.
- Releases: every push publishes ready-to-run bundles for Node.js 20 and 22
  (Linux x64). Each version gets a GitHub Release on the channel its suffix
  names (stable, rc, beta, alpha), and `dev-build` always holds the newest
  commit. See RELEASING.md.
- `get-release.mjs` downloads a release by channel or version and verifies its
  checksum.
- The dashboard shows the running version, channel and commit.
- `COOKIE_SECURE=false` allows sign-in over plain HTTP, for deployments without
  HTTPS.

### Fixed

- In production, signing in on a plain `http://` address silently did nothing,
  because browsers drop HTTPS-only cookies there. The sign-in and registration
  pages now say so and explain what to change.
- A production instance without a valid `SECRET_ENCRYPTION_KEY` now fails
  early, instead of later when a provider key is first stored.

### Removed

- `SESSION_SECRET`. It was documented as required but was never used; delete it
  from `.env`.

## [1.2.0] - 2026-11-11

Development milestone, published as part of 1.3.0.

### Added

- Project workspaces with path-validated file management.
- Sandboxed code execution through an external isolated runner. Code never runs
  on the application host; execution is disabled unless `SANDBOX_URL` is set.
  A reference runner lives in `sandbox-runner/`.
- Execution guardrails: command allowlist, shell-metacharacter rejection,
  per-run timeout and output caps.
- Workspace version snapshots (commit and restore).
- QA/Security review step after each run, and an optional hard QA gate that
  keeps a project in `review` unless the reviewer's verdict is `pass`.
- Remote Git: push the workspace to a GitHub repository as one commit through
  the GitHub Git Data API. Not yet tested against a live repository.

## [1.1.0] - 2026-11-04

Development milestone, published as part of 1.3.0.

### Added

- Agents (role, instructions, primary and fallback model, temperature) and teams.
- AI Manager orchestration: plans a goal into tasks, assigns them to agents and
  runs them in dependency order, with bounded attempts and cancellation.
- Task states, artifacts and per-attempt agent runs, with live progress over
  server-sent events.

## [1.0.0] - 2026-11-03

Development milestone, published as part of 1.3.0.

### Added

- Username/email/password authentication with scrypt hashing and database-backed
  sessions.
- Optional per-user two-factor authentication (TOTP) with single-use recovery
  codes.
- Admin and user roles enforced on every protected endpoint.
- Provider management with API keys encrypted at rest (AES-256-GCM) and never
  returned to the browser.
- SSRF protection for provider Base URLs.
- Model catalog with discovery, manual registration, capabilities and tests.
- Model gateway with an OpenAI-compatible adapter and streaming chat.
- Usage and estimated-cost tracking, and an audit log.
