# Releases

Every push to `main` is checked, built and published by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)). You choose
the version; the automation does the rest:

1. Typecheck, lint and unit tests.
2. Ready-to-run bundles are built for Node.js 20 and 22 (Linux x64), and each
   bundle is started and signed in to before it is published.
3. A GitHub Release named `v<version>` is published, **once per version**, with
   the bundles and their checksums attached.
4. The `dev-build` entry is replaced so it always holds the newest commit.

The version is the `version` field in `package.json`. A push that does not
change it publishes no new numbered release; it only refreshes `dev-build`.

## Channels

The suffix of the version decides the channel. Nothing else has to be set.

| Channel | Version looks like | On GitHub | Use it for |
|---|---|---|---|
| **stable** | `1.4.0` | Release, marked "Latest" | Production |
| **rc** | `1.4.0-rc.1` | Pre-release | Last check before stable |
| **beta** | `1.4.0-beta.1` | Pre-release | Trying new features |
| **alpha** | `1.4.0-alpha.1` | Pre-release | Early work that may break |
| **dev** | tag `dev-build` | Pre-release, replaced on every push | The newest commit, not a tested release |

The running app shows its version, channel and commit at the bottom of the
dashboard sidebar, for example `v1.4.0-beta.1 · beta · 3f9c2ab`.

## Cut a release

```bash
npm version 1.4.0-beta.1        # 1. set the version you want to publish
# 2. add a "## [1.4.0-beta.1] - YYYY-MM-DD" section to CHANGELOG.md
git add -A
git commit -m "Release 1.4.0-beta.1"
git push origin main            # 3. push; the release appears when the run is green
```

`npm version` only edits `package.json` and `package-lock.json` here (see
`.npmrc`). Do not create git tags yourself: the automation tags the commit when
it publishes the release.

The CHANGELOG section for the version becomes the release notes. If there is
none, the release still goes out, with a placeholder note and a warning in the
run.

### Version shortcuts

Typing the version is the clearest way. These shortcuts raise it for you:

| Command | From | To |
|---|---|---|
| `npm run version:beta` | `1.4.0-beta.1` | `1.4.0-beta.2` |
| `npm run version:rc` | `1.4.0-beta.2` | `1.4.0-rc.0` |
| `npm run version:rc` | `1.4.0-rc.0` | `1.4.0-rc.1` |
| `npm run version:alpha` | `1.4.0-alpha.0` | `1.4.0-alpha.1` |
| `npm run version:patch` | `1.4.0` | `1.4.1` |
| `npm run version:minor` | `1.4.1` | `1.5.0` |
| `npm run version:major` | `1.5.0` | `2.0.0` |
| `npm version preminor --preid=beta` | `1.5.0` | `1.6.0-beta.0` |

Two things to know: from a stable version, `version:beta` starts a beta of the
next **patch** (`1.4.1` → `1.4.2-beta.0`); and to promote a pre-release to
stable, type the final number: `npm version 1.4.0`.

A typical cycle: `1.4.0-beta.1` → `1.4.0-beta.2` → `1.4.0-rc.0` → `1.4.0`.
Each push publishes that version on its channel.

## Download a release

**In the browser:** open
[Releases](https://github.com/xieryzen/xiero-nexus-ai/releases), pick a version
and take the file under *Assets* that matches the server's Node.js version
(`node -v`):

- `xiero-nexus-ai-linux-x64-node22.zip` for Node.js 22
- `xiero-nexus-ai-linux-x64-node20.zip` for Node.js 20
- `SHA256SUMS.txt` holds the checksums of both

GitHub also attaches the source code of that exact version to every release.

**Direct links** (while the repository is public):

```text
Newest stable   https://github.com/xieryzen/xiero-nexus-ai/releases/latest/download/xiero-nexus-ai-linux-x64-node22.zip
One version     https://github.com/xieryzen/xiero-nexus-ai/releases/download/v1.4.0-beta.1/xiero-nexus-ai-linux-x64-node22.zip
Newest commit   https://github.com/xieryzen/xiero-nexus-ai/releases/download/dev-build/xiero-nexus-ai-linux-x64-node22.zip
```

**From a server**, `get-release.mjs` picks the right file for that machine's
Node.js version, downloads it and verifies the checksum:

```bash
curl -fsSLO https://raw.githubusercontent.com/xieryzen/xiero-nexus-ai/main/scripts/get-release.mjs
node get-release.mjs                 # newest stable
node get-release.mjs beta            # newest release that is beta or more stable
node get-release.mjs 1.4.0-beta.1    # exactly this version
node get-release.mjs dev             # newest commit
node get-release.mjs --list          # what is available
```

A channel means "at least this stable": `beta` gives the newest of the beta, rc
and stable releases, so it never hands you something older than stable. Every
bundle also contains `get-release.mjs`, so an installed copy can fetch its own
update.

Stable, `dev` and exact versions are fetched through GitHub's plain download
links. Only `rc`, `beta`, `alpha` and `--list` ask the GitHub API, which allows
few anonymous requests per hour per network address. If it refuses, wait, or
name the exact version instead.

If the repository is private, the links above need a signed-in browser, and
`get-release.mjs` needs a token that can read the repository:
`GH_TOKEN=<token> node get-release.mjs`.

## Install a release

A bundle needs only Node.js: no `npm install`, no build. The Node.js major
version must match the bundle (`node20` or `node22`); `start.js` says so clearly
if it does not.

```bash
mkdir -p ~/apps && cd ~/apps
curl -fLO https://github.com/xieryzen/xiero-nexus-ai/releases/latest/download/xiero-nexus-ai-linux-x64-node22.zip
unzip -q xiero-nexus-ai-linux-x64-node22.zip
cd xiero-nexus-ai
cp .env.example .env
sed -i "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")|" .env
node start.js
```

Then open the site and create the first account: it becomes the administrator.
(Or set `BOOTSTRAP_ADMIN_PASSWORD` in `.env` before the first start and sign in
as `admin`.)

Before you open it, decide how people reach it:

- **Over HTTPS** (behind a reverse proxy or tunnel): nothing to change.
- **Over plain `http://server-ip:port`**: add `COOKIE_SECURE=false` to `.env`.
  Without it the sign-in page explains that sign-in is turned off, because
  browsers drop HTTPS-only cookies on plain HTTP. On plain HTTP, passwords and
  sessions can be read by anyone on the network path, so use HTTPS when you can.

Good to know:

- `.env` and `data/` (the SQLite database, and generated images and videos
  in `data/media/`) live inside `xiero-nexus-ai/`.
  **Keep `SECRET_ENCRYPTION_KEY` safe**: stored provider keys and 2FA secrets
  cannot be read without it.
- The port is `PORT` from the environment, else the port a hosting panel
  assigns (`SERVER_PORT`), else `PORT` from `.env`, else 3000.
- To keep it running after you log out, start it under a process manager, for
  example `pm2 start start.js --name xiero-nexus`.
- `cat VERSION` shows the version, commit and Node.js version of an install.

### On Pterodactyl

1. Use a Node.js egg and note its Node.js version (20 or 22).
2. Upload the matching zip to the server's files and unarchive it. A
   `xiero-nexus-ai` folder appears.
3. In that folder, copy `.env.example` to `.env` and set
   `SECRET_ENCRYPTION_KEY` (generate one on any computer with
   `openssl rand -base64 32`). If you will open the panel address over plain
   `http://`, also add `COOKIE_SECURE=false`.
4. Set the startup file to `xiero-nexus-ai/start.js`, so the server runs
   `node xiero-nexus-ai/start.js`.
5. Start the server. The port the panel assigned is used automatically.

The bundle has no `package.json` on purpose, so the egg does not run
`npm install` against it.

## Upgrade

`.env` and `data/` are never part of a bundle, so they survive an upgrade.
Database changes are applied automatically the first time the new version runs.

```bash
cd ~/apps                                   # the folder that contains xiero-nexus-ai/
# stop the app, then:
cp -a xiero-nexus-ai/data "data-backup-$(date +%Y%m%d-%H%M%S)"
curl -fLO https://github.com/xieryzen/xiero-nexus-ai/releases/latest/download/xiero-nexus-ai-linux-x64-node22.zip
rm -rf xiero-nexus-ai/.next xiero-nexus-ai/node_modules
unzip -oq xiero-nexus-ai-linux-x64-node22.zip
# start the app again
```

Removing `.next` and `node_modules` first matters: unzipping over them would
leave files of the old version behind.

The backup copies generated images and videos too (`data/media/`), which can
be large. If `MEDIA_PATH` points somewhere else, that folder is untouched by
an upgrade and only the database needs the copy.

On Pterodactyl: stop the server, back up or archive `xiero-nexus-ai/data`,
delete `xiero-nexus-ai/.next` and `xiero-nexus-ai/node_modules`, upload the new
zip, unarchive it, start the server.

### Roll back

Stop the app, put the data backup you made before the upgrade back in place of
`xiero-nexus-ai/data`, then repeat the upgrade steps with the older version's
link (`.../releases/download/v1.3.0/...`). Restoring the backup matters because
the newer version may have changed the database.

## Other platforms

Published bundles are for Linux x64 with glibc (Debian, Ubuntu and the usual
Pterodactyl Node.js images). For ARM, Alpine or macOS, build a bundle on that
machine:

```bash
git clone https://github.com/xieryzen/xiero-nexus-ai.git
cd xiero-nexus-ai
git checkout v1.4.0                 # the version you want
npm ci
npm run build:standalone
npm run package                     # → dist/xiero-nexus-ai-<platform>-node<major>.zip
npm run package:test                # optional: start that bundle and sign in to it
```

If packaging stops with a message about glibc, the SQLite module was compiled
on your machine instead of downloaded prebuilt. Such a bundle works on that
machine and on newer systems; allow it with `MAX_GLIBC=99 npm run package`.

The scripts need bash, `zip` and `unzip`; on Windows use WSL.

## When something goes wrong

- **Pushed, but no new release.** The version in `package.json` already has a
  release, so only `dev-build` was refreshed. Raise the version and push.
- **The run is red.** Open the run under *Actions*. Nothing is published
  unless every check and both bundles pass.
- **"Tag v… already exists on commit …".** That tag was created by hand on
  another commit. Delete the tag or raise the version, then push.
- **Redo a release.** Delete it together with its tag
  (`gh release delete v1.4.0-beta.1 --cleanup-tag --yes`), then start the
  workflow again from *Actions → Build and release → Run workflow*.
- **Fix release notes.** Edit the release on GitHub. Published releases are
  never rewritten by the automation.
- **`dev-build` cannot be replaced.** It is deleted and recreated on every
  push, which GitHub's "immutable releases" repository setting does not allow.
  Leave that setting off.

## Files behind this

| File | Role |
|---|---|
| `.github/workflows/release.yml` | The pipeline: check, bundle, publish |
| `scripts/release-info.mjs` | Reads version, tag and channel from `package.json`; extracts release notes |
| `scripts/package-release.sh` | Turns a standalone build into a bundle zip |
| `scripts/bundle-start.js` | Becomes `start.js` in the bundle |
| `scripts/smoke-test-bundle.sh` | Starts a bundle and signs in to it |
| `scripts/publish-release.sh` | Creates the GitHub releases |
| `scripts/get-release.mjs` | Downloads a release by channel or version |
