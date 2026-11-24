#!/usr/bin/env bash
# The runner in its container, with a real Docker: runner-service.sh is run
# on a made-up server and a network made for the test. It builds the image,
# starts the container as on a node, and asks its questions of the real
# thing: who a program runs as, that a container next to it is not reached
# and the outside is, and that a Paper plugin builds with Gradle (test/runner.sh
# asks them of stand-ins). After that the runner is asked more, the way the
# app asks: what a program left behind comes back and a link does not, a
# program whose time is up is stopped with everything it started, and a
# project written for Gradle 9 is built with Gradle 9.
#
#   bash scripts/host/test/runner-container.sh
#
# It needs Docker and the outside: Debian's packages, Gradle, Maven Central
# and the package server of Paper. The first build of the image takes
# several minutes.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
NODE_NAME="xiero-runner-test-node"
NODE_NET="xiero-runner-test-nw"
NODE_SUBNET="${RUNNER_TEST_SUBNET:-10.213.78.0/24}"
WORK=""

command -v docker > /dev/null 2>&1 || { echo "error: this needs docker."; exit 1; }
docker info > /dev/null 2>&1 || { echo "error: the Docker daemon does not answer."; exit 1; }

cleanup() {
  docker rm -f "${NODE_NAME}" "${NODE_NAME}-probe" > /dev/null 2>&1 || true
  docker volume rm "${NODE_NAME}-work" > /dev/null 2>&1 || true
  docker network rm "${NODE_NET}" > /dev/null 2>&1 || true
  if [ -n "${WORK}" ]; then rm -rf "${WORK}"; fi
}
trap cleanup EXIT
cleanup

fail() {
  echo "error: $*"
  echo "--- what the container said:"
  docker logs --tail 40 "${NODE_NAME}" 2>&1 || true
  # On GitHub, also on the run's page, with the last lines of the container.
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    said="$(docker logs --tail 12 "${NODE_NAME}" 2>&1 | tr '\n' '|' | cut -c1-900 || true)"
    echo "::error title=The runner in its container::$* What the container said: ${said}"
  fi
  exit 1
}

# What was found, also on the run's page on GitHub: the log of a run is long.
FOUND=()
found() {
  echo "$*"
  FOUND+=("$*")
}

echo "==> runner-service.sh, on a made-up server with this Docker"
# The script that sets the runner up on a node, for real: only the server
# next to it is made up, and left alone (--container-only).
WORK="$(mktemp -d)"
uuid="0a11ce00-1111-4222-8333-444455556666"
mkdir -p "${WORK}/volumes/${uuid}/xiero-nexus-ai"
printf 'version=0.0.0\ncommit=test\nnode=22\n' > "${WORK}/volumes/${uuid}/xiero-nexus-ai/VERSION"
printf 'token: none\nsystem:\n  data: %s\ndocker:\n  network:\n    name: %s\n' "${WORK}/volumes" "${NODE_NET}" > "${WORK}/wings.yml"
docker network create --subnet "${NODE_SUBNET}" "${NODE_NET}" > /dev/null || fail "a network for the test could not be made (${NODE_SUBNET}; RUNNER_TEST_SUBNET names another)."
on_node() { bash "${root}/scripts/host/runner-service.sh" --server "${uuid}" --wings-config "${WORK}/wings.yml" --state-dir "${WORK}/state" --name "${NODE_NAME}" --container-only --yes "$@" > "${WORK}/said.txt" 2>&1; }
if ! on_node; then
  cat "${WORK}/said.txt"
  fail "runner-service.sh did not set the runner up: $(tail -n 4 "${WORK}/said.txt" | tr '\n' ' ' | cut -c1-900)"
fi
cat "${WORK}/said.txt"
address="${NODE_SUBNET%.*}.246"
for wanted in \
  "Built xiero-runner" \
  "  JDKs: " \
  "The container ${NODE_NAME} runs at ${address}:8080 on ${NODE_NET}." \
  "The runner is running in it, and starts every program as a user of its own." \
  "Without the token it runs nothing." \
  "With the token it runs a program: as 20000:20000, which cannot read the runner's own memory or its token, and cannot write outside its folder." \
  "Its programs do not reach a container next to it (" \
  "Nor this machine itself." \
  "They reach the outside: " \
  "A build works in it: a Paper plugin was built with Gradle in " \
  "The runner runs. The lines for the server's .env are in ${WORK}/state/${uuid}/runner-env"; do
  grep -qF -- "${wanted}" "${WORK}/said.txt" || fail "runner-service.sh did not say \"${wanted}\"."
done
grep -qF "which another container does reach" "${WORK}/said.txt" || fail "the container that only listened was not reached by another one either, so nothing was shown."
grep -qF "repo.maven.apache.org" "${WORK}/said.txt" || fail "the runner's programs do not reach Maven Central."
if grep -q "^warning: a small Maven project could not be built" "${WORK}/said.txt"; then fail "a Maven project does not build in the runner."; fi
token="$(sed -n 's/^SANDBOX_TOKEN=//p' "${WORK}/state/${uuid}/runner-env")"
url="$(sed -n 's/^SANDBOX_URL=//p' "${WORK}/state/${uuid}/runner-env")"
[ "${url}" = "http://${address}:8080" ] || fail "the lines for the server's .env do not name the runner's address."
[ "${#token}" -eq 48 ] || fail "the lines for the server's .env hold no token."
if grep -qF -- "${token}" "${WORK}/said.txt"; then fail "runner-service.sh printed the token."; fi
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{.HostConfig.Privileged}}' "${NODE_NAME}")" = "true 3221225472 ${NODE_NET} 0 false" ] \
  || fail "the container was not started with the limits of a node: $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{.HostConfig.Privileged}}' "${NODE_NAME}")"
while IFS= read -r line; do FOUND+=("${line}"); done <<< "$(grep -E '^  (JDKs: |warm: )|^Built |A build works in it|And with Maven|They reach the outside|Its programs do not reach' "${WORK}/said.txt" | sed 's/^  //')"
echo "runner-service.sh set it up, asked the real runner, and said what it found."

echo "==> The runner itself"
# The server in the container: without the right that set the rules of the network.
bounding="$(docker exec "${NODE_NAME}" sh -c 'for dir in /proc/[0-9]*; do if tr "\0" " " < "${dir}/cmdline" 2> /dev/null | grep -q "^node /srv/server.mjs"; then sed -n "s/^CapBnd:[[:space:]]*//p" "${dir}/status"; fi; done' | head -n 1)"
[ -n "${bounding}" ] || fail "the server was not found among the processes of the container."
# CAP_NET_ADMIN is bit 12, CAP_SYS_ADMIN bit 21.
if [ $((0x${bounding} & 0x1000)) -ne 0 ] || [ $((0x${bounding} & 0x200000)) -ne 0 ]; then fail "the server in the container still has the right to administer the network (CapBnd ${bounding})."; fi
echo "The server runs without the right that closed the network (CapBnd ${bounding})."

# Asked the way the app asks: over the network, with the token.
ask() { # the request as JSON; the answer goes to ${WORK}/answer.json
  curl -sS --max-time 900 -X POST "${url}/run" -H "authorization: Bearer ${token}" -H 'content-type: application/json' --data-binary @- > "${WORK}/answer.json"
}
field() { node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim()); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), a); console.log(typeof v === "string" ? v : JSON.stringify(v));' "${WORK}/answer.json" "$1"; }
leftovers() { docker top "${NODE_NAME}" -eo uid,args 2> /dev/null | awk '$1 == 20000' | wc -l | tr -d ' '; }

[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${url}/run" -H 'content-type: application/json' -d '{"files":[],"command":"node -v"}')" = "401" ] || fail "the runner took a request over the network without the token."
echo "Over the network, without the token, it runs nothing."

# What a program leaves behind comes back when it fits a pattern that was
# asked for; a link that points out of the folder does not, nor does what a
# program says is a package and is a link to a file of the system.
cat << 'EOF' | ask
{"stream": true, "timeoutMs": 30000, "keep": ["build/libs/*.jar", "dist/*.zip"],
 "files": [{"path": "make.js", "content": "const fs = require('fs'); fs.mkdirSync('build/libs', { recursive: true }); fs.mkdirSync('dist'); fs.writeFileSync('build/libs/thing-1.0.jar', Buffer.concat([Buffer.from('PK'), Buffer.alloc(300, 7)])); fs.symlinkSync('/etc/passwd', 'build/libs/passwd.jar'); fs.symlinkSync('/proc/1/environ', 'dist/environ.zip'); fs.writeFileSync('notes.txt', 'not asked for'); console.log('made by', process.getuid());"}],
 "command": "node make.js"}
EOF
[ "$(field exitCode)" = "0" ] || fail "a program that writes files did not run: $(cut -c1-400 "${WORK}/answer.json")"
[ "$(field stdout)" = "made by 20000" ] || fail "the program did not run as the user of its own: $(field stdout)"
[ "$(node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim()); console.log(a.kept.map((k) => k.path + ":" + Buffer.from(k.base64, "base64").length).join(","));' "${WORK}/answer.json")" = "build/libs/thing-1.0.jar:302" ] \
  || fail "what came back is not the one package the program made: $(node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim()); console.log(JSON.stringify(a.kept.map((k) => k.path)));' "${WORK}/answer.json")"
if grep -q "root:" "${WORK}/answer.json"; then fail "a link to a file of the system came back with its content."; fi
echo "What a program made comes back; a link it made to a file of the system does not."

# One run right after another: what was started to tidy up after the first
# stops nothing of the second, which runs as the same user.
for _ in 1 2 3; do
  printf '%s' '{"timeoutMs": 20000, "files": [{"path": "quick.js", "content": "console.log(1)"}], "command": "node quick.js"}' | ask
  printf '%s' '{"timeoutMs": 20000, "files": [{"path": "slow.js", "content": "setTimeout(() => console.log(\"through\"), 700)"}], "command": "node slow.js"}' | ask
  [ "$(field exitCode)" = "0" ] && [ "$(field stdout)" = "through" ] || fail "a program that ran right after another one was stopped: $(cut -c1-400 "${WORK}/answer.json")"
done
echo "A run right after another one runs to its end."

# A program whose time is up is stopped, with everything it started.
cat << 'EOF' | ask
{"timeoutMs": 3000,
 "files": [{"path": "stay.js", "content": "const { spawn } = require('child_process'); for (let i = 0; i < 3; i++) spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref(); console.log('started'); setInterval(() => {}, 1000);"}],
 "command": "node stay.js"}
EOF
[ "$(field timedOut)" = "true" ] && [ "$(field exitCode)" = "null" ] || fail "a program whose time was up was not stopped: $(cut -c1-400 "${WORK}/answer.json")"
sleep 1
[ "$(leftovers)" = "0" ] || fail "what a stopped program had started is still running: $(docker top "${NODE_NAME}" -eo uid,args | awk '$1 == 20000' | head -n 5 | tr '\n' '|')"
echo "A program whose time is up is stopped, and nothing it started is left."

# So is what a program that ended left running.
cat << 'EOF' | ask
{"timeoutMs": 20000,
 "files": [{"path": "leave.js", "content": "const { spawn } = require('child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref(); console.log('left one behind');"}],
 "command": "node leave.js"}
EOF
[ "$(field exitCode)" = "0" ] || fail "a program that leaves another one running did not end well: $(cut -c1-400 "${WORK}/answer.json")"
sleep 1
[ "$(leftovers)" = "0" ] || fail "what a program left running is still there after it ended."
echo "What a program left running ends with it."

# From inside a program: private addresses and this machine are refused, the outside is not.
cat << 'EOF' | ask
{"timeoutMs": 60000,
 "files": [{"path": "reach.js", "content": "const net = require('net'); const tryOne = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 5000 }, () => { s.destroy(); done('open'); }); s.on('timeout', () => { s.destroy(); done('closed'); }); s.on('error', () => done('closed')); }); (async () => { const out = {}; for (const [name, host, port] of [['metadata', '169.254.169.254', 80], ['private', '10.0.0.1', 80], ['docker', '172.17.0.1', 22], ['gateway', process.env.GATEWAY_FOR_TEST || '10.213.78.1', 22], ['central', 'repo.maven.apache.org', 443]]) out[name] = await tryOne(host, port); console.log(JSON.stringify(out)); })();"}],
 "command": "node reach.js"}
EOF
[ "$(field stdout)" = '{"metadata":"closed","private":"closed","docker":"closed","gateway":"closed","central":"open"}' ] || fail "what a program reaches is not what it should be: $(field stdout)"
echo "A program reaches Maven Central, and no private address."

# A project that says it was written for Gradle 9 is built with Gradle 9.
answer="$(docker exec -e SELFTEST_GRADLE=9 "${NODE_NAME}" node /srv/selftest.mjs gradle 2> /dev/null || echo "no the question could not be asked")"
case "${answer}" in ok\ *"Gradle 9)") found "With Gradle 9 too: ${answer#ok }." ;; *) fail "a Paper plugin did not build with Gradle 9 (${answer#no })." ;; esac
cat << 'EOF' | ask
{"timeoutMs": 300000,
 "files": [{"path": "settings.gradle.kts", "content": "rootProject.name = \"which\"\n"}, {"path": "gradle/wrapper/gradle-wrapper.properties", "content": "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip\n"}],
 "command": "gradle --version"}
EOF
field stdout | grep -q "Gradle 9\." || fail "\"gradle\" in a project written for Gradle 9 is not Gradle 9: $(field stdout | head -n 4 | tr '\n' ' ')"
cat << 'EOF' | ask
{"timeoutMs": 300000, "files": [{"path": "settings.gradle.kts", "content": "rootProject.name = \"which\"\n"}], "command": "gradle --version"}
EOF
field stdout | grep -q "Gradle 8\." || fail "\"gradle\" in a project that names no version is not Gradle 8: $(field stdout | head -n 4 | tr '\n' ' ')"
echo "\"gradle\" is Gradle 8, and Gradle 9 for a project that names it."

# What else is in it, for the log of this test.
cat << 'EOF' | ask
{"timeoutMs": 60000, "files": [], "command": "java -version"}
EOF
found "Java: $(field stderr | head -n 1)"
cat << 'EOF' | ask
{"timeoutMs": 60000, "files": [], "command": "mvn -v"}
EOF
found "Maven: $(field stdout | head -n 1)"
cat << 'EOF' | ask
{"timeoutMs": 60000, "files": [], "command": "node -v"}
EOF
found "Node.js: $(field stdout)"
cat << 'EOF' | ask
{"timeoutMs": 60000, "files": [], "command": "python3 --version"}
EOF
found "Python: $(field stdout)"

echo "==> Taking it away"
if ! on_node --remove; then
  cat "${WORK}/said.txt"
  fail "runner-service.sh --remove did not take the runner away."
fi
if docker inspect "${NODE_NAME}" > /dev/null 2>&1; then fail "runner-service.sh --remove left the container."; fi
if docker volume inspect "${NODE_NAME}-work" > /dev/null 2>&1; then fail "runner-service.sh --remove left the folder of the runs."; fi
echo "And took it away again."
echo "The runner in its container passed."
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::notice title=The runner in its container::$(printf '%s | ' "${FOUND[@]}" | tr -d '\r\n' | cut -c1-3500)"
fi
