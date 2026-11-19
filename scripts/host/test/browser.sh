#!/usr/bin/env bash
# Tests of browser-service.sh, on a made-up Wings host in a temporary folder:
# a server's files, a Wings configuration, a stand-in for docker that keeps
# what it was asked and answers as a host with one server does, and a
# stand-in for pterodactyl-upgrade.sh that says what it was called with.
#
#   bash scripts/host/test/browser.sh
#
# Nothing is built and no container is started: that the image builds and the
# service in it works is checked with a real Docker in CI (release.yml).
# SHOW=1 prints what the script said each time.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../browser-service.sh"
UUID="0a11ce00-1111-4222-8333-444455556666"
OTHER="0b0b0b0b-1111-4222-8333-444455556666"

WORK="$(mktemp -d)"
OUT="${WORK}/out.txt"
FAKE="${WORK}/fake"
passed=0
failed=0
failures=()
trap 'rm -rf "${WORK}"' EXIT

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
is() { # NAME WANTED GOT
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "wanted \"$2\", got \"$3\""; fi
}
said() { grep -qF -- "$1" "${OUT}"; }
line() { grep -qE -- "$1" "${OUT}"; }
asked() { grep -qE -- "$1" "${FAKE}/log"; }
upgraded() { grep -qF -- "$1" "${FAKE}/upgrade" 2> /dev/null; }

# ── A made-up host ───────────────────────────────────────────────────────────

mkdir -p "${WORK}/volumes/${UUID}/xiero-nexus-ai" "${WORK}/volumes/${OTHER}" "${WORK}/bin" "${FAKE}/containers"
printf 'version=1.8.0-rc.5\ncommit=abcdef0\nnode=22\n' > "${WORK}/volumes/${UUID}/xiero-nexus-ai/VERSION"
printf 'APP_URL=https://nexus.example.com\nSECRET_ENCRYPTION_KEY=kept\n' > "${WORK}/volumes/${UUID}/xiero-nexus-ai/.env"
cat > "${WORK}/wings.yml" << EOF
token: node-token
system:
  data: ${WORK}/volumes
docker:
  network:
    name: pterodactyl_nw
    interface: 172.18.0.1
EOF

# docker, as this script uses it. What exists is a file in ${FAKE}/containers:
# its name is the container's, its content the address.
cat > "${WORK}/bin/docker" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE}/log"
address_of() { cat "${FAKE}/containers/$1" 2> /dev/null || true; }
case "${1:-}" in
  info) [ "${FAKE_NO_DOCKER:-}" != "yes" ] ;;
  network)
    [ "${2:-}" = "inspect" ] || exit 1
    name="${*: -1}"
    [ "${name}" = "pterodactyl_nw" ] || exit 1
    case " $* " in
      *"{{.Driver}}"*) echo "${FAKE_DRIVER:-bridge}" ;;
      *"IPAM.Config"*) printf '%s\n' "${FAKE_SUBNET-172.18.0.0/16}" ;;
    esac
    ;;
  inspect)
    name="${*: -1}"
    if [ "${name}" = "${FAKE_UUID}" ]; then
      [ "${FAKE_SERVER:-running}" != "none" ] || exit 1
      case " $* " in
        *"NetworkSettings.Networks}}{{"*) printf 'pterodactyl_nw\n' ;;
        *"State.Running"*) if [ "${FAKE_SERVER:-running}" = "running" ]; then echo true; else echo false; fi ;;
      esac
      exit 0
    fi
    [ -f "${FAKE}/containers/${name}" ] || exit 1
    case " $* " in *"IPAddress"*) address_of "${name}" ;; esac
    ;;
  build)
    [ "${FAKE_BUILD:-ok}" = "ok" ] || { echo "E: Unable to locate package chromium" >&2; exit 1; }
    [ -f "${*: -1}/Dockerfile" ] && [ -f "${*: -1}/gate.mjs" ] && [ -f "${*: -1}/policy.json" ]
    ;;
  image) printf ' (612345678 bytes)' ;;
  rm)
    rm -f "${FAKE}/containers/${*: -1}"
    ;;
  run)
    name="" address="" envfile=""
    words=("$@")
    for i in "${!words[@]}"; do
      case "${words[$i]}" in
        --name) name="${words[$((i + 1))]}" ;;
        --ip) address="${words[$((i + 1))]}" ;;
        --env-file) envfile="${words[$((i + 1))]}" ;;
      esac
    done
    if [ -n "${address}" ] && [ "${FAKE_STATIC:-ok}" = "refused" ]; then
      echo "docker: Error response from daemon: user specified IP address is supported only when connecting to networks with user configured subnets." >&2
      exit 125
    fi
    if [ -n "${address}" ] && [ "${address}" = "${FAKE_TAKEN:-}" ]; then
      echo "docker: Error response from daemon: Address already in use." >&2
      exit 125
    fi
    [ "${FAKE_RUN:-ok}" = "ok" ] || { echo "docker: Error response from daemon: no space left on device." >&2; exit 125; }
    printf '%s' "${address:-172.18.0.9}" > "${FAKE}/containers/${name}"
    printf '%s\n' "$*" > "${FAKE}/run"
    cp "${envfile}" "${FAKE}/envfile"
    echo "0123456789abcdef"
    ;;
  exec)
    # What is asked from inside a container: the address in XN_URL, with the token when XN_TOKEN_ENV says so.
    url="" token="" name=""
    words=("$@")
    for i in "${!words[@]}"; do
      case "${words[$i]}" in
        XN_URL=*) url="${words[$i]#XN_URL=}" ;;
        XN_TOKEN_ENV=*) token="yes" ;;
        node) name="${words[$((i - 1))]}" ;;
      esac
    done
    if [ "${name}" = "${FAKE_UUID}" ]; then
      if [ "${FAKE_REACH:-yes}" = "yes" ]; then echo '200 {"ok":true}'; else echo "0 connect ETIMEDOUT ${url#http://}"; fi
      exit 0
    fi
    case "${url}" in
      */healthz) if [ "${FAKE_HEALTH:-ok}" = "ok" ]; then echo '200 {"ok":true}'; else echo '503 {"ok":false}'; fi ;;
      */json/version)
        if [ -z "${token}" ]; then
          if [ "${FAKE_OPEN:-no}" = "yes" ]; then echo '200 {"Browser":"Chrome/120.0.1"}'; else echo '401 {"error":"The token is missing or wrong."}'; fi
        else
          echo '200 {"Browser":"Chrome/120.0.1","gate":{"version":1,"egress":"filtered"}}'
        fi
        ;;
    esac
    ;;
  logs) echo "chromium could not be started" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/docker"

# pterodactyl-upgrade.sh: says what it was called with, and ends as the test says.
cat > "${WORK}/upgrade.sh" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${FAKE}/upgrade"
echo "==> The plan"
echo "  Setting     BROWSER_URL=(as pterodactyl-upgrade.sh prints it)"
echo "==> Version is running and answers"
exit "${FAKE_UPGRADE:-0}"
EOF

export PATH="${WORK}/bin:${PATH}" FAKE FAKE_UUID="${UUID}" XIERO_UPGRADE_SCRIPT="${WORK}/upgrade.sh" XIERO_BROWSER_TRIES=2 XIERO_BROWSER_GAP=0
STATE="${WORK}/state"
CODE=0
run() { # options of the script
  CODE=0
  : > "${FAKE}/log"
  rm -f "${FAKE}/upgrade" "${FAKE}/run"
  bash "${script}" --wings-config "${WORK}/wings.yml" --state-dir "${STATE}" "$@" > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ -n "${SHOW:-}" ]; then
    printf '   $ browser-service.sh %s  → %s\n' "$*" "${CODE}"
    sed 's/^/     /' "${OUT}"
  fi
}
token() { sed -n 's/^BROWSER_TOKEN=//p' "${STATE}/${UUID}/container.env" 2> /dev/null; }
mode() { stat -c '%a' "$1" 2> /dev/null || stat -f '%Lp' "$1"; }

# ── The plan ─────────────────────────────────────────────────────────────────

begin "The plan changes nothing"
run --server "${UUID:0:8}" --dry-run
is "it ends well" "0" "${CODE}"
check "it names the server and the version that is installed" line "Server +${UUID}"
check "  " line "App +${WORK}/volumes/${UUID}/xiero-nexus-ai \(version 1\.8\.0-rc\.5\)"
check "the network the server's container is on, as Docker says it" line "Network +pterodactyl_nw \(172\.18\.0\.0/16\)"
check "an address of its own near the end of that network" said "at 172.18.255.250:9223 on that network"
check "nothing is published, and the limits are said" said "not published to this machine or to the outside"
check "  " said "1g of memory, 1.5 processors; no rights of root; a read-only file system"
check "pages cannot reach private networks" line "Pages +cannot reach private networks$"
check "what happens to the app" said "BROWSER_URL is written into ${WORK}/volumes/${UUID}/xiero-nexus-ai/.env, and the server is started again"
check "  with the version that is installed" said "with version 1.8.0-rc.5 (the one that is installed, put in place again)"
check "it says that nothing was changed" said "Dry run: nothing was changed."
check_not "nothing was built, started or removed" asked '^(build|run|rm|exec) '
check_not "no token was made" test -e "${STATE}"
check_not "the server was not touched" test -e "${FAKE}/upgrade"

begin "What it does not start with"
run --server deadbeef --dry-run
is "a server that is not there" "1" "${CODE}"
check "  is said" said 'no server "deadbeef" has files in'
run --server "${OTHER:0:8}" --dry-run
is "a server without the app" "1" "${CODE}"
check "  is said" said "has no bundle of the app"
run --dry-run
check "without --server, the one server that has the app is taken" line "Server +${UUID}"
run --server "${UUID}" --memory lots --dry-run
is "a memory limit that is none" "1" "${CODE}"
run --server "${UUID}" --port 80 --dry-run
is "a port for root only" "1" "${CODE}"
run --server "${UUID}" --allow-private 'a.example;rm -rf /' --dry-run
is "hosts that are none" "1" "${CODE}"
FAKE_NO_DOCKER=yes run --server "${UUID}" --dry-run
is "a machine whose Docker does not answer" "1" "${CODE}"
check "  is said" said "the Docker daemon does not answer"
FAKE_DRIVER=host run --server "${UUID}" --dry-run
is "a network that is no bridge" "1" "${CODE}"
check "  is said" said 'is of the kind "host"'
run --server "${UUID}"
is "without --yes and without a terminal it does not start" "1" "${CODE}"
check "  and says how" said "run it with --yes, or in a terminal"
check_not "  nothing was built" asked '^build '

# ── Setting it up ────────────────────────────────────────────────────────────

begin "Setting it up"
run --server "${UUID}" --yes
is "it ends well" "0" "${CODE}"
check "the image is built from what is next to the script, with the newest base" asked "^build --pull -t xiero-browser ${here%/test}/browser$"
RUN="$(cat "${FAKE}/run" 2> /dev/null || true)"
has() { case " ${RUN} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
check "the container is on the server's network, at its own address" has "--network pterodactyl_nw --ip 172.18.255.250"
check "  started again with Docker" has "--restart unless-stopped"
check "  with a limit on memory, processors and processes" has "--memory 1g --memory-swap 1g --cpus 1.5 --pids-limit 512"
check "  a read-only file system, and what it writes kept in memory" has "--read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m,mode=1777"
check "  no rights of root, and none to gain" has "--cap-drop ALL --security-opt no-new-privileges"
check_not "  nothing is published" eval 'case " ${RUN} " in *" -p "* | *" --publish "* | *" -P "* | *" --network host "* | *" --privileged "*) true ;; *) false ;; esac'
TOKEN="$(token)"
check "a token of 48 characters was made" test "${#TOKEN}" -eq 48
check "  kept where only root reads it" test "$(mode "${STATE}/${UUID}/container.env")" = "600"
check "  " test "$(mode "${STATE}/${UUID}")" = "700"
check "  handed to the container in a file, not on the command line" has "--env-file ${STATE}/${UUID}/container.env"
check_not "  " eval 'case "$(cat "${FAKE}/log")" in *"${TOKEN}"*) true ;; *) false ;; esac'
check "  the container got it" grep -qx "BROWSER_TOKEN=${TOKEN}" "${FAKE}/envfile"
check "it looks whether Chromium runs, whether the token is asked for, and whether it is taken" said "Chromium is running in it."
check "  " said "Without the token it lets nobody in."
check "  " said "With the token it does, and it keeps pages from private networks: Chrome/120.0.1."
check "  and whether the server's container reaches it" said "The server's container reaches it."
check "  asked from inside that container, at the service's address" asked "^exec -e XN_URL=http://172.18.255.250:9223/healthz ${UUID} node "
check "the server is restarted with the address of the service in its .env" upgraded "BROWSER_URL=http://172.18.255.250:9223/?token=${TOKEN}"
is "  by pterodactyl-upgrade.sh, with the installed version put in place again" "--server ${UUID} --version 1.8.0-rc.5 --force --yes --set BROWSER_URL=http://172.18.255.250:9223/?token=${TOKEN} --wings-config ${WORK}/wings.yml" "$(tr '\n' ' ' < "${FAKE}/upgrade" | sed 's/ $//')"
check "  what that script said is passed on" said "==> Version is running and answers"
check_not "the token is in nothing this script said" said "${TOKEN}"
check "the line for .env is kept for root" test "$(cat "${STATE}/${UUID}/browser-url")" = "BROWSER_URL=http://172.18.255.250:9223/?token=${TOKEN}"
check "  " test "$(mode "${STATE}/${UUID}/browser-url")" = "600"
check "it ends by saying what there is now, and how to update and remove it" said "run this again with --rebuild now and then; --remove takes it away."

begin "Running it again"
run --server "${UUID}" --yes --rebuild --version 1.8.0 --memory 768m --cpus 1 --allow-private shop.internal,10.0.0.5
is "it ends well" "0" "${CODE}"
is "the token is the one there was" "${TOKEN}" "$(token)"
check "the plan says that the container is replaced" said "(there is one: it is replaced), at 172.18.255.250:9223"
check "  and that the token is kept" said "the one that is kept in ${STATE}/${UUID}"
check "the container that was there is removed first" asked '^rm -f xiero-browser$'
check "--rebuild builds without what was built before" asked '^build --pull -t xiero-browser --no-cache '
RUN="$(cat "${FAKE}/run")"
check "it keeps its address" has "--ip 172.18.255.250"
check "the limits are the ones that were asked for" has "--memory 768m --memory-swap 768m --cpus 1"
check "hosts on a private network that pages may reach are handed on" has "ALLOW_PRIVATE_HOSTS=shop.internal,10.0.0.5"
check "  and said in the plan" line "Pages +cannot reach private networks, except shop.internal,10.0.0.5"
check "--version is the version the server is restarted with" upgraded "1.8.0"
check_not "  " upgraded "1.8.0-rc.5"

begin "An address that is taken, and a network that gives none"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_TAKEN=172.18.255.250 run --server "${UUID}" --yes
is "the next address is tried" "0" "${CODE}"
check "  " said "The container xiero-browser runs at 172.18.255.249:9223 on pterodactyl_nw."
check "  and that is what the app is given" upgraded "BROWSER_URL=http://172.18.255.249:9223/?token=${TOKEN}"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_STATIC=refused run --server "${UUID}" --yes
is "a network that takes no address of one's choosing: Docker chooses" "0" "${CODE}"
check "  with a warning that it can change" said "Docker chose the address 172.18.0.9. It can change when Docker is restarted"
check "  " upgraded "BROWSER_URL=http://172.18.0.9:9223/?token=${TOKEN}"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_SUBNET=192.168.77.0/24 run --server "${UUID}" --dry-run
check "a smaller network: an address near its end" said "at 192.168.77.250:9223"
FAKE_SUBNET="" run --server "${UUID}" --dry-run
check "a network that says nothing of its addresses: Docker's choice, and said" said "at an address Docker chooses:9223"

begin "What stops it, with the server left alone"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_BUILD=fails run --server "${UUID}" --yes
is "an image that cannot be built" "1" "${CODE}"
check "  with what the build said" said "Unable to locate package chromium"
check "  " said "the image could not be built. Nothing else was changed."
check_not "  no container was started" asked '^run '
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_RUN=fails run --server "${UUID}" --yes
is "a container that cannot be started" "1" "${CODE}"
check "  with what Docker said" said "no space left on device"
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_HEALTH=bad run --server "${UUID}" --yes
is "a Chromium that does not come up" "1" "${CODE}"
check "  with what the container said" said "chromium could not be started"
check "  " said "the browser service did not come up"
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_OPEN=yes run --server "${UUID}" --yes
is "a service that answers without the token" "1" "${CODE}"
check "  " said "the service answered a question without the token"
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_REACH=no run --server "${UUID}" --yes
is "a server whose container does not reach the service" "1" "${CODE}"
check "  is said, with what may be in the way" said "the server's container does not reach the service at 172.18.255.250:9223 (connect ETIMEDOUT 172.18.255.250:9223/healthz). Containers of the network \"pterodactyl_nw\" may not be allowed to talk to each other."
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_UPGRADE=1 run --server "${UUID}" --yes
is "a server that does not come up again: this ends as pterodactyl-upgrade.sh did" "1" "${CODE}"
check_not "  and does not say that all is well" said "the app is pointed at it"

begin "A server that is not running, and a container alone"
FAKE_SERVER=stopped run --server "${UUID}" --yes
is "a server that is stopped is set up all the same" "0" "${CODE}"
check "  and it is said what could not be looked at" said "The server is not running now, so whether it reaches the service is seen when it is started."
FAKE_SERVER=none run --server "${UUID}" --yes
is "a server whose container is not there: the network of the Wings configuration" "0" "${CODE}"
RUN="$(cat "${FAKE}/run")"
check "  " has "--network pterodactyl_nw"
run --server "${UUID}" --yes --container-only
is "--container-only ends well" "0" "${CODE}"
check_not "  the server is left alone" test -e "${FAKE}/upgrade"
check "  and it is said where the line for its .env is" said "The line for the server's .env is in ${STATE}/${UUID}/browser-url"
check_not "  not the line itself" said "$(token)"

begin "Taking it away"
run --server "${UUID}" --remove --dry-run
check "the plan of --remove" said "xiero-browser: is removed"
check "  " said "BROWSER_URL is emptied in"
check_not "  changes nothing" asked '^rm '
run --server "${UUID}" --remove --yes
is "it ends well" "0" "${CODE}"
check "the container is removed" asked '^rm -f xiero-browser$'
check_not "  " test -e "${FAKE}/containers/xiero-browser"
check "the token is forgotten" test ! -e "${STATE}/${UUID}/container.env"
is "the server is restarted without the address" "--server ${UUID} --version 1.8.0-rc.5 --force --yes --set BROWSER_URL= --wings-config ${WORK}/wings.yml" "$(tr '\n' ' ' < "${FAKE}/upgrade" | sed 's/ $//')"
check "it says what follows" said 'Agents are not handed the tool "Work in a browser" until there is one again.'
run --server "${UUID}" --remove --yes
is "taking away what is not there ends well too" "0" "${CODE}"
check "  " said "xiero-browser: is not there"

printf '\n%s passed, %s failed (the browser service on a made-up host)\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  printf '\nFailed:\n'
  for name in "${failures[@]}"; do printf '  - %s\n' "${name}"; done
  exit 1
fi
