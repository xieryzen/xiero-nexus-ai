# Scripts for the machine that hosts the app

Scripts for whoever runs Xiero Nexus AI on a **Pterodactyl** server and has
root on the machine that runs **Wings** (the node). They run there; they are
not part of a release bundle and the app never runs them.

| Script | What it is for |
|---|---|
| [`pterodactyl-install.sh`](pterodactyl-install.sh) | Put the app on a server that does not have it yet: the bundle, its `.env`, and the file the server starts. |
| [`pterodactyl-upgrade.sh`](pterodactyl-upgrade.sh) | Upgrade the app on one server to a new release, with a backup, and go back by itself if the new version does not come up. |
| [`disk-report.sh`](disk-report.sh) | A read-only report of what fills the machine's disk, to decide what to tidy up. |
| [`node-check.sh`](node-check.sh) | A read-only look at the node before an upgrade: Wings, Docker, which servers hold the app, what is in one server's files. |
| [`over-ssh.sh`](over-ssh.sh) | Run one of the three on the node from another machine, over SSH. The [Deploy workflow](#from-github-actions) uses it. |

All of them are tested on a made-up Wings host (see [Tests](#tests)), written
from the source of Wings 1.12; no test here talks to a real Wings. Outside
the tests, the installer, the start it ends with, the check and the disk
report have been used on one real node (Debian 13, Docker 29, the Node.js egg
of ptero-eggs), in November 2026. **The upgrade itself has not yet run
against a real Wings.** It is built for that: it has a dry run, asks before it
starts, keeps a backup outside the server's files, and puts the old version
back when the new one does not answer.

Get them on the node:

```bash
for name in pterodactyl-install.sh pterodactyl-upgrade.sh disk-report.sh node-check.sh; do
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
`install-plan`, `install`, `disk-report` or `last-log`.

It reads these secrets (**Settings**, **Secrets and variables**, **Actions**):

| Secret | |
|---|---|
| `VPS_HOST` | Host name or address of the node. |
| `VPS_USER` | Who to sign in as: `root` (the default), or a user with sudo without a password. |
| `VPS_PASSWORD` or `VPS_SSH_KEY` | That user's password, or a private key. |
| `VPS_PORT` | The SSH port, when it is not 22. |
| `VPS_HOST_KEY` | The node's host key, `ssh-ed25519 AAAA…`. Without it, each run accepts the key the node shows. |
| `PTERODACTYL_SERVER` | The server's UUID or its first 8 characters. Can also be typed when a run is started. |
| `APP_URL` | The public address of the site. Can also be typed. After an upgrade the runner asks `/api/health` there. |

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

CI runs all four on every push: the report test, the SSH test as a plain
user and as root, and for Node.js 20 and 22 the upgrade test from the
released bundle of v1.4.0 to the bundle it has just built and the
installation test of that bundle, with `ts-node` 10.9 and TypeScript 6.0.
That is still a made-up host and an SSH server on the runner itself: no test
here signs in to a real node or talks to a real Wings.
