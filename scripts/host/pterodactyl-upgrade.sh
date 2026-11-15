#!/usr/bin/env bash
# Upgrade Xiero Nexus AI on a Pterodactyl server, from the machine that runs
# Wings, as root:
#
#   sudo bash pterodactyl-upgrade.sh --server <server id>
#
# What it does, in this order:
#
#   1. finds the server's files and the release bundle installed there,
#   2. downloads the new bundle for the same Node.js version and checks it
#      against the release's SHA-256 list,
#   3. shows what it is going to do and asks,
#   4. stops the server (through Wings, as the panel does); a server that has
#      not stopped by itself after a minute has its process ended,
#   5. copies the database, .env and the old program files to a backup folder
#      outside the server's files,
#   6. puts the new program files in place; .env, data/ and anything else that
#      is not part of a bundle are left alone,
#   7. starts the server and waits until it answers,
#   8. if it does not, puts the old version and the database back and starts
#      that again.
#
# It touches one server's files and nothing else on the machine. Run it with
# --dry-run first to see the plan without changing anything.
#
# Options: --help.
set -euo pipefail
umask 022

REPO="${XIERO_REPO:-xieryzen/xiero-nexus-ai}"
RELEASES_URL="${XIERO_RELEASES_URL:-https://github.com/${REPO}/releases}"
CONTAINER_HOME="/home/container"
# Everything a bundle of any version has put in its folder. Other names in
# that folder belong to whoever runs the server and are never touched.
KNOWN_BUNDLE_NAMES=".next node_modules drizzle public assets server.js start.js get-release.mjs VERSION README.md CHANGELOG.md RELEASING.md .env.example package.json"
PROTECTED_NAMES=".env data"

SERVER=""
VERSION="latest"
ZIP=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
BACKUP_ROOT="/root/xiero-nexus-backups"
APP_DIR_OPTION=""
POWER="wings"
WITH_MEDIA=false
STOP_TIMEOUT=60
HEALTH_TIMEOUT=120
CHECK_URL=""
RESTORE=""
FFMPEG_FILE=""
DRY_RUN=false
YES=false
FORCE=false
ALLOW_DOWNGRADE=false
LEAVE_STOPPED=false
ROLLBACK=true
START_ONLY=false
SETTINGS=()

usage() {
  cat << 'EOF'
Upgrade Xiero Nexus AI on a Pterodactyl server. Run as root on the machine that runs Wings.

  sudo bash pterodactyl-upgrade.sh --server <server id> [options]

  --server <id>        The server: its UUID, or the first 8 characters of it (the
                       short ID in the panel address). Not needed when only one
                       server on this machine has the app.
  --version <v>        What to install: "latest" (default) or a version such as 1.5.0.
  --zip <file>         Install this bundle instead of downloading one.
  --set KEY=VALUE      Set a line in the server's .env (can be repeated).
  --app-url <url>      The same as --set APP_URL=<url>: the public address of the site.
  --ffmpeg <file>      Copy this ffmpeg program into the server's files and point
                       FFMPEG_PATH at it, for a server image that has no ffmpeg.
  --with-media         Also copy the generated images and videos to the backup.
                       An upgrade does not change them; this can take long, and
                       the server is stopped meanwhile.
  --backup-dir <dir>   Where backups are kept (default /root/xiero-nexus-backups).
  --restore <folder>   Instead of upgrading, put back the program files and the
                       database of that backup folder.
  --start              Instead of upgrading, start the server and wait until
                       the app answers; show its console when it does not.
  --dry-run            Show the plan and stop.
  --yes                Do not ask before starting.

  --power wings|manual How the server is stopped and started. "wings" (default)
                       asks Wings on this machine, the way the panel does.
                       "manual": you stop the server in the panel before running
                       this, and start it afterwards.
  --leave-stopped      Do not start the server afterwards.
  --no-rollback        Do not go back to the old version when the new one does
                       not answer.
  --force              Install even when that version is already installed.
  --allow-downgrade    Install an older version than the installed one. Its
                       database may be too new for it: only with --restore in mind.
  --check-url <url>    Where the app answers on this machine, when that cannot be
                       found out (for example http://127.0.0.1:25565).
  --app-dir <dir>      The folder of the installed bundle, when it is not found.
  --volumes <dir>      Where Wings keeps server files (default: from the Wings
                       configuration, else /var/lib/pterodactyl/volumes).
  --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
  --stop-timeout <s>   Seconds the server gets to stop by itself before its process
                       is ended (default 60). Wings does the same to a server
                       that has not stopped after 10 minutes.
  --health-timeout <s> Seconds to wait for the new version to answer (default 120).

Environment:
  WINGS_TOKEN          The node's token, for a Wings configuration that does not
                       hold the token itself but names a variable of the Wings
                       service. Not needed otherwise.
  XIERO_REPO           The GitHub repository whose releases are downloaded
                       (default xieryzen/xiero-nexus-ai).
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$@"; SERVER="$2"; shift 2 ;;
    --version) need_value "$@"; VERSION="${2#v}"; shift 2 ;;
    --zip) need_value "$@"; ZIP="$2"; shift 2 ;;
    --set) need_value "$@"; SETTINGS+=("$2"); shift 2 ;;
    --app-url) need_value "$@"; SETTINGS+=("APP_URL=$2"); shift 2 ;;
    --ffmpeg) need_value "$@"; FFMPEG_FILE="$2"; shift 2 ;;
    --with-media) WITH_MEDIA=true; shift ;;
    --backup-dir) need_value "$@"; BACKUP_ROOT="$2"; shift 2 ;;
    --restore) need_value "$@"; RESTORE="$2"; shift 2 ;;
    --start) START_ONLY=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) YES=true; shift ;;
    --power) need_value "$@"; POWER="$2"; shift 2 ;;
    --leave-stopped) LEAVE_STOPPED=true; shift ;;
    --no-rollback) ROLLBACK=false; shift ;;
    --force) FORCE=true; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=true; shift ;;
    --check-url) need_value "$@"; CHECK_URL="${2%/}"; shift 2 ;;
    --app-dir) need_value "$@"; APP_DIR_OPTION="$2"; shift 2 ;;
    --volumes) need_value "$@"; VOLUMES="$2"; shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; shift 2 ;;
    --stop-timeout) need_value "$@"; STOP_TIMEOUT="$2"; shift 2 ;;
    --health-timeout) need_value "$@"; HEALTH_TIMEOUT="$2"; shift 2 ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option: $1. See --help." ;;
  esac
done

case "${POWER}" in wings | manual) ;; *) die "--power is \"wings\" or \"manual\"." ;; esac
case "${CHECK_URL}" in "" | http://* | https://*) ;; *) die "--check-url is an address such as http://127.0.0.1:25565." ;; esac
case "${STOP_TIMEOUT}${HEALTH_TIMEOUT}" in *[!0-9]*) die "--stop-timeout and --health-timeout are whole seconds." ;; esac
if [ -n "${RESTORE}" ] && { [ -n "${ZIP}" ] || [ "${VERSION}" != "latest" ]; }; then
  die "--restore puts a backup back; it cannot be combined with --zip or --version."
fi
if [ "${START_ONLY}" = true ]; then
  if [ -n "${RESTORE}" ] || [ -n "${ZIP}" ] || [ "${VERSION}" != "latest" ]; then
    die "--start only starts the server; it cannot be combined with --restore, --zip or --version."
  fi
  [ "${POWER}" = "wings" ] || die "--start asks Wings to start the server; with --power manual there is nothing for it to do."
fi

for setting in ${SETTINGS[@]+"${SETTINGS[@]}"}; do
  key="${setting%%=*}"
  value="${setting#*=}"
  case "${setting}" in *=*) ;; *) die "--set needs KEY=VALUE, not \"${setting}\"." ;; esac
  [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "--set: \"${key}\" is not a setting name (capital letters, digits and _)."
  case "${value}" in *$'\n'* | *\"* | *\'* | *\\*) die "--set ${key}: quotes, backslashes and line breaks are not supported." ;; esac
  if [ "${key}" = "SECRET_ENCRYPTION_KEY" ]; then
    die "SECRET_ENCRYPTION_KEY cannot be changed here: stored provider keys and 2FA secrets could not be read any more."
  fi
done

# ── Tools ────────────────────────────────────────────────────────────────────

for tool in curl awk sed find stat df du cp mv rm mkdir chown date flock sha256sum realpath mktemp; do
  command -v "${tool}" > /dev/null 2>&1 || die "this script needs \"${tool}\", which is not installed."
done

unpack() { # ZIP FOLDER
  if command -v unzip > /dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  elif command -v bsdtar > /dev/null 2>&1; then
    bsdtar -xf "$1" -C "$2"
  elif command -v python3 > /dev/null 2>&1; then
    python3 -m zipfile -e "$1" "$2"
  else
    die "nothing here can open a zip file. Install unzip (apt-get install -y unzip, or dnf install -y unzip) and run this again."
  fi
}

WORK="$(mktemp -d)"
PHASE="start"
STAGING=""
STOPPED_BY_US=false
BACKUP=""

# ── Small helpers ────────────────────────────────────────────────────────────

# The value of a key in a VERSION file ("key=value" lines).
version_field() { sed -n "s/^$1=//p" "$2" 2> /dev/null | head -n 1 | tr -d '\r'; }

# The value of a setting in an env file: the last line that sets it; empty when
# it is not set or only in a comment.
env_get() {
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*(.*)$/\2/p" "$2" 2> /dev/null \
    | tail -n 1 | tr -d '\r' \
    | sed -E 's/^"([^"]*)".*$/\1/; t; s/^'"'"'([^'"'"']*)'"'"'.*$/\1/; t; s/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

# Set KEY=VALUE in an env file: replaces the line that sets it now, or adds one.
# The file keeps its owner and permissions.
env_set() {
  local file="$1" key="$2" value="$3" line tmp
  case "${value}" in *[[:space:]#]*) line="${key}=\"${value}\"" ;; *) line="${key}=${value}" ;; esac
  tmp="$(mktemp "${WORK}/env.XXXXXX")"
  LINE="${line}" awk -v key="${key}" '
    { lines[NR] = $0; if ($0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=") last = NR }
    END {
      for (i = 1; i <= NR; i++) print (i == last ? ENVIRON["LINE"] : lines[i])
      if (!last) print ENVIRON["LINE"]
    }' "${file}" > "${tmp}"
  cat "${tmp}" > "${file}"
  rm -f "${tmp}"
}

# A value from the Wings configuration: "token", "api.port", "api.ssl.enabled".
yaml_get() {
  awk -v want="$2" '
    function clean(v) {
      sub(/[[:space:]]+#.*$/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^["\047]|["\047]$/, "", v)
      return v
    }
    /^[[:space:]]*(#|$)/ { next }
    {
      indent = match($0, /[^ ]/) - 1
      level = int(indent / 2)
      line = substr($0, indent + 1)
      colon = index(line, ":")
      if (colon == 0) next
      path[level] = substr(line, 1, colon - 1)
      full = path[0]
      for (i = 1; i <= level; i++) full = full "." path[i]
      if (full == want) { print clean(substr(line, colon + 1)); exit }
    }' "$1" 2> /dev/null
}

human() { # kilobytes, readable
  awk -v kb="$1" 'BEGIN {
    if (kb >= 1048576) printf "%.1f GB", kb / 1048576
    else if (kb >= 1024) printf "%.0f MB", kb / 1024
    else printf "%d KB", kb
  }'
}
size_kb() { du -sk "$1" 2> /dev/null | awk '{ print $1 }'; }
free_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

# A folder that is really a folder: a link could lead anywhere on the machine,
# and the server's files can be written by whoever runs that server.
real_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
real_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
inside() { # PATH FOLDER: whether the path, with links followed, is inside the folder
  local path folder
  path="$(realpath -m "$1")" && folder="$(realpath -m "$2")" || return 1
  case "${path}" in "${folder}" | "${folder}"/*) return 0 ;; *) return 1 ;; esac
}
is_bundle() { real_file "$1/VERSION" && [ -f "$1/start.js" ] && [ -f "$1/server.js" ] && grep -q '^version=' "$1/VERSION"; }
names_in() { # the names in a folder, one a line, hidden ones too
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "${entry}" ] || [ -L "${entry}" ]; then printf '%s\n' "${entry##*/}"; fi
  done
}

confirm() { # QUESTION
  [ "${YES}" = true ] && return 0
  local answer=""
  if [ -t 0 ]; then
    read -r -p "$1 [y/N] " answer || true
  elif ! { read -r -p "$1 [y/N] " answer < /dev/tty; } 2> /dev/null; then
    die "there is no terminal to ask on. Add --yes to go ahead without asking."
  fi
  case "${answer}" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# ── Wings and Docker ─────────────────────────────────────────────────────────

WINGS_URL=""
NODE_TOKEN=""
WINGS_CODE=""
WINGS_INSECURE=()

# The token Wings answers to. Its configuration holds the token itself, or
# "file:///path/to/it", or the name of a variable of the Wings service; and
# WINGS_TOKEN in the environment goes before the configuration, as for Wings.
node_token() {
  local value="${WINGS_TOKEN:-}"
  [ -n "${value}" ] || value="$(yaml_get "${WINGS_CONFIG}" token || true)"
  case "${value}" in
    *'$'*) return 2 ;;
    file://*) value="$(cat "${value#file://}" 2> /dev/null)" || return 1 ;;
  esac
  value="${value%$'\r'}"
  [ -n "${value}" ] || return 1
  printf '%s' "${value}"
}

# Ask Wings. The answer is in ${WORK}/wings.body. The token is given to curl on
# its standard input, so it does not show in the process list.
wings_call() { # METHOD PATH [JSON]
  local method="$1" path="$2" body="${3-}"
  local args=(-sS -o "${WORK}/wings.body" -w '%{http_code}' --max-time 30 -X "${method}" -H 'Accept: application/json')
  if [ -n "${body}" ]; then args+=(-H 'Content-Type: application/json' --data "${body}"); fi
  WINGS_CODE="$(curl "${args[@]}" ${WINGS_INSECURE[@]+"${WINGS_INSECURE[@]}"} -K - "${WINGS_URL}${path}" 2> "${WORK}/wings.error" << EOF
header = "Authorization: Bearer ${NODE_TOKEN}"
EOF
  )" || WINGS_CODE="000"
  case "${WINGS_CODE}" in 2??) return 0 ;; *) return 1 ;; esac
}

wings_problem() {
  case "${WINGS_CODE}" in
    000) say "Wings did not answer at ${WINGS_URL} ($(tr -d '\n' < "${WORK}/wings.error" 2> /dev/null | cut -c1-200))." ;;
    401 | 403) say "Wings refused the token of ${WINGS_CONFIG}." ;;
    404) say "Wings does not know a server ${UUID}." ;;
    *) say "Wings answered with HTTP ${WINGS_CODE}." ;;
  esac
}

# offline | starting | running | stopping, or nothing when Wings cannot be asked.
wings_state() {
  wings_call GET "/api/servers/${UUID}" || return 1
  grep -o '"state":"[a-z]*"' "${WORK}/wings.body" | head -n 1 | cut -d '"' -f 4
}

DOCKER=""
have_docker() {
  if [ -z "${DOCKER}" ]; then
    if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then DOCKER="yes"; else DOCKER="no"; fi
  fi
  [ "${DOCKER}" = "yes" ]
}
# Wings names a server's container after the server.
container_running() { have_docker && [ "$(docker inspect -f '{{.State.Running}}' "${UUID}" 2> /dev/null || true)" = "true" ]; }
# Whether the server's container was started at or after a moment (seconds
# since 1970). Wings makes a new container for every start.
container_started_since() {
  local at
  have_docker || return 1
  at="$(docker inspect -f '{{.State.StartedAt}}' "${UUID}" 2> /dev/null || true)"
  [ -n "${at}" ] || return 1
  at="$(date -d "${at}" +%s 2> /dev/null || true)"
  [ -n "${at}" ] && [ "${at}" -ge "$1" ]
}

server_state() {
  if [ "${POWER}" = "wings" ]; then
    wings_state
  elif container_running; then
    echo running
  else
    echo offline
  fi
}

# The last lines the server wrote, for when it does not come up.
show_log() {
  say ""
  say "── The last lines of the server's console ──"
  if have_docker && docker inspect "${UUID}" > /dev/null 2>&1; then
    docker logs --tail 40 "${UUID}" 2>&1 | sed 's/^/  /' || true
  elif [ "${POWER}" = "wings" ] && wings_call GET "/api/servers/${UUID}/logs?size=40"; then
    if command -v python3 > /dev/null 2>&1; then
      python3 -c 'import json,sys; [print("  " + str(l).rstrip()) for l in json.load(open(sys.argv[1])).get("data", [])]' "${WORK}/wings.body" 2> /dev/null || true
    else
      sed -e 's/^{"data":\["//' -e 's/"\]}$//' -e 's/","/\n/g' "${WORK}/wings.body" | sed 's/^/  /'
    fi
  else
    say "  (not available from here; look at the console in the panel)"
  fi
  say "────"
}

# ok | starting | failing: whether the app answers at CHECK_URL.
probe() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${CHECK_URL}/api/health" 2> /dev/null)" || code="000"
  case "${code}" in
    200) echo ok ;;
    000) echo starting ;;
    404)
      # Versions before 1.5 have no health check: their sign-in page tells.
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${CHECK_URL}/login" 2> /dev/null)" || code="000"
      if [ "${code}" = "200" ]; then echo ok; else echo failing; fi
      ;;
    *) echo failing ;;
  esac
}

# Wings answers a power request at once and carries it out afterwards, one
# action at a time for a server. With wait_seconds the request waits its turn;
# without, Wings drops it when another action is still in progress, and nobody
# is told.
power() { # stop | start | kill
  wings_call POST "/api/servers/${UUID}/power" "{\"action\":\"$1\",\"wait_seconds\":30}" || {
    wings_problem
    return 1
  }
}

# Whether the server is down and stays down: three looks in a row, two seconds
# apart, with Wings saying "offline" and no container running. One look is not
# enough. Wings still says "offline" while it prepares a start, and it starts a
# server whose process ended by itself once more.
is_down() { [ "$(server_state || true)" = "offline" ] && ! container_running; }
wait_until_down() { # SECONDS
  local deadline=$((SECONDS + $1)) seen=0
  while :; do
    if is_down; then
      seen=$((seen + 1))
      if [ "${seen}" -ge 3 ]; then return 0; fi
    else
      seen=0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then return 1; fi
    sleep 2
  done
}

stop_server() {
  if [ "${POWER}" = "manual" ]; then
    if ! is_down; then die "the server is running. Stop it in the panel, then run this again. Nothing was changed."; fi
    say "The server is stopped."
    return 0
  fi
  if is_down; then
    say "The server is stopped."
  else
    say "Asking Wings to stop the server..."
    STOPPED_BY_US=true
  fi
  # Asked even when the server looks stopped: a start that Wings is preparing
  # right now is then stopped as well, instead of running into the new files.
  power stop || die "the server could not be stopped. Nothing was changed."
  if ! wait_until_down "${STOP_TIMEOUT}"; then
    # Wings goes on waiting for the server and ends its process after 10
    # minutes, whatever this script does. Leaving now would only mean that the
    # site goes down later, with nobody there to start it again.
    say "It did not stop by itself in ${STOP_TIMEOUT} seconds: ending its process."
    power kill || true
    wait_until_down 30 || die "the server could not be stopped. This script changed nothing, but Wings was asked to stop the server: look at it in the panel."
  fi
  if [ "${STOPPED_BY_US}" = true ]; then say "Stopped."; fi
}

# How long a server may look stopped after it was told to start, before that
# is taken to mean that the start did not happen. Wings first asks the panel
# for the server's settings and goes through its files, and says "offline"
# meanwhile.
START_GRACE=45

# Start the server and wait until the app answers. 0: it answers. 1: it does not.
# 2: it was started, but whether it answers cannot be told from here.
start_and_check() {
  if [ "${POWER}" = "manual" ]; then return 2; fi
  local asked_at asked deadline down=0 asks=1
  asked_at=$(($(date +%s) - 1))
  asked="${SECONDS}"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  say "Asking Wings to start the server..."
  power start || return 1
  STOPPED_BY_US=false
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if [ -n "${CHECK_URL}" ]; then
      if [ "$(probe)" = "ok" ]; then return 0; fi
    elif [ $((SECONDS - asked)) -ge 30 ] && [ "${down}" -eq 0 ]; then
      # Nothing to ask it; it has been up for half a minute.
      return 2
    fi
    if is_down; then down=$((down + 1)); else down=0; fi
    if [ "${down}" -ge 3 ]; then
      # Its process ran and ended, and Wings gave up on it: nothing to wait for.
      if container_started_since "${asked_at}"; then return 1; fi
      # It never started. Wings drops a request when it is busy with another
      # one for the same server (a restart asked for in the panel, say), and
      # nobody is told: ask once more.
      if [ $((SECONDS - asked)) -ge "${START_GRACE}" ]; then
        if [ "${asks}" -ge 2 ]; then return 1; fi
        say "The server has not started. Asking Wings once more..."
        power start || return 1
        asks=$((asks + 1))
        asked="${SECONDS}"
        down=0
      fi
    fi
    sleep 2
  done
  if [ -z "${CHECK_URL}" ] && ! is_down; then return 2; fi
  return 1
}

# ── Finding the server and its files ─────────────────────────────────────────

if [ "$(id -u)" != "0" ]; then
  warn "not running as root: this only works where you may write the server's files yourself."
fi

if [ -z "${VOLUMES}" ]; then
  VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
  [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
fi
[ -d "${VOLUMES}" ] || die "${VOLUMES} does not exist. Is this the machine that runs Wings? Name the folder of the server files with --volumes."
VOLUMES="$(realpath "${VOLUMES}")"

if [ -z "${SERVER}" ]; then
  candidates=()
  for folder in "${VOLUMES}"/*/; do
    folder="${folder%/}"
    if is_bundle "${folder}/xiero-nexus-ai" || is_bundle "${folder}"; then candidates+=("$(basename "${folder}")"); fi
  done
  case "${#candidates[@]}" in
    0) die "no server in ${VOLUMES} has a Xiero Nexus AI bundle in xiero-nexus-ai/. Name the server with --server." ;;
    1) SERVER="${candidates[0]}" ;;
    *)
      say "More than one server has the app. Name one with --server:"
      printf '  %s\n' "${candidates[@]}"
      exit 1
      ;;
  esac
fi

[[ "${SERVER}" =~ ^[0-9a-fA-F-]{8,36}$ ]] || die "\"${SERVER}\" is not a server ID. Use the UUID of the server, or its first 8 characters."
SERVER="$(printf '%s' "${SERVER}" | tr 'A-F' 'a-f')"
matches=()
for folder in "${VOLUMES}/${SERVER}"*/; do
  [ -d "${folder}" ] && matches+=("$(basename "${folder%/}")")
done
case "${#matches[@]}" in
  0) die "there is no server \"${SERVER}\" in ${VOLUMES}." ;;
  1) UUID="${matches[0]}" ;;
  *) die "\"${SERVER}\" fits more than one server. Use the whole UUID." ;;
esac
VOLUME="${VOLUMES}/${UUID}"
real_dir "${VOLUME}" || die "${VOLUME} is not a folder."

if [ -n "${APP_DIR_OPTION}" ]; then
  APP_DIR="${APP_DIR_OPTION%/}"
elif is_bundle "${VOLUME}/xiero-nexus-ai"; then
  APP_DIR="${VOLUME}/xiero-nexus-ai"
elif is_bundle "${VOLUME}"; then
  APP_DIR="${VOLUME}"
else
  found=()
  while IFS= read -r -d '' file; do
    is_bundle "$(dirname "${file}")" && found+=("$(dirname "${file}")")
  done < <(find "${VOLUME}" -maxdepth 3 -name VERSION -type f -not -path '*/node_modules/*' -print0 2> /dev/null)
  case "${#found[@]}" in
    1) APP_DIR="${found[0]}" ;;
    0)
      if grep -qs '"name": *"xiero-nexus-ai"' "${VOLUME}/package.json" "${VOLUME}"/*/package.json 2> /dev/null; then
        die "this server runs the app from its source code, not from a release bundle. This script upgrades bundles only; see RELEASING.md, \"Install a release\"."
      fi
      die "no release bundle of Xiero Nexus AI was found in ${VOLUME}. Name its folder with --app-dir."
      ;;
    *) die "more than one bundle was found in ${VOLUME}. Name the one to upgrade with --app-dir." ;;
  esac
fi
real_dir "${APP_DIR}" || die "${APP_DIR} is a link, not a folder. Not touching it."
inside "${APP_DIR}" "${VOLUME}" || die "${APP_DIR} is not inside the files of server ${UUID}."
APP_DIR="$(realpath "${APP_DIR}")"
is_bundle "${APP_DIR}" || die "${APP_DIR} is not a release bundle of Xiero Nexus AI (no VERSION, start.js and server.js)."
for name in .env data; do
  if [ -L "${APP_DIR}/${name}" ]; then die "${APP_DIR}/${name} is a link. Not touching this server; look at where it leads first."; fi
done

OLD_VERSION="$(version_field version "${APP_DIR}/VERSION")"
OLD_COMMIT="$(version_field commit "${APP_DIR}/VERSION")"
NODE_MAJOR="$(version_field node "${APP_DIR}/VERSION")"
PLATFORM="$(version_field platform "${APP_DIR}/VERSION")"
[ -n "${OLD_VERSION}" ] && [ -n "${NODE_MAJOR}" ] || die "${APP_DIR}/VERSION cannot be read."
PLATFORM="${PLATFORM:-linux-x64}"
OWNER="$(stat -c '%u:%g' "${APP_DIR}")"
ENV_FILE="${APP_DIR}/.env"

# Where the app keeps its database and media, as paths on this machine.
host_path() { # a path as the app sees it
  local path="$1"
  case "${path}" in
    "${CONTAINER_HOME}") path="${VOLUME}" ;;
    "${CONTAINER_HOME}"/*) path="${VOLUME}/${path#"${CONTAINER_HOME}"/}" ;;
    /*) return 1 ;;
    *) path="${APP_DIR}/${path#./}" ;;
  esac
  inside "${path}" "${VOLUME}" || return 1
  realpath -m "${path}"
}
DATABASE_SETTING="$(env_get DATABASE_PATH "${ENV_FILE}")"
MEDIA_SETTING="$(env_get MEDIA_PATH "${ENV_FILE}")"
DATABASE="$(host_path "${DATABASE_SETTING:-./data/nexus.db}" || true)"
if [ -z "${DATABASE}" ]; then
  die "DATABASE_PATH in .env (${DATABASE_SETTING}) is outside this server's files, so it cannot be backed up from here."
fi
if [ -n "${MEDIA_SETTING}" ]; then MEDIA_DIR="$(host_path "${MEDIA_SETTING}" || true)"; else MEDIA_DIR="$(dirname "${DATABASE}")/media"; fi
if [ -e "${DATABASE}" ] && ! real_file "${DATABASE}"; then die "${DATABASE} is not a plain file. Not touching this server."; fi

mkdir -p "${BACKUP_ROOT}"
chmod 700 "${BACKUP_ROOT}"
exec 9> "${BACKUP_ROOT}/.lock-${UUID}"
flock -n 9 || die "another upgrade of this server is running."

# ── How the server is stopped and started ────────────────────────────────────

# Asked once, here, so that everything below knows the answer.
have_docker || true

STATE_BEFORE=""
if [ "${POWER}" = "wings" ]; then
  [ -r "${WINGS_CONFIG}" ] || die "${WINGS_CONFIG} cannot be read, so Wings cannot be asked to stop the server. Stop the server in the panel and add --power manual."
  token_result=0
  NODE_TOKEN="$(node_token)" || token_result=$?
  case "${token_result}" in
    0) ;;
    2) die "the token in ${WINGS_CONFIG} refers to a variable of the Wings service, which cannot be read from here. Run this with WINGS_TOKEN=<the token> in front, or stop the server in the panel and add --power manual." ;;
    *) die "there is no token in ${WINGS_CONFIG}. Stop the server in the panel and add --power manual." ;;
  esac
  wings_host="$(yaml_get "${WINGS_CONFIG}" api.host || true)"
  wings_port="$(yaml_get "${WINGS_CONFIG}" api.port || true)"
  case "${wings_host}" in "" | 0.0.0.0 | "::" | "[::]") wings_host="127.0.0.1" ;; esac
  case "${wings_host}" in *:*) [ "${wings_host#[}" != "${wings_host}" ] || wings_host="[${wings_host}]" ;; esac
  if [ "$(yaml_get "${WINGS_CONFIG}" api.ssl.enabled || true)" = "true" ]; then
    # The certificate is for the node's public name, not for this address; the
    # request does not leave this machine.
    WINGS_URL="https://${wings_host}:${wings_port:-8080}"
    WINGS_INSECURE=(-k)
  else
    WINGS_URL="http://${wings_host}:${wings_port:-8080}"
  fi
  if ! wings_call GET "/api/servers/${UUID}"; then
    die "$(wings_problem) Stop the server in the panel and add --power manual."
  fi
  STATE_BEFORE="$(grep -o '"state":"[a-z]*"' "${WORK}/wings.body" | head -n 1 | cut -d '"' -f 4 || true)"
  [ -n "${STATE_BEFORE}" ] || die "Wings did not say whether the server runs. Stop the server in the panel and add --power manual."
  if grep -q '"is_suspended":true' "${WORK}/wings.body"; then
    warn "this server is suspended in the panel: Wings will not start it afterwards."
    LEAVE_STOPPED=true
  fi
  if [ -z "${CHECK_URL}" ]; then
    allocation="$(grep -o '"default":{"ip":"[^"]*","port":[0-9]*' "${WORK}/wings.body" | head -n 1 || true)"
    if [ -n "${allocation}" ]; then
      check_ip="$(printf '%s' "${allocation}" | cut -d '"' -f 6)"
      check_port="${allocation##*:}"
      case "${check_ip}" in "" | 0.0.0.0 | "::") check_ip="127.0.0.1" ;; esac
      case "${check_ip}" in *:*) check_ip="[${check_ip}]" ;; esac
      CHECK_URL="http://${check_ip}:${check_port}"
    fi
  fi
else
  have_docker || die "--power manual needs Docker here, to see that the server is stopped."
  if container_running; then STATE_BEFORE="running"; else STATE_BEFORE="offline"; fi
fi

# A server in the middle of a restart looks stopped for a moment: look again
# before taking it for stopped.
if [ "${STATE_BEFORE}" = "offline" ] || [ "${STATE_BEFORE}" = "stopping" ]; then
  if wait_until_down 8; then
    STATE_BEFORE="offline"
  else
    STATE_BEFORE="$(server_state || true)"
    STATE_BEFORE="${STATE_BEFORE:-offline}"
  fi
fi

# Whether the check can be trusted: only when the running version answers it
# now. A server that is just starting gets a little time to do so.
CHECK_TRUSTED=false
if [ -n "${CHECK_URL}" ] && [ "${STATE_BEFORE}" != "offline" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ "$(probe)" = "ok" ]; then
      CHECK_TRUSTED=true
      break
    fi
    sleep 2
  done
fi

# ── Going back ───────────────────────────────────────────────────────────────

# Put the program files, the database and .env of a backup folder back. The
# server must be stopped.
put_back() { # BACKUP FOLDER
  local from="$1" name trash kept=()
  if [ -d "${from}/code" ]; then
    mapfile -t kept < <(names_in "${from}/code")
    trash="$(mktemp -d "${VOLUME}/.xiero-upgrade-XXXXXX")"
    for name in ${KNOWN_BUNDLE_NAMES} ${kept[@]+"${kept[@]}"}; do
      case " ${PROTECTED_NAMES} " in *" ${name} "*) continue ;; esac
      if [ -e "${APP_DIR}/${name}" ] || [ -L "${APP_DIR}/${name}" ]; then
        [ -e "${trash}/${name}" ] || mv "${APP_DIR}/${name}" "${trash}/${name}"
      fi
    done
    for name in ${kept[@]+"${kept[@]}"}; do
      case " ${PROTECTED_NAMES} " in *" ${name} "*) continue ;; esac
      cp -a "${from}/code/${name}" "${APP_DIR}/${name}"
      chown -hR "${OWNER}" "${APP_DIR}/${name}" 2> /dev/null || true
    done
    rm -rf "${trash}"
  fi
  if [ -f "${from}/data/$(basename "${DATABASE}")" ]; then
    # The write-ahead files of the newer version must not meet the older database.
    rm -f "${DATABASE}" "${DATABASE}-wal" "${DATABASE}-shm"
    mkdir -p "$(dirname "${DATABASE}")"
    cp -a "${from}/data/." "$(dirname "${DATABASE}")/"
  elif [ -f "${from}/no-database" ]; then
    # There was none before: the one the newer version made goes.
    rm -f "${DATABASE}" "${DATABASE}-wal" "${DATABASE}-shm"
  fi
  if [ -f "${from}/dot-env" ] && ! [ -L "${ENV_FILE}" ]; then
    if [ -f "${ENV_FILE}" ]; then cat "${from}/dot-env" > "${ENV_FILE}"; else cp -a "${from}/dot-env" "${ENV_FILE}"; fi
  fi
}

# shellcheck disable=SC2329  # called by the trap below
on_exit() {
  local code=$?
  trap - EXIT
  set +e
  case "${PHASE}" in
    replacing)
      # The server is stopped and the new files are partly or wholly in place.
      say ""
      say "Stopped before the new version was started. Putting the old version back..."
      if put_back "${BACKUP}"; then
        say "The old version (${OLD_VERSION}) and its database are back in place."
      else
        warn "the old version could not be put back completely. Its files and database are in ${BACKUP}; run this again with --restore ${BACKUP}."
        STOPPED_BY_US=false
      fi
      ;;
    starting)
      say ""
      say "Stopped while the new version was starting. Version ${NEW_VERSION} is installed and the server was told to start."
      say "The backup of ${OLD_VERSION} is in ${BACKUP}; --restore ${BACKUP} goes back to it."
      ;;
    restoring)
      warn "the backup was not put back completely. Run the same command again; the server is left stopped."
      STOPPED_BY_US=false
      ;;
  esac
  if [ "${STOPPED_BY_US}" = true ] && [ "${PHASE}" != "done" ] && [ "${LEAVE_STOPPED}" != true ]; then
    say "Starting the server again..."
    power start > /dev/null || warn "the server could not be started. Start it in the panel."
  fi
  if [ -n "${STAGING}" ]; then rm -rf "${STAGING}"; fi
  rm -rf "${WORK}"
  exit "${code}"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

describe_target() {
  say "  Server      ${UUID}"
  say "  Files       ${APP_DIR}"
  say "  Installed   ${OLD_VERSION}${OLD_COMMIT:+ (${OLD_COMMIT})}, for Node.js ${NODE_MAJOR}"
}

# ── --start ──────────────────────────────────────────────────────────────────

if [ "${START_ONLY}" = true ]; then
  step "Starting the server"
  describe_target
  say "  Power       through Wings at ${WINGS_URL} (now: ${STATE_BEFORE})"
  say "  Check       ${CHECK_URL:-no address found: the site has to be looked at by hand (--check-url)}"
  if [ "${CHECK_TRUSTED}" = true ]; then
    say ""
    say "The server runs and answers at ${CHECK_URL}. Nothing to do."
    exit 0
  fi
  if [ "${DRY_RUN}" = true ]; then
    say ""
    say "Dry run: nothing was changed."
    exit 0
  fi
  say ""
  result=0
  start_and_check || result=$?
  case "${result}" in
    0) say "The server answers at ${CHECK_URL}." ;;
    2) say "The server was started. Whether the app answers cannot be told from here: open the site." ;;
    *)
      show_log
      die "the server was asked to start, but the app does not answer. Look at the console above."
      ;;
  esac
  exit 0
fi

# ── --restore ────────────────────────────────────────────────────────────────

if [ -n "${RESTORE}" ]; then
  RESTORE="$(realpath "${RESTORE}")"
  [ -d "${RESTORE}/code" ] || [ -d "${RESTORE}/data" ] || die "${RESTORE} is not a backup folder of this script (no code/ or data/ in it)."
  backup_version="$(version_field version "${RESTORE}/code/VERSION" || true)"
  backup_server="$(version_field server "${RESTORE}/INFO" || true)"
  if [ -n "${backup_server}" ] && [ "${backup_server}" != "${UUID}" ] && [ "${FORCE}" != true ]; then
    die "that backup is of server ${backup_server}, not of ${UUID}. (--force puts it back all the same.)"
  fi
  step "Put a backup back"
  describe_target
  say "  Backup      ${RESTORE}${backup_version:+ (version ${backup_version})}"
  say "  Power       $([ "${POWER}" = wings ] && echo "through Wings (now: ${STATE_BEFORE})" || echo "by hand (now: ${STATE_BEFORE})")"
  say ""
  say "The program files and the database go back to what they were when that backup"
  say "was made. Everything that was added or changed since then is lost."
  if [ "${DRY_RUN}" = true ]; then
    say ""
    say "Dry run: nothing was changed."
    exit 0
  fi
  confirm "Put this backup back?" || die "stopped; nothing was changed."
  step "Stopping the server"
  stop_server
  step "Putting the backup back"
  PHASE="restoring"
  put_back "${RESTORE}"
  say "Done."
  if [ "${LEAVE_STOPPED}" = true ]; then
    PHASE="done"
    say "The server is left stopped."
    exit 0
  fi
  step "Starting the server"
  result=0
  start_and_check || result=$?
  PHASE="done"
  case "${result}" in
    0) say "The server answers at ${CHECK_URL}. The backup is back in place." ;;
    2) say "The backup is back in place. $([ "${POWER}" = manual ] && echo "Start the server in the panel." || echo "The server was started; open the site to check it.")" ;;
    *)
      show_log
      die "the backup is back in place, but the server does not answer. Look at the console above."
      ;;
  esac
  exit 0
fi

# ── The new bundle ───────────────────────────────────────────────────────────

ASSET="xiero-nexus-ai-${PLATFORM}-node${NODE_MAJOR}.zip"
step "Getting the new version"
if [ -n "${ZIP}" ]; then
  [ -f "${ZIP}" ] || die "${ZIP} does not exist."
  cp "${ZIP}" "${WORK}/${ASSET}"
  say "Using ${ZIP}."
else
  if [ "${VERSION}" = "latest" ]; then base="${RELEASES_URL}/latest/download"; else base="${RELEASES_URL}/download/v${VERSION}"; fi
  say "Downloading ${base}/${ASSET}"
  curl -fsSL --retry 3 --max-time 600 -o "${WORK}/${ASSET}" "${base}/${ASSET}" \
    || die "the download failed. Check the version (${VERSION}) and this machine's connection to github.com. Nothing was changed."
  curl -fsSL --retry 3 --max-time 120 -o "${WORK}/SHA256SUMS.txt" "${base}/SHA256SUMS.txt" \
    || die "the list of checksums could not be downloaded, so the bundle cannot be checked. Nothing was changed."
  expected="$(awk -v file="${ASSET}" '{ name = $2; sub(/^\*/, "", name); if (name == file) print $1 }' "${WORK}/SHA256SUMS.txt" | head -n 1)"
  actual="$(sha256sum "${WORK}/${ASSET}" | awk '{ print $1 }')"
  [ -n "${expected}" ] || die "the release's checksum list does not name ${ASSET}. Nothing was changed."
  [ "${expected}" = "${actual}" ] || die "the downloaded file does not match the release's checksum. Nothing was changed."
  say "The checksum matches."
fi
mkdir "${WORK}/new"
unpack "${WORK}/${ASSET}" "${WORK}/new" || die "the bundle cannot be opened. Nothing was changed."
NEW="${WORK}/new/xiero-nexus-ai"
is_bundle "${NEW}" || die "that file is not a Xiero Nexus AI bundle (no xiero-nexus-ai/ with VERSION, start.js and server.js in it)."
NEW_VERSION="$(version_field version "${NEW}/VERSION")"
NEW_COMMIT="$(version_field commit "${NEW}/VERSION")"
NEW_NODE="$(version_field node "${NEW}/VERSION")"
NEW_PLATFORM="$(version_field platform "${NEW}/VERSION")"
[ "${NEW_NODE}" = "${NODE_MAJOR}" ] || die "that bundle is for Node.js ${NEW_NODE}, but this server runs a bundle for Node.js ${NODE_MAJOR}."
[ "${NEW_PLATFORM:-${PLATFORM}}" = "${PLATFORM}" ] || die "that bundle is for ${NEW_PLATFORM}, but this server runs a bundle for ${PLATFORM}."
for name in ${PROTECTED_NAMES}; do
  [ ! -e "${NEW}/${name}" ] || die "that bundle contains ${name}, which a bundle never does. Not installing it."
done
mapfile -t NEW_NAMES < <(names_in "${NEW}")
for name in "${NEW_NAMES[@]}"; do
  [[ "${name}" =~ ^[A-Za-z0-9._-]+$ ]] || die "that bundle has a file with an unusual name in it. Not installing it."
done

base_of() { printf '%s' "${1%%-*}"; }
if [ "${NEW_VERSION}" = "${OLD_VERSION}" ] && [ "${NEW_COMMIT}" = "${OLD_COMMIT}" ] && [ "${FORCE}" != true ]; then
  say ""
  say "Version ${OLD_VERSION} is already installed. Nothing to do. (--force installs it again.)"
  exit 0
fi
if [ "$(base_of "${NEW_VERSION}")" != "$(base_of "${OLD_VERSION}")" ] \
  && [ "$(printf '%s\n%s\n' "$(base_of "${NEW_VERSION}")" "$(base_of "${OLD_VERSION}")" | sort -V | tail -n 1)" = "$(base_of "${OLD_VERSION}")" ] \
  && [ "${ALLOW_DOWNGRADE}" != true ]; then
  die "version ${NEW_VERSION} is older than the installed ${OLD_VERSION}. An older version may not be able to read the database. To go back, use --restore with a backup."
fi

if [ -n "${FFMPEG_FILE}" ]; then
  [ -f "${FFMPEG_FILE}" ] || die "${FFMPEG_FILE} does not exist."
  [ "$(head -c 4 "${FFMPEG_FILE}" | od -An -c | tr -d ' \n')" = '177ELF' ] || die "${FFMPEG_FILE} is not a Linux program."
  SETTINGS+=("FFMPEG_PATH=${CONTAINER_HOME}/xiero-tools/ffmpeg")
fi

# ── The plan ─────────────────────────────────────────────────────────────────

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${BACKUP_ROOT}/${UUID}/${STAMP}-v${OLD_VERSION}"
database_kb=0
[ -f "${DATABASE}" ] && database_kb="$(size_kb "${DATABASE}")"
media_kb=0
[ -n "${MEDIA_DIR}" ] && [ -d "${MEDIA_DIR}" ] && media_kb="$(size_kb "${MEDIA_DIR}")"
new_kb="$(size_kb "${NEW}")"
old_kb=0
for name in ${KNOWN_BUNDLE_NAMES}; do
  [ -e "${APP_DIR}/${name}" ] && old_kb=$((old_kb + $(size_kb "${APP_DIR}/${name}")))
done

step "The plan"
describe_target
say "  New         ${NEW_VERSION}${NEW_COMMIT:+ (${NEW_COMMIT})}"
if [ -f "${DATABASE}" ]; then
  say "  Database    ${DATABASE} ($(human "${database_kb}"))"
else
  say "  Database    none yet at ${DATABASE}"
fi
if [ "${media_kb}" -gt 0 ]; then
  say "  Media       ${MEDIA_DIR} ($(human "${media_kb}")): $([ "${WITH_MEDIA}" = true ] && echo "copied to the backup" || echo "left as it is, not copied (--with-media)")"
fi
say "  Backup      ${BACKUP}"
if [ "${POWER}" = "wings" ]; then
  say "  Power       through Wings at ${WINGS_URL} (now: ${STATE_BEFORE})"
  if [ "${STATE_BEFORE}" = "offline" ] && [ "${LEAVE_STOPPED}" != true ]; then
    say "              The server is stopped now. It is started afterwards, to see that the new version runs (--leave-stopped)."
  fi
else
  say "  Power       by hand in the panel (now: ${STATE_BEFORE})"
fi
if [ "${CHECK_TRUSTED}" = true ]; then
  say "  Check       ${CHECK_URL} (answers now: yes)"
elif [ -n "${CHECK_URL}" ] && [ "${STATE_BEFORE}" = "offline" ]; then
  say "  Check       ${CHECK_URL}"
elif [ -n "${CHECK_URL}" ]; then
  say "  Check       ${CHECK_URL} (answers now: no)"
  say "              So it cannot tell afterwards whether the new version works, and will not go back by itself."
  say "              Open the site after the upgrade, or name the address that answers on this machine with --check-url."
else
  say "  Check       no address found: the site has to be checked by hand afterwards (--check-url)"
fi
for setting in ${SETTINGS[@]+"${SETTINGS[@]}"}; do
  current="$(env_get "${setting%%=*}" "${ENV_FILE}")"
  if [ "${current}" = "${setting#*=}" ]; then
    say "  Setting     ${setting} (already so)"
  else
    say "  Setting     ${setting}$([ -n "${current}" ] && echo "   (now: ${current})")"
  fi
done
[ -z "${FFMPEG_FILE}" ] || say "  ffmpeg      ${FFMPEG_FILE} is copied to ${VOLUME}/xiero-tools/ffmpeg"
[ -f "${ENV_FILE}" ] || warn "there is no .env in ${APP_DIR}. The app does not start without SECRET_ENCRYPTION_KEY; see RELEASING.md."

need_volume_kb=$((new_kb + new_kb / 5 + 10240))
need_backup_kb=$((old_kb + database_kb * 2 + 10240))
[ "${WITH_MEDIA}" = true ] && need_backup_kb=$((need_backup_kb + media_kb))
[ "$(free_kb "${VOLUME}")" -ge "${need_volume_kb}" ] \
  || die "not enough free space for the new version in ${VOLUME} ($(human "${need_volume_kb}") needed, $(human "$(free_kb "${VOLUME}")") free)."
[ "$(free_kb "${BACKUP_ROOT}")" -ge "${need_backup_kb}" ] \
  || die "not enough free space for the backup in ${BACKUP_ROOT} ($(human "${need_backup_kb}") needed, $(human "$(free_kb "${BACKUP_ROOT}")") free)."

if [ "${DRY_RUN}" = true ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi
say ""
confirm "Upgrade this server now? It is stopped for about a minute." || die "stopped; nothing was changed."

# ── Before the server stops: everything that takes time ──────────────────────

step "Preparing"
STAGING="$(mktemp -d "${VOLUME}/.xiero-upgrade-XXXXXX")"
mkdir "${STAGING}/new" "${STAGING}/old"
cp -a "${NEW}/." "${STAGING}/new/"
chown -hR "${OWNER}" "${STAGING}/new" 2> /dev/null || warn "the new files could not be given to the server's user (${OWNER})."
say "The new version is ready next to the old one."

mkdir -p "${BACKUP}/code" "${BACKUP}/data"
chmod 700 "${BACKUP_ROOT}/${UUID}" "${BACKUP}"
for name in ${KNOWN_BUNDLE_NAMES}; do
  if [ -e "${APP_DIR}/${name}" ] || [ -L "${APP_DIR}/${name}" ]; then cp -a "${APP_DIR}/${name}" "${BACKUP}/code/${name}"; fi
done
say "The program files of ${OLD_VERSION} are copied to the backup."

# ── Stop, back up the data, replace the program files ────────────────────────

step "Stopping the server"
stop_server

step "Backing up"
# Looked at again now that nothing runs: links could have been put there meanwhile.
for name in .env data; do
  [ ! -L "${APP_DIR}/${name}" ] || die "${APP_DIR}/${name} became a link. Nothing was changed."
done
if [ -f "${DATABASE}" ]; then
  real_file "${DATABASE}" || die "${DATABASE} is not a plain file. Nothing was changed."
  for file in "${DATABASE}" "${DATABASE}-wal" "${DATABASE}-shm"; do
    if [ -f "${file}" ] && [ ! -L "${file}" ]; then cp -a "${file}" "${BACKUP}/data/"; fi
  done
  say "Database: ${BACKUP}/data/$(basename "${DATABASE}")"
else
  : > "${BACKUP}/no-database"
fi
if [ -f "${ENV_FILE}" ]; then
  cp -a "${ENV_FILE}" "${BACKUP}/dot-env"
  chmod 600 "${BACKUP}/dot-env"
  say "Settings: ${BACKUP}/dot-env"
fi
if [ "${WITH_MEDIA}" = true ] && [ -n "${MEDIA_DIR}" ] && real_dir "${MEDIA_DIR}"; then
  say "Copying the media ($(human "${media_kb}"))..."
  cp -a "${MEDIA_DIR}" "${BACKUP}/media"
fi
{
  echo "server=${UUID}"
  echo "made=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "from=${OLD_VERSION}"
  echo "to=${NEW_VERSION}"
  echo "files=${APP_DIR}"
  echo "database=${DATABASE}"
} > "${BACKUP}/INFO"

step "Installing ${NEW_VERSION}"
PHASE="replacing"
for name in ${KNOWN_BUNDLE_NAMES} "${NEW_NAMES[@]}"; do
  case " ${PROTECTED_NAMES} " in *" ${name} "*) continue ;; esac
  if [ -e "${APP_DIR}/${name}" ] || [ -L "${APP_DIR}/${name}" ]; then
    [ -e "${STAGING}/old/${name}" ] || mv "${APP_DIR}/${name}" "${STAGING}/old/${name}"
  fi
done
for name in "${NEW_NAMES[@]}"; do
  case " ${PROTECTED_NAMES} " in *" ${name} "*) continue ;; esac
  mv "${STAGING}/new/${name}" "${APP_DIR}/${name}"
done
say "The program files are in place. .env and data/ were not touched."

if [ -n "${FFMPEG_FILE}" ]; then
  [ ! -L "${VOLUME}/xiero-tools" ] || die "${VOLUME}/xiero-tools is a link."
  mkdir -p "${VOLUME}/xiero-tools"
  cp "${FFMPEG_FILE}" "${VOLUME}/xiero-tools/ffmpeg"
  chmod 755 "${VOLUME}/xiero-tools" "${VOLUME}/xiero-tools/ffmpeg"
  chown -hR "${OWNER}" "${VOLUME}/xiero-tools" 2> /dev/null || true
  say "ffmpeg: ${VOLUME}/xiero-tools/ffmpeg"
fi
if [ "${#SETTINGS[@]}" -gt 0 ]; then
  [ ! -L "${ENV_FILE}" ] || die "${ENV_FILE} is a link."
  if [ ! -f "${ENV_FILE}" ]; then
    : > "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
    chown -h "${OWNER}" "${ENV_FILE}" 2> /dev/null || true
  fi
  for setting in "${SETTINGS[@]}"; do
    env_set "${ENV_FILE}" "${setting%%=*}" "${setting#*=}"
    say "Set ${setting%%=*} in .env."
  done
fi

# ── Start and check ──────────────────────────────────────────────────────────

finish() {
  PHASE="done"
  rm -rf "${STAGING}"
  STAGING=""
  say ""
  say "Backup of ${OLD_VERSION}: ${BACKUP}"
  say "To go back to it:  sudo bash pterodactyl-upgrade.sh --server ${UUID} --restore ${BACKUP}"
}

if [ "${LEAVE_STOPPED}" = true ] || [ "${POWER}" = "manual" ]; then
  finish
  step "Version ${NEW_VERSION} is installed"
  if [ "${POWER}" = "manual" ]; then say "Start the server in the panel now and open the site."; else say "The server is left stopped."; fi
  exit 0
fi

step "Starting the server"
PHASE="starting"
result=0
start_and_check || result=$?
if [ "${result}" = "0" ]; then
  finish
  step "Version ${NEW_VERSION} is running and answers at ${CHECK_URL}"
  if have_docker && container_running; then
    if docker exec "${UUID}" sh -c 'command -v ffmpeg' > /dev/null 2>&1 || [ -n "${FFMPEG_FILE}" ]; then
      say "ffmpeg is available to the server: clips can be joined into one video."
    else
      say "The server's image has no ffmpeg: joining clips into one video is switched off. See --ffmpeg."
    fi
  fi
  exit 0
fi
if [ "${result}" = "2" ] || { [ "${CHECK_TRUSTED}" != true ] && [ "$(server_state || true)" != "offline" ]; }; then
  finish
  step "Version ${NEW_VERSION} is installed and the server was started"
  if [ -z "${CHECK_URL}" ]; then
    say "Whether the site answers could not be checked from this machine."
  elif [ "${STATE_BEFORE}" = "offline" ]; then
    say "${CHECK_URL} does not answer. The server was stopped before the upgrade, so it is not known whether that address ever answers on this machine."
  else
    say "Whether the site answers could not be checked from this machine: ${CHECK_URL} did not answer before the upgrade either."
  fi
  say "Open the site. If it does not come up, look at the console in the panel, or go back with the command above."
  exit 0
fi

show_log
if [ "${ROLLBACK}" != true ]; then
  finish
  die "version ${NEW_VERSION} is installed, but the server does not answer. It was left like this (--no-rollback)."
fi

step "The new version does not answer: going back to ${OLD_VERSION}"
# Asked even when the server looks stopped already: Wings starts a server that
# ended by itself once more, and that start must not run into the old files
# while they are put back.
power stop > /dev/null || true
if ! wait_until_down "${STOP_TIMEOUT}"; then
  power kill > /dev/null || true
  wait_until_down 30 || die "the server does not stop, so the old version cannot be put back. Stop it in the panel, then run: sudo bash pterodactyl-upgrade.sh --server ${UUID} --restore ${BACKUP}"
fi
PHASE="restoring"
put_back "${BACKUP}"
say "The program files and the database of ${OLD_VERSION} are back in place."
PHASE="starting"
if [ "${STATE_BEFORE}" = "offline" ]; then
  say "The server was stopped before the upgrade and is left stopped."
else
  result=0
  start_and_check || result=$?
  case "${result}" in
    0) say "The server runs ${OLD_VERSION} again and answers." ;;
    *) warn "the server was started with ${OLD_VERSION} again, but does not answer yet. Look at the console in the panel." ;;
  esac
fi
PHASE="done"
rm -rf "${STAGING}"
STAGING=""
say "The backup stays at ${BACKUP}."
die "the upgrade to ${NEW_VERSION} did not work; the server is back on ${OLD_VERSION}. The console output above says why the new version did not start."
