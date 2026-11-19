#!/usr/bin/env bash
# The browser service in its container, with a real Docker: the image is
# built, started with the limits browser-service.sh gives it on a node, and
# then the end-to-end checks of the browser run against it (a real site to
# sign in to, a person who takes a page over, private addresses that are
# refused).
#
#   npm run build && bash scripts/host/test/browser-container.sh
#
# It needs Docker, and the app built (npm run build). The container shares
# the network of this machine for the test, so that its Chromium reaches the
# site the checks start here; on a node it is on the server's network, and
# nothing of it is published.
#
# In between, browser-service.sh itself is run with this Docker, on a
# made-up server and a network made for the test: it builds, starts the
# container as on a node, and asks its questions of a real Chromium behind
# the real gate (test/browser.sh asks them of stand-ins). That part opens
# https://example.com/, so it needs the outside.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
NAME="xiero-browser-test"
PORT="${BROWSER_TEST_PORT:-9223}"
# What browser-service.sh is given to work with: a container and a network of these names.
NODE_NAME="xiero-browser-test-node"
NODE_NET="xiero-browser-test-nw"
NODE_SUBNET="${BROWSER_TEST_SUBNET:-10.213.77.0/24}"
WORK=""

command -v docker > /dev/null 2>&1 || { echo "error: this needs docker."; exit 1; }
docker info > /dev/null 2>&1 || { echo "error: the Docker daemon does not answer."; exit 1; }

cleanup() {
  docker rm -f "${NAME}" "${NODE_NAME}" > /dev/null 2>&1 || true
  docker network rm "${NODE_NET}" > /dev/null 2>&1 || true
  if [ -n "${WORK}" ]; then rm -rf "${WORK}"; fi
}
trap cleanup EXIT
cleanup

echo "==> Building the image"
docker build -t xiero-browser "${root}/scripts/host/browser"
docker run --rm --entrypoint chromium xiero-browser --version

echo "==> Starting the container"
token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
envfile="$(mktemp)"
printf 'BROWSER_TOKEN=%s\n' "${token}" > "${envfile}"
docker run -d --name "${NAME}" --network host \
  --memory 1g --memory-swap 1g --cpus 1.5 --pids-limit 512 --shm-size 256m \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file "${envfile}" -e "PORT=${PORT}" -e ALLOW_PRIVATE_HOSTS=127.0.0.1,localhost \
  xiero-browser > /dev/null
rm -f "${envfile}"

LOGS_OF="${NAME}"
fail() {
  echo "error: $*"
  echo "--- what the container said:"
  docker logs --tail 40 "${LOGS_OF}" 2>&1 || true
  # On GitHub, also on the run's page, with the last lines of the container.
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    said="$(docker logs --tail 12 "${LOGS_OF}" 2>&1 | tr '\n' '|' | cut -c1-900 || true)"
    echo "::error title=The browser service in its container::$* What the container said: ${said}"
  fi
  exit 1
}
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1 || fail "Chromium did not come up in the container."
echo "Chromium is running in it."
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/json/version")" = "401" ] || fail "the service answered without the token."
echo "Without the token it lets nobody in."
curl -fsS "http://127.0.0.1:${PORT}/json/version?token=${token}" | grep -q '"egress":"filtered"' || fail "the service did not take its token."
echo "With the token it does."
[ "$(docker inspect -f '{{.State.Health.Status}}' "${NAME}" 2> /dev/null || true)" != "unhealthy" ] || fail "Docker says the container is unhealthy."
[ "$(docker exec "${NAME}" id -u)" = "10001" ] || fail "the service runs as root in its container."
if docker exec "${NAME}" sh -c 'touch /srv/x 2> /dev/null'; then fail "the container's file system can be written to."; fi
echo "It runs without the rights of root, on a file system it cannot write to."

echo "==> browser-service.sh, on a made-up server with this Docker"
# The script that sets the service up on a node, for real: only the server
# next to it is made up, and left alone (--container-only).
WORK="$(mktemp -d)"
uuid="0a11ce00-1111-4222-8333-444455556666"
mkdir -p "${WORK}/volumes/${uuid}/xiero-nexus-ai"
printf 'version=0.0.0\ncommit=test\nnode=22\n' > "${WORK}/volumes/${uuid}/xiero-nexus-ai/VERSION"
printf 'token: none\nsystem:\n  data: %s\ndocker:\n  network:\n    name: %s\n' "${WORK}/volumes" "${NODE_NET}" > "${WORK}/wings.yml"
docker network create --subnet "${NODE_SUBNET}" "${NODE_NET}" > /dev/null || fail "a network for the test could not be made (${NODE_SUBNET}; BROWSER_TEST_SUBNET names another)."
LOGS_OF="${NODE_NAME}"
on_node() { bash "${root}/scripts/host/browser-service.sh" --server "${uuid}" --wings-config "${WORK}/wings.yml" --state-dir "${WORK}/state" --name "${NODE_NAME}" --container-only --yes "$@" > "${WORK}/said.txt" 2>&1; }
if ! on_node; then
  cat "${WORK}/said.txt"
  fail "browser-service.sh did not set the service up: $(tail -n 4 "${WORK}/said.txt" | tr '\n' ' ' | cut -c1-700)"
fi
cat "${WORK}/said.txt"
address="${NODE_SUBNET%.*}.250"
for wanted in \
  "Built xiero-browser" \
  "The container ${NODE_NAME} runs at ${address}:9223 on ${NODE_NET}." \
  "Chromium is running in it." \
  "Without the token it lets nobody in." \
  "With the token it does, and it keeps pages from private networks: Chrom" \
  "It reaches the outside (" \
  "Its Chromium opens a page: https://example.com/ came up in " \
  "The browser service runs. The line for the server's .env is in ${WORK}/state/${uuid}/browser-url"; do
  grep -qF -- "${wanted}" "${WORK}/said.txt" || fail "browser-service.sh did not say \"${wanted}\"."
done
url="$(sed -n 's/^BROWSER_URL=//p' "${WORK}/state/${uuid}/browser-url")"
[ "${url%%\?*}" = "http://${address}:9223/" ] || fail "the line for the server's .env does not name the service's address."
if grep -qF -- "${url#*token=}" "${WORK}/said.txt"; then fail "browser-service.sh printed the token."; fi
curl -fsS "${url%%\?*}json/version?${url#*\?}" | grep -q '"egress":"filtered"' || fail "the service browser-service.sh started does not take the token of the line for .env."
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}}' "${NODE_NAME}")" = "true 1073741824 ${NODE_NET} 0" ] || fail "the container browser-service.sh started is not limited as it says: $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}}' "${NODE_NAME}")."
echo "browser-service.sh set it up, asked a real Chromium, and said what it found."
if ! on_node --remove; then
  cat "${WORK}/said.txt"
  fail "browser-service.sh --remove did not take the service away."
fi
if docker inspect "${NODE_NAME}" > /dev/null 2>&1; then fail "browser-service.sh --remove left the container."; fi
echo "And took it away again."
LOGS_OF="${NAME}"

echo "==> The end-to-end checks of the browser, against the container"
cd "${root}"
ONLY=browser E2E_BROWSER_URL="http://127.0.0.1:${PORT}/?token=${token}" node scripts/e2e/run.mjs || fail "the checks failed against the container."
echo "The browser service in its container passed."
