#!/usr/bin/env bash
# What the Deploy workflow (.github/workflows/deploy.yml) runs: one action of
# over-ssh.sh on the node, with care for what ends up in the log.
#
# The log of a workflow in a public repository can be read by anyone. So:
#
#   - What was typed when the run was started (the server, the site's address,
#     the host key) is read from the event's file and hidden in the log; it is
#     never written into a command of the workflow.
#   - What the node says is not printed, unless the repository is private or
#     the run was started with "show_output". It is kept on the node
#     (~/xiero-nexus-remote/logs) and in a file on the runner.
#   - With an "output_key", that output is sealed for the holder of the key
#     (sealed-output.sh) and stored as an object of the repository that no
#     branch contains. A notice on the run's page names it; `sealed-output.sh
#     read <key.pem> <run id>` fetches and opens it.
#
# The secrets come in as DEPLOY_HOST, DEPLOY_PORT, DEPLOY_USER,
# DEPLOY_PASSWORD, DEPLOY_SSH_KEY, and as SECRET_SERVER, SECRET_APP_URL and
# SECRET_HOST_KEY for what a run may also be given by hand.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
EVENT="${GITHUB_EVENT_PATH:?this runs inside a workflow (GITHUB_EVENT_PATH is not set)}"
command -v jq > /dev/null 2>&1 || {
  echo "::error::jq is not installed on this runner."
  exit 1
}

input() { jq -r --arg name "$1" '(.inputs // {})[$name] // "" | tostring' "${EVENT}" | tr -d '\r'; }
hide() { # values that must not be readable in the log from here on
  local value
  for value in "$@"; do
    if [ "${#value}" -ge 6 ]; then printf '::add-mask::%s\n' "${value}"; fi
  done
}
notice() { printf '::notice title=%s::%s\n' "$1" "$2"; }
problem() { printf '::error title=%s::%s\n' "$1" "$2"; }
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "${GITHUB_STEP_SUMMARY}"; fi; }

ACTION="$(input action)"
case "${ACTION}" in
  check | plan | upgrade | install-plan | install | disk-report | site-plan | site | workforce-plan | workforce | browser-plan | browser | last-log | input-key) ;;
  *)
    problem "Deploy" "\"${ACTION}\" is not an action. There are: check, plan, upgrade, install-plan, install, disk-report, site-plan, site, workforce-plan, workforce, browser-plan, browser, last-log, input-key."
    exit 1
    ;;
esac

SERVER="$(input server)"
APP_URL="$(input app_url)"
HOST_KEY="$(input host_key)"
VERSION="$(input version)"
OPTIONS="$(input options)"
OUTPUT_KEY="$(input output_key)"
[ -n "${SERVER}" ] || SERVER="${SECRET_SERVER:-}"
[ -n "${APP_URL}" ] || APP_URL="${SECRET_APP_URL:-}"
[ -n "${HOST_KEY}" ] || HOST_KEY="${SECRET_HOST_KEY:-}"
SERVER="$(printf '%s' "${SERVER}" | tr -d ' \r\n')"
APP_URL="$(printf '%s' "${APP_URL}" | tr -d ' \r\n')"
APP_URL="${APP_URL%/}"

# Typed values are not secrets to GitHub, so they are hidden here: the server
# by its whole ID and by its short one, the site by its address and its name.
site="${APP_URL#*://}"
hide "${SERVER}" "${SERVER:0:8}" "${APP_URL}" "${site%%[:/]*}"
while read -r _ key_part _; do hide "${key_part:-}"; done <<< "$(printf '%s\n' "${HOST_KEY}" | awk 'NF >= 3 { print $1, $3; next } { print $1, $2 }')"

SHOW="no"
if [ "$(input show_output)" = "true" ] || [ "$(jq -r '.repository.private // false' "${EVENT}")" = "true" ]; then SHOW="yes"; fi

missing=0
if [ -z "$(printf '%s' "${DEPLOY_HOST:-}" | tr -d ' \r\n')" ]; then
  problem "Deploy" "The secret VPS_HOST is not set: the host name or address of the node."
  missing=1
fi
if [ -z "${DEPLOY_PASSWORD:-}" ] && [ -z "${DEPLOY_SSH_KEY:-}" ]; then
  problem "Deploy" "Neither the secret VPS_PASSWORD nor VPS_SSH_KEY is set: there is nothing to sign in with."
  missing=1
fi
if [ "${missing}" = "1" ]; then
  echo "Secrets are set under Settings, Secrets and variables, Actions. A secret that was just added is there for the next run."
  exit 1
fi

# More options for the host script: words separated by spaces.
EXTRA=()
if [ -n "${OPTIONS}" ]; then read -r -a EXTRA <<< "${OPTIONS}"; fi

OUT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/node-output.txt"
export DEPLOY_SERVER="${SERVER}" DEPLOY_APP_URL="${APP_URL}" DEPLOY_VERSION="${VERSION}" DEPLOY_HOST_KEY="${HOST_KEY}"
export DEPLOY_OUTPUT="${OUT}"

code=0
if [ "${#EXTRA[@]}" -gt 0 ]; then
  bash "${here}/over-ssh.sh" "${ACTION}" -- "${EXTRA[@]}" || code=$?
else
  bash "${here}/over-ssh.sh" "${ACTION}" || code=$?
fi

lines=0
if [ -f "${OUT}" ]; then lines="$(wc -l < "${OUT}" | tr -d ' ')"; fi

if [ "${lines}" -gt 0 ]; then
  if [ "${SHOW}" = "yes" ]; then
    echo "::group::What the node said"
    cat "${OUT}"
    echo "::endgroup::"
  else
    echo "What the node said (${lines} lines) is not printed: anyone can read the log of a public repository."
    echo "It is on the node, in ~/xiero-nexus-remote/logs of the user this signed in as."
  fi
  if [ -n "${OUTPUT_KEY}" ]; then
    sealed="${OUT}.sealed"
    blob=""
    if bash "${here}/sealed-output.sh" seal "${OUTPUT_KEY}" < "${OUT}" > "${sealed}"; then
      blob="$(jq -Rs '{content: ., encoding: "utf-8"}' "${sealed}" | gh api "repos/${GITHUB_REPOSITORY}/git/blobs" --input - --jq .sha 2> /dev/null || true)"
    fi
    if [[ "${blob}" =~ ^[0-9a-f]{40,64}$ ]]; then
      # One character at a time: the log hides whatever looks like a secret
      # of the repository, and a short one (a port number) can be part of
      # this name by chance. The reader takes the dots out again.
      notice "Sealed output" "$(printf '%s' "${blob}" | sed 's/./&./g; s/\.$//')"
      echo "The output was sealed for the holder of the output key: scripts/host/sealed-output.sh read <key.pem> ${GITHUB_RUN_ID:-<run id>}"
    else
      printf '::warning title=Sealed output::%s\n' "The output could not be sealed and stored. It is still on the node."
    fi
  elif [ "${SHOW}" != "yes" ]; then
    echo "To read it from here: start the run with an output_key (scripts/host/sealed-output.sh keygen), or with show_output."
  fi
fi

# After an upgrade, an installation, or giving the site its address: does the
# site answer from the outside? This machine is a visitor like any other: it
# takes the name from DNS and accepts the certificates a browser accepts.
site_says=""
if { [ "${ACTION}" = "upgrade" ] || [ "${ACTION}" = "install" ] || [ "${ACTION}" = "site" ]; } && [ "${code}" = "0" ] && [ -n "${APP_URL}" ]; then
  why=0
  for _ in 1 2 3 4 5 6; do
    why=0
    site_says="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${APP_URL}/api/health" 2> /dev/null)" || why=$?
    [ "${site_says}" = "200" ] && break
    sleep "${DEPLOY_SITE_PAUSE:-5}"
  done
  if [ "${site_says}" = "200" ]; then
    case "${APP_URL}" in
      https://*) notice "The site" "answers at /api/health from the outside, with a certificate that is accepted." ;;
      *) notice "The site" "answers at /api/health from the outside." ;;
    esac
  else
    # What curl could not do, in words that do not name the site.
    case "${why}" in
      0) reason="" ;;
      6) reason=": its name is not known to DNS" ;;
      7) reason=": nothing took the connection" ;;
      28) reason=": no answer in time" ;;
      35) reason=": no secure connection could be made" ;;
      51 | 60) reason=": its certificate is not accepted (it is for another name, or not from an authority browsers know)" ;;
      *) reason=": curl ended with code ${why}" ;;
    esac
    printf '::warning title=The site::%s\n' "\"${ACTION}\" ended well on the node, but /api/health did not answer 200 from the outside (it said ${site_says:-nothing}${reason}). Look at the site and at what stands in front of it."
  fi
fi

case "${code}" in
  0) meaning="ended well" ;;
  90) meaning="was not started: a setting is wrong (see the log)" ;;
  91) meaning="was not started: the node could not be reached or did not let this in (see the log)" ;;
  92) meaning="lost its connection while it ran. It goes on on the node; run \"last-log\" to see how it ended" ;;
  93) meaning="was not started: the user on the node is not root and has no sudo without a password" ;;
  *) meaning="ended with code ${code} on the node" ;;
esac
summary "### ${ACTION}: ${meaning}"
summary ""
summary "The node's output: ${lines} lines$([ "${SHOW}" = "yes" ] && echo ", in the log" || echo ", not in the log")."
if [ "${code}" = "0" ]; then notice "${ACTION}" "${meaning}"; else problem "${ACTION}" "${meaning}"; fi
exit "${code}"
