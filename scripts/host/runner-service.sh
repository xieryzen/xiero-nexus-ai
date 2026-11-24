#!/usr/bin/env bash
# The runner programs and builds run in, on a Pterodactyl node: run as root on
# the machine that runs Wings.
#
#   sudo bash runner-service.sh --server <server id>
#
# Xiero Nexus AI never runs code itself. What an agent runs with run_command,
# what the Execute box of a workspace runs, and the build that turns the files
# of a project into its package (a plugin's .jar) all run in a runner that is
# apart from the app (runner/README.md). This script sets one up next to a
# Pterodactyl server, in this order:
#
#   1. finds the server and the Docker network its container is on,
#   2. shows what it is going to do and asks,
#   3. builds the image of the runner (runner/Dockerfile: Node.js, Python, and
#      for builds JDK, Maven and Gradle), on this machine. Where Docker's
#      default network does not reach Debian's package servers and the
#      machine's own network does, it builds on the machine's own,
#   4. starts it as a container on the server's network, at an address of its
#      own that stays the same, with limits on memory, processors and
#      processes, a read-only file system, and nothing published to the
#      outside. Every program runs in it as a user of its own without any
#      right of root, and the container's network is closed to private
#      addresses: a build fetches from the internet, and reaches neither this
#      machine nor the containers next to it,
#   5. checks that it runs, that it takes its token, who a program runs as,
#      that private addresses are refused and the outside is reached, that a
#      Paper plugin builds in it, and that the server's container reaches it,
#   6. writes SANDBOX_URL, SANDBOX_TOKEN and SANDBOX_MAX_SECONDS into the
#      server's .env and starts the server again (pterodactyl-upgrade.sh does
#      that part: with a backup, and back to how it was when the app does not
#      come up).
#
# The token that lets the app in is made here and kept in a folder only root
# reads. It is never printed.
#
# Run it with --dry-run first to see the plan without changing anything.
# Run it again to rebuild the image (--rebuild gets the newest packages) or
# after a change of the limits; --remove takes the runner away again.
#
# Options: --help.
set -euo pipefail
umask 077

SERVER=""
VERSION=""
NAME="xiero-runner"
IMAGE="xiero-runner"
PORT="8080"
MEMORY="3g"
CPUS="2"
MAX_SECONDS="900"
CONCURRENCY="1"
ALLOW_PRIVATE=""
WARM=""
WARM_SET=false
NETWORK_OPTION=""
BUILD_NETWORK=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
VOLUMES=""
STATE_ROOT="/root/xiero-nexus-runner"
DRY_RUN=false
YES=false
REMOVE=false
REBUILD=false
CONTAINER_ONLY=false
BUILD_TEST=true
# Who the programs run as inside the container: a user that is nobody on this machine.
RUN_AS="20000:20000"
UPGRADE_OPTIONS=()

usage() {
  cat << 'EOF'
Set up the runner programs and builds run in, next to a Pterodactyl server. Run as root on the machine that runs Wings.

  sudo bash runner-service.sh --server <server id> [options]

  --server <id>        The server: its UUID, or the first 8 characters of it. Not
                       needed when only one server on this machine has the app.
  --dry-run            Show the plan and stop.
  --yes                Do not ask before starting.
  --rebuild            Build the image anew from the newest Debian packages.
  --remove             Take the runner away: the container, and SANDBOX_URL in
                       the server's .env.
  --container-only     Start the container and leave the server alone. The lines
                       for its .env are then written to a file only root reads.
  --skip-build-test    Do not build a Paper plugin as a check: for a machine the
                       package servers of Paper cannot be reached from.

  --version <v>        The app version to install while the server is restarted
                       (default: the one that is installed, put in place again).
  --memory <size>      What the runner may use of the machine's memory (3g). A
                       Gradle build wants 2g or more.
  --cpus <n>           And of its processors (2).
  --max-seconds <n>    The longest a program or a build may run (900).
  --concurrency <n>    How many run at once (1); the others wait their turn.
                       Each needs memory of its own.
  --allow-private <a>  Addresses or networks on a private network that programs
                       may reach all the same, separated by commas: a package
                       mirror of your own (10.0.0.5 or 10.0.0.0/24).
  --warm <list>        The Paper API versions that are fetched once, when the
                       image is built, each with the Java it is for, separated
                       by commas: 1.21.4:21,1.21.8:21. "none" fetches nothing
                       ahead. (default: what runner/Dockerfile names)
  --name <name>        The container's name (xiero-runner).
  --port <port>        The port the runner listens on inside its network (8080).
  --network <name>     The Docker network to put it on (default: the one the
                       server's container is on).
  --build-network <n>  The network the image is built on: "default" (Docker's
                       own) or "host" (this machine's). Without it, the script
                       asks which of them reaches Debian's package servers.
  --volumes <dir>      Where Wings keeps server files (default: from the Wings
                       configuration, else /var/lib/pterodactyl/volumes).
  --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
  --state-dir <dir>    Where the token is kept (default /root/xiero-nexus-runner).

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
    --max-seconds) need_value "$@"; MAX_SECONDS="$2"; shift 2 ;;
    --concurrency) need_value "$@"; CONCURRENCY="$2"; shift 2 ;;
    --allow-private) need_value "$@"; ALLOW_PRIVATE="$2"; shift 2 ;;
    --warm) need_value "$@"; WARM="$2"; WARM_SET=true; shift 2 ;;
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
    --skip-build-test) BUILD_TEST=false; shift ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option \"$1\". See --help." ;;
  esac
done

[[ "${NAME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]] || die "--name: \"${NAME}\" is not a container name."
[[ "${PORT}" =~ ^[0-9]{2,5}$ ]] && [ "${PORT}" -ge 1024 ] && [ "${PORT}" -le 65535 ] || die "--port: a port from 1024 to 65535."
[[ "${MEMORY}" =~ ^[0-9]+[mMgG]$ ]] || die "--memory: a size such as 2g or 3g."
[[ "${CPUS}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--cpus: a number such as 1 or 1.5."
[[ "${MAX_SECONDS}" =~ ^[0-9]{2,4}$ ]] && [ "${MAX_SECONDS}" -ge 10 ] && [ "${MAX_SECONDS}" -le 3600 ] || die "--max-seconds: a number of seconds from 10 to 3600."
[[ "${CONCURRENCY}" =~ ^[1-8]$ ]] || die "--concurrency: a number from 1 to 8."
[[ "${ALLOW_PRIVATE}" =~ ^[0-9.,/]*$ ]] || die "--allow-private: addresses or networks in numbers (10.0.0.5 or 10.0.0.0/24), separated by commas."
if [ "${WARM_SET}" = true ] && [ "${WARM}" != "none" ]; then
  [[ "${WARM}" =~ ^[0-9]+(\.[0-9]+){1,2}:[0-9]{1,2}(,[0-9]+(\.[0-9]+){1,2}:[0-9]{1,2})*$ ]] || die "--warm: versions of the Paper API, each with its Java, separated by commas (1.21.4:21,1.21.8:21), or \"none\"."
fi
case "${BUILD_NETWORK}" in "" | default | host) ;; *) die "--build-network: \"default\" or \"host\"." ;; esac
if [ -n "${VERSION}" ]; then [[ "${VERSION}" =~ ^[0-9A-Za-z.+-]+$ ]] || die "--version: \"${VERSION}\" is not a version."; fi

here="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${here}/runner"
UPGRADE="${XIERO_UPGRADE_SCRIPT:-${here}/pterodactyl-upgrade.sh}"
[ -f "${SOURCE}/Dockerfile" ] && [ -f "${SOURCE}/server.mjs" ] || die "the runner (${SOURCE}/Dockerfile and server.mjs) is not next to this script."
VOLUME_NAME="${NAME}-work"
PROBE="${NAME}-probe"

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
ENV_LINES_FILE="${STATE_DIR}/runner-env"

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
[ "${DRIVER}" = "bridge" ] || die "the network \"${NETWORK}\" is of the kind \"${DRIVER:-unknown}\". This script puts the runner on a bridge network, next to the server's container."

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
# app finds it for the runner next to it. Without any, Docker decides.
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
# The browser service, where there is one, has the first addresses from the end: the runner takes the fifth.
if [ -z "${ADDRESS}" ] && [ -n "${SUBNET}" ]; then ADDRESS="$(static_address "${SUBNET}" 4)"; fi

# The addresses of this machine itself, which programs are kept from as from
# every private one: what listens on them is this machine's, not the internet's.
OWN=()
while IFS= read -r one; do
  if [[ "${one}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "${#OWN[@]}" -lt 32 ]; then OWN+=("${one}"); fi
done <<< "$( (ip -4 -o addr show scope global 2> /dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }') || true)"
if [ "${#OWN[@]}" -eq 0 ]; then
  for one in $(hostname -I 2> /dev/null || true); do
    if [[ "${one}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "${#OWN[@]}" -lt 32 ]; then OWN+=("${one}"); fi
  done
fi
PIDS="$((CONCURRENCY * 1024 + 256))"

# ── The plan ─────────────────────────────────────────────────────────────────

step "$([ "${REMOVE}" = true ] && echo "Taking the runner away" || echo "The plan")"
say "  Server      ${UUID}"
say "  App         ${APP_DIR} (version ${INSTALLED})"
say "  Network     ${NETWORK}${SUBNET:+ (${SUBNET})}"
if [ "${REMOVE}" = true ]; then
  say "  Container   ${NAME}: $([ "${HAD}" = true ] && echo "is removed, with the folder its runs work in" || echo "is not there")"
  [ "${CONTAINER_ONLY}" = true ] || say "  The app     SANDBOX_URL and SANDBOX_TOKEN are emptied in ${ENV_FILE}, and the server is started again"
else
  say "  Image       ${IMAGE}, built here: Node.js, Python, JDK, Maven, Gradle 8 and 9$([ "${REBUILD}" = true ] && echo ", anew from the newest packages")"
  case "${BUILD_NETWORK}" in
    host) say "              built on this machine's own network (--build-network host)" ;;
    default) say "              built on Docker's default network (--build-network default)" ;;
    *) say "              built on Docker's default network, or on this machine's own where only that reaches Debian's package servers" ;;
  esac
  if [ "${WARM_SET}" = true ]; then
    say "              fetched ahead: $([ "${WARM}" = "none" ] && echo "nothing" || echo "the Paper API ${WARM//,/, }")"
  else
    say "              fetched ahead: the Paper API in the versions the Dockerfile names"
  fi
  say "              The first build of the image takes several minutes and a few gigabytes of disk."
  say "  Container   ${NAME}$([ "${HAD}" = true ] && echo " (there is one: it is replaced)"), at ${ADDRESS:-an address Docker chooses}:${PORT} on that network"
  say "              not published to this machine or to the outside; started again with Docker"
  say "  Limits      ${MEMORY} of memory, ${CPUS} processors, ${PIDS} processes; a read-only file system"
  say "              a program runs up to ${MAX_SECONDS} seconds, ${CONCURRENCY} at a time"
  say "  Programs    run as a user of their own (${RUN_AS}), without any right of root"
  say "              they reach the internet, and no private address${ALLOW_PRIVATE:+ except ${ALLOW_PRIVATE}}; not this machine either"
  if [ "${#DNS[@]}" -gt 0 ]; then say "  Names       are looked up ${DNS_FROM}: ${DNS[*]}"; else say "  Names       are looked up as Docker does on this machine"; fi
  say "  Token       $([ -s "${TOKEN_FILE}" ] && echo "the one that is kept in ${STATE_DIR}" || echo "a new one, kept in ${STATE_DIR} (only root reads it)")"
  if [ "${CONTAINER_ONLY}" = true ]; then
    say "  The app     is left alone; the lines for its .env are written to ${ENV_LINES_FILE}"
  else
    say "  The app     SANDBOX_URL, SANDBOX_TOKEN and SANDBOX_MAX_SECONDS are written into ${ENV_FILE},"
    say "              and the server is started again with version ${VERSION:-${INSTALLED}}$([ -z "${VERSION}" ] || [ "${VERSION}" = "${INSTALLED}" ] && echo " (the one that is installed, put in place again)")"
  fi
fi
available="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2> /dev/null || true)"
[ -z "${available}" ] || say "  Memory      ${available} MB of this machine are free now"

if [ "${DRY_RUN}" = true ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi

restart_app() { # the lines for .env
  [ -f "${UPGRADE}" ] || die "pterodactyl-upgrade.sh is not next to this script, so the server cannot be restarted from here. Put the lines of ${ENV_LINES_FILE} into ${ENV_FILE} and restart the server in the panel."
  local sets=() one
  for one in "$@"; do sets+=(--set "${one}"); done
  bash "${UPGRADE}" --server "${UUID}" --version "${VERSION:-${INSTALLED}}" --force --yes "${sets[@]}" ${UPGRADE_OPTIONS[@]+"${UPGRADE_OPTIONS[@]}"}
}

# ── Taking it away ───────────────────────────────────────────────────────────

if [ "${REMOVE}" = true ]; then
  confirm "Take the runner away?" || die "stopped; nothing was changed."
  docker rm -f "${PROBE}" > /dev/null 2>&1 || true
  if [ "${HAD}" = true ]; then
    docker rm -f "${NAME}" > /dev/null
    say "The container ${NAME} is removed."
  fi
  docker volume rm "${VOLUME_NAME}" > /dev/null 2>&1 || true
  rm -f "${TOKEN_FILE}" "${ENV_LINES_FILE}"
  if [ "${CONTAINER_ONLY}" != true ]; then
    step "The app"
    restart_app "SANDBOX_URL=" "SANDBOX_TOKEN="
  fi
  say ""
  say "The runner is gone. Nothing is run or built until there is one again: agents are not handed the tool \"Run a command\"."
  exit 0
fi

confirm "Set up the runner?" || die "stopped; nothing was changed."

# ── The image ────────────────────────────────────────────────────────────────

step "Building the image"
build_log="$(mktemp)"
trap 'rm -f "${build_log}"; docker rm -f "${PROBE}" > /dev/null 2>&1 || true' EXIT

# The build installs Debian's packages from inside a container, on Docker's
# default network. On some machines that network does not get to the outside
# while the machine itself does (seen on a node; a firewall that passes on
# only what Wings set up would do that). So it is asked first, with the image
# the build starts from. Where the default network does not get there and
# the machine's own does, the image is built on the machine's own.
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
if [ "${WARM_SET}" = true ]; then
  if [ "${WARM}" = "none" ]; then build_options+=(--build-arg "WARM_PAPER="); else build_options+=(--build-arg "WARM_PAPER=${WARM//,/ }"); fi
fi
# What the build says of itself, without what the builder puts in front of a line.
plain() { sed -E 's/^#[0-9]+ +[0-9.]+ +//'; }
if ! docker build --progress plain "${build_options[@]}" "${SOURCE}" > "${build_log}" 2>&1; then
  # What went wrong stands long before the end of what a build prints.
  telling="$(grep -E '^(#[0-9]+ +[0-9.]+ +)?(W: |E: |Err:[0-9]+ |curl: |sha256sum: )' "${build_log}" | plain | awk '!seen[$0]++' | head -n 8 || true)"
  # Only where the end of it does not show them anyway.
  if [ -n "${telling}" ] && [ "$(wc -l < "${build_log}")" -gt 30 ]; then
    printf 'What went wrong first:\n%s\n\nThe end of what the build said:\n' "${telling}" >&2
  fi
  tail -n 30 "${build_log}" >&2
  if [ "${BUILD_NETWORK}" = "host" ]; then
    die "the image could not be built, on this machine's own network. Nothing else was changed."
  fi
  die "the image could not be built. Nothing else was changed. If the lines above say that a name was not found or that nothing connected, the build has no way out on Docker's default network: run this again with --build-network host."
fi
say "Built ${IMAGE}$(docker image inspect -f ' ({{.Size}} bytes)' "${IMAGE}" 2> /dev/null || true)."
# What is in it, as the build said: the JDKs, and what was fetched ahead.
grep -E '^(#[0-9]+ +[0-9.]+ +)?(JDKs: |warm: )' "${build_log}" | plain | awk '!seen[$0]++' | sed 's/^/  /' || true

# ── The container ────────────────────────────────────────────────────────────

step "Starting the container"
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_ROOT}" "${STATE_DIR}"
if [ ! -s "${TOKEN_FILE}" ]; then
  token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "${#token}" -eq 48 ] || die "a token could not be made."
  printf 'RUNNER_TOKEN=%s\n' "${token}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi
TOKEN="$(sed -n 's/^RUNNER_TOKEN=//p' "${TOKEN_FILE}" | head -n 1)"
[ "${#TOKEN}" -ge 16 ] || die "${TOKEN_FILE} holds no token. Remove the file and run this again."

dns_options=()
for one in ${DNS[@]+"${DNS[@]}"}; do dns_options+=(--dns "${one}"); done
# The rights the container starts with: to close its network (given up before
# the server runs), and to start every program as another user and to tidy up
# after it. Nothing else of root.
run_container() { # ADDRESS, or nothing for one Docker chooses
  docker rm -f "${NAME}" > /dev/null 2>&1 || true
  docker run -d --name "${NAME}" --restart unless-stopped --init \
    --network "${NETWORK}" ${1:+--ip "$1"} ${dns_options[@]+"${dns_options[@]}"} \
    --memory "${MEMORY}" --memory-swap "${MEMORY}" --cpus "${CPUS}" --pids-limit "${PIDS}" --ulimit nproc=1024:1024 \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    --mount "type=volume,src=${VOLUME_NAME},dst=/work" \
    --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SETPCAP \
    --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges \
    --env-file "${TOKEN_FILE}" -e "PORT=${PORT}" -e RUNNER_FIREWALL=1 -e "RUNNER_RUN_AS=${RUN_AS}" \
    -e "RUNNER_MAX_SECONDS=${MAX_SECONDS}" -e "RUNNER_CONCURRENCY=${CONCURRENCY}" \
    -e "RUNNER_DENY=${OWN[*]-}" ${ALLOW_PRIVATE:+-e "RUNNER_ALLOW=${ALLOW_PRIVATE//,/ }"} \
    "${IMAGE}" > /dev/null 2> "${build_log}"
}
started=false
if [ -n "${ADDRESS}" ]; then
  # The address may be taken by something else: the next one down is tried.
  for nth in 0 1 2 3; do
    try="${ADDRESS}"
    if [ "${nth}" -gt 0 ]; then try="$(static_address "${SUBNET}" "$((4 + nth))")"; fi
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
left_as_is="The container ${NAME} is left as it is, to look at (docker logs ${NAME}); the server was not touched."
ask_inside() { # CONTAINER HOST:PORT/PATH [post]: the status and the answer, asked from inside a container
  docker exec -e "XN_URL=http://${2}" ${3:+-e "XN_POST=1"} "$1" node -e '
    const options = process.env.XN_POST ? { method: "POST", headers: { "content-type": "application/json" }, timeout: 5000 } : { timeout: 5000 };
    const req = require("http").request(process.env.XN_URL, options, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => { console.log(res.statusCode + " " + body.slice(0, 4000).replace(/\s+/g, " ")); process.exit(0); }); })
      .on("timeout", function () { this.destroy(new Error("no answer in 5 s")); })
      .on("error", (err) => { console.log("0 " + err.message); process.exit(0); });
    req.end(process.env.XN_POST ? "{\"files\":[],\"command\":\"node -v\"}" : undefined);' 2> /dev/null || echo "0 the question could not be asked"
}
# Whether a connection can be made, asked with node: "ok", or "no" and why.
CONNECT='
  const net = require("net");
  const socket = net.connect({ host: process.env.XN_HOST, port: Number(process.env.XN_PORT), timeout: 4000 }, () => { socket.destroy(); console.log("ok"); });
  socket.on("timeout", () => { socket.destroy(); console.log("no no answer in 4 s"); });
  socket.on("error", (err) => console.log("no " + (err.code || err.message)));'
connects() { # CONTAINER HOST PORT [user]: from inside a container, as the user the programs run as or as it is
  docker exec ${4:+-u "$4"} -e "XN_HOST=$2" -e "XN_PORT=$3" "$1" node -e "${CONNECT}" 2> /dev/null || echo "no the question could not be asked"
}

answer=""
for _ in $(seq 1 "${XIERO_RUNNER_TRIES:-20}"); do
  answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/health")"
  case "${answer}" in 200\ *) break ;; esac
  # A container that ended says why in its log: the rules of its network could not be set.
  if [ "$(field "${NAME}" '{{.State.Running}}')" != "true" ] && [ "$(field "${NAME}" '{{.State.Restarting}}')" != "true" ]; then break; fi
  sleep "${XIERO_RUNNER_GAP:-1}"
done
case "${answer}" in
  200\ *'"separate":true'*) say "The runner is running in it, and starts every program as a user of its own." ;;
  200\ *) die "the runner came up, but it does not start programs as a user of their own: what answers at that port is not the runner of this version. ${left_as_is}" ;;
  *)
    docker logs --tail 20 "${NAME}" >&2 2> /dev/null || true
    die "the runner did not come up (${answer:0:200}). If the lines above speak of the rules of the network: this machine's kernel does not let a container set them, and the runner does not start without. ${left_as_is}"
    ;;
esac
answer="$(ask_inside "${NAME}" "127.0.0.1:${PORT}/run" post)"
case "${answer}" in 401\ *) say "Without the token it runs nothing." ;; *) die "the runner took a request without the token (${answer:0:200}). ${left_as_is}" ;; esac

answer="$(docker exec "${NAME}" node /srv/selftest.mjs whoami 2> /dev/null || echo "no the question could not be asked")"
case "${answer}" in
  "ok uid=${RUN_AS%%:*} gid=${RUN_AS##*:} reads-server=no writes-outside=no has-token=no") say "With the token it runs a program: as ${RUN_AS}, which cannot read the runner's own memory or its token, and cannot write outside its folder." ;;
  ok\ *) die "a program ran, but not shut in as it should be (${answer#ok }). ${left_as_is}" ;;
  *) die "the runner did not run a program (${answer#no }). ${left_as_is}" ;;
esac

# Whether the programs are kept from private addresses: a container is started
# next to the runner that does nothing but listen, another one connects to it
# (so it is there to be reached), and then a program's user in the runner
# tries the same and must not get through.
docker rm -f "${PROBE}" > /dev/null 2>&1 || true
probe_address=""
if docker run -d --rm --name "${PROBE}" --network "${NETWORK}" --entrypoint node --cap-drop ALL --user 65534:65534 --memory 128m --read-only \
  "${IMAGE}" -e 'require("http").createServer((q, s) => s.end("probe")).listen(8099, "0.0.0.0"); setTimeout(() => process.exit(0), 120000);' > /dev/null 2>&1; then
  probe_address="$(field "${PROBE}" "{{with index .NetworkSettings.Networks \"${NETWORK}\"}}{{.IPAddress}}{{end}}")"
fi
if [ -n "${probe_address}" ]; then
  reached="no"
  for _ in 1 2 3 4 5 6; do
    reached="$(docker run --rm --network "${NETWORK}" --entrypoint node --cap-drop ALL --user 65534:65534 --memory 128m -e "XN_HOST=${probe_address}" -e XN_PORT=8099 "${IMAGE}" -e "${CONNECT}" 2> /dev/null || echo "no")"
    [ "${reached}" = "ok" ] && break
    sleep 1
  done
  answer="$(connects "${NAME}" "${probe_address}" 8099 "${RUN_AS}")"
  docker rm -f "${PROBE}" > /dev/null 2>&1 || true
  case "${answer}" in
    ok) die "a program in the runner reached a container next to it (${probe_address}:8099): the network is not closed to private addresses. ${left_as_is}" ;;
    *)
      if [ "${reached}" = "ok" ]; then
        say "Its programs do not reach a container next to it (${answer#no }), which another container does reach."
      else
        warn "containers of the network \"${NETWORK}\" do not reach each other, so whether the runner keeps its programs from private addresses could not be seen from the outside. Its own rules are in place: it does not start without them."
      fi
      ;;
  esac
else
  docker rm -f "${PROBE}" > /dev/null 2>&1 || true
  warn "no container could be started next to the runner to try its network with. Its own rules are in place: it does not start without them."
fi
gateway="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}' "${NETWORK}" 2> /dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
if [ -n "${gateway}" ]; then
  answer="$(connects "${NAME}" "${gateway}" 22 "${RUN_AS}")"
  case "${answer}" in
    ok) die "a program in the runner reached this machine itself (${gateway}:22): the network is not closed to private addresses. ${left_as_is}" ;;
    *) say "Nor this machine itself." ;;
  esac
fi

# Whether a build gets what it fetches: the places Maven and Gradle fetch
# from, asked as a program asks, a name looked up and a connection made.
answer="$(docker exec -u "${RUN_AS}" "${NAME}" node -e '
  const dns = require("dns").promises;
  const net = require("net");
  const connects = (address) => new Promise((resolve) => {
    const socket = net.connect({ host: address, port: 443, timeout: 8000 }, () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
  (async () => {
    const reached = [];
    const said = [];
    for (const host of ["repo.maven.apache.org", "plugins.gradle.org", "repo.papermc.io", "registry.npmjs.org"]) {
      let address;
      try { address = (await dns.lookup(host, { family: 4 })).address; } catch (err) { said.push(host + ": the name was not found (" + (err.code || err.message) + ")"); continue; }
      if (await connects(address)) reached.push(host); else said.push(host + ": nothing connected at " + address);
    }
    console.log(reached.length > 0 ? "ok " + reached.join(", ") + (said.length ? " (not: " + said.join("; ") + ")" : "") : "no " + said.join("; "));
  })();' 2> /dev/null || echo "no the question could not be asked")"
case "${answer}" in
  ok\ *) say "They reach the outside: ${answer#ok }." ;;
  *)
    die "the runner's programs do not reach the outside (${answer#no }), so a build could not fetch what it is built with. A name that is not found is a matter of DNS: the container looks names up $([ "${#DNS[@]}" -gt 0 ] && echo "at ${DNS[*]}" || echo "as Docker does on this machine"). Nothing that connects is a matter of the firewall of this machine or of the network \"${NETWORK}\". ${left_as_is}"
    ;;
esac

# Whether a build works: a Paper plugin as small as one gets is built with
# Gradle, the way the app has a project built, and its .jar comes back.
if [ "${BUILD_TEST}" = true ]; then
  answer="$(docker exec -e "SELFTEST_SECONDS=${MAX_SECONDS}" "${NAME}" node /srv/selftest.mjs gradle 2> /dev/null || echo "no the question could not be asked")"
  case "${answer}" in
    ok\ *) say "A build works in it: a Paper plugin was built with Gradle in ${answer#ok }." ;;
    *)
      die "a Paper plugin could not be built in the runner (${answer#no }). If the package servers of Paper cannot be reached from this machine at all, run this again with --skip-build-test. ${left_as_is}"
      ;;
  esac
  answer="$(docker exec -e "SELFTEST_SECONDS=${MAX_SECONDS}" "${NAME}" node /srv/selftest.mjs maven 2> /dev/null || echo "no the question could not be asked")"
  case "${answer}" in
    ok\ *) say "And with Maven: a jar in ${answer#ok }." ;;
    *) warn "a small Maven project could not be built in the runner (${answer#no }). Gradle builds work; a Maven project may not." ;;
  esac
fi

if [ "$(field "${UUID}" '{{.State.Running}}')" = "true" ]; then
  answer="$(ask_inside "${UUID}" "${ADDRESS}:${PORT}/health")"
  case "${answer}" in
    200\ *) say "The server's container reaches it." ;;
    *) die "the server's container does not reach the runner at ${ADDRESS}:${PORT} (${answer:2:200}). Containers of the network \"${NETWORK}\" may not be allowed to talk to each other. The server was not touched." ;;
  esac
else
  say "The server is not running now, so whether it reaches the runner is seen when it is started."
fi

SANDBOX_URL="http://${ADDRESS}:${PORT}"
printf 'SANDBOX_URL=%s\nSANDBOX_TOKEN=%s\nSANDBOX_MAX_SECONDS=%s\n' "${SANDBOX_URL}" "${TOKEN}" "${MAX_SECONDS}" > "${ENV_LINES_FILE}"
chmod 600 "${ENV_LINES_FILE}"

# ── The app ──────────────────────────────────────────────────────────────────

if [ "${CONTAINER_ONLY}" = true ]; then
  say ""
  say "The runner runs. The lines for the server's .env are in ${ENV_LINES_FILE}:"
  say "put them into ${ENV_FILE} and restart the server."
  exit 0
fi

step "The app"
restart_app "SANDBOX_URL=${SANDBOX_URL}" "SANDBOX_TOKEN=${TOKEN}" "SANDBOX_MAX_SECONDS=${MAX_SECONDS}"

say ""
say "The runner runs next to server ${UUID}, and the app is pointed at it."
say "A project whose files are a Gradle or a Maven project is built when its run ends, and"
say "its package is on the project page. To give the runner the newest packages, run this"
say "again with --rebuild now and then; --remove takes it away."
