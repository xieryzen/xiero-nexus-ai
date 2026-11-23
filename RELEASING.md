# Releases

Every push to `main` is checked, built and published by GitHub Actions
([`.github/workflows/release.yml`](.github/workflows/release.yml)). You choose
the version; the automation does the rest:

1. Typecheck, lint, unit tests, the end-to-end checks against the mock
   provider, and the tests of the scripts in `scripts/host/`.
2. Ready-to-run bundles are built for Node.js 20 and 22 (Linux x64). Each
   bundle is started and signed in to, and the bundle of v1.4.0 is upgraded
   to it on a made-up Pterodactyl host, before anything is published.
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

- **Over HTTPS** (behind a reverse proxy or tunnel): nothing to change. With
  root on a node that has nginx,
  [`scripts/host/nginx-site.sh`](scripts/host/README.md#the-public-address-nginx-sitesh)
  sets that up: the site for a name, with a certificate from Let's Encrypt.
- **Over plain `http://server-ip:port`**: add `COOKIE_SECURE=false` to `.env`.
  Without it the sign-in page explains that sign-in is turned off, because
  browsers drop HTTPS-only cookies on plain HTTP. On plain HTTP, passwords and
  sessions can be read by anyone on the network path, so use HTTPS when you can.

Good to know:

- `.env` and `data/` (the SQLite database, and generated images, voice-overs
  and videos in `data/media/`) live inside `xiero-nexus-ai/`.
  **Keep `SECRET_ENCRYPTION_KEY` safe**: stored provider keys and 2FA secrets
  cannot be read without it.
- The port is `PORT` from the environment, else the port a hosting panel
  assigns (`SERVER_PORT`), else `PORT` from `.env`, else 3000.
- To keep it running after you log out, start it under a process manager, for
  example `pm2 start start.js --name xiero-nexus`.
- `cat VERSION` shows the version, commit and Node.js version of an install.
- `GET /api/health` answers `{"status":"ok"}` without signing in when the
  server and its database work. Point an uptime check at it.
- Set `APP_URL` in `.env` to the address people open. Links in webhook
  messages and the file links the API returns are built from it.
- Joining clips into one video needs `ffmpeg` 4.2 or newer on the machine
  (`apt install ffmpeg`), or `FFMPEG_PATH` in `.env`. Everything else works
  without it.
- Stopping: the app ends within a few seconds of `SIGTERM` or Ctrl+C, and the
  next start goes on with the runs that were in progress.

### On Pterodactyl

1. Use a Node.js egg and note its Node.js version (20 or 22). Its Docker
   image must be one that is built on Debian or Ubuntu, such as
   `ghcr.io/ptero-eggs/yolks:nodejs_22` (earlier `ghcr.io/parkervcp/yolks`),
   which the common Node.js eggs use.
   The images `ghcr.io/pterodactyl/yolks:nodejs_*` are built on Alpine, where
   the published bundles do not run (see [Other platforms](#other-platforms)).
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

**With root on the node**, `scripts/host/pterodactyl-install.sh` does steps 2
to 5 for a server that was made in the panel: it downloads and checks the
bundle, writes `.env` with a new key and a password for the first
administrator, and starts the server. It also takes care of two things the
common Node.js egg does on its own: that egg runs one file, `index.js` by
default, through `ts-node`, and clones, installs and updates the source code
when it was given the repository's address. See
[scripts/host/README.md](scripts/host/README.md#installing-pterodactyl-installsh).

Joining clips into one video needs ffmpeg inside the server's container. The
`yolks` Node.js images include it; the status page (Observability) says
whether this server has it. If not, see `--ffmpeg` in
[scripts/host](scripts/host#upgrading-pterodactyl-upgradesh).

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

### Upgrading on Pterodactyl

**With root on the node** (the machine that runs Wings), one script does all
of it: it stops the server, backs up the database, `.env` and the old program
files, installs the new release, starts the server, waits until it answers,
and puts the old version back by itself when it does not.

```bash
curl -fsSLO https://raw.githubusercontent.com/xieryzen/xiero-nexus-ai/main/scripts/host/pterodactyl-upgrade.sh
sudo bash pterodactyl-upgrade.sh --server <short id> --dry-run     # shows the plan, changes nothing
sudo bash pterodactyl-upgrade.sh --server <short id>
```

The short ID is the one in the panel's address of the server. Options, what
is backed up where, and how to go back are in
[scripts/host/README.md](scripts/host/README.md). The script is tested
against a stand-in for Wings and has upgraded one real node so far: do the
dry run first and read the plan.

**Without signing in to the node yourself:** the workflow *Deploy to a
Pterodactyl node* (Actions, started by hand) runs the same script over SSH,
with the node's address and a password or key from the repository's secrets.
Run `plan` first, then `upgrade`. `scripts/host/over-ssh.sh` does the same
from any machine. Both are described in
[scripts/host/README.md](scripts/host/README.md#from-somewhere-else-over-sshsh),
with what they keep out of a public log.

**Through the panel only:** stop the server, back up or archive
`xiero-nexus-ai/data`, delete `xiero-nexus-ai/.next` and
`xiero-nexus-ai/node_modules`, upload the new zip, unarchive it, start the
server.

### From 1.4 to 1.5

- Back up `data/` before the first start of 1.5: it updates the database, and
  1.4 cannot open that database afterwards.
- A project that 1.4 was running when it was stopped is ended about a minute
  after 1.5 starts, with the message "The server stopped while this project
  was running. Run it again."
- Nothing has to be configured. The new settings (`FFMPEG_PATH`,
  `SEARCH_PROVIDER`, `RUN_CONCURRENCY` and others) are optional and described
  in `.env.example`; an existing `.env` keeps working as it is.

### From 1.5 to 1.6

- Nothing has to be configured, and the database stays as it is: going back
  to 1.5 needs no backup of `data/` to be put back.
- The app now waits and asks again when a provider answers "too many
  requests" or "busy". `PROVIDER_RETRIES=0` in `.env` turns that off.

### From 1.6 to 1.7

- Nothing has to be configured. At its first start 1.7 adds four tables to
  the database, for skills.
- 1.7 has a third role, the owner, who manages the accounts. At that first
  start the first administrator of the installation becomes its owner (the
  audit log says which account). Administrators no longer change roles or
  switch accounts off: the owner does.
- **Going back to 1.6 means putting the backup of `data/` back**, as
  `pterodactyl-upgrade.sh --restore` does: 1.6 does not know the role
  "owner", and would treat that account as an ordinary user.
- `scripts/host/workforce.py` of 1.6 does not sign in to a 1.7 app with the
  owner's account (it asks for an administrator by that word): use the
  scripts of the same version as the app.

### From 1.7 to 1.8

- Nothing has to be configured. At its first start 1.8 adds its columns to
  the database.
- From that start on the app checks its chat models by itself: a few seconds
  after the start it asks every model that was not checked in the last six
  hours for one word, one model a second. **A model that fails is left out
  of the model lists** until a check passes again; the Models page shows
  which, and why. Models whose last test had failed before the upgrade are
  left out from the first moment, and asked again in that first round.
- `MODEL_HEALTH_INTERVAL_MINUTES` in `.env` sets how often (`0` = never).
- **Every account that is not an owner gets a limit of 10,000,000 tokens**,
  and starts at 0 used: what it used before the upgrade is not counted. From
  then on its work is counted, and refused when nothing is left, until an
  owner raises its limit under **Users & Roles**. Look at that page after the
  upgrade, and give the accounts that run much (a team's shared account, the
  account the host scripts sign in with) the limit they need. An owner is
  not limited. `DEFAULT_TOKEN_LIMIT` in `.env` sets what a new account gets.
- **A user no longer sees providers and models, and chooses none.** After
  the upgrade the app chooses for every user: the cheapest model of each kind
  that is switched on. **Open the Models page and mark the models that are
  for users** (the switch "for users" on each model); the page says which
  model users work with now. A project a user made before the upgrade keeps
  what it was set to in the database, and runs with the app's choice from now
  on. Administrators and owners choose as before.
- An API client that uses a user's key has to send `"model": "auto"`: a name
  of a model is answered 404 `model_not_found` from this version on. A key of
  an administrator works as before.
- **Read the descriptions of your agents, teams and workflows once as a user
  would.** They are shown to users as written. Where one says which model a
  project needs, say what it makes instead: the app tells an administrator
  what a project needs when the project is made. The sentence the Reel
  template added to a description is left out for users by the app; what you
  wrote yourself is yours to change. An installation that was set up from
  `scripts/host/workforce.json` gets the new descriptions with the workforce
  action and `--only teams,workflows --update`.
- **Servers over SSH are off until you register one.** Nothing changes for
  an installation that registers none. To have agents work on a server: an
  owner registers it on the **Servers** page (compare the fingerprint that
  is shown with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the
  machine), ticks **Work on servers** on the agents that should have the
  tool, and names the server in a project. Register an account with the
  rights the work needs, and no more: an agent can run any command that
  account can. `SSH_KEEPALIVE_SECONDS` in `.env` sets how often an open
  connection says that it is still there (default 15).
- The password or key of a server is encrypted with `SECRET_ENCRYPTION_KEY`,
  like the keys of the providers: with another key in `.env` they cannot be
  read, and the servers have to be registered again.
- **The browser is off until there is a browser service.** Agents work in a
  Chromium that runs apart from the app; `BROWSER_URL` in `.env` says where
  it is. On a Pterodactyl node the Deploy workflow's action `browser-plan`
  shows what setting it up would do, and `browser` does it: a container
  next to the server, built on the node, with a limit on memory and nothing
  published, and `BROWSER_URL` written into the server's `.env`
  (`scripts/host/README.md`, "The browser"). Elsewhere it is one
  `docker run` (`scripts/host/browser/README.md`). Run the action again with
  `--rebuild` every few weeks: that is how its Chromium gets its updates.
- To have agents sign in to a site: an owner saves the account on the
  **Browser** page, ticks **Work in a browser** on the agents that should
  have the tool, and names the account in a project: one account of a site
  in a project, since its run has one browser. Where a site asks for
  a CAPTCHA or a code, the task waits for you; **Sign in by hand** on the
  Browser page lets you do that once, ahead of the agents, and keeps the
  session. Save an account with the rights the work needs, and no more: on
  the site an agent can do whatever that account can.
- The password of a site account and the session that is kept for it are
  encrypted with `SECRET_ENCRYPTION_KEY`, like the keys of the providers
  and of the servers.
- **From the candidate 1.8.0-rc.5:** the sessions that were kept for site
  accounts are dropped at the first start of 1.8.0, once, and each account
  signs in anew with its next run (a CAPTCHA or a code that a kept session
  spared is asked for once more). With that candidate a project could name
  two accounts of one site, and one of them could be let in with what the
  other's sign-in left. Such a project does not run until it names one of
  them.
- Going back to 1.7 needs nothing: 1.7 does not read the new columns and
  tables. An agent that was given the tool "Work on servers" or "Work in a
  browser" keeps the name of the tool in its row; 1.7 does not know it and
  leaves it out. The browser service keeps running until it is taken away
  (`browser-service.sh --remove`); nothing uses it then.

### From 1.8.0 to 1.8.1

- Nothing has to be configured, and the database is not changed.
- **A project has no token budget any more.** A run that 1.8.0 stopped at
  the project's budget (200,000 tokens unless the project said otherwise)
  now goes on while its account has tokens left. **If you used the budget to
  cap what a run may spend, set the token limit of the account the project
  belongs to** (Users & Roles, an owner). An owner's account has no limit,
  so a run of an owner's project is held to no number of tokens: a project
  that is to be capped has to belong to an account that is not an owner.
- A run that is not stopped at a budget asks more of its provider. A
  provider with a small quota (a free tier) answers 429 sooner; that is the
  provider's limit, and nothing in the app lifts it.
- Going back to 1.8.0 needs nothing.

### From 1.8 to 1.9

- Nothing has to be configured. At its first start 1.9 adds two columns to
  the table of the runs (`project_runs.continued` and `tokens_before`).
  **Back up `data/` before the upgrade**, as for every version that changes
  the database: going back to 1.8 is done with that backup in its place
  (`pterodactyl-upgrade.sh` makes the backup and prints the command). 1.8
  on the database of 1.9 was not tried.
- **A run that stopped before the upgrade can be continued after it**: open
  the project and press **Continue**. The tasks that succeeded are kept; the
  others are done again.
- **A task now waits when all of its models are limited**, for up to an
  hour, where 1.8 failed it at once. A run with such a task takes longer and
  keeps its place among the runs that work at the same time
  (`RUN_CONCURRENCY`) meanwhile. `RUN_LIMIT_WAIT_MINUTES=0` in `.env` brings
  back what 1.8 did; **Cancel** ends a wait at once.
- A task that failed after several of its models were asked now says what
  each of them answered. A program that reads the text of a task's error
  finds more lines there than before.

### From 1.9 to 1.10

- Nothing has to be configured. At its first start 1.10 adds three columns
  to the database (`models.use_failures`, `models.retry_at`,
  `projects.stand_ins`). **Back up `data/` before the upgrade**; going back
  to 1.9 is done with that backup in its place (`pterodactyl-upgrade.sh`
  makes the backup and prints the command). 1.9 on the database of 1.10 was
  not tried.
- **A run now goes on with another model when its own do not answer.** A
  task that 1.9 failed with "None of the 3 models of this task gave an
  answer" is done by another chat model of the installation that works, and
  never by one that costs more than the dearest model the task was set to.
  To keep what 1.9 did: `MODEL_STAND_INS=0` in `.env`, or **Go on with
  another model** switched off for a project.
- **Models are left out sooner.** 1.9 left a model out when a check failed
  (every six hours unless set otherwise). 1.10 also counts real work: three
  requests in a row that the provider did not answer, or one answer that
  asking again does not change, leave the model out until it answers again.
  Look at the Models page after the first runs.
- Where the installation has models that are billed and models that are
  free, and none is marked **for users**: a task set to a billed model can
  be done by any model that costs no more. Mark the models the app may
  choose by itself, if that is to be fewer.

### From 1.10 to 1.11

- Nothing has to be configured. At its first start 1.11 changes the
  database: new tables for conversations' messages, for what an account
  remembers and for its keys; `servers.owner_id`, `site_accounts.owner_id`
  and `server_commands.handed`; and the names of servers and site accounts
  are unique among the ones an owner registered, and among the ones of each
  account, no longer among all. The table `chat_messages` of earlier
  versions, which nothing ever wrote to, is made anew. **Back up `data/`
  before the upgrade**; going back to 1.10 is done with that backup in its
  place. 1.10 on the database of 1.11 was not tried, and what was handed
  over in conversations would show on its Servers and Browser pages.
- **Every account can now hand a server, a site account or a key to the
  assistant in Chat, users included**, and its assistant and the runs of
  its projects then work with it. Anyone but an owner reaches public
  addresses only. Where that is not wanted: `OWN_ACCESS=admins`, `owners`
  or `off` in `.env` before the first start.
- **The app now makes SSH connections that no owner set up**: to the
  machines people hand over. A firewall that lets the app out on port 22
  only to certain machines keeps doing so; the sign-in then fails and the
  person is told.
- **Chat is a different page.** Conversations are kept and listed; there
  is a Memory page in everyone's menu. A program that calls
  `POST /api/chat` with `messages` gets what it got before.
- Where the app chooses the model of a conversation (always, for a user),
  it asks the models marked **Tool calling** that work first. Mark the
  models that do call tools: `workforce.sh --try-assistant-all` says which
  ones do, and `--mark-tools` marks them.
- An answer that is being worked on goes on when the page is closed, for
  up to half an hour, and is stopped with the Stop button.
- **See whether the assistant can act on this installation.** It works on
  what is handed over by calling tools, and a model that only answers
  cannot. On the node, after the upgrade:
  `sudo bash workforce.sh --server <id> --as-owner --inventory-only --try-assistant --try-ssh <a machine of yours>`
  (through the deploy workflow: action `workforce`, with those as
  `options`). It asks the assistant to keep one note and says whether its
  model called the tool, and has the app read the machine's host key,
  signing in to nothing ([scripts/host/README.md](scripts/host/README.md)).

### Roll back

Stop the app, put the data backup you made before the upgrade back in place of
`xiero-nexus-ai/data`, then repeat the upgrade steps with the older version's
link (`.../releases/download/v1.4.0/...`). Restoring the backup matters because
the newer version may have changed the database.

After an upgrade with `pterodactyl-upgrade.sh`, the command it printed at the
end does both: `sudo bash pterodactyl-upgrade.sh --server <id> --restore
<backup folder>`.

## Other platforms

Published bundles are for Linux x64 with glibc: Debian, Ubuntu, and the
Docker images built on them. For ARM, Alpine (musl) or macOS, build a bundle
on that machine:

```bash
git clone https://github.com/xieryzen/xiero-nexus-ai.git
cd xiero-nexus-ai
git checkout v1.5.0                 # the version you want
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
| `.github/workflows/release.yml` | The pipeline: check, end-to-end, bundle, publish |
| `scripts/release-info.mjs` | Reads version, tag and channel from `package.json`; extracts release notes |
| `scripts/package-release.sh` | Turns a standalone build into a bundle zip |
| `scripts/bundle-start.js` | Becomes `start.js` in the bundle |
| `scripts/smoke-test-bundle.sh` | Starts a bundle, signs in to it, and stops it |
| `scripts/e2e/` | The mock provider and the end-to-end checks (`npm run test:e2e`) |
| `scripts/host/` | For a Pterodactyl node: installing, upgrading, the site in nginx, the disk report, and their tests |
| `scripts/publish-release.sh` | Creates the GitHub releases |
| `scripts/get-release.mjs` | Downloads a release by channel or version |
