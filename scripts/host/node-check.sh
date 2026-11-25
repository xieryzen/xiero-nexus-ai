#!/usr/bin/env bash
# What is on this Pterodactyl node, for someone who is about to upgrade a
# server on it from somewhere else (over-ssh.sh check). It only reads.
#
#   sudo bash node-check.sh [--server <server id>]
#
# It says what the machine runs, whether Wings and Docker are there, whether
# the releases on GitHub can be reached from here, which servers hold a Xiero
# Nexus AI bundle, and for one server what is in its files, which image it
# runs in, what it runs when it starts, how much room is left, and whether
# the browser service its .env names answers it. Of .env it shows which names
# are set and no value; it shows no token and no file's content.
#
#   --server <id>        The server to look at: its UUID or the first 8
#                        characters. Without it: the one server that has the app.
#   --volumes <dir>      Where Wings keeps server files (default: from the Wings
#                        configuration, else /var/lib/pterodactyl/volumes).
#   --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
#   --backup-dir <dir>   Where the upgrade keeps its backups (default /root/xiero-nexus-backups).
#   --site <url>         Also say how the site's public address is answered on
#                        this machine: where the name leads, what listens on
#                        ports 80 and 443, whether a web server's configuration
#                        names the site, and what a request gets.
#   --try-image          Also find out what the server's image holds and whether
#                        its startup command can run a file. For that, and only
#                        with this option, a container is started from the image
#                        for a moment: without network, without any server's
#                        files, and removed again. The image is not pulled.
set -uo pipefail

REPO="${XIERO_REPO:-xieryzen/xiero-nexus-ai}"
RELEASES_URL="${XIERO_RELEASES_URL:-https://github.com/${REPO}/releases}"
SERVER=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
BACKUP_ROOT="/root/xiero-nexus-backups"
TRY_IMAGE=false
SITE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --volumes) VOLUMES="${2:-}"; shift 2 ;;
    --wings-config) WINGS_CONFIG="${2:-}"; shift 2 ;;
    --backup-dir) BACKUP_ROOT="${2:-}"; shift 2 ;;
    --try-image) TRY_IMAGE=true; shift ;;
    --site) SITE="${2:-}"; shift 2 ;;
    -h | --help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown option \"$1\". See --help." >&2
      exit 1
      ;;
  esac
done

head_line() { printf '\n%s\n' "$*"; }
row() { printf '  %-11s %s\n' "$1" "$2"; }
more() { printf '  %-11s %s\n' "" "$1"; }
have() { command -v "$1" > /dev/null 2>&1; }
human() { # kilobytes, readable
  awk -v kb="${1:-0}" 'BEGIN {
    if (kb >= 1048576) printf "%.1f GB", kb / 1048576
    else if (kb >= 1024) printf "%.0f MB", kb / 1024
    else printf "%d KB", kb
  }'
}
size_kb() { timeout 120 du -sk "$1" 2> /dev/null | awk '{ print $1 }'; }
free_kb() { df -Pk "$1" 2> /dev/null | awk 'NR == 2 { print $4 }'; }
field() { sed -n "s/^$1=//p" "$2" 2> /dev/null | head -n 1 | tr -d '\r'; }
is_bundle() { [ -f "$1/VERSION" ] && [ ! -L "$1/VERSION" ] && [ -f "$1/start.js" ] && [ -f "$1/server.js" ] && grep -q '^version=' "$1/VERSION"; }
# A value from the Wings configuration, such as "system.data".
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

# ── The machine ──────────────────────────────────────────────────────────────

head_line "This machine"
system="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2> /dev/null | tr -d '"' | head -n 1)"
row "System" "${system:-unknown}, $(uname -m), kernel $(uname -r)"
row "Signed in" "$(id -un) (user number $(id -u))"
if [ "$(id -u)" != "0" ]; then more "Not root: some of what follows may be hidden from this user."; fi
row "Time" "$(date -u '+%Y-%m-%d %H:%M') UTC"

# How the machine is: since when it runs, its memory, its load, and whether
# the kernel had to end programs for lack of memory. A machine that is short
# of memory answers nobody for a while: no SSH, no site, and no way out for
# the app either. PROC is where those numbers are read (for the tests).
PROC="${XIERO_PROC:-/proc}"
if [ -r "${PROC}/uptime" ]; then
  up_seconds="$(awk '{ print int($1) }' "${PROC}/uptime" 2> /dev/null || echo 0)"
  up_words="$(awk -v s="${up_seconds}" 'BEGIN {
    d = int(s / 86400); h = int((s % 86400) / 3600); m = int((s % 3600) / 60)
    if (d > 0) printf "%d day%s and %d hour%s", d, (d == 1 ? "" : "s"), h, (h == 1 ? "" : "s")
    else if (h > 0) printf "%d hour%s and %d minute%s", h, (h == 1 ? "" : "s"), m, (m == 1 ? "" : "s")
    else printf "%d minute%s", m, (m == 1 ? "" : "s")
  }')"
  since="$(date -u -d "@$(($(date +%s) - up_seconds))" '+%Y-%m-%d %H:%M' 2> /dev/null || true)"
  row "Running" "for ${up_words}${since:+ (started ${since} UTC)}"
fi
if [ -r "${PROC}/meminfo" ]; then
  mem_total="$(awk '/^MemTotal:/ { print $2 }' "${PROC}/meminfo")"
  mem_free="$(awk '/^MemAvailable:/ { print $2 }' "${PROC}/meminfo")"
  swap_total="$(awk '/^SwapTotal:/ { print $2 }' "${PROC}/meminfo")"
  swap_free="$(awk '/^SwapFree:/ { print $2 }' "${PROC}/meminfo")"
  if [ "${swap_total:-0}" -gt 0 ] 2> /dev/null; then
    swap_says="swap $(human "${swap_total}"), $(human "${swap_free:-0}") of it free"
  else
    swap_says="no swap"
  fi
  [ -z "${mem_total}" ] || row "Memory" "$(human "${mem_total}"), $(human "${mem_free:-0}") of it free now; ${swap_says}"
fi
if [ -r "${PROC}/loadavg" ]; then
  row "Load" "$(cut -d' ' -f1-3 "${PROC}/loadavg" 2> /dev/null) over 1, 5 and 15 minutes, on $(nproc 2> /dev/null || echo "?") processors"
fi
# What the kernel wrote when it ended a program for lack of memory, in the
# last seven days: "Memory cgroup out of memory" when a container reached its
# own limit (that harms nothing else), "Out of memory" when the whole machine
# had none left. XIERO_KERNEL_LOG: a file to read instead (for the tests).
kernel_said=""
if [ -n "${XIERO_KERNEL_LOG:-}" ]; then
  kernel_said="$(cat "${XIERO_KERNEL_LOG}" 2> /dev/null || true)"
elif have journalctl; then
  kernel_said="$(timeout 60 journalctl _TRANSPORT=kernel --no-pager -o short-iso --since '-7 days' 2> /dev/null || true)"
elif have dmesg; then
  kernel_said="$(timeout 30 dmesg -T 2> /dev/null || true)"
fi
ended="$(printf '%s\n' "${kernel_said}" | grep -i 'out of memory: killed process' || true)"
if [ -n "${ended}" ]; then
  in_container="$(printf '%s\n' "${ended}" | grep -ci 'memory cgroup out of memory' || true)"
  all="$(printf '%s\n' "${ended}" | grep -c . || true)"
  whole=$((all - in_container))
  last="$(printf '%s\n' "${ended}" | tail -n 1)"
  last_what="$(printf '%s\n' "${last}" | sed -n 's/.*[Kk]illed process [0-9]* (\([^)]*\)).*/\1/p')"
  last_when="$(printf '%s\n' "${last}" | awk '{ print $1 }' | cut -c1-16 | tr 'T' ' ')"
  row "No memory" "in the last 7 days the kernel ended ${all} program$([ "${all}" = "1" ] || echo s) for lack of memory: ${whole} because the whole machine had none left, ${in_container} inside a container that reached its own limit"
  more "The last: \"${last_what:-?}\"${last_when:+, at ${last_when}}."
  if [ "${whole}" -gt 0 ]; then more "A machine without memory answers nobody for a while. What may use how much: the server's limit in the panel, and --memory of the runner and of the browser service."; fi
elif [ -n "${kernel_said}" ]; then
  row "No memory" "the kernel ended no program for lack of memory in the last 7 days"
fi

# ── Wings and Docker ─────────────────────────────────────────────────────────

head_line "Wings and Docker"
if [ -r "${WINGS_CONFIG}" ]; then
  row "Wings" "its configuration is at ${WINGS_CONFIG}"
elif [ -e "${WINGS_CONFIG}" ]; then
  row "Wings" "${WINGS_CONFIG} is there, and this user may not read it"
else
  row "Wings" "no configuration at ${WINGS_CONFIG}: is this the machine that runs Wings?"
fi
if have wings; then
  wings_says="$(wings --version 2> /dev/null | head -n 1 || true)"
  [ -z "${wings_says}" ] || more "${wings_says}"
fi
if have systemctl; then
  service="$(systemctl is-active wings 2> /dev/null || true)"
  [ -z "${service}" ] || more "service: ${service}"
fi
if have docker; then
  row "Docker" "version $(docker version --format '{{.Server.Version}}' 2> /dev/null || echo "unknown (it does not answer this user)")"
else
  row "Docker" "not installed"
fi

missing=""
for tool in curl awk sed find stat df du cp mv rm mkdir chown date flock sha256sum realpath mktemp; do
  have "${tool}" || missing="${missing} ${tool}"
done
if ! have unzip && ! have bsdtar && ! have python3; then missing="${missing} unzip"; fi
if [ -z "${missing}" ]; then row "Tools" "everything the upgrade needs is installed"; else row "Tools" "missing for the upgrade:${missing}"; fi

if have curl; then
  answer="$(curl -sI --max-time 20 "${RELEASES_URL}/latest" 2> /dev/null | tr -d '\r')"
  latest="$(printf '%s\n' "${answer}" | sed -n 's/^[Ll]ocation: .*\/tag\/\(.*\)$/\1/p' | head -n 1)"
  if [ -n "${latest}" ]; then
    row "Releases" "can be reached from here; the latest is ${latest}"
  elif [ -n "${answer}" ]; then
    row "Releases" "answered, without naming a latest release: $(printf '%s\n' "${answer}" | head -n 1)"
  else
    row "Releases" "cannot be reached from here (${RELEASES_URL}). The upgrade downloads from there."
  fi
fi

# ── The servers ──────────────────────────────────────────────────────────────

if [ -z "${VOLUMES}" ]; then
  VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
  [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
fi

head_line "Servers"
if [ ! -d "${VOLUMES}" ]; then
  row "Files" "${VOLUMES} does not exist, so no server's files are here"
  exit 0
fi
row "Files" "${VOLUMES} ($(human "$(free_kb "${VOLUMES}")") free)"
total=0
with_app=()
for folder in "${VOLUMES}"/*/; do
  [ -d "${folder}" ] || continue
  folder="${folder%/}"
  total=$((total + 1))
  if is_bundle "${folder}/xiero-nexus-ai"; then
    with_app+=("${folder##*/}")
    more "${folder##*/}  has version $(field version "${folder}/xiero-nexus-ai/VERSION") in xiero-nexus-ai/"
  elif is_bundle "${folder}"; then
    with_app+=("${folder##*/}")
    more "${folder##*/}  has version $(field version "${folder}/VERSION") at the top of its files"
  fi
done
row "Count" "${total} servers have files here; ${#with_app[@]} with a Xiero Nexus AI bundle"

if [ -z "${SERVER}" ]; then
  if [ "${#with_app[@]}" -eq 1 ]; then
    SERVER="${with_app[0]}"
  else
    head_line "No server was named (--server), so none is looked at more closely."
    exit 0
  fi
fi

# ── One server ───────────────────────────────────────────────────────────────

if ! [[ "${SERVER}" =~ ^[0-9a-fA-F-]{8,36}$ ]]; then
  head_line "\"${SERVER}\" is not a server ID. It is the UUID of the server, or its first 8 characters."
  exit 1
fi
SERVER="$(printf '%s' "${SERVER}" | tr 'A-F' 'a-f')"
matches=()
for folder in "${VOLUMES}/${SERVER}"*/; do
  [ -d "${folder}" ] && matches+=("$(basename "${folder%/}")")
done
if [ "${#matches[@]}" -ne 1 ]; then
  head_line "Server ${SERVER}"
  if [ "${#matches[@]}" -eq 0 ]; then
    row "Files" "there is no server with this ID in ${VOLUMES}"
  else
    row "Files" "this ID fits ${#matches[@]} servers; use the whole UUID"
  fi
  exit 1
fi
UUID="${matches[0]}"
VOLUME="${VOLUMES}/${UUID}"

head_line "Server ${UUID}"
row "Files" "${VOLUME} ($(human "$(size_kb "${VOLUME}")")), owned by $(stat -c '%U:%G (%u:%g)' "${VOLUME}" 2> /dev/null)"

names=()
for entry in "${VOLUME}"/* "${VOLUME}"/.[!.]* "${VOLUME}"/..?*; do
  [ -e "${entry}" ] || [ -L "${entry}" ] || continue
  if [ -d "${entry}" ] && [ ! -L "${entry}" ]; then names+=("${entry##*/}/"); else names+=("${entry##*/}"); fi
done
if [ "${#names[@]}" -eq 0 ]; then
  row "At the top" "nothing: the server has no files yet"
else
  shown="$(printf '%s  ' "${names[@]:0:40}")"
  row "At the top" "${shown%  }"
  if [ "${#names[@]}" -gt 40 ]; then more "and $((${#names[@]} - 40)) more"; fi
fi

APP_DIR=""
if is_bundle "${VOLUME}/xiero-nexus-ai"; then
  APP_DIR="${VOLUME}/xiero-nexus-ai"
elif is_bundle "${VOLUME}"; then
  APP_DIR="${VOLUME}"
else
  while IFS= read -r file; do
    if is_bundle "$(dirname "${file}")"; then
      APP_DIR="$(dirname "${file}")"
      break
    fi
  done < <(find "${VOLUME}" -maxdepth 3 -name VERSION -type f -not -path '*/node_modules/*' 2> /dev/null)
fi

if [ -n "${APP_DIR}" ]; then
  version_file="${APP_DIR}/VERSION"
  row "Bundle" "version $(field version "${version_file}"), commit $(field commit "${version_file}"), for Node.js $(field node "${version_file}")"
  more "in ${APP_DIR}, owned by $(stat -c '%U:%G (%u:%g)' "${APP_DIR}" 2> /dev/null)"
  if [ -f "${APP_DIR}/.env" ]; then
    set_names="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "${APP_DIR}/.env" 2> /dev/null | sort -u | tr '\n' ' ')"
    set_names="${set_names% }"
    row ".env" "sets: ${set_names:-nothing}"
  else
    row ".env" "missing: the app does not start without SECRET_ENCRYPTION_KEY"
  fi
  if [ -f "${APP_DIR}/data/nexus.db" ]; then
    row "Database" "data/nexus.db, $(human "$(size_kb "${APP_DIR}/data/nexus.db")")"
  else
    row "Database" "none at data/nexus.db (it is made at the first start, or DATABASE_PATH names another place)"
  fi
  if [ -d "${APP_DIR}/data/media" ]; then row "Media" "data/media, $(human "$(size_kb "${APP_DIR}/data/media")")"; fi
elif grep -qs '"name": *"xiero-nexus-ai"' "${VOLUME}/package.json" "${VOLUME}"/*/package.json 2> /dev/null; then
  row "Bundle" "none. The app is here as source code (a package.json of xiero-nexus-ai),"
  more "which the upgrade script does not replace. See RELEASING.md, \"Install a release\"."
  source_dir="$(dirname "$(grep -ls '"name": *"xiero-nexus-ai"' "${VOLUME}/package.json" "${VOLUME}"/*/package.json 2> /dev/null | head -n 1)")"
  source_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${source_dir}/package.json" 2> /dev/null | head -n 1)"
  row "Source" "version ${source_version:-unknown} in ${source_dir}"
  for name in .env data .next; do
    if [ -e "${source_dir}/${name}" ]; then
      more "${name} is there$([ -d "${source_dir}/${name}" ] && echo " ($(human "$(size_kb "${source_dir}/${name}")"))")"
    else
      more "${name} is not there"
    fi
  done
  if [ ! -e "${source_dir}/data" ] && [ ! -e "${source_dir}/.env" ]; then
    more "So it has not run here: there is no database and no key to keep."
  fi
else
  row "Bundle" "none: no folder here has the VERSION, start.js and server.js of a release bundle"
fi

if have docker; then
  image="$(docker inspect -f '{{.Config.Image}}' "${UUID}" 2> /dev/null || true)"
  if [ -z "${image}" ]; then
    row "Container" "none: the server has not been started since it was made, or Docker does not answer this user"
  else
    built="$(docker image inspect -f '{{.Created}}' "${image}" 2> /dev/null | cut -c 1-10 || true)"
    [ -z "${built}" ] || image="${image} (built ${built})"
    if [ "$(docker inspect -f '{{.State.Running}}' "${UUID}" 2> /dev/null || true)" = "true" ]; then
      row "Container" "running, image ${image}"
      inside="$(timeout 20 docker exec "${UUID}" sh -c 'printf "Node.js %s" "$(node -v 2> /dev/null || echo "not found")"; if command -v ffmpeg > /dev/null 2>&1; then printf ", ffmpeg installed"; else printf ", no ffmpeg"; fi; if [ -e /etc/alpine-release ]; then printf ", Alpine (the published bundles do not run on it)"; fi' 2> /dev/null || true)"
      [ -z "${inside}" ] || more "${inside}"
    else
      row "Container" "stopped, image ${image}"
    fi
    case "${image}" in
      *pterodactyl/yolks:nodejs_*) more "This image is built on Alpine, where the published bundles do not run. See RELEASING.md, \"On Pterodactyl\"." ;;
    esac
    # What the server runs when it starts, as the panel gave it to Wings for
    # this container. Of the settings the command names, those that look like
    # a secret are not shown; of all others, only that they exist.
    container_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UUID}" 2> /dev/null || true)"
    startup="$(printf '%s\n' "${container_env}" | sed -n 's/^STARTUP=//p' | head -n 1)"
    if [ -n "${startup}" ]; then
      row "Startup" "${startup}"
      named=" "
      for name in $(printf '%s\n' "${startup}" | grep -oE '\{\{[A-Za-z_][A-Za-z0-9_]*\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*' | tr -d '{}$' | sort -u); do
        printf '%s\n' "${container_env}" | grep -q "^${name}=" || continue
        named="${named}${name} "
        value="$(printf '%s\n' "${container_env}" | sed -n "s/^${name}=//p" | head -n 1)"
        case "${name}" in
          *TOKEN* | *PASS* | *SECRET* | *KEY* | *AUTH* | *CREDENTIAL*) [ -z "${value}" ] || value="(set, not shown)" ;;
        esac
        more "${name}=${value}"
      done
      others=""
      while IFS= read -r line; do
        name="${line%%=*}"
        case "${name}" in "" | STARTUP) continue ;; esac
        case "${named}" in *" ${name} "*) continue ;; esac
        others="${others}${name} "
      done <<< "${container_env}"
      [ -z "${others}" ] || more "also set, values not shown: ${others% }"
    fi
    if [ "${TRY_IMAGE}" = true ]; then
      # A container of its own, for a moment: no network, none of the server's
      # files, little memory, and gone afterwards. It says what the image
      # holds, and tries what the common Node.js egg does with a main file.
      tried="$(timeout 90 docker run --rm --pull never --network none --memory 512m --pids-limit 200 --entrypoint /bin/sh "${image%% *}" -c '
        echo "Node.js $(node -v 2> /dev/null || echo "not found"), npm $(npm -v 2> /dev/null || echo "not found")"
        if [ -e /etc/alpine-release ]; then echo "Alpine $(cat /etc/alpine-release)"; else echo "$(sed -n "s/^PRETTY_NAME=//p" /etc/os-release 2> /dev/null | tr -d \")"; fi
        if command -v ffmpeg > /dev/null 2>&1; then echo "$(ffmpeg -version 2> /dev/null | head -n 1 | cut -d " " -f 1-3)"; else echo "no ffmpeg"; fi
        if command -v ts-node > /dev/null 2>&1; then
          echo "ts-node $(ts-node --version 2>&1 | head -n 1), TypeScript $(tsc --version 2>&1 | head -n 1)"
          mkdir -p /tmp/try && cd /tmp/try && echo "console.log(\"a-main-file-ran\")" > index.js
          if ts-node --esm /tmp/try/index.js > out.txt 2>&1 && grep -q a-main-file-ran out.txt; then
            echo "ts-node --esm runs a JavaScript file"
          else
            echo "ts-node --esm does NOT run a JavaScript file: $(grep -m 1 -E "Error|error" out.txt | cut -c 1-160)"
          fi
        else
          echo "no ts-node"
        fi
        if node -e "process.exit(0)" 2> /dev/null; then echo "node runs a JavaScript file"; fi
      ' 2>&1 || true)"
      if [ -n "${tried}" ]; then
        row "Image" "$(printf '%s\n' "${tried}" | head -n 1)"
        printf '%s\n' "${tried}" | tail -n +2 | while IFS= read -r line; do more "${line}"; done
      else
        row "Image" "a container could not be started from it"
      fi
    fi
  fi
fi

if [ -d "${BACKUP_ROOT}/${UUID}" ]; then
  count="$(find "${BACKUP_ROOT}/${UUID}" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | wc -l | tr -d ' ')"
  row "Backups" "${count} of earlier upgrades in ${BACKUP_ROOT}/${UUID} ($(human "$(size_kb "${BACKUP_ROOT}/${UUID}")"))"
else
  row "Backups" "none yet in ${BACKUP_ROOT}"
fi
if [ -d "${BACKUP_ROOT}" ]; then backup_at="${BACKUP_ROOT}"; else backup_at="$(dirname "${BACKUP_ROOT}")"; fi
row "Room" "$(human "$(free_kb "${VOLUME}")") free for the server's files, $(human "$(free_kb "${backup_at}")") free for backups"

# ── The site ─────────────────────────────────────────────────────────────────

# What a request gets: the status, or why there was none.
ask() { # URL [curl options]
  local url="$1" said
  shift
  said="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" "${url}" 2>&1 | tr '\n' ' ')"
  case "${said}" in
    [0-9][0-9][0-9]\ | [0-9][0-9][0-9]) if [ "${said%% *}" = "000" ]; then echo "no answer"; else echo "HTTP ${said%% *}"; fi ;;
    *) echo "no answer: $(printf '%s' "${said}" | sed -e 's/^curl: ([0-9]*) //' -e 's/ *000 *$//' | cut -c 1-140)" ;;
  esac
}

# The port of this machine that leads to the server, and whether the app answers there.
PORTS=""
if have docker; then
  PORTS="$(docker inspect -f '{{range $port, $to := .NetworkSettings.Ports}}{{range $to}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "${UUID}" 2> /dev/null | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' || true)"
fi
if [ -n "${PORTS}" ]; then
  first="${PORTS%% *}"
  local_port="${first##*:}"
  row "Port" "this machine passes ${PORTS% } on to the server"
  if have curl; then more "the app at http://127.0.0.1:${local_port}/api/health: $(ask "http://127.0.0.1:${local_port}/api/health")"; fi
fi

# ── The browser agents work in ───────────────────────────────────────────────

# Where BROWSER_URL of the server's .env points, which container is there, and
# whether a browser service answers the server at it. The address holds the
# token of the service: it is read and used inside the server's container,
# where the app uses it, and is neither shown nor handed to a program here.
if [ -n "${APP_DIR}" ]; then
  browser_at=""
  if [ -f "${APP_DIR}/.env" ]; then
    browser_at="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?BROWSER_URL[[:space:]]*=[[:space:]]*[\"']?[A-Za-z]+:\/\/([^\/?#\"' ]*).*/\2/p" "${APP_DIR}/.env" 2> /dev/null | tail -n 1 | tr -d '\r')"
    # A user name in front of the host would be something that signs in.
    browser_at="${browser_at##*@}"
  fi
  if [ -z "${browser_at}" ]; then
    row "Browser" "none: .env names no browser service (BROWSER_URL), so agents have no browser to work in"
    more "The action \"browser\" sets one up next to the server (browser-service.sh)."
  else
    row "Browser" "BROWSER_URL in .env names ${browser_at}"
    browser_host="${browser_at%:*}"
    browser_container=""
    if have docker; then
      ids="$(docker ps -aq 2> /dev/null | tr '\n' ' ')"
      if [ -n "${ids}" ]; then
        # shellcheck disable=SC2086 # the identifiers, one word each
        browser_container="$(docker inspect -f '{{.Name}}{{range .NetworkSettings.Networks}} {{.IPAddress}}{{if .IPAMConfig}} {{.IPAMConfig.IPv4Address}}{{end}}{{end}}' ${ids} 2> /dev/null |
          awk -v want="${browser_host}" '{ name = substr($1, 2); if (name == want) { print name; exit } for (i = 2; i <= NF; i++) if ($i == want) { print name; exit } }')"
      fi
    fi
    if [ -n "${browser_container}" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "${browser_container}" 2> /dev/null || true)"
      line="container ${browser_container}: ${state:-unknown}"
      browser_image="$(docker inspect -f '{{.Config.Image}}' "${browser_container}" 2> /dev/null || true)"
      built="$(docker image inspect -f '{{.Created}}' "${browser_image}" 2> /dev/null | cut -c 1-10 || true)"
      if [ -n "${built}" ]; then
        line="${line}, image ${browser_image} (built ${built})"
        built_at="$(date -u -d "${built}" +%s 2> /dev/null || true)"
        if [ -n "${built_at}" ]; then
          days=$((($(date -u +%s) - built_at) / 86400))
          more "${line}"
          line=""
          if [ "${days}" -ge 30 ]; then
            more "Its Chromium is as old as the image, ${days} days: the action \"browser\" with --rebuild in options builds it anew from the newest packages."
          fi
        fi
      fi
      [ -z "${line}" ] || more "${line}"
      if [ "${state}" != "running" ]; then more "It does not run: the action \"browser\" starts it again."; fi
    elif have docker; then
      more "no container of this machine has that address: the service is somewhere else, or it was taken away"
    fi
    if have docker && [ "$(docker inspect -f '{{.State.Running}}' "${UUID}" 2> /dev/null || true)" = "true" ]; then
      # Asked from where the app asks: inside the server's container, with the
      # address as its .env has it. What comes back says how it went, and
      # nothing of the address.
      answer="$(timeout 40 docker exec -e "XN_ENV_FILE=/home/container${APP_DIR#"${VOLUME}"}/.env" "${UUID}" node -e '
        const fs = require("fs");
        (async () => {
          let raw = "";
          try {
            const lines = fs.readFileSync(process.env.XN_ENV_FILE, "utf8").split(/\r?\n/).filter((l) => /^\s*(export\s+)?BROWSER_URL\s*=/.test(l));
            raw = (lines.pop() || "").replace(/^\s*(export\s+)?BROWSER_URL\s*=\s*/, "").trim().replace(/^(["\x27])(.*)\1$/, "$2");
          } catch {
            return console.log("unread");
          }
          let url;
          try {
            url = new URL(raw);
          } catch {
            return console.log("unparsed");
          }
          if (!/^https?:$/.test(url.protocol)) return console.log("other");
          const ask = async (path, signedIn) => {
            const to = new URL(url.toString());
            to.pathname = url.pathname.replace(/\/+$/, "") + path;
            if (!signedIn) to.search = "";
            try {
              const res = await fetch(to, { signal: AbortSignal.timeout(8000) });
              return { status: res.status, body: (await res.text()).slice(0, 4000) };
            } catch (err) {
              const cause = err && err.cause;
              const why = err && /Timeout|Abort/.test(String(err.name)) ? "no answer in 8 s" : (cause && (cause.code || cause.message)) || (err && err.name) || "no answer";
              return { status: 0, body: String(why).replace(/[^\w -]/g, "").slice(0, 40) };
            }
          };
          const health = await ask("/healthz", false);
          console.log("health " + health.status + (health.status === 0 ? " " + health.body : ""));
          if (health.status === 0) return;
          const version = await ask("/json/version", true);
          let product = "";
          let egress = "unsaid";
          try {
            const body = JSON.parse(version.body);
            product = String(body.Browser || "").replace(/[^\w ./()-]/g, "").slice(0, 60);
            if (body.gate) egress = body.gate.egress === "filtered" ? "filtered" : "open";
          } catch {
            // Not what a browser service answers.
          }
          console.log("version " + version.status + " " + egress + " " + product);
        })();
      ' 2> /dev/null || true)"
      health="$(printf '%s\n' "${answer}" | sed -n 's/^health //p' | head -n 1)"
      version="$(printf '%s\n' "${answer}" | sed -n 's/^version //p' | head -n 1)"
      case "${answer}" in
        unread*) more "the server's container could not read its .env: not asked" ;;
        unparsed*) more "BROWSER_URL is not an address: the app has no browser" ;;
        other*) more "BROWSER_URL is a DevTools address (ws://), which is not asked here" ;;
        "") more "the server's container could not be asked (no Node.js in it, or it did not answer)" ;;
        *)
          case "${health}" in
            200) ;;
            0\ * | 0) more "the server's container does NOT reach it (${health#0 }): agents have no browser until it does" ;;
            503) more "the service answers the server's container, and its Chromium is not running (HTTP 503)" ;;
            *) more "what answers the server's container there is not a browser service (HTTP ${health})" ;;
          esac
          if [ "${health}" = "200" ] || [ "${health}" = "503" ]; then
            code="${version%% *}"
            rest="${version#* }"
            egress="${rest%% *}"
            product="${rest#* }"
            [ "${product}" != "${rest}" ] || product=""
            case "${code}" in
              200)
                more "the server's container reaches it, and it takes the token of .env${product:+: ${product}}"
                case "${egress}" in
                  filtered) more "it keeps pages from private networks" ;;
                  *) more "it does not say that it keeps pages from private networks: it is not the service of this repository" ;;
                esac
                ;;
              401 | 403) more "the server's container reaches it, and it does NOT take the token of .env: the action \"browser\" writes the one it has" ;;
              *) more "the server's container reaches it, and it did not say what it is (HTTP ${code:-none})" ;;
            esac
          fi
          ;;
      esac
    elif have docker; then
      more "The server is not running: whether it reaches the service is seen when it runs."
    fi
  fi
fi

if [ -n "${SITE}" ] && have curl; then
  site_host="${SITE#*://}"
  site_host="${site_host%%[:/]*}"
  head_line "The site ${SITE}"
  leads_to="$(getent ahosts "${site_host}" 2> /dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
  own="$( (hostname -I 2> /dev/null || true) | tr ' ' '\n' | grep -v '^$')"
  if [ -z "${leads_to}" ]; then
    row "Name" "${site_host} does not lead anywhere (no DNS record that this machine can see)"
  else
    here_too="not an address of this machine: something else stands in front, or the name leads elsewhere"
    for address in ${leads_to}; do
      if printf '%s\n' "${own}" | grep -qxF "${address}"; then here_too="an address of this machine"; fi
    done
    row "Name" "${site_host} leads to ${leads_to% }, ${here_too}"
  fi
  if have ss; then
    for port in 80 443; do
      who="$(ss -ltnpH "sport = :${port}" 2> /dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ')"
      if [ -n "${who}" ]; then row "Port ${port}" "${who% } listens"; else row "Port ${port}" "nothing listens"; fi
    done
  fi
  named=""
  for folder in /etc/nginx /etc/apache2 /etc/httpd /etc/caddy; do
    [ -d "${folder}" ] || continue
    while IFS= read -r file; do
      named="${named}${file} "
      row "Web server" "${file} names ${site_host}"
      grep -E '^[[:space:]]*(proxy_pass|reverse_proxy|ProxyPass|listen|root)[[:space:]]' "${file}" 2> /dev/null | sed 's/^[[:space:]]*//' | sort -u | head -n 8 | while IFS= read -r line; do more "${line}"; done
    done < <(grep -rlsF -- "${site_host}" "${folder}" 2> /dev/null | head -n 5)
  done
  [ -n "${named}" ] || row "Web server" "no configuration of nginx, Apache or Caddy on this machine names ${site_host}"
  row "Asked" "${SITE}/api/health: $(ask "${SITE}/api/health")"
  case "${SITE}" in
    https://*)
      more "http://${site_host}/api/health: $(ask "http://${site_host}/api/health")"
      if have openssl; then
        cert_names="$(echo | timeout 10 openssl s_client -connect "${site_host}:443" -servername "${site_host}" 2> /dev/null | openssl x509 -noout -ext subjectAltName 2> /dev/null | grep -o 'DNS:[^,]*' | sed 's/DNS://' | head -n 6 | tr '\n' ' ')"
        if [ -n "${cert_names}" ]; then more "the certificate shown for it is for: ${cert_names% }"; fi
      fi
      ;;
  esac
fi
exit 0
