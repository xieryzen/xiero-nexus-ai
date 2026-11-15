#!/usr/bin/env bash
# What is on this Pterodactyl node, for someone who is about to upgrade a
# server on it from somewhere else (over-ssh.sh check). It only reads.
#
#   sudo bash node-check.sh [--server <server id>]
#
# It says what the machine runs, whether Wings and Docker are there, whether
# the releases on GitHub can be reached from here, which servers hold a Xiero
# Nexus AI bundle, and for one server what is in its files, which image it
# runs in and how much room is left. Of .env it shows which names are set and
# no value; it shows no token and no file's content.
#
#   --server <id>        The server to look at: its UUID or the first 8
#                        characters. Without it: the one server that has the app.
#   --volumes <dir>      Where Wings keeps server files (default: from the Wings
#                        configuration, else /var/lib/pterodactyl/volumes).
#   --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
#   --backup-dir <dir>   Where the upgrade keeps its backups (default /root/xiero-nexus-backups).
set -uo pipefail

REPO="${XIERO_REPO:-xieryzen/xiero-nexus-ai}"
RELEASES_URL="${XIERO_RELEASES_URL:-https://github.com/${REPO}/releases}"
SERVER=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
BACKUP_ROOT="/root/xiero-nexus-backups"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --volumes) VOLUMES="${2:-}"; shift 2 ;;
    --wings-config) WINGS_CONFIG="${2:-}"; shift 2 ;;
    --backup-dir) BACKUP_ROOT="${2:-}"; shift 2 ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
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

# ── Wings and Docker ─────────────────────────────────────────────────────────

head_line "Wings and Docker"
if [ -r "${WINGS_CONFIG}" ]; then
  row "Wings" "its configuration is at ${WINGS_CONFIG}"
elif [ -e "${WINGS_CONFIG}" ]; then
  row "Wings" "${WINGS_CONFIG} is there, and this user may not read it"
else
  row "Wings" "no configuration at ${WINGS_CONFIG}: is this the machine that runs Wings?"
fi
if have wings; then more "$(wings --version 2> /dev/null | head -n 1 || true)"; fi
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
row "Files" "${VOLUME} ($(human "$(size_kb "${VOLUME}")"))"

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
    row ".env" "sets: ${set_names:+${set_names% }}${set_names:-nothing}"
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
else
  row "Bundle" "none: no folder here has the VERSION, start.js and server.js of a release bundle"
fi

if have docker; then
  image="$(docker inspect -f '{{.Config.Image}}' "${UUID}" 2> /dev/null || true)"
  if [ -z "${image}" ]; then
    row "Container" "none: the server has not been started since it was made, or Docker does not answer this user"
  else
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
exit 0
