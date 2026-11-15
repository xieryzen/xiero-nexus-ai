#!/usr/bin/env bash
# Put Xiero Nexus AI on a Pterodactyl server that does not have it yet, from
# the machine that runs Wings, as root:
#
#   sudo bash pterodactyl-install.sh --server <server id> --app-url https://site.example.com --dry-run
#   sudo bash pterodactyl-install.sh --server <server id> --app-url https://site.example.com
#
# What it does, in this order:
#
#   1. finds the server's files and sees that there is no release bundle yet
#      (a server that has one is upgraded with pterodactyl-upgrade.sh),
#   2. downloads the bundle for the Node.js of the server's image and checks
#      it against the release's SHA-256 list,
#   3. shows what it is going to do and asks,
#   4. with --move-aside: moves a checkout of the app's source code that never
#      ran, when that is what the server holds, into one folder of the server,
#   5. unpacks the bundle into xiero-nexus-ai/ and writes its .env: a new
#      SECRET_ENCRYPTION_KEY, a password for the first administrator, and the
#      site's address,
#   6. when the server's startup command runs a file that is not there (the
#      common Node.js egg runs index.js), writes that file: a few lines that
#      start the bundle with plain Node.js,
#   7. gives the new files to the user that owns the server's files,
#   8. starts the server and waits until the app answers. This is done by
#      pterodactyl-upgrade.sh --start, when that script is next to this one.
#
# The server has to be stopped. Nothing is deleted, and nothing that is there
# is overwritten. The key and the password are written to .env and nowhere
# else: this script does not print them.
#
# Options: --help.
set -euo pipefail
umask 022

REPO="${XIERO_REPO:-xieryzen/xiero-nexus-ai}"
RELEASES_URL="${XIERO_RELEASES_URL:-https://github.com/${REPO}/releases}"
FOLDER="xiero-nexus-ai"

SERVER=""
VERSION="latest"
ZIP=""
NODE_MAJOR=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
MOVE_ASIDE=false
LAUNCHER=""
NO_LAUNCHER=false
START=true
DRY_RUN=false
YES=false
HEALTH_TIMEOUT=""
CHECK_URL=""
BACKUP_ROOT=""
SETTINGS=()

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat << 'EOF'
Install Xiero Nexus AI on a Pterodactyl server that does not have it yet. Run as
root on the machine that runs Wings, with the server stopped.

  sudo bash pterodactyl-install.sh --server <server id> [options]

  --server <id>        The server: its UUID, or the first 8 characters of it (the
                       short ID in the panel address).
  --app-url <url>      The public address of the site (APP_URL in .env).
  --set KEY=VALUE      Another line for .env (can be repeated).
  --version <v>        What to install: "latest" (default) or a version such as 1.5.0.
  --zip <file>         Install this bundle instead of downloading one.
  --node <20|22>       The Node.js of the server's image, when it cannot be found out.
  --move-aside         When the server holds a checkout of the app's source code
                       that never ran: move all of it into one folder of the
                       server, source-checkout-<date>/, so that the egg does
                       not install and update it at every start any more.
  --launcher <file>    Write the file that starts the bundle under this name in
                       the server's files, instead of the name the server's
                       startup command runs.
  --no-launcher        Do not write such a file.
  --no-start           Do not start the server afterwards.
  --dry-run            Show the plan and stop.
  --yes                Do not ask before starting.

  --volumes <dir>      Where Wings keeps server files (default: from the Wings
                       configuration, else /var/lib/pterodactyl/volumes).
  --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
  --check-url <url>    Where the app answers on this machine, when that cannot be
                       found out (for example http://127.0.0.1:25565).
  --health-timeout <s> Seconds to wait for the app to answer (default 120).
  --backup-dir <dir>   Where pterodactyl-upgrade.sh keeps its backups, for when
                       it starts the server (default /root/xiero-nexus-backups).

Environment:
  XIERO_REPO           The GitHub repository whose releases are downloaded
                       (default xieryzen/xiero-nexus-ai).
EOF
}
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$@"; SERVER="$2"; shift 2 ;;
    --app-url) need_value "$@"; SETTINGS+=("APP_URL=${2%/}"); shift 2 ;;
    --set) need_value "$@"; SETTINGS+=("$2"); shift 2 ;;
    --version) need_value "$@"; VERSION="${2#v}"; shift 2 ;;
    --zip) need_value "$@"; ZIP="$2"; shift 2 ;;
    --node) need_value "$@"; NODE_MAJOR="$2"; shift 2 ;;
    --move-aside) MOVE_ASIDE=true; shift ;;
    --launcher) need_value "$@"; LAUNCHER="$2"; shift 2 ;;
    --no-launcher) NO_LAUNCHER=true; shift ;;
    --no-start) START=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) YES=true; shift ;;
    --volumes) need_value "$@"; VOLUMES="$2"; shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; shift 2 ;;
    --check-url) need_value "$@"; CHECK_URL="${2%/}"; shift 2 ;;
    --health-timeout) need_value "$@"; HEALTH_TIMEOUT="$2"; shift 2 ;;
    --backup-dir) need_value "$@"; BACKUP_ROOT="$2"; shift 2 ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option: $1. See --help." ;;
  esac
done

[ -n "${SERVER}" ] || die "name the server with --server: its UUID or the first 8 characters."
case "${NODE_MAJOR}" in "" | 20 | 22) ;; *) die "--node is 20 or 22: the Node.js versions bundles are published for." ;; esac
case "${HEALTH_TIMEOUT}" in *[!0-9]*) die "--health-timeout is whole seconds." ;; esac
if [ -n "${LAUNCHER}" ] && [ "${NO_LAUNCHER}" = true ]; then die "--launcher and --no-launcher do not go together."; fi

SET_NAMES=" "
for setting in ${SETTINGS[@]+"${SETTINGS[@]}"}; do
  key="${setting%%=*}"
  value="${setting#*=}"
  case "${setting}" in *=*) ;; *) die "--set needs KEY=VALUE, not \"${setting}\"." ;; esac
  [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "--set: \"${key}\" is not a setting name (capital letters, digits and _)."
  case "${value}" in *$'\n'* | *\"* | *\'* | *\\*) die "--set ${key}: quotes, backslashes and line breaks are not supported." ;; esac
  SET_NAMES="${SET_NAMES}${key} "
done

for tool in curl awk sed find stat df du cp mv rm mkdir chown chmod date sha256sum realpath mktemp head tr base64; do
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

# ── Small helpers ────────────────────────────────────────────────────────────

version_field() { sed -n "s/^$1=//p" "$2" 2> /dev/null | head -n 1 | tr -d '\r'; }
human() { # kilobytes, readable
  awk -v kb="${1:-0}" 'BEGIN {
    if (kb >= 1048576) printf "%.1f GB", kb / 1048576
    else if (kb >= 1024) printf "%.0f MB", kb / 1024
    else printf "%d KB", kb
  }'
}
size_kb() { du -sk "$1" 2> /dev/null | awk '{ print $1 }'; }
free_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }
is_bundle() { [ -f "$1/VERSION" ] && [ ! -L "$1/VERSION" ] && [ -f "$1/start.js" ] && [ -f "$1/server.js" ] && grep -q '^version=' "$1/VERSION"; }
names_in() { # the names in a folder, one a line, hidden ones too
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "${entry}" ] || [ -L "${entry}" ]; then printf '%s\n' "${entry##*/}"; fi
  done
}
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
# Set KEY=VALUE in an env file: replaces the line that sets it now, or adds one.
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
random_letters() { # COUNT: letters and digits that nobody can guess
  local out=""
  while [ "${#out}" -lt "$1" ]; do
    out="${out}$(head -c 64 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:$1}"
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

WORK="$(mktemp -d)"
PHASE="start"
STAGING=""
ASIDE=""
PLACED=false
WROTE_LAUNCHER=""

# Stopped in the middle: put everything back where it was.
# shellcheck disable=SC2329  # called by the trap below
on_exit() {
  local code=$? name
  trap - EXIT
  set +e
  if [ "${PHASE}" = "placing" ]; then
    say ""
    say "Stopped before the installation was complete. Putting things back..."
    if [ -n "${WROTE_LAUNCHER}" ]; then rm -f "${WROTE_LAUNCHER}"; fi
    if [ "${PLACED}" = true ]; then rm -rf "${VOLUME:?}/${FOLDER}"; fi
    if [ -n "${ASIDE}" ] && [ -d "${ASIDE}" ]; then
      while IFS= read -r name; do
        [ -e "${VOLUME}/${name}" ] || mv "${ASIDE}/${name}" "${VOLUME}/${name}"
      done < <(names_in "${ASIDE}")
      rmdir "${ASIDE}" 2> /dev/null
    fi
    say "The server's files are as they were."
  fi
  if [ -n "${STAGING}" ]; then rm -rf "${STAGING}"; fi
  rm -rf "${WORK}"
  exit "${code}"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── The server and what it holds ─────────────────────────────────────────────

if [ "$(id -u)" != "0" ]; then
  warn "not running as root: this only works where you may write the server's files yourself."
fi

if [ -z "${VOLUMES}" ]; then
  VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
  [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
fi
[ -d "${VOLUMES}" ] || die "${VOLUMES} does not exist. Is this the machine that runs Wings? Name the folder of the server files with --volumes."
VOLUMES="$(realpath "${VOLUMES}")"

[[ "${SERVER}" =~ ^[0-9a-fA-F-]{8,36}$ ]] || die "\"${SERVER}\" is not a server ID. Use the UUID of the server, or its first 8 characters."
SERVER="$(printf '%s' "${SERVER}" | tr 'A-F' 'a-f')"
matches=()
for folder in "${VOLUMES}/${SERVER}"*/; do
  [ -d "${folder}" ] && matches+=("$(basename "${folder%/}")")
done
case "${#matches[@]}" in
  0) die "there is no server \"${SERVER}\" in ${VOLUMES}. A server gets its folder when it is installed in the panel." ;;
  1) UUID="${matches[0]}" ;;
  *) die "\"${SERVER}\" fits more than one server. Use the whole UUID." ;;
esac
VOLUME="${VOLUMES}/${UUID}"
[ -d "${VOLUME}" ] && [ ! -L "${VOLUME}" ] || die "${VOLUME} is not a folder."
OWNER="$(stat -c '%u:%g' "${VOLUME}")"
APP_DIR="${VOLUME}/${FOLDER}"

# A bundle that is there already is for the upgrade script.
found=""
if is_bundle "${APP_DIR}"; then
  found="${APP_DIR}"
elif is_bundle "${VOLUME}"; then
  found="${VOLUME}"
else
  while IFS= read -r file; do
    if is_bundle "$(dirname "${file}")"; then
      found="$(dirname "${file}")"
      break
    fi
  done < <(find "${VOLUME}" -maxdepth 3 -name VERSION -type f -not -path '*/node_modules/*' 2> /dev/null)
fi
if [ -n "${found}" ]; then
  die "this server already has version $(version_field version "${found}/VERSION") in ${found}. Upgrade it with pterodactyl-upgrade.sh --server ${UUID}. Nothing was changed."
fi
if [ -e "${APP_DIR}" ] || [ -L "${APP_DIR}" ]; then
  die "${APP_DIR} exists and is not a release bundle. Look at what it is, and move it away, before installing. Nothing was changed."
fi

# The app as source code at the top of the server's files: what the common
# Node.js egg leaves there when it is given the repository's address.
SOURCE=false
if grep -qs '"name": *"xiero-nexus-ai"' "${VOLUME}/package.json"; then
  SOURCE=true
  SOURCE_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${VOLUME}/package.json" | head -n 1)"
  if [ -e "${VOLUME}/.env" ] || [ -e "${VOLUME}/data" ]; then
    die "this server has run the app from its source code: there is a .env or a data/ at the top of its files. Their key and database would have to move into the bundle, which this script does not do. Nothing was changed."
  fi
fi
if [ "${MOVE_ASIDE}" = true ] && [ "${SOURCE}" != true ]; then
  die "--move-aside is for a server that holds a checkout of this app's source code, and this one does not. Nothing was changed."
fi
# Node.js reads the nearest package.json above a .js file to tell which kind
# of module it is. The bundle's files are CommonJS and bring no package.json.
if [ "${MOVE_ASIDE}" != true ] && grep -qs '"type"[[:space:]]*:[[:space:]]*"module"' "${VOLUME}/package.json"; then
  die "the package.json at the top of this server's files says \"type\": \"module\". Every .js file below it is then read as an ES module, the bundle's too, and the bundle does not start. Install on a server without it. Nothing was changed."
fi
mapfile -t TOP_NAMES < <(names_in "${VOLUME}")

# What the server's container was given the last time: the Node.js of the
# image, and the command it starts with.
DOCKER=false
if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then DOCKER=true; fi
CONTAINER_ENV=""
IMAGE=""
if [ "${DOCKER}" = true ]; then
  if [ "$(docker inspect -f '{{.State.Running}}' "${UUID}" 2> /dev/null || true)" = "true" ]; then
    die "the server is running. Stop it in the panel, then run this again. Nothing was changed."
  fi
  IMAGE="$(docker inspect -f '{{.Config.Image}}' "${UUID}" 2> /dev/null || true)"
  CONTAINER_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UUID}" 2> /dev/null || true)"
fi
container_setting() { printf '%s\n' "${CONTAINER_ENV}" | sed -n "s/^$1=//p" | head -n 1; }

if [ -z "${NODE_MAJOR}" ]; then
  NODE_MAJOR="$(container_setting NODE_VERSION | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')"
  [ -n "${NODE_MAJOR}" ] || NODE_MAJOR="$(printf '%s' "${IMAGE}" | sed -n 's/.*nodejs_\([0-9]*\).*/\1/p')"
  [ -n "${NODE_MAJOR}" ] || die "the Node.js version of this server's image cannot be found out (it has not been started yet). Name it with --node 20 or --node 22."
fi
case "${NODE_MAJOR}" in
  20 | 22) ;;
  *) die "this server's image has Node.js ${NODE_MAJOR}. Bundles are published for Node.js 20 and 22: choose such an image in the panel (Startup), or name the version with --node." ;;
esac
case "${IMAGE}" in
  *pterodactyl/yolks:nodejs_*) die "this server's image (${IMAGE}) is built on Alpine, where the published bundles do not run. Choose an image built on Debian in the panel, such as ghcr.io/ptero-eggs/yolks:nodejs_${NODE_MAJOR}. See RELEASING.md, \"On Pterodactyl\"." ;;
esac

# The file the server's startup command runs.
STARTUP="$(container_setting STARTUP)"
MAIN_FILE=""
case "${STARTUP}" in *MAIN_FILE*) MAIN_FILE="$(container_setting MAIN_FILE)" ;; esac
LAUNCHER_NOTE=""
if [ "${NO_LAUNCHER}" = true ]; then
  LAUNCHER=""
elif [ -z "${LAUNCHER}" ]; then
  case "${MAIN_FILE}" in
    "") LAUNCHER_NOTE="what the server runs when it starts is not known here. Set its startup file to ${FOLDER}/start.js in the panel (Startup), or name a file with --launcher." ;;
    "${FOLDER}/start.js") ;;
    *) LAUNCHER="${MAIN_FILE}" ;;
  esac
fi
if [ -n "${LAUNCHER}" ]; then
  case "${LAUNCHER}" in
    /* | *..* | *$'\n'*) die "\"${LAUNCHER}\" is not a file inside the server's files." ;;
    "${FOLDER}"/*) die "the launcher cannot be inside ${FOLDER}/, which is the bundle's own folder." ;;
    *.js | *.cjs | *.mjs) ;;
    *) die "the server starts \"${LAUNCHER}\", which is not a JavaScript file. Set its startup file to ${FOLDER}/start.js in the panel (Startup), and run this with --no-launcher." ;;
  esac
  # After the move, nothing of the old top is in the way any more.
  if [ "${MOVE_ASIDE}" != true ] && { [ -e "${VOLUME}/${LAUNCHER}" ] || [ -L "${VOLUME}/${LAUNCHER}" ]; }; then
    LAUNCHER_NOTE="the server starts ${LAUNCHER}, and a file of that name is there already. It is left alone. Set the startup file to ${FOLDER}/start.js in the panel (Startup) for the server to start the app."
    LAUNCHER=""
  fi
fi

# ── The bundle ───────────────────────────────────────────────────────────────

ASSET="xiero-nexus-ai-linux-x64-node${NODE_MAJOR}.zip"
step "Getting the bundle"
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
NEW="${WORK}/new/${FOLDER}"
is_bundle "${NEW}" || die "that file is not a Xiero Nexus AI bundle (no ${FOLDER}/ with VERSION, start.js and server.js in it)."
NEW_VERSION="$(version_field version "${NEW}/VERSION")"
NEW_COMMIT="$(version_field commit "${NEW}/VERSION")"
NEW_NODE="$(version_field node "${NEW}/VERSION")"
[ "${NEW_NODE}" = "${NODE_MAJOR}" ] || die "that bundle is for Node.js ${NEW_NODE}, but this server's image has Node.js ${NODE_MAJOR}."
for name in .env data; do
  [ ! -e "${NEW}/${name}" ] || die "that bundle contains ${name}, which a bundle never does. Not installing it."
done
[ -f "${NEW}/.env.example" ] || die "that bundle has no .env.example to start the settings from. Not installing it."

# ── The plan ─────────────────────────────────────────────────────────────────

STAMP="$(date +%Y%m%d-%H%M%S)"
ASIDE_NAME="source-checkout-${STAMP}"
new_kb="$(size_kb "${NEW}")"

step "The plan"
say "  Server      ${UUID}"
say "  Files       ${VOLUME}, owned by $(stat -c '%U:%G' "${VOLUME}")"
say "  Image       ${IMAGE:-unknown (the server has not been started yet)}, Node.js ${NODE_MAJOR}"
say "  Install     version ${NEW_VERSION}${NEW_COMMIT:+ (${NEW_COMMIT})} into ${APP_DIR} ($(human "${new_kb}"))"
say "  Settings    ${APP_DIR}/.env is written: a new SECRET_ENCRYPTION_KEY$(case "${SET_NAMES}" in *" BOOTSTRAP_ADMIN_PASSWORD "*) ;; *) printf ', a password for the first administrator' ;; esac)"
for setting in ${SETTINGS[@]+"${SETTINGS[@]}"}; do
  case "${setting%%=*}" in
    *PASSWORD* | *SECRET* | *KEY* | *TOKEN*) say "              ${setting%%=*}=(not shown)" ;;
    *) say "              ${setting}" ;;
  esac
done
if [ "${SOURCE}" = true ]; then
  if [ "${MOVE_ASIDE}" = true ]; then
    say "  Move aside  the source code of version ${SOURCE_VERSION:-unknown} that is at the top of the server's files"
    say "              (${#TOP_NAMES[@]} entries, $(human "$(size_kb "${VOLUME}")")) goes into ${VOLUME}/${ASIDE_NAME}/."
    say "              It never ran here: there is no .env and no data/. Nothing is deleted."
  else
    say "  Source      the source code of version ${SOURCE_VERSION:-unknown} is at the top of the server's files and stays there."
    say "              It never ran here. An egg that finds package.json and .git there installs and updates it"
    say "              at every start, which takes long and does nothing for the bundle. --move-aside puts it in a folder."
  fi
elif [ "${#TOP_NAMES[@]}" -gt 0 ]; then
  say "  Other files ${#TOP_NAMES[@]} entries at the top of the server's files stay as they are."
fi
if [ -n "${LAUNCHER}" ]; then
  say "  Start file  ${VOLUME}/${LAUNCHER} is written: the server's startup command runs that file,"
  say "              and it starts ${FOLDER}/start.js with plain Node.js."
elif [ -n "${LAUNCHER_NOTE}" ]; then
  say "  Start file  none is written: ${LAUNCHER_NOTE}"
else
  say "  Start file  the server's startup command runs ${FOLDER}/start.js already."
fi
case "${STARTUP}" in
  *ts-node*) say "              (That command starts its file through ts-node. The bundle is started in a process of its own, with plain Node.js.)" ;;
esac
if [ "${START}" = true ]; then
  if [ -f "$(dirname "$0")/pterodactyl-upgrade.sh" ]; then
    say "  Afterwards  the server is started through Wings, and the app is waited for."
  else
    say "  Afterwards  start the server in the panel (pterodactyl-upgrade.sh is not next to this script to do it)."
  fi
else
  say "  Afterwards  the server is left stopped."
fi

need_kb=$((new_kb + new_kb / 5 + 10240))
[ "$(free_kb "${VOLUME}")" -ge "${need_kb}" ] \
  || die "not enough free space in ${VOLUME} ($(human "${need_kb}") needed, $(human "$(free_kb "${VOLUME}")") free)."

if [ "${DRY_RUN}" = true ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi
say ""
confirm "Install on this server now?" || die "stopped; nothing was changed."

# ── Putting it there ─────────────────────────────────────────────────────────

step "Installing"
STAGING="$(mktemp -d "${VOLUME}/.xiero-install-XXXXXX")"
cp -a "${NEW}" "${STAGING}/${FOLDER}"

# The settings. What must stay secret goes from the generator into the file.
ENV_FILE="${STAGING}/${FOLDER}/.env"
(umask 077 && cp "${STAGING}/${FOLDER}/.env.example" "${ENV_FILE}")
chmod 600 "${ENV_FILE}"
env_set "${ENV_FILE}" SECRET_ENCRYPTION_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
case "${SET_NAMES}" in
  *" BOOTSTRAP_ADMIN_PASSWORD "*) ;;
  *) env_set "${ENV_FILE}" BOOTSTRAP_ADMIN_PASSWORD "$(random_letters 24)" ;;
esac
for setting in ${SETTINGS[@]+"${SETTINGS[@]}"}; do
  env_set "${ENV_FILE}" "${setting%%=*}" "${setting#*=}"
done
chown -hR "${OWNER}" "${STAGING}" 2> /dev/null || warn "the new files could not be given to the server's user (${OWNER})."
say "Version ${NEW_VERSION} is unpacked, with its settings."

PHASE="placing"
if [ "${MOVE_ASIDE}" = true ]; then
  ASIDE="${VOLUME}/${ASIDE_NAME}"
  mkdir "${ASIDE}"
  chown "${OWNER}" "${ASIDE}" 2> /dev/null || true
  for name in "${TOP_NAMES[@]}"; do
    mv "${VOLUME}/${name}" "${ASIDE}/${name}"
  done
  say "What was at the top of the server's files is in ${ASIDE_NAME}/."
fi
mv "${STAGING}/${FOLDER}" "${APP_DIR}"
PLACED=true
rmdir "${STAGING}"
STAGING=""

if [ -n "${LAUNCHER}" ]; then
  target="${VOLUME}/${LAUNCHER}"
  if [ -e "${target}" ] || [ -L "${target}" ]; then die "${target} appeared meanwhile. Not overwriting it."; fi
  mkdir -p "$(dirname "${target}")"
  cat > "${target}" << 'EOF'
// Starts Xiero Nexus AI from its release bundle, xiero-nexus-ai/start.js.
//
// Written by scripts/host/pterodactyl-install.sh, because this server's
// startup command runs this file. The bundle is started with plain Node.js in
// a process of its own, whatever this file itself was started with: the common
// Node.js egg runs its main file through ts-node, which the bundle has no use
// for. When the server is told to stop, the bundle is told once, and this
// waits for it to end.
//
// It works as a CommonJS file and as an ES module. To do without it, set the
// server's startup file to xiero-nexus-ai/start.js.
(async () => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const here = typeof __dirname === "string" ? __dirname : path.dirname(path.resolve(process.argv[1]));
  const entry = path.join(here, "xiero-nexus-ai", "start.js");

  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("TS_NODE_")) delete env[name];

  // In a process group of its own: a signal that is sent to every process of
  // the container at once then reaches the bundle through here only, once.
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit", env, detached: true });
  let told = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (told) return;
      told = true;
      try {
        child.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
      } catch {
        // It has ended already.
      }
    });
  }
  child.on("error", (err) => {
    console.error(`[xiero-nexus] Cannot start ${entry}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
})();
EOF
  chown "${OWNER}" "${target}" 2> /dev/null || true
  WROTE_LAUNCHER="${target}"
  say "${LAUNCHER} starts the bundle."
fi
PHASE="done"

step "Installed"
say "Version ${NEW_VERSION} is in ${APP_DIR}."
say ""
say "The first administrator signs in as \"admin\". The password is in"
say "  ${APP_DIR}/.env, in the line BOOTSTRAP_ADMIN_PASSWORD"
say "(in the panel: Files, ${FOLDER}, .env). Change it after signing in. It is used once,"
say "to make that account, and can be taken out of the file afterwards."
say "Keep SECRET_ENCRYPTION_KEY of the same file: stored provider keys cannot be read without it."
if [ -n "${ASIDE}" ]; then
  say ""
  say "The source code that was at the top of the server's files is in ${ASIDE} ($(human "$(size_kb "${ASIDE}")"))."
  say "Nothing uses it any more. It can be deleted in the panel's file manager."
fi
[ -z "${LAUNCHER_NOTE}" ] || warn "${LAUNCHER_NOTE}"
say ""
say "To upgrade later:  sudo bash pterodactyl-upgrade.sh --server ${UUID}"

# ── Starting it ──────────────────────────────────────────────────────────────

if [ "${START}" != true ]; then
  say "The server is left stopped."
  exit 0
fi
upgrade="$(dirname "$0")/pterodactyl-upgrade.sh"
if [ ! -f "${upgrade}" ]; then
  say "Start the server in the panel now."
  exit 0
fi
start_options=(--server "${UUID}" --start --yes --volumes "${VOLUMES}" --wings-config "${WINGS_CONFIG}")
[ -z "${CHECK_URL}" ] || start_options+=(--check-url "${CHECK_URL}")
[ -z "${HEALTH_TIMEOUT}" ] || start_options+=(--health-timeout "${HEALTH_TIMEOUT}")
[ -z "${BACKUP_ROOT}" ] || start_options+=(--backup-dir "${BACKUP_ROOT}")
result=0
bash "${upgrade}" "${start_options[@]}" || result=$?
if [ "${result}" != "0" ]; then
  say ""
  say "The app is installed, but the server did not come up. What was installed stays in place."
  say "When the cause is found, start the server in the panel, or run:"
  say "  sudo bash pterodactyl-upgrade.sh --server ${UUID} --start"
  exit 1
fi
