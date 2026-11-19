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
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
NAME="xiero-browser-test"
PORT="${BROWSER_TEST_PORT:-9223}"

command -v docker > /dev/null 2>&1 || { echo "error: this needs docker."; exit 1; }
docker info > /dev/null 2>&1 || { echo "error: the Docker daemon does not answer."; exit 1; }

cleanup() { docker rm -f "${NAME}" > /dev/null 2>&1 || true; }
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

fail() {
  echo "error: $*"
  echo "--- what the container said:"
  docker logs --tail 40 "${NAME}" 2>&1 || true
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

echo "==> The end-to-end checks of the browser, against the container"
cd "${root}"
ONLY=browser E2E_BROWSER_URL="http://127.0.0.1:${PORT}/?token=${token}" node scripts/e2e/run.mjs || fail "the checks failed against the container."
echo "The browser service in its container passed."
