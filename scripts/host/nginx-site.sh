#!/usr/bin/env bash
# Give the app on a Pterodactyl server its public address: a site in the nginx
# of the machine that runs Wings, with a certificate from Let's Encrypt, so
# that https://<name> opens the app and no browser warns. As root:
#
#   sudo bash nginx-site.sh --server <server id> --site nexus.example.com --dry-run
#   sudo bash nginx-site.sh --server <server id> --site nexus.example.com
#
# What it does, in this order:
#
#   1. finds where the app answers on this machine (the port the panel gave
#      the server) and sees that it does,
#   2. looks at nginx: that it runs, that its configuration passes its own
#      test as it is, where it takes its sites from, how those listen, and
#      that none of them has this name,
#   3. sees that the name leads to this machine,
#   4. shows what it is going to do and asks,
#   5. adds one file to nginx: the site on the plain port, answering only what
#      Let's Encrypt asks for; tests the configuration and reloads nginx,
#   6. asks certbot for a certificate, unless a good one is there already,
#   7. writes that file anew: the plain port sends everyone on to https, and
#      https passes requests on to the app; tests, reloads,
#   8. asks the site for /api/health over https, with the certificate checked.
#
# The other sites of that nginx are left as they are. It writes one file of
# its own and changes no other; nginx is only reloaded with a configuration
# that `nginx -t` accepted without a new kind of warning; and the site nginx
# shows for names it does not know stays the one it was. When a step fails,
# the file is taken out again (or its earlier version put back), and nginx
# serves what it served before.
#
# certbot renews the certificate from then on, and nginx is reloaded when it
# has.
#
# Options: --help.
set -euo pipefail
umask 022

MARK="# Written by scripts/host/nginx-site.sh of xiero-nexus-ai. Changes here are lost when it runs again."
HTTP_PORT="${XIERO_NGINX_HTTP_PORT:-80}"
HTTPS_PORT="${XIERO_NGINX_HTTPS_PORT:-443}"
LE_DIR="${XIERO_LETSENCRYPT_DIR:-/etc/letsencrypt}"
WEBROOT="${XIERO_ACME_WEBROOT:-/var/www/xiero-nexus-acme}"
# A name no site has: what it gets is what nginx shows for names it does not know.
NO_SUCH_NAME="xiero-nexus-check.invalid"
# How long nginx is given to take a configuration it was told to take, in seconds.
RELOAD_WAIT="${XIERO_NGINX_RELOAD_WAIT:-30}"

SERVER=""
SITE=""
UPSTREAM=""
EMAIL=""
AGREE_TOS=false
MAX_BODY="32m"
REMOVE=false
SKIP_DNS=false
DRY_RUN=false
YES=false
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat << 'EOF'
Give the app on a Pterodactyl server its public address: a site in nginx with a
certificate from Let's Encrypt. Run as root on the machine that runs Wings.

  sudo bash nginx-site.sh --server <server id> --site <name> [options]

  --site <name>        The public name of the site, such as nexus.example.com.
                       An address (https://nexus.example.com) is understood too.
  --server <id>        The server whose app the site shows: its UUID, or the
                       first 8 characters of it. Where the app answers is
                       found out from the server's container.
  --upstream <url>     Where the app answers on this machine, instead of
                       --server: for example http://127.0.0.1:25565.
  --max-body <size>    The largest upload nginx lets through (default 32m; the
                       app itself takes files of up to 25 MB).
  --email <address>    For a new Let's Encrypt account, when certbot has none
                       on this machine yet.
  --agree-tos          Agree to Let's Encrypt's terms for such a new account
                       (https://letsencrypt.org/repository/). Not needed when
                       certbot has an account already.
  --remove             Take the site out of nginx again. The certificate stays.
  --skip-dns-check     Go on although the name, as seen from this machine,
                       does not lead to it.
  --dry-run            Show the plan and stop.
  --yes                Do not ask before starting.

  --volumes <dir>      Where Wings keeps server files (default: from the Wings
                       configuration, else /var/lib/pterodactyl/volumes).
  --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).

Environment:
  XIERO_NGINX_HTTP_PORT, XIERO_NGINX_HTTPS_PORT
                       The ports of the site, when they are not 80 and 443.
  XIERO_NGINX_RELOAD_WAIT
                       How many seconds nginx is given to take a configuration
                       (default 30).
  XIERO_LETSENCRYPT_DIR  certbot's folder (default /etc/letsencrypt).
  XIERO_ACME_WEBROOT   The folder Let's Encrypt's questions are answered from
                       (default /var/www/xiero-nexus-acme).
EOF
}
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$@"; SERVER="$2"; shift 2 ;;
    --site) need_value "$@"; SITE="$2"; shift 2 ;;
    --upstream) need_value "$@"; UPSTREAM="${2%/}"; shift 2 ;;
    --max-body) need_value "$@"; MAX_BODY="$2"; shift 2 ;;
    --email) need_value "$@"; EMAIL="$2"; shift 2 ;;
    --agree-tos) AGREE_TOS=true; shift ;;
    --remove) REMOVE=true; shift ;;
    --skip-dns-check) SKIP_DNS=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes | -y) YES=true; shift ;;
    --volumes) need_value "$@"; VOLUMES="$2"; shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; shift 2 ;;
    --help | -h) usage; exit 0 ;;
    *) die "unknown option: $1. See --help." ;;
  esac
done

# ── What was asked for ───────────────────────────────────────────────────────

[ -n "${SITE}" ] || die "name the site with --site, for example --site nexus.example.com."
DOMAIN="$(printf '%s' "${SITE}" | tr 'A-Z' 'a-z')"
DOMAIN="${DOMAIN#*://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="${DOMAIN%%:*}"
# Everything below writes this name into a file that nginx reads: letters,
# digits, dots and hyphens only.
[[ "${DOMAIN}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || die "\"${SITE}\" is not the name of a site. It looks like nexus.example.com."
[ "${#DOMAIN}" -le 200 ] || die "that name is too long."
[[ "${MAX_BODY}" =~ ^[0-9]+[kKmMgG]?$ ]] || die "--max-body is a size such as 32m."
if [ -n "${UPSTREAM}" ]; then
  [[ "${UPSTREAM}" =~ ^http://(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$ ]] || die "--upstream is an address such as http://127.0.0.1:25565."
fi
[[ "${HTTP_PORT}" =~ ^[0-9]{1,5}$ ]] && [[ "${HTTPS_PORT}" =~ ^[0-9]{1,5}$ ]] || die "XIERO_NGINX_HTTP_PORT and XIERO_NGINX_HTTPS_PORT are port numbers."
[[ "${RELOAD_WAIT}" =~ ^[0-9]{1,4}$ ]] || die "XIERO_NGINX_RELOAD_WAIT is a number of seconds."
case "${EMAIL}" in *[[:space:]\'\"\\]*) die "--email is an e-mail address." ;; esac

for tool in curl awk sed grep find mktemp date openssl sort comm readlink timeout; do
  command -v "${tool}" > /dev/null 2>&1 || die "this script needs \"${tool}\", which is not installed."
done
command -v nginx > /dev/null 2>&1 || die "nginx is not installed on this machine (or not where root finds it). This script adds a site to an nginx that is there; it does not install one."
NGINX="$(command -v nginx)"

if [ "$(id -u)" != "0" ]; then
  warn "not running as root: this only works where you may write nginx's files yourself."
fi

WORK="$(mktemp -d)"
PHASE="looking"
BEFORE=""     # a copy of this script's file as it was, when there was one
ORIG_FILE=""
ORIG_LINK=""
RELOADED=false
RENAMED=false
HALF=""       # a file that is being written, not yet in its place
PROBLEMS=()
problem() { PROBLEMS+=("$*"); }

# However this ends: when files of nginx were being changed, nginx is put
# back to what it had (put_back, further down), and nothing of this script's
# own is left lying about.
# shellcheck disable=SC2329  # called by the trap below
on_exit() {
  local code=$?
  trap - EXIT
  set +e
  [ -z "${HALF}" ] || rm -f "${HALF}"
  if [ "${PHASE}" = "changing" ]; then
    say ""
    if put_back; then
      if [ -n "${BEFORE}" ]; then
        say "nginx is as it was before: the earlier version of ${ORIG_FILE} is back."
      else
        say "nginx is as it was before: ${FILE} is taken out again."
      fi
    else
      warn "the file was taken back, but nginx's configuration does not pass its test now. nginx was not reloaded and goes on with what it had. Run nginx -t."
    fi
  fi
  rm -rf "${WORK}"
  exit "${code}"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Small helpers ────────────────────────────────────────────────────────────

# A value from the Wings configuration, such as "system.data".
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
confirm() { # QUESTION
  [ "${YES}" = true ] && return 0
  local answer=""
  if [ -t 0 ]; then
    read -r -p "$1 [y/N] " answer || true
  elif ! { read -r -p "$1 [y/N] " answer < /dev/tty; } 2> /dev/null; then
    die "there is no terminal to ask on. Add --yes to go ahead without asking."
  fi
  case "${answer}" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}
# What a request gets: "200", or "no answer: why".
status_of() { # URL [curl options]
  local url="$1" said
  shift
  said="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" "${url}" 2>&1 | tr '\n' ' ')" || true
  said="${said% }"
  case "${said}" in
    000 | "") echo "no answer" ;;
    [0-9][0-9][0-9]) echo "${said}" ;;
    *) echo "no answer: $(printf '%s' "${said}" | sed -e 's/^curl: ([0-9]*) //' -e 's/ *000$//' | cut -c 1-200)" ;;
  esac
}
version_at_least() { # HAVE WANT
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]
}
url_of() { # http|https PATH
  local port
  if [ "$1" = "https" ]; then port="${HTTPS_PORT}"; else port="${HTTP_PORT}"; fi
  case "$1:${port}" in
    http:80 | https:443) printf '%s://%s%s' "$1" "${DOMAIN}" "$2" ;;
    *) printf '%s://%s:%s%s' "$1" "${DOMAIN}" "${port}" "$2" ;;
  esac
}
# Everything nginx reads (the output of nginx -T), one directive a line: the
# file it stands in, then its words with single spaces between them. However
# it was laid out: several on one line, or one over several lines.
statements() {
  awk '
    function flush(    count, i, text) {
      count = split(all, parts, /[;{}]/)
      for (i = 1; i <= count; i++) {
        text = parts[i]
        gsub(/[[:space:]]+/, " ", text)
        sub(/^ /, "", text)
        sub(/ $/, "", text)
        if (text != "") print file "\t" text
      }
      all = ""
    }
    /^# configuration file .*:$/ { flush(); file = $0; sub(/^# configuration file /, "", file); sub(/:$/, "", file); next }
    { line = $0; sub(/#.*$/, "", line); all = all " " line }
    END { flush() }'
}
# The listen directives among them: the file, the address ("*" for every
# address), the port, and the words after them.
listen_rows() {
  awk -F '\t' '
    function row(spec,    address, port) {
      if (spec ~ /^unix:/) return ""
      address = spec
      port = "80"
      if (spec ~ /^[0-9]+$/) { address = "*"; port = spec }
      else if (spec ~ /^\[/) { if (match(spec, /\]:[0-9]+$/)) { port = substr(spec, RSTART + 2); address = substr(spec, 1, RSTART) } }
      else if (match(spec, /:[0-9]+$/)) { port = substr(spec, RSTART + 1); address = substr(spec, 1, RSTART - 1) }
      if (address == "0.0.0.0") address = "*"
      return address "\t" port
    }
    {
      count = split($2, words, " ")
      if (words[1] != "listen" || count < 2) next
      where = row(words[2])
      if (where == "") next
      flags = ""
      for (i = 3; i <= count; i++) flags = flags " " words[i]
      if (flags ~ / quic( |$)/) next  # that one is UDP
      print $1 "\t" where "\t" substr(flags, 2)
    }'
}
# What nginx warns about, without the place and without the certificate it is
# about: more of a warning that was there before is nothing new, another
# warning is.
warning_kinds() { (grep -F '[warn]' "$1" || true) | sed -E -e 's/ in [^ ]+:[0-9]+$//' -e 's/ in the certificate "[^"]*"//' | sort -u; }

# ── nginx as it is ───────────────────────────────────────────────────────────

NGINX_VERSION="$("${NGINX}" -v 2>&1 | sed -n 's|.*/\([0-9][0-9.]*\).*|\1|p' | head -n 1)"
NGINX_VERSION="${NGINX_VERSION:-0}"
NGINX_SOUND=true
if ! "${NGINX}" -t > "${WORK}/test-before.txt" 2>&1; then
  NGINX_SOUND=false
  problem "nginx's configuration does not pass its own test as it is, before anything was changed. This script does not touch it in that state. nginx says: $(grep -E 'emerg|error' "${WORK}/test-before.txt" | head -n 2 | cut -c 1-300 | tr '\n' ' ')"
fi
MAIN_CONF=""
CONF_DIR=""
FILE=""     # the file with the site
LINK=""     # the link to it that nginx reads, where sites are switched on by links
SEEN_AS=""  # the name nginx reads it under: the link, or the file
OURS=false
ROWS=""
SITE_FILES=0
if [ "${NGINX_SOUND}" = true ]; then
  # Everything nginx reads, with a line that names each file before its content.
  "${NGINX}" -T > "${WORK}/dump.txt" 2> /dev/null || true
  statements < "${WORK}/dump.txt" > "${WORK}/statements.txt"
  MAIN_CONF="$(sed -n 's/^# configuration file \(.*\):$/\1/p' "${WORK}/dump.txt" | head -n 1)"
  CONF_DIR="$(dirname "${MAIN_CONF:-/etc/nginx/nginx.conf}")"

  # Sites that have this name already, by the file they are in.
  named_in="$(awk -F '\t' -v name="${DOMAIN}" '{ count = split($2, words, " "); if (words[1] == "server_name") for (i = 2; i <= count; i++) if (words[i] == name) print $1 }' "${WORK}/statements.txt" | sort -u)"
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    if [ "${OURS}" != true ] && [ -f "${path}" ] && [ "$(head -n 1 "${path}")" = "${MARK}" ]; then
      # This script's own file, from an earlier run.
      OURS=true
      SEEN_AS="${path}"
      if [ -L "${path}" ]; then
        LINK="${path}"
        FILE="$(readlink -f "${path}")"
      else
        FILE="${path}"
      fi
    else
      problem "${path} names ${DOMAIN} already. This script does not change files it did not write."
    fi
  done <<< "${named_in}"

  if [ "${OURS}" != true ]; then
    # Where this nginx takes its sites from: the patterns of its include lines.
    includes="$(awk -F '\t' '{ count = split($2, words, " "); if (words[1] == "include" && count == 2) print words[2] }' "${WORK}/statements.txt" | tr -d "\"'" | while IFS= read -r pattern; do
      case "${pattern}" in /*) printf '%s\n' "${pattern}" ;; *) printf '%s/%s\n' "${CONF_DIR}" "${pattern}" ;; esac
    done)"
    if printf '%s\n' "${includes}" | grep -qxE "${CONF_DIR}/sites-enabled/\*(\.conf)?"; then
      if [ -d "${CONF_DIR}/sites-available" ]; then
        FILE="${CONF_DIR}/sites-available/${DOMAIN}.conf"
        LINK="${CONF_DIR}/sites-enabled/${DOMAIN}.conf"
      else
        FILE="${CONF_DIR}/sites-enabled/${DOMAIN}.conf"
      fi
    elif printf '%s\n' "${includes}" | grep -qxF "${CONF_DIR}/conf.d/*.conf"; then
      FILE="${CONF_DIR}/conf.d/${DOMAIN}.conf"
    else
      problem "it cannot be told where this nginx takes its sites from: ${MAIN_CONF} includes neither sites-enabled/* nor conf.d/*.conf."
    fi
    SEEN_AS="${LINK:-${FILE}}"
    for path in "${FILE}" "${LINK}"; do
      if [ -n "${path}" ] && { [ -e "${path}" ] || [ -L "${path}" ]; }; then
        problem "${path} is there already and nginx does not read it as a site of this script. It is left alone; look at what it is first."
      fi
    done
  fi

  # How the other sites listen.
  ROWS="$(listen_rows < "${WORK}/statements.txt" | awk -F '\t' -v ours="${SEEN_AS}" '$1 != ours')"
  SITE_FILES="$(printf '%s\n' "${ROWS}" | awk -F '\t' 'NF { print $1 }' | sort -u | wc -l | tr -d ' ')"
fi

# One at a time: the lock is on nginx's own configuration file, which is only read.
if [ -n "${MAIN_CONF}" ] && [ -r "${MAIN_CONF}" ] && command -v flock > /dev/null 2>&1; then
  exec 9< "${MAIN_CONF}"
  flock -n 9 || die "another run of this script is at work on this nginx."
fi

# The nginx that runs: the process whose number is in the file nginx names
# for that, and the processes it has for taking requests.
PID_FILE=""
MASTER=""
if [ "${NGINX_SOUND}" = true ]; then
  PID_FILE="$(awk -F '\t' '{ count = split($2, words, " "); if (words[1] == "pid" && count == 2) { print words[2]; exit } }' "${WORK}/statements.txt")"
  built_with="$("${NGINX}" -V 2>&1 | tr ' ' '\n')"
  [ -n "${PID_FILE}" ] || PID_FILE="$(printf '%s\n' "${built_with}" | sed -n 's/^--pid-path=//p' | head -n 1)"
  case "${PID_FILE}" in
    /* | "") ;;
    *)
      prefix="$(printf '%s\n' "${built_with}" | sed -n 's/^--prefix=//p' | head -n 1)"
      case "${prefix}" in /*) PID_FILE="${prefix%/}/${PID_FILE}" ;; *) PID_FILE="" ;; esac
      ;;
  esac
fi
NGINX_RUNS=true
if [ -n "${PID_FILE}" ]; then
  MASTER="$(head -n 1 "${PID_FILE}" 2> /dev/null | tr -dc '0-9' || true)"
  # A number that is left in the file can be another program's by now.
  if [ -z "${MASTER}" ] || ! { tr '\0' ' ' < "/proc/${MASTER}/cmdline"; } 2> /dev/null | grep -q nginx; then
    MASTER=""
    NGINX_RUNS=false
  fi
elif command -v pgrep > /dev/null 2>&1 && ! pgrep -x nginx > /dev/null 2>&1; then
  NGINX_RUNS=false
fi
[ "${NGINX_RUNS}" = true ] || problem "nginx is installed, but it is not running${PID_FILE:+ (${PID_FILE} names no process that is there)}. This script adds a site to a running nginx; it does not start one."
# shellcheck disable=SC2329  # also called by the trap at the top
takes_requests() { # PID: a process of this nginx that still takes new requests
  local title
  [ "$(awk '/^PPid:/ { print $2 }' "/proc/$1/status" 2> /dev/null || true)" = "${MASTER}" ] || return 1
  title="$({ tr '\0' ' ' < "/proc/$1/cmdline"; } 2> /dev/null || true)"
  case "${title}" in
    *"shutting down"*) return 1 ;;
    *"worker process"*) return 0 ;;
    *) return 1 ;;
  esac
}
# shellcheck disable=SC2329  # also called by the trap at the top
workers() {
  local pid
  [ -n "${MASTER}" ] || return 0
  for pid in $(awk -v master="${MASTER}" '/^Pid:/ { pid = $2 } /^PPid:/ && $2 == master { print pid }' /proc/[0-9]*/status 2> /dev/null || true); do
    if takes_requests "${pid}"; then printf '%s\n' "${pid}"; fi
  done
}

# ── Taking the file out, putting it back ─────────────────────────────────────

# Tell nginx to take the configuration, and wait until it has: nginx starts
# new processes for it and has the old ones take requests for a moment
# longer. Only when none of the old ones does any more is what the site
# answers the answer of the new configuration.
# shellcheck disable=SC2329  # also called by the trap at the top
reload_nginx() {
  local before pid left
  before="$(workers)"
  "${NGINX}" -s reload > "${WORK}/reload.txt" 2>&1 || return 1
  if [ -z "${before}" ]; then
    # Its processes cannot be seen from here: give it the time it usually takes.
    sleep 2
    return 0
  fi
  for _ in $(seq 1 $((RELOAD_WAIT * 5 + 1))); do
    left=""
    for pid in ${before}; do
      if takes_requests "${pid}"; then left="${pid}"; fi
    done
    [ -n "${left}" ] || return 0
    sleep 0.2
  done
  echo "nginx was told to take the configuration, but ${RELOAD_WAIT} seconds later it still answers with the processes it had: it did not take it. Its error log says why." > "${WORK}/reload.txt"
  return 1
}
# nginx as it was before this run: the file gone again, or its earlier version back.
# shellcheck disable=SC2329  # called by the trap at the top
put_back() {
  rm -f "${FILE}"
  [ -z "${LINK}" ] || rm -f "${LINK}"
  if [ -n "${BEFORE}" ]; then
    cat "${BEFORE}" > "${ORIG_FILE}"
    [ -z "${ORIG_LINK}" ] || ln -sfn "${ORIG_FILE}" "${ORIG_LINK}"
  fi
  if "${NGINX}" -t > /dev/null 2>&1; then
    if [ "${RELOADED}" = true ]; then reload_nginx || true; fi
    return 0
  fi
  return 1
}

# ── --remove ─────────────────────────────────────────────────────────────────

if [ "${REMOVE}" = true ]; then
  [ "${NGINX_SOUND}" = true ] || die "${PROBLEMS[0]}"
  [ "${OURS}" = true ] || die "nginx has no site for ${DOMAIN} that this script wrote. Nothing was changed."
  step "Take the site out of nginx"
  say "  Site        ${DOMAIN}"
  say "  File        ${FILE}${LINK:+ and the link to it in ${LINK%/*}/} $([ -n "${LINK}" ] && echo are || echo is) removed"
  say "  Certificate stays in ${LE_DIR}/live/${DOMAIN}, and so does the empty folder ${WEBROOT}."
  say "              To remove the certificate too:  certbot delete --cert-name ${DOMAIN}"
  if [ "${DRY_RUN}" = true ]; then
    say ""
    say "Dry run: nothing was changed."
    exit 0
  fi
  say ""
  confirm "Take ${DOMAIN} out of nginx now?" || die "stopped; nothing was changed."
  BEFORE="${WORK}/before.conf"
  cp "${FILE}" "${BEFORE}"
  ORIG_FILE="${FILE}"
  ORIG_LINK="${LINK}"
  PHASE="changing"
  rm -f "${FILE}"
  [ -z "${LINK}" ] || rm -f "${LINK}"
  "${NGINX}" -t > "${WORK}/test.txt" 2>&1 || die "without that file nginx's configuration does not pass its test: $(grep -E 'emerg|error' "${WORK}/test.txt" | head -n 2 | tr '\n' ' ')"
  RELOADED=true
  reload_nginx || die "nginx could not be reloaded: $(tr '\n' ' ' < "${WORK}/reload.txt" | cut -c 1-300)"
  PHASE="done"
  say ""
  say "${DOMAIN} is out of nginx. The app itself was not touched."
  exit 0
fi

# ── Where the app answers ────────────────────────────────────────────────────

UUID=""
if [ -z "${UPSTREAM}" ]; then
  if [ -z "${SERVER}" ]; then
    problem "it is not said where the app answers: name the server with --server, or the address with --upstream."
  else
    if [ -z "${VOLUMES}" ]; then
      VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
      [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
    fi
    [[ "${SERVER}" =~ ^[0-9a-fA-F-]{8,36}$ ]] || die "\"${SERVER}\" is not a server ID. Use the UUID of the server, or its first 8 characters."
    SERVER="$(printf '%s' "${SERVER}" | tr 'A-F' 'a-f')"
    matches=()
    for folder in "${VOLUMES}/${SERVER}"*/; do
      [ -d "${folder}" ] && matches+=("$(basename "${folder%/}")")
    done
    case "${#matches[@]}" in
      0) problem "there is no server \"${SERVER}\" in ${VOLUMES}." ;;
      1) UUID="${matches[0]}" ;;
      *) problem "\"${SERVER}\" fits more than one server. Use the whole UUID." ;;
    esac
    if [ -n "${UUID}" ]; then
      # The ports of this machine that Docker passes on to the server; Wings
      # names the container after the server. The app listens on the first
      # port the panel gave it (SERVER_PORT).
      passed=""
      wanted=""
      if command -v docker > /dev/null 2>&1; then
        passed="$(docker inspect -f '{{range $port, $to := .NetworkSettings.Ports}}{{range $to}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "${UUID}" 2> /dev/null | tr ' ' '\n' | grep -v '^$' | sort -u || true)"
        wanted="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${UUID}" 2> /dev/null | sed -n 's/^SERVER_PORT=//p' | head -n 1 || true)"
      fi
      chosen=""
      for want in "${wanted}" ""; do
        while IFS= read -r entry; do
          [ -n "${entry}" ] || continue
          case "${entry%:*}" in *:*) continue ;; esac # an IPv6 address: the IPv4 one leads to the same place
          if [ -z "${want}" ] || [ "${entry##*:}" = "${want}" ]; then
            chosen="${entry}"
            break 2
          fi
        done <<< "${passed}"
      done
      if [ -z "${chosen}" ]; then
        problem "where the app of server ${UUID} answers cannot be found out: the server is not running, or Docker does not answer. Start it, or name the address with --upstream http://127.0.0.1:<port>."
      else
        address="${chosen%:*}"
        case "${address}" in "" | 0.0.0.0) address="127.0.0.1" ;; esac
        UPSTREAM="http://${address}:${chosen##*:}"
      fi
    fi
  fi
fi
APP_SAYS=""
if [ -n "${UPSTREAM}" ]; then
  APP_SAYS="$(status_of "${UPSTREAM}/api/health")"
  [ "${APP_SAYS}" = "200" ] || problem "the app does not answer at ${UPSTREAM}/api/health (${APP_SAYS}). The site would show an error: start the server first."
fi

# ── Where the name leads ─────────────────────────────────────────────────────

LEADS_TO="$( (getent ahosts "${DOMAIN}" 2> /dev/null || true) | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
LEADS_TO="${LEADS_TO% }"
OWN="$( { hostname -I 2> /dev/null || true; ip -o addr show 2> /dev/null | awk '{ print $4 }' | cut -d / -f 1 || true; } | tr ' ' '\n' | grep -v '^$' | sort -u || true)"
NAME_ADDR4="" # the IPv4 address of this machine that the name leads to
NAME_SAYS=""
if [ -z "${LEADS_TO}" ]; then
  NAME_SAYS="does not lead anywhere, as seen from this machine"
  [ "${SKIP_DNS}" = true ] || problem "${DOMAIN} does not lead anywhere: it has no DNS record that this machine can see, so Let's Encrypt could not find the site either. Make an A record for it with this machine's address first (a new record can take some minutes to be seen)."
else
  elsewhere=""
  for address in ${LEADS_TO}; do
    if printf '%s\n' "${OWN}" | grep -qxF "${address}"; then
      case "${address}" in *:*) ;; *) NAME_ADDR4="${address}" ;; esac
    else
      elsewhere="${elsewhere}${address} "
    fi
  done
  if [ -z "${elsewhere}" ]; then
    NAME_SAYS="leads to ${LEADS_TO}, $(case "${LEADS_TO}" in *" "*) echo "addresses" ;; *) echo "an address" ;; esac) of this machine"
  else
    NAME_SAYS="leads to ${LEADS_TO}; ${elsewhere% } is not an address of this machine"
    [ "${SKIP_DNS}" = true ] || problem "${DOMAIN} leads to ${elsewhere% }, which is not an address of this machine. Let's Encrypt asks the site at the address the name leads to, so it would not find it here. Point the name at this machine; or, when this machine is reached through that address after all, add --skip-dns-check."
  fi
fi
# Requests of this script go to the site the way a visitor's do: to the name,
# at the address it leads to here.
CHECK_ADDR="${NAME_ADDR4:-127.0.0.1}"
at_this_machine() { printf '%s:%s:%s' "${DOMAIN}" "$1" "${CHECK_ADDR}"; } # PORT

# What a name gets from this nginx now: the answer on the plain port (without
# the name itself in it), and the certificate on the other. Empty where
# nothing answers.
name_gets() { # http|https NAME
  if [ "$1" = "http" ]; then
    curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 --resolve "$2:${HTTP_PORT}:${CHECK_ADDR}" "http://$2:${HTTP_PORT}/" 2> /dev/null | sed -e 's/^000 *$//' -e "s/$2/<name>/g" || true
  else
    (timeout 10 openssl s_client -connect "${CHECK_ADDR}:${HTTPS_PORT}" -servername "$2" < /dev/null 2> /dev/null || true) | (openssl x509 -noout -fingerprint -sha256 2> /dev/null || true)
  fi
}
# A name that no site has.
unknown_name_gets() { name_gets "$1" "${NO_SUCH_NAME}"; }
# The names of the certificate a name is shown.
certificate_shown_to() { # NAME
  (timeout 10 openssl s_client -connect "${CHECK_ADDR}:${HTTPS_PORT}" -servername "$1" < /dev/null 2> /dev/null || true) \
    | (openssl x509 -noout -ext subjectAltName 2> /dev/null || true) | (grep -o 'DNS:[^,]*' || true) | sed 's/DNS://' | head -n 4 | tr '\n' ' ' | sed 's/ $//'
}
UNKNOWN_HTTP=""
UNKNOWN_HTTPS=""
NOW_SAYS=""
if [ "${NGINX_SOUND}" = true ] && [ "${NGINX_RUNS}" = true ]; then
  UNKNOWN_HTTP="$(unknown_name_gets http)"
  UNKNOWN_HTTPS="$(unknown_name_gets https)"
  if [ "${OURS}" = true ]; then
    NOW_SAYS="${DOMAIN} is a site of this nginx (from an earlier run of this script)"
  elif [ "$(name_gets http "${DOMAIN}")" = "${UNKNOWN_HTTP}" ] && [ "$(name_gets https "${DOMAIN}")" = "${UNKNOWN_HTTPS}" ]; then
    shown="$(certificate_shown_to "${DOMAIN}")"
    NOW_SAYS="${DOMAIN} is no site of this nginx: it gets what any name gets that nginx does not know"
    if [ -n "${shown}" ]; then NOW_SAYS="${NOW_SAYS}, and over https the certificate of ${shown}"; fi
  else
    NOW_SAYS="another site of this nginx answers for ${DOMAIN} already (its names cover it with a wildcard or a pattern). The new site takes this one name from it"
  fi
fi

# ── How the site listens ─────────────────────────────────────────────────────

# The way the sites that are there do, so that nginx hands the requests for
# this name to it: on the address the name leads to when sites listen on that
# one by itself, else on every address when sites do that.
pick_addresses() { # PORT: one address a line; "*" is every address
  local port="$1" there
  there="$(printf '%s\n' "${ROWS}" | awk -F '\t' -v port="${port}" '$3 == port { print $2 }' | sort -u)"
  if [ -n "${NAME_ADDR4}" ] && printf '%s\n' "${there}" | grep -qxF -e "${NAME_ADDR4}"; then
    printf '%s\n' "${NAME_ADDR4}"
  elif printf '%s\n' "${there}" | grep -qxF -e '*' -e '[::]'; then
    printf '%s\n' "${there}" | grep -xF -e '*' -e '[::]'
  elif [ -z "${there}" ]; then
    printf '*\n'
  elif [ -n "${NAME_ADDR4}" ]; then
    printf '%s\n' "${NAME_ADDR4}"
  else
    return 1
  fi
}
# The words the other sites give a listen that all sites on it must agree on.
shared_words() { # ADDRESS PORT
  printf '%s\n' "${ROWS}" | awk -F '\t' -v address="$1" -v port="$2" '
    $2 == address && $3 == port { count = split($4, words, " "); for (i = 1; i <= count; i++) seen[words[i]] = 1 }
    END { if (seen["http2"]) printf " http2"; if (seen["proxy_protocol"]) printf " proxy_protocol" }'
}
listen_line() { # ADDRESS PORT WORDS
  case "$1" in
    "*") printf 'listen %s%s;' "$2" "$3" ;;
    *) printf 'listen %s:%s%s;' "$1" "$2" "$3" ;;
  esac
}
HTTP_LISTENS=()
HTTPS_LISTENS=()
HTTP2_DIRECTIVE=false
if [ "${NGINX_SOUND}" = true ]; then
  if addresses="$(pick_addresses "${HTTP_PORT}")" && more="$(pick_addresses "${HTTPS_PORT}")"; then
    while IFS= read -r address; do
      HTTP_LISTENS+=("$(listen_line "${address}" "${HTTP_PORT}" "$(shared_words "${address}" "${HTTP_PORT}")")")
    done <<< "${addresses}"
    # HTTP/2 the way the others have it. Where nobody has it as a word of
    # "listen", it is switched on for this site alone, which nginx can do
    # from 1.25.1; before that it could only be had for all sites together.
    h2_as_word=false
    while IFS= read -r address; do
      words="$(shared_words "${address}" "${HTTPS_PORT}")"
      case "${words}" in *" http2"*) h2_as_word=true ;; esac
      HTTPS_LISTENS+=("$(listen_line "${address}" "${HTTPS_PORT}" " ssl${words}")")
    done <<< "${more}"
    if [ "${h2_as_word}" != true ] && version_at_least "${NGINX_VERSION}" "1.25.1"; then HTTP2_DIRECTIVE=true; fi
  else
    problem "the sites of this nginx listen on addresses of their own (not on every address), and ${DOMAIN} does not lead to an address of this machine, so it cannot be told which one the site is to listen on."
  fi
fi
# What the other sites listen with on the two ports, for the plan.
OTHERS_LISTEN="$(printf '%s\n' "${ROWS}" | awk -F '\t' -v a="${HTTP_PORT}" -v b="${HTTPS_PORT}" '
  $3 == a || $3 == b {
    text = ($2 == "*" ? $3 : $2 ":" $3)
    count = split($4, words, " ")
    for (i = 1; i <= count; i++) if (words[i] ~ /^(ssl|http2|proxy_protocol|default_server|default)$/) text = text " " words[i]
    if (!(text in seen)) { seen[text] = 1; list = list (list == "" ? "" : ", ") text }
  }
  END { print list }')"

# ── The certificate ──────────────────────────────────────────────────────────

CERT="${LE_DIR}/live/${DOMAIN}/fullchain.pem"
KEY="${LE_DIR}/live/${DOMAIN}/privkey.pem"
cert_until() { date -d "$(openssl x509 -noout -enddate -in "${CERT}" 2> /dev/null | cut -d = -f 2)" +%Y-%m-%d 2> /dev/null || echo "an unknown day"; }
# A certificate for this name that runs for another 30 days at least.
cert_is_good() {
  [ -f "${CERT}" ] && [ -f "${KEY}" ] \
    && openssl x509 -noout -checkend 2592000 -in "${CERT}" > /dev/null 2>&1 \
    && openssl x509 -noout -checkhost "${DOMAIN}" -in "${CERT}" 2> /dev/null | grep -q 'does match'
}
CERT_GOOD=false
if cert_is_good; then CERT_GOOD=true; fi
CERTBOT=""
CERTBOT_VERSION=""
CERTBOT_KEEPS=""
HAS_ACCOUNT=false
if command -v certbot > /dev/null 2>&1; then
  CERTBOT="$(command -v certbot)"
  CERTBOT_VERSION="$("${CERTBOT}" --version 2> /dev/null | awk '{ print $NF }' | head -n 1 || true)"
  # What it keeps on this machine, and how it proves each name.
  CERTBOT_KEEPS="$( (grep -hs '^authenticator' "${LE_DIR}"/renewal/*.conf || true) | awk '{ how[$NF]++; total++ } END { if (total) { printf "%d certificates (proved by:", total; for (name in how) printf " %s %d", name, how[name]; printf ")" } }')"
  if find "${LE_DIR}/accounts" -path '*acme-v02.api.letsencrypt.org*' -name regr.json 2> /dev/null | grep -q .; then HAS_ACCOUNT=true; fi
fi
if [ "${CERT_GOOD}" != true ]; then
  if [ -z "${CERTBOT}" ]; then
    problem "certbot is not installed, so no certificate can be asked for. Install it (on Debian and Ubuntu: apt-get install -y certbot) and run this again."
  elif [ "${HAS_ACCOUNT}" != true ] && [ "${AGREE_TOS}" != true ]; then
    problem "certbot has no Let's Encrypt account on this machine yet. Making one means agreeing to Let's Encrypt's terms (https://letsencrypt.org/repository/): when you do, run this again with --agree-tos, and with --email <address> to give them one."
  fi
fi
# Whether certbot has noted, with this certificate's renewal settings, that
# nginx is to be reloaded once it was renewed. Without that, nginx would go
# on showing the old certificate until something else reloads it.
RENEWAL_CONF="${LE_DIR}/renewal/${DOMAIN}.conf"
HOOK="${NGINX} -s reload"
reloads_after_renewal() { grep -qsF -- "${HOOK}" "${RENEWAL_CONF}"; }
# What renews certificates on this machine by itself.
RENEWAL=""
if command -v systemctl > /dev/null 2>&1 && systemctl is-active --quiet certbot.timer 2> /dev/null; then
  RENEWAL="certbot.timer"
elif command -v systemctl > /dev/null 2>&1 && systemctl is-active --quiet snap.certbot.renew.timer 2> /dev/null; then
  RENEWAL="the timer of certbot's snap"
else
  while IFS= read -r line; do
    # The job Debian's package brings does nothing where systemd runs: there the timer does it.
    if [ -d /run/systemd/system ] && [[ "${line}" == *"/run/systemd/system"* ]]; then continue; fi
    RENEWAL="a cron job (${line%%:*})"
    break
  done < <(grep -sE '^[^#]*certbot.*renew' /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/root /var/spool/cron/root 2> /dev/null || true)
fi

# ── The plan ─────────────────────────────────────────────────────────────────

step "The plan"
say "  Site        $(url_of https "")"
say "  App         ${UPSTREAM:-unknown}${UUID:+ (server ${UUID})}${APP_SAYS:+, answers now: $([ "${APP_SAYS}" = "200" ] && echo yes || echo no)}"
say "  Name        ${DOMAIN} ${NAME_SAYS}"
if [ -n "${NOW_SAYS}" ]; then say "  Now         ${NOW_SAYS}"; fi
say "  nginx       ${NGINX_VERSION} (${NGINX}), $([ "${NGINX_RUNS}" = true ] && echo running || echo "not running"); its configuration $([ "${NGINX_SOUND}" = true ] && echo "passes its test" || echo "does NOT pass its test")"
if [ "${NGINX_SOUND}" = true ]; then
  if [ "${SITE_FILES}" -gt 0 ]; then
    say "              ${SITE_FILES} $([ "${SITE_FILES}" = 1 ] && echo "file has" || echo "files have") sites now${OTHERS_LISTEN:+; on these ports they listen with: ${OTHERS_LISTEN}}"
  else
    say "              it has no sites yet"
  fi
fi
if [ -n "${FILE}" ]; then
  say "  File        ${FILE} is $([ "${OURS}" = true ] && echo "written anew (it is this script's, from an earlier run)" || echo "written")${LINK:+, with a link in ${LINK%/*}/}"
  if [ "${#HTTP_LISTENS[@]}" -gt 0 ]; then
    say "              It has: ${HTTP_LISTENS[*]} ${HTTPS_LISTENS[*]}$([ "${HTTP2_DIRECTIVE}" = true ] && echo " http2 on;")"
  fi
  say "              No other file of nginx is changed."
fi
if [ "${CERT_GOOD}" = true ]; then
  say "  Certificate the one in ${LE_DIR}/live/${DOMAIN} is used: it is for this name and runs until $(cert_until)"
elif [ -n "${CERTBOT}" ]; then
  say "  Certificate $([ -f "${CERT}" ] && echo "the one that is there ends soon or is for another name" || echo "none yet"): certbot ${CERTBOT_VERSION} asks Let's Encrypt for one,"
  if [ "${HAS_ACCOUNT}" = true ]; then
    say "              with the account certbot has on this machine. Let's Encrypt's questions are answered from ${WEBROOT}."
  elif [ "${AGREE_TOS}" = true ]; then
    say "              with a new account$([ -n "${EMAIL}" ] && echo " for ${EMAIL}" || echo " without an e-mail address"), agreeing to Let's Encrypt's terms (--agree-tos). Its questions are answered from ${WEBROOT}."
  else
    say "              for which certbot needs an account with Let's Encrypt first: see below."
  fi
else
  say "  Certificate none, and certbot is not installed"
fi
if [ -n "${CERTBOT_KEEPS}" ]; then say "              certbot keeps ${CERTBOT_KEEPS} on this machine now"; fi
if [ -n "${RENEWAL}" ] && [ "${CERT_GOOD}" = true ] && [ ! -f "${RENEWAL_CONF}" ]; then
  say "  Renewal     ${RENEWAL} renews certbot's certificates on this machine, but this one is not certbot's"
  say "              (no ${RENEWAL_CONF}): whoever put it there has to renew it."
elif [ -n "${RENEWAL}" ] && [ "${CERT_GOOD}" = true ] && ! reloads_after_renewal; then
  say "  Renewal     ${RENEWAL} renews certificates on this machine. certbot is NOT told to reload nginx when this"
  say "              one was renewed. To tell it:  certbot reconfigure --cert-name ${DOMAIN} --deploy-hook \"${HOOK}\""
elif [ -n "${RENEWAL}" ]; then
  say "  Renewal     ${RENEWAL} renews certificates on this machine; nginx is reloaded when this one was"
else
  say "  Renewal     nothing was found on this machine that renews certificates by itself (no certbot.timer, no cron job)."
  say "              A certificate runs for 90 days: have \"certbot renew\" run every day, or this site warns again then."
fi
say "  Uploads     up to ${MAX_BODY}"

if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  say ""
  say "This cannot go on:"
  for text in "${PROBLEMS[@]}"; do say "  - ${text}"; done
  say ""
  say "Nothing was changed."
  exit 1
fi
if [ "${DRY_RUN}" = true ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi
say ""
confirm "Add this site to nginx now?" || die "stopped; nothing was changed."

# ── The file ─────────────────────────────────────────────────────────────────

# Written next to its place, under a name nginx does not read, and moved
# there: nginx never reads half a file.
write_site() { # first|final
  local line
  HALF="$(mktemp "$(dirname "${FILE}")/.xiero-nexus-site.XXXXXX")"
  {
    printf '%s\n' "${MARK}"
    printf '# %s, the app of %s.\n' "${DOMAIN}" "${UUID:+server ${UUID} at }${UPSTREAM}"
    printf '# To take it out again:  bash nginx-site.sh --site %s --remove\n\n' "${DOMAIN}"
    printf 'server {\n'
    for line in "${HTTP_LISTENS[@]}"; do printf '    %s\n' "${line}"; done
    printf '    server_name %s;\n\n' "${DOMAIN}"
    printf "    # What Let's Encrypt asks for, when the certificate is made and renewed.\n"
    printf '    location ^~ /.well-known/acme-challenge/ {\n'
    printf '        root %s;\n' "${WEBROOT}"
    printf '        default_type text/plain;\n'
    printf '    }\n'
    if [ "$1" = "first" ]; then
      printf '    location / {\n        return 503;\n    }\n}\n'
    else
      printf '    location / {\n        return 301 %s$request_uri;\n    }\n}\n\n' "$(url_of https "")"
      printf 'server {\n'
      for line in "${HTTPS_LISTENS[@]}"; do printf '    %s\n' "${line}"; done
      if [ "${HTTP2_DIRECTIVE}" = true ]; then printf '    http2 on;\n'; fi
      printf '    server_name %s;\n\n' "${DOMAIN}"
      printf '    ssl_certificate %s;\n' "${CERT}"
      printf '    ssl_certificate_key %s;\n\n' "${KEY}"
      printf '    client_max_body_size %s;\n\n' "${MAX_BODY}"
      printf '    location / {\n'
      printf '        proxy_pass %s;\n' "${UPSTREAM}"
      printf '        proxy_http_version 1.1;\n'
      printf '        proxy_set_header Connection "";\n'
      printf '        proxy_set_header Host $host;\n'
      printf '        proxy_set_header X-Forwarded-Host $host;\n'
      printf '        proxy_set_header X-Forwarded-Proto $scheme;\n'
      printf '        # The address of whoever asks, as nginx saw it. The app takes the first\n'
      printf '        # address of X-Forwarded-For, so what a visitor sends under that name is\n'
      printf '        # not passed on.\n'
      printf '        proxy_set_header X-Forwarded-For $remote_addr;\n'
      printf '        proxy_set_header X-Real-IP $remote_addr;\n'
      printf '        # Answers that are written bit by bit (a chat, the progress of a run)\n'
      printf '        # are passed on as they come, for as long as they take.\n'
      printf '        proxy_buffering off;\n'
      printf '        proxy_read_timeout 1h;\n'
      printf '        proxy_send_timeout 1h;\n'
      printf '    }\n}\n'
    fi
  } > "${HALF}"
  chmod 644 "${HALF}"
  mv -f "${HALF}" "${FILE}"
  HALF=""
  if [ -n "${LINK}" ]; then ln -sfn "${FILE}" "${LINK}"; fi
}
# The addresses and ports on which this script's file would become the site
# nginx shows for names it does not know, in place of the one that is that
# now: where other sites listen too, none of them says it is the default, and
# nginx reads this file before theirs.
takes_over() {
  "${NGINX}" -T 2> /dev/null | statements | listen_rows | awk -F '\t' -v ours="${SEEN_AS}" '
    {
      key = ($2 == "*" ? "" : $2 ":") $3
      if (!(key in first)) first[key] = $1
      if ($1 == ours) mine[key] = 1; else others[key] = 1
      if ($4 ~ /(^| )default(_server)?( |$)/) named[key] = 1
    }
    END { for (key in mine) if (others[key] && !named[key] && first[key] == ours) printf "%s ", key }'
}
# Give the file a name that nginx reads after the others.
read_last() {
  local folder new_file new_link="" path
  folder="$(dirname "${FILE}")"
  new_file="${folder}/zz-${DOMAIN}.conf"
  [ -z "${LINK}" ] || new_link="$(dirname "${LINK}")/zz-${DOMAIN}.conf"
  for path in "${new_file}" "${new_link}"; do
    if [ -n "${path}" ] && { [ -e "${path}" ] || [ -L "${path}" ]; }; then return 1; fi
  done
  mv "${FILE}" "${new_file}" || return 1
  FILE="${new_file}"
  if [ -n "${LINK}" ]; then
    # The new link first: the old one then points at nothing and is removed.
    ln -sfn "${FILE}" "${new_link}" || return 1
    rm -f "${LINK}" || return 1
    LINK="${new_link}"
  fi
  SEEN_AS="${LINK:-${FILE}}"
  RENAMED=true
}
nginx_accepts() { # WHAT, for the message
  if ! "${NGINX}" -t > "${WORK}/test.txt" 2>&1; then
    say "nginx does not accept its configuration with $1:"
    (grep -E 'emerg|error|failed' "${WORK}/test.txt" || true) | head -n 5 | sed 's/^/  /'
    return 1
  fi
  new_kinds="$(comm -13 <(warning_kinds "${WORK}/test-before.txt") <(warning_kinds "${WORK}/test.txt"))"
  if [ -n "${new_kinds}" ]; then
    say "nginx accepts its configuration with $1, but warns about something it did not warn about before:"
    printf '%s\n' "${new_kinds}" | head -n 5 | sed 's/^/  /'
    return 1
  fi
}
# Test the configuration and, when nginx accepts it, reload.
apply() { # WHAT, for the message
  local where
  nginx_accepts "$1" || return 1
  where="$(takes_over)"
  if [ -n "${where}" ] && [ "${RENAMED}" != true ]; then
    # nginx reads the files of a folder by name, and this one would come first.
    if read_last; then
      nginx_accepts "$1" || return 1
      where="$(takes_over)"
    fi
  fi
  if [ -n "${where}" ]; then
    say "With $1, nginx would show this site for every name it does not know on ${where% }, in place of the site it shows for them now. That would change other sites, so it is not done."
    say "Say which site is the one for unknown names: \"default_server\" on its listen lines."
    return 1
  fi
  # From here on nginx may have the file, also when it is not seen to take it:
  # putting things back then tells it once more.
  RELOADED=true
  if ! reload_nginx; then
    say "nginx could not be reloaded: $(tr '\n' ' ' < "${WORK}/reload.txt" | cut -c 1-300)"
    return 1
  fi
}
# The same as before the change, for the names of other sites and of none.
others_untouched() {
  local kind before now
  for kind in http https; do
    if [ "${kind}" = "http" ]; then before="${UNKNOWN_HTTP}"; else before="${UNKNOWN_HTTPS}"; fi
    [ -n "${before}" ] || continue
    now="$(unknown_name_gets "${kind}")"
    if [ "${now}" != "${before}" ]; then
      say "A name that no site has got another answer over ${kind} than before the change (before: ${before}; now: ${now:-nothing}). This site must not become the one for unknown names."
      return 1
    fi
  done
}
# Whether a file of the folder Let's Encrypt's questions are answered from
# arrives when it is asked for by the site's name on this machine. nginx takes
# a moment to change over after a reload.
answers_questions() {
  local folder="${WEBROOT}/.well-known/acme-challenge" token got=""
  token="xiero-check-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  mkdir -p "${folder}"
  chmod 755 "${WEBROOT}" "${WEBROOT}/.well-known" "${folder}" 2> /dev/null || true
  printf '%s\n' "${token}" > "${folder}/${token}"
  chmod 644 "${folder}/${token}"
  for _ in $(seq 1 20); do
    got="$(curl -s --max-time 10 --resolve "$(at_this_machine "${HTTP_PORT}")" "$(url_of http "/.well-known/acme-challenge/${token}")" 2> /dev/null | head -c 200 | tr -d '\r\n' || true)"
    if [ "${got}" = "${token}" ]; then break; fi
    sleep 0.5
  done
  rm -f "${folder}/${token}"
  [ "${got}" = "${token}" ]
}

if [ "${OURS}" = true ]; then
  BEFORE="${WORK}/before.conf"
  cp "${FILE}" "${BEFORE}"
  ORIG_FILE="${FILE}"
  ORIG_LINK="${LINK}"
fi
PHASE="changing"

if [ "${CERT_GOOD}" != true ]; then
  if [ "${OURS}" != true ]; then
    step "Adding the site to nginx, for Let's Encrypt's questions only"
    write_site first
    apply "the new file" || die "the site was not added."
    say "nginx has the site: ${FILE}"
  fi
  step "Asking Let's Encrypt for a certificate"
  if ! answers_questions; then
    die "a request for $(url_of http /.well-known/acme-challenge/)... on this machine does not arrive at the new site, so Let's Encrypt would not get its answer either. Another site of this nginx takes the requests for that name first, or nginx did not take the new configuration (its error log says why)."
  fi
  others_untouched || die "the site was not set up."
  options=(certonly --webroot -w "${WEBROOT}" -d "${DOMAIN}" --cert-name "${DOMAIN}" --non-interactive --keep-until-expiring --deploy-hook "${HOOK}")
  if [ "${LE_DIR}" != "/etc/letsencrypt" ]; then options+=(--config-dir "${LE_DIR}" --work-dir "${LE_DIR}/work" --logs-dir "${LE_DIR}/logs"); fi
  if [ "${HAS_ACCOUNT}" != true ]; then
    options+=(--agree-tos)
    if [ -n "${EMAIL}" ]; then options+=(--email "${EMAIL}"); else options+=(--register-unsafely-without-email); fi
  fi
  if ! "${CERTBOT}" "${options[@]}" > "${WORK}/certbot.txt" 2>&1; then
    say "certbot did not get a certificate. It said:"
    tail -n 25 "${WORK}/certbot.txt" | sed 's/^/  /'
    die "no certificate, so the site was not set up."
  fi
  cert_is_good || die "certbot ended well, but there is no certificate for ${DOMAIN} in ${LE_DIR}/live/${DOMAIN} that runs for 30 days or more. The site was not set up."
  say "The certificate is there. It runs until $(cert_until)."
fi

step "Passing the site on to the app"
write_site final
apply "the site" || die "the site was not set up."
# The request a browser makes, with the certificate checked against the
# authorities this machine knows.
SITE_SAYS=""
for _ in $(seq 1 20); do
  SITE_SAYS="$(status_of "$(url_of https /api/health)" --resolve "$(at_this_machine "${HTTPS_PORT}")")"
  [ "${SITE_SAYS}" = "200" ] && break
  sleep 0.5
done
if [ "${SITE_SAYS}" != "200" ]; then
  die "$(url_of https /api/health), asked on this machine, did not give 200 but: ${SITE_SAYS}. The site was not set up."
fi
others_untouched || die "the site was not set up."
PHASE="done"

step "$(url_of https "") answers"
# The certificate that was accepted is the one nginx shows. That it is the
# one in the file is looked at too: nginx 1.27.4 and newer keep what they
# have when a file was overwritten in place and still carries the same time.
SHOWN="$(name_gets https "${DOMAIN}")"
if [ -n "${SHOWN}" ] && [ "${SHOWN}" = "$(openssl x509 -noout -fingerprint -sha256 -in "${CERT}" 2> /dev/null || true)" ]; then
  say "The app's /api/health gives 200 there, and the certificate is accepted: it is for ${DOMAIN} and runs until $(cert_until)."
else
  say "The app's /api/health gives 200 there, and the certificate nginx shows is accepted."
  warn "that certificate is not the one in ${CERT}: nginx kept the one it had, as nginx 1.27.4 and newer do when a file was overwritten in place and still carries the time it had. To have nginx take the one in the file, which runs until $(cert_until):  touch ${CERT} ${KEY} && ${NGINX} -s reload"
fi
PLAIN="$(status_of "$(url_of http /)" --resolve "$(at_this_machine "${HTTP_PORT}")")"
if [ "${PLAIN}" = "301" ]; then say "$(url_of http "") sends everyone on to https."; else warn "$(url_of http /) gives ${PLAIN} instead of sending on to https."; fi
if [ ! -f "${RENEWAL_CONF}" ]; then
  warn "certbot has no renewal settings for this certificate (${RENEWAL_CONF}), so it is not renewed by certbot. It runs until $(cert_until)."
elif ! answers_questions; then
  warn "the site does not answer Let's Encrypt's questions any more now that it is passed on to the app, so renewing the certificate would fail. It runs until $(cert_until)."
elif [ -z "${RENEWAL}" ]; then
  warn "nothing on this machine renews certificates by itself. Have \"certbot renew\" run every day, or the site warns again after $(cert_until)."
elif ! reloads_after_renewal; then
  warn "${RENEWAL} renews the certificate, but certbot did not note that nginx is to be reloaded afterwards. To tell it:  certbot reconfigure --cert-name ${DOMAIN} --deploy-hook \"${HOOK}\""
else
  say "Renewal: ${RENEWAL} renews it, and certbot has noted to reload nginx when it was."
fi
say ""
say "The file: ${FILE}"
say "To take the site out again:  sudo bash nginx-site.sh --site ${DOMAIN} --remove"
