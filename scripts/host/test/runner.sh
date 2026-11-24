#!/usr/bin/env bash
# Tests of runner-service.sh, on a made-up Wings host in a temporary folder:
# a server's files, a Wings configuration, a stand-in for docker that keeps
# what it was asked and answers as a host with one server does, and a
# stand-in for pterodactyl-upgrade.sh that says what it was called with.
#
#   bash scripts/host/test/runner.sh
#
# Nothing is built and no container is started: that the image builds, that
# the runner in it shuts its programs in, and that a Paper plugin builds
# there, is checked with a real Docker in CI (test/runner-container.sh).
# SHOW=1 prints what the script said each time.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../runner-service.sh"
UUID="0a11ce00-1111-4222-8333-444455556666"

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
asked() { grep -qE -- "$1" "${FAKE}/log"; }
started_with() { grep -qF -- "$1" "${FAKE}/run"; }
upgraded() { grep -qF -- "$1" "${FAKE}/upgrade" 2> /dev/null; }

# ── A made-up host ───────────────────────────────────────────────────────────

mkdir -p "${WORK}/volumes/${UUID}/xiero-nexus-ai" "${WORK}/bin" "${FAKE}/containers"
printf 'version=1.12.0\ncommit=abcdef0\nnode=22\n' > "${WORK}/volumes/${UUID}/xiero-nexus-ai/VERSION"
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
  network)
    [ "${2:-}" = "inspect" ] || exit 1
    [ "${*: -1}" = "pterodactyl_nw" ] || exit 1
    case " $* " in
      *"{{.Driver}}"*) echo "bridge" ;;
      *".Subnet"*) printf '%s\n' "${FAKE_SUBNET-172.18.0.0/16}" ;;
      *".Gateway"*) printf '%s\n' "172.18.0.1" ;;
    esac
    ;;
  inspect)
    name="${*: -1}"
    if [ "${name}" = "${FAKE_UUID}" ]; then
      case " $* " in
        *"NetworkSettings.Networks}}{{"*) printf 'pterodactyl_nw\n' ;;
        *"State.Running"*) if [ "${FAKE_SERVER:-running}" = "running" ]; then echo true; else echo false; fi ;;
        *"HostConfig.Dns"*) for one in ${FAKE_DNS-1.1.1.1 1.0.0.1}; do printf '%s\n' "${one}"; done ;;
      esac
      exit 0
    fi
    [ -f "${FAKE}/containers/${name}" ] || exit 1
    case " $* " in
      *"IPAddress"*) address_of "${name}" ;;
      *"State.Running"*) if [ "${FAKE_RUNNER:-up}" = "ended" ]; then echo false; else echo true; fi ;;
      *"State.Restarting"*) echo false ;;
    esac
    ;;
  pull) exit 0 ;;
  build)
    printf '%s\n' "$*" > "${FAKE}/build"
    if [ "${FAKE_BUILD:-ok}" != "ok" ]; then
      printf '%s\n' \
        "#7 [3/9] RUN set -eu; fetch() ..." \
        "#7 12.01 curl: (6) Could not resolve host: github.com" \
        "#7 22.40 curl: (6) Could not resolve host: services.gradle.org"
      for n in $(seq 1 30); do echo "#7 3${n}.00 a line of the build"; done
      echo "#7 ERROR: process \"/bin/sh -c set -eu; fetch()\" did not complete successfully: exit code: 6"
      exit 1
    fi >&2
    # What the build says of what is in the image, as the builder prints it.
    printf '%s\n' \
      "#6 41.20 JDKs: 17 21 25 " \
      "#11 88.10 warm: Paper 1.21.4 (Java 21) with Gradle 8: fetched." \
      "#11 131.5 warm: Paper 1.21.4 (Java 21) with Gradle 9: fetched." \
      "#11 190.2 warm: 212M for Gradle, 31M for Maven."
    [ -f "${*: -1}/Dockerfile" ] && [ -f "${*: -1}/server.mjs" ] && [ -f "${*: -1}/init.sh" ] && [ -f "${*: -1}/selftest.mjs" ]
    ;;
  image) printf ' (1612345678 bytes)' ;;
  volume) exit 0 ;;
  rm) rm -f "${FAKE}/containers/${*: -1}" ;;
  run)
    name="" address="" envfile="" detached=no
    words=("$@")
    for i in "${!words[@]}"; do
      case "${words[$i]}" in
        -d) detached=yes ;;
        --name) name="${words[$((i + 1))]}" ;;
        --ip) address="${words[$((i + 1))]}" ;;
        --env-file) envfile="${words[$((i + 1))]}" ;;
      esac
    done
    if [ "${detached}" = no ]; then
      case " $* " in
        # Whether a container on that network gets to the package servers.
        *" timeout 15 "*) exit 0 ;;
        # Whether another container reaches the one that listens.
        *" XN_HOST="*) if [ "${FAKE_ICC:-yes}" = "yes" ]; then echo "ok"; else echo "no EHOSTUNREACH"; fi ;;
      esac
      exit 0
    fi
    case "${name}" in
      *-probe)
        [ "${FAKE_PROBE:-ok}" = "ok" ] || exit 125
        printf '172.18.0.77' > "${FAKE}/containers/${name}"
        echo "fedcba9876543210"
        exit 0
        ;;
    esac
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
    case " $* " in
      *" XN_URL="*"/health "*)
        case " $* " in
          *" ${FAKE_UUID} "*) if [ "${FAKE_REACH:-yes}" = "yes" ]; then echo '200 {"ok":true}'; else echo "0 connect ETIMEDOUT"; fi ;;
          *)
            case "${FAKE_HEALTH:-ok}" in
              ok) echo '200 {"ok":true,"protocol":2,"keeps":true,"stream":true,"maxSeconds":900,"slots":1,"running":0,"waiting":0,"separate":true}' ;;
              old) echo '200 {"ok":true}' ;;
              *) echo "0 connect ECONNREFUSED 127.0.0.1:8080" ;;
            esac
            ;;
        esac
        ;;
      *" XN_POST=1 "*) if [ "${FAKE_OPEN:-no}" = "yes" ]; then echo '200 {"exitCode":0}'; else echo '401 {"error":"unauthorized"}'; fi ;;
      *" /srv/selftest.mjs whoami "*) echo "${FAKE_WHO:-ok uid=20000 gid=20000 reads-server=no writes-outside=no has-token=no}" ;;
      *" /srv/selftest.mjs gradle "*)
        if [ "${FAKE_BUILD_TEST:-ok}" = "ok" ]; then
          echo "ok 41.5 s build/libs/warm-1.0.0.jar 2312 bytes (Paper 1.21.4, Java 21, Gradle 8)"
        else
          echo "no the build ended with code 1 after 20.0 s: Could not resolve io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT."
        fi
        ;;
      *" /srv/selftest.mjs maven "*) if [ "${FAKE_MAVEN_TEST:-ok}" = "ok" ]; then echo "ok 12.0 s target/warm-1.0.0.jar 1522 bytes"; else echo "no the build ended with code 1 after 9.0 s: it said nothing"; fi ;;
      # Whether a program's user gets to a private address: the container that listens, and this machine.
      *" XN_HOST=172.18.0.77 "*) if [ "${FAKE_LEAK:-no}" = "yes" ]; then echo "ok"; else echo "no EHOSTUNREACH"; fi ;;
      *" XN_HOST=172.18.0.1 "*) if [ "${FAKE_LEAK_HOST:-no}" = "yes" ]; then echo "ok"; else echo "no EHOSTUNREACH"; fi ;;
      # Whether its programs get to the outside.
      *)
        if [ "${FAKE_OUTSIDE:-yes}" = "yes" ]; then
          echo "ok repo.maven.apache.org, plugins.gradle.org, repo.papermc.io, registry.npmjs.org"
        else
          echo "no repo.maven.apache.org: the name was not found (EAI_AGAIN)"
        fi
        ;;
    esac
    ;;
  logs) echo "error: the rules of the network cannot be set here: iptables does not work in this container." ;;
  *) exit 1 ;;
esac
EOF
chmod +x "${WORK}/bin/docker"

# The addresses of the machine, as "ip" lists them: one of its own, one of Docker's.
cat > "${WORK}/bin/ip" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' \
  '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\       valid_lft forever preferred_lft forever' \
  '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever'
EOF
chmod +x "${WORK}/bin/ip"

# pterodactyl-upgrade.sh: it says what it was called with.
cat > "${WORK}/upgrade.sh" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${FAKE}/upgrade"
echo "The server was started again (a stand-in)."
exit "${FAKE_UPGRADE_EXIT:-0}"
EOF

run() { # options of the script; what it said goes to ${OUT}
  : > "${FAKE}/log"
  rm -f "${FAKE}/upgrade" "${FAKE}/build"
  local code=0
  env PATH="${WORK}/bin:${PATH}" FAKE="${FAKE}" FAKE_UUID="${UUID}" XIERO_UPGRADE_SCRIPT="${WORK}/upgrade.sh" XIERO_RUNNER_TRIES=2 XIERO_RUNNER_GAP=0 \
    bash "${script}" --wings-config "${WORK}/wings.yml" --state-dir "${WORK}/state" "$@" > "${OUT}" 2>&1 || code=$?
  if [ "${SHOW:-}" = "1" ]; then sed 's/^/    | /' "${OUT}"; fi
  return "${code}"
}
STATE="${WORK}/state/${UUID}"
ADDRESS="172.18.255.246"

# ── The plan ─────────────────────────────────────────────────────────────────

begin "The plan: what would be done, and nothing is"
check "a dry run ends well" run --server 0a11ce00 --dry-run
check "  it names the server and the app's version" said "App         ${WORK}/volumes/${UUID}/xiero-nexus-ai (version 1.12.0)"
check "  the network of the server's container" said "Network     pterodactyl_nw (172.18.0.0/16)"
check "  an address of its own near the end of that network, apart from the browser's" said "Container   xiero-runner, at ${ADDRESS}:8080 on that network"
check "  nothing published" said "not published to this machine or to the outside"
check "  the limits" said "Limits      3g of memory, 2 processors, 1280 processes; a read-only file system"
check "  how long a program runs" said "a program runs up to 900 seconds, 1 at a time"
check "  who the programs run as" said "Programs    run as a user of their own (20000:20000), without any right of root"
check "  what they reach" said "they reach the internet, and no private address; not this machine either"
check "  how names are looked up: as the server's container does" said "Names       are looked up as the server's container does: 1.1.1.1 1.0.0.1"
check "  what the app is given" said "SANDBOX_URL, SANDBOX_TOKEN and SANDBOX_MAX_SECONDS are written into"
check "  and that nothing was changed" said "Dry run: nothing was changed."
check_not "  docker was not asked to build, start or remove anything" asked '^(build|run|rm|volume) '
check_not "  no token was made" test -e "${STATE}/container.env"

begin "Options that are not what they should be"
check_not "a memory that is not a size" run --server 0a11ce00 --dry-run --memory lots
check "  says so" said "--memory: a size such as 2g or 3g."
check_not "a time that is too long" run --server 0a11ce00 --dry-run --max-seconds 99999
check_not "what is fetched ahead, not written as versions" run --server 0a11ce00 --dry-run --warm "paper;rm -rf"
check "  says how they are written" said "--warm: versions of the Paper API"
check_not "an address to let through that is a name" run --server 0a11ce00 --dry-run --allow-private "mirror.internal"
check_not "a server that is not there" run --server ffffffff --dry-run
check "  says so" said "no server \"ffffffff\" has files in"

# ── Setting it up ────────────────────────────────────────────────────────────

begin "Setting it up"
check "the script ends well" run --server 0a11ce00 --yes
check "the image is built from what is next to the script" asked "^build --progress plain --pull -t xiero-runner ${here%/test}/runner\$"
check "  and what the build said is in it is passed on: the JDKs" said "  JDKs: 17 21 25"
check "  and what was fetched ahead" said "  warm: Paper 1.21.4 (Java 21) with Gradle 8: fetched."
check_not "  without what the builder puts in front of a line" said "#11 "
check "the container is started at its address" said "The container xiero-runner runs at ${ADDRESS}:8080 on pterodactyl_nw."
check "  on the server's network, at that address" started_with "--network pterodactyl_nw --ip ${ADDRESS} "
check "  looking names up as the server's container does" started_with "--dns 1.1.1.1 --dns 1.0.0.1 "
check "  with its limits" started_with "--memory 3g --memory-swap 3g --cpus 2 --pids-limit 1280 --ulimit nproc=1024:1024 "
check "  a read-only file system, and a folder for its runs" started_with "--read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --mount type=volume,src=xiero-runner-work,dst=/work "
check "  no right of root but the ones it needs: to close its network, to run a program as another user, to tidy up" started_with "--cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SETPCAP --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges "
check_not "  nothing published, and not privileged" grep -qE -- '(^| )(-p|--publish|--privileged|--network host|--pid|-v) ' "${FAKE}/run"
check "  told to close its network, and who the programs run as" started_with "-e RUNNER_FIREWALL=1 -e RUNNER_RUN_AS=20000:20000 "
check "  how long and how many" started_with "-e RUNNER_MAX_SECONDS=900 -e RUNNER_CONCURRENCY=1 "
check "  and the addresses of this machine, which are refused like private ones" started_with "-e RUNNER_DENY=203.0.113.7 172.17.0.1 "
check "  started again with Docker, with a first process that buries the dead" started_with "--restart unless-stopped --init "
token="$(sed -n 's/^RUNNER_TOKEN=//p' "${FAKE}/envfile")"
check "a token was made for it: 48 characters" test "${#token}" -eq 48
check "  kept where only root reads it" test "$(stat -c '%a' "${STATE}/container.env")" = "600"
check_not "  and never printed" said "${token}"
check "what was checked is said: that it runs and how it starts programs" said "The runner is running in it, and starts every program as a user of its own."
check "  that it runs nothing without the token" said "Without the token it runs nothing."
check "  who a program runs as, and what it cannot do" said "With the token it runs a program: as 20000:20000, which cannot read the runner's own memory or its token, and cannot write outside its folder."
check "  that a container next to it is not reached, though it can be" said "Its programs do not reach a container next to it (EHOSTUNREACH), which another container does reach."
check "  nor this machine" said "Nor this machine itself."
check "  that the outside is" said "They reach the outside: repo.maven.apache.org, plugins.gradle.org, repo.papermc.io, registry.npmjs.org."
check "  that a Paper plugin builds" said "A build works in it: a Paper plugin was built with Gradle in 41.5 s build/libs/warm-1.0.0.jar 2312 bytes (Paper 1.21.4, Java 21, Gradle 8)."
check "  and a Maven project" said "And with Maven: a jar in 12.0 s target/warm-1.0.0.jar 1522 bytes."
check "  that the server's container reaches it" said "The server's container reaches it."
check "the container that only listened is removed again" asked '^rm -f xiero-runner-probe$'
check "the server is started again with the three settings" upgraded "--server ${UUID} --version 1.12.0 --force --yes --set SANDBOX_URL=http://${ADDRESS}:8080 --set SANDBOX_TOKEN=${token} --set SANDBOX_MAX_SECONDS=900 --wings-config ${WORK}/wings.yml"
check "  and the lines are kept for a person, where only root reads them" test "$(stat -c '%a' "${STATE}/runner-env")" = "600"
is "  the same three" "SANDBOX_URL=http://${ADDRESS}:8080 SANDBOX_TOKEN=${token} SANDBOX_MAX_SECONDS=900" "$(tr '\n' ' ' < "${STATE}/runner-env" | sed 's/ $//')"

begin "Run again: what is there is replaced, and its token stays"
check "the script ends well" run --server 0a11ce00 --yes --memory 4g --max-seconds 1200 --concurrency 2 --allow-private 10.0.0.5,10.9.0.0/24 --warm 1.21.4:21,1.21.8:21 --rebuild
check "  the plan says that there is one" said "Container   xiero-runner (there is one: it is replaced), at ${ADDRESS}:8080"
check "  and that its token is kept" said "Token       the one that is kept in"
is "  it is the same token" "${token}" "$(sed -n 's/^RUNNER_TOKEN=//p' "${FAKE}/envfile")"
check "  the image is built anew, with what is to be fetched ahead" grep -qF -- "--pull -t xiero-runner --no-cache --build-arg WARM_PAPER=1.21.4:21 1.21.8:21 " "${FAKE}/build"
check "  the new limits" started_with "--memory 4g --memory-swap 4g --cpus 2 --pids-limit 2304 "
check "  the time and how many at once" started_with "-e RUNNER_MAX_SECONDS=1200 -e RUNNER_CONCURRENCY=2 "
check "  and what is let through" started_with "-e RUNNER_ALLOW=10.0.0.5 10.9.0.0/24 "
check "  the app is told the new time" upgraded "--set SANDBOX_MAX_SECONDS=1200"
check "nothing fetched ahead, when that is asked for" run --server 0a11ce00 --yes --warm none
check "  the build is told so" grep -qF -- "--build-arg WARM_PAPER= " "${FAKE}/build"

begin "The container only"
check "the script ends well" run --server 0a11ce00 --yes --container-only
check_not "  the server is left alone" test -e "${FAKE}/upgrade"
check "  and it says where the lines for its .env are" said "The lines for the server's .env are in ${STATE}/runner-env"

# ── When something is not as it should be ────────────────────────────────────

begin "What stops it before the server is touched"
check_not "an image that cannot be built" env FAKE_BUILD=fails bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes"
check "  says what went wrong first, from the middle of what the build said" said "curl: (6) Could not resolve host: github.com"
check "  and that nothing else was changed" said "the image could not be built. Nothing else was changed."
check_not "  the server was not touched" test -e "${FAKE}/upgrade"

expect_stop() { # NAME SETTING WHAT-IT-SAYS
  local name="$1" setting="$2" says="$3" code=0
  env "${setting}" bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes" || code=$?
  if [ "${code}" -ne 0 ] && said "${says}" && [ ! -e "${FAKE}/upgrade" ]; then ok "${name}"; else bad "${name}" "code ${code}; wanted \"${says}\"; $(tail -n 2 "${OUT}" | tr '\n' ' ' | cut -c1-300)"; fi
}
expect_stop "a runner that does not come up: its log is shown, and why it may be" FAKE_HEALTH=down "If the lines above speak of the rules of the network"
check "  with what the container said" said "iptables does not work in this container"
expect_stop "what answers is not the runner of this version" FAKE_HEALTH=old "it does not start programs as a user of their own"
expect_stop "a runner that takes a request without the token" FAKE_OPEN=yes "the runner took a request without the token"
expect_stop "a program that runs as root" "FAKE_WHO=ok uid=0 gid=0 reads-server=yes writes-outside=yes has-token=no" "a program ran, but not shut in as it should be (uid=0 gid=0 reads-server=yes writes-outside=yes has-token=no)"
expect_stop "a program that reaches the container next to it" FAKE_LEAK=yes "a program in the runner reached a container next to it (172.18.0.77:8099): the network is not closed to private addresses."
expect_stop "a program that reaches this machine" FAKE_LEAK_HOST=yes "a program in the runner reached this machine itself (172.18.0.1:22)"
expect_stop "programs that do not reach the outside" FAKE_OUTSIDE=no "the runner's programs do not reach the outside (repo.maven.apache.org: the name was not found (EAI_AGAIN))"
expect_stop "a plugin that does not build" FAKE_BUILD_TEST=fails "a Paper plugin could not be built in the runner (the build ended with code 1 after 20.0 s"
check "  and how to go on where Paper cannot be reached at all" said "run this again with --skip-build-test"
expect_stop "a server's container that does not reach it" FAKE_REACH=no "the server's container does not reach the runner at ${ADDRESS}:8080"

begin "What it goes on with, and says"
check "without the build as a check, when that is asked for" env FAKE_BUILD_TEST=fails bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes --skip-build-test"
check_not "  no build is tried" asked 'selftest\.mjs (gradle|maven)'
check "  and the server is started again" test -e "${FAKE}/upgrade"
check "a Maven project that does not build is a warning: Gradle builds work" env FAKE_MAVEN_TEST=fails bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes"
check "  it says so" said "warning: a small Maven project could not be built in the runner"
check "containers that do not reach each other: what could not be seen is said" env FAKE_ICC=no bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes --container-only"
check "  as a warning" said "so whether the runner keeps its programs from private addresses could not be seen from the outside"
check "an address that is taken: the next one down" env FAKE_TAKEN="${ADDRESS}" bash -c "$(declare -f run); FAKE='${FAKE}' UUID='${UUID}' WORK='${WORK}' OUT='${OUT}' script='${script}' run --server 0a11ce00 --yes --container-only"
# The container of the last run is there, with the address it had: so that is the one tried first.
check "  or the one it had" said "The container xiero-runner runs at 172.18.255.24"

# ── Taking it away ───────────────────────────────────────────────────────────

begin "Taking it away"
check "the script ends well" run --server 0a11ce00 --yes --remove
check "  the container is removed" asked '^rm -f xiero-runner$'
check "  and the folder its runs worked in" asked '^volume rm xiero-runner-work$'
check_not "  its token is gone" test -e "${STATE}/container.env"
check "  the app's settings are emptied, and the server is started again" upgraded "--set SANDBOX_URL= --set SANDBOX_TOKEN= "
check "  and it says what that means" said "Nothing is run or built until there is one again"

printf '\n%s passed, %s failed\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  for name in "${failures[@]}"; do printf '  ✗ %s\n' "${name}"; done
  exit 1
fi
