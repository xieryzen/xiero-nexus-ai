#!/usr/bin/env bash
# The browser agents work in, on a Pterodactyl node: run as root on the
# machine that runs Wings.
#
#   sudo bash browser-service.sh --server <server id>
#
# Xiero Nexus AI drives a Chromium that runs apart from it (browser/README.md).
# This script sets that up next to a Pterodactyl server, in this order:
#
#   1. finds the server and the Docker network its container is on,
#   2. shows what it is going to do and asks,
#   3. builds the image of the browser service (browser/Dockerfile: Debian's
#      Chromium behind the gate), on this machine,
#   4. starts it as a container on the server's network, at an address of its
#      own that stays the same, with a limit on memory and nothing published
#      to the outside,
#   5. checks that it runs, that it takes its token, and that the server's
#      container reaches it,
#   6. writes BROWSER_URL into the server's .env and starts the server again
#      (pterodactyl-upgrade.sh does that part: with a backup, and back to how
#      it was when the app does not come up).
#
# The token that lets the app in is made here and kept in a folder only root
# reads. It is never printed.
#
# Run it with --dry-run first to see the plan without changing anything.
# Run it again to rebuild the image (--rebuild gets a newer Chromium) or
# after a change of the limits; --remove takes the service away again.
#
# Options: --help.
set -euo pipefail
umask 077

SERVER=""
VERSION=""
NAME="xiero-browser"
IMAGE="xiero-browser"
PORT="9223"
MEMORY="1g"
CPUS="1.5"
ALLOW_PRIVATE=""
NETWORK_OPTION=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
VOLUMES=""
STATE_ROOT="/root/xiero-nexus-browser"
DRY_RUN=false
YES=false
REMOVE=false
REBUILD=false
CONTAINER_ONLY=false
UPGRADE_OPTIONS=()

usage() {
  cat << 'EOF'
Set up the browser agents work in, next to a Pterodactyl server. Run as root on the machine that runs Wings.

  sudo bash browser-service.sh --server <server id> [options]

  --server <id>        The server: its UUID, or the first 8 characters of it. Not
                       needed when only one server on this machine has the app.
  --dry-run            Show the plan and stop.
  --yes                Do not ask before starting.
  --rebuild            Build the image anew from the newest Debian packages: that
                       is how the Chromium in it gets its updates.
  --remove             Take the service away: the container, and BROWSER_URL in
                       the server's .env.
  --container-only     Start the container and leave the server alone. The line
                       for its .env is then written to a file only root reads.

  --version <v>        The app version to install while the server is restarted
                       (default: the one that is installed, put in place again).
  --memory <size>      What the browser may use of the machine's memory (1g).
  --cpus <n>           And of its processors (1.5).
  --allow-private <h>  Hosts on a private network that pages may reach all the
                       same, separated by commas: a site of your own.
  --name <name>        The container's name (xiero-browser).
  --port <port>        The port the service listens on inside its network (9223).
  --network <name>     The Docker network to put it on (default: the one the
                       server's container is on).
  --volumes <dir>      Where Wings keeps server files (default: from the Wings
                       configuration, else /var/lib/pterodactyl/volumes).
  --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
  --state-dir <dir>    Where the token is kept (default /root/xiero-nexus-browser).

Environment:
  WINGS_TOKEN          As for pterodactyl-upgrade.sh, which restarts the server.
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$@"; SERVER="$2"; shift 2 ;;
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --memory) need_value "$@"; MEMORY="$2"; shift 2 ;;
    --cpus) need_value "$@"; CPUS="$2"; shift 2 ;;
    --allow-private) need_value "$@"; ALLOW_PRIVATE="$2"; shift 2 ;;
    --network) need_value "$@"; NETWORK_OPTION="$2"; shift 2 ;;
    --volumes) need_value "$@"; VOLUMES="$2"; UPGRADE_OPTIONS+=(--volumes "$2"); shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; UPGRADE_OPTIONS+=(--wings-config "$2"); shift 2 ;;
    --state-dir) need_value "$@"; STATE_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) YES=true; shift ;;
    --rebuild) REBUILD=true; shift ;;
    --remove) REMOVE=true; shift ;;
    --container-only) CONTAINER_ONLY=true; shift ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option \"$1\". See --help." ;;
  esac
done

[[ "${NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]] || die "--name: \"${NAME}\" is not a container name."
[[ "${PORT}" =~ ^[0-9]{2,5}$ ]] && [ "${PORT}" -ge 1024 ] && [ "${PORT}" -le 65535 ] || die "--port: a port from 1024 to 65535."
[[ "${MEMORY}" =~ ^[0-9]+[mMgG]$ ]] || die "--memory: a size such as 768m or 1g."
[[ "${CPUS}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--cpus: a number such as 1 or 1.5."
[[ "${ALLOW_PRIVATE}" =~ ^[a-zA-Z0-9.,:_-]*$ ]] || die "--allow-private: host names and addresses, separated by commas."
if [ -n "${VERSION}" ]; then [[ "${VERSION}" =~ ^[0-9A-Za-z.+-]+$ ]] || die "--version: \"${VERSION}\" is not a version."; fi

here="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${here}/browser"
UPGRADE="${XIERO_UPGRADE_SCRIPT:-${here}/pterodactyl-upgrade.sh}"
[ -f "${SOURCE}/Dockerfile" ] && [ -f "${SOURCE}/gate.mjs" ] || die "the browser service (${SOURCE}/Dockerfile and gate.mjs) is not next to this script."

# A value from the Wings configuration: "system.data", "docker.network.name".
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

confirm() { # QUESTION
  [ "${YES}" = true ] && return 0
  [ -t 0 ] || die "this has to be confirmed: run it with --yes, or in a terminal."
  local answer
  read -r -p "$1 [y/N] " answer
  case "${answer}" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# ── The server ───────────────────────────────────────────────────────────────

if [ -z "${VOLUMES}" ]; then
  VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
  VOLUMES="${VOLUMES:-/var/lib/pterodactyl/volumes}"
fi
[ -d "${VOLUMES}" ] || die "${VOLUMES} is not a folder. Where does Wings keep server files? (--volumes)"

has_app() { [ -f "$1/xiero-nexus-ai/VERSION" ] || [ -f "$1/VERSION" ]; }
UUID=""
matches=()
for dir in "${VOLUMES}"/*/; do
  dir="${dir%/}"
  id="$(basename "${dir}")"
  [[ "${id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
  if [ -n "${SERVER}" ]; then
    case "${id}" in "${SERVER}"*) matches+=("${id}") ;; esac
  elif has_app "${dir}"; then
    matches+=("${id}")
  fi
done
case "${#matches[@]}" in
  0) die "$([ -n "${SERVER}" ] && echo "no server \"${SERVER}\" has files in ${VOLUMES}." || echo "no server in ${VOLUMES} has the app. Name the server with --server.")" ;;
  1) UUID="${matches[0]}" ;;
  *) die "$([ -n "${SERVER}" ] && echo "\"${SERVER}\" is the start of ${#matches[@]} server IDs. Give more of it." || echo "${#matches[@]} servers here have the app. Name one with --server.")" ;;
esac
VOLUME="${VOLUMES}/${UUID}"
if [ -f "${VOLUME}/xiero-nexus-ai/VERSION" ]; then APP_DIR="${VOLUME}/xiero-nexus-ai"; else APP_DIR="${VOLUME}"; fi
[ -f "${APP_DIR}/VERSION" ] || die "server ${UUID} has no bundle of the app (no VERSION file). Install it first."
INSTALLED="$(sed -n 's/^version=//p' "${APP_DIR}/VERSION" | head -n 1 | tr -d '\r')"
[ -n "${INSTALLED}" ] || die "${APP_DIR}/VERSION does not say which version is installed."
ENV_FILE="${APP_DIR}/.env"
STATE_DIR="${STATE_ROOT}/${UUID}"
TOKEN_FILE="${STATE_DIR}/container.env"
URL_FILE="${STATE_DIR}/browser-url"

# ── Docker ───────────────────────────────────────────────────────────────────

command -v docker > /dev/null 2>&1 || die "docker is not installed on this machine."
docker info > /dev/null 2>&1 || die "the Docker daemon does not answer. This has to run as root on the machine that runs Wings."

exists() { docker inspect "$1" > /dev/null 2>&1; }
field() { docker inspect -f "$2" "$1" 2> /dev/null || true; }

# The network the server's container is on: asked of the container when there
# is one (Wings makes a new one with every start), else of the Wings configuration.
NETWORK="${NETWORK_OPTION}"
if [ -z "${NETWORK}" ] && exists "${UUID}"; then
  NETWORK="$(field "${UUID}" '{{range $name, $net := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' | head -n 1)"
fi
if [ -z "${NETWORK}" ]; then
  NETWORK="$(yaml_get "${WINGS_CONFIG}" docker.network.name || true)"
  NETWORK="${NETWORK:-pterodactyl_nw}"
fi
docker network inspect "${NETWORK}" > /dev/null 2>&1 || die "there is no Docker network \"${NETWORK}\". Start the server once, or name the network with --network."
DRIVER="$(docker network inspect -f '{{.Driver}}' "${NETWORK}" 2> /dev/null || true)"
SUBNET="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' "${NETWORK}" 2> /dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' | head -n 1 || true)"
[ "${DRIVER}" = "bridge" ] || die "the network \"${NETWORK}\" is of the kind \"${DRIVER:-unknown}\". This script puts the browser on a bridge network, next to the server's container."

# An address of its own that stays the same when the container is made anew:
# near the end of the network, where Docker, which counts from the start, does
# not get to. Empty when the network is too small or of an unknown shape:
# Docker then chooses, and the address can change with a restart of Docker.
static_address() { # SUBNET NTH
  local base="${1%/*}" bits="${1#*/}" a b c
  IFS=. read -r a b c _ <<< "${base}"
  if [ "${bits}" -le 16 ]; then printf '%s.%s.255.%s' "${a}" "${b}" "$((250 - $2))"; elif [ "${bits}" -le 24 ]; then printf '%s.%s.%s.%s' "${a}" "${b}" "${c}" "$((250 - $2))"; fi
}

HAD=false
HAD_ADDRESS=""
if exists "${NAME}"; then
  HAD=true
  HAD_ADDRESS="$(field "${NAME}" "{{with index .NetworkSettings.Networks \"${NETWORK}\"}}{{.IPAddress}}{{end}}")"
fi
ADDRESS="${HAD_ADDRESS}"
if [ -z "${ADDRESS}" ] && [ -n "${SUBNET}" ]; then ADDRESS="$(static_address "${SUBNET}" 0)"; fi

# ── The plan ─────────────────────────────────────────────────────────────────

step "$([ "${REMOVE}" = true ] && echo "Taking the browser service away" || echo "The plan")"
say "  Server      ${UUID}"
say "  App         ${APP_DIR} (version ${INSTALLED})"
say "  Network     ${NETWORK}${SUBNET:+ (${SUBNET})}"
if [ "${REMOVE}" = true ]; then
  say "  Container   ${NAME}: $([ "${HAD}" = true ] && echo "is removed" || echo "is not there")"
  [ "${CONTAINER_ONLY}" = true ] || say "  The app     BROWSER_URL is emptied in ${ENV_FILE}, and the server is started again"
else
  say "  Image       ${IMAGE}, built here from Debian's Chromium$([ "${REBUILD}" = true ] && echo ", anew from the newest packages")"
  say "  Container   ${NAME}$([ "${HAD}" = true ] && echo " (there is one: it is replaced)"), at ${ADDRESS:-an address Docker chooses}:${PORT} on that network"
  say "              not published to this machine or to the outside; started again with Docker"
  say "  Limits      ${MEMORY} of memory, ${CPUS} processors; no rights of root; a read-only file system"
  say "  Pages       cannot reach private networks${ALLOW_PRIVATE:+, except ${ALLOW_PRIVATE}}"
  say "  Token       $([ -s "${TOKEN_FILE}" ] && echo "the one that is kept in ${STATE_DIR}" || echo "a new one, kept in ${STATE_DIR} (only root reads it)")"
  if [ "${CONTAINER_ONLY}" = true ]; then
    say "  The app     is left alone; the line for its .env is written to ${URL_FILE}"
  else
    say "  The app     BROWSER_URL is written into ${ENV_FILE}, and the server is started again"
    say "              with version ${VERSION:-${INSTALLED}}$([ -z "${VERSION}" ] || [ "${VERSION}" = "${INSTALLED}" ] && echo " (the one that is installed, put in place again)")"
  fi
fi
available="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2> /dev/null || true)"
[ -z "${available}" ] || say "  Memory      ${available} MB of this machine are free now"

if [ "${DRY_RUN}" = true ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi

restart_app() { # the line for .env
  [ -f "${UPGRADE}" ] || die "pterodactyl-upgrade.sh is not next to this script, so the server cannot be restarted from here. Put the line of ${URL_FILE} into ${ENV_FILE} and restart the server in the panel."
  bash "${UPGRADE}" --server "${UUID}" --version "${VERSION:-${INSTALLED}}" --force --yes --set "$1" ${UPGRADE_OPTIONS[@]+"${UPGRADE_OPTIONS[@]}"}
}

# ── Taking it away ───────────────────────────────────────────────────────────

if [ "${REMOVE}" = true ]; then
  confirm "Take the browser service away?" || die "stopped; nothing was changed."
  if [ "${HAD}" = true ]; then
    docker rm -f "${NAME}" > /dev/null
    say "The container ${NAME} is removed."
  fi
  rm -f "${TOKEN_FILE}" "${URL_FILE}"
  if [ "${CONTAINER_ONLY}" != true ]; then
    step "The app"
    restart_app "BROWSER_URL="
  fi
  say ""
  say "The browser service is gone. Agents are not handed the tool \"Work in a browser\" until there is one again."
  exit 0
fi

confirm "Set up the browser service?" || die "stopped; nothing was changed."

# ── The image ────────────────────────────────────────────────────────────────

step "Building the image"
build_log="$(mktemp)"
trap 'rm -f "${build_log}"' EXIT
build_options=(--pull -t "${IMAGE}")
[ "${REBUILD}" = true ] && build_options+=(--no-cache)
if ! docker build "${build_options[@]}" "${SOURCE}" > "${build_log}" 2>&1; then
  tail -n 30 "${build_log}" >&2
  die "the image could not be built. Nothing else was changed."
fi
say "Built ${IMAGE}$(docker image inspect -f ' ({{.Size}} bytes)' "${IMAGE}" 2> /dev/null || true)."

# ── The container ────────────────────────────────────────────────────────────

step "Starting the container"
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_ROOT}" "${STATE_DIR}"
if [ ! -s "${TOKEN_FILE}" ]; then
  token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "${#token}" -eq 48 ] || die "a token could not be made."
  printf 'BROWSER_TOKEN=%s\n' "${token}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi
TOKEN="$(sed -n 's/^BROWSER_TOKEN=//p' "${TOKEN_FILE}" | head -n 1)"
[ "${#TOKEN}" -ge 16 ] || die "${TOKEN_FILE} holds no token. Remove the file and run this again."

run_container() { # ADDRESS, or nothing for one Docker chooses
  docker rm -f "${NAME}" > /dev/null 2>&1 || true
  docker run -d --name "${NAME}" --restart unless-stopped \
    --network "${NETWORK}" ${1:+--ip "$1"} \
    --memory "${MEMORY}" --memory-swap "${MEMORY}" --cpus "${CPUS}" --pids-limit 512 --shm-size 256m \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges \
    --env-file "${TOKEN_FILE}" -e "PORT=${PORT}" ${ALLOW_PRIVATE:+-e "ALLOW_PRIVATE_HOSTS=${ALLOW_PRIVATE}"} \
    "${IMAGE}" > /dev/null 2> "${build_log}"
}
started=false
if [ -n "${ADDRESS}" ]; then
  # The address may be taken by something else: the next one down is tried.
  for nth in 0 1 2 3; do
    try="${ADDRESS}"
    if [ "${nth}" -gt 0 ]; then try="$(static_address "${SUBNET}" "${nth}")"; fi
    [ -n "${try}" ] || break
    if run_container "${try}"; then
      started=true
      ADDRESS="${try}"
      break
    fi
    grep -qi 'address already in use\|already allocated' "${build_log}" || break
  done
fi
if [ "${started}" != true ]; then
  if ! run_container ""; then
    tail -n 5 "${build_log}" >&2
    die "the container could not be started. The server was not touched."
  fi
  ADDRESS="$(field "${NAME}" "{{with index .NetworkSettings.Networks \"${NETWORK}\"}}{{.IPAddress}}{{end}}")"
  [ -n "${ADDRESS}" ] || die "the container was started, but Docker does not say at which address. The server was not touched."
  warn "Docker chose the address ${ADDRESS}. It can change when Docker is restarted: run this script again then."
fi
say "The container ${NAME} runs at ${ADDRESS}:${PORT} on ${NETWORK}."

# ── Checks ───────────────────────────────────────────────────────────────────

step "Checking"
ask_inside() { # CONTAINER PATH [with-token]: the status of the service, asked from inside a container
  docker exec -e "XN_URL=http://${2}" ${3:+-e "XN_TOKEN_ENV=BROWSER_TOKEN"} "$1" node -e '
    const url = process.env.XN_URL + (process.env.XN_TOKEN_ENV ? "?token=" + process.env[process.env.XN_TOKEN_ENV] : "");
    require("http").get(url, { timeout: 5000 }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => { console.log(res.statusCode + " " + body.slice(0, 200).replace(/\s+/g, " ")); process.exit(0); }); })
      .on("timeout", function () { this.destroy(new Error("no answer in 5 s")); })
      .on("error", (err) => { console.log("0 " + err.message); process.exit(0); });' 2> /dev/null || echo "0 the question could not be asked"
}
answer=""
# Chromium takes a few seconds to start; a minute is given.
for _ in $(seq 1 "${XIERO_BROWSER_TRIES:-30}"); do
  answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/healthz")"
  case "${answer}" in 200\ *) break ;; esac
  sleep "${XIERO_BROWSER_GAP:-2}"
done
case "${answer}" in
  200\ *) say "Chromium is running in it." ;;
  *)
    docker logs --tail 20 "${NAME}" >&2 2> /dev/null || true
    die "the browser service did not come up (${answer}). The container ${NAME} is left as it is, to look at; the server was not touched."
    ;;
esac
answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/json/version")"
case "${answer}" in 401\ *) say "Without the token it lets nobody in." ;; *) die "the service answered a question without the token (${answer}). The server was not touched." ;; esac
answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/json/version" with-token)"
case "${answer}" in
  200\ *filtered*) say "With the token it does, and it keeps pages from private networks: $(printf '%s' "${answer}" | sed -n 's/.*"Browser":"\([^"]*\)".*/\1/p')." ;;
  *) die "the service did not take its own token (${answer%% *}). The server was not touched." ;;
esac
if [ "$(field "${UUID}" '{{.State.Running}}')" = "true" ]; then
  answer="$(ask_inside "${UUID}" "${ADDRESS}:${PORT}/healthz")"
  case "${answer}" in
    200\ *) say "The server's container reaches it." ;;
    *) die "the server's container does not reach the service at ${ADDRESS}:${PORT} (${answer#* }). Containers of the network \"${NETWORK}\" may not be allowed to talk to each other. The server was not touched." ;;
  esac
else
  say "The server is not running now, so whether it reaches the service is seen when it is started."
fi

BROWSER_URL="http://${ADDRESS}:${PORT}/?token=${TOKEN}"
printf 'BROWSER_URL=%s\n' "${BROWSER_URL}" > "${URL_FILE}"
chmod 600 "${URL_FILE}"

# ── The app ──────────────────────────────────────────────────────────────────

if [ "${CONTAINER_ONLY}" = true ]; then
  say ""
  say "The browser service runs. The line for the server's .env is in ${URL_FILE}:"
  say "put it into ${ENV_FILE} and restart the server."
  exit 0
fi

step "The app"
restart_app "BROWSER_URL=${BROWSER_URL}"

say ""
say "The browser service runs next to server ${UUID}, and the app is pointed at it."
say "The Browser page of the app shows how it is. To give its Chromium the newest"
say "updates, run this again with --rebuild now and then; --remove takes it away."
