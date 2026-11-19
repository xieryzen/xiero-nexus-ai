#!/usr/bin/env bash
# Run one of the host scripts on a Pterodactyl node from another machine, over
# SSH: from a laptop, or from the workflow in .github/workflows/deploy.yml.
#
#   DEPLOY_HOST=node.example.com DEPLOY_PASSWORD=... bash scripts/host/over-ssh.sh plan
#
# Actions:
#
#   check         sign in and say what is on the node (node-check.sh). Changes nothing.
#   plan          what an upgrade would do (pterodactyl-upgrade.sh --dry-run). Changes nothing.
#   upgrade       the upgrade (pterodactyl-upgrade.sh --yes).
#   install-plan  what a first installation would do (pterodactyl-install.sh --dry-run).
#                 Changes nothing.
#   install       the first installation on a server that has no bundle yet
#                 (pterodactyl-install.sh --yes).
#   disk-report   what takes the space (disk-report.sh). Changes nothing.
#   site-plan     what giving the app its public address would do
#                 (nginx-site.sh --dry-run). Changes nothing.
#   site          the public address: a site in the node's nginx with a
#                 certificate from Let's Encrypt (nginx-site.sh --yes).
#   workforce-plan  what the app has (models, agents, teams, workflows) and
#                 what workforce.json asks for that is not there yet
#                 (workforce.sh --dry-run). Changes nothing.
#   workforce     adds that to the app, signed in as its administrator
#                 (workforce.sh --yes).
#   browser-plan  what setting up the browser agents work in would do
#                 (browser-service.sh --dry-run). Changes nothing.
#   browser       the browser service next to the server: a Chromium in a
#                 container of its own on the server's network, and
#                 BROWSER_URL in the server's .env (browser-service.sh --yes).
#                 With "-- --remove" it is taken away again.
#   last-log      what the last run on the node said and how it ended. With
#                 "-- --list": the runs that are kept, and how each ended.
#                 With "-- --back 1": the run before the last (2: the one
#                 before that), for when another run came in between.
#   input-key     the public key of this node, for what is sealed for it: a
#                 password or a skill that has to pass through a place others
#                 can read. The key pair is made at the first call and stays
#                 on the node (~/xiero-nexus-remote/input-key). Seal with
#                 `sealed-output.sh seal-line <that line> < file`, and give
#                 the line to workforce.sh (--account-password-sealed,
#                 --skill-sealed).
#
# Anything after "--" is given to the host script as it is:
#
#   bash scripts/host/over-ssh.sh upgrade -- --with-media --stop-timeout 120
#
# The script does not run as a child of the connection. When the connection is
# lost in the middle, an upgrade still finishes on the node (or goes back by
# itself), and `last-log` shows how it ended. What each run said is kept on
# the node in ~/xiero-nexus-remote/logs, readable by that user only; the
# newest 20 are kept.
#
# Settings, all from the environment so that no password is on a command line:
#
#   DEPLOY_HOST       The node: a host name or an address. Needed.
#   DEPLOY_PORT       Its SSH port (22).
#   DEPLOY_USER       Who to sign in as (root). Anyone else needs sudo without
#                     a password.
#   DEPLOY_PASSWORD   That user's password, or
#   DEPLOY_SSH_KEY    a private key: the key itself, not the name of a file.
#                     With neither, ssh uses the keys of whoever runs this.
#   DEPLOY_HOST_KEY   The node's host key, as `ssh-keyscan` prints it or
#                     without the host name ("ssh-ed25519 AAAA..."), so that
#                     nobody else can answer in its place. Without it the key
#                     the node shows is accepted, and shown in the output.
#   DEPLOY_SERVER     The Pterodactyl server: its UUID or the first 8
#                     characters (--server).
#   DEPLOY_APP_URL    The public address of the site (--app-url).
#   DEPLOY_VERSION    The version to install (latest).
#   DEPLOY_OUTPUT     A file for what the node said, instead of printing it.
#                     Progress and errors of this script are still printed;
#                     they name neither the node nor the server.
#   DEPLOY_ENV        Lines of KEY=VALUE that the host script gets as its
#                     environment, for example WINGS_TOKEN=...
#
# It ends with the exit code of the host script. Its own: 90 a setting is
# wrong, 91 it could not connect or sign in, 92 the connection was lost while
# the script was running, 93 the user on the node may not run it.
set -euo pipefail
umask 077

here="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="${DEPLOY_SCRIPTS:-${here}}"
# What goes to the node with every run: the host scripts, and what
# workforce.sh works with. The skills workforce.json names are folders next
# to it.
SENT=(pterodactyl-upgrade.sh pterodactyl-install.sh disk-report.sh node-check.sh nginx-site.sh
  workforce.sh workforce.py workforce.json)
if [ -d "${SCRIPTS}/skills" ]; then SENT+=(skills); fi
# The browser service: the script that sets it up, and what its image is built from.
if [ -f "${SCRIPTS}/browser-service.sh" ] && [ -d "${SCRIPTS}/browser" ]; then SENT+=(browser-service.sh browser); fi
# What opens a password or a skill that was sealed for the node.
if [ -f "${SCRIPTS}/sealed-output.sh" ]; then SENT+=(sealed-output.sh); fi
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"
SUDO_MODE="${DEPLOY_SUDO:-auto}"
KEEP_LOGS=20

say() { printf '%s\n' "$*" >&2; }
die() { # CODE MESSAGE
  local code="$1"
  shift
  printf 'error: %s\n' "$*" >&2
  exit "${code}"
}
usage() { sed -n '2,70p' "$0" | sed 's/^# \{0,1\}//'; }
trimmed() { # the value without spaces and line ends around it
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

# ── What to do ───────────────────────────────────────────────────────────────

ACTION="${1:-}"
[ "$#" -gt 0 ] && shift
EXTRA=()
if [ "${1:-}" = "--" ]; then
  shift
  EXTRA=("$@")
elif [ "$#" -gt 0 ]; then
  die 90 "options for the host script come after \"--\" (got \"$1\")."
fi

case "${ACTION}" in
  check) REMOTE_SCRIPT="node-check.sh" ;;
  plan | upgrade) REMOTE_SCRIPT="pterodactyl-upgrade.sh" ;;
  install-plan | install) REMOTE_SCRIPT="pterodactyl-install.sh" ;;
  disk-report) REMOTE_SCRIPT="disk-report.sh" ;;
  site-plan | site) REMOTE_SCRIPT="nginx-site.sh" ;;
  workforce-plan | workforce) REMOTE_SCRIPT="workforce.sh" ;;
  browser-plan | browser) REMOTE_SCRIPT="browser-service.sh" ;;
  last-log | input-key) REMOTE_SCRIPT="" ;;
  "" | -h | --help | help)
    usage
    exit 0
    ;;
  *) die 90 "\"${ACTION}\" is not an action. There are: check, plan, upgrade, install-plan, install, disk-report, site-plan, site, workforce-plan, workforce, browser-plan, browser, last-log, input-key." ;;
esac

SERVER="$(trimmed "${DEPLOY_SERVER:-}")"
APP_URL="$(trimmed "${DEPLOY_APP_URL:-}")"
VERSION="$(trimmed "${DEPLOY_VERSION:-}")"
VERSION="${VERSION#v}"

ARGS=()
case "${ACTION}" in
  check)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    [ -z "${APP_URL}" ] || ARGS+=(--site "${APP_URL}")
    ;;
  plan | upgrade)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    [ -z "${APP_URL}" ] || ARGS+=(--app-url "${APP_URL}")
    if [ -n "${VERSION}" ] && [ "${VERSION}" != "latest" ]; then ARGS+=(--version "${VERSION}"); fi
    if [ "${ACTION}" = "plan" ]; then ARGS+=(--dry-run); else ARGS+=(--yes); fi
    ;;
  install-plan | install)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    [ -z "${APP_URL}" ] || ARGS+=(--app-url "${APP_URL}")
    if [ -n "${VERSION}" ] && [ "${VERSION}" != "latest" ]; then ARGS+=(--version "${VERSION}"); fi
    if [ "${ACTION}" = "install-plan" ]; then ARGS+=(--dry-run); else ARGS+=(--yes); fi
    ;;
  site-plan | site)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    [ -z "${APP_URL}" ] || ARGS+=(--site "${APP_URL}")
    if [ "${ACTION}" = "site-plan" ]; then ARGS+=(--dry-run); else ARGS+=(--yes); fi
    ;;
  workforce-plan | workforce)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    if [ "${ACTION}" = "workforce-plan" ]; then ARGS+=(--dry-run); else ARGS+=(--yes); fi
    ;;
  browser-plan | browser)
    [ -z "${SERVER}" ] || ARGS+=(--server "${SERVER}")
    # The version of the app that is put in place while the server is restarted: without one, the installed one again.
    if [ -n "${VERSION}" ] && [ "${VERSION}" != "latest" ]; then ARGS+=(--version "${VERSION}"); fi
    if [ "${ACTION}" = "browser-plan" ]; then ARGS+=(--dry-run); else ARGS+=(--yes); fi
    ;;
esac
ARGS+=(${EXTRA[@]+"${EXTRA[@]}"})

ENV_LINES=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -n "$(trimmed "${line}")" ] || continue
  [[ "${line}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die 90 "DEPLOY_ENV takes lines of KEY=VALUE; one of them is not."
  ENV_LINES+=("${line}")
done <<< "${DEPLOY_ENV:-}"

# ── The node and how to sign in ──────────────────────────────────────────────

HOST="$(trimmed "${DEPLOY_HOST:-}")"
PORT="$(trimmed "${DEPLOY_PORT:-}")"
USER_NAME="$(trimmed "${DEPLOY_USER:-}")"
[ -n "${HOST}" ] || die 90 "DEPLOY_HOST is not set: the host name or address of the node."

# Forgiving about what people paste: ssh://, a user in front, a port behind.
HOST="${HOST#ssh://}"
case "${HOST}" in
  *@*)
    [ -n "${USER_NAME}" ] || USER_NAME="${HOST%%@*}"
    HOST="${HOST#*@}"
    ;;
esac
HOST="${HOST%/}"
if [[ "${HOST}" =~ ^\[(.+)\]:([0-9]+)$ ]]; then
  [ -n "${PORT}" ] || PORT="${BASH_REMATCH[2]}"
  HOST="${BASH_REMATCH[1]}"
elif [[ "${HOST}" =~ ^([^:]+):([0-9]+)$ ]]; then
  [ -n "${PORT}" ] || PORT="${BASH_REMATCH[2]}"
  HOST="${BASH_REMATCH[1]}"
fi
PORT="${PORT:-22}"
USER_NAME="${USER_NAME:-root}"
# Nothing here may be read by ssh as an option.
[[ "${HOST}" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die 90 "DEPLOY_HOST is not a host name or an address."
[[ "${PORT}" =~ ^[0-9]{1,5}$ ]] || die 90 "DEPLOY_PORT is not a port number."
[[ "${USER_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die 90 "DEPLOY_USER is not a user name."
case "${SUDO_MODE}" in auto | no) ;; *) die 90 "DEPLOY_SUDO is \"auto\" or \"no\"." ;; esac

for tool in ssh base64 tar; do
  command -v "${tool}" > /dev/null 2>&1 || die 90 "this needs \"${tool}\", which is not installed here."
done
if [ -n "${REMOTE_SCRIPT}" ]; then
  [ -f "${SCRIPTS}/${REMOTE_SCRIPT}" ] || die 90 "${SCRIPTS}/${REMOTE_SCRIPT} is missing."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# The password must not go into a known_hosts line or a log by a line end.
PASSWORD="${DEPLOY_PASSWORD:-}"
PASSWORD="${PASSWORD%$'\n'}"
PASSWORD="${PASSWORD%$'\r'}"
KEY="${DEPLOY_SSH_KEY:-}"

SSH=(ssh -F /dev/null -T -p "${PORT}" -l "${USER_NAME}"
  -o "UserKnownHostsFile=${TMP}/known_hosts" -o GlobalKnownHostsFile=/dev/null
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8
  -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o LogLevel=ERROR)

if [ -n "$(trimmed "${KEY}")" ]; then
  printf '%s\n' "${KEY//$'\r'/}" > "${TMP}/key"
  SSH+=(-i "${TMP}/key" -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o BatchMode=yes)
  SIGN_IN="a key"
elif [ -n "${PASSWORD}" ]; then
  # ssh takes a password from a helper program only; SSH_ASKPASS_REQUIRE makes
  # it ask the helper even where there is a terminal (OpenSSH 8.4 and newer).
  version="$(ssh -V 2>&1 | sed -n 's/^OpenSSH_\([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
  read -r major minor <<< "${version:-0 0}"
  if [ "${major:-0}" -lt 8 ] || { [ "${major}" -eq 8 ] && [ "${minor:-0}" -lt 4 ]; }; then
    die 90 "signing in with a password needs OpenSSH 8.4 or newer here ($(ssh -V 2>&1)). Use a key (DEPLOY_SSH_KEY) instead."
  fi
  printf '#!/bin/sh\nprintf '\''%%s\\n'\'' "${OVER_SSH_PASSWORD}"\n' > "${TMP}/askpass"
  chmod 700 "${TMP}/askpass"
  export OVER_SSH_PASSWORD="${PASSWORD}"
  export SSH_ASKPASS="${TMP}/askpass" SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-none}"
  SSH+=(-o "PreferredAuthentications=password,keyboard-interactive" -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1)
  SIGN_IN="a password"
else
  SSH+=(-o BatchMode=yes)
  SIGN_IN="the keys of $(id -un)"
fi

# ── Whose key the node may show ──────────────────────────────────────────────

if [ "${PORT}" = "22" ]; then KNOWN_AS="${HOST}"; else KNOWN_AS="[${HOST}]:${PORT}"; fi
HOST_KEY_NOTE=""
if [ -n "$(trimmed "${DEPLOY_HOST_KEY:-}")" ]; then
  while IFS= read -r line; do
    line="$(trimmed "${line%$'\r'}")"
    case "${line}" in "" | \#*) continue ;; esac
    # "ssh-ed25519 AAAA..." or a whole known_hosts line "host ssh-ed25519 AAAA...".
    read -r first second third _ <<< "${line}"
    case "${first}" in
      ssh-* | ecdsa-* | sk-*) printf '%s %s %s\n' "${KNOWN_AS}" "${first}" "${second}" ;;
      *) [ -n "${third}" ] && printf '%s %s %s\n' "${KNOWN_AS}" "${second}" "${third}" ;;
    esac
  done <<< "${DEPLOY_HOST_KEY}" > "${TMP}/known_hosts"
  [ -s "${TMP}/known_hosts" ] || die 90 "DEPLOY_HOST_KEY is not a host key. It looks like \"ssh-ed25519 AAAA...\"."
else
  command -v ssh-keyscan > /dev/null 2>&1 || die 90 "this needs \"ssh-keyscan\" to learn the node's host key, or DEPLOY_HOST_KEY."
  say "Asking the node for its host key..."
  ssh-keyscan -T 20 -p "${PORT}" "${HOST}" 2> /dev/null | grep -v '^#' > "${TMP}/known_hosts" || true
  [ -s "${TMP}/known_hosts" ] || die 91 "the node does not answer on its SSH port. Check DEPLOY_HOST and DEPLOY_PORT, and that the node lets this machine in."
  say "warning: the node's host key was not checked against a known one. The output shows it; set DEPLOY_HOST_KEY to it."
  # Preferring the short kind; any of them pins the node.
  shown="$(grep -m 1 ' ssh-ed25519 ' "${TMP}/known_hosts" || head -n 1 "${TMP}/known_hosts")"
  HOST_KEY_NOTE="Host key of the node (accepted as it was shown, not checked): ${shown#* }"
  if command -v ssh-keygen > /dev/null 2>&1; then
    HOST_KEY_NOTE="${HOST_KEY_NOTE}"$'\n'"Its fingerprint: $(printf '%s\n' "${shown}" | ssh-keygen -lf - 2> /dev/null | awk '{ print $2 }')"
    HOST_KEY_NOTE="${HOST_KEY_NOTE}"$'\n'"Compare on the node:  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
  fi
fi

# ── What runs on the node ────────────────────────────────────────────────────

# Words for the shell on the node, each quoted. No words give nothing: printf
# alone would still print '' for a list that is empty.
quoted() {
  local word
  for word in "$@"; do printf ' %q' "${word}"; done
}

# A line nothing on the node can write by accident tells where its output ends.
MARK="over-ssh-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

{
  printf 'set -uo pipefail\numask 077\n'
  printf 'mark=%q\naction=%q\nscript=%q\nremote_dir=%q\nsudo_mode=%q\nkeep=%q\n' \
    "${MARK}" "${ACTION}" "${REMOTE_SCRIPT}" "${REMOTE_DIR}" "${SUDO_MODE}" "${KEEP_LOGS}"
  printf 'args=(%s )\n' "$(quoted ${ARGS[@]+"${ARGS[@]}"})"
  printf 'env_lines=(%s )\n' "$(quoted ${ENV_LINES[@]+"${ENV_LINES[@]}"})"
  cat << 'REMOTE'
ended() { # CODE: the last line this prints
  printf '\n%s ended %s\n' "${mark}" "$1"
  exit "$1"
}
dir="${remote_dir:-${HOME}/xiero-nexus-remote}"
mkdir -p "${dir}/logs" && chmod 700 "${dir}" "${dir}/logs" || {
  echo "error: ${dir} cannot be made on the node."
  ended 93
}
state_of() { # LOG: how that run ended
  if [ -f "$1.code" ]; then echo "ended with code $(cat "$1.code")"; else echo "has not ended"; fi
}

if [ "${action}" = "last-log" ]; then
  # Which run: the last one, or one that many before it. --list names them.
  back=0
  list=no
  set -- ${args[@]+"${args[@]}"}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --list)
        list=yes
        shift
        ;;
      --back)
        back="${2:-}"
        case "${back}" in
          "" | *[!0-9]* | ????*)
            echo "error: --back needs a number: 1 for the run before the last, 2 for the one before that."
            ended 90
            ;;
        esac
        shift 2
        ;;
      *)
        echo "error: last-log takes --list and --back <n> (got \"$1\")."
        ended 90
        ;;
    esac
  done
  logs="$(find "${dir}/logs" -maxdepth 1 -name '*.log' | sort)"
  if [ -z "${logs}" ]; then
    echo "Nothing was run on this node yet."
    ended 1
  fi
  count="$(printf '%s\n' "${logs}" | wc -l)"
  if [ "${list}" = yes ]; then
    echo "The runs that are kept on this node, the last one first:"
    n=0
    printf '%s\n' "${logs}" | sort -r | while IFS= read -r one; do
      name="${one##*/}"
      if [ "${n}" -eq 0 ]; then which="the last"; else which="--back ${n}"; fi
      printf '  %-34s %-22s %s\n' "${name%.log}" "$(state_of "${one}")" "${which}"
      n=$((n + 1))
    done
    ended 0
  fi
  if [ "${back}" -ge "${count}" ]; then
    echo "There is no run that far back: ${count} are kept on this node (--list names them)."
    ended 1
  fi
  last="$(printf '%s\n' "${logs}" | tail -n "$((back + 1))" | head -n 1)"
  name="${last##*/}"
  if [ "${back}" -eq 0 ]; then
    echo "Last run: ${name%.log}, which $(state_of "${last}")."
  else
    echo "The run ${back} before the last: ${name%.log}, which $(state_of "${last}")."
  fi
  echo
  cat "${last}"
  if [ -s "${last}.err" ]; then
    echo
    echo "What it said besides:"
    tail -n 40 "${last}.err"
  fi
  ended 0
fi

# The key of this node for what is sealed for it. Its private half never
# leaves the node; the public half is no secret.
input_key="${dir}/input-key/key.pem"
if [ "${action}" = "input-key" ]; then
  command -v openssl > /dev/null 2>&1 || {
    echo "error: this needs openssl, which is not installed on the node."
    ended 1
  }
  if [ ! -s "${input_key}" ]; then
    mkdir -p "${dir}/input-key" && chmod 700 "${dir}/input-key"
    if ! openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${input_key}" 2> /dev/null; then
      rm -f "${input_key}"
      echo "error: the key could not be made on the node."
      ended 1
    fi
    chmod 600 "${input_key}"
    echo "A key for what is sealed for this node was made: ${input_key}"
  else
    echo "The key for what is sealed for this node: ${input_key}"
  fi
  echo "Its public half, to seal with (sealed-output.sh seal-line):"
  openssl pkey -in "${input_key}" -pubout 2> /dev/null | openssl base64 -A
  echo
  ended 0
fi

as_root=()
if [ "$(id -u)" -ne 0 ] && [ "${sudo_mode}" = "auto" ]; then
  if ! sudo -n true 2> /dev/null; then
    echo "error: signed in as $(id -un), who is not root and may not use sudo without a password."
    echo "Sign in as root, or give this user sudo without a password for the time of the upgrade."
    ended 93
  fi
  as_root=(sudo -n)
fi

# The host scripts, as they were sent with this. A folder left behind by a
# run whose connection was lost goes after a day.
find "${dir}" -maxdepth 1 -name 'run.*' -mmin +1440 -exec rm -rf {} + 2> /dev/null
run="$(mktemp -d "${dir}/run.XXXXXX")"
if ! base64 -d << 'PAYLOAD' | tar -xzf - -C "${run}"; then
REMOTE
  tar -czf - -C "${SCRIPTS}" "${SENT[@]}" | base64
  cat << 'REMOTE'
PAYLOAD
  echo "error: the scripts did not arrive whole on the node."
  rm -rf "${run}"
  ended 93
fi

log="${dir}/logs/$(date -u +%Y%m%d-%H%M%S)-${action}.log"
while [ -e "${log}" ]; do log="${log%.log}x.log"; done
: > "${log}"
# Runs the script with nothing to read, writes down how it ended and tidies
# up after itself. With "apart", what the script says besides its output (the
# progress of a disk report) is kept apart, so that the report is nothing but
# the report.
cat > "${run}/detached.sh" << 'DETACHED'
log="$1"
apart="$2"
shift 2
echo "$$" > "${log}.pid"
if [ "${apart}" = "yes" ]; then
  "$@" < /dev/null >> "${log}" 2>> "${log}.err"
else
  "$@" < /dev/null >> "${log}" 2>&1
fi
echo "$?" > "${log}.code"
rm -f "${log}.pid"
rm -rf "$(dirname "$0")"
DETACHED
if [ "${action}" = "disk-report" ]; then apart=yes; else apart=no; fi

# The host script is told where the node's key is, when the node has one.
if [ -s "${input_key}" ]; then env_lines+=("XIERO_INPUT_KEY=${input_key}"); fi
run_this=(${as_root[@]+"${as_root[@]}"} env ${env_lines[@]+"${env_lines[@]}"} bash "${run}/${script}" ${args[@]+"${args[@]}"})
# In a session of its own: the end of this connection does not end it.
if command -v setsid > /dev/null 2>&1; then
  setsid bash "${run}/detached.sh" "${log}" "${apart}" "${run_this[@]}" < /dev/null > /dev/null 2>&1 &
else
  nohup bash "${run}/detached.sh" "${log}" "${apart}" "${run_this[@]}" < /dev/null > /dev/null 2>&1 &
fi
name="${log##*/}"
printf '%s started %s\n' "${mark}" "${name%.log}"

# Pass on what it writes until it has ended.
sent=0
pass_on() {
  local size
  size="$(stat -c %s "${log}" 2> /dev/null || echo 0)"
  if [ "${size}" -gt "${sent}" ]; then
    tail -c "+$((sent + 1))" "${log}" | head -c "$((size - sent))"
    sent="${size}"
  fi
}
gone=0
while [ ! -e "${log}.code" ]; do
  pass_on
  sleep 1
  # Ended without writing down how: the machine went down, or it was killed.
  if [ -f "${log}.pid" ] && ! kill -0 "$(cat "${log}.pid" 2> /dev/null)" 2> /dev/null; then gone=$((gone + 1)); else gone=0; fi
  if [ "${gone}" -ge 5 ] && [ ! -e "${log}.code" ]; then
    pass_on
    echo
    echo "error: the script on the node ended without saying how. Its output up to there is above."
    ended 1
  fi
done
pass_on
code="$(cat "${log}.code")"
if [ "${code}" != "0" ] && [ -s "${log}.err" ]; then
  echo
  echo "What it said besides:"
  tail -n 40 "${log}.err"
fi

# Old logs go; the newest stay.
find "${dir}/logs" -maxdepth 1 -name '*.log' | sort | head -n "-${keep}" | while IFS= read -r old; do
  rm -f "${old}" "${old}.code" "${old}.err" "${old}.pid"
done
ended "${code}"
REMOTE
} > "${TMP}/remote.sh"

# ── Go ───────────────────────────────────────────────────────────────────────

OUTPUT="${DEPLOY_OUTPUT:-}"
if [ -n "${OUTPUT}" ]; then : > "${OUTPUT}"; fi
out() { # what the node said: to the file, or printed
  if [ -n "${OUTPUT}" ]; then cat >> "${OUTPUT}"; else cat; fi
}
if [ -n "${HOST_KEY_NOTE}" ]; then printf '%s\n' "${HOST_KEY_NOTE}" | out; fi

say "Connecting to the node, signing in with ${SIGN_IN}..."
started=$SECONDS
ssh_code=0
"${SSH[@]}" "${HOST}" 'exec bash -s' < "${TMP}/remote.sh" 2> "${TMP}/ssh.err" \
  | {
    # The marker lines are for this script; everything else is the output.
    while IFS= read -r line || [ -n "${line}" ]; do
      case "${line}" in
        "${MARK} started "*)
          echo "${line#"${MARK} started "}" > "${TMP}/started"
          say "Signed in. Running \"${ACTION}\" on the node..."
          ;;
        "${MARK} ended "*) echo "${line#"${MARK} ended "}" > "${TMP}/ended" ;;
        *) printf '%s\n' "${line}" ;;
      esac
    done
  } | out || ssh_code=$?
took=$((SECONDS - started))

# What ssh itself said, without the name of the node.
ssh_said="$(tr -d '\r' < "${TMP}/ssh.err" | grep -v '^[[:space:]]*$' | tail -n 5 || true)"
ssh_said="${ssh_said//"${HOST}"/the node}"

if [ -f "${TMP}/ended" ]; then
  code="$(cat "${TMP}/ended")"
  [[ "${code}" =~ ^[0-9]+$ ]] || code=1
  case "${code}" in
    0) say "\"${ACTION}\" ended well, after ${took} seconds." ;;
    93) say "error: \"${ACTION}\" was not started: ${USER_NAME} is not root on the node and may not use sudo without a password, or cannot write in its home there." ;;
    *) say "\"${ACTION}\" ended with code ${code}, after ${took} seconds." ;;
  esac
  exit "${code}"
fi

if [ -f "${TMP}/started" ]; then
  say "error: the connection to the node was lost after ${took} seconds, while \"${ACTION}\" was running."
  say "It goes on there by itself. Run the action \"last-log\" to see how it ended."
  [ -z "${ssh_said}" ] || say "ssh said: ${ssh_said}"
  exit 92
fi

say "error: could not connect to the node or sign in (ssh ended with code ${ssh_code})."
case "${ssh_said}" in
  *"Host key verification failed"* | *"REMOTE HOST IDENTIFICATION"*)
    say "The node showed another host key than DEPLOY_HOST_KEY. If the node was set up again, replace the key; if not, someone else answered in its place."
    ;;
  *"Permission denied"*)
    say "ssh said: ${ssh_said}"
    say "The node refused ${SIGN_IN} for this user. Check the user and the password or key; a node can also be set to refuse passwords for root (PermitRootLogin, PasswordAuthentication in its sshd_config)."
    ;;
  "") ;;
  *) say "ssh said: ${ssh_said}" ;;
esac
exit 91
