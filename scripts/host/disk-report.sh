#!/usr/bin/env bash
# A report of what fills the disk of a machine that runs Pterodactyl Wings:
#
#   sudo bash disk-report.sh              # print the report
#   sudo bash disk-report.sh > report.txt # or keep it in a file
#
# It only looks. It deletes nothing, changes nothing, writes no file and
# stops no service: every command in it reads. What to clean up is for a
# person to decide, with the report in hand.
#
# Servers appear by the first 8 characters of their ID (the short ID in the
# panel address), never by name. No password, key, token or address is printed.
#
# Measuring a large disk takes a few minutes. Anything that takes more than
# ten minutes is skipped and marked.
#
#   REPORT_ROOT=/mnt/disk   look at the folders of another disk instead of /
#   TOP=30                  longer lists (default 15)
set -uo pipefail

WINGS_CONFIG="${WINGS_CONFIG:-/etc/pterodactyl/config.yml}"
ROOT="${REPORT_ROOT:-/}"
TOP="${TOP:-15}"
LIMIT="${LIMIT:-600}"

if [ "$(id -u)" != "0" ]; then
  echo "note: not running as root; folders that only root may read are missing from the numbers." >&2
fi

have() { command -v "$1" > /dev/null 2>&1; }
section() { printf '\n== %s ==\n' "$*"; }
note() { printf '   %s\n' "$*"; }
progress() { printf '%s\n' "$*" >&2; }

# Run a command that only reads, gently, and give up after LIMIT seconds.
gently() {
  local runner=()
  if have timeout; then runner+=(timeout "${LIMIT}"); fi
  if have ionice; then runner+=(ionice -c 3); fi
  if have nice; then runner+=(nice -n 19); fi
  "${runner[@]}" "$@" 2> /dev/null
}

human() { # kilobytes
  awk -v kb="${1:-0}" 'BEGIN {
    if (kb >= 1048576) printf "%.1f GB", kb / 1048576
    else if (kb >= 1024) printf "%.0f MB", kb / 1024
    else printf "%d KB", kb
  }'
}
size_kb() { # the size of a folder or file in kilobytes; empty when it took too long
  [ -e "$1" ] || { echo 0; return; }
  gently du -sxk "$1" | awk '{ print $1 }'
}
show_size() { # LABEL PATH
  [ -e "$2" ] || return 0
  local kb
  kb="$(size_kb "$2")"
  if [ -n "${kb}" ]; then printf '   %-56s %10s\n' "$1" "$(human "${kb}")"; else printf '   %-56s %10s\n' "$1" "(took too long)"; fi
}
# Said under a list whose measuring was stopped: what is there is right, but
# the largest entry may be the one that was not reached.
cut_short() { # the exit code of a command run with gently
  if [ "$1" = "124" ]; then note "(stopped after ${LIMIT} seconds: this list is not complete)"; fi
}
# The largest entries directly inside a folder.
largest_in() { # FOLDER COUNT
  [ -d "$1" ] || return 0
  local listing code=0
  listing="$(gently du -xk --max-depth=1 "$1")" || code=$?
  printf '%s\n' "${listing}" | sort -rn | awk -v top="$2" -v self="$1" '
    NF < 2 || $2 == self { next }
    shown < top {
      kb = $1; $1 = ""; sub(/^ /, "")
      if (kb >= 1048576) size = sprintf("%.1f GB", kb / 1048576); else if (kb >= 1024) size = sprintf("%.0f MB", kb / 1024); else size = kb " KB"
      printf "   %10s  %s\n", size, $0
      shown++
    }'
  cut_short "${code}"
}
# Keep the lines whose first field, the kilobytes a file takes on the disk, is
# at least so many megabytes. A file's length says little: /var/log/lastlog is
# gigabytes long on many machines and takes a few kilobytes.
on_disk() { awk -F '\t' -v mb="$1" '$1 + 0 >= mb * 1024'; }
short() { printf '%s' "${1:0:8}"; }
is_uuid() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

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

echo "Disk report, $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "Read-only: nothing on this machine was changed to make it."
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  note "System: $(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}"), kernel $(uname -r)"
fi

# ── Disks ────────────────────────────────────────────────────────────────────

section "Disks"
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2> /dev/null | sed 's/^/   /'
full_inodes="$(df -iP -x tmpfs -x devtmpfs -x squashfs -x overlay 2> /dev/null | awk 'NR > 1 && $5 + 0 >= 70 { print "   " $6 ": " $5 " of the file slots (inodes) are used" }')"
if [ -n "${full_inodes}" ]; then
  echo "${full_inodes}"
else
  note "File slots (inodes): none of the disks is above 70%."
fi

# ── The big picture ──────────────────────────────────────────────────────────

progress "Measuring the folders of ${ROOT} (this is the slow part)..."
section "Largest folders in ${ROOT}"
largest_in "${ROOT}" 12

section "Largest folders in ${ROOT%/}/var/lib"
largest_in "${ROOT%/}/var/lib" 10

# ── Pterodactyl ──────────────────────────────────────────────────────────────

VOLUMES="$(yaml_get "${WINGS_CONFIG}" system.data)"
BACKUPS="$(yaml_get "${WINGS_CONFIG}" system.backup_directory)"
ARCHIVES="$(yaml_get "${WINGS_CONFIG}" system.archive_directory)"
WINGS_TMP="$(yaml_get "${WINGS_CONFIG}" system.tmp_directory)"
WINGS_LOGS="$(yaml_get "${WINGS_CONFIG}" system.log_directory)"
VOLUMES="${VOLUMES:-/var/lib/pterodactyl/volumes}"
BACKUPS="${BACKUPS:-/var/lib/pterodactyl/backups}"
ARCHIVES="${ARCHIVES:-/var/lib/pterodactyl/archives}"
WINGS_TMP="${WINGS_TMP:-/tmp/pterodactyl}"
WINGS_LOGS="${WINGS_LOGS:-/var/log/pterodactyl}"

# The servers Wings has, to tell leftovers of deleted servers apart. Asked from
# Wings on this machine with the node's own token, which is not printed.
known=""
known_from=""
if [ -r "${WINGS_CONFIG}" ] && have curl; then
  # The configuration holds the token itself, or "file:///path/to/it", or the
  # name of a variable of the Wings service (which cannot be read from here);
  # WINGS_TOKEN in the environment goes first, as for Wings.
  token="${WINGS_TOKEN:-}"
  [ -n "${token}" ] || token="$(yaml_get "${WINGS_CONFIG}" token)"
  case "${token}" in
    *'$'*) token="" ;;
    file://*) token="$(cat "${token#file://}" 2> /dev/null || true)" ;;
  esac
  token="${token%$'\r'}"
  host="$(yaml_get "${WINGS_CONFIG}" api.host)"
  port="$(yaml_get "${WINGS_CONFIG}" api.port)"
  case "${host}" in "" | 0.0.0.0 | "::" | "[::]") host="127.0.0.1" ;; esac
  case "${host}" in *:*) [ "${host#[}" != "${host}" ] || host="[${host}]" ;; esac
  scheme="http"
  insecure=()
  if [ "$(yaml_get "${WINGS_CONFIG}" api.ssl.enabled)" = "true" ]; then
    scheme="https"
    insecure=(-k)
  fi
  if [ -n "${token}" ]; then
    answer="$(curl -sS --max-time 30 ${insecure[@]+"${insecure[@]}"} -H 'Accept: application/json' -K - "${scheme}://${host}:${port:-8080}/api/servers" 2> /dev/null << EOF
header = "Authorization: Bearer ${token}"
EOF
    )" || answer=""
    known="$(printf '%s' "${answer}" | grep -o '"configuration":{"uuid":"[0-9a-f-]\{36\}"' | cut -d '"' -f 6 | sort -u)"
    [ -n "${known}" ] && known_from="wings"
  fi
  unset token answer
fi
is_known() { printf '%s\n' "${known}" | grep -qx "$1"; }

if [ -d "${VOLUMES}" ] || [ -d "${BACKUPS}" ]; then
  progress "Measuring the Pterodactyl servers..."
  section "Pterodactyl"
  show_size "Server files (${VOLUMES})" "${VOLUMES}"
  show_size "Backups (${BACKUPS})" "${BACKUPS}"
  show_size "Archives of transfers (${ARCHIVES})" "${ARCHIVES}"
  show_size "Temporary files of Wings (${WINGS_TMP})" "${WINGS_TMP}"
  show_size "Logs of Wings (${WINGS_LOGS})" "${WINGS_LOGS}"
  show_size "Logs of the panel" /var/www/pterodactyl/storage/logs
  if [ "${known_from}" = "wings" ]; then
    note "Wings has $(printf '%s\n' "${known}" | grep -c .) servers."
  else
    note "Wings could not be asked which servers exist, so leftovers of deleted servers cannot be told apart below."
  fi

  if [ -d "${VOLUMES}" ]; then
    section "Pterodactyl: the largest servers (short ID, size)"
    code=0
    listing="$(gently du -xk --max-depth=1 "${VOLUMES}")" || code=$?
    printf '%s\n' "${listing}" | sort -rn | awk -v self="${VOLUMES}" 'NF >= 2 && $2 != self' | head -n "${TOP}" | while read -r kb path; do
      name="$(basename "${path}")"
      mark=""
      if [ "${known_from}" = "wings" ] && is_uuid "${name}" && ! is_known "${name}"; then mark="   <- Wings has no such server"; fi
      if is_uuid "${name}"; then name="$(short "${name}")"; fi
      printf '   %10s  %s%s\n' "$(human "${kb}")" "${name}" "${mark}"
    done
    cut_short "${code}"
    unset listing

    if [ "${known_from}" = "wings" ]; then
      section "Pterodactyl: folders of servers that Wings does not have"
      leftovers=0
      for folder in "${VOLUMES}"/*/; do
        [ -d "${folder}" ] || continue
        name="$(basename "${folder}")"
        if is_uuid "${name}" && is_known "${name}"; then continue; fi
        leftovers=$((leftovers + 1))
        if [ "${leftovers}" -le 40 ]; then
          shown="${name}"
          if is_uuid "${name}"; then shown="$(short "${name}")"; fi
          printf '   %10s  %s  last changed %s\n' "$(human "$(size_kb "${folder}")")" "${shown}" "$(date -r "${folder}" '+%Y-%m-%d' 2> /dev/null || echo '?')"
        fi
      done
      if [ "${leftovers}" -eq 0 ]; then note "None."; else note "${leftovers} in total. Check each in the panel before anything is removed: a server that is being installed or transferred can look like this too."; fi
    fi
  fi

  if [ -d "${BACKUPS}" ]; then
    section "Pterodactyl: backups kept on this machine"
    count="$(find "${BACKUPS}" -maxdepth 1 -type f 2> /dev/null | wc -l)"
    note "${count} files."
    if [ "${count}" -gt 0 ]; then
      find "${BACKUPS}" -maxdepth 1 -type f -printf '%k\t%TY-%Tm-%Td\t%f\n' 2> /dev/null | sort -rn | head -n "${TOP}" | while IFS=$'\t' read -r kb day file; do
        printf '   %10s  %s  %s...\n' "$(human "${kb}")" "${day}" "$(short "${file}")"
      done
      old="$(find "${BACKUPS}" -maxdepth 1 -type f -mtime +30 -printf '%k\n' 2> /dev/null | awk '{ s += $1; n++ } END { printf "%d %d", n, s }')"
      note "Older than 30 days: ${old%% *} files, $(human "${old##* }"). A backup belongs to a server in the panel; removing it there keeps the panel's list right."
    fi
  fi
fi

# ── Docker ───────────────────────────────────────────────────────────────────

DOCKER_ROOT="/var/lib/docker"
if have docker && docker info > /dev/null 2>&1; then
  progress "Asking Docker..."
  DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || true)"
  DOCKER_ROOT="${DOCKER_ROOT:-/var/lib/docker}"
  section "Docker"
  gently docker system df | sed 's/^/   /'
  note "\"Reclaimable\" is what Docker itself counts as unused."
  dangling="$(docker images -f dangling=true -q 2> /dev/null | wc -l)"
  note "Images without a name (left over from updates): ${dangling}"

  section "Docker: the largest images"
  in_use="$(docker ps -a --format '{{.Image}}' 2> /dev/null | sort -u)"
  docker images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}\t{{.ID}}' 2> /dev/null | awk -F '\t' -v used="${in_use}" '
    BEGIN { n = split(used, list, "\n"); for (i = 1; i <= n; i++) if (list[i] != "") busy[list[i]] = 1 }
    {
      size = $1; unit = size; sub(/^[0-9.]+/, "", unit); sub(/[A-Za-z]+$/, "", size)
      kb = size + 0
      if (unit == "GB") kb *= 1048576; else if (unit == "MB") kb *= 1024; else if (unit == "B") kb /= 1024
      mark = ""
      if (!($2 in busy) && !($3 in busy)) mark = "   <- no container uses it"
      printf "%d\t%s\t%s%s\n", kb, $1, $2, mark
    }' | sort -rn | head -n "${TOP}" | while IFS=$'\t' read -r _ size name; do
    printf '   %10s  %s\n' "${size}" "${name}"
  done
  note "An image that no container uses is downloaded again when a server that needs it is installed or started."

  section "Docker: containers that are not running"
  stopped_servers=0
  others=""
  while IFS=$'\t' read -r name image status; do
    [ -n "${name}" ] || continue
    if is_uuid "${name}"; then stopped_servers=$((stopped_servers + 1)); else others="${others}   ${name}  (${image}; ${status})"$'\n'; fi
  done < <(docker ps -a --filter status=exited --filter status=created --filter status=dead --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2> /dev/null)
  note "Stopped Pterodactyl servers: ${stopped_servers} (Wings makes these again when a server starts; they hold no server data)."
  if [ -n "${others}" ]; then
    note "Others:"
    printf '%s' "${others}" | head -n 20
  else
    note "Others: none."
  fi

  section "Docker: volumes"
  total_volumes="$(docker volume ls -q 2> /dev/null | wc -l)"
  unused_volumes="$(docker volume ls -q -f dangling=true 2> /dev/null | wc -l)"
  note "${total_volumes} volumes, ${unused_volumes} not attached to any container."
  if [ "${unused_volumes}" -gt 0 ]; then
    note "CAREFUL: a volume that is not attached can still hold a database (of a panel or site whose container is stopped). Never prune volumes without looking at each."
    docker volume ls -q -f dangling=true 2> /dev/null | head -n 15 | while read -r volume; do
      if [[ "${volume}" =~ ^[0-9a-f]{64}$ ]]; then printf '   %s... (no name)\n' "${volume:0:12}"; else printf '   %s\n' "${volume}"; fi
    done
  fi

  section "Docker: large container logs (50 MB and more)"
  logs="$(find "${DOCKER_ROOT}/containers" -maxdepth 2 -name '*-json.log' -size +50M -printf '%k\t%h\n' 2> /dev/null | on_disk 50 | sort -rn | head -n 10)"
  if [ -z "${logs}" ]; then
    note "None."
  else
    while IFS=$'\t' read -r kb folder; do
      name="$(docker inspect --format '{{.Name}}' "$(basename "${folder}")" 2> /dev/null | sed 's|^/||')"
      if is_uuid "${name}"; then name="server $(short "${name}")"; fi
      printf '   %10s  %s\n' "$(human "${kb}")" "${name:-unknown container}"
    done <<< "${logs}"
  fi
else
  section "Docker"
  note "Docker is not installed, or cannot be asked."
fi

# ── Logs ─────────────────────────────────────────────────────────────────────

section "Logs"
show_size "/var/log" /var/log
if have journalctl; then
  journal="$(journalctl --disk-usage 2> /dev/null | head -n 1)"
  if [ -n "${journal}" ]; then note "${journal}"; fi
fi
big_logs="$(find /var/log -xdev -type f -size +20M -printf '%k\t%p\n' 2> /dev/null | on_disk 20 | sort -rn | head -n 10)"
if [ -z "${big_logs}" ]; then
  note "Files of 20 MB and more in /var/log: none."
else
  note "Files of 20 MB and more in /var/log:"
  while IFS=$'\t' read -r kb path; do
    printf '   %10s  %s\n' "$(human "${kb}")" "${path}"
  done <<< "${big_logs}"
fi

# ── Packages ─────────────────────────────────────────────────────────────────

section "Packages"
show_size "Downloaded packages (/var/cache/apt/archives)" /var/cache/apt/archives
show_size "Package lists (/var/lib/apt/lists)" /var/lib/apt/lists
show_size "Downloaded packages (/var/cache/dnf)" /var/cache/dnf
show_size "Downloaded packages (/var/cache/yum)" /var/cache/yum
if have apt-get; then
  # -s only simulates: nothing is removed.
  unneeded="$(apt-get -s autoremove 2> /dev/null | grep -c '^Remv ')"
  note "Packages nothing needs any more (apt-get autoremove would remove them): ${unneeded}"
fi
if have dpkg; then
  kernels="$(dpkg -l 'linux-image-[0-9]*' 2> /dev/null | awk '/^ii/ { print $2 }')"
  if [ -n "${kernels}" ]; then
    note "Installed kernels: $(printf '%s\n' "${kernels}" | grep -c .) (running: $(uname -r))"
  fi
fi
if have snap; then
  disabled="$(snap list --all 2> /dev/null | awk '/disabled/' | wc -l)"
  note "Old snap revisions kept: ${disabled}"
  show_size "Snap data (/var/lib/snapd)" /var/lib/snapd
fi

# ── Temporary files ──────────────────────────────────────────────────────────

section "Temporary files"
show_size "/tmp" /tmp
show_size "/var/tmp" /var/tmp
for folder in /tmp /var/tmp; do
  old="$(find "${folder}" -xdev -type f -mtime +7 -printf '%k\n' 2> /dev/null | awk '{ s += $1; n++ } END { printf "%d %d", n, s }')"
  note "${folder}: ${old%% *} files older than 7 days, $(human "${old##* }")"
done
show_size "Crash reports (/var/crash)" /var/crash
show_size "Core dumps (/var/lib/systemd/coredump)" /var/lib/systemd/coredump

# ── Home folders ─────────────────────────────────────────────────────────────

section "Largest folders in /root and /home"
largest_in /root 10
if [ -d /home ]; then largest_in /home 10; fi

# ── Databases ────────────────────────────────────────────────────────────────

if [ -d /var/lib/mysql ]; then
  section "MySQL / MariaDB"
  show_size "/var/lib/mysql" /var/lib/mysql
  binlogs="$(find /var/lib/mysql -maxdepth 1 -type f -regextype posix-extended -regex '.*/[^/]*bin\.[0-9]+' -printf '%k\n' 2> /dev/null | awk '{ s += $1; n++ } END { printf "%d %d", n, s }')"
  note "Binary logs: ${binlogs%% *} files, $(human "${binlogs##* }")"
fi

# ── Large single files ───────────────────────────────────────────────────────

progress "Looking for large files..."
section "Files of 500 MB and more (outside server files and Docker)"
code=0
large="$(gently find "${ROOT}" -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path "${DOCKER_ROOT}" -o -path "${VOLUMES}" -o -path "${BACKUPS}" \) -prune -o -type f -size +500M -printf '%k\t%TY-%Tm-%Td\t%p\n')" || code=$?
large="$(printf '%s\n' "${large}" | on_disk 500 | sort -rn | head -n 25)"
if [ -z "${large}" ]; then
  note "None."
else
  while IFS=$'\t' read -r kb day path; do
    printf '   %10s  %s  %s\n' "$(human "${kb}")" "${day}" "${path}"
  done <<< "${large}"
fi
cut_short "${code}"

# ── Space held by deleted files ──────────────────────────────────────────────

section "Deleted files that a running program still holds open"
if have lsof; then
  held="$(gently lsof -nP +L1 | awk 'NR > 1 && $7 ~ /^[0-9]+$/ && $7 >= 52428800 { printf "%d\t%s\n", $7 / 1024, $1 }' | sort -rn | head -n 8)"
  if [ -z "${held}" ]; then
    note "None of 50 MB or more."
  else
    note "Their space comes back when the program is restarted:"
    while IFS=$'\t' read -r kb program; do
      printf '   %10s  %s\n' "$(human "${kb}")" "${program}"
    done <<< "${held}"
  fi
else
  note "Not checked (lsof is not installed)."
fi

# ── Memory ───────────────────────────────────────────────────────────────────

section "Memory and swap"
if have free; then free -h | sed 's/^/   /'; fi
if [ -r /proc/swaps ]; then
  awk 'NR > 1 { printf "   swap: %s, %.1f GB\n", $1, $3 / 1048576 }' /proc/swaps
fi

echo
echo "End of the report. Nothing was changed."
