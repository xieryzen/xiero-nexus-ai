#!/usr/bin/env bash
# Tests of disk-report.sh, on a made-up Wings host in a temporary folder: the
# folders Wings keeps, a stand-in for Wings (fake-wings.mjs) and a stand-in
# for docker, the way a host that needs tidying looks.
#
#   bash scripts/host/test/report.sh
#
# It checks what the report says, that it names no server and shows no
# secret, and above all that making it changed nothing: not a file of the
# host, and nothing but questions to Wings and to Docker. SHOW=1 prints the
# reports.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../disk-report.sh"

WINGS_PORT="${WINGS_PORT:-8190}"
WINGS="http://127.0.0.1:${WINGS_PORT}"
UUID="0a11ce00-1111-4222-8333-444455556666"  # a server that runs
OTHER="0b0b0b0b-1111-4222-8333-444455556666" # a server that is stopped
LEFT="dead0000-1111-4222-8333-444455556666"  # files of a server that was deleted
BACKUP_NEW="aaaa1111-1111-4222-8333-444455556666"
BACKUP_OLD="bbbb2222-1111-4222-8333-444455556666"
BACKUP_OLDER="cccc3333-1111-4222-8333-444455556666"
CONTAINER="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
TOKEN="node-token-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

WORK="$(mktemp -d)"
HOST="${WORK}/host"
OUT="${WORK}/report.txt"
ERR="${WORK}/progress.txt"
WINGS_PID=""
passed=0
failed=0
failures=()

cleanup() {
  if [ -n "${WINGS_PID}" ]; then kill "${WINGS_PID}" 2> /dev/null || true; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

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
line() { grep -qE -- "$1" "${OUT}"; } # a line of the report that matches
anywhere() { grep -qF -- "$1" "${OUT}" "${ERR}"; }
megabytes() { head -c "$(($1 * 1024 * 1024))" /dev/urandom > "$2"; }
# Every file and folder of the made-up host: its name, size, time and mode.
fingerprint() { find "${HOST}" -printf '%p %s %T@ %m %y\n' | sort | sha256sum; }

report() { # the environment of the script, then its options; returns its exit code
  local code=0
  env PATH="${here}:${PATH}" FAKE_WINGS_URL="${WINGS}" FAKE_DOCKER_ROOT="${HOST}/docker" FAKE_LOG_CONTAINER="${UUID}" \
    FAKE_STOPPED_SERVER="${OTHER}" FAKE_DOCKER_LOG="${WORK}/docker-calls.txt" \
    WINGS_CONFIG="${HOST}/config.yml" REPORT_ROOT="${HOST}/root" "$@" bash "${script}" > "${OUT}" 2> "${ERR}" < /dev/null || code=$?
  if [ -n "${SHOW:-}" ]; then sed 's/^/      | /' "${OUT}"; fi
  return "${code}"
}

# ── The made-up host ─────────────────────────────────────────────────────────

mkdir -p "${HOST}/volumes/${UUID}" "${HOST}/volumes/${OTHER}" "${HOST}/volumes/${LEFT}" "${HOST}/volumes/old-import" \
  "${HOST}/backups" "${HOST}/archives" "${HOST}/tmp" "${HOST}/logs" "${HOST}/docker/containers/${CONTAINER}" \
  "${HOST}/root/var/lib/something" "${HOST}/root/opt" "${HOST}/root/srv"
megabytes 4 "${HOST}/volumes/${UUID}/world.dat"
megabytes 2 "${HOST}/volumes/${OTHER}/world.dat"
megabytes 6 "${HOST}/volumes/${LEFT}/world.dat"
megabytes 1 "${HOST}/volumes/old-import/dump.sql"
megabytes 3 "${HOST}/backups/${BACKUP_NEW}.tar.gz"
megabytes 2 "${HOST}/backups/${BACKUP_OLD}.tar.gz"
megabytes 1 "${HOST}/backups/${BACKUP_OLDER}.tar.gz"
megabytes 51 "${HOST}/docker/containers/${CONTAINER}/${CONTAINER}-json.log"
megabytes 5 "${HOST}/root/var/lib/something/data.bin"
megabytes 2 "${HOST}/root/opt/tool.bin"
echo "a line" > "${HOST}/logs/wings.log"
# 600 MB long, and next to nothing on the disk: like /var/log/lastlog.
truncate -s 600M "${HOST}/root/srv/sparse.img"
touch -d '45 days ago' "${HOST}/backups/${BACKUP_OLD}.tar.gz"
touch -d '200 days ago' "${HOST}/backups/${BACKUP_OLDER}.tar.gz"
touch -d '100 days ago' "${HOST}/volumes/${LEFT}"
cat > "${HOST}/config.yml" << EOF
debug: false
uuid: 11111111-2222-4333-8444-555555555555
token_id: abcdefghijklmnop
token: ${TOKEN}
api:
  host: 0.0.0.0
  port: ${WINGS_PORT}
  ssl:
    enabled: false
system:
  root_directory: ${HOST}
  log_directory: ${HOST}/logs
  data: ${HOST}/volumes
  archive_directory: ${HOST}/archives
  backup_directory: ${HOST}/backups
  tmp_directory: ${HOST}/tmp
remote: https://panel.example.com
EOF

# Wings has the two servers; the other two folders are leftovers.
FAKE_WINGS_UNKNOWN="${LEFT},old-import" node "${here}/fake-wings.mjs" "${WINGS_PORT}" "${HOST}/volumes" "${TOKEN}" 3398 > "${WORK}/wings.log" 2>&1 &
WINGS_PID=$!
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "${WINGS}/__requests" 2> /dev/null; then break; fi
  sleep 0.5
done
curl -fsS -o /dev/null "${WINGS}/__requests" || { echo "the stand-in for Wings did not start" >&2; cat "${WORK}/wings.log" >&2; exit 1; }

echo "Disk report on a made-up host, as $(id -un)."

# ── The report ───────────────────────────────────────────────────────────────

begin "The report"
before="$(fingerprint)"
code=0
report || code=$?
after="$(fingerprint)"
if [ "${code}" = "0" ]; then ok "it ends well"; else
  bad "it ends well" "exit ${code}"
  sed 's/^/         | /' "${ERR}" | tail -n 20
fi
check "it starts by saying that it only reads" says "Read-only: nothing on this machine was changed to make it."
check "  and ends the same way" test "$(tail -n 1 "${OUT}")" = "End of the report. Nothing was changed."
check_not "the script itself ran into no error" grep -qE 'disk-report\.sh: line|command not found|unbound variable|syntax error' "${ERR}" "${OUT}"
check "progress goes to the terminal, not into the report" grep -qF "Measuring the Pterodactyl servers..." "${ERR}"
check_not "  so the report can be kept in a file without it" says "Measuring the Pterodactyl servers..."

begin "It changes nothing"
check "every file of the host is as it was: none changed, added or removed" test "${before}" = "${after}"
check "Wings was asked one thing: which servers it has" test "$(curl -fsS "${WINGS}/__requests")" = '["GET /api/servers"]'
check "Docker was asked questions" grep -qx 'system df' "${WORK}/docker-calls.txt"
check_not "  and nothing but questions" grep -qvE '^(info|info --format .*|system df|images .*|ps -a .*|volume ls .*|inspect --format .*)$' "${WORK}/docker-calls.txt"

begin "Pterodactyl"
check "the server files are measured" line "Server files \(${HOST}/volumes\) +1[34] MB"
check "  and the backups" line "Backups \(${HOST}/backups\) +6 MB"
check "it says how many servers Wings has" says "Wings has 2 servers."
check "the largest folder comes first, marked as one Wings does not have" test "$(grep -A 1 'the largest servers' "${OUT}" | tail -n 1 | tr -s ' ')" = " 6 MB dead0000 <- Wings has no such server"
check "a server Wings has is listed without a mark" line '^ +4 MB  0a11ce00$'
check "the leftovers are listed with their size and when they last changed" line "^ +6 MB  dead0000  last changed $(date -d '100 days ago' '+%Y-%m-%d')$"
check "  a folder that is not a server's too, by its name" line '^ +1 MB  old-import  last changed '
check "  with a warning to look in the panel first" says "2 in total. Check each in the panel before anything is removed"
check "the backups are counted" says "3 files."
check "  listed largest first, by the start of their name" test "$(grep -A 2 'backups kept on this machine' "${OUT}" | tail -n 1 | tr -s ' ')" = " 3 MB $(date '+%Y-%m-%d') aaaa1111..."
check "  and the old ones added up" says "Older than 30 days: 2 files, 3 MB."

begin "Docker"
check "what Docker counts as unused is shown" line 'Images +12 +4 +9\.1GB +6\.2GB \(68%\)'
check "images without a name are counted" says "Images without a name (left over from updates): 2"
check "the images are listed largest first" test "$(grep -A 5 'Docker: the largest images' "${OUT}" | tail -n 5 | awk '{ print $1 }' | tr '\n' ' ')" = "2.4GB 1.21GB 412MB 356MB 12.3kB "
check "  one that a container uses has no mark" line '^ +356MB  ghcr\.io/parkervcp/yolks:nodejs_22$'
check "  one that no container uses is marked" line '^ +1\.21GB  ghcr\.io/pterodactyl/yolks:java_17   <- no container uses it$'
check "stopped servers are counted, not named" says "Stopped Pterodactyl servers: 1 "
check "  other stopped containers are named" says "old-panel-db  (mariadb:10.5; Exited (137) 2 months ago)"
check "volumes that no container uses are listed" line '^ +panel_database$'
check "  one without a name by the start of its ID" says "0123456789ab... (no name)"
check "  with the warning never to prune them unseen" says "CAREFUL: a volume that is not attached can still hold a database"
check "a large container log is found, with the server it belongs to" line '^ +51 MB  server 0a11ce00$'

begin "The rest of the machine"
check "the folders of the disk are listed, largest first" test "$(grep -A 1 "Largest folders in ${HOST}/root ==" "${OUT}" | tail -n 1 | tr -s ' ')" = " 5 MB ${HOST}/root/var"
check_not "a file that is long but takes no room is not taken for a large file" says "sparse.img"
check "  so there is no large file" test "$(grep -A 1 'Files of 500 MB and more' "${OUT}" | tail -n 1)" = "   None."
for name in "Disks" "Logs" "Packages" "Temporary files" "Largest folders in /root and /home" "Deleted files that a running program still holds open" "Memory and swap"; do
  check "it has the part \"${name}\"" says "== ${name} =="
done

begin "What it does not show"
check_not "the name of a server" anywhere "Customer server"
check_not "the full ID of a server or a backup" grep -qF -e "${UUID}" -e "${OTHER}" -e "${LEFT}" -e "${BACKUP_NEW}" -e "${BACKUP_OLD}" -e "${BACKUP_OLDER}" -e "${CONTAINER}" "${OUT}" "${ERR}"
check_not "the node's token" anywhere "${TOKEN}"
check_not "the address of the panel" anywhere "panel.example.com"

# ── Wings cannot be asked ────────────────────────────────────────────────────

begin "Wings cannot be asked"
sed -i "s/^token: .*/token: not-the-token/" "${HOST}/config.yml"
code=0
report || code=$?
check "the report is made all the same" test "${code}" = "0"
check "it says that leftovers cannot be told apart" says "Wings could not be asked which servers exist"
check_not "  and marks no folder as a leftover" says "Wings has no such server"
check_not "  nor lists any" says "folders of servers that Wings does not have"
check "the servers are still measured" line '^ +6 MB  dead0000$'

begin "The token of the node, kept elsewhere"
printf '%s\n' "${TOKEN}" > "${WORK}/token-file"
sed -i "s|^token: .*|token: file://${WORK}/token-file|" "${HOST}/config.yml"
code=0
report || code=$?
check "in a file that the configuration names: Wings is asked with it" says "Wings has 2 servers."
# shellcheck disable=SC2016  # the configuration holds the name of a variable, as text
sed -i 's|^token: .*|token: ${WINGS_NODE_TOKEN}|' "${HOST}/config.yml"
code=0
report || code=$?
check "in a variable of the Wings service: the report is made without asking Wings" test "${code}$(grep -c 'Wings could not be asked' "${OUT}")" = "01"
code=0
report WINGS_TOKEN="${TOKEN}" || code=$?
check "  given in the environment, Wings is asked" says "Wings has 2 servers."
check_not "the token is not in the report" anywhere "${TOKEN}"
sed -i "s|^token: .*|token: ${TOKEN}|" "${HOST}/config.yml"

# ── A disk that is slow to measure ───────────────────────────────────────────

begin "Measuring that takes too long"
# A du that names one folder and then hangs, and one second of patience.
mkdir "${WORK}/slow"
cat > "${WORK}/slow/du" << 'EOF'
#!/usr/bin/env bash
# The size of one folder (-s) comes at the end, so there is none; a list has
# its first entry by then.
case "$1" in -s*) ;; *) printf '2048\t%s/reached\n' "${!#}" ;; esac
sleep 20
EOF
chmod +x "${WORK}/slow/du"
began="${SECONDS}"
code=0
report PATH="${WORK}/slow:${here}:${PATH}" LIMIT=1 || code=$?
check "the report is made all the same" test "${code}" = "0"
check "  without waiting for what hangs" test "$((SECONDS - began))" -lt 60
check "a list that was cut short shows what was reached" says "2 MB  ${HOST}/root/reached"
check "  and says that it is not complete" says "(stopped after 1 seconds: this list is not complete)"
check "a size that could not be measured says so" line "Server files \(${HOST}/volumes\) +\(took too long\)"
check "it still reaches the end" test "$(tail -n 1 "${OUT}")" = "End of the report. Nothing was changed."

printf '\n%s passed, %s failed (disk report)\n' "${passed}" "${failed}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  exit 1
fi
