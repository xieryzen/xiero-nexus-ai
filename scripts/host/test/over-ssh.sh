#!/usr/bin/env bash
# Tests of what runs the host scripts from somewhere else: over-ssh.sh,
# from-workflow.sh, sealed-output.sh and node-check.sh. An SSH server is
# started on this machine (127.0.0.1 only) for the time of the test, and the
# scripts sign in to it the way they sign in to a node.
#
#   bash scripts/host/test/over-ssh.sh
#
# As a plain user it signs in with a key, as that user. As root
# (sudo env "PATH=$PATH" bash scripts/host/test/over-ssh.sh) it also makes a
# user for the time of the test, to sign in with a password the way the
# workflow does, gives that user sudo for one check, and removes both again.
#
# Most of it uses stand-ins for the host scripts that say what they were
# given; node-check.sh and disk-report.sh also run for real, on made-up
# folders. SHOW=1 prints what was said each time. REQUIRE_SSHD=1 fails where
# there is no sshd, instead of skipping.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
host="${here}/.."
script="${host}/over-ssh.sh"
PORT="${SSH_TEST_PORT:-2299}"
SITE_PORT="${SITE_TEST_PORT:-2298}"

# sshd, useradd and their kind live where a plain user's PATH does not look.
export PATH="${PATH}:/usr/sbin:/sbin"
SSHD="$(command -v sshd 2> /dev/null || true)"
if [ -z "${SSHD}" ]; then
  if [ "${REQUIRE_SSHD:-}" = "1" ]; then
    echo "error: there is no sshd here, and REQUIRE_SSHD is set. Install openssh-server." >&2
    exit 1
  fi
  echo "skipped: there is no sshd on this machine to sign in to (install openssh-server)."
  exit 0
fi
for tool in ssh ssh-keygen ssh-keyscan jq openssl node; do
  command -v "${tool}" > /dev/null 2>&1 || { echo "error: this test needs \"${tool}\"." >&2; exit 1; }
done

WORK="$(mktemp -d)"
OUT="${WORK}/out.txt"       # what the node said
ERR="${WORK}/progress.txt"  # what over-ssh.sh said itself
PRINTED="${WORK}/printed.txt"
NODE="${WORK}/node"         # the folder over-ssh.sh keeps on the node
LOGIN="$(id -un)"
TEST_USER=""
SUDOERS=""
SITE_PID=""
passed=0
failed=0
failures=()

cleanup() {
  if [ -f "${WORK}/sshd.pid" ]; then kill "$(cat "${WORK}/sshd.pid")" 2> /dev/null || true; fi
  if [ -n "${SITE_PID}" ]; then kill "${SITE_PID}" 2> /dev/null || true; fi
  if [ -n "${SUDOERS}" ]; then rm -f "${SUDOERS}"; fi
  if [ -n "${TEST_USER}" ]; then
    pkill -u "${TEST_USER}" 2> /dev/null || true
    userdel -r "${TEST_USER}" > /dev/null 2>&1 || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

begin() { printf '\n── %s\n' "$*"; }
ok() {
  passed=$((passed + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  failed=$((failed + 1))
  failures+=("$1")
  printf '  FAIL %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '         %s\n' "$2"; fi
}
check() { # NAME COMMAND...
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then ok "${name}"; else bad "${name}" "$*"; fi
}
check_not() {
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then bad "${name}" "$*"; else ok "${name}"; fi
}
expect_exit() { # NAME WANTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1" "exit $3 instead of $2"
    sed 's/^/         | /' "${ERR}" | tail -n 12
    sed 's/^/         : /' "${OUT}" 2> /dev/null | tail -n 12
  fi
}
said() { grep -qF -- "$1" "${OUT}"; }      # the node said it
told() { grep -qF -- "$1" "${ERR}"; }      # over-ssh.sh said it itself
printed() { grep -qF -- "$1" "${PRINTED}"; }
wait_until() { # SECONDS COMMAND...
  local deadline=$((SECONDS + $1))
  shift
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 0.3
  done
  return 1
}

# ── An SSH server to sign in to ──────────────────────────────────────────────

ssh-keygen -q -t ed25519 -N '' -f "${WORK}/host_key"
ssh-keygen -q -t ed25519 -N '' -f "${WORK}/client_key"
ssh-keygen -q -t ed25519 -N '' -f "${WORK}/stranger_key"
cp "${WORK}/client_key.pub" "${WORK}/authorized_keys"
HOST_KEY="$(cut -d ' ' -f 1,2 "${WORK}/host_key.pub")"
OTHER_HOST_KEY="$(cut -d ' ' -f 1,2 "${WORK}/stranger_key.pub")"
PASSWORD="pass \$HOME 'word' \"$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')\""

{
  echo "Port ${PORT}"
  echo "ListenAddress 127.0.0.1"
  echo "HostKey ${WORK}/host_key"
  echo "PidFile ${WORK}/sshd.pid"
  echo "AuthorizedKeysFile ${WORK}/authorized_keys"
  echo "KbdInteractiveAuthentication no"
  echo "UsePAM no"
  echo "StrictModes no"
  echo "LogLevel VERBOSE"
  if [ "$(id -u)" = "0" ]; then
    TEST_USER="xiero-test-$$"
    echo "PasswordAuthentication yes"
    echo "PermitRootLogin prohibit-password"
    echo "AllowUsers root ${TEST_USER}"
  else
    echo "PasswordAuthentication no"
  fi
} > "${WORK}/sshd_config"
if [ -n "${TEST_USER}" ]; then
  # The folders above the keys must let the server's users through.
  chmod 755 "${WORK}"
  chmod 644 "${WORK}/authorized_keys"
  useradd -m -s /bin/bash "${TEST_USER}"
  printf '%s:%s\n' "${TEST_USER}" "${PASSWORD}" | chpasswd
  mkdir -p /run/sshd
fi
"${SSHD}" -f "${WORK}/sshd_config" -E "${WORK}/sshd.log"
wait_until 10 test -s "${WORK}/sshd.pid" || { echo "the SSH server of the test did not start:" >&2; cat "${WORK}/sshd.log" >&2; exit 1; }
echo "An SSH server for the test listens on 127.0.0.1:${PORT}; signing in as ${LOGIN}${TEST_USER:+, and as ${TEST_USER} with a password}."

# Stand-ins for the host scripts: they say what they were given.
mkdir "${WORK}/scripts" "${WORK}/bin"
cat > "${WORK}/scripts/pterodactyl-upgrade.sh" << 'EOF'
#!/usr/bin/env bash
echo "ran=$(basename "$0")"
echo "count=$#"
for word in "$@"; do printf 'arg=[%s]\n' "${word}"; done
echo "MY_SETTING=[${MY_SETTING:-}]"
echo "stdin=$(wc -c | tr -d ' ')"
echo "who=$(id -un)"
echo "a line for stderr" >&2
if [ -n "${STAND_IN_SLEEP:-}" ]; then sleep "${STAND_IN_SLEEP}"; fi
echo "the end"
exit "${STAND_IN_EXIT:-0}"
EOF
cp "${WORK}/scripts/pterodactyl-upgrade.sh" "${WORK}/scripts/pterodactyl-install.sh"
cp "${WORK}/scripts/pterodactyl-upgrade.sh" "${WORK}/scripts/disk-report.sh"
cp "${WORK}/scripts/pterodactyl-upgrade.sh" "${WORK}/scripts/node-check.sh"

# An ssh that says which process it is, for the test that cuts a connection.
REAL_SSH="$(command -v ssh)"
printf '#!/bin/sh\necho "$$" >> "%s"\nexec "%s" "$@"\n' "${WORK}/ssh.pids" "${REAL_SSH}" > "${WORK}/bin/ssh"
chmod +x "${WORK}/bin/ssh"

# Run over-ssh.sh against the test's server. What the node said is in ${OUT},
# what over-ssh.sh said itself in ${ERR}, what it printed in ${PRINTED}.
# Settings given in front of the call replace the ones here.
remote() {
  local code=0
  rm -f "${OUT}"
  DEPLOY_HOST="${DEPLOY_HOST-127.0.0.1}" DEPLOY_PORT="${DEPLOY_PORT-${PORT}}" DEPLOY_USER="${DEPLOY_USER-${LOGIN}}" \
    DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY-$(cat "${WORK}/client_key")}" DEPLOY_PASSWORD="${DEPLOY_PASSWORD-}" \
    DEPLOY_HOST_KEY="${DEPLOY_HOST_KEY-${HOST_KEY}}" DEPLOY_SUDO="${DEPLOY_SUDO-no}" \
    DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR-${NODE}}" DEPLOY_SCRIPTS="${DEPLOY_SCRIPTS-${WORK}/scripts}" \
    DEPLOY_OUTPUT="${DEPLOY_OUTPUT-${OUT}}" \
    bash "${script}" "$@" > "${PRINTED}" 2> "${ERR}" < /dev/null || code=$?
  [ -f "${OUT}" ] || : > "${OUT}"
  if [ -n "${SHOW:-}" ]; then
    sed 's/^/      | /' "${ERR}"
    sed 's/^/      : /' "${OUT}"
  fi
  return "${code}"
}
args_are() { # the words the host script got, in order
  local wanted
  wanted="$(printf 'arg=[%s]\n' "$@")"
  [ "$(grep '^arg=' "${OUT}")" = "${wanted}" ]
}

# ── Signing in ───────────────────────────────────────────────────────────────

begin "Signing in"
code=0
remote plan || code=$?
expect_exit "with a key and the node's host key: the script runs" 0 "${code}"
check "  it is the upgrade script that ran" said "ran=pterodactyl-upgrade.sh"
check "  as the user that signed in" said "who=${LOGIN}"
check "  over-ssh.sh says that it ended well" told "ended well"
check_not "  what it says itself names no address" told "127.0.0.1"

code=0
DEPLOY_HOST_KEY="" remote plan || code=$?
expect_exit "without a host key: the key the node shows is accepted" 0 "${code}"
check "  and shown, to be kept" said "${HOST_KEY}"
check "  with its fingerprint" said "SHA256:"
check "  and a warning that it was not checked" told "was not checked"

code=0
DEPLOY_HOST_KEY="${OTHER_HOST_KEY}" remote plan || code=$?
expect_exit "another host key than the node's: stops (91)" 91 "${code}"
check "  says that the node showed another key" told "another host key"
check_not "  nothing ran on the node" said "ran="

code=0
DEPLOY_HOST_KEY="127.0.0.1 ${HOST_KEY}" remote plan || code=$?
expect_exit "a host key as ssh-keyscan prints it, with the host in front" 0 "${code}"

code=0
DEPLOY_SSH_KEY="$(cat "${WORK}/stranger_key")" remote plan || code=$?
expect_exit "a key the node does not know: stops (91)" 91 "${code}"
check "  says that the node refused it" told "refused"

code=0
DEPLOY_PORT=1 remote plan || code=$?
expect_exit "a port nothing listens on: stops (91)" 91 "${code}"

code=0
DEPLOY_HOST="${LOGIN}@127.0.0.1:${PORT}" DEPLOY_PORT="" DEPLOY_USER="" remote plan || code=$?
expect_exit "user@host:port in DEPLOY_HOST is understood" 0 "${code}"

begin "Settings that are wrong"
code=0
DEPLOY_HOST="" remote plan || code=$?
expect_exit "no host: 90" 90 "${code}"
code=0
DEPLOY_HOST="-oProxyCommand=touch ${WORK}/owned" remote plan || code=$?
expect_exit "a host that ssh would read as an option: 90" 90 "${code}"
check_not "  and nothing was run" test -e "${WORK}/owned"
code=0
DEPLOY_USER="root -oProxyCommand=x" remote plan || code=$?
expect_exit "a user that is not a user name: 90" 90 "${code}"
code=0
remote restart || code=$?
expect_exit "an action that does not exist: 90" 90 "${code}"
code=0
remote plan --with-media || code=$?
expect_exit "options without \"--\" in front: 90" 90 "${code}"
code=0
DEPLOY_ENV="this is not a setting" remote plan || code=$?
expect_exit "a line in DEPLOY_ENV that is not KEY=VALUE: 90" 90 "${code}"

# ── What reaches the host script ─────────────────────────────────────────────

begin "What the host script is given"
remote plan || true
check "plan: only --dry-run when nothing else is set" args_are --dry-run
DEPLOY_SERVER=" 0a11ce00 " DEPLOY_APP_URL="https://site.example.com" remote plan || true
check "plan: the server, the site's address, --dry-run" args_are --server 0a11ce00 --app-url https://site.example.com --dry-run
DEPLOY_SERVER=0a11ce00 DEPLOY_VERSION=latest remote upgrade || true
check "upgrade: --yes, and no --version for \"latest\"" args_are --server 0a11ce00 --yes
DEPLOY_VERSION=v1.5.0 remote upgrade || true
check "upgrade: a version, with or without the v" args_are --version 1.5.0 --yes
remote upgrade -- --with-media --set "NOTE=it's a \"test\" of \$HOME; rm -rf /" --stop-timeout 120 || true
check "options after \"--\" arrive as they are, quotes and all" args_are --yes --with-media --set "NOTE=it's a \"test\" of \$HOME; rm -rf /" --stop-timeout 120
DEPLOY_SERVER=0a11ce00 DEPLOY_APP_URL="https://site.example.com" remote install-plan -- --move-aside || true
check "install-plan: runs pterodactyl-install.sh" said "ran=pterodactyl-install.sh"
check "  with the server, the address, --dry-run and what came after \"--\"" args_are --server 0a11ce00 --app-url https://site.example.com --dry-run --move-aside
DEPLOY_SERVER=0a11ce00 DEPLOY_VERSION=1.5.0 remote install || true
check "install: --yes" args_are --server 0a11ce00 --version 1.5.0 --yes
DEPLOY_SERVER=0a11ce00 DEPLOY_APP_URL="https://site.example.com" remote check || true
check "check: runs node-check.sh with the server and the site" said "ran=node-check.sh"
check "  " args_are --server 0a11ce00 --site https://site.example.com
DEPLOY_SERVER=0a11ce00 remote disk-report || true
check "disk-report: runs disk-report.sh with no options" said "count=0"
check "  " said "ran=disk-report.sh"
DEPLOY_ENV=$'MY_SETTING=a value with spaces\n\nSTAND_IN_EXIT=0' remote plan || true
check "DEPLOY_ENV reaches the script" said "MY_SETTING=[a value with spaces]"
check "the script has nothing to read" said "stdin=0"

begin "How it ended"
code=0
DEPLOY_ENV="STAND_IN_EXIT=3" remote upgrade || code=$?
expect_exit "the script's exit code is the exit code" 3 "${code}"
check "  the output is there up to its end" said "the end"
check "  over-ssh.sh names the code" told "ended with code 3"

# ── Where the output goes ────────────────────────────────────────────────────

begin "Where the output goes"
remote plan || true
check "with DEPLOY_OUTPUT: in that file" said "the end"
check_not "  and nothing of it is printed" printed "the end"
check_not "  nor in what over-ssh.sh says itself" told "the end"
check "  what a script says on stderr is part of the output" said "a line for stderr"
code=0
DEPLOY_OUTPUT="" remote plan || code=$?
check "without: printed" printed "the end"
remote disk-report || true
check_not "disk-report: its progress (stderr) is kept out of the report" said "a line for stderr"
DEPLOY_ENV="STAND_IN_EXIT=2" remote disk-report || true
check "  and shown after it when the report failed" said "a line for stderr"

# ── On the node ──────────────────────────────────────────────────────────────

begin "What is kept on the node"
logs="${NODE}/logs"
check "a log of every run" test -n "$(find "${logs}" -name '*-plan.log' | head -n 1)"
check "  with how it ended" test -n "$(find "${logs}" -name '*-plan.log.code' | head -n 1)"
check "  readable by that user only" test "$(stat -c %a "${logs}")" = "700"
check_not "the scripts that were sent are gone again" test -n "$(find "${NODE}" -maxdepth 1 -name 'run.*' | head -n 1)"
check_not "no key and no password is among it" grep -rqF -e "PRIVATE KEY" -e "${PASSWORD}" "${NODE}"
for number in $(seq 10 39); do : > "${logs}/20200101-0000${number}-plan.log"; echo 0 > "${logs}/20200101-0000${number}-plan.log.code"; done
remote plan || true
check "only the newest 20 logs are kept" test "$(find "${logs}" -name '*.log' | wc -l | tr -d ' ')" = "20"
check_not "  the oldest went, with what belonged to them" test -e "${logs}/20200101-000010-plan.log.code"
check "  the newest is the run that was just made" grep -qF "the end" "$(find "${logs}" -name '*.log' | sort | tail -n 1)"

begin "A connection that is lost in the middle"
ended_on_node() { [ -n "$(find "${NODE}/logs" -name '*-upgrade.log.code' 2> /dev/null | head -n 1)" ]; }
tidied_up() { [ -z "$(find "${NODE}" -maxdepth 1 -name 'run.*' 2> /dev/null | head -n 1)" ]; }
rm -rf "${NODE}"
: > "${WORK}/ssh.pids"
code=0
PATH="${WORK}/bin:${PATH}" DEPLOY_ENV="STAND_IN_SLEEP=6" remote upgrade &
background=$!
if wait_until 20 grep -qF "Running" "${ERR}"; then
  sleep 1
  kill "$(tail -n 1 "${WORK}/ssh.pids")"
  wait "${background}" || code=$?
  expect_exit "over-ssh.sh says so (92)" 92 "${code}"
  check "  and that the script goes on" told "goes on there"
  code=0
  remote last-log || code=$?
  expect_exit "last-log while it still runs" 0 "${code}"
  check "  says that it has not ended" said "has not ended"
  check "the script goes on by itself, to its end" wait_until 20 ended_on_node
  remote last-log || true
  check "last-log afterwards: how it ended" said "ended with code 0"
  check "  and what it said" said "the end"
  check "  what it left to tidy up is tidied up" wait_until 10 tidied_up
else
  kill "${background}" 2> /dev/null || true
  bad "the run did not start" "$(tail -n 3 "${ERR}")"
fi
rm -rf "${NODE}"
code=0
remote last-log || code=$?
expect_exit "last-log on a node where nothing ran: 1" 1 "${code}"
check "  says so" said "Nothing was run"

# ── The real scripts, on made-up folders ─────────────────────────────────────

begin "node-check.sh on a made-up node"
mkdir -p "${WORK}/host/volumes/0a11ce00-1111-4222-8333-444455556666/xiero-nexus-ai/data" \
  "${WORK}/host/volumes/0b0b0b0b-1111-4222-8333-444455556666" "${WORK}/host/backups"
app="${WORK}/host/volumes/0a11ce00-1111-4222-8333-444455556666/xiero-nexus-ai"
printf 'version=1.4.0\ncommit=a83dc07\nnode=22\nplatform=linux-x64\n' > "${app}/VERSION"
echo "// start" > "${app}/start.js"
echo "// server" > "${app}/server.js"
printf 'SECRET_ENCRYPTION_KEY=never-show-this-value\nAPP_URL=https://old.example.com\n' > "${app}/.env"
echo "x" > "${app}/data/nexus.db"
echo "someone's world" > "${WORK}/host/volumes/0b0b0b0b-1111-4222-8333-444455556666/world.dat"
printf 'system:\n  data: %s\n' "${WORK}/host/volumes" > "${WORK}/host/config.yml"
node_options=(--wings-config "${WORK}/host/config.yml" --backup-dir "${WORK}/host/backups")
code=0
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=0a11ce00 DEPLOY_ENV="PATH=${here}:${PATH}"$'\n'"XIERO_RELEASES_URL=http://127.0.0.1:1/releases" remote check -- "${node_options[@]}" || code=$?
expect_exit "runs over SSH and ends well" 0 "${code}"
check "finds the folder of the server files in the Wings configuration" said "${WORK}/host/volumes"
check "counts the servers and those with the app" said "2 servers have files here; 1 with a Xiero Nexus AI bundle"
check "names the installed version, its commit and Node.js" said "version 1.4.0, commit a83dc07, for Node.js 22"
check "says which names .env sets" grep -qE 'sets: APP_URL SECRET_ENCRYPTION_KEY$' "${OUT}"
check_not "  and none of its values" said "never-show-this-value"
check_not "  nor the old address" said "old.example.com"
check "says which image the server runs in" said "ghcr.io/ptero-eggs/yolks:nodejs_22"
check "says what the server runs when it starts" said '/usr/local/bin/ts-node --esm "/home/container/${MAIN_FILE}"'
check "  and the settings that command names" said "MAIN_FILE=index.js"
check "  one that looks like a secret only as being set" said "GIT_PASSWORD=(set, not shown)"
check_not "  without its value" said "a-password-that-must-stay-hidden"
check "  of the other settings only that they exist" said "also set, values not shown: ACCESS_TOKEN P_SERVER_UUID SERVER_PORT NODE_VERSION"
check_not "  not what they are" said "a-token-that-must-stay-hidden"
check "says who owns the server's files" said "owned by $(id -un)"
check "says that there are no backups yet" said "none yet"
check "says when the releases cannot be reached" said "cannot be reached"
check_not "names nothing of the other server's files" said "world.dat"
code=0
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=0b0b0b0b DEPLOY_ENV="PATH=${here}:${PATH}"$'\n'"XIERO_RELEASES_URL=http://127.0.0.1:1/releases" remote check -- "${node_options[@]}" || code=$?
expect_exit "a server without the app: still ends well" 0 "${code}"
check "  says that it holds no bundle" said "none: no folder here has"
check_not "without --try-image no container is started" said "runs a JavaScript file"
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=0a11ce00 DEPLOY_ENV="PATH=${here}:${PATH}"$'\n'"XIERO_RELEASES_URL=http://127.0.0.1:1/releases"$'\n'"FAKE_DOCKER_LOG=${WORK}/docker.asked" remote check -- "${node_options[@]}" --try-image || true
check "with --try-image: says what the image holds" said "Node.js v22.0.0, npm 10.0.0"
check "  and whether its ts-node runs a main file" said "ts-node --esm runs a JavaScript file"
check "  the container had no network, was not pulled, and is removed" grep -qE '^run --rm --pull never --network none ' "${WORK}/docker.asked"
check_not "  and none of the server's files" grep -qE '^run .*(-v|--volume|--mount) ' "${WORK}/docker.asked"
# A server that holds the app as source code, cloned and never run.
source_server="${WORK}/host/volumes/50c0de00-1111-4222-8333-444455556666"
mkdir -p "${source_server}/src" "${source_server}/node_modules"
printf '{\n  "name": "xiero-nexus-ai",\n  "version": "1.3.1",\n  "private": true\n}\n' > "${source_server}/package.json"
code=0
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=50c0de00 DEPLOY_ENV="PATH=${here}:${PATH}"$'\n'"XIERO_RELEASES_URL=http://127.0.0.1:1/releases" remote check -- "${node_options[@]}" || code=$?
expect_exit "a server with the source code instead of a bundle: ends well" 0 "${code}"
check "  says that it is source code, and of which version" said "version 1.3.1 in ${source_server}"
check "  and that it has not run there" said "there is no database and no key to keep"
code=0
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=ffffffff DEPLOY_ENV="XIERO_RELEASES_URL=http://127.0.0.1:1/releases" remote check -- "${node_options[@]}" || code=$?
expect_exit "a server that is not there: 1" 1 "${code}"
check "  says so" said "there is no server with this ID"
before="$(cd "${WORK}/host" && find . -type f -exec sha256sum {} + | sort | sha256sum)"
DEPLOY_SCRIPTS="${host}" DEPLOY_SERVER=0a11ce00 DEPLOY_ENV="XIERO_RELEASES_URL=http://127.0.0.1:1/releases" remote check -- "${node_options[@]}" || true
check "looking changed no file of the node" test "$(cd "${WORK}/host" && find . -type f -exec sha256sum {} + | sort | sha256sum)" = "${before}"

begin "disk-report.sh over SSH"
mkdir -p "${WORK}/disk/var/log" "${WORK}/disk/home"
head -c 300000 /dev/zero > "${WORK}/disk/var/log/big.log"
code=0
DEPLOY_SCRIPTS="${host}" DEPLOY_ENV="REPORT_ROOT=${WORK}/disk"$'\n'"WINGS_CONFIG=${WORK}/host/config.yml"$'\n'"LIMIT=60" remote disk-report || code=$?
expect_exit "runs and ends well" 0 "${code}"
check "the output is the report" said "== "
check_not "  without the report's progress lines" said "note: not running as root"

# ── Sealed output ────────────────────────────────────────────────────────────

begin "Sealed output"
seal="${host}/sealed-output.sh"
public="$(bash "${seal}" keygen "${WORK}/keys")"
check "keygen makes a key that only its owner can read" test "$(stat -c %a "${WORK}/keys/key.pem")" = "600"
check "  and prints the public key as one line" test "$(printf '%s\n' "${public}" | wc -l | tr -d ' ')" = "1"
check "  a second time it is the same key" test "$(bash "${seal}" keygen "${WORK}/keys")" = "${public}"
printf 'what the node said\nwith "quotes", a $ and an é\n' > "${WORK}/plain.txt"
bash "${seal}" seal "${public}" < "${WORK}/plain.txt" > "${WORK}/sealed.txt"
check "sealed text is three lines" test "$(wc -l < "${WORK}/sealed.txt" | tr -d ' ')" = "3"
check_not "  and shows nothing of the output" grep -qF "node said" "${WORK}/sealed.txt"
check "the key opens it again, the same to the byte" cmp -s "${WORK}/plain.txt" <(bash "${seal}" open "${WORK}/keys/key.pem" < "${WORK}/sealed.txt")
bash "${seal}" keygen "${WORK}/other-keys" > /dev/null
check_not "another key does not" bash "${seal}" open "${WORK}/other-keys/key.pem" < "${WORK}/sealed.txt"
check_not "something that is not a public key is refused" bash "${seal}" seal "bm90IGEga2V5" < "${WORK}/plain.txt"
seq 1 60000 > "${WORK}/long.txt"
check "a long output survives" cmp -s "${WORK}/long.txt" <(bash "${seal}" seal "${public}" < "${WORK}/long.txt" | bash "${seal}" open "${WORK}/keys/key.pem")

# ── The workflow's script ────────────────────────────────────────────────────

begin "from-workflow.sh: what gets into the log"
# A stand-in for gh that keeps what it was asked to store.
cat > "${WORK}/bin/gh" << EOF
#!/usr/bin/env bash
echo "\$*" >> "${WORK}/gh.calls"
case "\$*" in
  "api repos/someone/project/git/blobs --input - --jq .sha")
    cat > "${WORK}/gh.stored.json"
    echo "0123456789abcdef0123456789abcdef01234567"
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/gh"
node -e '
  require("http").createServer((req, res) => { res.statusCode = req.url === "/api/health" ? 200 : 404; res.end("{}"); })
    .listen(Number(process.argv[1]), "127.0.0.1");
' "${SITE_PORT}" &
SITE_PID=$!
wait_until 10 curl -fsS -o /dev/null "http://127.0.0.1:${SITE_PORT}/api/health" || { echo "the stand-in for the site did not start" >&2; exit 1; }

LOG="${WORK}/workflow.log"
workflow() { # the event's JSON; the log is in ${LOG}; returns the exit code
  local code=0
  printf '%s\n' "$1" > "${WORK}/event.json"
  rm -f "${WORK}/gh.stored.json" "${WORK}/summary.md" "${WORK}/runner/node-output.txt"
  mkdir -p "${WORK}/runner"
  PATH="${WORK}/bin:${PATH}" GITHUB_EVENT_PATH="${WORK}/event.json" GITHUB_REPOSITORY="someone/project" GITHUB_RUN_ID=4242 \
    RUNNER_TEMP="${WORK}/runner" GITHUB_STEP_SUMMARY="${WORK}/summary.md" GH_TOKEN="not-a-token" \
    DEPLOY_HOST="${DEPLOY_HOST-127.0.0.1}" DEPLOY_PORT="${PORT}" DEPLOY_USER="${LOGIN}" \
    DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY-$(cat "${WORK}/client_key")}" DEPLOY_PASSWORD="" \
    SECRET_HOST_KEY="${SECRET_HOST_KEY-${HOST_KEY}}" SECRET_SERVER="${SECRET_SERVER-}" SECRET_APP_URL="${SECRET_APP_URL-}" \
    DEPLOY_SUDO=no DEPLOY_REMOTE_DIR="${NODE}" DEPLOY_SCRIPTS="${WORK}/scripts" DEPLOY_ENV="${DEPLOY_ENV-}" DEPLOY_SITE_PAUSE=0 \
    bash "${host}/from-workflow.sh" > "${LOG}" 2>&1 < /dev/null || code=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/      | /' "${LOG}"; fi
  return "${code}"
}
logged() { grep -qF -- "$1" "${LOG}"; }
# The log as a reader sees it: what was asked to be hidden is hidden.
readable_log() {
  local text mask
  text="$(grep -v '^::add-mask::' "${LOG}")"
  while IFS= read -r mask; do
    [ -n "${mask}" ] && text="${text//"${mask}"/***}"
  done < <(sed -n 's/^::add-mask:://p' "${LOG}")
  printf '%s\n' "${text}"
}
reader_sees() { readable_log | grep -qF -- "$1"; }
SERVER_ID="0a11ce00-1111-4222-8333-444455556666"
SITE="http://127.0.0.1:${SITE_PORT}"

code=0
workflow "{\"inputs\":{\"action\":\"plan\",\"server\":\"${SERVER_ID}\",\"app_url\":\"${SITE}/\",\"version\":\"latest\",\"options\":\"\",\"host_key\":\"\",\"output_key\":\"\",\"show_output\":\"false\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "a plan in a public repository ends well" 0 "${code}"
check "the script got what was typed" grep -qF "arg=[${SERVER_ID}]" "${WORK}/runner/node-output.txt"
check "  the site's address without the slash at its end" grep -qF "arg=[${SITE}]" "${WORK}/runner/node-output.txt"
check_not "what the node said is not in the log" logged "the end"
check "  the log says why, and where it is" logged "is not printed"
check_not "the server's ID cannot be read in the log" reader_sees "${SERVER_ID}"
check_not "  nor its short form" reader_sees "0a11ce00"
check_not "  nor the site's address" reader_sees "127.0.0.1:${SITE_PORT}"
check "a notice says how it ended" logged "::notice title=plan::ended well"
check "  and so does the run's summary" grep -qF "plan: ended well" "${WORK}/summary.md"
check_not "nothing was stored in the repository" test -e "${WORK}/gh.stored.json"

workflow "{\"inputs\":{\"action\":\"plan\",\"show_output\":\"true\"},\"repository\":{\"private\":false}}" || true
check "with show_output: what the node said is in the log" logged "the end"
workflow "{\"inputs\":{\"action\":\"plan\",\"show_output\":\"false\"},\"repository\":{\"private\":true}}" || true
check "in a private repository: it is in the log too" logged "the end"

SECRET_SERVER="feedf00d" SECRET_APP_URL="https://from-a-secret.example.com" workflow "{\"inputs\":{\"action\":\"plan\"},\"repository\":{\"private\":false}}" || true
check "nothing typed: the server and the address come from the secrets" grep -qF "arg=[feedf00d]" "${WORK}/runner/node-output.txt"
check "  " grep -qF "arg=[https://from-a-secret.example.com]" "${WORK}/runner/node-output.txt"
SECRET_SERVER="feedf00d" workflow "{\"inputs\":{\"action\":\"plan\",\"server\":\"0a11ce00\"},\"repository\":{\"private\":false}}" || true
check "what is typed comes before the secret" grep -qF "arg=[0a11ce00]" "${WORK}/runner/node-output.txt"
workflow "{\"inputs\":{\"action\":\"upgrade\",\"version\":\"1.5.0\",\"options\":\"--with-media --stop-timeout 120\"},\"repository\":{\"private\":false}}" || true
check "version and more options reach the script" test "$(grep '^arg=' "${WORK}/runner/node-output.txt" | tr '\n' ' ')" = "arg=[--version] arg=[1.5.0] arg=[--yes] arg=[--with-media] arg=[--stop-timeout] arg=[120] "

code=0
workflow "{\"inputs\":{\"action\":\"plan\",\"output_key\":\"${public}\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "with an output key" 0 "${code}"
check "the output is stored sealed" test -s "${WORK}/gh.stored.json"
check "  a notice names the stored object" logged "::notice title=Sealed output::0123456789abcdef0123456789abcdef01234567"
check_not "  what is stored shows nothing of the output" grep -qF "the end" "${WORK}/gh.stored.json"
check "  the key opens it: the node's output, to the byte" cmp -s "${WORK}/runner/node-output.txt" <(jq -r .content "${WORK}/gh.stored.json" | bash "${seal}" open "${WORK}/keys/key.pem")
check_not "  the log still shows nothing of it" logged "the end"
workflow "{\"inputs\":{\"action\":\"plan\",\"output_key\":\"not a key\"},\"repository\":{\"private\":false}}" || code=$?
check "a key that is none: a warning, and the run still ends as the script did" logged "::warning title=Sealed output::"

code=0
workflow "{\"inputs\":{\"action\":\"upgrade\",\"app_url\":\"${SITE}\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "an upgrade that ends well" 0 "${code}"
check "the site is asked from the outside afterwards" logged "::notice title=The site::answers at /api/health"
code=0
workflow "{\"inputs\":{\"action\":\"upgrade\",\"app_url\":\"http://127.0.0.1:1\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "a site that does not answer afterwards: the run still ends as the upgrade did" 0 "${code}"
check "  with a warning" logged "::warning title=The site::"
code=0
workflow "{\"inputs\":{\"action\":\"install\",\"app_url\":\"${SITE}\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "an installation that ends well" 0 "${code}"
check "  the site is asked afterwards too" logged "::notice title=The site::answers at /api/health"
code=0
DEPLOY_ENV="STAND_IN_EXIT=3" workflow "{\"inputs\":{\"action\":\"upgrade\",\"app_url\":\"${SITE}\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "an upgrade that fails: the run fails with its code" 3 "${code}"
check "  an error says so" logged "::error title=upgrade::ended with code 3 on the node"
check_not "  the site is not asked" logged "title=The site"

code=0
DEPLOY_HOST="" workflow "{\"inputs\":{\"action\":\"plan\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "no VPS_HOST: stops before anything" 1 "${code}"
check "  names the secret that is missing" logged "VPS_HOST is not set"
code=0
DEPLOY_SSH_KEY="" workflow "{\"inputs\":{\"action\":\"plan\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "neither a password nor a key: stops" 1 "${code}"
check "  names both secrets" logged "Neither the secret VPS_PASSWORD nor VPS_SSH_KEY"
code=0
workflow "{\"inputs\":{\"action\":\"rm -rf\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "an action that is none: stops" 1 "${code}"
code=0
SECRET_HOST_KEY="${OTHER_HOST_KEY}" workflow "{\"inputs\":{\"action\":\"plan\"},\"repository\":{\"private\":false}}" || code=$?
expect_exit "a node that shows another host key: 91" 91 "${code}"
check "  the error says that the node was not reached" logged "::error title=plan::was not started"

# ── With a password, as the workflow signs in ────────────────────────────────

if [ -n "${TEST_USER}" ]; then
  begin "Signing in with a password (as root only)"
  home="$(getent passwd "${TEST_USER}" | cut -d : -f 6)"
  code=0
  DEPLOY_USER="${TEST_USER}" DEPLOY_SSH_KEY="" DEPLOY_PASSWORD="${PASSWORD}" DEPLOY_REMOTE_DIR="" remote plan || code=$?
  expect_exit "a password with spaces, quotes and a \$ signs in" 0 "${code}"
  check "  the script ran as that user" said "who=${TEST_USER}"
  check "  the logs are in that user's home" test -d "${home}/xiero-nexus-remote/logs"
  code=0
  DEPLOY_USER="${TEST_USER}" DEPLOY_SSH_KEY="" DEPLOY_PASSWORD="${PASSWORD}"$'\n' DEPLOY_REMOTE_DIR="" remote plan || code=$?
  expect_exit "a line end after the password, as a pasted secret has, does no harm" 0 "${code}"
  code=0
  DEPLOY_USER="${TEST_USER}" DEPLOY_SSH_KEY="" DEPLOY_PASSWORD="not the password" DEPLOY_REMOTE_DIR="" remote plan || code=$?
  expect_exit "a wrong password: stops (91)" 91 "${code}"
  check "  says that the node refused it" told "refused"
  check_not "  nothing ran" said "ran="
  code=0
  DEPLOY_USER="${TEST_USER}" DEPLOY_SSH_KEY="" DEPLOY_PASSWORD="${PASSWORD}" DEPLOY_REMOTE_DIR="" DEPLOY_SUDO=auto remote plan || code=$?
  expect_exit "a user who is not root and has no sudo: stops (93)" 93 "${code}"
  check "  says what to do" said "may not use sudo without a password"
  check_not "  the script did not run" said "ran="
  check_not "the password is in no file on the node" grep -rqF -- "${PASSWORD}" "${home}"
  check_not "  nor in what the SSH server wrote down" grep -qF -- "${PASSWORD}" "${WORK}/sshd.log"
  check_not "  nor in what over-ssh.sh said" grep -qF -- "${PASSWORD}" "${ERR}"
  code=0
  DEPLOY_SUDO=auto remote plan || code=$?
  expect_exit "root signs in with a key and needs no sudo" 0 "${code}"
  check "  the script ran as root" said "who=root"
  if command -v sudo > /dev/null 2>&1 && [ -d /etc/sudoers.d ]; then
    SUDOERS="/etc/sudoers.d/${TEST_USER}"
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${TEST_USER}" > "${SUDOERS}"
    chmod 440 "${SUDOERS}"
    code=0
    DEPLOY_USER="${TEST_USER}" DEPLOY_SSH_KEY="" DEPLOY_PASSWORD="${PASSWORD}" DEPLOY_REMOTE_DIR="" DEPLOY_SUDO=auto \
      DEPLOY_ENV="MY_SETTING=through sudo" remote upgrade -- --set "NOTE=a b" || code=$?
    expect_exit "a user with sudo without a password: the script runs" 0 "${code}"
    check "  as root" said "who=root"
    check "  with its options" args_are --yes --set "NOTE=a b"
    check "  and its settings" said "MY_SETTING=[through sudo]"
    check "  the log stays that user's, to be read without sudo" test "$(stat -c %U "$(find "${home}/xiero-nexus-remote/logs" -name '*-upgrade.log' | sort | tail -n 1)")" = "${TEST_USER}"
    rm -f "${SUDOERS}"
    SUDOERS=""
  fi
fi

printf '\n%s passed, %s failed\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  exit 1
fi
