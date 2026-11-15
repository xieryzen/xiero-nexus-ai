#!/usr/bin/env bash
# Tests of pterodactyl-install.sh, and of pterodactyl-upgrade.sh --start which
# it uses, on a made-up Wings host in a temporary folder: one real bundle, the
# stand-in for Wings (fake-wings.mjs) and the stand-in for docker.
#
#   NEW_ZIP=<bundle to install> bash scripts/host/test/install.sh
#
# The made-up server is set up the way the common Node.js egg leaves one: a
# checkout of the app's source code at the top of its files, and a startup
# command that runs index.js. The stand-in for Wings starts that file, so the
# few lines the installer writes there are what brings the app up.
#
#   TS_NODE=<path of a ts-node>   also start the server the way that egg really
#                                 does, through "ts-node --esm". ts-node 10
#                                 needs a TypeScript before 7 next to it.
#   SHOW=1                        print what the script said each time.
#
# The bundle must be for the Node.js that runs this. As root it also checks
# who owns the files afterwards.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../pterodactyl-install.sh"
upgrade="${here}/../pterodactyl-upgrade.sh"
: "${NEW_ZIP:?set NEW_ZIP to the bundle to install}"
NEW_ZIP="$(realpath "${NEW_ZIP}")"

WINGS_PORT="${WINGS_PORT:-8191}"
APP_PORT="${APP_PORT:-3398}"
UUID="0a11ce00-1111-4222-8333-444455556666"
OTHER="0b0b0b0b-1111-4222-8333-444455556666"
TOKEN="node-token-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
APP="http://127.0.0.1:${APP_PORT}"
WINGS="http://127.0.0.1:${WINGS_PORT}"

WORK="$(mktemp -d)"
HOST="${WORK}/host"
OUT="${WORK}/out.txt"
VOLUME="${HOST}/volumes/${UUID}"
APP_DIR="${VOLUME}/xiero-nexus-ai"
WINGS_PID=""
passed=0
failed=0
failures=()

cleanup() {
  if [ -n "${WINGS_PID}" ]; then kill "${WINGS_PID}" 2> /dev/null || true; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

export PATH="${here}:${PATH}"
export FAKE_WINGS_URL="${WINGS}"
export FAKE_MAIN_FILE="index.js"

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
says() { grep -qF -- "$1" "${OUT}"; }
show_output() { sed 's/^/         | /' "${OUT}" | tail -n 40; }
expect_exit() { # NAME WANTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1" "exit $3 instead of $2"
    show_output
  fi
}
http() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2> /dev/null || true; }
healthy() { [ "$(http "${APP}/api/health")" = "200" ]; }
signs_in() { [ "$(http -X POST "${APP}/api/auth/login" -H 'content-type: application/json' -d "{\"identifier\":\"$1\",\"password\":\"$2\"}")" = "200" ]; }
wait_until() { # SECONDS COMMAND...
  local deadline=$((SECONDS + $1))
  shift
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
stopped() { ! curl -fsS "${WINGS}/__state/${UUID}" | grep -q '"running":true'; }
wings_power() { curl -fsS -o /dev/null -X POST "${WINGS}/api/servers/${UUID}/power" -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d "{\"action\":\"$1\"}"; }
setting() { sed -n "s/^$1=//p" "${APP_DIR}/.env" | tail -n 1; }
app_pid() { # the app's own process, among those of the made-up container
  local file pid
  for file in /proc/[0-9]*/environ; do
    pid="${file#/proc/}"
    pid="${pid%/environ}"
    if grep -qsa "FAKE_WINGS_CONTAINER=${UUID}" "${file}" && grep -qs '^next-server' "/proc/${pid}/comm"; then
      echo "${pid}"
      return 0
    fi
  done
  return 1
}
tree_hash() { (cd "${HOST}/volumes" && find . -mindepth 1 -printf '%p %y %s\n' | sort | sha256sum); }

# A host with one server as the common Node.js egg leaves it, and someone
# else's server next to it. KIND says what the server holds:
#   source  the app's source code, never run     empty  nothing
#   ran     the source code with a .env          bot    someone's own index.js
fresh_host() { # KIND
  if [ -n "${WINGS_PID}" ]; then
    kill "${WINGS_PID}" 2> /dev/null || true
    wait "${WINGS_PID}" 2> /dev/null || true
    WINGS_PID=""
  fi
  rm -rf "${HOST}"
  mkdir -p "${VOLUME}" "${HOST}/volumes/${OTHER}" "${HOST}/backups"
  echo "another customer's file" > "${HOST}/volumes/${OTHER}/world.dat"
  case "$1" in
    source | ran)
      mkdir -p "${VOLUME}/src" "${VOLUME}/node_modules/next" "${VOLUME}/.git" "${VOLUME}/.github"
      printf '{\n  "name": "xiero-nexus-ai",\n  "version": "1.4.0",\n  "private": true\n}\n' > "${VOLUME}/package.json"
      echo "export const page = 1;" > "${VOLUME}/src/page.ts"
      echo "module.exports = {};" > "${VOLUME}/node_modules/next/index.js"
      echo "ref: refs/heads/main" > "${VOLUME}/.git/HEAD"
      echo "node_modules" > "${VOLUME}/.gitignore"
      echo '{ "compilerOptions": { "allowJs": true, "module": "esnext", "jsx": "preserve" } }' > "${VOLUME}/tsconfig.json"
      if [ "$1" = "ran" ]; then echo "SECRET_ENCRYPTION_KEY=the-key-of-a-server-that-ran" > "${VOLUME}/.env"; fi
      ;;
    bot) echo "console.log('someone else\\'s bot');" > "${VOLUME}/index.js" ;;
  esac
  cat > "${HOST}/config.yml" << EOF
debug: false
uuid: 11111111-2222-4333-8444-555555555555
token_id: abcdefghijklmnop
token: ${TOKEN}
api:
  host: 0.0.0.0
  port: ${WINGS_PORT}
  ssl:
    enabled: false
system:
  data: ${HOST}/volumes
  username: pterodactyl
remote: https://panel.example.com
EOF
  # The server's files belong to the user Wings runs servers as, not to root.
  if [ "$(id -u)" = "0" ]; then chown -R 988:988 "${VOLUME}"; fi
  FAKE_RUNNER="${RUNNER:-}" node "${here}/fake-wings.mjs" "${WINGS_PORT}" "${HOST}/volumes" "${TOKEN}" "${APP_PORT}" > "${WORK}/wings.log" 2>&1 &
  WINGS_PID=$!
  wait_until 20 curl -fsS -o /dev/null "${WINGS}/__state/${UUID}" || { echo "the stand-in for Wings did not start" >&2; cat "${WORK}/wings.log" >&2; exit 1; }
}

install() { # options of the script; the output goes to ${OUT}; returns its exit code
  local code=0
  bash "${script}" --server 0a11ce00 --wings-config "${HOST}/config.yml" --backup-dir "${HOST}/backups" --zip "${NEW_ZIP}" "$@" > "${OUT}" 2>&1 < /dev/null || code=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/      | /' "${OUT}"; fi
  return "${code}"
}

NEW_VERSION="$(unzip -p "${NEW_ZIP}" 'xiero-nexus-ai/VERSION' | sed -n 's/^version=//p')"
RUNNER=""
echo "Installing ${NEW_VERSION}, as $(id -un)."

# ── The plan ─────────────────────────────────────────────────────────────────

begin "A dry run on a server that holds the source code"
fresh_host source
before="$(tree_hash)"
code=0
install --app-url https://site.example.com/ --move-aside --dry-run || code=$?
expect_exit "ends well" 0 "${code}"
check "names the version to install" says "version ${NEW_VERSION}"
check "says that the source code goes into a folder, and that it never ran" says "It never ran here"
check "says which file it writes for the server to start" says "${VOLUME}/index.js is written"
check "says that the egg's command uses ts-node, and the bundle plain Node.js" says "through ts-node"
check "shows the address without the slash at its end" says "APP_URL=https://site.example.com"
check "says that nothing was changed" says "Dry run: nothing was changed."
check "and nothing was" test "$(tree_hash)" = "${before}"

begin "What it refuses"
code=0
install --yes --move-aside --node 18 || code=$?
expect_exit "a Node.js that bundles are not published for" 1 "${code}"
fresh_host ran
before="$(tree_hash)"
code=0
install --yes --move-aside || code=$?
expect_exit "a server that has run the app from its source code" 1 "${code}"
check "  says why" says "has run the app from its source code"
check "  nothing was changed" test "$(tree_hash)" = "${before}"
fresh_host bot
code=0
install --yes --move-aside || code=$?
expect_exit "--move-aside where there is no source code of the app" 1 "${code}"
fresh_host empty
mkdir "${APP_DIR}"
echo "not a bundle" > "${APP_DIR}/notes.txt"
code=0
install --yes || code=$?
expect_exit "a folder xiero-nexus-ai that is not a bundle" 1 "${code}"
check "  it is left alone" grep -qF "not a bundle" "${APP_DIR}/notes.txt"
fresh_host empty
echo '{ "name": "a-bot", "type": "module" }' > "${VOLUME}/package.json"
code=0
install --yes || code=$?
expect_exit "a package.json above the bundle that makes its files ES modules" 1 "${code}"
check "  says why" says "ES module"

# ── Installing ───────────────────────────────────────────────────────────────

run_install_checks() { # what starts the server's file, in words
  begin "Installing on a server that holds the source code ($1)"
  fresh_host source
  code=0
  install --app-url https://site.example.com --set COOKIE_SECURE=false --move-aside --yes || code=$?
  expect_exit "ends well" 0 "${code}"
  check "the bundle is in xiero-nexus-ai/" test "$(sed -n 's/^version=//p' "${APP_DIR}/VERSION")" = "${NEW_VERSION}"
  aside="$(find "${VOLUME}" -maxdepth 1 -type d -name 'source-checkout-*' | head -n 1)"
  check "the source code is in one folder of the server" test -n "${aside}"
  check "  all of it, hidden files too" test -f "${aside}/package.json" -a -f "${aside}/.git/HEAD" -a -f "${aside}/.gitignore" -a -f "${aside}/src/page.ts" -a -f "${aside}/node_modules/next/index.js"
  check "  and nothing of it is at the top any more" test "$(find "${VOLUME}" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = "3"
  check ".env has a key of 32 bytes" test "$(setting SECRET_ENCRYPTION_KEY | base64 -d 2> /dev/null | wc -c | tr -d ' ')" = "32"
  check "  a password for the first administrator" test "$(setting BOOTSTRAP_ADMIN_PASSWORD | wc -c | tr -d ' ')" -ge 20
  check "  the site's address" test "$(setting APP_URL)" = "https://site.example.com"
  check "  and what was given with --set" test "$(setting COOKIE_SECURE)" = "false"
  check "  it is readable by its owner only" test "$(stat -c %a "${APP_DIR}/.env")" = "600"
  check_not "the key is not in what the script said" says "$(setting SECRET_ENCRYPTION_KEY)"
  check_not "  nor the password" says "$(setting BOOTSTRAP_ADMIN_PASSWORD)"
  check "  it says where the password is" says "BOOTSTRAP_ADMIN_PASSWORD"
  check "the file the server starts was written" grep -qF "xiero-nexus-ai" "${VOLUME}/index.js"
  check "the server was started through Wings" says "Asking Wings to start the server"
  check "  and the app answers" healthy
  check "  the script says so" says "The server answers at"
  check "the first administrator signs in with the password of .env" signs_in admin "$(setting BOOTSTRAP_ADMIN_PASSWORD)"
  pid="$(app_pid || true)"
  check "the app runs in a process group of its own, where only the start file reaches it" test -n "${pid}" -a "$(ps -o pgid= -p "${pid:-1}" | tr -d ' ')" = "${pid}"
  if [ "$(id -u)" = "0" ]; then
    owner="$(stat -c '%u:%g' "${VOLUME}")"
    check "as root: the new files belong to the owner of the server's files" test "$(find "${APP_DIR}" "${VOLUME}/index.js" ! -path '*/data/*' ! -path '*/data' -printf '%u:%g\n' | sort -u)" = "${owner}"
  fi
  wings_power stop
  check "told to stop, the server stops" wait_until 30 stopped
  check "  the app said that it was told, once" test "$(curl -fsS "${WINGS}/__log/${UUID}" | grep -o 'SIGINT: stopping' | wc -l | tr -d ' ')" = "1"
  check_not "  and nothing of it is left running" healthy
  check "the database it made is in the bundle's folder" test -f "${APP_DIR}/data/nexus.db"

  code=0
  bash "${upgrade}" --server 0a11ce00 --wings-config "${HOST}/config.yml" --backup-dir "${HOST}/backups" --start --yes > "${OUT}" 2>&1 < /dev/null || code=$?
  expect_exit "pterodactyl-upgrade.sh --start brings it up again" 0 "${code}"
  check "  and the app answers" healthy
  code=0
  bash "${upgrade}" --server 0a11ce00 --wings-config "${HOST}/config.yml" --backup-dir "${HOST}/backups" --start --yes > "${OUT}" 2>&1 < /dev/null || code=$?
  expect_exit "  a second time there is nothing to do" 0 "${code}"
  check "  and it says so" says "Nothing to do"
  code=0
  install --move-aside --yes || code=$?
  expect_exit "installing where the app is already: refused" 1 "${code}"
  check "  it points to the upgrade script" says "pterodactyl-upgrade.sh --server ${UUID}"
  code=0
  bash "${upgrade}" --server 0a11ce00 --wings-config "${HOST}/config.yml" --backup-dir "${HOST}/backups" --zip "${NEW_ZIP}" --dry-run > "${OUT}" 2>&1 < /dev/null || code=$?
  expect_exit "the upgrade script finds what was installed" 0 "${code}"
  wings_power stop
  wait_until 30 stopped || true
}
run_install_checks "its file is started with node"

if [ -n "${TS_NODE:-}" ]; then
  [ -x "${TS_NODE}" ] || { echo "TS_NODE is not a program: ${TS_NODE}" >&2; exit 1; }
  RUNNER="${TS_NODE} --esm"
  run_install_checks "its file is started through ts-node --esm, as the common Node.js egg does"
  RUNNER=""
else
  echo
  echo "(Starting through ts-node, as the common Node.js egg does, was not tried: TS_NODE is not set.)"
fi

begin "Other servers"
fresh_host empty
code=0
install --yes --no-start || code=$?
expect_exit "an empty server, --no-start: ends well" 0 "${code}"
check "  the bundle and the start file are there" test -f "${APP_DIR}/start.js" -a -f "${VOLUME}/index.js"
check "  the server was not started" stopped
check "  nothing was moved" test -z "$(find "${VOLUME}" -maxdepth 1 -name 'source-checkout-*')"
check_not "  the other server's files were not touched" test -e "${HOST}/volumes/${OTHER}/xiero-nexus-ai"

fresh_host source
code=0
install --yes --no-start || code=$?
expect_exit "the source code left where it is (no --move-aside): ends well" 0 "${code}"
check "  it is still at the top" test -f "${VOLUME}/package.json" -a -d "${VOLUME}/.git"
check "  the plan said what that means" says "installs and updates it"
check "  the bundle and the start file are there" test -f "${APP_DIR}/start.js" -a -f "${VOLUME}/index.js"

fresh_host bot
code=0
install --yes --no-start || code=$?
expect_exit "a server whose index.js is someone's own: ends well" 0 "${code}"
check "  that file is left alone" grep -qF "someone else" "${VOLUME}/index.js"
check "  the script says that the startup file has to be changed in the panel" says "Set the startup file to xiero-nexus-ai/start.js"
check "  the bundle is there" test -f "${APP_DIR}/start.js"

fresh_host empty
code=0
install --yes --no-start --launcher bot/main.js || code=$?
expect_exit "--launcher names another file" 0 "${code}"
check "  it is written there" grep -qF "xiero-nexus-ai" "${VOLUME}/bot/main.js"
check_not "  and not as index.js" test -e "${VOLUME}/index.js"
fresh_host empty
code=0
install --yes --no-start --launcher ../outside.js || code=$?
expect_exit "a launcher outside the server's files: refused" 1 "${code}"
check_not "  nothing was written there" test -e "${HOST}/volumes/outside.js"

begin "A server that does not come up"
fresh_host empty
code=0
install --yes --set SECRET_ENCRYPTION_KEY=too-short-to-be-a-key --health-timeout 20 || code=$?
expect_exit "the script ends with an error" 1 "${code}"
check "  it shows the server's console" says "The last lines of the server's console"
check "  and says that what was installed stays" says "What was installed stays in place"
check "  it does" test -f "${APP_DIR}/start.js" -a -f "${APP_DIR}/.env"

printf '\n%s passed, %s failed (install)\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  exit 1
fi
