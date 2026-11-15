#!/usr/bin/env bash
# Start a packaged release bundle the way a hosting panel would and check that
# it really works: it refuses to start without its key, serves pages, signs in
# (which exercises the native SQLite binding and the migrations), keeps the
# session, stores its data inside the bundle folder, reads a PDF into the
# knowledge base (a package that is only loaded while the server runs), has
# its background worker going, and stops when it is told to.
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

# 5. A PDF goes into the knowledge base and is found again: the PDF reader
#    and the full-text search of the bundled SQLite both have to be there.
session=(-H "cookie: nexus_session=${token}")
# shellcheck disable=SC2016  # the script is JavaScript: nothing in it is for the shell
node -e '
  const text = "BT /F1 12 Tf 72 720 Td (The bundle reads this sentence about marmalade.) Tj ET";
  const objects = [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /Font << /F1 1 0 R >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Catalog /Pages 4 0 R >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  require("fs").writeFileSync(process.argv[1], out, "latin1");
' "${WORK}/smoke.pdf"
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(0)}for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))})' "$1"; }
collection="$(curl -s "${session[@]}" -X POST "${BASE}/api/knowledge" -H 'content-type: application/json' -d '{"name":"Smoke test"}' | field collection.id)"
[ -n "${collection}" ] || fail "could not create a knowledge collection"
uploaded="$(curl -s "${session[@]}" -X POST "${BASE}/api/knowledge/${collection}/documents/upload" \
  -H 'content-type: application/pdf' -H 'x-file-name: smoke.pdf' --data-binary "@${WORK}/smoke.pdf")"
[ "$(echo "${uploaded}" | field document.chunkCount)" = "1" ] || fail "the PDF was not read: ${uploaded}"
hits="$(curl -s "${session[@]}" -X POST "${BASE}/api/knowledge/search" -H 'content-type: application/json' \
  -d "{\"query\":\"marmalade\",\"collectionIds\":[\"${collection}\"]}")"
echo "${hits}" | grep -q "about marmalade" || fail "the PDF's text was not found again: ${hits}"
echo "ok: a PDF is read into the knowledge base and found by its words"

# 6. Subtitles need the font that comes with the bundle.
[ -f "${APP}/assets/fonts/NotoSans-Bold.ttf" ] || fail "the subtitle font is missing from the bundle"
echo "ok: the subtitle font is in the bundle"

# 7. The background worker runs inside the server: no second process to start.
worker_state() {
  curl -s "${session[@]}" "${BASE}/dashboard/observability" \
    | grep -o 'data-status="Background worker" data-state="[^"]*"' | head -n 1 | sed -E 's/.*data-state="([^"]*)"/\1/'
}
state="$(worker_state)"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "${state}" = "Running" ] && break
  sleep 1
  state="$(worker_state)"
done
[ "${state}" = "Running" ] || fail "the status page says the background worker is \"${state:-not reported}\", not Running"
echo "ok: the background worker is running"

# 8. Told to stop (a panel's Stop button sends Ctrl+C), it ends within seconds,
#    also while a request is still open: here one whose body never arrives.
exec 9<> "/dev/tcp/127.0.0.1/${PORT}"
printf 'POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{' >&9
sleep 1
asked="${SECONDS}"
kill -INT "${PID}"
(sleep 10 && kill -KILL "${PID}" 2> /dev/null) &
watchdog=$!
set +e
wait "${PID}"
rc=$?
set -e
kill "${watchdog}" 2> /dev/null || true
exec 9>&-
took=$((SECONDS - asked))
PID=""
[ "${rc}" = "0" ] || fail "told to stop with a request still open, the server did not end by itself (exit ${rc} after ${took}s)"
[ "${took}" -le 6 ] || fail "the server took ${took}s to stop"
grep -q "SIGINT: stopping" "${WORK}/server.log" || fail "the server did not say that it is stopping"
echo "ok: stops within seconds when told to, with a request still open"

echo "smoke test passed"
