# Scripts for the machine that hosts the app

Scripts for whoever runs Xiero Nexus AI on a **Pterodactyl** server and has
root on the machine that runs **Wings** (the node). They run there; they are
not part of a release bundle and the app never runs them.

| Script | What it is for |
|---|---|
| [`pterodactyl-install.sh`](pterodactyl-install.sh) | Put the app on a server that does not have it yet: the bundle, its `.env`, and the file the server starts. |
| [`pterodactyl-upgrade.sh`](pterodactyl-upgrade.sh) | Upgrade the app on one server to a new release, with a backup, and go back by itself if the new version does not come up. |
| [`nginx-site.sh`](nginx-site.sh) | Give the app its public address: a site in the node's nginx with a certificate from Let's Encrypt, without touching the other sites. |
| [`workforce.sh`](workforce.sh), [`workforce.py`](workforce.py) | Put the workforce of [`workforce.json`](workforce.json) into the running app: providers that take no key, models, agents, teams and workflows. |
| [`disk-report.sh`](disk-report.sh) | A read-only report of what fills the machine's disk, to decide what to tidy up. |
| [`node-check.sh`](node-check.sh) | A read-only look at the node before an upgrade: Wings, Docker, which servers hold the app, what is in one server's files. |
| [`over-ssh.sh`](over-ssh.sh) | Run one of them on the node from another machine, over SSH. The [Deploy workflow](#from-github-actions) uses it. |

All of them are tested on a made-up Wings host (see [Tests](#tests)), written
from the source of Wings 1.12; no test here talks to a real Wings. Outside
the tests they have been used on one real node (Debian 13, Docker 29, the
Node.js egg of ptero-eggs, nginx 1.26), in November 2026: an installation,
the check, the disk report, one upgrade, which installed the version that was
there again, upgrades to four later versions, the site in nginx with its
certificate, the workforce of `workforce.json`, and an account and two
skills sealed for the node. **Going back by
itself after a new version does not come up has only run against the
stand-in**, and so has taking a site out of nginx again after a step failed.
So do the dry run first and read the plan; the upgrade keeps a backup outside
the server's files, and `--restore` puts it back.

Get them on the node:

```bash
for name in pterodactyl-install.sh pterodactyl-upgrade.sh nginx-site.sh disk-report.sh node-check.sh workforce.sh workforce.py workforce.json; do
  curl -fsSLO "https://raw.githubusercontent.com/xieryzen/xiero-nexus-ai/main/scripts/host/${name}"
done
```

## Installing: `pterodactyl-install.sh`

For a server that was made in the panel and does not run the app yet. Stop
the server first.

```bash
# 1. See what it would do. Nothing is changed.
sudo bash pterodactyl-install.sh --server 1a2b3c4d --app-url https://site.example.com --dry-run

# 2. Do it.
sudo bash pterodactyl-install.sh --server 1a2b3c4d --app-url https://site.example.com
```

What happens, in this order:

1. It finds the server's files, and stops when a bundle is there already
   (that is a case for the upgrade script) or when the server is running.
2. It downloads the bundle for the Node.js of the server's image and checks
   it against the release's SHA-256 list.
3. It shows the plan and asks.
4. It unpacks the bundle into `xiero-nexus-ai/` and writes its `.env`: a new
   `SECRET_ENCRYPTION_KEY`, a password for the first administrator, the
   site's address, and what was given with `--set`.
5. When the server's startup command runs a file that is not there, it
   writes that file (see below).
6. It gives the new files to the owner of the server's files, starts the
   server through Wings and waits until the app answers. The start is done by
   `pterodactyl-upgrade.sh --start`, which has to be in the same folder;
   without it, start the server in the panel.

Nothing is deleted and nothing that is there is overwritten. When it is
stopped in the middle, it puts the server's files back as they were.

- **The first administrator.** Sign in as `admin`. The password was made on
  the node and is in `xiero-nexus-ai/.env`, in the line
  `BOOTSTRAP_ADMIN_PASSWORD`; the script does not print it. Change it after
  signing in. Without that line the first account that registers in the
  browser becomes the administrator, which on a public address can be anyone.
- **The file the server starts.** The common Node.js egg does not run a
  command of your choice: it runs one file, `index.js` unless the panel's
  *Startup* tab says otherwise, and it runs that file through `ts-node`. The
  installer therefore writes that file. It is a few lines that start
  `xiero-nexus-ai/start.js` with plain Node.js in a process of its own, pass
  a stop on to it once, and end with its exit code. A file of that name that
  is there already is left alone; then set the startup file to
  `xiero-nexus-ai/start.js` in the panel. `--launcher <file>` and
  `--no-launcher` decide otherwise.
- **A checkout of the source code.** Given the repository's address, that egg
  clones the source code into the server and runs `npm install` and
  `git pull` there at every start, as long as `package.json` and `.git` are
  at the top of the server's files. That takes minutes and does nothing for
  a bundle. `--move-aside` moves all of it into one folder of the server,
  `source-checkout-<date>/`, which can be deleted afterwards. It only does
  so for a checkout that never ran (no `.env`, no `data/`); one that has run
  holds a key and a database, and the script stops.
- **`ts-node` and TypeScript 7.** `ts-node` 10 does not start with
  TypeScript 7 next to it. An image that holds both cannot start any main
  file through that egg, this one included. `node-check.sh --try-image` says
  whether a server's image is such a one. The way out is a startup command
  without `ts-node`, which an administrator of the panel can set for the
  server: `/usr/local/bin/node /home/container/xiero-nexus-ai/start.js`.

| Option | |
|---|---|
| `--app-url <url>` | The public address of the site (`APP_URL`). |
| `--set KEY=VALUE` | Another line for `.env`. Can be repeated. |
| `--version <v>`, `--zip <file>` | Which bundle: a version instead of the latest, or a file instead of a download. |
| `--node <20\|22>` | The Node.js of the server's image, for a server that has never been started. |
| `--move-aside` | Move a checkout of the source code that never ran into one folder. |
| `--launcher <file>`, `--no-launcher` | Where the start file is written, or that none is. |
| `--no-start` | Leave the server stopped. |
| `--dry-run`, `--yes` | Show the plan and stop; do not ask. |
| `--volumes`, `--wings-config`, `--check-url`, `--health-timeout`, `--backup-dir` | As for the upgrade script. |

## Upgrading: `pterodactyl-upgrade.sh`

```bash
# 1. See what it would do. Nothing is changed.
sudo bash pterodactyl-upgrade.sh --server 1a2b3c4d --dry-run

# 2. Do it.
sudo bash pterodactyl-upgrade.sh --server 1a2b3c4d
```

`--server` takes the server's UUID or its first 8 characters, which is the
short ID in the panel's address (`…/server/1a2b3c4d`). It can be left out when
only one server on the machine has the app.

What happens, in this order:

1. It finds the server's files (`/var/lib/pterodactyl/volumes/<uuid>`, or
   where the Wings configuration says) and the bundle installed there.
2. It downloads the bundle of the newest stable release for the Node.js
   version the installed bundle was built for, and checks it against the
   release's `SHA256SUMS.txt`.
3. It shows the plan and asks.
4. It stops the server through Wings, the way the panel does. A server that
   has not stopped by itself after a minute has its process ended. (Wings does
   the same after ten minutes.)
5. It copies the database, `.env` and the old program files to
   `/root/xiero-nexus-backups/<uuid>/<time>-v<old version>/`, which only root
   can read.
6. It puts the new program files in place. **`.env`, `data/` and every file
   that is not part of a bundle are left alone.**
7. It starts the server and waits until `/api/health` answers.
8. If the new version does not answer within two minutes, it shows the last
   lines of the server's console, puts the old program files and the database
   back, and starts the old version again.

At the end it prints where the backup is and the command that goes back to
it.

### Options

| Option | |
|---|---|
| `--version 1.5.0` | Install that version instead of the newest. |
| `--zip <file>` | Install a bundle you already have instead of downloading one. |
| `--app-url https://nexus.example.com` | Set `APP_URL` in the server's `.env`: the public address of the site, used in webhook links and in the links the API returns. |
| `--set KEY=VALUE` | Set any other line of `.env`. Can be repeated. `SECRET_ENCRYPTION_KEY` cannot be changed this way. |
| `--ffmpeg <file>` | Copy this ffmpeg program into the server's files and point `FFMPEG_PATH` at it, for a server image without ffmpeg. See below. |
| `--with-media` | Also copy the generated images and videos to the backup. An upgrade does not change them, and copying can take long. |
| `--backup-dir <dir>` | Keep backups somewhere else. |
| `--restore <folder>` | Do not upgrade: put the program files and the database of that backup folder back. |
| `--start` | Do not upgrade: start the server through Wings and wait until the app answers; show its console when it does not. |
| `--dry-run` | Show the plan and stop. |
| `--yes` | Do not ask. |
| `--power manual` | Do not talk to Wings. You stop the server in the panel first, and start it afterwards. |
| `--leave-stopped` | Do not start the server afterwards. |
| `--no-rollback` | Leave the new version in place even when it does not answer. |
| `--check-url <url>` | Where the app answers on this machine, when that cannot be found out. |

`--help` lists the rest.

### Good to know

- **The site is down while it runs**: a minute or so, and up to two when the
  running version is slow to stop.
- **Runs that are in progress are not lost** when the installed version is
  1.5.0 or newer: the app picks them up again after the restart. A project
  that 1.4 was running is ended with the message "The server stopped while
  this project was running. Run it again."
- **Going back.** `--restore <backup folder>` puts back the program files
  and the database as they were at the time of the backup. Everything done in
  the app after that is lost, apart from generated media files, which are not
  touched. A version cannot simply be replaced by an older one: the database
  of a newer version may be too new for it, which is why `--restore` puts the
  database back as well.
- **Backups are kept** until you delete them. Each is the size of the
  program files (about 30 MB) plus the database.
- **The token of the node.** To stop and start the server, the script reads
  the node's token from `/etc/pterodactyl/config.yml` and asks Wings on the
  same machine. The token is not printed and is not passed on a command line.
  If the configuration names a variable instead of holding the token, run the
  script with `WINGS_TOKEN=<the token>` in front, or use `--power manual`.
- **When the check cannot be made.** The script asks the app at the address
  and port the panel assigned to the server. If the running version does not
  answer there before the upgrade either (a firewall, an unusual network
  setup), the script says so in the plan, and afterwards it cannot tell a
  broken version from an unreachable one: it then leaves the new version in
  place and tells you to open the site. Name the address that does answer
  with `--check-url`.
- **A server that is suspended** in the panel is upgraded and left stopped:
  Wings does not start it.
- **ffmpeg.** Joining clips into one video needs ffmpeg inside the server's
  container. The script says at the end whether the server's image has it;
  the `yolks` Node.js images do. If not, download a static build
  of ffmpeg for Linux x64, and pass the program with `--ffmpeg`: it is copied
  to `xiero-tools/ffmpeg` in the server's files, where it counts towards the
  server's disk limit (80 to 170 MB, depending on the build).

## The public address: `nginx-site.sh`

The app listens on the port the panel gave the server. `nginx-site.sh` puts a
name in front of it: a site in the **nginx of the node**, with a certificate
from **Let's Encrypt**, so that `https://nexus.example.com` opens the app and
no browser warns.

```bash
# 1. See what it would do. Nothing is changed.
sudo bash nginx-site.sh --server 1a2b3c4d --site nexus.example.com --dry-run

# 2. Do it.
sudo bash nginx-site.sh --server 1a2b3c4d --site nexus.example.com
```

Before that: the name needs a DNS record with the node's address, and the
node needs nginx (running) and certbot. The script installs neither. A node
that serves the panel over HTTPS usually has both.

What it does:

1. Finds the port of the machine that leads to the server, and sees that the
   app answers there.
2. Looks at nginx: that it runs, that its configuration passes `nginx -t` as
   it is, where it takes its sites from (`sites-enabled`, or `conf.d`), how
   the sites that are there listen, and that none of them has this name.
3. Sees that the name leads to this machine, shows the plan, and asks.
4. Adds **one file** to nginx: at first the site on port 80 that answers
   nothing but Let's Encrypt's questions. Tests the configuration, reloads.
5. Asks certbot for the certificate (`certonly --webroot`), unless a good one
   is there already.
6. Writes the file anew: port 80 sends everyone on to https, and https
   passes the requests on to the app. Tests, reloads.
7. Asks `https://<name>/api/health` on the machine, with the certificate
   checked, and wants a 200.

**The other sites of that nginx are left as they are.** That is what most of
the script is about:

- It changes no file but its own, which says so in its first line, and it
  refuses when a file it did not write has the name or stands in its place.
- nginx is only reloaded with a configuration that `nginx -t` accepts
  **without a new kind of warning**.
- The site listens the way the others do: on the same addresses, and with
  HTTP/2 as a word of `listen` where they have it so. Where they do not, and
  nginx is 1.25.1 or newer, HTTP/2 is switched on for this site alone
  (`http2 on;`).
- It must not become the site nginx shows for **names it does not know**
  (the first one nginx reads, where none says `default_server`). When its
  file would be read first it gets a name that is read last; when that does
  not help, the script stops. Before and after, it asks nginx for a name no
  site has, and what that gets must stay the same.
- **When a step fails, the file is taken out again** (or its earlier version
  put back) and nginx reloaded: a certificate that was not given, a name that
  another site answers first, an app that stopped answering.

certbot renews the certificate from then on, and reloads nginx when it has
(`--deploy-hook`). The plan says what renews certificates on the machine
(`certbot.timer`, or a cron job) and warns when nothing does; at the end the
script looks whether certbot has noted the reload with the certificate's
renewal settings, and whether the site still answers Let's Encrypt's
questions now that it is passed on to the app.

What the app gets from nginx: the name that was asked for (`Host`,
`X-Forwarded-Host`), `X-Forwarded-Proto`, and the visitor's address as nginx
saw it (`X-Forwarded-For`, `X-Real-IP`; what a visitor sends under those
names is not passed on, since the app's audit log and rate limits go by
them). Answers that are written bit by bit, such as a chat, are passed on as
they come. Uploads of up to 32 MB are let through (`--max-body`).

| Option | |
|---|---|
| `--site <name>` | The public name. An address (`https://nexus.example.com`) is understood too. |
| `--server <id>` | The server whose app the site shows: its UUID or the first 8 characters. |
| `--upstream <url>` | Where the app answers on this machine, instead of `--server`: `http://127.0.0.1:25565`. |
| `--max-body <size>` | The largest upload nginx lets through. Default `32m`. |
| `--agree-tos`, `--email <address>` | For a **new** Let's Encrypt account, when certbot has none on the machine. Making one means agreeing to [their terms](https://letsencrypt.org/repository/), so the script does not do that unasked. |
| `--skip-dns-check` | Go on although the name, as seen from the machine, does not lead to it. |
| `--remove` | Take the site out of nginx again. The certificate stays (`certbot delete --cert-name <name>` removes it). |
| `--dry-run`, `--yes` | Show the plan and stop; do not ask before starting. |
| `--volumes <dir>`, `--wings-config <file>` | Where Wings keeps server files and its configuration, when not in the usual places. |

Running it again writes the file anew, for another `--max-body` say, and
keeps the certificate.

Good to know:

- The port the panel gave the server is as open to the outside as it was
  before. Where no firewall closes it, the app also answers at
  `http://<address>:<port>`, without the certificate. Nobody stays signed in
  that way (the session cookie is HTTPS-only unless `COOKIE_SECURE=false`),
  but a password typed there travels unprotected. When only nginx should
  reach the app, close that port to the outside: in the firewall (for a port
  Docker passes on, the rule belongs in the `DOCKER-USER` chain), or with an
  allocation on `127.0.0.1` in the panel. This script does neither.
- A certificate that is there already and good is used as it is, whoever
  put it there. nginx 1.27.4 and newer keep a certificate across a reload
  when its file is the same file with the same time as before; certbot
  writes new files, so its certificates are taken. At the end the script
  compares what nginx shows with what is in the file, and says so, and what
  to do, when they are not the same.
- It works with nginx only, and with the layouts `sites-enabled` and
  `conf.d`. With Apache, Caddy or a tunnel in front, set the site up there
  and pass on the same things.
- Its test runs it against a real nginx (see [Tests](#tests)), with stand-ins
  for certbot and Let's Encrypt. On a real node it has been used **once**
  (November 2026: nginx 1.26 laid out the Debian way, ten other sites,
  certbot 4.0 with an account, `certbot.timer`): the first setup, which went
  through. Taking a file out again after a failed step, a second run,
  `--remove` and a new account have only happened in the test, and a renewal
  by certbot's own timer has not happened anywhere yet: the first one is due
  a month before the certificate ends.

## The workforce: `workforce.sh` and `workforce.json`

An app that was just installed has providers at most: no agents, no teams, no
workflows, no skills. [`workforce.json`](workforce.json) says what the
workforce of this repository's server is, with the skills in
[`skills/`](skills), and `workforce.sh` puts it into the running app, the way
an administrator would by hand on its pages:

```bash
sudo bash workforce.sh --server 1a2b3c4d --dry-run        # what the app has, what would be added
sudo bash workforce.sh --server 1a2b3c4d --yes --test     # add it, then ask each chat model for one word
sudo bash workforce.sh --server 1a2b3c4d --yes --try-run  # add it, then have the agents do a small project
sudo bash workforce.sh --server 1a2b3c4d --yes --only-usable  # add it, then switch off the models that cannot be used
```

`workforce.sh` finds the port the server's app answers on and the app's
`.env`; [`workforce.py`](workforce.py) (Python 3.8 or newer, nothing else to
install) signs in as the administrator of the first start, with the password
in that `.env`, and works through the app's own API. So every change is in
the app's audit log under that administrator's name, and nothing on the node
is changed. The password is not printed and is on no command line; one
sign-in is tried and no more; the session is ended before the program exits.
The password in `.env` is the one of the first start: once it is changed in
the app, give the current one as `NEXUS_PASSWORD`. An account with two-step
sign-in cannot be used.

It adds what is missing and leaves the rest:

- A model the file names is taken into the app from the provider's list, with
  the capabilities and prices of the file. One that is in the app already
  gets the capabilities it lacks, and the prices and name it has none of.
- An agent, a team, a workflow or a skill is added when none of that name is
  there. One that is there and differs from the file is reported and left as
  it is; `--update` changes it to what the file says, under the ID it has.
- A skill is a folder with a `SKILL.md` and the text files it refers to. It
  is compared word for word: a `SKILL.md` that was edited here differs from
  the one in the app until `--update` puts it there, and a skill that was
  edited on the Skills page is overwritten by that. An agent or a team gets
  the skills the file names for it, and keeps the ones it was given by hand
  on its page: the file adds skills and takes none away. Skills came with
  version 1.7: on an older app the program says so and changes no agent.
- **A skill of your own** need not be in the file, or in a repository
  others can read. `"my-skill": {"uploaded": true}` names one that you
  upload on the Skills page, or with `--upload-skill <file>` (a `SKILL.md`,
  a `.skill` or a `.zip`, as on that page; it replaces a skill of the same
  name). Agents and teams that name it get it when the app has it, and are
  made without it until then: the program says who waits for it.
- A provider that takes no key (`"authType": "none"`) is added when the app
  does not have it, with the address of the file. One that takes a key is not
  added: the program has no keys, and says that the provider is to be added
  on the Providers page. The file can say how long the app waits for a
  provider's answer; for a provider that is there already, that is changed
  with `--update` only.
- A model with `"enabled": false` is switched off, and not taken into the app
  when it is not there: for a model that was tried and did not serve.
- Nothing is ever deleted. What the file does not name is not touched.
- A tool the server cannot run (`run_command` without a sandbox runner,
  `web_search` without a search service) is left out of an agent, and said.

**An account** the app is to have:

```bash
NEXUS_ACCOUNT_PASSWORD=... sudo -E bash workforce.sh --server 1a2b3c4d --yes --only accounts \
  --account dewi --account-email dewi@example.com --account-role owner
```

It is made when no account has that username or that email, with the role
given (`owner`, `admin` or `user`). One that is there is left as it is and
what differs is said; with `--update` its role, name and email are made as
asked, and its password too when one is given, which signs it out
everywhere. The password comes in the environment, never on the command
line, and is in nothing the program prints. Only an owner manages accounts:
the program has to sign in as one (from version 1.7 the administrator of the
first start is the owner). It does not change the account it signs in as.

`--test` asks each chat model of the file for one word, and `--test-all`
every chat model in the app; `--test-media` has the image model make one
picture and the speech model say one sentence, joins them where the server
has ffmpeg, and deletes the three files again. **These are requests the
providers bill**, small ones. They are the only way to know that a model can
be used: a provider lists models that its key may not call. A failed test
ends the run with 1 and says what the provider answered; the workforce stays.

`--try-run` goes further, and takes minutes: it makes a small project with
the goal of the file's `tryRun`, lets the model named there plan it and the
agents do the tasks, and says for each task which model answered and what the
models before it said. With `"everyAgent": true` a second project gives each
agent one small task (each agent of the try-run's team, or of the whole file
when it names no team), so that each is seen at work with its own first model
and its tools. Both are deleted again (`--keep-try-run` keeps them). One word
from a model says that it answers; whether a provider allows the many
requests of a project is only seen in one.

`--only-usable` is for an app whose model list has grown past what can be
used, as it does when everything a gateway lists is imported. It looks at
every model that is switched on and that the file does not name, and
switches off:

- a model that a provider without a key **bills for**, by what the provider's
  own list says (a price above zero, or the gateway's word that it is not
  free). No request is made for these;
- a chat model that the provider **refuses** one word: no access, no credit,
  no such model (an answer of 400 to 405, 410 or 422).

A model that is limited or busy at the moment (429, 5xx), or that takes
longer than 100 seconds, stays as it is and is listed: run it again later.
Models for pictures, video, speech, listening and embeddings are not judged,
because a word cannot try them. The models the file names are never touched
by it (`--test` is for those). Nothing is deleted: a model is switched on
again on the Models page. It needs version 1.7 of the app, which passes on
what a provider's list says of its prices; a provider that lists more than
120 models without saying what they cost is left alone, so that the check
does not become hundreds of requests.

Without the node, against any app that can be reached:

```bash
NEXUS_PASSWORD=... python3 scripts/host/workforce.py --url https://nexus.example.com --user admin --dry-run
```

### The file

```json
{
  "providers": {
    "gemini": { "timeoutMs": 300000 },
    "OVHcloud AI Endpoints": { "adapter": "openai-compatible", "baseUrl": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
                               "authType": "none", "timeoutMs": 300000, "notes": "No key. 2 requests a minute for each model." }
  },
  "models": {
    "writer": { "provider": "anthropic", "model": "claude-sonnet-5-5", "displayName": "Claude Sonnet 5.5",
                "capabilities": ["text", "tool_calling", "vision"], "contextWindow": 1000000,
                "inputPricePerMTok": 2, "outputPricePerMTok": 10 },
    "spare":  { "provider": "OVHcloud AI Endpoints", "model": "gpt-oss-120b", "inputPricePerMTok": 0, "outputPricePerMTok": 0 },
    "slow":   { "provider": "OVHcloud AI Endpoints", "model": "Meta-Llama-3_3-70B-Instruct", "enabled": false },
    "pictures": { "provider": "gemini", "model": "gemini-nano-banana-2.1", "capabilities": ["image_generation"], "pricePerImage": 0.0336 }
  },
  "skills": {
    "house-style": { "file": "skills/house-style" },
    "short-notes": { "description": "Three rules for notes.", "instructions": "One line each. A date. A name." }
  },
  "agents": [
    { "name": "Copywriter", "role": "Copywriter", "primary": "writer", "fallback": "spare",
      "tools": ["read_file", "write_file"], "maxSteps": 8, "memory": true, "skills": ["house-style"],
      "instructions": ["Writes captions and headlines in the brand's voice.", "", "How you work:", "- ..."] }
  ],
  "teams": [ { "name": "Content", "description": "...", "agents": ["Copywriter"], "skills": ["short-notes"] } ],
  "workflows": [ { "name": "Post", "description": "...", "steps": [
    { "title": "Caption", "role": "Copywriter", "objective": "...", "acceptanceCriteria": "..." },
    { "title": "Picture", "role": "Copywriter", "kind": "image", "media": { "aspectRatio": "9:16" }, "dependsOn": [1], "objective": "..." }
  ] } ],
  "tryRun": { "goal": "A caption for a coffee cart, and three hashtags.", "manager": "spare", "maxTasks": 3, "everyAgent": true }
}
```

- **`providers`**: a provider by its name in the app, or by its kind
  (`anthropic`, `gemini`, `openai-compatible`, `custom-http`) when the app has
  one of that kind. `timeoutMs` is how long the app waits for an answer
  (1,000 to 300,000). An agent's request is answered in one piece, so a model
  that thinks before it writes needs more than the 60 seconds a new provider
  has. With `adapter` and `baseUrl` (and optionally `authType`, `mediaApi`,
  `notes`) the entry also says what the provider is, under the name it is to
  have: enough to add one that takes no key.
- **`models`**: a name of your choice for each model, used by the agents
  below. `provider` as above, `model` as the provider names it. Optional:
  `capabilities`, `displayName`, `contextWindow`, and the prices
  `inputPricePerMTok`, `outputPricePerMTok`, `pricePerImage`,
  `pricePerSecond`, `pricePerMChars`, and `enabled` (`false` switches the
  model off). Give `capabilities` where the provider's list does not say what
  a model is: Gemini lists its Nano Banana image models like chat models, and
  Anthropic lists names only.
- **`skills`**: the name of each skill, and where it is: `file`, a folder
  with a `SKILL.md` next to the definition file (or one Markdown file), or
  the words themselves as `description` and `instructions`. The name is the
  one in the `SKILL.md`'s front matter, which this program reads as one line
  for each key (`name: ...`, `description: ...`). The other text files of
  the folder come with the skill, each up to 256 KB. `"uploaded": true`
  (with an optional `about`) names a skill of your own that is in the app
  and not in the file.
- **`agents`**: `name`, `role`, `primary` and, optionally, `fallback` (model
  names from above), `instructions` (text, or a list of lines), `tools`,
  `maxSteps` (1 to 40), `memory`, `temperature`, `skills` (names from above).
  The AI Manager sees the first 160 characters of the instructions when it
  shares out tasks: say there what the agent is for. A model that only makes
  images, speech or embeddings cannot be an agent's model.
- **`teams`**: `name`, `description`, `agents` (names), and `skills`: every
  member has those while it works in a project of the team.
- **`workflows`**: `name`, `description`, `steps`. A step has `title`,
  `objective`, `role` (the name of an agent, or a role), and optionally
  `acceptanceCriteria`, `dependsOn` (numbers of earlier steps), `outputFile`,
  `kind` (`text`, `image`, `video`, `audio`, `render`) and `media`
  (`aspectRatio`, `durationSeconds`, `voice`, `subtitles`, `imageFrom`, ...),
  as on the Workflows page. A new project allows 12 tasks and 10 generated
  files: a workflow within that runs without changing a project's limits.
- **`tryRun`**: what `--try-run` does. `goal`, and `manager`: the model (a
  name from above) that plans the goal and sums the tasks up. Optional:
  `team` (the agents that may get a task; all of them otherwise), `maxTasks`
  (3 unless given), and `everyAgent` (a second project with one task for
  each of those agents; a project takes 40 tasks).

What [`workforce.json`](workforce.json) holds is said in its `about`.

### The teams of the committed file

Each team is for one kind of work, and its description names the workflow
that goes with it. A project is made with the team and the workflow of the
same row; a workflow with pictures or voice-overs also needs the project's
image and speech models set.

| Team | Agents | Workflow | What it makes | Skills of the team |
| --- | --- | --- | --- | --- |
| Software Team | Manager, CEO, Designer, Frontend, Backend, QA, Security Engineer, Tester, DevOps | Software delivery | 10 steps: 10 written | (its agents' own) |
| Xiero Nexus AI | the same nine | Software delivery | 10 steps: 10 written | *xiero-nexus-ai* |
| Short Reels Team | Short Reels, Designer, Copywriter, QA | Short Reels | 12 steps: 2 written, 5 pictures, 4 voice-overs, 1 joined video | short-reels, product-image-prompts, anti-ai-slop-copy |
| Video Product | Video Director, Designer, Copywriter, QA | Video Product | 12 steps: 2 written, 5 pictures, 4 voice-overs, 1 joined video | product-video, product-image-prompts, anti-ai-slop-copy |
| Brosur & Katalog | Art Director, Copywriter, Designer, Print Designer, QA | Brosur & Katalog | 8 steps: 5 written, 3 pictures | brochure-catalog, anti-ai-slop-design, anti-ai-slop-copy |
| Website E-commerce | Commerce Strategist, Art Director, Copywriter, Designer, Frontend, Backend, SEO Specialist, Security Engineer, QA | Website E-commerce | 11 steps: 11 written | *xiero-premium-web-studio*, ecommerce-store, anti-ai-slop-design |
| Landing Page | Commerce Strategist, Art Director, Copywriter, Designer, Frontend, SEO Specialist, QA | Landing Page | 7 steps: 6 written, 1 pictures | *xiero-premium-web-studio*, anti-ai-slop-design, anti-ai-slop-copy |
| Plugin Minecraft Premium | Minecraft Game Designer, Minecraft Plugin Developer, Minecraft QA, Technical Writer | Plugin Minecraft Premium | 10 steps: 10 written | minecraft-paper-plugin, minecraft-premium-product |
| Addon Minecraft Premium | Minecraft Game Designer, Minecraft Addon Developer, Minecraft QA, Technical Writer | Addon Minecraft Premium | 9 steps: 9 written | minecraft-bedrock-addon, minecraft-premium-product |
| Setup Server Minecraft | Minecraft Server Admin, Minecraft QA, Technical Writer | Setup Server Minecraft | 8 steps: 8 written | minecraft-server-setup, linux-server-hardening |
| Developer Minecraft | Minecraft Game Designer, Minecraft Plugin Developer, Minecraft Addon Developer, Minecraft Server Admin, Minecraft QA, Technical Writer | Fitur Minecraft Custom | 7 steps: 7 written | *xiero-minecraft-forge*, minecraft-premium-product |
| Install Panel + Wings Pterodactyl | Pterodactyl Engineer, DevOps, Security Engineer, Technical Writer, QA | Install Panel + Wings Pterodactyl | 8 steps: 8 written | pterodactyl-panel-wings, linux-server-hardening |
| Bot Discord | Discord Bot Developer, Tester, Technical Writer | Bot Discord | 5 steps: 5 written | discord-bot |
| Konten Media Sosial | Social Media Strategist, Designer, Copywriter, QA | Konten Carousel | 8 steps: 3 written, 5 pictures | social-media-content, anti-ai-slop-copy, product-image-prompts |
| Artikel SEO | SEO Specialist, Copywriter, QA | Artikel SEO | 4 steps: 4 written | seo-content, anti-ai-slop-copy |
| Proposal & Penawaran | Sales Consultant, Copywriter, QA | Proposal & Penawaran | 4 steps: 4 written | sales-proposal, anti-ai-slop-copy |

The agents write documents and files into the project's workspace. Without a
sandbox runner on the server they do not compile, start a game or run a
command, and no workflow touches a customer's machine: each ends with a test
list, a checklist or a review for a person, and says what was not run. The
pictures are made by a free model that makes squares of 1024 pixels and no
lettering; they stand in for the client's own photographs.

The skills are in [`skills/`](skills), one folder each. They say how the work
is done, what to check against the official documentation instead of
memory, and what must never be invented. They were written for this file and
are **untried as skills**: no project was judged with and without them.

The three in *italics* are the owner's own and are not in this repository:
they are uploaded to the app (the Skills page, or sealed for the node, see
[Sealed for the node](#sealed-for-the-node)), and the team has them once
they are there. In a task the team's skills come after the agent's own, in
the order of the table: the owner's standard first.

### Providers that cost nothing

The committed file adds four providers that take no key, and uses no model
that is billed:

| Provider | What it has | What it allows from one address |
| --- | --- | --- |
| [Kilo Gateway](https://kilo.ai) | A handful of chat models marked `:free`, which change often | 200 requests an hour by its documentation, all models together; about a hundred when it was counted on one server |
| [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) | Open chat models, Stable Diffusion XL for pictures (1024 by 1024 only), hosted in the EU | 2 requests a minute for each model |
| [LLM7](https://llm7.io) | A few chat models; the others it lists need its paid plan | 1 request a second, and an allowance for a day that a few tasks use up |
| [Pollinations](https://pollinations.ai) | One chat model (GPT-OSS 20B) on its old open text API; its newer API takes a key | One request at a time; no number is published |

That is little: an agent with tools makes several requests for one task. The
app waits and asks again when a provider answers "too many requests" (see
`PROVIDER_RETRIES` in the main README), and an agent whose first model does
not answer goes on with its second, so a project gets done, slowly. The
agents have their first model with Kilo Gateway and their second with
OVHcloud or Gemini. None depends on LLM7, whose allowance was used up after
a few tasks, or on the one model of Pollinations: those are in the app to be
picked by hand. When Kilo
Gateway's allowance is used up it answers "sign up for free or come back
later", and every agent works on its second model: on one server each of
the eleven agents then did its small task there, in ten minutes instead of a
minute and a half. A free account at Kilo gives a key, which the provider
takes on the Providers page. The
providers list far more models than they give away: one word from each
(`--test`) is how the ones in the file were found. Kilo Gateway and LLM7 may
log what is sent to their free models and use it to improve models: nothing
confidential belongs there. A free key of a provider (Google AI Studio, Groq,
Mistral, OpenRouter, NVIDIA NIM, GitHub Models, Cloudflare Workers AI, and
Kilo Gateway and LLM7 themselves) allows more than no key; such a provider
is added on the Providers page, and its models can then be named in the
file. Which providers give what for nothing changes by the month: the lists
this was taken from are
[awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) and
[awesome-free-ai-coding](https://github.com/mvalentsev/awesome-free-ai-coding),
read on 2026-11-15.

## Tidying up: `disk-report.sh`

```bash
sudo bash disk-report.sh > report.txt
```

**It only reads.** It deletes nothing, changes nothing, writes no file of its
own and stops no service. Measuring a large disk takes a few minutes; progress
is shown on the terminal and the report goes to the file.

The report has: how full each disk is; the largest folders; what Pterodactyl
keeps (server files, backups, logs, the largest servers, folders of servers
that Wings no longer has); what Docker keeps (images, stopped containers,
volumes that nothing uses, large container logs); logs; packages; temporary
files; home folders; the database server's files; single files of 500 MB and
more; space held by deleted files; memory.

Servers appear by the first 8 characters of their ID, never by name, and no
password, key, token or address is printed, so the report can be shown to
someone who helps. It does contain folder and file names of the machine:
read it before you pass it on.

### Reading it

The report says what is there. What can go is a decision; these are the
usual candidates, from harmless to "look first":

| In the report | What it usually is | Clearing it |
|---|---|---|
| Downloaded packages | Package files that are installed already | `apt-get clean` |
| Packages nothing needs any more | Old kernels and libraries | `apt-get autoremove --purge` (read the list it shows before you confirm) |
| Journal | The system's own log | `journalctl --vacuum-size=200M` |
| Large files in `/var/log` | Logs that are not rotated | Find out which program writes it; set up rotation rather than deleting once |
| Large container logs | Console output Docker keeps for a container | For a Pterodactyl server, starting it again empties it. For another container: recreate it, and set a `max-size` log option in `/etc/docker/daemon.json` so that the log cannot grow back |
| Images without a name, images no container uses | Old versions of server images | `docker image prune` removes the unnamed ones; with `-a` also every image no container uses, which is then downloaded again when a server needs it |
| Stopped containers, "Others" | Containers of things that no longer run | Look at each name. `docker rm <name>` removes one |
| Old backups | Backups of servers, kept on the node | Delete them **in the panel**, on the server's Backups page, so that the panel's list stays right |
| Folders of servers that Wings does not have | Files of servers that were deleted while the node was offline, or of a failed transfer | **Check each ID in the panel first.** A server that is being installed, transferred or restored can look like this too |
| Deleted files still held open | A program keeps writing to a file that was deleted | Restart that program |

And what **not** to do:

- **Never run `docker volume prune` or `docker system prune --volumes`** on
  the word of the report alone. A volume that no container uses right now can
  hold the panel's database or a site's uploads; the report lists such
  volumes so that each can be looked at.
- **Do not delete anything inside `/var/lib/pterodactyl/volumes/<id>` by
  hand** for a server that exists. Those are a customer's files. Use the
  panel's file manager, or delete the server in the panel.
- **Do not delete files in `/var/lib/docker` by hand.** Docker keeps track of
  them; remove things with `docker` commands.
- **Do not delete MySQL / MariaDB files by hand**, binary logs included. Use
  `PURGE BINARY LOGS` in the database.

`REPORT_ROOT=/mnt/disk` looks at the folders of another disk instead of `/`,
and `TOP=30` makes the lists longer.

## From somewhere else: `over-ssh.sh`

When you are not signed in to the node, `over-ssh.sh` signs in for you, sends
the scripts of this folder along and runs one of them there:

```bash
export DEPLOY_HOST=node.example.com DEPLOY_SERVER=1a2b3c4d
read -rs DEPLOY_PASSWORD && export DEPLOY_PASSWORD   # or DEPLOY_SSH_KEY, or your own ssh keys

bash scripts/host/over-ssh.sh check        # what is on the node; changes nothing
bash scripts/host/over-ssh.sh plan         # what an upgrade would do; changes nothing
bash scripts/host/over-ssh.sh upgrade      # the upgrade, without asking again
bash scripts/host/over-ssh.sh disk-report > report.txt

# For a server that does not have the app yet:
bash scripts/host/over-ssh.sh install-plan -- --move-aside   # changes nothing
bash scripts/host/over-ssh.sh install -- --move-aside

# The public address (DEPLOY_APP_URL=https://nexus.example.com):
bash scripts/host/over-ssh.sh site-plan    # changes nothing
bash scripts/host/over-ssh.sh site

# The workforce of workforce.json:
bash scripts/host/over-ssh.sh workforce-plan            # changes nothing
bash scripts/host/over-ssh.sh workforce -- --test
```

`check` runs [`node-check.sh`](node-check.sh). It says whether Wings and
Docker are there, which servers hold the app, what is in the named server's
files, what that server runs when it starts, and how the site's address is
answered on the machine: where the name leads, what listens on ports 80 and
443, whether a web server's configuration names the site. It shows no
setting's value. With `-- --try-image` it also starts a container from the
server's image for a moment, without network and without any server's files,
to say which Node.js, ffmpeg and `ts-node` the image holds.

Options for the host script go after `--`, for example
`over-ssh.sh upgrade -- --with-media`. All settings come from the environment
(`over-ssh.sh --help` lists them), so that no password is on a command line.

- **The script does not depend on the connection.** It runs on the node in a
  session of its own. If the connection is lost in the middle, an upgrade
  still finishes there, or goes back by itself; `over-ssh.sh last-log` shows
  what it said and how it ended.
- **What each run said is kept on the node**, in `~/xiero-nexus-remote/logs`
  of the user that signed in, readable by that user only. The newest 20 are
  kept.
- **The node's host key.** Give it as `DEPLOY_HOST_KEY` (`ssh-ed25519 AAAA…`)
  and nobody else can answer in the node's place. Without it, the key the
  node shows is accepted and printed with its fingerprint, to be compared on
  the node (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and set from
  then on.
- **Root, or sudo.** Sign in as root, or as a user who may use `sudo` without
  a password; the scripts themselves run as root either way.
- Signing in with a password needs OpenSSH 8.4 or newer on the machine that
  runs `over-ssh.sh`. A key is the better choice: a password that works from
  anywhere is worth more to whoever finds it.

### From GitHub Actions

The workflow [`Deploy to a Pterodactyl node`](../../.github/workflows/deploy.yml)
does the same from a runner. It only starts by hand: **Actions**, the
workflow's name, **Run workflow**, then pick `check`, `plan`, `upgrade`,
`install-plan`, `install`, `site-plan`, `site`, `workforce-plan`, `workforce`,
`disk-report`, `last-log` or `input-key`. For `workforce-plan` and
`workforce`, the workflow runs the `workforce.json` of the branch it is
started on; more options, such as `--update` or `--test`, go in **options**.

It reads these secrets (**Settings**, **Secrets and variables**, **Actions**):

| Secret | |
|---|---|
| `VPS_HOST` | Host name or address of the node. |
| `VPS_USER` | Who to sign in as: `root` (the default), or a user with sudo without a password. |
| `VPS_PASSWORD` or `VPS_SSH_KEY` | That user's password, or a private key. |
| `VPS_PORT` | The SSH port, when it is not 22. |
| `VPS_HOST_KEY` | The node's host key, `ssh-ed25519 AAAA…`. Without it, each run accepts the key the node shows. |
| `PTERODACTYL_SERVER` | The server's UUID or its first 8 characters. Can also be typed when a run is started. |
| `APP_URL` | The public address of the site. Can also be typed. After `upgrade`, `install` and `site` the runner asks `/api/health` there, as a visitor would: by the name, and with the certificate checked. |

**The log of a workflow in a public repository can be read by anyone**, and
what a node says about itself is nobody else's business. So:

- What is typed when a run is started (server, address, host key) is hidden
  in the log, as secrets are.
- What the node says is **not printed**, unless the repository is private or
  `show_output` is ticked. The run's page says how the script ended; the
  output stays on the node, in `~/xiero-nexus-remote/logs`.
- To read it without signing in to the node, start the run with an
  `output_key`. The output is then sealed for the holder of that key and
  stored as an object of the repository that no branch contains:

  ```bash
  bash scripts/host/sealed-output.sh keygen ~/.xiero-deploy    # once; prints the output_key
  bash scripts/host/sealed-output.sh read ~/.xiero-deploy/key.pem <run id>
  ```

  `key.pem` is the private key. Keep it outside the repository.

#### Sealed for the node

What goes the other way, from you to the node, passes the same public place:
the options of a run can be read by others. A password for an account, or a
skill of your own that is not to be published, is therefore sealed for the
node first, and only the node opens it:

```bash
# 1. Once: the node makes a key pair and prints the public half (action "input-key").
#    The private half stays on the node, in ~/xiero-nexus-remote/input-key.
# 2. Seal with that line. What comes out is one word of letters and dots.
printf '%s' 'the password' | bash scripts/host/sealed-output.sh seal-line '<the line>'
bash scripts/host/sealed-output.sh seal-line '<the line>' < my-skill/SKILL.md
# 3. Give it in the options of the action "workforce":
#    --only accounts --account dewi --account-email dewi@example.com --account-role owner --account-password-sealed <word>
#    --only skills,teams --update --skill-sealed <word>
```

`workforce.sh` opens it on the node, hands the password to `workforce.py`
in its environment and the skill as a file of its own that is deleted when
the program ends. Neither is printed, by the runner or by the node. All
options of a run together may be about 65,000 characters: a skill of some
ten thousand words fits; a larger one, or one with many files, is uploaded
on the Skills page.

Anyone who may push to the repository can start this workflow and so act as
root on the node. Give that right to people you would give the password to. A
key that is only used here, which you can take off the node again
(`~/.ssh/authorized_keys`), is better than the password of root.

## Tests

The scripts have tests that run them on a made-up Wings host in a temporary
folder:

```bash
# The upgrade: two real bundles, an old one and a new one (about 4 minutes).
OLD_ZIP=old.zip NEW_ZIP=new.zip bash scripts/host/test/run.sh

# The first installation: one real bundle (about a minute). With TS_NODE the
# server is also started the way the common Node.js egg starts it.
NEW_ZIP=new.zip TS_NODE=/path/to/ts-node bash scripts/host/test/install.sh

# The report (about half a minute).
bash scripts/host/test/report.sh

# Running them from somewhere else (about a minute): starts an SSH server on
# 127.0.0.1 for the time of the test and signs in to it.
bash scripts/host/test/over-ssh.sh

# The public address (about a minute): starts the machine's nginx program in
# a temporary folder, on ports 8480 and 8443. NGINX_BIN names another one.
bash scripts/host/test/site.sh

# The workforce (under a minute, after "npm run build"): starts the built app
# with the mock providers of the end-to-end tests, puts the committed
# workforce.json into it, and runs both of its workflows in a project.
bash scripts/host/test/workforce.sh
```

`test/fake-wings.mjs` stands in for Wings and for the server's container: it
answers the requests the scripts make the way Wings does, and "runs" a server
by starting the bundle in its folder as a plain process. It follows Wings in
the things that matter to the upgrade: a power request is answered at once
and carried out later, one at a time; a server still reports "offline" while
its start is being prepared; and a server whose process ends by itself is
started once more. `test/docker` stands in for the `docker` command.

The upgrade test covers, among others: a dry run; the upgrade with the old
database, accounts and `.env` kept; going back to a backup; a new version
that changes the database and then does not start; a server that does not
stop; a restart asked for in the panel a moment before; a slow start; a
stopped and a suspended server; a wrong token; a download that does not match
its checksum; and, as root, who owns the files afterwards. The report test
also checks that making the report changed no file and sent Wings and Docker
nothing but questions.

`SHOW=1` prints what the script said at each step. As root, the upgrade test
also checks the owner of the files:
`sudo env "PATH=$PATH" OLD_ZIP=… NEW_ZIP=… bash scripts/host/test/run.sh`.

The test of `over-ssh.sh` mostly uses stand-ins for the host scripts that say
what they were given: which options, which settings, nothing to read. It
covers signing in with a key, a host key that is given, missing or wrong, the
exit codes, where the output goes, a connection that is cut in the middle,
the logs on the node, sealing and opening an output, and what the workflow's
script lets into the log. `node-check.sh` and `disk-report.sh` also run for
real over SSH, on made-up folders. As root
(`sudo env "PATH=$PATH" bash scripts/host/test/over-ssh.sh`) it makes a user
for the time of the test to sign in with a password, as the workflow does,
and to run through `sudo`.

The installation test sets the made-up server up as the common Node.js egg
leaves one: the source code at the top of its files, and a startup that runs
`index.js`. It covers the dry run, what the installer refuses, the move of
the source code, the `.env` it writes and that neither the key nor the
password is printed, the start through Wings, signing in as the first
administrator, a stop that reaches the app once, `--start` of the upgrade
script, and a server that does not come up. With `TS_NODE` it does all of
that a second time with the server's file started through `ts-node --esm`.

The test of `nginx-site.sh` is the one with nothing made up about nginx: it
starts the real program with a configuration of its own, in a temporary
folder and on ports of its own, with other sites in it the way a node with a
panel has them, and looks at what a visitor gets. The app is a few lines of
Node.js. certbot is a stand-in that does what certbot and Let's Encrypt do
between them: it asks the site for a file it has put into the folder for
that, and only then makes a certificate, signed by an authority made up for
the test, and kept the way certbot keeps certificates: new files each time,
behind links. It covers the dry run; everything the script refuses; each
step failing, with nginx as it was afterwards, also when nginx does not take
the configuration or the script is stopped in the middle; two runs at once;
what reaches the app (the name, https, the visitor's address whatever the
visitor claims); an answer that arrives bit by bit; uploads; a second run; a
certificate that ends soon, and one whose file was overwritten in place;
`--remove`; and for every case that the other sites, and a name no site has,
get exactly what they got before: the same answer, the same certificate, the
same protocol.
It does so for nginx laid out the Debian way and with `conf.d`, for sites
that listen on one address, with and without `default_server`, with HTTP/2
either way, and where nginx would read the new file first. It has passed
with nginx 1.24, 1.26, 1.28 and 1.30. **The real certbot and the real Let's
Encrypt are not part of it.**

CI runs all five on every push: the report test, the SSH test and the nginx
test as a plain user and as root, and for Node.js 20 and 22 the upgrade test
from the released bundle of v1.4.0 to the bundle it has just built and the
installation test of that bundle, with `ts-node` 10.9 and TypeScript 6.0.
That is still a made-up host, an SSH server and an nginx on the runner
itself: no test here signs in to a real node or talks to a real Wings.
