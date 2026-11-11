#!/usr/bin/env bash
# Start a packaged release bundle the way a hosting panel would and check that
# it really works: it refuses to start without its key, serves pages, signs in
# (which exercises the native SQLite binding and the migrations), keeps the
# session, and stores its data inside the bundle folder.
#
#   bash scripts/smoke-test-bundle.sh [path/to/bundle.zip]
set -euo pipefail

cd "$(dirname "$0")/.."

ZIP="${1:-}"
if [ -z "${ZIP}" ]; then
  shopt -s nullglob
  found=(dist/xiero-nexus-ai-*.zip)
  shopt -u nullglob
  ZIP="${found[0]:-}"
fi
if [ -z "${ZIP}" ] || [ ! -f "${ZIP}" ]; then
  echo "error: no bundle found. Run: npm run build:standalone && npm run package" >&2
  exit 1
fi
ZIP="$(cd "$(dirname "${ZIP}")" && pwd)/$(basename "${ZIP}")"
PORT="${SMOKE_PORT:-3210}"
WORK="$(mktemp -d)"
PID=""

cleanup() {
  if [ -n "${PID}" ]; then kill "${PID}" 2>/dev/null || true; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

fail() {
  echo "FAILED: $*" >&2
  if [ -f "${WORK}/server.log" ]; then
    echo "--- server log ---" >&2
    cat "${WORK}/server.log" >&2
  fi
  exit 1
}

unzip -q "${ZIP}" -d "${WORK}"
APP="${WORK}/xiero-nexus-ai"
[ -f "${APP}/start.js" ] || fail "the zip does not contain xiero-nexus-ai/start.js"
cd "${WORK}"
echo "bundle: $(basename "${ZIP}") | $(tr '\n' ' ' < "${APP}/VERSION")"

# 1. Without a key the bundle must stop with instructions, not start half-configured.
set +e
timeout 30 env -u SECRET_ENCRYPTION_KEY node xiero-nexus-ai/start.js > "${WORK}/nokey.log" 2>&1
rc=$?
set -e
if [ "${rc}" != "1" ] || ! grep -q "SECRET_ENCRYPTION_KEY" "${WORK}/nokey.log"; then
  cat "${WORK}/nokey.log" >&2
  fail "expected the bundle to stop and explain the missing SECRET_ENCRYPTION_KEY (exit ${rc})"
fi
echo "ok: refuses to start without SECRET_ENCRYPTION_KEY"

# 2. Configure it like a user would: copy the template, fill in the blanks.
PASS="smoke-$(node -e "process.stdout.write(require('crypto').randomBytes(9).toString('hex'))")"
KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
sed -e "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=${KEY}|" \
    -e "s|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=${PASS}|" \
    "${APP}/.env.example" > "${APP}/.env"
# A PORT left in .env must not beat the port the panel assigns.
echo "PORT=$((PORT + 1))" >> "${APP}/.env"

# 3. Start from the parent folder with only the panel's port variable set.
env -u PORT SERVER_PORT="${PORT}" BIND_HOST=127.0.0.1 node xiero-nexus-ai/start.js > "${WORK}/server.log" 2>&1 &
PID=$!

BASE="http://127.0.0.1:${PORT}"
code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

page="$(code --retry 40 --retry-delay 1 --retry-connrefused "${BASE}/login")"
[ "${page}" = "200" ] || fail "sign-in page returned HTTP ${page} on the panel port ${PORT}"
echo "ok: serves pages on the panel port (SERVER_PORT)"

login="$(code -D "${WORK}/headers.txt" -X POST "${BASE}/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"admin\",\"password\":\"${PASS}\"}")"
[ "${login}" = "200" ] || fail "sign-in returned HTTP ${login}"
cookie="$(grep -i '^set-cookie: nexus_session=' "${WORK}/headers.txt" | head -n 1 | tr -d '\r')"
[ -n "${cookie}" ] || fail "sign-in did not set a session cookie"
echo "${cookie}" | grep -qi 'httponly' || fail "the session cookie is not HttpOnly"
echo "${cookie}" | grep -qi 'secure' || fail "the session cookie is not Secure by default"
echo "ok: sign-in works (SQLite + migrations) and the cookie is HttpOnly + Secure"

token="$(echo "${cookie}" | sed -E 's/^[^=]*=([^;]*).*/\1/')"
me="$(code -H "cookie: nexus_session=${token}" "${BASE}/api/account/me")"
[ "${me}" = "200" ] || fail "the session was not accepted (HTTP ${me})"
echo "ok: the session is accepted"

# 4. On a plain-HTTP public address sign-in is refused with an explanation,
#    because the browser would drop the HTTPS-only cookie.
blocked="$(curl -s -X POST "${BASE}/api/auth/login" -H "host: 203.0.113.5:${PORT}" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"admin\",\"password\":\"${PASS}\"}" || true)"
echo "${blocked}" | grep -q '"insecure_transport"' || fail "no plain-HTTP explanation: ${blocked}"
echo "ok: explains itself on a plain-HTTP address"

[ -f "${APP}/data/nexus.db" ] || fail "the database was not created in xiero-nexus-ai/data/"
echo "ok: data is stored in xiero-nexus-ai/data/"

echo "smoke test passed"
