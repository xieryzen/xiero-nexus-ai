# Changelog

All notable changes to Xiero Nexus AI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Release channels (stable, rc, beta,
alpha, dev) are described in [RELEASING.md](RELEASING.md).

## [Unreleased]

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
