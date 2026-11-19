#!/usr/bin/env bash
# Tests of pterodactyl-upgrade.sh, on a made-up Wings host in a temporary
# folder: two real bundles, a stand-in for Wings that starts and stops the
# bundle as a plain process (fake-wings.mjs), and a stand-in for docker.
#
#   OLD_ZIP=<bundle that is installed> NEW_ZIP=<bundle to upgrade to> bash scripts/host/test/run.sh
#
# Both bundles must be for the Node.js that runs this. As root
# (sudo env "PATH=$PATH" OLD_ZIP=… NEW_ZIP=… bash …) it also checks who owns
# the files afterwards. SHOW=1 prints what the script said each time.
#
# It takes about five minutes: the script is patient with a server that does
# not come up, and that is tried with its real waiting times.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../pterodactyl-upgrade.sh"
: "${OLD_ZIP:?set OLD_ZIP to the bundle of the installed version}"
: "${NEW_ZIP:?set NEW_ZIP to the bundle to upgrade to}"
OLD_ZIP="$(realpath "${OLD_ZIP}")"
NEW_ZIP="$(realpath "${NEW_ZIP}")"

WINGS_PORT="${WINGS_PORT:-8189}"
APP_PORT="${APP_PORT:-3399}"
UUID="0a11ce00-1111-4222-8333-444455556666"
OTHER="0b0b0b0b-1111-4222-8333-444455556666"
TOKEN="node-token-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PASSWORD="upgrade-test-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
APP="http://127.0.0.1:${APP_PORT}"
WINGS="http://127.0.0.1:${WINGS_PORT}"

WORK="$(mktemp -d)"
HOST="${WORK}/host"
OUT="${WORK}/out.txt"
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

http() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2> /dev/null || true; }
signs_in() { [ "$(http -X POST "${APP}/api/auth/login" -H 'content-type: application/json' -d "{\"identifier\":\"$1\",\"password\":\"$2\"}")" = "200" ]; }
answers() { [ "$(http "${APP}/login")" = "200" ]; }
healthy() { [ "$(http "${APP}/api/health")" = "200" ]; }
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
starts() { curl -fsS "${WINGS}/__state/${UUID}" | sed -n 's/.*"starts":\([0-9]*\).*/\1/p'; } # how often Wings started the server's process
wings_power() { curl -fsS -o /dev/null -X POST "${WINGS}/api/servers/${UUID}/power" -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -d "{\"action\":\"$1\"}"; }
control() { curl -fsS -o /dev/null -X POST "${WINGS}/__control/${UUID}" -H 'content-type: application/json' -d "$1"; }
field() { sed -n "s/^$1=//p" "$2" | head -n 1; }
installed() { field version "${APP_DIR}/VERSION"; }
leftovers() { find "${HOST}/volumes/${UUID}" -maxdepth 1 -name '.xiero-upgrade-*' | grep -q .; }
newest_backup() { find "${HOST}/backups/${UUID}" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | sort | tail -n 1; }
has_table() { # whether the server's database has this table
  node -e '
    const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[1] + "/data/nexus.db", { readonly: true });
    process.exit(db.prepare("select 1 from sqlite_master where type = ? and name = ?").get("table", process.argv[2]) ? 0 : 1);
  ' "${APP_DIR}" "$1"
}

OLD_VERSION=""
NEW_VERSION=""
NODE_MAJOR=""
APP_DIR="${HOST}/volumes/${UUID}/xiero-nexus-ai"

# A host with one server that runs the old bundle, and someone else's server next to it.
fresh_host() { # [root]: with "root", the bundle sits at the top of the server's files
  if [ -n "${WINGS_PID}" ]; then
    kill "${WINGS_PID}" 2> /dev/null || true
    wait "${WINGS_PID}" 2> /dev/null || true
    WINGS_PID=""
  fi
  rm -rf "${HOST}"
  mkdir -p "${HOST}/volumes/${UUID}" "${HOST}/volumes/${OTHER}" "${HOST}/backups"
  unzip -q "${OLD_ZIP}" -d "${HOST}/volumes/${UUID}"
  if [ "${1:-}" = "root" ]; then
    mv "${HOST}/volumes/${UUID}/xiero-nexus-ai" "${HOST}/moved"
    rmdir "${HOST}/volumes/${UUID}"
    mv "${HOST}/moved" "${HOST}/volumes/${UUID}"
    APP_DIR="${HOST}/volumes/${UUID}"
  else
    APP_DIR="${HOST}/volumes/${UUID}/xiero-nexus-ai"
  fi
  cat > "${APP_DIR}/.env" << EOF
# Settings of the test server. This comment has to survive an upgrade.
SECRET_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=${PASSWORD}
COOKIE_SECURE=false
APP_URL=http://old.example.com
MY_OWN_SETTING=kept
EOF
  chmod 600 "${APP_DIR}/.env"
  echo "notes of whoever runs this server" > "${APP_DIR}/my-notes.txt"
  echo "another customer's file" > "${HOST}/volumes/${OTHER}/world.dat"
  cat > "${HOST}/config.yml" << EOF
debug: false
app_name: Pterodactyl
uuid: 11111111-2222-4333-8444-555555555555
token_id: abcdefghijklmnop
token: ${TOKEN}
api:
  host: 0.0.0.0
  port: ${WINGS_PORT}
  ssl:
    enabled: false
    cert: /etc/letsencrypt/live/node.example.com/fullchain.pem
    key: /etc/letsencrypt/live/node.example.com/privkey.pem
  upload_limit: 100
system:
  root_directory: /var/lib/pterodactyl
  log_directory: /var/log/pterodactyl
  data: ${HOST}/volumes
  username: pterodactyl
  user:
    uid: 988
    gid: 988
remote: https://panel.example.com
EOF
  node "${here}/fake-wings.mjs" "${WINGS_PORT}" "${HOST}/volumes" "${TOKEN}" "${APP_PORT}" "${HOST}/releases" > "${WORK}/wings.log" 2>&1 &
  WINGS_PID=$!
  wait_until 20 curl -fsS -o /dev/null "${WINGS}/__state/${UUID}" || { echo "the stand-in for Wings did not start" >&2; cat "${WORK}/wings.log" >&2; exit 1; }
  wings_power start
  wait_until 60 answers || { echo "the old bundle did not start" >&2; curl -s "${WINGS}/__log/${UUID}" >&2; exit 1; }
  # Something to find again afterwards: the administrator, a second account, a media file.
  signs_in admin "${PASSWORD}" || { echo "the administrator of the old bundle cannot sign in" >&2; exit 1; }
  [ "$(http -X POST "${APP}/api/auth/register" -H 'content-type: application/json' -d "{\"username\":\"keeper\",\"email\":\"keeper@example.com\",\"password\":\"${PASSWORD}\"}")" = "201" ] \
    || { echo "could not register a second account on the old bundle" >&2; exit 1; }
  mkdir -p "${APP_DIR}/data/media"
  echo "a generated picture" > "${APP_DIR}/data/media/picture.png"
}

upgrade() { # options of the script; the output goes to ${OUT}; prints nothing, returns its exit code
  local code=0
  bash "${script}" --wings-config "${HOST}/config.yml" --backup-dir "${HOST}/backups" "$@" > "${OUT}" 2>&1 < /dev/null || code=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/      | /' "${OUT}"; fi
  return "${code}"
}
expect_exit() { # NAME WANTED ACTUAL
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1" "exit $3 instead of $2"
    show_output
  fi
}

# ── The two bundles ──────────────────────────────────────────────────────────

mkdir "${WORK}/peek-old" "${WORK}/peek-new"
unzip -q "${OLD_ZIP}" 'xiero-nexus-ai/VERSION' -d "${WORK}/peek-old"
unzip -q "${NEW_ZIP}" 'xiero-nexus-ai/VERSION' -d "${WORK}/peek-new"
OLD_VERSION="$(field version "${WORK}/peek-old/xiero-nexus-ai/VERSION")"
NEW_VERSION="$(field version "${WORK}/peek-new/xiero-nexus-ai/VERSION")"
NODE_MAJOR="$(field node "${WORK}/peek-new/xiero-nexus-ai/VERSION")"
ASSET="xiero-nexus-ai-linux-x64-node${NODE_MAJOR}.zip"
echo "Upgrading ${OLD_VERSION} to ${NEW_VERSION} (Node.js ${NODE_MAJOR}), as $(id -un)."
[ "${OLD_VERSION}" != "${NEW_VERSION}" ] || { echo "both bundles are version ${OLD_VERSION}" >&2; exit 1; }

# A new version that changes the database and then cannot start.
mkdir "${WORK}/broken"
unzip -q "${NEW_ZIP}" -d "${WORK}/broken"
cat > "${WORK}/broken/xiero-nexus-ai/server.js" << 'EOF'
const path = require("path");
const Database = require("better-sqlite3");
const db = new Database(path.join(__dirname, "data", "nexus.db"));
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS broken_upgrade (x TEXT); INSERT INTO broken_upgrade VALUES ('left behind')");
console.error("this version changed the database and cannot start");
process.exit(1);
EOF
(cd "${WORK}/broken" && zip -qr "${WORK}/broken.zip" xiero-nexus-ai)

# ── A dry run, the upgrade, a second run, an older version, going back ───────

fresh_host
begin "A dry run"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --dry-run || code=$?
expect_exit "it ends well" 0 "${code}"
check "it shows the plan" says "Installed   ${OLD_VERSION}"
check "  with the new version" says "New         ${NEW_VERSION}"
check "  and that the running version answers the check" says "(answers now: yes)"
check "it says that nothing was changed" says "Dry run: nothing was changed."
check "the old version is still installed" test "$(installed)" = "${OLD_VERSION}"
check "  and still running" answers
check_not "no backup was made" test -n "$(newest_backup)"
check_not "nothing is left in the server's files" leftovers

begin "The upgrade"
before_env="$(grep -v '^APP_URL=' "${APP_DIR}/.env")"
code=0
upgrade --server "${UUID:0:8}" --zip "${NEW_ZIP}" --yes --app-url https://nexus.example.com --set RUN_CONCURRENCY=2 \
  --set "BROWSER_URL=http://172.18.255.250:9223/?token=a-token-that-must-stay-hidden" --set SEARCH_API_KEY=a-key-that-must-stay-hidden || code=$?
expect_exit "it ends well" 0 "${code}"
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "it runs and passes its health check" healthy
check "the script saw that it answers" says "is running and answers at"
check "the administrator of the old database signs in" signs_in admin "${PASSWORD}"
check "  and so does the second account" signs_in keeper "${PASSWORD}"
check "the media file is where it was" grep -q "a generated picture" "${APP_DIR}/data/media/picture.png"
check "a file of the server's owner in the same folder is kept" grep -q "notes of whoever" "${APP_DIR}/my-notes.txt"
check "the address of the site is set in .env" grep -qx 'APP_URL=https://nexus.example.com' "${APP_DIR}/.env"
check "  once" test "$(grep -c '^APP_URL=' "${APP_DIR}/.env")" = "1"
check "  a new setting is added" grep -qx 'RUN_CONCURRENCY=2' "${APP_DIR}/.env"
check "  one that signs in somewhere is written as it was given" grep -qx 'BROWSER_URL=http://172.18.255.250:9223/?token=a-token-that-must-stay-hidden' "${APP_DIR}/.env"
check "    and shown without what signs in" says "Setting     BROWSER_URL=http://172.18.255.250:9223/?token=(not shown)"
check "    a key is not shown at all" says "Setting     SEARCH_API_KEY=(not shown)"
check_not "    neither is in the output" says "must-stay-hidden"
check "  everything else in .env is as it was" test "$(grep -v -e '^APP_URL=' -e '^RUN_CONCURRENCY=' -e '^BROWSER_URL=' -e '^SEARCH_API_KEY=' "${APP_DIR}/.env")" = "${before_env}"
check "  and it keeps its permissions" test "$(stat -c '%a' "${APP_DIR}/.env")" = "600"
backup="$(newest_backup)"
check "the backup has the old program files" test "$(field version "${backup}/code/VERSION")" = "${OLD_VERSION}"
check "  the database" test -s "${backup}/data/nexus.db"
check "  and .env as it was, readable by root only" test "$(stat -c '%a' "${backup}/dot-env")$(grep -c '^APP_URL=http://old.example.com$' "${backup}/dot-env")" = "6001"
check "  the backup folder is closed to others" test "$(stat -c '%a' "${backup}")" = "700"
check_not "the media is not copied without --with-media" test -e "${backup}/media"
check "it says how to go back" says "--restore ${backup}"
check_not "nothing is left in the server's files" leftovers
check "the other server's files were not touched" test "$(ls -A "${HOST}/volumes/${OTHER}")$(cat "${HOST}/volumes/${OTHER}/world.dat")" = "world.datanother customer's file"
check_not "the node's token is not in the output" says "${TOKEN}"
# One of the server's own variables has the words "is_suspended":true in it.
check_not "a variable of the server is not taken for what Wings says about it" says "suspended in the panel"

begin "The same upgrade again"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
check "it says that the version is installed already" says "is already installed"
check "no second backup is made" test "$(newest_backup)" = "${backup}"
check "the server keeps running" healthy

begin "An older version"
code=0
upgrade --server "${UUID}" --zip "${OLD_ZIP}" --yes || code=$?
expect_exit "it is refused" 1 "${code}"
check "  with the reason" says "is older than the installed ${NEW_VERSION}"
check "the new version stays installed" test "$(installed)" = "${NEW_VERSION}"
check "  and running" healthy

begin "Going back to the backup"
code=0
upgrade --server "${UUID}" --restore "${backup}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
check "the old version is installed again" test "$(installed)" = "${OLD_VERSION}"
check "  and answers" answers
check "the administrator signs in" signs_in admin "${PASSWORD}"
check ".env is as it was before the upgrade" grep -qx 'APP_URL=http://old.example.com' "${APP_DIR}/.env"
check "the file of the server's owner is still there" test -f "${APP_DIR}/my-notes.txt"
check_not "nothing is left in the server's files" leftovers
mkdir "${WORK}/elsewhere"
cp -a "${backup}" "${WORK}/elsewhere/backup"
sed -i "s/^server=.*/server=${OTHER}/" "${WORK}/elsewhere/backup/INFO"
code=0
upgrade --server "${UUID}" --restore "${WORK}/elsewhere/backup" --yes || code=$?
expect_exit "a backup of another server is refused" 1 "${code}"

# ── A new version that does not start ────────────────────────────────────────

begin "A new version that does not start"
before="$(starts)"
began="${SECONDS}"
code=0
upgrade --server "${UUID}" --zip "${WORK}/broken.zip" --yes --health-timeout 300 || code=$?
took=$((SECONDS - began))
expect_exit "the script ends with an error" 1 "${code}"
check "it shows what the server wrote" says "this version changed the database and cannot start"
check "it says that it went back" says "the server is back on ${OLD_VERSION}"
# The new version, once more by Wings after the crash, then the old version.
check "Wings started the crashed server once more by itself, and that did not get in the way" test "$(($(starts) - before))" = "3"
check "it does not wait the whole five minutes for a server that is gone" test "${took}" -lt 200
check "the old version is installed again" test "$(installed)" = "${OLD_VERSION}"
check "  and answers" answers
check "the administrator signs in" signs_in admin "${PASSWORD}"
check_not "what the broken version did to the database is undone" has_table broken_upgrade
check "the database still has its own tables" has_table users
check_not "nothing is left in the server's files" leftovers

begin "The same, without going back"
code=0
upgrade --server "${UUID}" --zip "${WORK}/broken.zip" --yes --health-timeout 20 --no-rollback || code=$?
expect_exit "the script ends with an error" 1 "${code}"
check "the new files are left in place" test "$(installed)" = "${NEW_VERSION}"
check "the backup can be put back by hand" upgrade --server "${UUID}" --restore "$(newest_backup)" --yes
check "  and the old version answers again" answers
check_not "  with its database as it was" has_table broken_upgrade

# ── A server that does not stop ──────────────────────────────────────────────

begin "A server that does not stop"
# Wings would go on waiting and end the process after ten minutes; the script
# does that itself, sooner, and goes on.
control '{"ignoreStop":true}'
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --stop-timeout 6 || code=$?
expect_exit "it ends well" 0 "${code}"
check "it says that the process was ended" says "It did not stop by itself in 6 seconds: ending its process."
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "  and runs" healthy
check "the administrator signs in" signs_in admin "${PASSWORD}"
check_not "nothing is left in the server's files" leftovers
control '{"ignoreStop":false}'

# ── What Wings does on its own time ──────────────────────────────────────────

fresh_host
begin "Wings is slow to start the server"
# Twelve seconds in which Wings still says "offline" after it was told to start.
control '{"preboot":12000}'
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
check_not "the wait is not taken for a server that ended" says "going back"
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "  and runs" healthy
control '{"preboot":1200}'

begin "A restart was asked for in the panel a moment before"
upgrade --server "${UUID}" --restore "$(newest_backup)" --yes > /dev/null 2>&1 || true
check "(the old version runs again)" test "$(installed)$(http "${APP}/login")" = "${OLD_VERSION}200"
control '{"preboot":4000}'
before="$(starts)"
wings_power restart
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
# The restart's own start, then the start of the new version. Which of the
# script's requests Wings takes first after the restart is not certain: when
# its "start" comes before its "stop", the script has to ask a second time.
check "the restart went through, and the server was started with the new version after it" test "$(($(starts) - before))" -ge 2
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "  and runs" healthy
check "the administrator signs in" signs_in admin "${PASSWORD}"
check_not "nothing is left in the server's files" leftovers
control '{"preboot":1200}'

begin "A server that is stopped"
upgrade --server "${UUID}" --restore "$(newest_backup)" --yes --leave-stopped > /dev/null 2>&1 || true
check "(the old version is installed and stopped)" test "$(installed)$(stopped && echo stopped)" = "${OLD_VERSION}stopped"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
check "the plan says that it will be started" says "The server is stopped now. It is started afterwards"
check "the new version runs" test "$(installed)$(http "${APP}/api/health")" = "${NEW_VERSION}200"

begin "A server that is suspended"
upgrade --server "${UUID}" --restore "$(newest_backup)" --yes --leave-stopped > /dev/null 2>&1 || true
control '{"suspended":true}'
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it ends well" 0 "${code}"
check "it says that Wings will not start it" says "this server is suspended in the panel"
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "the server is left stopped" stopped
control '{"suspended":false}'
wings_power start
check "once it is no longer suspended and started, it runs" wait_until 60 healthy

begin "ffmpeg for a server image that has none"
upgrade --server "${UUID}" --restore "$(newest_backup)" --yes > /dev/null 2>&1 || true
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --ffmpeg "${here}/run.sh" || code=$?
expect_exit "a file that is not a program is refused" 1 "${code}"
check "  before anything was changed" test "$(installed)$(http "${APP}/login")" = "${OLD_VERSION}200"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --ffmpeg "$(readlink -f "$(type -P true)")" || code=$?
expect_exit "with a program, it ends well" 0 "${code}"
check "the program is in the server's files, and can be run" test -x "${HOST}/volumes/${UUID}/xiero-tools/ffmpeg"
check "  .env points at it, as the server sees the path" grep -qx 'FFMPEG_PATH=/home/container/xiero-tools/ffmpeg' "${APP_DIR}/.env"
check "the new version runs" healthy

begin "The token of the node, kept elsewhere"
printf '%s\n' "${TOKEN}" > "${HOST}/token-file"
sed -i "s|^token: .*|token: file://${HOST}/token-file|" "${HOST}/config.yml"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --dry-run --force || code=$?
expect_exit "in a file that the configuration names" 0 "${code}"
check "  Wings was asked with it" says "through Wings at"
# shellcheck disable=SC2016  # the configuration holds the name of a variable, as text
sed -i 's|^token: .*|token: ${WINGS_NODE_TOKEN}|' "${HOST}/config.yml"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --dry-run --force || code=$?
expect_exit "in a variable of the Wings service: refused" 1 "${code}"
check "  with what to do" says "Run this with WINGS_TOKEN=<the token> in front"
code=0
WINGS_TOKEN="${TOKEN}" upgrade --server "${UUID}" --zip "${NEW_ZIP}" --dry-run --force || code=$?
expect_exit "  given in the environment, it works" 0 "${code}"
check_not "the token is not in the output" says "${TOKEN}"
sed -i "s|^token: .*|token: ${TOKEN}|" "${HOST}/config.yml"

# ── Things it refuses ────────────────────────────────────────────────────────

fresh_host
begin "Refused: a wrong token"
sed -i "s/^token: .*/token: not-the-token/" "${HOST}/config.yml"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it stops" 1 "${code}"
check "  and says that Wings refused the token" says "Wings refused the token"
check "the old version keeps running" answers
sed -i "s/^token: .*/token: ${TOKEN}/" "${HOST}/config.yml"

begin "Refused: a server that is not there"
code=0
upgrade --server "ffffffff" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "it stops" 1 "${code}"
check "  and says so" says 'there is no server "ffffffff"'
code=0
upgrade --server "${OTHER}" --zip "${NEW_ZIP}" --yes || code=$?
expect_exit "a server without the app is refused too" 1 "${code}"
check "the other server's files were not touched" test "$(ls -A "${HOST}/volumes/${OTHER}")" = "world.dat"

begin "Refused: .env is a link to a file outside the server"
echo "a file of the host" > "${WORK}/host-file"
mv "${APP_DIR}/.env" "${WORK}/real-env"
ln -s "${WORK}/host-file" "${APP_DIR}/.env"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --app-url https://evil.example.com || code=$?
expect_exit "it stops" 1 "${code}"
check "  and says why" says ".env is a link"
check "the file the link leads to is unchanged" test "$(cat "${WORK}/host-file")" = "a file of the host"
check "the old version keeps running" answers
rm "${APP_DIR}/.env"
mv "${WORK}/real-env" "${APP_DIR}/.env"

begin "Refused: settings that must not be changed here"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --set SECRET_ENCRYPTION_KEY=abc || code=$?
expect_exit "the encryption key" 1 "${code}"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --set 'lowercase=1' || code=$?
expect_exit "a name that is not a setting" 1 "${code}"
code=0
upgrade --server "${UUID}" --zip "${here}/run.sh" --yes || code=$?
expect_exit "a file that is not a bundle" 1 "${code}"
check "the old version is still installed and running" test "$(installed)$(http "${APP}/login")" = "${OLD_VERSION}200"

# ── Downloading ──────────────────────────────────────────────────────────────

begin "Downloading: a file that does not match its checksum"
mkdir -p "${HOST}/releases/latest/download" "${HOST}/releases/download/v${NEW_VERSION}"
cp "${NEW_ZIP}" "${HOST}/releases/latest/download/${ASSET}"
cp "${NEW_ZIP}" "${HOST}/releases/download/v${NEW_VERSION}/${ASSET}"
echo "0000000000000000000000000000000000000000000000000000000000000000  ${ASSET}" > "${HOST}/releases/latest/download/SHA256SUMS.txt"
code=0
XIERO_RELEASES_URL="${WINGS}/releases" upgrade --server "${UUID}" --yes || code=$?
expect_exit "it stops" 1 "${code}"
check "  and says why" says "does not match the release's checksum. Nothing was changed."
check "the old version keeps running" test "$(installed)$(http "${APP}/login")" = "${OLD_VERSION}200"

begin "Downloading: a version that does not exist"
code=0
XIERO_RELEASES_URL="${WINGS}/releases" upgrade --server "${UUID}" --yes --version 99.0.0 || code=$?
expect_exit "it stops" 1 "${code}"
check "  and says that the download failed" says "the download failed"

begin "Downloading: a named version, with its checksum"
(cd "${HOST}/releases/download/v${NEW_VERSION}" && sha256sum -- *.zip > SHA256SUMS.txt)
code=0
XIERO_RELEASES_URL="${WINGS}/releases" upgrade --server "${UUID}" --yes --version "v${NEW_VERSION}" || code=$?
expect_exit "it ends well" 0 "${code}"
check "the checksum was compared" says "The checksum matches."
check "the new version runs" test "$(installed)$(http "${APP}/api/health")" = "${NEW_VERSION}200"

# ── By hand, and a bundle at the top of the server's files ───────────────────

fresh_host root
begin "Power by hand, bundle at the top of the server's files"
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --power manual || code=$?
expect_exit "a running server is refused" 1 "${code}"
check "  with what to do" says "Stop it in the panel, then run this again. Nothing was changed."
wings_power stop
wait_until 30 stopped
code=0
upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --power manual --with-media || code=$?
expect_exit "once it is stopped, the upgrade ends well" 0 "${code}"
check "it says to start the server in the panel" says "Start the server in the panel now"
check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
check "the server was not started" stopped
check "the media is in the backup, as asked" grep -q "a generated picture" "$(newest_backup)/media/picture.png"
check "the file of the server's owner is kept" test -f "${APP_DIR}/my-notes.txt"
check_not "nothing is left in the server's files" leftovers
wings_power start
check "started by hand, it runs" wait_until 60 healthy
check "the administrator signs in" signs_in admin "${PASSWORD}"

# ── Who owns the files (as root only) ────────────────────────────────────────

if [ "$(id -u)" = "0" ]; then
  fresh_host
  begin "Ownership"
  wings_power stop
  wait_until 30 stopped
  chown -R 988:988 "${HOST}/volumes/${UUID}"
  code=0
  upgrade --server "${UUID}" --zip "${NEW_ZIP}" --yes --leave-stopped --app-url https://nexus.example.com || code=$?
  expect_exit "the upgrade ends well" 0 "${code}"
  check "the server is left stopped, as asked" stopped
  check "the new version is installed" test "$(installed)" = "${NEW_VERSION}"
  check "every file belongs to the server's user" test -z "$(find "${HOST}/volumes/${UUID}" ! -uid 988 -o ! -gid 988 | head -n 5)"
  check "the backup belongs to root" test "$(stat -c '%u' "$(newest_backup)")" = "0"
else
  begin "Ownership"
  echo "  skipped: run as root to check who owns the files afterwards"
fi

printf '\n%s passed, %s failed (host upgrade)\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  exit 1
fi
