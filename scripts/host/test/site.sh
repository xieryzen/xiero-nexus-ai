#!/usr/bin/env bash
# Tests of nginx-site.sh, with a real nginx: one of its own, in a temporary
# folder and on ports of its own, that already has other sites the way a
# machine with a panel on it does. The app is a few lines of Node.js, and
# certbot is a stand-in that does what certbot and Let's Encrypt do between
# them: it asks the site for a file it has put into the folder for that, and
# only then makes a certificate, signed by an authority made up for the test.
#
#   bash scripts/host/test/site.sh
#   NGINX_BIN=/path/to/nginx bash scripts/host/test/site.sh
#
# It checks that the site answers over https with a certificate that is
# accepted, and above all what must stay as it was: the other sites, the site
# that names nobody has get, and everything when a step fails. SHOW=1 prints
# what the script said.
#
# Not tried here: the real certbot and the real Let's Encrypt.
set -Eeuo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../nginx-site.sh"

HTTP_PORT="${SITE_HTTP_PORT:-8480}"
HTTPS_PORT="${SITE_HTTPS_PORT:-8443}"
APP_PORT="${SITE_APP_PORT:-8470}"
UUID="0a11ce00-1111-4222-8333-444455556666"

NGINX_BIN="${NGINX_BIN:-}"
if [ -z "${NGINX_BIN}" ]; then
  for candidate in "$(command -v nginx 2> /dev/null || true)" /usr/sbin/nginx /usr/local/sbin/nginx; do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
      NGINX_BIN="${candidate}"
      break
    fi
  done
fi
[ -n "${NGINX_BIN}" ] || {
  echo "This test needs nginx: install it, or name the program with NGINX_BIN."
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::error title=A site in nginx::there is no nginx on this machine"; fi
  exit 1
}
NGINX_VERSION="$("${NGINX_BIN}" -v 2>&1 | sed -n 's|.*/\([0-9][0-9.]*\).*|\1|p')"
BUILT_WITH="$("${NGINX_BIN}" -V 2>&1)"
# From 1.25.1, nginx can have HTTP/2 for one site alone.
if [ "$(printf '%s\n1.25.1\n' "${NGINX_VERSION}" | sort -V | head -n 1)" = "1.25.1" ]; then H2_ALONE=yes; else H2_ALONE=no; fi
if [ -e /proc/net/if_inet6 ] && ip -6 addr show lo 2> /dev/null | grep -q '::1'; then HAS_V6=yes; else HAS_V6=no; fi
if curl -V | grep -qw HTTP2; then CURL_H2=yes; else CURL_H2=no; fi

WORK="$(mktemp -d)"
[ "$(id -u)" != "0" ] || chmod 755 "${WORK}"
STUB="${WORK}/stub"
CA="${WORK}/ca"
LE="${WORK}/letsencrypt"
ACME="${WORK}/acme"
OUT="${WORK}/out.txt"
CALLS="${WORK}/certbot-calls.txt"
PREFIX=""
APP_PID=""
CODE=0
passed=0
failed=0
failures=()
details=()
SECTION="the preparations"
STOPPED_AT=""
ENDED=""

stop_nginx() {
  if [ -n "${PREFIX}" ] && [ -s "${PREFIX}/nginx.pid" ]; then
    kill "$(cat "${PREFIX}/nginx.pid")" 2> /dev/null || true
    for _ in $(seq 1 50); do [ -e "${PREFIX}/nginx.pid" ] || break; sleep 0.1; done
  fi
}
# On the page of a run of GitHub Actions: how the test ended, and what failed.
annotate() { # notice|error TEXT
  [ "${GITHUB_ACTIONS:-}" = "true" ] || return 0
  printf '::%s title=A site in nginx%s::%s\n' "$1" "$([ "$(id -u)" = "0" ] && echo ", as root" || true)" \
    "$(printf '%s' "$2" | cut -c 1-400 | head -n 40 | sed -e 's/%/%25/g' | awk '{ printf "%s%s", sep, $0; sep = "%0A" }')"
}
cleanup() {
  local code=$?
  trap - EXIT
  if [ -z "${ENDED}" ]; then
    echo "The test stopped before its end, in \"${SECTION}\"${STOPPED_AT:+ (${STOPPED_AT})}."
    annotate error "stopped before its end, in \"${SECTION}\"${STOPPED_AT:+ (${STOPPED_AT})}; ${passed} passed and ${failed} failed until then"$'\n'"$(printf '%s\n' ${details[@]+"${details[@]}"})"
    [ "${code}" != "0" ] || code=1
  fi
  stop_nginx
  if [ -n "${APP_PID}" ]; then kill "${APP_PID}" 2> /dev/null || true; fi
  rm -rf "${WORK}"
  exit "${code}"
}
trap cleanup EXIT
trap 'STOPPED_AT="line ${LINENO}: ${BASH_COMMAND}"' ERR

begin() {
  SECTION="$*"
  printf '\n── %s\n' "$*"
}
ok() {
  passed=$((passed + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  failed=$((failed + 1))
  failures+=("$1")
  details+=("${SECTION}: $1${2:+ [$2]}")
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
says() { grep -qF -- "$1" "${OUT}"; }
line() { grep -qE -- "$1" "${OUT}"; }
eventually() { # a command that becomes true within half a minute
  for _ in $(seq 1 300); do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}

# ── The authority of the test, and certificates ──────────────────────────────

mkdir -p "${STUB}" "${CA}"
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=Authority of the test" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "${CA}/ca.key" -out "${CA}/ca.pem" 2> /dev/null
certificate() { # NAME FOLDER [DAYS]: FOLDER/fullchain.pem and privkey.pem
  mkdir -p "$2"
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$1" -keyout "$2/privkey.pem" -out "$2/request.pem" 2> /dev/null
  openssl x509 -req -in "$2/request.pem" -CA "${CA}/ca.pem" -CAkey "${CA}/ca.key" -CAcreateserial -days "${3:-90}" \
    -extfile <(printf 'subjectAltName=DNS:%s\n' "$1") -out "$2/cert.pem" 2> /dev/null
  cat "$2/cert.pem" "${CA}/ca.pem" > "$2/fullchain.pem"
  rm -f "$2/request.pem"
}

# ── The stand-ins ────────────────────────────────────────────────────────────

# Where the names of the test lead: to this machine, unless a test says otherwise.
cat > "${STUB}/getent" << 'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "ahosts" ]; then
  case "${2:-}" in
    *.test)
      for address in ${FAKE_LEADS_TO-127.0.0.1}; do printf '%s STREAM %s\n' "${address}" "$2"; done
      exit 0
      ;;
  esac
fi
exec /usr/bin/getent "$@"
EOF

# certbot, and Let's Encrypt behind it.
cat > "${STUB}/certbot" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_CERTBOT_LOG}"
if [ "${1:-}" = "--version" ]; then
  echo "certbot 4.0.0"
  exit 0
fi
[ "${1:-}" = "certonly" ] || {
  echo "certbot: error: unrecognized arguments: $*"
  exit 2
}
shift
webroot=""
domain=""
name=""
config="/etc/letsencrypt"
hook=""
agreed=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    -w) webroot="$2"; shift 2 ;;
    -d) domain="$2"; shift 2 ;;
    --cert-name) name="$2"; shift 2 ;;
    --config-dir) config="$2"; shift 2 ;;
    --work-dir | --logs-dir | --email) shift 2 ;;
    --deploy-hook) hook="$2"; shift 2 ;;
    --agree-tos) agreed=yes; shift ;;
    --webroot | --non-interactive | --keep-until-expiring | --register-unsafely-without-email) shift ;;
    *)
      echo "certbot: error: unrecognized arguments: $1"
      exit 2
      ;;
  esac
done
[ -n "${webroot}" ] && [ -n "${domain}" ] && [ "${name}" = "${domain}" ] || {
  echo "certbot: error: the test's certbot wants -w, -d and --cert-name"
  exit 2
}
if ! find "${config}/accounts" -name regr.json 2> /dev/null | grep -q .; then
  if [ "${agreed}" != yes ]; then
    echo "You should register before running non-interactively, or provide --agree-tos and --email <email_address> flags."
    exit 1
  fi
  mkdir -p "${config}/accounts/acme-v02.api.letsencrypt.org/directory/made-up"
  echo '{}' > "${config}/accounts/acme-v02.api.letsencrypt.org/directory/made-up/regr.json"
fi
sleep "${FAKE_CERTBOT_SLEEP:-0}"
if [ -n "${FAKE_CERTBOT_FAILS:-}" ]; then
  echo "Certbot failed to authenticate some domains (authenticator: webroot). The Certificate Authority reported these problems:"
  echo "  Domain: ${domain}"
  echo "  Type:   connection"
  echo "  Detail: made up by the test"
  exit 1
fi
# Let's Encrypt's question: a file in the folder, asked for through the site.
token="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
mkdir -p "${webroot}/.well-known/acme-challenge"
printf '%s.made-up\n' "${token}" > "${webroot}/.well-known/acme-challenge/${token}"
got="$(curl -s --max-time 10 --resolve "${domain}:${FAKE_HTTP_PORT}:127.0.0.1" "http://${domain}:${FAKE_HTTP_PORT}/.well-known/acme-challenge/${token}" || true)"
rm -f "${webroot}/.well-known/acme-challenge/${token}"
if [ "${got}" != "${token}.made-up" ]; then
  echo "Certbot failed to authenticate some domains (authenticator: webroot). The Certificate Authority reported these problems:"
  echo "  Domain: ${domain}"
  echo "  Type:   unauthorized"
  echo "  Detail: Invalid response from http://${domain}/.well-known/acme-challenge/${token}"
  exit 1
fi
live="${config}/live/${domain}"
mkdir -p "${live}" "${config}/renewal"
openssl req -new -newkey rsa:2048 -nodes -subj "/CN=${domain}" -keyout "${live}/privkey.pem" -out "${live}/request.pem" 2> /dev/null
openssl x509 -req -in "${live}/request.pem" -CA "${FAKE_CA}/ca.pem" -CAkey "${FAKE_CA}/ca.key" -CAcreateserial -days "${FAKE_CERT_DAYS:-90}" \
  -extfile <(printf 'subjectAltName=DNS:%s\n' "${FAKE_CERT_NAME:-${domain}}") -out "${live}/cert.pem" 2> /dev/null
cat "${live}/cert.pem" "${FAKE_CA}/ca.pem" > "${live}/fullchain.pem"
rm -f "${live}/request.pem"
printf 'authenticator = webroot\nrenew_hook = %s\n[[webroot_map]]\n%s = %s\n' "${hook}" "${domain}" "${webroot}" > "${config}/renewal/${domain}.conf"
# The hook, as certbot runs it once a certificate was made.
if [ -n "${hook}" ]; then sh -c "${hook}"; fi
if [ -n "${FAKE_CERTBOT_THEN:-}" ]; then sh -c "${FAKE_CERTBOT_THEN}"; fi
echo "Successfully received certificate."
EOF
chmod +x "${STUB}/getent" "${STUB}/certbot"

# The app: /api/health, what a request looked like when it arrived, an answer
# that is written bit by bit, and an upload.
cat > "${WORK}/app.mjs" << 'EOF'
import http from "node:http";
let healthy = true;
http
  .createServer((req, res) => {
    const path = new URL(req.url, "http://app").pathname;
    if (path === "/api/health") {
      res.writeHead(healthy ? 200 : 500, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    } else if (path === "/__down" || path === "/__up") {
      healthy = path === "/__up";
      res.end("ok\n");
    } else if (path === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url, version: req.httpVersion, headers: req.headers }));
    } else if (path === "/stream") {
      // Written bit by bit, a second apart. With ?ends=close it has neither a
      // length nor chunks: it is over when the connection is.
      if (req.url.includes("ends=close")) res.useChunkedEncodingByDefault = false;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: start\n\n");
      let part = 0;
      const timer = setInterval(() => {
        part += 1;
        res.write(`data: part ${part}\n\n`);
        if (part === 4) {
          clearInterval(timer);
          res.end();
        }
      }, 1000);
    } else if (path === "/upload") {
      let size = 0;
      req.on("data", (chunk) => (size += chunk.length));
      req.on("end", () => res.end(`${size}\n`));
    } else {
      res.writeHead(404);
      res.end("not found\n");
    }
  })
  .listen(Number(process.argv[2]), "127.0.0.1");
EOF
node "${WORK}/app.mjs" "${APP_PORT}" &
APP_PID=$!
APP="http://127.0.0.1:${APP_PORT}"
eventually curl -fsS "${APP}/api/health" || {
  STOPPED_AT="the app of the test did not start on port ${APP_PORT}"
  exit 1
}

# ── A machine with nginx on it ───────────────────────────────────────────────

RELOADS_SEEN=0
# The files of nginx: their names, kinds, modes, where links lead, and what is in them.
files_print() { # [names to leave out]
  local skip="${1:-no-such-name}"
  {
    find "${PREFIX}/nginx.conf" "${PREFIX}/conf.d" "${PREFIX}/sites-available" "${PREFIX}/sites-enabled" "${PREFIX}/vhosts" -not -name "${skip}" -printf '%p %y %m %l\n' 2> /dev/null | sort || true
    find "${PREFIX}/nginx.conf" "${PREFIX}/conf.d" "${PREFIX}/sites-available" "${PREFIX}/sites-enabled" "${PREFIX}/vhosts" -type f -not -name "${skip}" -exec sha256sum {} + 2> /dev/null | sort || true
  } | sha256sum
}
config_print() { files_print; }
reloads() { grep -c 'signal 1 (SIGHUP) received' "${PREFIX}/logs/error.log" 2> /dev/null || true; }
reloads_are() { [ "$(reloads)" = "$1" ]; }
reloads_are_not() { [ "$(reloads)" != "$1" ]; }
note() { # what is there now, to compare with later
  PRINT="$(config_print)"
  RELOADS_SEEN="$(reloads)"
}
unchanged() { [ "$(config_print)" = "${PRINT}" ]; }
not_reloaded() { [ "$(reloads)" = "${RELOADS_SEEN}" ]; }

# A site of someone else: NAME, the folder it is switched on in, and how it
# listens on the two ports (the words of "listen", without the semicolon).
neighbour() { # NAME FOLDER HTTP_LISTENS HTTPS_LISTENS [FILE NAME]
  local name="$1" folder="$2" file="${5:-$1.conf}" listen
  certificate "${name}" "${PREFIX}/certs/${name}"
  {
    printf 'server {\n'
    while IFS= read -r listen; do [ -z "${listen}" ] || printf '    listen %s;\n' "${listen}"; done <<< "${3//,/$'\n'}"
    printf '    server_name %s;\n    return 301 https://$host$request_uri;\n}\n' "${name}"
    printf 'server {\n'
    while IFS= read -r listen; do [ -z "${listen}" ] || printf '    listen %s;\n' "${listen}"; done <<< "${4//,/$'\n'}"
    printf '    server_name %s;\n' "${name}"
    printf '    ssl_certificate %s/certs/%s/fullchain.pem;\n    ssl_certificate_key %s/certs/%s/privkey.pem;\n' "${PREFIX}" "${name}" "${PREFIX}" "${name}"
    printf '    location / {\n        return 200 "this is %s\\n";\n    }\n}\n' "${name}"
  } > "${PREFIX}/${folder}/${file}"
  if [ "${folder}" = "sites-available" ]; then ln -s "${PREFIX}/sites-available/${file}" "${PREFIX}/sites-enabled/${file}"; fi
}
# A new machine: stops the nginx of the one before and lays out the folders.
machine() { # NAME INCLUDES...
  stop_nginx
  PREFIX="${WORK}/$1"
  shift
  mkdir -p "${PREFIX}/logs" "${PREFIX}/tmp" "${PREFIX}/certs" "${PREFIX}/conf.d" "${PREFIX}/sites-available" "${PREFIX}/sites-enabled"
  {
    [ "$(id -u)" != "0" ] || printf 'user root;\n'
    printf 'pid %s/nginx.pid;\nerror_log logs/error.log notice;\nevents {\n    worker_connections 256;\n}\nhttp {\n' "${PREFIX}"
    printf '    access_log logs/access.log;\n    default_type text/plain;\n'
    # Everything nginx writes stays in this folder, whoever runs the test.
    printf '    client_body_temp_path tmp/body;\n    proxy_temp_path tmp/proxy;\n'
    for part in fastcgi uwsgi scgi; do
      case "${BUILT_WITH}" in *"--without-http_${part}_module"*) ;; *) printf '    %s_temp_path tmp/%s;\n' "${part}" "${part}" ;; esac
    done
    if [ -n "${FOR_ALL_SITES:-}" ]; then printf '    %s\n' "${FOR_ALL_SITES}"; fi
    for include in "$@"; do printf '    include %s;\n' "${include}"; done
    printf '}\n'
  } > "${PREFIX}/nginx.conf"
  # The nginx of the test: the real program, with this folder as its own. A
  # test can make it refuse a configuration with a site in it, or warn.
  cat > "${STUB}/nginx" << EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-t" ] && grep -RqsF -- "\${FAKE_NGINX_REFUSES:-nothing-is-refused}" "${PREFIX}/sites-enabled" "${PREFIX}/conf.d"; then
  echo 'nginx: [emerg] made up by the test in ${PREFIX}/nginx.conf:1' >&2
  echo 'nginx: configuration file ${PREFIX}/nginx.conf test failed' >&2
  exit 1
fi
if [ "\${1:-}" = "-t" ] && grep -RqsF -- "\${FAKE_NGINX_WARNS:-nothing-is-warned-about}" "${PREFIX}/sites-enabled" "${PREFIX}/conf.d"; then
  echo 'nginx: [warn] a warning made up by the test in ${PREFIX}/nginx.conf:1' >&2
fi
exec "${NGINX_BIN}" -p "${PREFIX}/" -c "${PREFIX}/nginx.conf" -e "${PREFIX}/logs/error.log" "\$@"
EOF
  chmod +x "${STUB}/nginx"
}
start_nginx() {
  if ! "${STUB}/nginx" > "${WORK}/nginx-start.txt" 2>&1 || ! eventually test -s "${PREFIX}/nginx.pid"; then
    cat "${WORK}/nginx-start.txt" "${PREFIX}/logs/error.log" 2> /dev/null || true
    STOPPED_AT="the nginx of the test did not start: $(cat "${WORK}/nginx-start.txt" "${PREFIX}/logs/error.log" 2> /dev/null | grep -E 'emerg|alert|crit|error' | head -n 3 | tr '\n' ' ')"
    exit 1
  fi
}
reload_nginx() {
  local before
  before="$(reloads)"
  "${STUB}/nginx" -s reload
  eventually reloads_are_not "${before}" || true
  sleep 0.5
}

# The script: [NAME=VALUE ...] -- [its options]. Sets CODE.
run() {
  local settings=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    settings+=("$1")
    shift
  done
  [ "$#" -eq 0 ] || shift
  CODE=0
  env PATH="${STUB}:${here}:${PATH}" XIERO_NGINX_HTTP_PORT="${HTTP_PORT}" XIERO_NGINX_HTTPS_PORT="${HTTPS_PORT}" \
    XIERO_LETSENCRYPT_DIR="${LE}" XIERO_ACME_WEBROOT="${ACME}" CURL_CA_BUNDLE="${CA}/ca.pem" \
    FAKE_CA="${CA}" FAKE_HTTP_PORT="${HTTP_PORT}" FAKE_CERTBOT_LOG="${CALLS}" \
    ${settings[@]+"${settings[@]}"} bash "${script}" "$@" > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/      | /' "${OUT}"; fi
}
asked_for_certificates() { grep -c '^certonly' "${CALLS}" 2> /dev/null || true; }

# A visitor: every name of the test leads to this machine.
visit() { # curl options and a URL
  local name resolve=()
  for name in nexus.test agent.test panel.test other.test first.test zzz.test nobody.test; do
    resolve+=(--resolve "${name}:${HTTP_PORT}:127.0.0.1" --resolve "${name}:${HTTPS_PORT}:127.0.0.1")
  done
  curl -sS --max-time 20 --cacert "${CA}/ca.pem" "${resolve[@]}" "$@"
}
status() { visit -o /dev/null -w '%{http_code}' "$@" 2> /dev/null || true; }
gives() { [ "$(status "${@:2}")" = "$1" ]; } # STATUS, then what to ask for
# Whose certificate a name is shown, by its fingerprint.
shown_to() { # NAME [ADDRESS]
  (timeout 10 openssl s_client -connect "${2:-127.0.0.1}:${HTTPS_PORT}" -servername "$1" < /dev/null 2> /dev/null || true) | openssl x509 -noout -fingerprint -sha256 2> /dev/null || true
}
print_of() { openssl x509 -noout -fingerprint -sha256 -in "$1"; }
shows() { [ "$(shown_to "$1")" = "$(print_of "$2")" ]; } # NAME, the certificate it is to be shown
# What the other sites and a name nobody has are given: it must stay the same.
others_get() {
  local name
  for name in "$@" nobody.test; do
    printf '%s: %s | %s | %s | %s\n' "${name}" \
      "$(visit -o /dev/null -w '%{http_code} %{redirect_url}' "http://${name}:${HTTP_PORT}/some/page" 2> /dev/null || true)" \
      "$(visit "https://${name}:${HTTPS_PORT}/" 2> /dev/null || echo "not accepted")" \
      "$(shown_to "${name}")" \
      "$(visit -o /dev/null -w '%{http_version}' --http2 "https://${name}:${HTTPS_PORT}/" 2> /dev/null || true)"
  done
}
SITE="https://nexus.test:${HTTPS_PORT}"
V6_HTTP=""
V6_HTTPS=""
if [ "${HAS_V6}" = "yes" ]; then
  V6_HTTP=",[::]:${HTTP_PORT}"
  V6_HTTPS=",[::]:${HTTPS_PORT} ssl"
fi

# ═════════════════════════════════════════════════════════════════════════════
# A machine the way Debian lays nginx out, with two sites on it. The first one
# nginx reads is the one names that nobody has get.
# ═════════════════════════════════════════════════════════════════════════════

machine debian "conf.d/*.conf" "sites-enabled/*"
neighbour agent.test sites-available "${HTTP_PORT}${V6_HTTP}" "${HTTPS_PORT} ssl${V6_HTTPS}"
neighbour panel.test sites-available "${HTTP_PORT}${V6_HTTP}" "${HTTPS_PORT} ssl${V6_HTTPS}"
start_nginx
OTHERS_BEFORE="$(others_get agent.test panel.test)"
WARNINGS_BEFORE="$("${STUB}/nginx" -t 2>&1 | grep -c '\[warn\]' || true)"

begin "Before: nginx $("${NGINX_BIN}" -v 2>&1 | sed 's/.*: //') with two sites, and the name has none"
check "a site that is there answers" test "$(visit "https://agent.test:${HTTPS_PORT}/")" = "this is agent.test"
is "the name gets what names that nobody has get: sent on by the first site" "301" "$(status "http://nexus.test:${HTTP_PORT}/")"
check "  and over https, the certificate of another site" shows nexus.test "${PREFIX}/certs/agent.test/cert.pem"
check_not "  which a browser does not accept" visit -o /dev/null "${SITE}/api/health"

begin "A dry run changes nothing"
note
run -- --site nexus.test --upstream "${APP}" --agree-tos --dry-run
is "it ends well" "0" "${CODE}"
check "it says so" says "Dry run: nothing was changed."
check "the plan names the site" says "Site        ${SITE}"
check "  where the app answers, and that it does" says "App         ${APP}, answers now: yes"
check "  where the name leads" says "nexus.test leads to 127.0.0.1, an address of this machine"
check "  what the name gets now: what any unknown name gets, with another site's certificate" says "Now         nexus.test is no site of this nginx: it gets what any name gets that nginx does not know, and over https the certificate of agent.test"
check "  that nginx runs and is sound" line "nginx +${NGINX_VERSION} .*running; its configuration passes its test"
check "  how the sites that are there listen" line "2 files have sites now; on these ports they listen with: ${HTTP_PORT}, .*${HTTPS_PORT} ssl"
check "  the file it would write, and the link" says "${PREFIX}/sites-available/nexus.test.conf is written, with a link in ${PREFIX}/sites-enabled/"
check "  that it would listen the way the others do" says "It has: listen ${HTTP_PORT};"
if [ "${HAS_V6}" = "yes" ]; then check "    on IPv6 too, as they do" says "listen [::]:${HTTPS_PORT} ssl;"; fi
check "  that there is no certificate yet" says "Certificate none yet: certbot 4.0.0 asks Let's Encrypt for one"
check "  with a new account, as it was agreed to" says "with a new account without an e-mail address, agreeing to Let's Encrypt's terms (--agree-tos)"
check "  that nothing renews certificates on this machine by itself" says "nothing was found on this machine that renews certificates by itself"
check "  how large an upload may be" says "Uploads     up to 32m"
check "no file of nginx was changed" unchanged
check "nginx was not reloaded" not_reloaded
is "certbot was not asked for a certificate" "0" "$(asked_for_certificates)"
check_not "nothing was made for Let's Encrypt's questions" test -e "${ACME}"
run -- --site "https://Nexus.Test/some/page" --upstream "${APP}" --agree-tos --dry-run
check "an address is understood as the name in it" says "Site        ${SITE}"
echo "server { listen ${HTTP_PORT}; server_name *.test; return 204; }" > "${PREFIX}/sites-enabled/wildcard"
reload_nginx
run -- --site nexus.test --upstream "${APP}" --agree-tos --dry-run
check "a site whose names cover this one with a wildcard is told of in the plan" says "Now         another site of this nginx answers for nexus.test already"
rm "${PREFIX}/sites-enabled/wildcard"
reload_nginx
note

begin "What it does not go on with (nothing is changed each time)"
refused() { # NAME WORDS
  if [ "${CODE}" = "1" ] && says "$2" && says "Nothing was changed." && unchanged && not_reloaded; then ok "$1"; else bad "$1" "code ${CODE}; wanted \"$2\""; fi
}
curl -fsS -o /dev/null "${APP}/__down"
run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "an app that does not answer" "the app does not answer at ${APP}/api/health (500)"
curl -fsS -o /dev/null "${APP}/__up"
run FAKE_LEADS_TO=203.0.113.9 -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "a name that leads to another machine" "nexus.test leads to 203.0.113.9, which is not an address of this machine"
run FAKE_LEADS_TO= -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "a name that leads nowhere" "nexus.test does not lead anywhere"
run FAKE_LEADS_TO=203.0.113.9 -- --site nexus.test --upstream "${APP}" --agree-tos --skip-dns-check --dry-run
is "  unless it is told to go on all the same" "0" "${CODE}"
run -- --site nexus.test --upstream "${APP}" --yes
refused "a new account with Let's Encrypt that nobody agreed to" "certbot has no Let's Encrypt account on this machine yet"
if command -v certbot > /dev/null 2>&1; then
  echo "  (not tried: \"a machine without certbot\", because this machine has one)"
else
  mkdir "${WORK}/no-certbot"
  cp "${STUB}/getent" "${STUB}/nginx" "${WORK}/no-certbot/"
  run PATH="${WORK}/no-certbot:${PATH}" -- --site nexus.test --upstream "${APP}" --agree-tos --yes
  refused "a machine without certbot" "certbot is not installed"
fi
run -- --site nexus.test --agree-tos --yes
refused "not knowing where the app answers" "it is not said where the app answers"
stop_nginx
note
run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "an nginx that is not running" "nginx is installed, but it is not running (${PREFIX}/nginx.pid names no process that is there)"
start_nginx
note
echo "server { listen ${HTTP_PORT}; server_name old.test nexus.test; return 204; }" > "${PREFIX}/sites-enabled/someone-elses"
reload_nginx
note
run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "a name that a site of someone else has" "${PREFIX}/sites-enabled/someone-elses names nexus.test already"
rm "${PREFIX}/sites-enabled/someone-elses"
reload_nginx
echo "# kept for later" > "${PREFIX}/sites-available/nexus.test.conf"
note
run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "a file of that name that is not its own" "${PREFIX}/sites-available/nexus.test.conf is there already"
rm "${PREFIX}/sites-available/nexus.test.conf"
echo "server { listen ${HTTP_PORT}; server_name broken.test; no_such_directive; }" > "${PREFIX}/sites-enabled/broken"
note
run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
refused "an nginx whose configuration is broken already" "does not pass its own test as it is"
check "  with what nginx says about it" says "no_such_directive"
rm "${PREFIX}/sites-enabled/broken"
note
# Without a terminal of its own, so that it cannot ask whoever runs this test.
if command -v setsid > /dev/null 2>&1; then
  CODE=0
  env PATH="${STUB}:${here}:${PATH}" XIERO_NGINX_HTTP_PORT="${HTTP_PORT}" XIERO_NGINX_HTTPS_PORT="${HTTPS_PORT}" XIERO_LETSENCRYPT_DIR="${LE}" \
    XIERO_ACME_WEBROOT="${ACME}" FAKE_CERTBOT_LOG="${CALLS}" setsid -w bash "${script}" --site nexus.test --upstream "${APP}" --agree-tos > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ "${CODE}" = "1" ] && says "there is no terminal to ask on" && unchanged && not_reloaded; then ok "going ahead without being told to"; else bad "going ahead without being told to" "code ${CODE}"; fi
fi
for wrong in "nexus.test; return 200" "nexus" "-nexus.test" "nexus..test" 'nexus.test$(id)'; do
  run -- --site "${wrong}" --upstream "${APP}" --agree-tos --yes
  if [ "${CODE}" = "1" ] && says "is not the name of a site" && unchanged; then ok "a name that is none: ${wrong}"; else bad "a name that is none: ${wrong}" "code ${CODE}"; fi
done
run -- --site nexus.test --upstream "http://127.0.0.1:${APP_PORT}/x; evil" --agree-tos --yes
if [ "${CODE}" = "1" ] && says "--upstream is an address such as" && unchanged; then ok "an address of the app that is none"; else bad "an address of the app that is none" "code ${CODE}"; fi
run -- --site nexus.test --upstream "${APP}" --max-body "1m; evil" --yes
if [ "${CODE}" = "1" ] && says "--max-body is a size" && unchanged; then ok "a size that is none"; else bad "a size that is none" "code ${CODE}"; fi

begin "When a step fails, nginx is as it was before"
failed_safely() { # NAME
  if unchanged && [ "$(others_get agent.test panel.test)" = "${OTHERS_BEFORE}" ] && [ "$(status "http://nexus.test:${HTTP_PORT}/")" = "301" ]; then ok "$1"; else bad "$1"; fi
}
note
run FAKE_NGINX_REFUSES="server_name nexus.test" -- --site nexus.test --upstream "${APP}" --agree-tos --yes
is "nginx refuses the configuration with the new file: it ends badly" "1" "${CODE}"
check "  saying what nginx said" says "nginx: [emerg] made up by the test"
check "  and that the file is taken out again" says "nginx is as it was before: ${PREFIX}/sites-available/nexus.test.conf is taken out again."
check "  nginx was never reloaded" not_reloaded
failed_safely "  no file is left, and the other sites answer as before"
run FAKE_NGINX_WARNS="server_name nexus.test" -- --site nexus.test --upstream "${APP}" --agree-tos --yes
is "nginx warns about something new with the file: it ends badly" "1" "${CODE}"
check "  saying what the warning is" says "a warning made up by the test"
check "  nginx was never reloaded" not_reloaded
failed_safely "  no file is left, and the other sites answer as before"
run FAKE_CERTBOT_FAILS=1 -- --site nexus.test --upstream "${APP}" --agree-tos --yes
is "certbot gets no certificate: it ends badly" "1" "${CODE}"
check "  with what certbot said" says "Detail: made up by the test"
check "  the site was in nginx for the questions only, and nginx was reloaded twice: in and out" eventually reloads_are "$((RELOADS_SEEN + 2))"
eventually gives 301 "http://nexus.test:${HTTP_PORT}/" || true
failed_safely "  no file is left, and the other sites answer as before"
check_not "  no certificate is left either" test -e "${LE}/live/nexus.test"
run FAKE_CERT_NAME=other.test -- --site nexus.test --upstream "${APP}" --agree-tos --yes
is "certbot comes back with a certificate for another name: it ends badly" "1" "${CODE}"
check "  saying so" says "certbot ended well, but there is no certificate for nexus.test"
eventually gives 301 "http://nexus.test:${HTTP_PORT}/" || true
failed_safely "  no file is left, and the other sites answer as before"
rm -rf "${LE}/live/nexus.test" "${LE}/renewal/nexus.test.conf"
run FAKE_CERTBOT_THEN="curl -s -o /dev/null ${APP}/__down" -- --site nexus.test --upstream "${APP}" --agree-tos --yes
is "the app stops answering before the site is done: it ends badly" "1" "${CODE}"
check "  saying what the site gave" says "${SITE}/api/health, asked on this machine, did not give 200 but: 500"
curl -fsS -o /dev/null "${APP}/__up"
eventually gives 301 "http://nexus.test:${HTTP_PORT}/" || true
failed_safely "  no file is left, and the other sites answer as before"
check "  the certificate that was made stays" test -s "${LE}/live/nexus.test/fullchain.pem"
rm -rf "${LE}"

begin "Two at once, and one that is stopped in the middle"
note
run FAKE_CERTBOT_SLEEP=4 -- --site nexus.test --upstream "${APP}" --agree-tos --yes &
first=$!
eventually grep -q 'certonly' "${CALLS}" || true
before_second="$(asked_for_certificates)"
(
  OUT="${WORK}/second.txt"
  run -- --site nexus.test --upstream "${APP}" --agree-tos --yes
  echo "${CODE}" > "${WORK}/second.code"
)
is "the second one does not start" "1" "$(cat "${WORK}/second.code")"
check "  saying why" grep -qF "another run of this script is at work on this nginx" "${WORK}/second.txt"
is "  and asks for no certificate" "${before_second}" "$(asked_for_certificates)"
# Stop the first: the script itself, a child of the shell it was started in.
# It takes notice once certbot has come back.
pkill -TERM -P "${first}" || true
wait "${first}" || true
eventually gives 301 "http://nexus.test:${HTTP_PORT}/" || true
failed_safely "the one that was stopped left no file, and the other sites answer as before"
rm -rf "${LE}"

# ═════════════════════════════════════════════════════════════════════════════

begin "The site is set up"
rm -f "${CALLS}"
note
others_files="$(files_print '*nexus.test.conf')"
run -- --site nexus.test --upstream "${APP}" --agree-tos --email ops@nexus.test --yes
is "it ends well" "0" "${CODE}"
check "it says that the site answers" says "==> ${SITE} answers"
check "  that the certificate is accepted, and until when it runs" line "the certificate is accepted: it is for nexus.test and runs until 20[0-9]{2}-[0-9]{2}-[0-9]{2}"
check "  that plain http is sent on" says "http://nexus.test:${HTTP_PORT} sends everyone on to https."
check "  and how to take it out again" says "sudo bash nginx-site.sh --site nexus.test --remove"
FILE="${PREFIX}/sites-available/nexus.test.conf"
check "the file is where sites are kept" test -f "${FILE}"
check "  switched on by a link, as the others are" test "$(readlink "${PREFIX}/sites-enabled/nexus.test.conf")" = "${FILE}"
is "  readable the way such files are" "644" "$(stat -c %a "${FILE}")"
check "  and says in its first line where it is from" test "$(head -n 1 "${FILE}")" = "# Written by scripts/host/nginx-site.sh of xiero-nexus-ai. Changes here are lost when it runs again."
is "no other file of nginx was changed" "${others_files}" "$(files_print '*nexus.test.conf')"
check_not "no half-written file is left" test -n "$(find "${PREFIX}" -name '.xiero-nexus-site.*')"
is "certbot was asked once" "1" "$(asked_for_certificates)"
check "  for this name, through the folder for the questions" grep -qE -- "^certonly --webroot -w ${ACME} -d nexus.test --cert-name nexus.test --non-interactive --keep-until-expiring --deploy-hook ${STUB}/nginx -s reload" "${CALLS}"
check "  with a new account that was agreed to" grep -qE -- "--agree-tos --email ops@nexus.test$" "${CALLS}"
check "  and nginx is reloaded when the certificate is renewed" grep -qF "renew_hook = ${STUB}/nginx -s reload" "${LE}/renewal/nexus.test.conf"
check "nginx still passes its own test" "${STUB}/nginx" -t
is "  without a warning it did not have" "${WARNINGS_BEFORE}" "$("${STUB}/nginx" -t 2>&1 | grep -c '\[warn\]' || true)"

begin "What a visitor gets"
is "the app, over https, with a certificate that is accepted" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
check "  which is the one certbot got for this name" shows nexus.test "${LE}/live/nexus.test/cert.pem"
is "plain http is sent on to https, to the same page" "301 ${SITE}/some/page?with=a+question" "$(visit -o /dev/null -w '%{http_code} %{redirect_url}' "http://nexus.test:${HTTP_PORT}/some/page?with=a+question")"
echo "an answer for Let's Encrypt" > "${ACME}/.well-known/acme-challenge/a-question"
is "  but Let's Encrypt's questions are answered there, for renewals" "an answer for Let's Encrypt" "$(visit "http://nexus.test:${HTTP_PORT}/.well-known/acme-challenge/a-question")"
rm "${ACME}/.well-known/acme-challenge/a-question"
is "  and nothing else of that folder is given out over https" "404" "$(status "${SITE}/.well-known/acme-challenge/a-question")"
seen="$(visit -H "X-Forwarded-For: 203.0.113.66" -H "X-Real-IP: 203.0.113.67" -H "X-Forwarded-Proto: http" "${SITE}/echo?page=1")"
field() { printf '%s' "${seen}" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined?"(none)":v)})' "$1"; }
is "the app is told the name that was asked for" "nexus.test" "$(field headers.host)"
is "  and the page" "/echo?page=1" "$(field url)"
is "  that it came over https, whatever the visitor claims" "https" "$(field headers.x-forwarded-proto)"
is "  and from whom, whatever the visitor claims" "127.0.0.1" "$(field headers.x-forwarded-for)"
is "    under the other name too" "127.0.0.1" "$(field headers.x-real-ip)"
is "  over a connection that is kept" "(none)" "$(field headers.connection)"
if [ "${CURL_H2}" = "yes" ]; then
  if [ "${H2_ALONE}" = "yes" ]; then
    is "HTTP/2 is offered, for this site alone" "2" "$(visit -o /dev/null -w '%{http_version}' --http2 "${SITE}/api/health")"
  else
    is "HTTP/2 is not switched on: this nginx could only do it for all sites" "1.1" "$(visit -o /dev/null -w '%{http_version}' --http2 "${SITE}/api/health")"
  fi
fi
# What has arrived of an answer after two and a half seconds; it takes four.
so_far() { (timeout 2.6 curl -sS -N --cacert "${CA}/ca.pem" --resolve "nexus.test:${HTTPS_PORT}:127.0.0.1" "${SITE}/stream$1" > "${WORK}/stream.txt" 2> /dev/null || true); }
so_far ""
check "an answer that is written bit by bit arrives bit by bit" grep -qF "data: part 1" "${WORK}/stream.txt"
check_not "  (it was not over yet)" grep -qF "data: part 4" "${WORK}/stream.txt"
so_far "?ends=close"
check "  also one that says neither how long it is nor comes in chunks" grep -qF "data: part 1" "${WORK}/stream.txt"
check_not "    (it was not over yet)" grep -qF "data: part 4" "${WORK}/stream.txt"
is "  and whole in the end" "5" "$(visit -N "${SITE}/stream" | grep -c '^data: ')"
head -c $((30 * 1024 * 1024)) /dev/zero > "${WORK}/30mb"
head -c $((34 * 1024 * 1024)) /dev/zero > "${WORK}/34mb"
upload() { visit --http1.1 -X POST --data-binary "@$1" -H "Content-Type: application/octet-stream" "${@:2}" "${SITE}/upload"; }
is "an upload of 30 MB reaches the app whole" "$((30 * 1024 * 1024))" "$(upload "${WORK}/30mb")"
is "  one of 34 MB is refused by nginx" "413" "$(upload "${WORK}/34mb" -o /dev/null -w '%{http_code}')"

begin "What the others get is what they got before"
is "the two sites and a name nobody has: the same answers, certificates and protocol" "${OTHERS_BEFORE}" "$(others_get agent.test panel.test)"
check "a name nobody has still gets the first site's certificate, not this one's" shows nobody.test "${PREFIX}/certs/agent.test/cert.pem"

begin "Running it again"
before_file="$(sha256sum < "${FILE}")"
note
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "it knows its own file" says "${FILE} is written anew (it is this script's, from an earlier run)"
check "  and that the name is a site already" says "Now         nexus.test is a site of this nginx (from an earlier run of this script)"
check "  and uses the certificate that is there" line "Certificate the one in ${LE}/live/nexus.test is used: it is for this name and runs until"
is "certbot is not asked again" "1" "$(asked_for_certificates)"
is "the file is the same" "${before_file}" "$(sha256sum < "${FILE}")"
check "  and nothing else changed" unchanged
is "the site answers" "200" "$(status "${SITE}/api/health")"
run -- --site nexus.test --upstream "${APP}" --max-body 8m --yes
is "with another size for uploads: it ends well" "0" "${CODE}"
head -c $((9 * 1024 * 1024)) /dev/zero > "${WORK}/9mb"
too_large() { [ "$(upload "$1" -o /dev/null -w '%{http_code}')" = "413" ]; }
check "  which then holds: 9 MB is refused" eventually too_large "${WORK}/9mb"
note
run FAKE_NGINX_REFUSES="client_max_body_size 4m" -- --site nexus.test --upstream "${APP}" --max-body 4m --yes
is "a change that nginx refuses ends badly" "1" "${CODE}"
check "  and the earlier version of the file is back" says "nginx is as it was before: the earlier version of ${FILE} is back."
check "  to the letter" unchanged
is "  with the site still answering" "200" "$(status "${SITE}/api/health")"

begin "A certificate that ends soon"
certificate nexus.test "${WORK}/short" 12
cp "${WORK}/short/fullchain.pem" "${WORK}/short/privkey.pem" "${LE}/live/nexus.test/"
reload_nginx
run -- --site nexus.test --upstream "${APP}" --dry-run
check "the plan says that it ends soon" says "the one that is there ends soon or is for another name: certbot 4.0.0 asks Let's Encrypt for one"
check "  with the account that is there" says "with the account certbot has on this machine"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
is "certbot was asked for a new one" "2" "$(asked_for_certificates)"
check_not "  without agreeing to anything again" grep -qE '^certonly.*--agree-tos' <(tail -n 1 "${CALLS}")
check "the site shows the new one" eventually shows nexus.test "${LE}/live/nexus.test/cert.pem"
check "  which runs for more than a month" openssl x509 -noout -checkend 2592000 -in "${LE}/live/nexus.test/cert.pem"

begin "Taking the site out again"
note
run -- --site nexus.test --remove --dry-run
is "a dry run ends well" "0" "${CODE}"
check "  names the file and the link" says "${FILE} and the link to it in ${PREFIX}/sites-enabled/ are removed"
check "  and what stays" says "Certificate stays in ${LE}/live/nexus.test, and so does the empty folder ${ACME}."
check "  and changes nothing" unchanged
run -- --site nexus.test --remove --yes
is "it ends well" "0" "${CODE}"
check "it says so" says "nexus.test is out of nginx. The app itself was not touched."
check_not "the file is gone" test -e "${FILE}"
check_not "  and the link" test -L "${PREFIX}/sites-enabled/nexus.test.conf"
check "the certificate stays" test -s "${LE}/live/nexus.test/fullchain.pem"
check "the name gets what names that nobody has get, again" eventually gives 301 "http://nexus.test:${HTTP_PORT}/"
is "the other sites answer as before" "${OTHERS_BEFORE}" "$(others_get agent.test panel.test)"
run -- --site nexus.test --remove --yes
is "taking out what is not there ends badly" "1" "${CODE}"
check "  saying that there is nothing" says "nginx has no site for nexus.test that this script wrote. Nothing was changed."
note
run -- --site agent.test --remove --yes
is "it does not take out a site of someone else" "1" "${CODE}"
check "  and leaves it as it is" unchanged

begin "With a certificate that is there already, certbot is not asked"
rm -f "${CALLS}"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
is "certbot was not asked" "0" "$(asked_for_certificates)"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
is "the other sites answer as before" "${OTHERS_BEFORE}" "$(others_get agent.test panel.test)"

begin "The app of a server is found by the server's ID"
VOLUMES="${WORK}/volumes"
mkdir -p "${VOLUMES}/${UUID}" "${VOLUMES}/0b0b0b0b-1111-4222-8333-444455556666"
run FAKE_SERVER_PORT="${APP_PORT}" FAKE_DOCKER_PORTS="0.0.0.0:9 :::${APP_PORT} 0.0.0.0:${APP_PORT}" -- --site nexus.test --server 0a11ce00 --volumes "${VOLUMES}" --dry-run
is "it ends well" "0" "${CODE}"
check "by the port the panel gave the server first, not by the first one Docker names" says "App         ${APP} (server ${UUID}), answers now: yes"
run FAKE_SERVER_PORT=1 FAKE_DOCKER_PORTS=":::${APP_PORT} 127.0.0.2:${APP_PORT}" -- --site nexus.test --server "${UUID}" --volumes "${VOLUMES}" --dry-run
check "a port that is passed on from one address only is asked at that address" says "App         http://127.0.0.2:${APP_PORT} (server ${UUID}), answers now: no"
run -- --site nexus.test --server 0a11ce00 --volumes "${VOLUMES}" --dry-run
is "a server that is not running: it ends badly" "1" "${CODE}"
check "  saying what to do" says "where the app of server ${UUID} answers cannot be found out"
run -- --site nexus.test --server 0c0c0c0c --volumes "${VOLUMES}" --dry-run
check "a server that is not there is said to be not there" says "there is no server \"0c0c0c0c\" in ${VOLUMES}."
run -- --site nexus.test --server "0a11ce00;id" --volumes "${VOLUMES}" --dry-run
check "an ID that is none is refused" says "is not a server ID"

# ═════════════════════════════════════════════════════════════════════════════
# The site must not become the one that names nobody has get.
# ═════════════════════════════════════════════════════════════════════════════

begin "Where nginx would read the new file first"
rm -rf "${LE}/live" "${LE}/renewal"
machine first "sites-enabled/*"
neighbour panel.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl"
start_nginx
OTHERS_BEFORE="$(others_get panel.test)"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the file has a name that nginx reads after the others" test -f "${PREFIX}/sites-available/zz-nexus.test.conf"
check "  and so has the link" test -L "${PREFIX}/sites-enabled/zz-nexus.test.conf"
check_not "  with nothing left under the first name" test -e "${PREFIX}/sites-enabled/nexus.test.conf" -o -e "${PREFIX}/sites-available/nexus.test.conf"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
is "the other site and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get panel.test)"
check "a name nobody has is still shown the other site's certificate" shows nobody.test "${PREFIX}/certs/panel.test/cert.pem"
note
run -- --site nexus.test --upstream "${APP}" --yes
is "running it again ends well" "0" "${CODE}"
check "  it finds its file under that name" says "${PREFIX}/sites-available/zz-nexus.test.conf is written anew"
check "  and changes nothing" unchanged
run -- --site nexus.test --remove --yes
check_not "taking it out removes the file" test -e "${PREFIX}/sites-available/zz-nexus.test.conf"
check_not "  and the link" test -L "${PREFIX}/sites-enabled/zz-nexus.test.conf"

begin "Where a site says that it is the one for unknown names"
rm -rf "${LE}/live" "${LE}/renewal"
machine named "sites-enabled/*"
neighbour panel.test sites-available "${HTTP_PORT} default_server" "${HTTPS_PORT} ssl default_server"
start_nginx
OTHERS_BEFORE="$(others_get panel.test)"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the file keeps its name: the order does not matter there" test -f "${PREFIX}/sites-available/nexus.test.conf"
is "the other site and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get panel.test)"

begin "Where no name would put the file after the others"
rm -rf "${LE}/live" "${LE}/renewal"
machine last "sites-enabled/*"
neighbour zzz.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl" "zzz.conf"
start_nginx
OTHERS_BEFORE="$(others_get zzz.test)"
note
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends badly" "1" "${CODE}"
check "saying that the site would be shown for every unknown name" says "nginx would show this site for every name it does not know on ${HTTP_PORT}"
check "  and what to do about it" says "\"default_server\" on its listen lines"
check "no file is left" unchanged
check "nginx was never reloaded" not_reloaded
is "the other site and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get zzz.test)"

# ═════════════════════════════════════════════════════════════════════════════
# Other ways nginx is laid out.
# ═════════════════════════════════════════════════════════════════════════════

begin "An nginx that keeps its sites in conf.d"
rm -rf "${LE}/live" "${LE}/renewal"
machine confd "conf.d/*.conf"
rmdir "${PREFIX}/sites-available" "${PREFIX}/sites-enabled"
neighbour agent.test conf.d "${HTTP_PORT}" "${HTTPS_PORT} ssl"
start_nginx
OTHERS_BEFORE="$(others_get agent.test)"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the file is there, without a link" test -f "${PREFIX}/conf.d/nexus.test.conf" -a ! -L "${PREFIX}/conf.d/nexus.test.conf"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
is "the other site and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get agent.test)"
run -- --site nexus.test --remove --yes
check_not "taking it out removes the file" test -e "${PREFIX}/conf.d/nexus.test.conf"

begin "An nginx that keeps its sites somewhere else"
machine elsewhere "vhosts/*.conf"
mkdir "${PREFIX}/vhosts"
start_nginx
note
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends badly" "1" "${CODE}"
check "saying that it cannot tell where the sites are" says "includes neither sites-enabled/* nor conf.d/*.conf"
check "nothing was changed" unchanged

begin "Sites that listen on one address by itself"
rm -rf "${LE}/live" "${LE}/renewal"
machine addresses "sites-enabled/*"
neighbour agent.test sites-available "127.0.0.1:${HTTP_PORT}" "127.0.0.1:${HTTPS_PORT} ssl"
neighbour panel.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl"
start_nginx
OTHERS_BEFORE="$(others_get agent.test panel.test)"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the site listens on the address its name leads to, as the site there does" grep -qF "listen 127.0.0.1:${HTTPS_PORT} ssl;" "${PREFIX}/sites-available/nexus.test.conf"
check_not "  and not on every address, where nginx would not hand it those requests" grep -qE "listen ${HTTPS_PORT} ssl;" "${PREFIX}/sites-available/nexus.test.conf"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
is "the other sites and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get agent.test panel.test)"

begin "Sites that have HTTP/2 as a word of \"listen\""
rm -rf "${LE}/live" "${LE}/renewal"
machine http2 "sites-enabled/*"
neighbour agent.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl http2"
neighbour panel.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl http2"
start_nginx
OTHERS_BEFORE="$(others_get agent.test panel.test)"
KINDS_BEFORE="$("${STUB}/nginx" -t 2>&1 | grep -F '[warn]' | sed -E 's/ in [^ ]+:[0-9]+$//' | sort -u || true)"
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the site has it the same way" grep -qF "listen ${HTTPS_PORT} ssl http2;" "${PREFIX}/sites-available/nexus.test.conf"
check_not "  and not the other way as well" grep -qF "http2 on;" "${PREFIX}/sites-available/nexus.test.conf"
is "nginx warns about nothing it did not warn about before" "${KINDS_BEFORE}" "$("${STUB}/nginx" -t 2>&1 | grep -F '[warn]' | sed -E 's/ in [^ ]+:[0-9]+$//' | sort -u || true)"
if [ "${CURL_H2}" = "yes" ]; then is "HTTP/2 is offered" "2" "$(visit -o /dev/null -w '%{http_version}' --http2 "${SITE}/api/health")"; fi
is "the other sites and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get agent.test panel.test)"

begin "An nginx that warns about every certificate already"
rm -rf "${LE}/live" "${LE}/renewal"
FOR_ALL_SITES="ssl_stapling on;" machine stapling "sites-enabled/*"
neighbour agent.test sites-available "${HTTP_PORT}" "${HTTPS_PORT} ssl"
start_nginx
stapling_warnings() { "${STUB}/nginx" -t 2>&1 | grep -c '\[warn\] "ssl_stapling" ignored' || true; }
is "it warns about the certificate of the site that is there" "1" "$(stapling_warnings)"
OTHERS_BEFORE="$(others_get agent.test)"
run -- --site nexus.test --upstream "${APP}" --yes
is "one more warning of that kind is nothing new: it ends well" "0" "${CODE}"
is "  (nginx does warn about the new certificate too)" "2" "$(stapling_warnings)"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"
is "the other site and a name nobody has get what they got before" "${OTHERS_BEFORE}" "$(others_get agent.test)"

begin "An nginx that has no sites yet"
rm -rf "${LE}/live" "${LE}/renewal"
machine empty "conf.d/*.conf" "sites-enabled/*"
start_nginx
run -- --site nexus.test --upstream "${APP}" --yes
is "it ends well" "0" "${CODE}"
check "the plan says that there are none" says "it has no sites yet"
is "the site answers" '{"status":"ok"}' "$(visit "${SITE}/api/health")"

ENDED=yes
summary="${passed} passed, ${failed} failed (a site in nginx ${NGINX_VERSION})"
printf '\n%s\n' "${summary}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  annotate error "${summary}"$'\n'"$(printf '%s\n' "${details[@]}")"
  exit 1
fi
annotate notice "${summary}"
