# The runner: where programs and builds run

Xiero Nexus AI never runs code itself. What an agent runs with `run_command`,
what the **Execute** box of a workspace runs, and the build that turns the
files of a project into its package (a plugin's `.jar`) all run here: a small
HTTP server in a container of its own, apart from the app. The app sends the
files and one command, and gets back what the command printed and the files
it was asked to keep.

Without a runner (`SANDBOX_URL` unset) nothing is run: the app says so, the
project page says that this server has no runner to build with, and a project
is still shown with all its files.

## On a Pterodactyl node

`scripts/host/runner-service.sh` sets everything up next to the server that
runs the app, and tells the app where it is:

```bash
sudo bash runner-service.sh --server <server id> --dry-run   # the plan, nothing changed
sudo bash runner-service.sh --server <server id>
```

It builds the image on the node, starts the container on the Docker network
of the server at an address that stays the same, checks it (who a program
runs as, that private addresses are refused and the outside is reached, that
a Paper plugin builds, that the app's container reaches it), writes
`SANDBOX_URL`, `SANDBOX_TOKEN` and `SANDBOX_MAX_SECONDS` into the server's
`.env` and starts the server again. `--remove` takes it away. Over SSH or
from the repository's **Deploy** workflow these are the actions `runner-plan`
and `runner` ([scripts/host/README.md](../README.md)).

## What is in the image

Debian 13, Node.js 20, Python 3, JDK 17, 21 and 25, Maven 3.9 and Gradle 8
and 9. `gradle` is a small launcher (`gradle.sh`): it runs Gradle 9 where the
project's `gradle/wrapper/gradle-wrapper.properties` names version 9 or
newer, and Gradle 8 otherwise. **No wrapper is run** (`./gradlew`, `./mvnw`):
a program is named, not a path, and a wrapper would fetch and run a program
of its own. Gradle finds the JDK a build asks for (its toolchain) among the
three that are installed.

The Paper API of 1.20.4, 1.21.4 and 1.21.8 and what a Maven `jar` build needs
are fetched when the image is built, into caches that builds read and do not
write: a plugin for one of them builds in about half a minute. Anything else
is fetched by the build that needs it, from the internet.

## The boundary

The **container** is the boundary, and the script starts it this way:

- a read-only file system; work happens in a volume of its own, in a folder
  per run that is deleted when the run ends;
- limits on memory (3 GB), processors (2) and the number of processes;
- every program runs as a user of its own (`20000:20000`) that has no right
  of root; whatever a run leaves behind, running or on disk, is removed
  before the next one starts;
- nothing is published to the outside: the app reaches it on the Docker
  network of its server, with a token;
- **the network is closed to private addresses**: rules inside the container
  (`init.sh`) refuse the private ranges, the link-local range, and every
  address of the machine it runs on; IPv6 is refused. A build fetches from
  the internet (Maven Central, the Gradle plugin portal, Paper's repository,
  npm) and reaches neither the node nor the containers next to it. The right
  to change those rules is dropped before the server starts.

A build runs code that somebody wrote: its build script, and the plugins that
script names. That is why it runs here and not in the app's container. What
the boundary does **not** do: a build can use the processors and the network
it is given for as long as it may run (`SANDBOX_MAX_SECONDS`, 900 by default
on a node), and it can fetch anything that is public.

## By hand

```bash
docker build -t xiero-runner scripts/host/runner
docker run -d --name xiero-runner --restart unless-stopped --init \
  --memory 3g --memory-swap 3g --cpus 2 --pids-limit 512 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --mount type=volume,src=xiero-runner-work,dst=/work \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SETPCAP \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges \
  -e RUNNER_TOKEN="$(openssl rand -hex 24)" -e RUNNER_FIREWALL=1 -e RUNNER_RUN_AS=20000:20000 \
  -e RUNNER_MAX_SECONDS=900 -e RUNNER_CONCURRENCY=1 \
  -p 127.0.0.1:8080:8080 xiero-runner
```

The rights it starts with are the ones it needs to close its network and to
start every program as another user; `init.sh` gives up the first before the
server runs. The settings of the server are listed at the top of
`server.mjs`. In the app's `.env`:

```
SANDBOX_URL=http://127.0.0.1:8080
SANDBOX_TOKEN=<the RUNNER_TOKEN>
SANDBOX_MAX_SECONDS=900
```

The app reaches the address `SANDBOX_URL` names although it is a private one;
no other setting is needed for that.

`runner-service.sh` is the reference for the options: start from what it
prints with `--dry-run`. `node scripts/host/runner/selftest.mjs` inside the
container says who programs run as and builds a small Gradle and a small
Maven project.

## The protocol

- `GET /health` → `{ ok, protocol: 2, keeps, stream, maxSeconds, slots,
  running, waiting, separate }`. No token is needed.
- `POST /run`, with `Authorization: Bearer <RUNNER_TOKEN>` and a JSON body:

  | Field | |
  |---|---|
  | `files` | `[{ path, content }]`: the files of the workspace, as text. |
  | `command` | One command: a program by its name and its arguments. No shell: `;`, `|`, `$( )` and a program given as a path are refused. |
  | `timeoutMs` | How long it may run, up to `MAX_SECONDS`. |
  | `keep` | Patterns of files to hand back, such as `build/libs/*.jar`. |
  | `keepMaxFiles`, `keepMaxFileBytes`, `keepMaxTotalBytes` | How much may be handed back. |
  | `stream` | `true`: the answer starts at once and stays open with blank lines until the command has ended, so that nothing between the app and the runner closes a build that takes minutes. |

  The answer: `{ exitCode, stdout, stderr, durationMs, timedOut, kept:
  [{ path, base64 }], notKept: [{ path, reason }], error? }`.

A runner of protocol 1 (the reference runner before v1.12.0) still runs
commands for `run_command` and the Execute box. It hands no files back, so a
build with it leaves no package: set this one up instead.

## Tests

`scripts/host/test/runner.sh` runs `runner-service.sh` against a stand-in for
Docker, on any machine. `scripts/host/test/runner-container.sh` builds the
real image and runs it (it needs Docker; the release workflow runs it): the
user of a run, the network rules, one run after another, and real builds of a
Paper plugin with Gradle 8 and 9 and of a Maven project. `tests/runner-server.test.ts`
drives `server.mjs` by itself.
