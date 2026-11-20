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
# What node-check.sh says of the service is tested here too, on the same
# made-up host. SHOW=1 prints what the script said each time.
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
    dns:
    - 9.9.9.9
    - 149.112.112.112
    is_internal: false
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
  # What node-check.sh asks besides: which containers there are, and of a container how it is.
  version) echo "29.9.9" ;;
  ps)
    echo "${FAKE_UUID}"
    ls "${FAKE}/containers" 2> /dev/null || true
    ;;
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
    case " $* " in
      *"{{.Name}}"*)
        # Every container that was named, with its addresses: one in a line.
        shift 3
        for one in "$@"; do
          if [ "${one}" = "${FAKE_UUID}" ]; then echo "/${one} 172.18.0.5"; else echo "/${one} $(address_of "${one}")"; fi
        done
        exit 0
        ;;
    esac
    if [ "${name}" = "${FAKE_UUID}" ]; then
      [ "${FAKE_SERVER:-running}" != "none" ] || exit 1
      case " $* " in
        *"{{.Config.Image}}"*) echo "ghcr.io/ptero-eggs/yolks:nodejs_22" ;;
        *"NetworkSettings.Networks}}{{"*) printf 'pterodactyl_nw\n' ;;
        *"State.Running"*) if [ "${FAKE_SERVER:-running}" = "running" ]; then echo true; else echo false; fi ;;
        # The DNS servers Wings gave the server's container, one in a line.
        *"HostConfig.Dns"*) for one in ${FAKE_DNS-1.1.1.1 1.0.0.1}; do printf '%s\n' "${one}"; done ;;
      esac
      exit 0
    fi
    [ -f "${FAKE}/containers/${name}" ] || exit 1
    case " $* " in
      *"IPAddress"*) address_of "${name}" ;;
      *"{{.State.Status}}"*) echo "${FAKE_BROWSER_STATE:-running}" ;;
      *"{{.Config.Image}}"*) echo "xiero-browser" ;;
    esac
    ;;
  pull) [ "${FAKE_PULL:-ok}" = "ok" ] ;;
  build)
    if [ "${FAKE_BUILD:-ok}" = "needs-host" ]; then
      # A machine whose default network does not get to the package servers:
      # the build works on the machine's own network only. Said as a build says it.
      case " $* " in
        *" --network host "*) ;;
        *)
          printf '%s\n' \
            "#6 [2/5] RUN apt-get -o APT::Update::Error-Mode=any update" \
            "#6 0.21 Ign:1 http://deb.debian.org/debian bookworm InRelease" \
            "#6 20.22 Err:1 http://deb.debian.org/debian bookworm InRelease" \
            "#6 20.22   Temporary failure resolving 'deb.debian.org'" \
            "#6 20.23 W: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease  Temporary failure resolving 'deb.debian.org'" \
            "#6 20.23 E: Some index files failed to download. They have been ignored, or old ones used instead."
          for n in $(seq 1 30); do echo "#6 2${n}.00 Reading package lists..."; done
          printf '%s\n' \
            "#6 674.1 E: Unable to locate package chromium" \
            "#6 674.1 E: Unable to locate package nodejs" \
            "#6 ERROR: process \"/bin/sh -c apt-get update\" did not complete successfully: exit code: 100"
          exit 1
          ;;
      esac >&2
    elif [ "${FAKE_BUILD:-ok}" != "ok" ]; then
      echo "E: Unable to locate package chromium" >&2
      exit 1
    fi
    [ -f "${*: -1}/Dockerfile" ] && [ -f "${*: -1}/gate.mjs" ] && [ -f "${*: -1}/policy.json" ]
    ;;
  image)
    # When the image was built, for node-check.sh; how large it is, for browser-service.sh.
    case " $* " in
      *"{{.Created}}"*) echo "${FAKE_BUILT:-$(date -u +%Y-%m-%d)}T09:30:00.123456789Z" ;;
      *) printf ' (612345678 bytes)' ;;
    esac
    ;;
  rm)
    rm -f "${FAKE}/containers/${*: -1}"
    ;;
  run)
    if [ "${2:-}" = "--rm" ]; then
      # Whether a container on that network gets to the package servers:
      # FAKE_BUILD_NET says which networks do ("ok": both, "host", "none").
      case "${FAKE_BUILD_NET:-ok}:${4:-}" in ok:* | host:host) exit 0 ;; *) exit 1 ;; esac
    fi
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
    # node-check.sh asks from inside the server's container, with the address
    # its .env has: the program it hands over is run for real, by the Node of
    # this machine, on the .env of the made-up server.
    for word in "$@"; do
      case "${word}" in
        XN_ENV_FILE=/home/container/*)
          XN_ENV_FILE="${FAKE_VOLUME}/${word#XN_ENV_FILE=/home/container/}" node -e "${*: -1}"
          exit 0
          ;;
      esac
    done
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
    case " $* " in
      *" XN_PAGE="*)
        # Whether Chromium opens a page: asked for real, with the words the
        # script handed over, of a stand-in that answers as Chromium answers
        # at its own port; or, where a test wants that, what a page that the
        # gate refused looks like.
        if [ "${FAKE_PAGE:-ok}" != "ok" ]; then
          echo 'no after 20.1 s the tab is titled "Not opened", not "Example Domain"'
          exit 0
        fi
        page="" title=""
        for word in "$@"; do
          case "${word}" in XN_PAGE=*) page="${word#XN_PAGE=}" ;; XN_TITLE=*) title="${word#XN_TITLE=}" ;; esac
        done
        XN_TMP="${FAKE}/tmp" XN_PAGE="${page}" XN_TITLE="${title}" node -e "${*: -1}"
        exit 0
        ;;
      *" XN_OUTSIDE=1 "*)
        # Whether the service's container gets to the outside.
        if [ "${FAKE_OUTSIDE:-yes}" = "yes" ]; then echo "ok deb.debian.org"; else echo "no deb.debian.org: the name was not found (EAI_AGAIN); github.com: the name was not found (EAI_AGAIN); www.wikipedia.org: the name was not found (EAI_AGAIN)"; fi
        exit 0
        ;;
    esac
    # Where a test makes nothing go wrong, the question is asked for real: by
    # the Node of this machine, with the words the script handed over, of a
    # stand-in for the gate that answers at the length a Chromium answers.
    if [ -s "${FAKE}/gate-port" ] && [ "${FAKE_HEALTH:-ok}${FAKE_OPEN:-no}${FAKE_GATE:-yes}" = "oknoyes" ]; then
      asked_of="http://127.0.0.1:$(cat "${FAKE}/gate-port")/${url#http://*/}"
      if [ -n "${token}" ]; then
        XN_URL="${asked_of}" XN_TOKEN_ENV=BROWSER_TOKEN BROWSER_TOKEN="$(sed -n 's/^BROWSER_TOKEN=//p' "${FAKE}/envfile")" node -e "${*: -1}"
      else
        XN_URL="${asked_of}" node -e "${*: -1}"
      fi
      exit 0
    fi
    case "${url}" in
      */healthz) if [ "${FAKE_HEALTH:-ok}" = "ok" ]; then echo '200 {"ok":true}'; else echo '503 {"ok":false}'; fi ;;
      */json/version)
        # As a Chromium answers: what the gate adds stands at the end, hundreds of characters in.
        chrome='"Browser":"Chrome/120.0.1","Protocol-Version":"1.3","User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36","V8-Version":"12.0.267.8","WebKit-Version":"537.36 (@0123456789abcdef0123456789abcdef01234567)","webSocketDebuggerUrl":"ws://127.0.0.1:9223/devtools/browser/01234567-89ab-cdef-0123-456789abcdef"'
        if [ -z "${token}" ]; then
          if [ "${FAKE_OPEN:-no}" = "yes" ]; then echo "200 {${chrome}}"; else echo '401 {"error":"The token is missing or wrong."}'; fi
        elif [ "${FAKE_GATE:-yes}" = "yes" ]; then
          echo "200 {${chrome},\"gate\":{\"version\":1,\"egress\":\"filtered\",\"allowPrivate\":[],\"starts\":1}}"
        else
          echo "200 {${chrome}}"
        fi
        ;;
    esac
    ;;
  logs) echo "chromium could not be started" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/docker"

# A stand-in for the gate, for the questions the script asks with Node: it
# takes the token the container was given, and answers what a gate in front
# of a Chromium answers, at that length.
cat > "${WORK}/gate.js" << 'EOF'
const http = require("http");
const fs = require("fs");
const chrome = {
  Browser: "Chrome/120.0.1",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  "V8-Version": "12.0.267.8",
  "WebKit-Version": "537.36 (@0123456789abcdef0123456789abcdef01234567)",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/01234567-89ab-cdef-0123-456789abcdef",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gate");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };
  let token = "";
  try {
    token = (/^BROWSER_TOKEN=(.*)$/m.exec(fs.readFileSync(`${process.env.FAKE}/envfile`, "utf8")) || [])[1] || "";
  } catch {
    // No container was started yet.
  }
  if (url.pathname === "/healthz") return send(200, { ok: true });
  // What Chromium answers at its own port: a tab is opened, listed with the
  // title its page has, and closed.
  if (url.pathname === "/json/new") {
    if (req.method !== "PUT") return send(405, { error: "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb." });
    fs.appendFileSync(`${process.env.FAKE}/tabs`, `opened ${url.search.slice(1)}\n`);
    return send(200, { id: "TAB1", title: "", url: url.search.slice(1) });
  }
  if (url.pathname === "/json/list") return send(200, [{ id: "OTHER", title: "about:blank" }, { id: "TAB1", title: "Example Domain", url: "https://example.com/" }]);
  if (url.pathname.startsWith("/json/close/")) {
    fs.appendFileSync(`${process.env.FAKE}/tabs`, `closed ${url.pathname.slice(12)}\n`);
    return send(200, { ok: true });
  }
  if (url.pathname !== "/json/version") return send(404, { error: "not found" });
  if (!token || url.searchParams.get("token") !== token) return send(401, { error: "The token is missing or wrong." });
  send(200, { ...chrome, gate: { version: 1, egress: "filtered", allowPrivate: [], starts: 1 } });
});
server.listen(0, "127.0.0.1", () => {
  // Where Chromium writes the port it chose: into its profile, under the temporary folder.
  fs.mkdirSync(`${process.env.FAKE}/tmp/profile`, { recursive: true });
  fs.writeFileSync(`${process.env.FAKE}/tmp/profile/DevToolsActivePort`, `${server.address().port}\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef\n`);
  fs.writeFileSync(`${process.env.FAKE}/gate-port`, String(server.address().port));
});
EOF
FAKE="${FAKE}" node "${WORK}/gate.js" &
GATE_PID=$!
trap 'kill "${GATE_PID}" 2> /dev/null || true; rm -rf "${WORK}"' EXIT
for _ in $(seq 1 50); do
  [ -s "${FAKE}/gate-port" ] && break
  sleep 0.1
done
[ -s "${FAKE}/gate-port" ] || { echo "error: the stand-in for the gate did not start." >&2; exit 1; }

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
check "names are looked up as the server's container looks them up" line "Names +are looked up as the server's container does: 1\.1\.1\.1 1\.0\.0\.1$"
check "the image is built on Docker's default network, or on the machine's own where only that gets out" said "built on Docker's default network, or on this machine's own where only that reaches Debian's package servers"
check "what happens to the app" said "BROWSER_URL is written into ${WORK}/volumes/${UUID}/xiero-nexus-ai/.env, and the server is started again"
check "  with the version that is installed" said "with version 1.8.0-rc.5 (the one that is installed, put in place again)"
check "it says that nothing was changed" said "Dry run: nothing was changed."
check_not "nothing was fetched, built, started or removed" asked '^(pull|build|run|rm|exec) '
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
check "  after asking whether Docker's default network gets to the package servers, with the image the build starts from" asked "^run --rm --network bridge debian:bookworm-slim timeout 15 bash -c "
check_not "  which it does here: the machine's own network is not asked about" asked '^run --rm --network host '
RUN="$(cat "${FAKE}/run" 2> /dev/null || true)"
has() { case " ${RUN} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
check "the container is on the server's network, at its own address" has "--network pterodactyl_nw --ip 172.18.255.250"
check "  it looks names up at the DNS servers of the server's container" has "--ip 172.18.255.250 --dns 1.1.1.1 --dns 1.0.0.1"
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
check "  (asked for real, of a stand-in that answers at the length a Chromium does)" test "$(XN_URL="http://127.0.0.1:$(cat "${FAKE}/gate-port")/json/version?token=${TOKEN}" node -e 'require("http").get(process.env.XN_URL, (res) => { let n = 0; res.on("data", (d) => (n += d.length)); res.on("end", () => console.log(n > 400 ? "long" : "short")); })')" = "long"
check "  " said "Without the token it lets nobody in."
check "  " said "With the token it does, and it keeps pages from private networks: Chrome/120.0.1."
check "  whether it reaches the outside" said "It reaches the outside (deb.debian.org)."
check "  whether its Chromium opens a page" line "^Its Chromium opens a page: https://example\.com/ came up in [0-9.]+ s\.$"
check "    asked of Chromium at the port it chose: a tab on that page, and closed again" test "$(tr '\n' ' ' < "${FAKE}/tabs")" = "opened https://example.com/ closed TAB1 "
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

begin "A machine whose default network does not get to the package servers"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_BUILD_NET=host FAKE_BUILD=needs-host run --server "${UUID}" --yes
is "the image is built all the same" "0" "${CODE}"
check "  both networks were asked about, the default one first" test "$(grep -E '^run --rm --network ' "${FAKE}/log" | cut -d ' ' -f 4 | tr '\n' ' ')" = "bridge host "
check "  it says what it found" said "Docker's default network does not reach Debian's package servers from this machine; the machine's own network does."
check "  and built on the machine's own network" asked "^build --pull -t xiero-browser --network host ${here%/test}/browser$"
RUN="$(cat "${FAKE}/run" 2> /dev/null || true)"
check "  the container is on the server's network as ever, not on the machine's" has "--network pterodactyl_nw --ip 172.18.255.250"
check_not "  " has "--network host"
check "  and the app is pointed at it" upgraded "BROWSER_URL=http://172.18.255.250:9223/?token=${TOKEN}"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_BUILD_NET=none FAKE_BUILD=needs-host run --server "${UUID}" --yes
is "a machine that does not get there on either: the build is tried, and fails" "1" "${CODE}"
check "  it says beforehand that neither gets there" said "neither Docker's default network nor this machine's own reaches deb.debian.org just now"
check "  what the package tool said first is shown under its own heading" said "What the package tool said first:"
check "    each line once, without the counters of the build" test "$(grep -cx "W: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease  Temporary failure resolving 'deb.debian.org'" "${OUT}")" = "1"
check "    the errors among them" grep -qx "E: Some index files failed to download. They have been ignored, or old ones used instead." "${OUT}"
check_not "    though the end of what the build said no longer shows them" grep -q "^#6 20.23 W: Failed to fetch" "${OUT}"
check "  and the end of what the build said" said "did not complete successfully: exit code: 100"
check "  with the way out" said "run this again with --build-network host"
check_not "  no container was started" asked '^run -d '
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_BUILD_NET=host FAKE_BUILD=needs-host run --server "${UUID}" --yes --build-network host
is "--build-network host builds there without asking" "0" "${CODE}"
check_not "  " asked '^(pull|run --rm) '
check "  " asked "^build --pull -t xiero-browser --network host "
check "  and the plan says so" said "built on this machine's own network (--build-network host)"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_BUILD_NET=host FAKE_BUILD=needs-host run --server "${UUID}" --yes --build-network default
is "--build-network default builds on Docker's network without asking, whatever comes of it" "1" "${CODE}"
check_not "  " asked '^(pull|run --rm) '
check_not "  " asked '^build .*--network host'
FAKE_PULL=fails run --server "${UUID}" --yes
is "an image to start from that cannot be fetched now: nothing is asked, and the build is tried" "0" "${CODE}"
check_not "  " asked '^run --rm '
check "  " asked "^build --pull -t xiero-browser ${here%/test}/browser$"
run --server "${UUID}" --build-network elsewhere --dry-run
is "a network to build on that is neither" "1" "${CODE}"

begin "Where names are looked up"
FAKE_DNS="" run --server "${UUID}" --yes
is "a server's container that was given no DNS servers" "0" "${CODE}"
check "  the ones of the Wings configuration are taken" line "Names +are looked up as the Wings configuration says: 9\.9\.9\.9 149\.112\.112\.112$"
RUN="$(cat "${FAKE}/run")"
check "  " has "--dns 9.9.9.9 --dns 149.112.112.112"
FAKE_SERVER=none run --server "${UUID}" --dry-run
check "a server whose container is not there: the same" line "Names +are looked up as the Wings configuration says: 9\.9\.9\.9 149\.112\.112\.112$"
FAKE_DNS="1.1.1.1 not-an-address --privileged 2606:4700:4700::1111" run --server "${UUID}" --yes
RUN="$(cat "${FAKE}/run")"
check "what is no address is not handed to Docker" has "--dns 1.1.1.1 --dns 2606:4700:4700::1111 --memory"
check_not "  " has "--privileged"
cp "${WORK}/wings.yml" "${WORK}/wings.keep"
grep -v -e 'dns:' -e '^    - ' "${WORK}/wings.keep" > "${WORK}/wings.yml"
FAKE_DNS="" run --server "${UUID}" --yes
is "no DNS servers anywhere: Docker decides" "0" "${CODE}"
check "  and that is said" line "Names +are looked up as Docker does on this machine$"
RUN="$(cat "${FAKE}/run")"
check_not "  " has "--dns"
printf 'token: node-token\nsystem:\n  data: %s\ndocker:\n  network:\n    name: pterodactyl_nw\n    dns: [8.8.8.8, "8.8.4.4"]\n' "${WORK}/volumes" > "${WORK}/wings.yml"
FAKE_DNS="" run --server "${UUID}" --dry-run
check "a list written in one line is read too" line "Names +are looked up as the Wings configuration says: 8\.8\.8\.8 8\.8\.4\.4$"
mv "${WORK}/wings.keep" "${WORK}/wings.yml"

begin "What stops it, with the server left alone"
rm -f "${FAKE}/containers/xiero-browser"
FAKE_BUILD=fails run --server "${UUID}" --yes
is "an image that cannot be built" "1" "${CODE}"
check "  with what the build said" said "Unable to locate package chromium"
check_not "    once, where it is short" said "What the package tool said first:"
check "  " said "the image could not be built. Nothing else was changed."
check_not "  no container was started" asked '^run -d '
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
FAKE_GATE=no run --server "${UUID}" --yes
is "something at that port that takes the token and is not the gate" "1" "${CODE}"
check "  is said" said "does not say that it keeps pages from private networks"
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_PAGE=no run --server "${UUID}" --yes
is "a Chromium that does not open a page" "1" "${CODE}"
check "  is said, with what the tab showed" said 'Chromium did not open https://example.com/ (after 20.1 s the tab is titled "Not opened", not "Example Domain").'
check "  where to look, and the way around it" said "docker logs xiero-browser"
check "  " said "run this again with --skip-page-test"
check_not "  the server was not touched" test -e "${FAKE}/upgrade"
FAKE_PAGE=no run --server "${UUID}" --yes --skip-page-test
is "--skip-page-test does not ask for the page" "0" "${CODE}"
check_not "  " asked 'XN_PAGE='
check_not "  " said "opens a page"
FAKE_OUTSIDE=no run --server "${UUID}" --yes
is "a service whose container does not get to the outside" "1" "${CODE}"
check "  is said, with what it tried" said "the browser's container does not reach the outside (deb.debian.org: the name was not found (EAI_AGAIN); github.com:"
check "  what that means, and where it looks names up" said "so pages would not load. A name that is not found is a matter of DNS: the container looks names up at 1.1.1.1 1.0.0.1."
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

# ── What node-check.sh says of it ────────────────────────────────────────────

begin "node-check.sh says how the browser service is"
run --server "${UUID}" --yes
is "(the service is set up)" "0" "${CODE}"
app="${WORK}/volumes/${UUID}/xiero-nexus-ai"
echo "// start" > "${app}/start.js"
echo "// server" > "${app}/server.js"
# The stand-in for the gate listens on this machine: that is where the made-up server's .env points, and where the container "is".
gate_at="127.0.0.1:$(cat "${FAKE}/gate-port")"
printf '127.0.0.1' > "${FAKE}/containers/xiero-browser"
env_with() { printf 'APP_URL=https://nexus.example.com\nSECRET_ENCRYPTION_KEY=kept\n%s\n' "$1" > "${app}/.env"; }
looked() { # settings of the stand-in for docker, then nothing: node-check.sh on the made-up server
  CODE=0
  : > "${FAKE}/log"
  FAKE_VOLUME="${WORK}/volumes/${UUID}" XIERO_RELEASES_URL="http://127.0.0.1:1/releases" bash "${here}/../node-check.sh" --server "${UUID}" --wings-config "${WORK}/wings.yml" --backup-dir "${WORK}/backups" > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/     /' "${OUT}"; fi
}
env_with "BROWSER_URL=http://${gate_at}/?token=$(token)"
looked
is "it ends well" "0" "${CODE}"
check "where BROWSER_URL of .env points, without what signs in" line "^  Browser +BROWSER_URL in \.env names ${gate_at}$"
check "the container that is there, how it is, and when its image was built" said "container xiero-browser: running, image xiero-browser (built $(date -u +%Y-%m-%d))"
check "the server's container reaches it and its token is taken: asked for real, from where the app asks" said "the server's container reaches it, and it takes the token of .env: Chrome/120.0.1"
check "  that it keeps pages from private networks" said "it keeps pages from private networks"
check_not "  an image of today is not called old" said "as old as the image"
check_not "the token is not shown" said "$(token)"
check_not "  nor handed to a program of this machine" asked "$(token)"
check_not "nothing was started, stopped, built or removed" asked '^(run|rm|build|pull|stop|start|restart) '
check ".env still names it among what it sets, and no value" line '^  \.env +sets: APP_URL BROWSER_URL SECRET_ENCRYPTION_KEY$'

env_with "BROWSER_URL=\"http://${gate_at}/?token=not-the-token-of-the-service\""
looked
check "a token the service does not take is said, and what puts it right" said "the server's container reaches it, and it does NOT take the token of .env: the action \"browser\" writes the one it has"
check_not "  without the token" said "not-the-token-of-the-service"
# Another address of this machine, and a port that was free a moment ago: nothing answers there, and no container is there.
free_port="$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')"
env_with "BROWSER_URL=http://127.0.0.2:${free_port}/?token=$(token)"
looked
check "an address where nothing answers: the server does not reach it, and why" said "the server's container does NOT reach it (ECONNREFUSED): agents have no browser until it does"
check "  and no container has that address" said "no container of this machine has that address"
check_not "  nothing is said of a token that was never asked for" said "the token of .env"
env_with "BROWSER_URL=http://${gate_at}/?token=$(token)"
FAKE_BUILT="2026-01-05" looked
check "an image that is old: how old, and how its Chromium gets its updates" line "Its Chromium is as old as the image, [0-9]+ days: the action \"browser\" with --rebuild in options builds it anew"
FAKE_BROWSER_STATE=exited looked
check "a container that does not run is said" said "container xiero-browser: exited"
check "  with what starts it" said "It does not run: the action \"browser\" starts it again."
FAKE_SERVER=stopped looked
check "a server that is not running is not asked" said "The server is not running: whether it reaches the service is seen when it runs."
check_not "  " said "takes the token"
env_with "BROWSER_URL=ws://${gate_at}/devtools/browser/0123"
looked
check "a DevTools address is named, and not asked" said "BROWSER_URL is a DevTools address (ws://), which is not asked here"
env_with "BROWSER_URL="
looked
check "a server without a browser service: said, with what sets one up" said "none: .env names no browser service (BROWSER_URL), so agents have no browser to work in"
check "  " said "The action \"browser\" sets one up next to the server (browser-service.sh)."
check_not "  the server's container is not asked for it" asked 'XN_ENV_FILE'
env_with "#BROWSER_URL=http://${gate_at}/?token=$(token)"
looked
check "  a line that is commented out names none either" said "none: .env names no browser service"
# As it was for the checks that follow.
printf 'APP_URL=https://nexus.example.com\nSECRET_ENCRYPTION_KEY=kept\n' > "${app}/.env"
printf '172.18.255.250' > "${FAKE}/containers/xiero-browser"
rm -f "${app}/start.js" "${app}/server.js"

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
