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
# ones the mock has: every provider, skill, agent, team and workflow of it
# goes through the app's own checks, every workflow is run to the end in a
# project of the team that names it, with the limits a new project has, and
# its "tryRun" is run. The mock's model
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
# A plain web server of this test, for skill files that are fetched from an address.
WWW_PORT="${WWW_PORT:-4022}"
APP="http://127.0.0.1:${APP_PORT}"
WWW="http://127.0.0.1:${WWW_PORT}"
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
# The skills of the file are folders next to it.
cp -R "${host}/skills" "${WORK}/skills"
# Numbers and names out of that file: a Python expression over "d", the file.
of_file() {
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))' "${FILE}" "$1"
}
AGENTS="$(of_file 'len(d["agents"])')"
TEAMS="$(of_file 'len(d["teams"])')"
WORKFLOWS="$(of_file 'len(d["workflows"])')"
# The skills that are in the file. One that is "uploaded" is the owner's own, and not in it.
SKILLS="$(of_file 'sum(1 for s in d["skills"].values() if not s.get("uploaded"))')"
OWN_SKILL="$(of_file '[k for k, s in d["skills"].items() if s.get("uploaded")][0]')"
OWN_TEAM="$(of_file '[t["name"] for t in d["teams"] if [k for k, s in d["skills"].items() if s.get("uploaded")][0] in (t.get("skills") or [])][0]')"
# The agents the try-run gives a task: those of its team.
TRY_TEAM="$(of_file 'd["tryRun"]["team"]')"
TRY_AGENTS="$(of_file 'sum(1 for a in d["agents"] if a["name"] in [t for t in d["teams"] if t["name"] == d["tryRun"]["team"]][0]["agents"])')"
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
  SANDBOX_URL="" SEARCH_PROVIDER="" FFMPEG_PATH="${FFMPEG:-${WORK}/no-ffmpeg-here}" RUN_CONCURRENCY="" NEXUS_WORKER="" PROVIDER_RETRIES="" RUN_LIMIT_WAIT_MINUTES="0" MODEL_HEALTH_INTERVAL_MINUTES="0" \
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
check "it says who is signed in: the administrator of the first start is the owner" says '"boss", an owner'
check "it names the providers" line 'Claude \(anthropic\)'
check "and the models they list that are not in the app" line 'not in the app, image: gemini-mock-flash-image'
check "and how long a provider is waited for" says "waits up to 60 s for an answer"
run -- --user boss --file "${FILE}" --dry-run --test
is "a dry run ends well" "0" "${CODE}"
check "it says what it would add" line '\+ Agent "Manager" \(Project Manager\): add it'
check "the skills of the file among it" line '\+ Skill "short-reels": add it \([0-9]+ characters of instructions\)'
check "and which skills an agent gets" line '\+ Agent "Copywriter" \(Copywriter\): add it, .*; skills: anti-ai-slop-copy'
check "and that nothing was changed" says "Dry run: nothing was changed."
check "and that no model was tried" says "no model was tried"
check "a provider that differs is reported and left alone" line 'Provider "Gemini" differs from the file .*--update changes it'
check "a provider that takes no key would be added" line '\+ Provider "Kilo Gateway": add it \(openai-compatible, .*/free/v1, no key\)'
check "and its models taken in after that" line '^ +Model "[a-z0-9-]+": take chat-mini of Kilo Gateway into the app, once that provider is added'
is "no provider was added" "2" "$(ask /api/providers 'len(d["providers"])')"
is "nothing was changed" "0 agents, 0 teams, 0 workflows, 0 models" "$(counts)"
is "no skill was added" "0" "$(ask /api/skills 'len(d["skills"])')"
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
is "with the skills of the file" "${SKILLS}" "$(ask /api/skills 'len(d["skills"])')"
api GET /api/skills > "${WORK}/skills.json"
is "each with the words of its SKILL.md" "${SKILLS}" "$(
  for id in $(python3 -c 'import json, sys; print(" ".join(s["id"] for s in json.load(open(sys.argv[1]))["skills"]))' "${WORK}/skills.json"); do
    api GET "/api/skills/${id}"
    echo
  done | python3 -c 'import json, sys
same = 0
for line in sys.stdin:
    if not line.strip():
        continue
    skill = json.loads(line)["skill"]
    text = open(sys.argv[1] + "/skills/" + skill["name"] + "/SKILL.md", encoding="utf-8").read()
    front, body = text.split("\n---\n", 1)
    described = [l.split(": ", 1)[1] for l in front.split("\n") if l.startswith("description: ")][0]
    same += skill["instructions"] == body.strip() and skill["description"] == described and skill["enabled"]
print(same)' "${WORK}")"
is "an agent has the skills the file gives it, and a team its own" \
  "$(of_file '"; ".join("%s: %s" % (x["name"], ", ".join(sorted(k for k in x["skills"] if not d["skills"][k].get("uploaded")))) for x in d["agents"] + d["teams"] if [k for k in x.get("skills") or [] if not d["skills"][k].get("uploaded")])')" \
  "$(api GET /api/teams > "${WORK}/teams.json"; api GET /api/agents | python3 -c 'import json, sys
names = dict((s["id"], s["name"]) for s in json.load(open(sys.argv[1] + "/skills.json"))["skills"])
order = [x["name"] for x in json.load(open(sys.argv[2]))["agents"] + json.load(open(sys.argv[2]))["teams"]]
have = dict((x["name"], x["skillIds"]) for x in json.load(sys.stdin)["agents"] + json.load(open(sys.argv[1] + "/teams.json"))["teams"])
print("; ".join("%s: %s" % (name, ", ".join(sorted(names[i] for i in have[name]))) for name in order if have.get(name)))' "${WORK}" "${FILE}")"
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
# The tools an agent works on servers and in a browser with are given by hand, to the agents that are to have them.
QA_TOOLS="$(ask /api/agents 'json.dumps([a["tools"] for a in d["agents"] if a["name"] == "QA"][0] + ["run_on_server", "use_browser"])')"
api PATCH "/api/agents/${QA_ID}" "{\"tools\":${QA_TOOLS}}" > /dev/null
is "(an agent is given the tools to work on servers and in a browser by hand)" "True" "$(ask /api/agents '"run_on_server" in [a["tools"] for a in d["agents"] if a["name"] == "QA"][0] and "use_browser" in [a["tools"] for a in d["agents"] if a["name"] == "QA"][0]')"
run -- --user boss --file "${FILE}" --yes --update
is "with --update it ends well" "0" "${CODE}"
check "it says what it changes" line 'done +Agent "QA": change it to what the file says'
check_not "the agent is as the file says again" test "$(ask /api/agents '[a["instructions"] for a in d["agents"] if a["name"] == "QA"][0]')" = "Changed by hand."
is "  and keeps the tools to work on servers and in a browser that it was given by hand, with the tools of the file" "${QA_TOOLS}" "$(ask /api/agents 'json.dumps([a["tools"] for a in d["agents"] if a["name"] == "QA"][0])')"
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

section "Only what can be used: the models the file does not name"
# What a person does on the Providers page: take everything a gateway lists into the app.
GATE="LLM7"
GATE_ID="$(ask /api/providers "[p['id'] for p in d['providers'] if p['name'] == '${GATE}'][0]")"
EXTRA="'chat-paid','auto-paid','img-paid','chat-noaccess','chat-limited','chat-down','whisper-1','text-embedding-3-small','vid-ok'"
api POST "/api/providers/${GATE_ID}/models/discover" "{\"import\":[$(printf '%s' "${EXTRA}" | tr "'" '"')]}" > /dev/null
state_of() { # the models named, each as on or off
  ask /api/models "' '.join(sorted(m['modelId'] + ('=on' if m['enabled'] else '=off') for m in d['models'] if m['providerId'] == '${GATE_ID}' and m['modelId'] in ($1)))"
}
is "nine more models of a gateway are in the app, all switched on" \
  "auto-paid=on chat-down=on chat-limited=on chat-noaccess=on chat-paid=on img-paid=on text-embedding-3-small=on vid-ok=on whisper-1=on" "$(state_of "${EXTRA}")"
is "the app took their prices from the gateway's list" "2.0 10.0" \
  "$(ask /api/models "[' '.join(str(float(m[k])) for k in ('inputPricePerMTok', 'outputPricePerMTok')) for m in d['models'] if m['modelId'] == 'chat-paid'][0]")"
on_before="$(ask /api/models 'sum(1 for m in d["models"] if m["enabled"])')"
run -- --user boss --file "${FILE}" --dry-run --only-usable
is "a dry run ends well" "0" "${CODE}"
check "and tries no model" says "no model was tried"
is "and switches nothing off" "${on_before}" "$(ask /api/models 'sum(1 for m in d["models"] if m["enabled"])')"
curl -fsS "${MOCK}/__reset" > /dev/null
run -- --user boss --file "${FILE}" --yes --only-usable
is "it ends well" "0" "${CODE}"
is "what the gateway bills for is switched off, and what it refuses one word" \
  "auto-paid=off chat-noaccess=off chat-paid=off img-paid=off" "$(state_of "'chat-paid','auto-paid','img-paid','chat-noaccess'")"
is "a model that is limited or down at the moment stays on" "chat-down=on chat-limited=on" "$(state_of "'chat-limited','chat-down'")"
is "a model for listening or for embeddings is not judged by a word" "text-embedding-3-small=on whisper-1=on" "$(state_of "'text-embedding-3-small','whisper-1'")"
# Its name does not say that it makes videos, so the app took it for a chat model; the provider knows better.
is "a model that was taken for a chat model and that the provider refuses a chat is switched off" "vid-ok=off" "$(state_of "'vid-ok'")"
check "it says which it switched off because they are billed" line 'Switched off +3 models: the provider bills for it, and has no key here'
check "  which because the provider refused" line "chat-noaccess of ${GATE}: refused \\(403\\): .*not available on your plan"
check "  both of them" line 'Switched off +2 models: the provider refused one word'
check "and which it could not judge" line 'Not judged +2 models did not answer this time'
is "no billed model was asked anything" "0" \
  "$(curl -fsS "${MOCK}/__log" | python3 -c 'import json, sys; print(sum(1 for l in json.load(sys.stdin) if isinstance(l.get("body"), dict) and l["body"].get("model") in ("chat-paid", "auto-paid", "img-paid")))')"
is "five models fewer are switched on, and none of the file's" "$((on_before - 5))" "$(ask /api/models 'sum(1 for m in d["models"] if m["enabled"])')"
run -- --user boss --file "${FILE}" --yes
check "the models of the file are as they were" says "Nothing to do: the app has everything the file asks for."
run -- --user boss --file "${FILE}" --yes --only-usable
is "a second time it ends well" "0" "${CODE}"
check "and finds nothing more to switch off" says "nothing: no model was found that cannot be used"

section "The skills of the file: changed, given by hand, written wrongly"
SKILL_ID="$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'short-reels'][0]")"
had="$(ask "/api/skills/${SKILL_ID}" 'str(len(d["skill"]["agentIds"])) + " " + str(len(d["skill"]["teamIds"]))')"
printf '\nOne more rule, added for the test.\n' >> "${WORK}/skills/short-reels/SKILL.md"
mkdir -p "${WORK}/skills/short-reels/references"
printf '# Hooks\n\nThree that worked.\n' > "${WORK}/skills/short-reels/references/hooks.md"
run -- --user boss --file "${FILE}" --yes
is "it ends well" "0" "${CODE}"
check "a skill whose folder was changed is reported" line 'Skill "short-reels" is in the app and differs from the file \(instructions, files\)'
is "and left as it is" "False" "$(ask "/api/skills/${SKILL_ID}" '"One more rule" in d["skill"]["instructions"]')"
run -- --user boss --file "${FILE}" --yes --update
is "with --update it ends well" "0" "${CODE}"
check "it says what it changes" line 'done +Skill "short-reels": change it to what the file says \(instructions, files\)'
is "the app has the new words, and the file that came with them" "True references/hooks.md" \
  "$(ask "/api/skills/${SKILL_ID}" 'str(d["skill"]["instructions"].endswith("One more rule, added for the test.")) + " " + " ".join(f["path"] for f in d["skill"]["files"])')"
is "that file reads as it was written" "# Hooks  Three that worked. " "$(ask "/api/skills/${SKILL_ID}/files?path=references/hooks.md" 'd["content"].replace(chr(10), " ")')"
is "it is the same skill, with the agents and teams that had it" "${had}" "$(ask "/api/skills/${SKILL_ID}" 'str(len(d["skill"]["agentIds"])) + " " + str(len(d["skill"]["teamIds"]))')"
run -- --user boss --file "${FILE}" --yes --update
check "a second time there is nothing to do" says "Nothing to do: the app has everything the file asks for."
# The file gives the Manager no skills, and the Designer two.
MANAGER_ID="$(ask /api/agents '[a["id"] for a in d["agents"] if a["name"] == "Manager"][0]')"
DESIGNER_ID="$(ask /api/agents '[a["id"] for a in d["agents"] if a["name"] == "Designer"][0]')"
api PATCH "/api/agents/${MANAGER_ID}" "{\"skillIds\":[\"${SKILL_ID}\"]}" > /dev/null
api PATCH "/api/agents/${DESIGNER_ID}" '{"skillIds":[]}' > /dev/null
run -- --user boss --file "${FILE}" --yes
check "an agent that lost the skills the file gives it is reported" line 'Agent "Designer" is in the app and differs from the file \(skills\)'
run -- --user boss --file "${FILE}" --yes --update
is "with --update it ends well" "0" "${CODE}"
is "and it has them again" "$(of_file 'len([a for a in d["agents"] if a["name"] == "Designer"][0]["skills"])')" "$(ask /api/agents '[len(a["skillIds"]) for a in d["agents"] if a["name"] == "Designer"][0]')"
is "an agent whose skills the file does not name keeps what it was given by hand" "${SKILL_ID}" "$(ask /api/agents '[" ".join(a["skillIds"]) for a in d["agents"] if a["name"] == "Manager"][0]')"
api PATCH "/api/agents/${MANAGER_ID}" '{"skillIds":[]}' > /dev/null
wrong() { # NAME, a Python statement that changes "d", what the program has to say
  python3 - "${FILE}" "${WORK}/wrong.json" "$2" << 'PYTHON_END'
import json, sys
d = json.load(open(sys.argv[1]))
exec(sys.argv[3])
json.dump(d, open(sys.argv[2], "w"))
PYTHON_END
  run -- --user boss --file "${WORK}/wrong.json" --dry-run
  if [ "${CODE}" = "2" ] && says "$3"; then ok "$1"; else bad "$1 (it ended with ${CODE})"; fi
}
wrong "a skill that its SKILL.md calls by another name is refused" \
  'd["skills"]["Another Name"] = {"file": "skills/short-reels"}' 'its SKILL.md calls it "short-reels"'
wrong "a skill whose file is outside the folder of the definition is refused" \
  'd["skills"]["outside"] = {"file": "../../../etc/hostname"}' "not one that leaves its folder"
wrong "an agent that is given a skill the file does not have is refused" \
  'd["agents"][0]["skills"] = ["no-such-skill"]' 'names the skill "no-such-skill"'
wrong "a skill without words is refused" \
  'd["skills"]["empty"] = {"instructions": "  "}' "is empty"
is "nothing of those files reached the app" "${SKILLS}" "$(ask /api/skills 'len(d["skills"])')"

section "Skills of your own: named in the file, uploaded by the owner"
# Signs in and out again; prints the status of the sign-in.
signs_in() { # USER PASSWORD
  local head="${WORK}/signs-in.head" status cookie
  status="$(curl -sS -m 30 -o /dev/null -D "${head}" -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"identifier\":\"$1\",\"password\":\"$2\"}" "${APP}/api/auth/login" || true)"
  cookie="$(tr -d '\r' < "${head}" | sed -n 's/^[Ss]et-[Cc]ookie: \(nexus_session=[^;]*\).*/\1/p' | head -n 1)"
  [ -z "${cookie}" ] || curl -sS -m 30 -o /dev/null -H "cookie: ${cookie}" -H 'content-type: application/json' -X POST -d '{}' "${APP}/api/auth/logout" || true
  printf '%s' "${status}"
}
team_skills() { # TEAM: the names of its skills, sorted
  api GET /api/teams | python3 -c 'import json, sys
teams = json.load(sys.stdin)["teams"]
names = dict((s["id"], s["name"]) for s in json.load(open(sys.argv[2]))["skills"])
print(" ".join(sorted(names.get(i, "?") for i in [t for t in teams if t["name"] == sys.argv[1]][0]["skillIds"])))' "$1" "${WORK}/skills.json"
}
skills_now() { api GET /api/skills > "${WORK}/skills.json"; }
FILE_TEAM_SKILLS="$(python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
team = [t for t in d["teams"] if t["name"] == sys.argv[2]][0]
print(" ".join(sorted(k for k in team["skills"] if not d["skills"][k].get("uploaded"))))' "${FILE}" "${OWN_TEAM}")"
run -- --user boss --file "${FILE}" --dry-run
check "a skill of your own that the app does not have is said, with who waits for it" line "Skill \"${OWN_SKILL}\" is one of your own, and it is not in the app.*team \"${OWN_TEAM}\""
check "  and stands in nobody's way" says "Nothing to do: the app has everything the file asks for."
skills_now
is "the team that names it was made without it" "${FILE_TEAM_SKILLS}" "$(team_skills "${OWN_TEAM}")"
mkdir -p "${WORK}/own"
printf -- '---\nname: %s\ndescription: The way this house builds.\n---\n\n# The house rules\n\nA rule of the house, kept by everyone.\n' "${OWN_SKILL}" > "${WORK}/own/SKILL.md"
run -- --user boss --file "${FILE}" --dry-run --upload-skill "${WORK}/own/SKILL.md"
check "a dry run says that the file would be uploaded" line '\+ Skill file "SKILL.md" \([0-9]+ bytes\): upload it'
is "  and uploads nothing" "${SKILLS}" "$(ask /api/skills 'len(d["skills"])')"
run -- --user boss --file "${FILE}" --yes --update --upload-skill "${WORK}/own/SKILL.md"
is "uploading it ends well" "0" "${CODE}"
check "the file is uploaded, as on the Skills page" line 'done +Skill file "SKILL.md" \([0-9]+ bytes\): upload it'
check "  and what the app made of it is said" line "added \"${OWN_SKILL}\": [0-9]+ characters of instructions\\."
check "the team that names it is given it" line "done +Team \"${OWN_TEAM}\": change it to what the file says \(skills\)"
skills_now
is "  with the skills the file gave it before" "$(printf '%s\n' ${FILE_TEAM_SKILLS} "${OWN_SKILL}" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" "$(team_skills "${OWN_TEAM}")"
is "the app has one skill more than the file" "$((SKILLS + 1))" "$(ask /api/skills 'len(d["skills"])')"
run -- --user boss --file "${FILE}" --yes --update
check "a second time there is nothing to do" says "Nothing to do: the app has everything the file asks for."
check "  and the skill is counted as there" says "skill \"${OWN_SKILL}\" (uploaded)"
printf '\nAnd one more rule.\n' >> "${WORK}/own/SKILL.md"
run -- --user boss --file "${FILE}" --yes --upload-skill "${WORK}/own/SKILL.md"
check "uploaded again, the skill is replaced" says "replaced \"${OWN_SKILL}\""
is "  and keeps the team it was given to" "1" "$(ask /api/skills "[len(s['teamIds']) for s in d['skills'] if s['name'] == '${OWN_SKILL}'][0] > 0 and 1")"
# An archive: a folder with a SKILL.md and a file of its own.
python3 - "${WORK}/own/bundle.skill" << 'PYTHON_END'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("house-checklist/SKILL.md", "---\nname: house-checklist\ndescription: What is checked before anything leaves the house.\n---\n\n# Checklist\n\nRead references/list.md.\n")
    archive.writestr("house-checklist/references/list.md", "# The list\n\n1. It works.\n")
    archive.writestr("house-checklist/logo.png", bytes([0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 3]))
PYTHON_END
run -- --user boss --file "${FILE}" --yes --upload-skill "${WORK}/own/bundle.skill"
is "an archive is uploaded too" "0" "${CODE}"
check "  with its files" line 'added "house-checklist": [0-9]+ characters of instructions, 1 file\.'
check "  and what is no text is left out, with how many and why, and named" line "left out of it: 1 file \(it is not text .*\): house-checklist/logo\.png"
# A skill that a team was given by hand stays when the file gives it others.
HOUSE_ID="$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'house-checklist'][0]")"
TEAM_ID="$(ask /api/teams "[t['id'] for t in d['teams'] if t['name'] == '${OWN_TEAM}'][0]")"
api PATCH "/api/teams/${TEAM_ID}" "{\"skillIds\":$(api GET /api/teams | python3 -c 'import json, sys
team = [t for t in json.load(sys.stdin)["teams"] if t["id"] == sys.argv[1]][0]
print(json.dumps(team["skillIds"] + [sys.argv[2]]))' "${TEAM_ID}" "${HOUSE_ID}")}" > /dev/null
run -- --user boss --file "${FILE}" --yes --update
check "a skill a team was given by hand is no difference from the file" says "Nothing to do: the app has everything the file asks for."
skills_now
check "  and it keeps it" grep -qw "house-checklist" <<< "$(team_skills "${OWN_TEAM}")"
api PATCH "/api/teams/${TEAM_ID}" "{\"skillIds\":[\"${HOUSE_ID}\"]}" > /dev/null
run -- --user boss --file "${FILE}" --yes --update
check "a team that lost the skills of the file gets them back" line "done +Team \"${OWN_TEAM}\": change it to what the file says \(skills\)"
skills_now
is "  and keeps the one it was given by hand" "$(printf '%s\n' ${FILE_TEAM_SKILLS} "${OWN_SKILL}" house-checklist | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" "$(team_skills "${OWN_TEAM}")"
run -- --user boss --file "${FILE}" --dry-run --upload-skill "${WORK}/own/no-such-file.md"
is "a file that is not there is refused" "2" "${CODE}"
head -c 300 /dev/urandom > "${WORK}/own/noise.bin"
run -- --user boss --file "${FILE}" --yes --upload-skill "${WORK}/own/noise.bin"
is "a file that is neither text nor an archive: the app refuses it, and it ends with 1" "1" "${CODE}"
check "  with what the app said" says "neither text nor a ZIP archive"
wrong "a skill of your own cannot also be written in the file" \
  'd["skills"]["both"] = {"uploaded": True, "instructions": "Words."}' 'what it says is in the app, not in this file'

# Skill files at an address. One archive holds two skills, each a folder with a SKILL.md.
mkdir -p "${WORK}/www"
python3 - "${WORK}/www" << 'PYTHON_END'
import io, sys, zipfile

def words(name):
    return "---\nname: %s\ndescription: Fetched from an address.\n---\n\n# %s\n\nFetched, not typed.\n" % (name, name)

with zipfile.ZipFile(sys.argv[1] + "/all-skills.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("all/fetched-one/SKILL.md", words("fetched-one"))
    archive.writestr("all/fetched-one/references/notes.md", "# Notes\n")
    archive.writestr("all/more/fetched-two/SKILL.md", words("fetched-two"))
with zipfile.ZipFile(sys.argv[1] + "/fetched-three.skill", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("fetched-three/SKILL.md", words("fetched-three"))
open(sys.argv[1] + "/sign-in.html", "w").write("<!DOCTYPE html>\n<html><body>Sign in to download.</body></html>\n")
PYTHON_END
(cd "${WORK}/www" && exec python3 -m http.server "${WWW_PORT}" --bind 127.0.0.1) > "${WORK}/www.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "${WWW}/sign-in.html" 2> /dev/null)" = "200" ] && break
  sleep 0.25
done
before_fetch="$(ask /api/skills 'len(d["skills"])')"
run -- --user boss --file "${FILE}" --dry-run --skill-url "${WWW}/all-skills.zip"
is "a dry run fetches a skill file from an address" "0" "${CODE}"
check "  and names the skills it holds, with their files" \
  line '\+ Skill file "all-skills\.zip" \([0-9]+ bytes\), from 127\.0\.0\.1: upload it; a skill of the same name is replaced\. It holds 2 skills: "fetched-one" with 1 more file, "fetched-two"\.'
is "  nothing is uploaded" "${before_fetch}" "$(ask /api/skills 'len(d["skills"])')"
run -- --user boss --file "${FILE}" --yes --skill-url "${WWW}/all-skills.zip" --skill-url "${WWW}/fetched-three.skill"
is "fetched for good, it ends well" "0" "${CODE}"
check "the skills of the archive are added, with their files" line 'added "fetched-one": [0-9]+ characters of instructions, 1 file\.'
check "  and so is the one of the second address" line 'done +Skill file "fetched-three\.skill" \([0-9]+ bytes\), from 127\.0\.0\.1: upload it'
is "the app has the three" "fetched-one fetched-three fetched-two" "$(ask /api/skills '" ".join(sorted(s["name"] for s in d["skills"] if s["name"].startswith("fetched-")))')"
is "  with the words that were fetched" "True" "$(ask "/api/skills/$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'fetched-two'][0]")" '"Fetched, not typed." in d["skill"]["instructions"]')"
run -- --user boss --file "${FILE}" --yes --skill-url "${WWW}/sign-in.html"
is "an address that gives a web page in place of the file stands in the way" "1" "${CODE}"
check "  and is said, without the whole address" says "PROBLEM: Skill from 127.0.0.1 (sign-in.html): the site gave a web page in place of the file"
run -- --user boss --file "${FILE}" --yes --skill-url "${WWW}/no-such-file.skill"
check "  and so does an address without a file" says "Skill from 127.0.0.1 (no-such-file.skill): the site answered 404: no such file."
run -- --user boss --file "${FILE}" --dry-run --skill-url "http://example.com/a.skill"
is "an address that is not https is a wrong option" "2" "${CODE}"
run NEXUS_SKILL_URLS="${WWW}/fetched-three.skill" -- --user boss --file "${FILE}" --dry-run
check "addresses are also taken from the environment" line '\+ Skill file "fetched-three\.skill"'
# The page of a file at MediaFire names the file itself in one of two ways.
is "MediaFire's page of a file is followed to the file" "https://download1.mediafire.com/a/k/x.zip?p=1&q=2 https://download22.mediafire.com/b/k/y.skill.zip None" "$(python3 - "${host}" << 'PYTHON_END'
import base64, sys
sys.path.insert(0, sys.argv[1])
import workforce
plain = '<a class="input popsok" aria-label="Download file" href="https://download1.mediafire.com/a/k/x.zip?p=1&amp;q=2" id="downloadButton">'
scrambled = '<a class="input popsok" href="javascript:void(0)" data-scrambled-url="%s" id="downloadButton">' % base64.b64encode(b"https://download22.mediafire.com/b/k/y.skill.zip").decode()
print(workforce.mediafire_direct(plain), workforce.mediafire_direct(scrambled), workforce.mediafire_direct("<html>Just a moment...</html>"))
PYTHON_END
)"
is "the inventory says which failing models the app leaves out of its lists" "last test failed, left out of the lists: no credit | last test failed: no credit | last test ok" "$(python3 - "${host}" << 'PYTHON_END'
import sys
sys.path.insert(0, sys.argv[1])
import workforce
print(" | ".join(workforce.tested_text(item) for item in (
    {"lastTestStatus": "error", "lastTestError": "no credit", "hidden": True},
    {"lastTestStatus": "error", "lastTestError": "no credit", "hidden": False},
    {"lastTestStatus": "ok", "hidden": False})))
PYTHON_END
)"
is "  and how the app checks its models, with what the last round found" "the app asks every chat model for one word, every 6 hours; its last round ended 3 minutes ago: 31 asked, 13 answered, 18 failed; 2 models are left out of its lists now | the app asks every chat model for one word, not automatic (MODEL_HEALTH_INTERVAL_MINUTES=0); no round since the app started; no model is left out of its lists now | the app asks every chat model for one word, every 90 minutes; a round is running now; 1 model is left out of its lists now" "$(python3 - "${host}" << 'PYTHON_END'
import sys
sys.path.insert(0, sys.argv[1])
import workforce
now = 1800000000
print(" | ".join((
    workforce.health_text({"automatic": True, "intervalMinutes": 360, "running": False, "last": {"endedAt": (now - 200) * 1000, "checked": 31, "passed": 13, "failed": 18}}, [{"hidden": True}, {"hidden": True}, {"hidden": False}, {}], now),
    workforce.health_text({"automatic": False, "intervalMinutes": 0, "running": False, "last": None}, [{"hidden": False}], now),
    workforce.health_text({"automatic": True, "intervalMinutes": 90, "running": True, "last": None}, [{"hidden": True}], now))))
PYTHON_END
)"
is "a site passes a request on to another https address, and to no other" "onwards refused refused" "$(python3 - "${host}" << 'PYTHON_END'
import sys, urllib.request
sys.path.insert(0, sys.argv[1])
import workforce
asked = urllib.request.Request("https://files.example/a.skill")
said = []
for onwards in ("https://cdn.example/a.skill", "http://127.0.0.1:8080/secret", "http://cdn.example/a.skill"):
    try:
        workforce.OnlyOnwardsSafely(False).redirect_request(asked, None, 302, "Found", {}, onwards)
        said.append("onwards")
    except workforce.NotFetched:
        said.append("refused")
print(" ".join(said))
PYTHON_END
)"
for fetched in fetched-one fetched-two fetched-three; do
  api DELETE "/api/skills/$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == '${fetched}'][0]")" > /dev/null
done
# Taken out again, so that what follows counts the skills of the file.
api DELETE "/api/skills/${HOUSE_ID}" > /dev/null
OWN_ID="$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == '${OWN_SKILL}'][0]")"
api DELETE "/api/skills/${OWN_ID}" > /dev/null
is "(the skills of the test are deleted again)" "${SKILLS}" "$(ask /api/skills 'len(d["skills"])')"

section "An account the app is to have"
run -- --user boss --file "${FILE}" --inventory-only
check "the accounts are in what the app has, by role" line 'Accounts +1 owner: boss'
check "  and so is how the app checks its models" line 'Model check +the app asks every chat model for one word, not automatic \(MODEL_HEALTH_INTERVAL_MINUTES=0\); no round since the app started; (no model is|1 model is|[0-9]+ models are) left out of its lists now'
ACCOUNT=(--only accounts --account rina --account-email Rina@Example.test --account-role owner)
run NEXUS_ACCOUNT_PASSWORD="the-first-password-of-rina" -- --user boss --file "${FILE}" --dry-run "${ACCOUNT[@]}"
is "the plan ends well" "0" "${CODE}"
check "it says what it would add" line '\+ Account "rina" <rina@example\.test>: add it, as an owner\.'
check_not "  and not the password" says "the-first-password-of-rina"
is "  and adds nothing" "1" "$(ask /api/admin/users 'len(d["users"])')"
before="$(counts)"
run NEXUS_ACCOUNT_PASSWORD="the-first-password-of-rina" -- --user boss --file "${FILE}" --yes "${ACCOUNT[@]}"
is "adding it ends well" "0" "${CODE}"
check_not "  without the password in what it says" says "the-first-password-of-rina"
is "the account is there: an owner, switched on, its email in small letters" "owner active rina@example.test" "$(ask /api/admin/users '[" ".join([u["role"], u["status"], u["email"]]) for u in d["users"] if u["username"] == "rina"][0]')"
check "it is signed in once with that password, to see that it is the right one" says '"rina" signs in with it, as an owner.'
is "  it signs in with the password it was given" "200" "$(signs_in rina the-first-password-of-rina)"
is "  only that part was done: the workforce is as it was" "${before}" "$(counts)"
run NEXUS_ACCOUNT_PASSWORD="another-password-for-rina" -- --user boss --file "${FILE}" --yes "${ACCOUNT[@]}"
check "a second time it is as asked" says 'account "rina" (an owner)'
check "  and its password is left as it is" says "its password is left as it is; --update sets the one that was given"
is "  that the password that was given is not the account's ends with 1" "1" "${CODE}"
check "  and is said" says '"rina" does not sign in with it'
is "  the first password still signs in" "200" "$(signs_in rina the-first-password-of-rina)"
run NEXUS_ACCOUNT_PASSWORD="another-password-for-rina" -- --user boss --file "${FILE}" --yes --update "${ACCOUNT[@]}"
check "with --update the password that was given is set" line 'done +Account "rina": change it to what was asked \(password\); it is signed out everywhere'
is "  once, and the run ends well" "0 1" "${CODE} $(grep -cE 'done +Account "rina"' "${OUT}")"
check "  and signs the account in" says '"rina" signs in with it, as an owner.'
is "  the old one signs in no more, the new one does" "401 200" "$(signs_in rina the-first-password-of-rina) $(signs_in rina another-password-for-rina)"
run -- --user boss --file "${FILE}" --yes --only accounts --account rina --account-email rina@example.test --account-role admin
check "another role than it has is reported" line 'Account "rina" is in the app and differs from what was asked \(role\)'
is "  and left as it is" "owner" "$(ask /api/admin/users '[u["role"] for u in d["users"] if u["username"] == "rina"][0]')"
run -- --user boss --file "${FILE}" --yes --update --only accounts --account rina --account-email rina@example.test --account-role admin
is "with --update it is changed" "admin" "$(ask /api/admin/users '[u["role"] for u in d["users"] if u["username"] == "rina"][0]')"
run -- --user boss --file "${FILE}" --yes --only accounts --account sari --account-email sari@example.test
is "a new account without a password is refused" "1" "${CODE}"
check "  with where the password goes" says "NEXUS_ACCOUNT_PASSWORD in the environment, at least 10 characters"
run NEXUS_ACCOUNT_PASSWORD="short" -- --user boss --file "${FILE}" --yes --only accounts --account sari --account-email sari@example.test
is "  and so is one with a password that is too short" "1" "${CODE}"
run -- --user boss --file "${FILE}" --dry-run --account sari
is "an account without an email is a wrong option" "2" "${CODE}"
run -- --user boss --file "${FILE}" --dry-run --account sari --account-email sari@example.test --account-role root
is "  and so is a role there is not" "2" "${CODE}"
run NEXUS_ACCOUNT_PASSWORD="a-password-for-the-boss" -- --user boss --file "${FILE}" --yes --update --only accounts --account boss --account-email boss@example.test --account-role owner
is "the account it signs in as is not changed" "1" "${CODE}"
check "  with where that is done" says "It changes its own name, email and password under Settings"
is "  its password still signs in" "200" "$(signs_in boss "${PASS}")"
# An administrator who is no owner manages no accounts.
run NEXUS_PASSWORD="another-password-for-rina" NEXUS_ACCOUNT_PASSWORD="a-password-for-sari" -- --user rina --file "${FILE}" --yes --only accounts --account sari --account-email sari@example.test
is "signed in as an administrator who is no owner, it adds no account" "1" "${CODE}"
check "  and says who does" says '"rina" is an administrator of the app, and only an owner manages accounts'
is "  none was added" "2" "$(ask /api/admin/users 'len(d["users"])')"
run NEXUS_PASSWORD="another-password-for-rina" -- --user rina --file "${FILE}" --dry-run
is "  the workforce it can still read and compare" "0" "${CODE}"
RINA_ID="$(ask /api/admin/users '[u["id"] for u in d["users"] if u["username"] == "rina"][0]')"
api DELETE "/api/admin/users/${RINA_ID}" > /dev/null
is "(the account of the test is deleted again)" "1" "$(ask /api/admin/users 'len(d["users"])')"

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
check "each step of it is done by the agent it names" \
  grep -qE 'Product brief: CEO, Delivery plan: Manager, UX and UI design: Designer, API and data design: Backend, Backend implementation: Backend, Frontend implementation: Frontend, Test plan and automated tests: Tester, Security review: Security Engineer, QA review: QA, Release plan: DevOps' <<< "${result}"

# Every other workflow of the file, in a project of the team whose description names it.
python3 - "${FILE}" > "${WORK}/flows.txt" << 'PYTHON_END'
import json, sys
d = json.load(open(sys.argv[1]))
for w in d["workflows"]:
    if w["name"] in ("Short Reels", "Software delivery"):
        continue
    teams = [t["name"] for t in d["teams"] if 'the workflow "%s"' % w["name"] in t["description"]]
    kinds = set(s.get("kind", "text") for s in w["steps"])
    print("\t".join([
        w["name"], teams[0] if len(teams) == 1 else "-", "media" if kinds - {"text"} else "-", "render" if "render" in kinds else "-",
        str(len(w["steps"])), ", ".join("%s: %s" % (s["title"], s["role"]) for s in w["steps"])]))
PYTHON_END
OTHERS=0
while IFS="$(printf '\t')" read -r flow team media render steps who; do
  OTHERS=$((OTHERS + 1))
  if [ "${team}" = "-" ]; then
    bad "the workflow \"${flow}\" is named by the description of exactly one team"
    continue
  fi
  if [ "${render}" = "render" ] && [ -z "${FFMPEG}" ]; then
    echo "  --   no ffmpeg here: \"${flow}\" was not run"
    continue
  fi
  made="$(api POST /api/projects "$(project "${flow}" "${team}" "${media#-}")")"
  id="$(printf '%s' "${made}" | python3 -c 'import json, sys; print(json.load(sys.stdin)["project"]["id"])' 2> /dev/null || echo "?")"
  api POST "/api/projects/${id}/run" > /dev/null
  is "\"${flow}\" with the team \"${team}\": all ${steps} steps succeed, each done by the agent it names" \
    "succeeded; ${steps} of ${steps} tasks succeeded; ${who}" "$(ended "${id}")"
done < "${WORK}/flows.txt"
is "every workflow of the file was run" "$((WORKFLOWS - 2))" "${OTHERS}"

# ── The try-run of the file ──────────────────────────────────────────────────

section "The try-run of the file: a planned goal, then a task for every agent of its team"
left() { printf '%s projects, %s workflows' "$(ask /api/projects 'len(d["projects"])')" "$(ask /api/workflows 'len(d["workflows"])')"; }
before="$(left)"
errors="$(db "select count(*) from usage_records where status = 'error'")"
run -- --user boss --file "${FILE}" --yes --try-run
is "it ends well" "0" "${CODE}"
check_not "nothing failed" says "FAILED"
check "the goal is planned by the model the file names for it" line 'Planned +by chat-busy: [0-9]+ tasks?;'
check "the tasks of the plan are done" line 'ok +1\. ".*", by .*: succeeded on '
check "every agent of the try-run's team gets a task, and no other" says "A small task for every agent of the team \"${TRY_TEAM}\""
check "  each of them one" line "Given +one task to each of ${TRY_AGENTS} agents"
is "and does it on its own first model" \
  "$(of_file '"; ".join("%s on %s (%s)" % (a["name"], d["models"][a["primary"]]["model"], d["models"][a["primary"]]["provider"]) for a in d["agents"] if a["name"] in [t for t in d["teams"] if t["name"] == d["tryRun"]["team"]][0]["agents"])')" \
  "$(sed -n '/^A small task for every agent/,$p' "${OUT}" | sed -n 's/^  ok  *[0-9]*\. \(.*\): succeeded on \([^(]*([^)]*)\).*/\1 on \2/p' | paste -sd ';' | sed 's/;/; /g')"
is "what each of them said is shown" "${TRY_AGENTS}" "$(grep -c '^ *it said: ' "${OUT}")"
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
check "signed in with the administrator and the password of its .env" says '"boss", an owner'
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

section "Sealed for the node: an account's password and a skill of your own"
NODE_KEY="${WORK}/node-key"
NODE_PUBLIC="$(bash "${host}/sealed-output.sh" keygen "${NODE_KEY}" | tail -n 1)"
SEALED_PASSWORD="$(printf '%s' 'a-password-sealed-for-the-node' | bash "${host}/sealed-output.sh" seal-line "${NODE_PUBLIC}")"
printf -- '---\nname: sealed-house-rules\ndescription: Sent sealed.\n---\n\n# Sealed\n\nOnly the node read this on its way.\n' > "${WORK}/own/sealed.md"
SEALED_SKILL="$(bash "${host}/sealed-output.sh" seal-line "${NODE_PUBLIC}" < "${WORK}/own/sealed.md")"
node_run NEXUS_PASSWORD="${PASS}" -- --file "${FILE}" --yes --only accounts,skills --account tono --account-email tono@example.test --account-role admin \
  --account-password-sealed "${SEALED_PASSWORD}" --skill-sealed "${SEALED_SKILL}"
is "without the node's key, what was sealed is not opened" "2" "${CODE}"
check "  and it says how the node gets one" says 'Make one with the action "input-key"'
node_run NEXUS_PASSWORD="${PASS}" XIERO_INPUT_KEY="${NODE_KEY}/key.pem" -- --file "${FILE}" --yes --only accounts,skills --account tono --account-email tono@example.test --account-role admin \
  --account-password-sealed "${SEALED_PASSWORD}" --skill-sealed "${SEALED_SKILL}"
is "with it, the run ends well" "0" "${CODE}"
check "the account is made" line 'done +Account "tono" <tono@example\.test>: add it, as an administrator\.'
is "  and signs in with the password that came sealed" "200" "$(signs_in tono a-password-sealed-for-the-node)"
check "the skill is uploaded" says 'added "sealed-house-rules"'
is "  with the words that came sealed" "True" "$(ask "/api/skills/$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'sealed-house-rules'][0]")" '"Only the node read this on its way." in d["skill"]["instructions"]')"
check_not "neither the password nor the words are in what it says" grep -qF -e "a-password-sealed-for-the-node" -e "Only the node read this" "${OUT}"
is "what was opened is gone from the node again" "0" "$(find "${TMPDIR:-/tmp}" -maxdepth 3 -name 'SKILL.md' -newer "${WORK}/own/sealed.md" -exec grep -l 'Only the node read this' {} + 2> /dev/null | wc -l | tr -d ' ')"
SEALED_ADDRESS="$(printf '%s' "${WWW}/fetched-three.skill" | bash "${host}/sealed-output.sh" seal-line "${NODE_PUBLIC}")"
node_run NEXUS_PASSWORD="${PASS}" XIERO_INPUT_KEY="${NODE_KEY}/key.pem" -- --file "${FILE}" --yes --only skills --skill-url-sealed "${SEALED_ADDRESS}"
is "the address of a skill file can come sealed too" "0" "${CODE}"
check "  the file is fetched from it and uploaded" says 'added "fetched-three"'
api DELETE "/api/skills/$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'fetched-three'][0]")" > /dev/null
OTHER_PUBLIC="$(bash "${host}/sealed-output.sh" keygen "${WORK}/other-key" | tail -n 1)"
node_run NEXUS_PASSWORD="${PASS}" XIERO_INPUT_KEY="${NODE_KEY}/key.pem" -- --file "${FILE}" --yes --only accounts --account wati --account-email wati@example.test \
  --account-password-sealed "$(printf '%s' 'sealed-for-another-node' | bash "${host}/sealed-output.sh" seal-line "${OTHER_PUBLIC}")"
is "a password sealed for another key is refused" "2" "${CODE}"
check "  with the reason" says "does not open with the key of this node"
is "  and no account is made" "0" "$(ask /api/admin/users 'len([u for u in d["users"] if u["username"] == "wati"])')"
api DELETE "/api/admin/users/$(ask /api/admin/users '[u["id"] for u in d["users"] if u["username"] == "tono"][0]')" > /dev/null
api DELETE "/api/skills/$(ask /api/skills "[s['id'] for s in d['skills'] if s['name'] == 'sealed-house-rules'][0]")" > /dev/null
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
