# Scripts for the machine that hosts the app

Scripts for whoever runs Xiero Nexus AI on a **Pterodactyl** server and has
root on the machine that runs **Wings** (the node). They run there; they are
not part of a release bundle and the app never runs them.

| Script | What it is for |
|---|---|
| [`pterodactyl-upgrade.sh`](pterodactyl-upgrade.sh) | Upgrade the app on one server to a new release, with a backup, and go back by itself if the new version does not come up. |
| [`disk-report.sh`](disk-report.sh) | A read-only report of what fills the machine's disk, to decide what to tidy up. |
| [`node-check.sh`](node-check.sh) | A read-only look at the node before an upgrade: Wings, Docker, which servers hold the app, what is in one server's files. |
| [`over-ssh.sh`](over-ssh.sh) | Run one of the three on the node from another machine, over SSH. The [Deploy workflow](#from-github-actions) uses it. |

The first two were tested on a made-up Wings host (see [Tests](#tests)),
written from the source of Wings 1.12. **Neither has been run against a real
Wings by this repository's tests.** The upgrade script is built for that: it
has a dry run, asks before it starts, keeps a backup outside the server's
files, and puts the old version back when the new one does not answer.

Get them on the node:

```bash
curl -fsSLO https://raw.githubusercontent.com/xieryzen/xiero-nexus-ai/main/scripts/host/pterodactyl-upgrade.sh
curl -fsSLO https://raw.githubusercontent.com/xieryzen/xiero-nexus-ai/main/scripts/host/disk-report.sh
```

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
```

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
`disk-report` or `last-log`.

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

CI runs all three on every push: the report test, the SSH test as a plain
user and as root, and the upgrade test from the released bundle of v1.4.0 to
the bundle it has just built, for Node.js 20 and 22. That is still a made-up
host and an SSH server on the runner itself: no test here signs in to a real
node or talks to a real Wings.
