# Changelog

All notable changes to Xiero Nexus AI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Release channels (stable, rc, beta,
alpha, dev) are described in [RELEASING.md](RELEASING.md).

## [Unreleased]

### Added

- Anthropic provider adapter. A provider on the `anthropic` adapter can be
  tested, have its models discovered, and be used for chat (streaming
  included), agents and project runs, through Anthropic's Messages API with
  API version `2026-10-21` by default. Text chat only; temperature is not
  sent, because that API version rejects it. Tested against a local mock of
  the API, not against the live service. Setup and limits are in the README
  under "Provider adapters".

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
