#!/usr/bin/env bash
# Tests of workforce.py and workforce.sh, and of workforce.json itself, against
# the app: the built app (npm run build) is started on a database of its own,
# with the mock providers of the end-to-end tests in place of the real ones,
# and the programs sign in to it the way they sign in on a node.
#
#   npm run build && bash scripts/host/test/workforce.sh
#
# The file that is checked is the committed workforce.json, with the addresses
# of its providers changed to the mock's and the names of its models to the
# ones the mock has: every provider, agent, team and workflow of it goes
# through the app's own checks, both workflows are run to the end in a project
# with the limits a new project has, and its "tryRun" is run. The mock's model
# "chat-busy" answers "too many requests" every other time, as a free tier
# does, and is the one that plans and sums up here: the app has to ask again.
#
# SHOW=1 prints what was said each time. APP_PORT, MOCK_PORT and CDN_PORT
# choose other ports. Needs node, python3, curl; joining clips is checked
# where there is an ffmpeg.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
host="${here}/.."
root="$(cd "${host}/../.." && pwd)"
APP_PORT="${APP_PORT:-3110}"
MOCK_PORT="${MOCK_PORT:-4020}"
CDN_PORT="${CDN_PORT:-4021}"
APP="http://127.0.0.1:${APP_PORT}"
MOCK="http://127.0.0.1:${MOCK_PORT}"
PASS="correct-horse-battery-staple"
UUID="0a11ce00-1111-4222-8333-444455556666"

annotate() { # error|notice TEXT
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    local text="${2//'%'/%25}"
    text="${text//$'\n'/%0A}"
    echo "::$1 title=The workforce from a file::${text}"
  fi
}
for tool in node python3 curl; do
  command -v "${tool}" > /dev/null 2>&1 || { echo "error: this test needs \"${tool}\"." >&2; annotate error "there is no ${tool} on this machine"; exit 1; }
done
if [ ! -f "${root}/.next/BUILD_ID" ]; then
  echo "error: the app is not built. Run \"npm run build\" first." >&2
  annotate error "the app is not built"
  exit 1
fi
FFMPEG="$(command -v "${FFMPEG_PATH:-ffmpeg}" 2> /dev/null || true)"

WORK="$(mktemp -d)"
OUT="${WORK}/out.txt"
VOLUMES="${WORK}/volumes"
passed=0
failed=0
failures=()
details=()
SECTION=""
ENDED=""
PIDS=()

cleanup() {
  local code=$?
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "${pid}" 2> /dev/null || true; done
  wait 2> /dev/null || true
  if [ -z "${ENDED}" ]; then
    echo "The test stopped before its end (exit ${code})."
    [ ! -f "${WORK}/app.log" ] || tail -n 15 "${WORK}/app.log"
    annotate error "the test stopped before its end, in \"${SECTION}\""
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

section() {
  SECTION="$1"
  printf '\n%s\n' "$1"
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

# The app, as the administrator: the app thinks it is behind https, as on a
# node, so its cookie is for https only and is handed over here by hand, the
# way workforce.py does it.
SESSION=""
api() { # METHOD PATH [BODY]
  curl -sS -m 300 -H "cookie: ${SESSION}" -H 'content-type: application/json' -X "$1" ${3:+-d "$3"} "${APP}$2"
}
# One value out of what the app has: a Python expression over "d", the parsed answer.
ask() { # PATH EXPRESSION
  api GET "$1" | python3 -c 'import json, sys
d = json.load(sys.stdin)
print(eval(sys.argv[1]))' "$2" 2> /dev/null || echo "?"
}
# Straight from the database, for what no page of the app shows.
db() { # SQL
  python3 -c 'import sqlite3, sys
rows = sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall()
print("\n".join(" ".join(str(v) for v in row) for row in rows))' "${WORK}/nexus.db" "$1"
}
# How many agents, teams, workflows and models the app has.
counts() {
  printf '%s agents, %s teams, %s workflows, %s models' "$(ask /api/agents 'len(d["agents"])')" "$(ask /api/teams 'len(d["teams"])')" \
    "$(ask /api/workflows 'len(d["workflows"])')" "$(ask /api/models 'len(d["models"])')"
}

# workforce.py against the app; what it said is in ${OUT}, how it ended in ${CODE}.
CODE=0
run() { # [NAME=VALUE...] -- OPTIONS
  local settings=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    settings+=("$1")
    shift
  done
  [ "$#" -eq 0 ] || shift
  CODE=0
  env NEXUS_PASSWORD="${PASS}" ${settings[@]+"${settings[@]}"} python3 "${host}/workforce.py" --url "${APP}" "$@" > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ "${SHOW:-}" = "1" ]; then sed 's/^/    | /' "${OUT}"; fi
}

# ── The file: the committed one, on the models of the mock ───────────────────

FILE="${WORK}/workforce.json"
python3 - "${host}/workforce.json" "${FILE}" "${MOCK}" << 'PYTHON_END'
import json, sys

real = json.load(open(sys.argv[1], encoding="utf-8"))
mock = sys.argv[3]
models = real["models"]
kind = lambda slot: models[slot].get("capabilities") or []
# A provider the file describes takes no key: the mock has one such gateway, and each of them is at its address.
keyless = [name for name, p in real["providers"].items() if p.get("baseUrl")]
for name in keyless:
    real["providers"][name]["baseUrl"] = mock + "/free/v1"
planner = real["tryRun"]["manager"]
agents_use = [a[key] for a in real["agents"] for key in ("primary", "fallback") if a.get(key)]
local, stand_in = {}, {}
for provider in sorted(set(m["provider"] for m in models.values())):
    slots = [slot for slot, m in models.items() if m["provider"] == provider]
    off = [slot for slot in slots if models[slot].get("enabled") is False]
    image = [slot for slot in slots if slot not in off and "image_generation" in kind(slot)]
    speech = [slot for slot in slots if slot not in off and ("speech_generation" in kind(slot) or "tts" in models[slot]["model"])]
    chat = [slot for slot in slots if slot not in off + image + speech]
    chat.sort(key=lambda slot: -agents_use.count(slot))
    free = provider in keyless
    for slot in off:
        local[slot] = dict(models[slot], model="chat-slow" if free else "gemini-mock-pro")
    for slot in image:
        local[slot] = dict(models[slot], model="img-ok" if free else "gemini-mock-flash-image")
    for slot in speech:
        local[slot] = dict(models[slot], model="tts-1" if free else "gemini-mock-flash-preview-tts")
    # The model that plans is the one that is busy every other time; the others of a provider are one model of the mock.
    rest = [slot for slot in chat if not (free and slot == planner)]
    if free and planner in chat:
        local[planner] = dict(models[planner], model="chat-busy")
    for slot in rest[:1]:
        local[slot] = dict(models[slot], model="chat-mini" if free else "gemini-mock-flash")
    for slot in rest[1:]:
        stand_in[slot] = rest[0]
real["models"] = local
for agent in real["agents"]:
    for key in ("primary", "fallback"):
        if agent.get(key):
            agent[key] = stand_in.get(agent[key], agent[key])
json.dump(real, open(sys.argv[2], "w", encoding="utf-8"), indent=1)
PYTHON_END
# Numbers and names out of that file: a Python expression over "d", the file.
of_file() {
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))' "${FILE}" "$1"
}
AGENTS="$(of_file 'len(d["agents"])')"
TEAMS="$(of_file 'len(d["teams"])')"
WORKFLOWS="$(of_file 'len(d["workflows"])')"
# The models the program takes into the app: those of the file that are not switched off.
MODELS="$(of_file 'sum(1 for m in d["models"].values() if m.get("enabled") is not False)')"
KEYLESS="$(of_file 'sum(1 for p in d["providers"].values() if p.get("baseUrl"))')"
# The model that plans, the image model and the voice of the file, each as "provider/model".
PLANNER="$(of_file '"/".join([d["models"][d["tryRun"]["manager"]][k] for k in ("provider", "model")])')"
IMAGE="$(of_file '["/".join([m["provider"], m["model"]]) for m in d["models"].values() if "image_generation" in (m.get("capabilities") or [])][0]')"
VOICE="$(of_file '["/".join([m["provider"], m["model"]]) for m in d["models"].values() if "tts" in m["model"]][0]')"
# A provider that takes no key and has a model the file switches off.
OFF_AT="$(of_file '[m["provider"] for m in d["models"].values() if m.get("enabled") is False and m["model"] == "chat-slow"][0]')"

# ── The app and the providers ────────────────────────────────────────────────

section "The app, with the mock providers"
(cd "${root}" && exec node scripts/e2e/mock-provider.mjs "${MOCK_PORT}" "${CDN_PORT}") > "${WORK}/mock.log" 2>&1 &
PIDS+=("$!")
(cd "${root}" && exec env NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATABASE_PATH="${WORK}/nexus.db" MEDIA_PATH="${WORK}/media" \
  SECRET_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)" APP_URL="https://nexus.example.test" COOKIE_SECURE="" \
  ALLOW_PRIVATE_PROVIDER_HOSTS=127.0.0.1 BOOTSTRAP_ADMIN_EMAIL="boss@example.test" BOOTSTRAP_ADMIN_USERNAME="boss" BOOTSTRAP_ADMIN_PASSWORD="${PASS}" \
  SANDBOX_URL="" SEARCH_PROVIDER="" FFMPEG_PATH="${FFMPEG:-${WORK}/no-ffmpeg-here}" RUN_CONCURRENCY="" NEXUS_WORKER="" PROVIDER_RETRIES="" \
  node node_modules/next/dist/bin/next start -p "${APP_PORT}" -H 127.0.0.1) > "${WORK}/app.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 240); do
  [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "${APP}/api/health" 2> /dev/null)" = "200" ] && break
  sleep 0.5
done
is "the app answers" "200" "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "${APP}/api/health")"
curl -sS -m 30 -o /dev/null -D "${WORK}/login.head" -H 'content-type: application/json' \
  -d "{\"identifier\":\"boss\",\"password\":\"${PASS}\"}" "${APP}/api/auth/login" || true
SESSION="$(tr -d '\r' < "${WORK}/login.head" | sed -n 's/^[Ss]et-[Cc]ookie: \(nexus_session=[^;]*\).*/\1/p' | head -n 1)"
is "the administrator of the first start can sign in" "boss" "$(ask /api/account/me 'd["user"]["username"]')"
api POST /api/providers "{\"name\":\"Gemini\",\"adapter\":\"gemini\",\"baseUrl\":\"${MOCK}/gemini/v1beta\",\"apiKey\":\"AIzaSyMOCK-0123456789-not-a-real-key\"}" > /dev/null
api POST /api/providers "{\"name\":\"Claude\",\"adapter\":\"anthropic\",\"baseUrl\":\"${MOCK}/anthropic/v1\",\"apiKey\":\"sk-ant-mock-0123456789abcdefghijklmnopqrstuvwxyz\"}" > /dev/null
is "it has the two providers and nothing else" "2 providers, 0 agents, 0 teams, 0 workflows, 0 models" "$(ask /api/providers 'len(d["providers"])') providers, $(counts)"
SESSIONS="$(db 'select count(*) from sessions')"

# ── Options and signing in ───────────────────────────────────────────────────

section "Options, and signing in"
run -- --help
is "--help ends well" "0" "${CODE}"
check "and names the options" says "--inventory-only"
check_not "without the code of the program" says "import "
run -- --no-such-option
is "an unknown option is refused" "2" "${CODE}"
run -- --file "${WORK}/not-there.json" --dry-run
is "a file that is not there is refused" "2" "${CODE}"
printf '{"agents":[{"name":"A","role":"B","primary":"nowhere"}]}' > "${WORK}/wrong.json"
run -- --file "${WORK}/wrong.json" --dry-run
is "a file that names a model it does not have is refused" "2" "${CODE}"
run NEXUS_PASSWORD= -- --inventory-only
is "without a password it does not start" "2" "${CODE}"
tried="$(db "select count(*) from audit_logs where action like 'auth.login%'")"
run NEXUS_PASSWORD=not-the-password -- --user boss --inventory-only
is "a wrong password ends with 3" "3" "${CODE}"
is "after one attempt" "$((tried + 1))" "$(db "select count(*) from audit_logs where action like 'auth.login%'")"
check_not "the password is not in what it says" says "not-the-password"
CODE=0
NEXUS_PASSWORD="${PASS}" python3 "${host}/workforce.py" --url "http://127.0.0.1:$((APP_PORT + 7))" --inventory-only > "${OUT}" 2>&1 || CODE=$?
is "an app that does not answer ends with 4" "4" "${CODE}"

# ── Looking ──────────────────────────────────────────────────────────────────

section "What the app has, and what the file would change"
run -- --user boss --inventory-only
is "the inventory ends well" "0" "${CODE}"
check "it says who is signed in" says '"boss", an administrator'
check "it names the providers" line 'Claude \(anthropic\)'
check "and the models they list that are not in the app" line 'not in the app, image: gemini-mock-flash-image'
check "and how long a provider is waited for" says "waits up to 60 s for an answer"
run -- --user boss --file "${FILE}" --dry-run --test
is "a dry run ends well" "0" "${CODE}"
check "it says what it would add" line '\+ Agent "Manager" \(Project Manager\): add it'
check "and that nothing was changed" says "Dry run: nothing was changed."
check "and that no model was tried" says "no model was tried"
check "a provider that differs is reported and left alone" line 'Provider "Gemini" differs from the file .*--update changes it'
check "a provider that takes no key would be added" line '\+ Provider "Kilo Gateway": add it \(openai-compatible, .*/free/v1, no key\)'
check "and its models taken in after that" line '^ +Model "[a-z0-9-]+": take chat-mini of Kilo Gateway into the app, once that provider is added'
is "no provider was added" "2" "$(ask /api/providers 'len(d["providers"])')"
is "nothing was changed" "0 agents, 0 teams, 0 workflows, 0 models" "$(counts)"
is "no model was asked anything" "0" "$(db "select count(*) from usage_records")"
is "its sessions are ended" "${SESSIONS}" "$(db 'select count(*) from sessions')"
check_not "the password is not in what it says" says "${PASS}"

# ── Doing ────────────────────────────────────────────────────────────────────

section "Making the workforce of the file"
if [ -n "${FFMPEG}" ]; then MEDIA=(--test-media); else MEDIA=(); fi
run -- --user boss --file "${FILE}" --yes --test ${MEDIA[@]+"${MEDIA[@]}"}
is "it ends well" "0" "${CODE}"
is "the app has what the file says" "${AGENTS} agents, ${TEAMS} teams, ${WORKFLOWS} workflows, ${MODELS} models" "$(counts)"
check "it read that back" says "everything the file asks for is there"
check "every chat model said its word" line 'ok +chat-mini \("[a-z0-9-]+"\) said "ok"'
check "one that says \"too many requests\" is asked again by the app, and answers" line 'ok +chat-busy \("[a-z0-9-]+"\) said "ok" in [1-9]'
check_not "no check failed" says "FAILED"
is "the providers that take no key were added" "${KEYLESS} none none none" \
  "$(ask /api/providers 'str(sum(1 for p in d["providers"] if p["authType"] == "none")) + " " + " ".join(p["authType"] for p in d["providers"] if p["name"] in ("Kilo Gateway", "OVHcloud AI Endpoints", "LLM7"))')"
is "with the address, the wait and the notes of the file" "True" \
  "$(ask /api/providers 'all(p["baseUrl"].endswith("/free/v1") and p["timeoutMs"] == 300000 and "no key" in (p["notes"] or "") for p in d["providers"] if p["authType"] == "none")')"
is "and without a key" "0" "$(ask /api/providers 'sum(1 for p in d["providers"] if p["authType"] == "none" and (p.get("credential") or {}).get("configured"))')"
is "a free model costs nothing in the app" "True" \
  "$(ask /api/models 'all(m["inputPricePerMTok"] == 0 and m["outputPricePerMTok"] == 0 for m in d["models"] if m["modelId"] in ("chat-mini", "chat-busy"))')"
is "the image model makes images only" "image_generation" \
  "$(ask /api/models '" ".join(sorted(c["capability"] for m in d["models"] if m["modelId"] == "img-ok" for c in m["capabilities"]))')"
is "a model the file switches off is not taken in" "0" "$(ask /api/models 'sum(1 for m in d["models"] if m["modelId"] in ("chat-slow", "gemini-mock-pro"))')"
is "the two models of every agent are with two providers" "${AGENTS}" \
  "$(api GET /api/models > "${WORK}/models.json"; api GET /api/providers > "${WORK}/providers.json"; api GET /api/agents | python3 -c 'import json, sys
agents = json.load(sys.stdin)["agents"]
models = dict((m["id"], m["providerId"]) for m in json.load(open(sys.argv[1]))["models"])
print(sum(1 for a in agents if a["primaryModelRowId"] and a["fallbackModelRowId"] and models[a["primaryModelRowId"]] != models[a["fallbackModelRowId"]]))' "${WORK}/models.json")"
is "a tool that this server cannot run is left out" "0" "$(ask /api/agents 'sum(1 for a in d["agents"] for t in a["tools"] if t in ("run_command", "web_search"))')"
is "the first 160 characters of every agent say what it is for" "${AGENTS}" "$(ask /api/agents 'sum(1 for a in d["agents"] if len(a["instructions"].split(chr(10))[0]) <= 160 and a["instructions"].split(chr(10))[0].endswith("."))')"
is "the providers that were there were left as they were" "60000 60000" "$(ask /api/providers '" ".join(str(p["timeoutMs"]) for p in d["providers"] if p["authType"] != "none")')"
if [ -n "${FFMPEG}" ]; then
  check "a picture and a sentence were made and joined" says "joined into one video"
  is "and deleted again" "0" "$(ask /api/media 'len(d["assets"])')"
else
  echo "  --   no ffmpeg here: the picture and the sentence were not tried"
fi
is "its sessions are ended" "${SESSIONS}" "$(db 'select count(*) from sessions')"
check "what it did is in the audit log, under the administrator's name" test "$(db "select count(*) from audit_logs a join users u on u.id = a.actor_user_id where u.username = 'boss' and a.action like 'agent.%'")" -ge "${AGENTS}"

section "A second time"
before="$(db 'select count(*) from audit_logs')"
run -- --user boss --file "${FILE}" --yes
is "it ends well" "0" "${CODE}"
check "there is nothing to do" says "Nothing to do: the app has everything the file asks for."
is "and nothing was added twice" "${AGENTS} agents, ${TEAMS} teams, ${WORKFLOWS} workflows, ${MODELS} models" "$(counts)"
is "the only things in the audit log are its sign-in and sign-out" "$((before + 2))" "$(db 'select count(*) from audit_logs')"

# ── What is there already ────────────────────────────────────────────────────

section "What is there is left as it is, unless --update is given"
QA_ID="$(ask /api/agents '[a["id"] for a in d["agents"] if a["name"] == "QA"][0]')"
api PATCH "/api/agents/${QA_ID}" '{"instructions":"Changed by hand.","maxSteps":3}' > /dev/null
api POST /api/agents '{"name":"Intern","role":"Helper","instructions":"Made by hand."}' > /dev/null
run -- --user boss --file "${FILE}" --yes
is "it ends well" "0" "${CODE}"
check "an agent that was changed by hand is reported" line 'Agent "QA" is in the app and differs from the file \(.*instructions.*\)'
is "and left as it is" "Changed by hand. 3" "$(ask "/api/agents" '[a["instructions"] + " " + str(a["maxSteps"]) for a in d["agents"] if a["name"] == "QA"][0]')"
run -- --user boss --file "${FILE}" --yes --update
is "with --update it ends well" "0" "${CODE}"
check "it says what it changes" line 'done +Agent "QA": change it to what the file says'
check_not "the agent is as the file says again" test "$(ask /api/agents '[a["instructions"] for a in d["agents"] if a["name"] == "QA"][0]')" = "Changed by hand."
is "under the ID it had" "${QA_ID}" "$(ask /api/agents '[a["id"] for a in d["agents"] if a["name"] == "QA"][0]')"
is "the provider the file names is waited for as long as the file says" "300000" "$(ask /api/providers '" ".join(str(p["timeoutMs"]) for p in d["providers"] if p["name"] == "Gemini")')"
is "the one it does not name is as it was" "60000" "$(ask /api/providers '" ".join(str(p["timeoutMs"]) for p in d["providers"] if p["name"] == "Claude")')"
is "and both still have their keys" "True" "$(ask /api/providers 'all(p["credential"]["configured"] for p in d["providers"] if p["authType"] != "none")')"
is "an agent the file does not name is still there" "1" "$(ask /api/agents 'sum(1 for a in d["agents"] if a["name"] == "Intern")')"
run -- --user boss --file "${FILE}" --yes --update --test-all
is "every chat model of the app answers, through the providers as they are now" "0" "${CODE}"
check_not "nothing is left to change" line '^  \+ '

section "A model the file switches off, and a provider that takes a key"
OFF_ID="$(ask /api/providers "[p['id'] for p in d['providers'] if p['name'] == '${OFF_AT}'][0]")"
api POST "/api/providers/${OFF_ID}/models/discover" '{"import":["chat-slow"]}' > /dev/null
is "a model the file switches off was taken into the app by hand" "True" "$(ask /api/models "[m['enabled'] for m in d['models'] if m['modelId'] == 'chat-slow' and m['providerId'] == '${OFF_ID}'][0]")"
run -- --user boss --file "${FILE}" --yes
is "the program ends well" "0" "${CODE}"
check "and says that it switches the model off" line 'done +Model "[a-z0-9-]+" \(chat-slow of .*\): switch it off'
is "it is switched off, and still there" "False" "$(ask /api/models "[m['enabled'] for m in d['models'] if m['modelId'] == 'chat-slow' and m['providerId'] == '${OFF_ID}'][0]")"
run -- --user boss --file "${FILE}" --yes
check "a second time there is nothing to do" says "Nothing to do: the app has everything the file asks for."
python3 - "${FILE}" "${WORK}/keyed.json" "${MOCK}" << 'PYTHON_END'
import json, sys
d = json.load(open(sys.argv[1]))
d["providers"]["Paid Gateway"] = {"adapter": "openai-compatible", "baseUrl": sys.argv[3] + "/openai/v1", "notes": "Takes a key."}
d["models"]["paid-chat"] = {"provider": "Paid Gateway", "model": "chat-mini"}
json.dump(d, open(sys.argv[2], "w"))
PYTHON_END
before="$(ask /api/providers 'len(d["providers"])')"
run -- --user boss --file "${WORK}/keyed.json" --yes
is "a provider that takes a key is not added: the program ends with 1" "1" "${CODE}"
check "it says that the key is to be entered on the Providers page" line 'Paid Gateway.*Providers page'
is "and no provider was added" "${before}" "$(ask /api/providers 'len(d["providers"])')"
check_not "nothing of the rest was changed either" line '^  done '

section "Only a part of the file"
python3 - "${FILE}" "${WORK}/more.json" << 'PYTHON_END'
import json, sys
d = json.load(open(sys.argv[1]))
d["agents"].append(dict(d["agents"][0], name="Second Manager"))
d["teams"].append({"name": "Second Team", "description": "", "agents": ["Second Manager"]})
json.dump(d, open(sys.argv[2], "w"))
PYTHON_END
run -- --user boss --file "${WORK}/more.json" --yes --only teams
is "a team whose agent is not there yet is not made" "1" "${CODE}"
check "it says which agent is missing" says "Second Manager"
is "nothing was added" "$((AGENTS + 1)) agents, ${TEAMS} teams" "$(ask /api/agents 'len(d["agents"])') agents, $(ask /api/teams 'len(d["teams"])') teams"
run -- --user boss --file "${WORK}/more.json" --yes --only agents,teams
is "with the agents it ends well" "0" "${CODE}"
is "both are there" "$((AGENTS + 2)) agents, $((TEAMS + 1)) teams" "$(ask /api/agents 'len(d["agents"])') agents, $(ask /api/teams 'len(d["teams"])') teams"

# ── The workflows of the file, in a project ──────────────────────────────────

section "The workflows of the file, run in a project with the limits of a new one"
project() { # WORKFLOW TEAM [image and speech models]
  python3 - "${WORK}" "$1" "$2" "${3:-}" "${PLANNER}" "${IMAGE}" "${VOICE}" << 'PYTHON_END'
import json, sys
work, workflow, team, media, planner, image, voice = sys.argv[1:8]
providers = dict((p["id"], p["name"]) for p in json.load(open(work + "/providers.json"))["providers"])
# By "provider/model": the mock's models have the same names with every provider.
models = dict(((providers[m["providerId"]] + "/" + m["modelId"]).lower(), m["id"]) for m in json.load(open(work + "/models.json"))["models"])
planner, image, voice = planner.lower(), image.lower(), voice.lower()
teams = dict((t["name"], t["id"]) for t in json.load(open(work + "/teams.json"))["teams"])
flows = dict((w["name"], w["id"]) for w in json.load(open(work + "/workflows.json"))["workflows"])
body = {"title": workflow, "goal": "A small coffee cart is the best start of the day.", "managerModelRowId": models[planner],
        "workflowId": flows[workflow], "teamId": teams[team]}
if media:
    body.update(imageModelRowId=models[image], speechModelRowId=models[voice])
print(json.dumps(body))
PYTHON_END
}
api GET /api/models > "${WORK}/models.json"
api GET /api/providers > "${WORK}/providers.json"
api GET /api/teams > "${WORK}/teams.json"
api GET /api/workflows > "${WORK}/workflows.json"
# How a run ended: the project's status, how many of its tasks succeeded, and who did each.
ended() { # PROJECT
  api GET /api/agents > "${WORK}/agents.json"
  api GET "/api/projects/$1" | python3 -c 'import json, sys
d = json.load(sys.stdin)
agents = dict((a["id"], a["name"]) for a in json.load(open(sys.argv[1]))["agents"])
tasks = d.get("tasks") or d.get("project", {}).get("tasks") or []
print("%s; %d of %d tasks succeeded; %s" % (d["project"]["status"], sum(1 for t in tasks if t["status"] == "succeeded"), len(tasks),
      ", ".join("%s: %s" % (t["title"], agents.get(t.get("agentId"), "nobody")) for t in tasks)))' "${WORK}/agents.json"
}
if [ -n "${FFMPEG}" ]; then
  made="$(api POST /api/projects "$(project "Short Reels" "Short Reels Team" media)")"
  REEL="$(printf '%s' "${made}" | python3 -c 'import json, sys; d = json.load(sys.stdin)["project"]; print(d["id"], d["maxTasks"], d["maxMedia"])' 2> /dev/null || echo "? ? ?")"
  is "a new project allows 12 tasks and 10 generated files" "12 10" "${REEL#* }"
  api POST "/api/projects/${REEL%% *}/run" > /dev/null
  result="$(ended "${REEL%% *}")"
  is "the reel is made: every step succeeds" "succeeded; 12 of 12 tasks succeeded" "${result%;*}"
  check "the script is written by Short Reels, the pictures by the Designer, the caption by the Copywriter" \
    grep -qE 'Script and storyboard: Short Reels, Scene 1 picture: Designer, Scene 1 voice-over: Short Reels, .*Cover image: Designer, Caption and hashtags: Copywriter' <<< "${result}"
  is "the final cut is one video of the four pictures under their voice-overs" "ready video/mp4 True" \
    "$(ask "/api/media?projectId=${REEL%% *}" '[" ".join([a["status"], a["mimeType"], str(a["durationSeconds"] >= 4)]) for a in d["assets"] if a["kind"] == "video"][0]')"
  is "with five pictures and four voice-overs beside it" "5 4" \
    "$(ask "/api/media?projectId=${REEL%% *}" 'str(sum(1 for a in d["assets"] if a["kind"] == "image")) + " " + str(sum(1 for a in d["assets"] if a["kind"] == "audio"))')"
else
  echo "  --   no ffmpeg here: the reel was not made"
fi
made="$(api POST /api/projects "$(project "Software delivery" "Software Team")")"
DELIVERY="$(printf '%s' "${made}" | python3 -c 'import json, sys; print(json.load(sys.stdin)["project"]["id"])' 2> /dev/null || echo "?")"
api POST "/api/projects/${DELIVERY}/run" > /dev/null
result="$(ended "${DELIVERY}")"
is "the software is delivered: every step succeeds" "succeeded; 10 of 10 tasks succeeded" "${result%;*}"
check "each step is done by the agent it names" \
  grep -qE 'Product brief: CEO, Delivery plan: Manager, UX and UI design: Designer, API and data design: Backend, Backend implementation: Backend, Frontend implementation: Frontend, Test plan and automated tests: Tester, Security review: Security Engineer, QA review: QA, Release plan: DevOps' <<< "${result}"

# ── The try-run of the file ──────────────────────────────────────────────────

section "The try-run of the file: a planned goal, then a task for every agent"
left() { printf '%s projects, %s workflows' "$(ask /api/projects 'len(d["projects"])')" "$(ask /api/workflows 'len(d["workflows"])')"; }
before="$(left)"
errors="$(db "select count(*) from usage_records where status = 'error'")"
run -- --user boss --file "${FILE}" --yes --try-run
is "it ends well" "0" "${CODE}"
check_not "nothing failed" says "FAILED"
check "the goal is planned by the model the file names for it" line 'Planned +by chat-busy: [0-9]+ tasks?;'
check "the tasks of the plan are done" line 'ok +1\. ".*", by .*: succeeded on '
check "every agent of the file gets a task" line "Given +one task to each of ${AGENTS} agents"
is "and does it on its own first model" \
  "$(of_file '"; ".join("%s on %s (%s)" % (a["name"], d["models"][a["primary"]]["model"], d["models"][a["primary"]]["provider"]) for a in d["agents"])')" \
  "$(sed -n '/^A small task for every agent/,$p' "${OUT}" | sed -n 's/^  ok  *[0-9]*\. \(.*\): succeeded on \([^(]*([^)]*)\).*/\1 on \2/p' | paste -sd ';' | sed 's/;/; /g')"
is "what each of them said is shown" "${AGENTS}" "$(grep -c '^ *it said: ' "${OUT}")"
is "both projects are summed up by the model that plans" "2" "$(grep -c 'summed up by chat-busy, beginning: ' "${OUT}")"
is "and reviewed" "2" "$(grep -cE '^  Review +VERDICT: pass' "${OUT}")"
is "that model said \"too many requests\" every other time, and no request failed for it" "${errors}" "$(db "select count(*) from usage_records where status = 'error'")"
is "the projects and the workflow of the check are deleted again" "${before}" "$(left)"
check "and the program says so" line 'Tidied +the project and its workflow were deleted again'
run -- --user boss --file "${FILE}" --yes --try-run --keep-try-run
is "with --keep-try-run it ends well" "0" "${CODE}"
check "and says where they are" line 'Kept +the project "Workforce check: every agent" is on the Projects page, and its workflow on the Workflows page'
is "they are kept" "$((${before%% *} + 2)) projects, $((WORKFLOWS + 1)) workflows" "$(left)"
python3 - "${FILE}" "${WORK}/no-try.json" << 'PYTHON_END'
import json, sys
d = json.load(open(sys.argv[1]))
del d["tryRun"]
json.dump(d, open(sys.argv[2], "w"))
PYTHON_END
run -- --user boss --file "${WORK}/no-try.json" --yes --try-run
is "a file without a try-run ends well" "0" "${CODE}"
check "and says that there is none" says 'the file has no "tryRun"'
run -- --user boss --file "${FILE}" --dry-run --try-run
check "a dry run starts no project" says "no project was run"

# ── On a node ────────────────────────────────────────────────────────────────

section "workforce.sh finds the app of a server"
mkdir -p "${VOLUMES}/${UUID}/xiero-nexus-ai" "${VOLUMES}/11111111-2222-4333-8444-555555555555"
printf 'version=1.5.0\n' > "${VOLUMES}/${UUID}/xiero-nexus-ai/VERSION"
: > "${VOLUMES}/${UUID}/xiero-nexus-ai/start.js"
: > "${VOLUMES}/${UUID}/xiero-nexus-ai/server.js"
printf '# The settings of the app\nAPP_URL=https://nexus.example.test\nBOOTSTRAP_ADMIN_USERNAME=boss\nBOOTSTRAP_ADMIN_PASSWORD="%s"\n' "${PASS}" > "${VOLUMES}/${UUID}/xiero-nexus-ai/.env"
node_run() { # [NAME=VALUE...] -- OPTIONS
  local settings=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    settings+=("$1")
    shift
  done
  [ "$#" -eq 0 ] || shift
  CODE=0
  env -u NEXUS_PASSWORD PATH="${here}:${PATH}" FAKE_DOCKER_PORTS="0.0.0.0:${APP_PORT} :::${APP_PORT}" FAKE_SERVER_PORT="${APP_PORT}" ${settings[@]+"${settings[@]}"} \
    bash "${host}/workforce.sh" --volumes "${VOLUMES}" "$@" > "${OUT}" 2>&1 < /dev/null || CODE=$?
  if [ "${SHOW:-}" = "1" ]; then sed 's/^/    | /' "${OUT}"; fi
}
node_run -- --file "${FILE}" --dry-run
is "the one server that has the app, by itself" "0" "${CODE}"
check "signed in with the administrator and the password of its .env" says '"boss", an administrator'
check "at the port Docker passes on" says "http://127.0.0.1:${APP_PORT}"
check_not "the password is not in what it says" says "${PASS}"
node_run -- --server 0a11ce00 --file "${FILE}" --inventory-only
is "by the first characters of its ID" "0" "${CODE}"
node_run -- --server deadbeef --file "${FILE}" --dry-run
is "a server that is not there is refused" "2" "${CODE}"
node_run -- --server 11111111 --file "${FILE}" --dry-run
is "and one without the app" "2" "${CODE}"
check "with the reason" says "has no Xiero Nexus AI bundle"
node_run FAKE_DOCKER_PORTS= -- --file "${FILE}" --dry-run
is "a server that is not running is refused" "2" "${CODE}"
check "with what to do" says "--url http://127.0.0.1:<port>"
sed -i 's/^BOOTSTRAP_ADMIN_PASSWORD=.*/BOOTSTRAP_ADMIN_PASSWORD=changed-in-the-app-since/' "${VOLUMES}/${UUID}/xiero-nexus-ai/.env"
node_run -- --file "${FILE}" --dry-run
is "a password in .env that is no longer right ends with 3" "3" "${CODE}"
check "and says why that happens" says "stops being right when it is changed in the app"
node_run NEXUS_PASSWORD="${PASS}" -- --file "${FILE}" --dry-run
is "NEXUS_PASSWORD goes before the one in .env" "0" "${CODE}"
is "its sessions are ended" "${SESSIONS}" "$(db 'select count(*) from sessions')"

ENDED=yes
summary="${passed} passed, ${failed} failed (the workforce from a file$([ -n "${FFMPEG}" ] || printf ', without ffmpeg'))"
printf '\n%s\n' "${summary}"
if [ "${failed}" -gt 0 ]; then
  printf '  ✗ %s\n' "${failures[@]}"
  annotate error "${summary}"$'\n'"$(printf '%s\n' "${details[@]}")"
  exit 1
fi
annotate notice "${summary}"
