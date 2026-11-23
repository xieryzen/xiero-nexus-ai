#!/usr/bin/env bash
# What the app on this machine knows about its models: the providers, each
# model with the result of its last check, the models every agent and every
# project is set to, and what the providers answered in the last runs.
#
#   sudo bash models-report.sh                    # the only server with the app
#   sudo bash models-report.sh --server 0a98f8fe  # that server
#   sudo bash models-report.sh --attempts 80      # more of the last attempts
#
# It only reads: the app's database is opened for reading, and nothing is
# asked of a provider. No key, password or token is printed (the keys of the
# providers are stored encrypted, and are not read here); what a provider
# answered is printed as the app kept it, cut to 240 characters.
#
#   --server <id>        The Pterodactyl server: its UUID or the first characters.
#   --volumes <dir>      Where Wings keeps server files (default: from the Wings
#                        configuration, else /var/lib/pterodactyl/volumes).
#   --wings-config <f>   The Wings configuration (default /etc/pterodactyl/config.yml).
#   --db <file>          The database itself, instead of looking for a server.
#   --attempts <n>       How many of the last attempts to list (default 40).
set -euo pipefail

SERVER=""
VOLUMES=""
WINGS_CONFIG="/etc/pterodactyl/config.yml"
DB=""
ATTEMPTS=40

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --volumes) VOLUMES="${2:-}"; shift 2 ;;
    --wings-config) WINGS_CONFIG="${2:-}"; shift 2 ;;
    --db) DB="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-}"; shift 2 ;;
    -h | --help)
      awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
      exit 0
      ;;
    # What the other host scripts take, and this one has no use for.
    --yes | --dry-run) shift ;;
    --site | --app-url | --version) shift 2 ;;
    *) die "\"$1\" is not an option of this script (--help lists them)." ;;
  esac
done
[[ "${ATTEMPTS}" =~ ^[0-9]{1,4}$ ]] || die "--attempts takes a number."
command -v python3 > /dev/null 2>&1 || die "this needs python3, which is not installed here."

if [ -z "${DB}" ]; then
  if [ -z "${VOLUMES}" ]; then
    if [ -r "${WINGS_CONFIG}" ]; then
      # system: / data: <dir>, as Wings writes it.
      VOLUMES="$(awk '/^system:/ { inside = 1; next } /^[^ ]/ { inside = 0 } inside && /^  data:/ { sub(/^  data:[ ]*/, ""); gsub(/["'"'"']/, ""); print; exit }' "${WINGS_CONFIG}" || true)"
    fi
    [ -n "${VOLUMES}" ] || VOLUMES="/var/lib/pterodactyl/volumes"
  fi
  [ -d "${VOLUMES}" ] || die "${VOLUMES} does not exist, so no server's files are here."
  found=()
  for file in "${VOLUMES}/${SERVER}"*/xiero-nexus-ai/data/nexus.db; do
    [ -f "${file}" ] && found+=("${file}")
  done
  if [ "${#found[@]}" -eq 0 ]; then
    die "no server${SERVER:+ whose ID starts with ${SERVER}} has the app's database in ${VOLUMES}."
  fi
  if [ "${#found[@]}" -gt 1 ]; then
    die "${#found[@]} servers have the app's database here: name one with --server."
  fi
  DB="${found[0]}"
fi
[ -f "${DB}" ] || die "${DB} is not there."

VERSION_FILE="$(dirname "$(dirname "${DB}")")/package.json"
VERSION=""
if [ -r "${VERSION_FILE}" ]; then
  VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${VERSION_FILE}" | head -n 1)"
fi

MODELS_DB="${DB}" MODELS_ATTEMPTS="${ATTEMPTS}" MODELS_VERSION="${VERSION}" python3 - << 'PY'
import datetime
import json
import os
import sqlite3
import sys

path = os.environ["MODELS_DB"]
attempts = int(os.environ.get("MODELS_ATTEMPTS") or 40)
try:
    db = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("select 1 from sqlite_master limit 1").fetchone()
except sqlite3.Error as error:
    print("error: the database could not be read: %s" % error, file=sys.stderr)
    sys.exit(1)

NOW = datetime.datetime.now(datetime.timezone.utc)


def columns(table):
    return {row["name"] for row in db.execute("pragma table_info(%s)" % table)}


def rows(table, wanted, tail=""):
    """The rows of a table, with the wanted columns that this version of the app has."""
    have = columns(table)
    if not have:
        return []
    cols = [c for c in wanted if c in have]
    return [dict(r) for r in db.execute("select %s from %s %s" % (", ".join(cols), table, tail))]


def when(value):
    """A stored time, which is seconds or milliseconds, as how long ago it was."""
    if value is None:
        return "never"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if number > 1e11:
        number /= 1000.0
    then = datetime.datetime.fromtimestamp(number, datetime.timezone.utc)
    minutes = int((NOW - then).total_seconds() // 60)
    if minutes < 0:
        ago = "in %d min" % -minutes
    elif minutes < 90:
        ago = "%d min ago" % minutes
    elif minutes < 72 * 60:
        ago = "%d h ago" % (minutes // 60)
    else:
        ago = "%d days ago" % (minutes // 1440)
    return "%s (%s UTC)" % (ago, then.strftime("%m-%d %H:%M"))


def short(text, limit=240):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def host_of(url):
    url = str(url or "")
    rest = url.split("://", 1)[-1]
    return rest.split("/", 1)[0]


def section(title):
    print("\n== %s ==" % title)


print("The models of the app")
print("  Database    %s" % path)
if os.environ.get("MODELS_VERSION"):
    print("  App         version %s" % os.environ["MODELS_VERSION"])
print("  Time        %s UTC" % NOW.strftime("%Y-%m-%d %H:%M"))

providers = rows("providers", ["id", "name", "adapter", "base_url", "auth_type", "timeout_ms", "status", "last_tested_at", "last_test_status", "last_test_error"], "order by name")
provider_by_id = {p["id"]: p for p in providers}
models = rows(
    "models",
    ["id", "provider_id", "model_id", "display_name", "enabled", "input_price_per_mtok", "output_price_per_mtok", "source", "last_tested_at", "last_test_status", "last_test_error", "check_failures", "for_users",
     "standing", "standing_at", "standing_error", "retry_at"],
    "order by model_id",
)
model_by_id = {m["id"]: m for m in models}
caps = {}
for c in rows("model_capabilities", ["model_row_id", "capability"]):
    caps.setdefault(c["model_row_id"], []).append(c["capability"])


def model_name(model_id):
    if not model_id:
        return "-"
    m = model_by_id.get(model_id)
    if not m:
        return "(a model that is gone)"
    p = provider_by_id.get(m["provider_id"], {})
    state = []
    if not m.get("enabled"):
        state.append("off")
    if m.get("last_test_status") == "error":
        state.append("failing")
    if m.get("standing") and m.get("standing") not in ("ok", None):
        state.append(str(m["standing"]))
    return "%s @ %s%s" % (m["model_id"], p.get("name", "?"), " [%s]" % ", ".join(state) if state else "")


section("Providers (%d)" % len(providers))
for p in providers:
    mine = [m for m in models if m["provider_id"] == p["id"]]
    print("  %s — %s, %s, auth %s, %s, waits %s s" % (p["name"], p.get("adapter"), host_of(p.get("base_url")), p.get("auth_type"), p.get("status"), int((p.get("timeout_ms") or 0) / 1000)))
    if p.get("last_test_status"):
        print("      its own test: %s, %s%s" % (p["last_test_status"], when(p.get("last_tested_at")), (" — " + short(p.get("last_test_error"))) if p.get("last_test_error") else ""))
    for m in mine:
        kinds = ",".join(sorted(caps.get(m["id"], []))) or "-"
        price = "free" if (m.get("input_price_per_mtok") == 0 and m.get("output_price_per_mtok") == 0) else ("no price" if m.get("input_price_per_mtok") is None and m.get("output_price_per_mtok") is None else "%s/%s" % (m.get("input_price_per_mtok"), m.get("output_price_per_mtok")))
        print("    %-3s %-52s %-7s checked %s%s" % (
            "on" if m.get("enabled") else "OFF",
            short(m["model_id"], 52),
            m.get("last_test_status") or "never",
            when(m.get("last_tested_at")),
            ", failures %s" % m.get("check_failures") if m.get("check_failures") else "",
        ))
        print("        %s; %s%s%s" % (kinds, price, "; for users" if m.get("for_users") else "", "; added by %s" % m["source"] if m.get("source") else ""))
        if m.get("standing"):
            print("        standing: %s since %s%s" % (m["standing"], when(m.get("standing_at")), (", asked again %s" % when(m.get("retry_at"))) if m.get("retry_at") else ""))
        if m.get("last_test_error"):
            print("        said: %s" % short(m["last_test_error"]))
        if m.get("standing_error") and m.get("standing_error") != m.get("last_test_error"):
            print("        said in use: %s" % short(m["standing_error"]))

listed = [m for m in models if m.get("enabled") and provider_by_id.get(m["provider_id"], {}).get("status") == "enabled"]
chat = [m for m in listed if not caps.get(m["id"]) or any(c not in ("image_generation", "video_generation", "speech_generation", "embeddings") for c in caps.get(m["id"], []))]
section("In short")
print("  Models      %d, of them switched on, on a provider that is switched on: %d" % (len(models), len(listed)))
print("  Chat models %d switched on: %d passed their last check, %d failed it, %d never checked" % (
    len(chat),
    len([m for m in chat if m.get("last_test_status") == "ok"]),
    len([m for m in chat if m.get("last_test_status") == "error"]),
    len([m for m in chat if not m.get("last_test_status")]),
))

agents = rows("agents", ["id", "name", "role", "primary_model_row_id", "fallback_model_row_id", "routing_mode", "status"], "order by name")
agent_by_id = {a["id"]: a for a in agents}
section("Agents (%d)" % len(agents))
for a in agents:
    print("  %-34s %s%s" % (short(a["name"], 34), "" if a.get("status") in (None, "active", "enabled") else "[%s] " % a.get("status"), "auto-routing; " if a.get("routing_mode") == "auto" else ""))
    print("      first:  %s" % model_name(a.get("primary_model_row_id")))
    print("      second: %s" % model_name(a.get("fallback_model_row_id")))

projects = rows("projects", ["id", "title", "status", "manager_model_row_id", "error", "updated_at", "created_at"], "order by created_at desc limit 12")
project_by_id = {p["id"]: p for p in projects}
section("Projects (the newest %d)" % len(projects))
for p in projects:
    print("  %-34s %-10s manager: %s" % (short(p["title"], 34), p.get("status"), model_name(p.get("manager_model_row_id"))))
    if p.get("error"):
        print("      %s" % short(p["error"]))

tasks = {t["id"]: t for t in rows("project_tasks", ["id", "project_id", "seq", "title", "status"])}
runs = rows("agent_runs", ["id", "project_id", "task_id", "agent_id", "model_row_id", "status", "attempt", "latency_ms", "error", "created_at"], "order by created_at desc, rowid desc limit %d" % attempts)
section("The last %d attempts of tasks (the newest first)" % len(runs))
titles = {p["id"]: p["title"] for p in rows("projects", ["id", "title"])}
for r in runs:
    t = tasks.get(r.get("task_id"), {})
    print("  %s  %s #%s %s — attempt %s, %s, %s, %s s" % (
        when(r.get("created_at")),
        short(titles.get(r.get("project_id"), "?"), 24),
        t.get("seq", "?"),
        short(t.get("title", ""), 30),
        r.get("attempt"),
        model_name(r.get("model_row_id")),
        r.get("status"),
        int((r.get("latency_ms") or 0) / 1000),
    ))
    if r.get("error"):
        print("        %s" % short(r["error"]))

usage = rows("usage_records", ["model_row_id", "kind", "status", "error_code", "created_at"], "order by created_at desc limit 4000")
section("What the models were asked for lately (of the last %d requests)" % len(usage))
tally = {}
for u in usage:
    key = u.get("model_row_id")
    entry = tally.setdefault(key, {"ok": 0, "error": 0, "codes": {}, "last": None})
    if u.get("status") == "ok":
        entry["ok"] += 1
    else:
        entry["error"] += 1
        code = u.get("error_code") or "error"
        entry["codes"][code] = entry["codes"].get(code, 0) + 1
    if entry["last"] is None:
        entry["last"] = u.get("created_at")
for key, entry in sorted(tally.items(), key=lambda item: -(item[1]["ok"] + item[1]["error"])):
    codes = ", ".join("%s×%s" % (n, c) for c, n in sorted(entry["codes"].items(), key=lambda item: -item[1]))
    print("  %-60s ok %-4d failed %-4d%s; last %s" % (short(model_name(key), 60), entry["ok"], entry["error"], " (%s)" % codes if codes else "", when(entry["last"])))

audits = rows("audit_logs", ["action", "metadata", "created_at"], "where action like 'model.health.%' order by created_at desc limit 30")
section("Models the check took away or gave back (the last %d times)" % len(audits))
for a in audits:
    try:
        meta = json.loads(a.get("metadata") or "{}")
    except ValueError:
        meta = {}
    print("  %s  %s  %s @ %s%s" % (when(a.get("created_at")), a["action"].replace("model.health.", ""), meta.get("model", "?"), meta.get("provider", "?"), (" — " + short(meta.get("error"), 160)) if meta.get("error") else ""))
PY
