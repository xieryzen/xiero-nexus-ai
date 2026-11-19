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
#      Chromium behind the gate), on this machine. Where Docker's default
#      network does not reach Debian's package servers and the machine's own
#      network does, it builds on the machine's own,
#   4. starts it as a container on the server's network, at an address of its
#      own that stays the same, with a limit on memory and nothing published
#      to the outside. It looks names up the way the server's container does,
#   5. checks that it runs, that it takes its token, that it reaches the
#      outside, that its Chromium opens a page, and that the server's
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
BUILD_NETWORK=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
VOLUMES=""
STATE_ROOT="/root/xiero-nexus-browser"
DRY_RUN=false
YES=false
REMOVE=false
REBUILD=false
CONTAINER_ONLY=false
PAGE_TEST=true
# The page Chromium is asked to open as a check, and the title it has.
TEST_PAGE="https://example.com/"
TEST_TITLE="Example Domain"
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
  --skip-page-test     Do not ask Chromium to open https://example.com/ as a
                       check: for a machine that page cannot be reached from.

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
  --build-network <n>  The network the image is built on: "default" (Docker's
                       own) or "host" (this machine's). Without it, the script
                       asks which of them reaches Debian's package servers.
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
    --build-network) need_value "$@"; BUILD_NETWORK="$2"; shift 2 ;;
    --volumes) need_value "$@"; VOLUMES="$2"; UPGRADE_OPTIONS+=(--volumes "$2"); shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; UPGRADE_OPTIONS+=(--wings-config "$2"); shift 2 ;;
    --state-dir) need_value "$@"; STATE_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) YES=true; shift ;;
    --rebuild) REBUILD=true; shift ;;
    --remove) REMOVE=true; shift ;;
    --container-only) CONTAINER_ONLY=true; shift ;;
    --skip-page-test) PAGE_TEST=false; shift ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option \"$1\". See --help." ;;
  esac
done

[[ "${NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]] || die "--name: \"${NAME}\" is not a container name."
[[ "${PORT}" =~ ^[0-9]{2,5}$ ]] && [ "${PORT}" -ge 1024 ] && [ "${PORT}" -le 65535 ] || die "--port: a port from 1024 to 65535."
[[ "${MEMORY}" =~ ^[0-9]+[mMgG]$ ]] || die "--memory: a size such as 768m or 1g."
[[ "${CPUS}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--cpus: a number such as 1 or 1.5."
[[ "${ALLOW_PRIVATE}" =~ ^[a-zA-Z0-9.,:_-]*$ ]] || die "--allow-private: host names and addresses, separated by commas."
case "${BUILD_NETWORK}" in "" | default | host) ;; *) die "--build-network: \"default\" or \"host\"." ;; esac
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

# The items of a list from the Wings configuration: "docker.network.dns".
yaml_list() {
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
      line = substr($0, indent + 1)
      if (inside) {
        if (substr(line, 1, 1) == "-" && indent >= at) { print clean(substr(line, 2)); next }
        exit
      }
      level = int(indent / 2)
      colon = index(line, ":")
      if (colon == 0) next
      path[level] = substr(line, 1, colon - 1)
      full = path[0]
      for (i = 1; i <= level; i++) full = full "." path[i]
      if (full != want) next
      rest = clean(substr(line, colon + 1))
      if (rest == "") { inside = 1; at = indent; next }
      # Written in one line: [1.1.1.1, 1.0.0.1]
      gsub(/^\[|\]$/, "", rest)
      n = split(rest, items, ",")
      for (i = 1; i <= n; i++) print clean(items[i])
      exit
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

# Names are looked up the way the server's container looks them up: Wings
# gives its containers DNS servers of its own, and what finds a name for the
# app finds it for the browser next to it. Without any, Docker decides.
DNS=()
DNS_FROM=""
address_like() { [[ "$1" =~ ^[0-9a-fA-F:.]{3,45}$ ]] && [[ "$1" == *[.:]* ]]; }
if exists "${UUID}"; then
  while IFS= read -r one; do
    if address_like "${one}"; then DNS+=("${one}"); fi
  done <<< "$(field "${UUID}" '{{range .HostConfig.Dns}}{{.}}{{"\n"}}{{end}}')"
  [ "${#DNS[@]}" -eq 0 ] || DNS_FROM="as the server's container does"
fi
if [ "${#DNS[@]}" -eq 0 ]; then
  while IFS= read -r one; do
    if address_like "${one}"; then DNS+=("${one}"); fi
  done <<< "$(yaml_list "${WINGS_CONFIG}" docker.network.dns || true)"
  [ "${#DNS[@]}" -eq 0 ] || DNS_FROM="as the Wings configuration says"
fi

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
  case "${BUILD_NETWORK}" in
    host) say "              built on this machine's own network (--build-network host)" ;;
    default) say "              built on Docker's default network (--build-network default)" ;;
    *) say "              built on Docker's default network, or on this machine's own where only that reaches Debian's package servers" ;;
  esac
  say "  Container   ${NAME}$([ "${HAD}" = true ] && echo " (there is one: it is replaced)"), at ${ADDRESS:-an address Docker chooses}:${PORT} on that network"
  say "              not published to this machine or to the outside; started again with Docker"
  say "  Limits      ${MEMORY} of memory, ${CPUS} processors; no rights of root; a read-only file system"
  say "  Pages       cannot reach private networks${ALLOW_PRIVATE:+, except ${ALLOW_PRIVATE}}"
  if [ "${#DNS[@]}" -gt 0 ]; then say "  Names       are looked up ${DNS_FROM}: ${DNS[*]}"; else say "  Names       are looked up as Docker does on this machine"; fi
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

# The build installs Debian's packages from inside a container, on Docker's
# default network. On some machines that network does not get to the outside
# while the machine itself does: a firewall that passes on only what Wings
# set up. So it is asked first, with the image the build starts from. Where
# the default network does not get there and the machine's own does, the
# image is built on the machine's own.
BASE="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' "${SOURCE}/Dockerfile" | head -n 1)"
reaches_packages() { # NETWORK: whether a container on it gets to Debian's package servers
  docker run --rm --network "$1" "${BASE}" timeout 15 bash -c 'exec 3<> /dev/tcp/deb.debian.org/80' > /dev/null 2>&1
}
if [ -z "${BUILD_NETWORK}" ]; then
  BUILD_NETWORK="default"
  if [ -n "${BASE}" ] && docker pull -q "${BASE}" > /dev/null 2>&1; then
    if ! reaches_packages bridge; then
      if reaches_packages host; then
        BUILD_NETWORK="host"
        say "Docker's default network does not reach Debian's package servers from this machine; the machine's own network does."
        say "So the image is built on the machine's own network (docker build --network host)."
      else
        warn "neither Docker's default network nor this machine's own reaches deb.debian.org just now. The build is tried all the same."
      fi
    fi
  fi
fi
build_options=(--pull -t "${IMAGE}")
[ "${REBUILD}" = true ] && build_options+=(--no-cache)
[ "${BUILD_NETWORK}" = "host" ] && build_options+=(--network host)
if ! docker build "${build_options[@]}" "${SOURCE}" > "${build_log}" 2>&1; then
  # What the package tool said went wrong stands long before the end of what a build prints.
  telling="$(grep -E '^(#[0-9]+ +[0-9.]+ +)?(W: |E: |Err:[0-9]+ )' "${build_log}" | sed -E 's/^#[0-9]+ +[0-9.]+ +//' | awk '!seen[$0]++' | head -n 8 || true)"
  # Only where the end of it does not show them anyway.
  if [ -n "${telling}" ] && [ "$(wc -l < "${build_log}")" -gt 30 ]; then
    printf 'What the package tool said first:\n%s\n\nThe end of what the build said:\n' "${telling}" >&2
  fi
  tail -n 30 "${build_log}" >&2
  if [ "${BUILD_NETWORK}" = "host" ]; then
    die "the image could not be built, on this machine's own network. Nothing else was changed."
  fi
  die "the image could not be built. Nothing else was changed. If the lines above say that a name was not found or that nothing connected, the build has no way out on Docker's default network: run this again with --build-network host."
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

dns_options=()
for one in ${DNS[@]+"${DNS[@]}"}; do dns_options+=(--dns "${one}"); done
run_container() { # ADDRESS, or nothing for one Docker chooses
  docker rm -f "${NAME}" > /dev/null 2>&1 || true
  docker run -d --name "${NAME}" --restart unless-stopped \
    --network "${NETWORK}" ${1:+--ip "$1"} ${dns_options[@]+"${dns_options[@]}"} \
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
    require("http").get(url, { timeout: 5000 }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => { console.log(res.statusCode + " " + body.slice(0, 4000).replace(/\s+/g, " ")); process.exit(0); }); })
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
    die "the browser service did not come up (${answer:0:200}). The container ${NAME} is left as it is, to look at; the server was not touched."
    ;;
esac
answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/json/version")"
case "${answer}" in 401\ *) say "Without the token it lets nobody in." ;; *) die "the service answered a question without the token (${answer:0:200}). The server was not touched." ;; esac
answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/json/version" with-token)"
case "${answer}" in
  200\ *filtered*) say "With the token it does, and it keeps pages from private networks: $(printf '%s' "${answer}" | sed -n 's/.*"Browser":[[:space:]]*"\([^"]*\)".*/\1/p')." ;;
  200\ *) die "the service took its token, but does not say that it keeps pages from private networks: what answers at that port is not the gate of this version. The server was not touched." ;;
  *) die "the service did not take its own token (${answer%% *}). The server was not touched." ;;
esac
# Whether pages get anywhere: asked the way the service asks for what a page
# loads, a name looked up and a connection made. One of three well-known
# sites is enough.
answer="$(docker exec -e XN_OUTSIDE=1 "${NAME}" node -e '
  const dns = require("dns").promises;
  const net = require("net");
  const connects = (address) => new Promise((resolve) => {
    const socket = net.connect({ host: address, port: 443, timeout: 8000 }, () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
  (async () => {
    const said = [];
    for (const host of ["deb.debian.org", "github.com", "www.wikipedia.org"]) {
      let address;
      try { address = (await dns.lookup(host)).address; } catch (err) { said.push(host + ": the name was not found (" + (err.code || err.message) + ")"); continue; }
      if (await connects(address)) { console.log("ok " + host); return; }
      said.push(host + ": nothing connected at " + address);
    }
    console.log("no " + said.join("; "));
  })();' 2> /dev/null || echo "no the question could not be asked")"
case "${answer}" in
  ok\ *) say "It reaches the outside (${answer#ok })." ;;
  *)
    die "the browser's container does not reach the outside (${answer#no }), so pages would not load. A name that is not found is a matter of DNS: the container looks names up $([ "${#DNS[@]}" -gt 0 ] && echo "at ${DNS[*]}" || echo "as Docker does on this machine"). Nothing that connects is a matter of the firewall of this machine or of the network \"${NETWORK}\". The container ${NAME} is left as it is, to look at; the server was not touched."
    ;;
esac
# Whether Chromium opens a page: a tab is opened on a page that has been
# there for decades, and its title is waited for. Everything a page loads
# goes through the gate, so this is the way an agent's page goes. Asked of
# Chromium itself, at the port it listens on inside its container.
if [ "${PAGE_TEST}" = true ]; then
  answer="$(docker exec -e "XN_PAGE=${TEST_PAGE}" -e "XN_TITLE=${TEST_TITLE}" "${NAME}" node -e '
    const fs = require("fs");
    const path = require("path");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    (async () => {
      // Chromium writes the port it chose into its profile, which is under the temporary folder.
      const tmp = process.env.XN_TMP || "/tmp";
      let port = "";
      for (const dir of fs.readdirSync(tmp)) {
        try { port = fs.readFileSync(path.join(tmp, dir, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); } catch { continue; }
        if (/^[0-9]+$/.test(port)) break;
      }
      if (!/^[0-9]+$/.test(port)) { console.log("no Chromium does not say at which port it listens"); return; }
      const chrome = "http://127.0.0.1:" + port;
      const started = Date.now();
      let tab;
      try { tab = await (await fetch(chrome + "/json/new?" + process.env.XN_PAGE, { method: "PUT" })).json(); } catch (err) { console.log("no no tab could be opened (" + err.message + ")"); return; }
      let title = "";
      for (let i = 0; i < 40 && title !== process.env.XN_TITLE; i++) {
        await wait(500);
        try { title = ((await (await fetch(chrome + "/json/list")).json()).find((one) => one.id === tab.id) || {}).title || ""; } catch { title = ""; }
      }
      try { await fetch(chrome + "/json/close/" + tab.id); } catch { /* It goes with the browser. */ }
      const took = ((Date.now() - started) / 1000).toFixed(1) + " s";
      if (title === process.env.XN_TITLE) console.log("ok " + took);
      else console.log("no after " + took + " the tab is titled \"" + title.slice(0, 80) + "\", not \"" + process.env.XN_TITLE + "\"");
    })().catch((err) => console.log("no " + err.message));' 2> /dev/null || echo "no the question could not be asked")"
  case "${answer}" in
    ok\ *) say "Its Chromium opens a page: ${TEST_PAGE} came up in ${answer#ok }." ;;
    *)
      die "Chromium did not open ${TEST_PAGE} (${answer#no }). A page goes through the gate, which refuses private networks and passes on the rest: the container's log (docker logs ${NAME}) says what it refused. If that page cannot be reached from this machine at all, run this again with --skip-page-test. The container ${NAME} is left as it is, to look at; the server was not touched."
      ;;
  esac
fi
if [ "$(field "${UUID}" '{{.State.Running}}')" = "true" ]; then
  answer="$(ask_inside "${UUID}" "${ADDRESS}:${PORT}/healthz")"
  case "${answer}" in
    200\ *) say "The server's container reaches it." ;;
    *) die "the server's container does not reach the service at ${ADDRESS}:${PORT} (${answer:2:200}). Containers of the network \"${NETWORK}\" may not be allowed to talk to each other. The server was not touched." ;;
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
