#!/usr/bin/env bash
# The workforce of the app on this Pterodactyl node, from a file: the models
# it works with, its agents, its teams and its workflows. This finds where the
# app of a server answers on this machine and where its .env is; workforce.py,
# next to this script, does the rest: it signs in as the administrator of the
# first start, says what the app has, and adds what the file asks for.
#
#   sudo bash workforce.sh --server <server id> --dry-run
#   sudo bash workforce.sh --server <server id> --yes --test
#
# Nothing on the node is changed, only the app's own data, through the app:
# every change is in its audit log, under the administrator's name.
#
#   --server <id>        The server: its UUID or the first 8 characters.
#                        Without it: the one server that has the app.
#   --url <address>      Where the app answers on this machine, instead of
#                        finding it out from the server, such as
#                        http://127.0.0.1:25565.
#   --env-file <file>    The app's .env, instead of the one in the server's files.
#   --volumes <dir>      Where Wings keeps server files (default: from the Wings
#                        configuration, else /var/lib/pterodactyl/volumes).
#   --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
#
# Everything else goes to workforce.py as it is (see its --help):
#
#   --file <file>        What the workforce should be (default: workforce.json
#                        next to this script).
#   --user <name>        The administrator to sign in as.
#   --dry-run            Say what would be done, and do nothing.
#   --yes                Do not ask before doing it.
#   --update             Also change what is there under the same name but differs.
#   --only <parts>       accounts, providers, models, skills, agents, teams,
#                        workflows (separated by commas).
#   --account <name>     An account the app is to have, with --account-email
#                        <address> and --account-role owner|admin|user. Its
#                        password comes in NEXUS_ACCOUNT_PASSWORD, or sealed:
#   --account-password-sealed <text>
#                        The password of that account, sealed for this node
#                        (see below), so that it can be given where others
#                        can read.
#   --upload-skill <f>   A skill of your own, uploaded as on the Skills page: a
#                        SKILL.md, or a .skill or .zip. May be given again.
#   --skill-sealed <text>
#                        The same, with the file itself sealed for this node.
#   --skill-url <addr>   The same, for a file at an https address, which is
#                        fetched from this node: a SKILL.md, a .skill or a
#                        .zip, also one that holds several packed skills. The
#                        address of a file's page at MediaFire is followed to
#                        the file. May be given again.
#   --skill-url-sealed <text>
#                        The same, with the address sealed for this node: an
#                        address is all it takes to have the file.
#   --test               Afterwards, ask each chat model of the file for one word.
#   --test-all           The same, for every chat model that is in the app.
#   --only-usable        Afterwards, switch off the models that cannot be used:
#                        billed ones of a provider without a key, and chat
#                        models the provider refuses one word.
#   --test-media         Afterwards, one picture and one spoken sentence from the
#                        image and speech models of the file, joined, then deleted.
#   --try-run            Afterwards, a small project on the models of the file,
#                        and a task for each agent where the file asks for it;
#                        deleted again when it has ended.
#   --inventory-only     Say what the app has, and stop.
#
# The password is read from the app's .env by workforce.py, or taken from
# NEXUS_PASSWORD when that is set; it is not printed and is on no command
# line. Needs python3 (3.8 or newer) on the node.
#
# Sealed for this node: a password or a skill that has to pass through a place
# others can read (the inputs of a workflow in a public repository) is sealed
# with the node's public key, and only this node opens it. The key is made by
# the action "input-key" of over-ssh.sh, which prints its public half; seal
# with `sealed-output.sh seal-line <that line> < file`. This script opens it
# with the private half, named by XIERO_INPUT_KEY.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
SERVER=""
URL=""
ENV_FILE=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
PASS_ON=()
SEALED_PASSWORD=""
SEALED_SKILLS=()
SEALED_URLS=()

die() {
  printf 'error: %s\n' "$*" >&2
  exit 2
}
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) need_value "$@"; SERVER="$2"; shift 2 ;;
    --url) need_value "$@"; URL="${2%/}"; shift 2 ;;
    --env-file) need_value "$@"; ENV_FILE="$2"; shift 2 ;;
    --volumes) need_value "$@"; VOLUMES="$2"; shift 2 ;;
    --wings-config) need_value "$@"; WINGS_CONFIG="$2"; shift 2 ;;
    --file | --user | --only | --account | --account-email | --account-role | --upload-skill | --skill-url) need_value "$@"; PASS_ON+=("$1" "$2"); shift 2 ;;
    --skill-url-sealed) need_value "$@"; SEALED_URLS+=("$2"); shift 2 ;;
    --account-password-sealed) need_value "$@"; SEALED_PASSWORD="$2"; shift 2 ;;
    --skill-sealed) need_value "$@"; SEALED_SKILLS+=("$2"); shift 2 ;;
    --dry-run | --yes | --update | --test | --test-all | --only-usable | --test-media | --keep-test-media | --try-run | --keep-try-run | --inventory-only) PASS_ON+=("$1"); shift ;;
    -h | --help)
      sed -n '2,74p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option \"$1\". See --help." ;;
  esac
done

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
is_bundle() { [ -f "$1/VERSION" ] && [ ! -L "$1/VERSION" ] && [ -f "$1/start.js" ] && [ -f "$1/server.js" ] && grep -q '^version=' "$1/VERSION"; }

PYTHON="${PYTHON:-python3}"
command -v "${PYTHON}" > /dev/null 2>&1 || die "this needs python3, which is not installed here (on Debian and Ubuntu: apt install python3)."
"${PYTHON}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2> /dev/null \
  || die "this needs Python 3.8 or newer; here is $("${PYTHON}" -V 2>&1)."
[ -f "${here}/workforce.py" ] || die "workforce.py is not next to this script."
[ -z "${URL}" ] || [[ "${URL}" =~ ^https?://[^[:space:]]+$ ]] || die "--url is an address such as http://127.0.0.1:25565."

# ── The server: its files, and where its app answers ────────────────────────

UUID=""
APP_DIR=""
if [ -z "${URL}" ] || [ -z "${ENV_FILE}" ]; then
  if [ -z "${VOLUMES}" ]; then
    VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data || true)"
    [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
  fi
  [ -d "${VOLUMES}" ] || die "${VOLUMES} does not exist, so no server's files are here. Name the app with --url and --env-file."
  if [ -z "${SERVER}" ]; then
    with_app=()
    for folder in "${VOLUMES}"/*/; do
      folder="${folder%/}"
      if is_bundle "${folder}/xiero-nexus-ai" || is_bundle "${folder}"; then with_app+=("${folder##*/}"); fi
    done
    [ "${#with_app[@]}" -eq 1 ] || die "${#with_app[@]} servers in ${VOLUMES} have the app. Name one with --server."
    SERVER="${with_app[0]}"
  fi
  [[ "${SERVER}" =~ ^[0-9a-fA-F-]{8,36}$ ]] || die "\"${SERVER}\" is not a server ID. Use the UUID of the server, or its first 8 characters."
  SERVER="$(printf '%s' "${SERVER}" | tr 'A-F' 'a-f')"
  matches=()
  for folder in "${VOLUMES}/${SERVER}"*/; do
    [ -d "${folder}" ] && matches+=("$(basename "${folder%/}")")
  done
  case "${#matches[@]}" in
    0) die "there is no server \"${SERVER}\" in ${VOLUMES}." ;;
    1) UUID="${matches[0]}" ;;
    *) die "\"${SERVER}\" fits more than one server. Use the whole UUID." ;;
  esac
  if is_bundle "${VOLUMES}/${UUID}/xiero-nexus-ai"; then
    APP_DIR="${VOLUMES}/${UUID}/xiero-nexus-ai"
  elif is_bundle "${VOLUMES}/${UUID}"; then
    APP_DIR="${VOLUMES}/${UUID}"
  else
    die "server ${UUID} has no Xiero Nexus AI bundle in its files. Install it first (pterodactyl-install.sh)."
  fi
fi

if [ -z "${ENV_FILE}" ]; then
  ENV_FILE="${APP_DIR}/.env"
  # Without NEXUS_PASSWORD, the administrator of the first start is in there.
  if [ -z "${NEXUS_PASSWORD:-}" ] && [ ! -f "${ENV_FILE}" ]; then
    die "${ENV_FILE} does not exist, and NEXUS_PASSWORD is not set: there is nothing to sign in with."
  fi
fi

if [ -z "${URL}" ]; then
  # The ports of this machine that Docker passes on to the server; Wings names
  # the container after the server. The app listens on the first port the
  # panel gave it (SERVER_PORT).
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
  [ -n "${chosen}" ] || die "where the app of server ${UUID} answers cannot be found out: the server is not running, or Docker does not answer. Start it, or name the address with --url http://127.0.0.1:<port>."
  address="${chosen%:*}"
  case "${address}" in "" | 0.0.0.0) address="127.0.0.1" ;; esac
  URL="http://${address}:${chosen##*:}"
fi

ARGS=(--url "${URL}")
[ ! -f "${ENV_FILE}" ] || ARGS+=(--env-file "${ENV_FILE}")

# ── What was sealed for this node ────────────────────────────────────────────

OPENED=""
tidy() { [ -z "${OPENED}" ] || rm -rf "${OPENED}"; }
trap tidy EXIT
if [ -n "${SEALED_PASSWORD}" ] || [ "${#SEALED_SKILLS[@]}" -gt 0 ] || [ "${#SEALED_URLS[@]}" -gt 0 ]; then
  key="${XIERO_INPUT_KEY:-}"
  [ -n "${key}" ] && [ -f "${key}" ] || die "something was sealed for this node, and the node has no key to open it with yet (XIERO_INPUT_KEY). Make one with the action \"input-key\", and seal for the key it prints."
  [ -f "${here}/sealed-output.sh" ] || die "sealed-output.sh is not next to this script."
  umask 077
  OPENED="$(mktemp -d)"
  if [ -n "${SEALED_PASSWORD}" ]; then
    NEXUS_ACCOUNT_PASSWORD="$(bash "${here}/sealed-output.sh" open-line "${key}" "${SEALED_PASSWORD}")" \
      || die "the sealed password does not open with the key of this node: it was sealed for another key, or it is damaged."
    [ -n "${NEXUS_ACCOUNT_PASSWORD}" ] || die "the sealed password is empty."
    export NEXUS_ACCOUNT_PASSWORD
  fi
  number=0
  for sealed in ${SEALED_SKILLS[@]+"${SEALED_SKILLS[@]}"}; do
    number=$((number + 1))
    mkdir "${OPENED}/${number}"
    # Markdown or an archive: the app tells them apart by what is in the file.
    bash "${here}/sealed-output.sh" open-line "${key}" "${sealed}" > "${OPENED}/${number}/SKILL.md" \
      || die "sealed skill ${number} does not open with the key of this node: it was sealed for another key, or it is damaged."
    PASS_ON+=(--upload-skill "${OPENED}/${number}/SKILL.md")
  done
  # Addresses go on in the environment, one a line: not on a command line, where the node's other users could read them.
  for sealed in ${SEALED_URLS[@]+"${SEALED_URLS[@]}"}; do
    address="$(bash "${here}/sealed-output.sh" open-line "${key}" "${sealed}")" \
      || die "a sealed address does not open with the key of this node: it was sealed for another key, or it is damaged."
    NEXUS_SKILL_URLS="${NEXUS_SKILL_URLS:-}${NEXUS_SKILL_URLS:+$'\n'}${address}"
  done
  [ -z "${NEXUS_SKILL_URLS:-}" ] || export NEXUS_SKILL_URLS
fi

"${PYTHON}" "${here}/workforce.py" "${ARGS[@]}" ${PASS_ON[@]+"${PASS_ON[@]}"}
code=$?
tidy
exit "${code}"
