#!/usr/bin/env python3
# The workforce of a running Xiero Nexus AI, from a file: the models it works
# with, its skills, its agents, its teams and its workflows.
#
#   NEXUS_PASSWORD=... python3 workforce.py --url https://nexus.example.com --dry-run
#
# It signs in as an administrator, says what the app has, compares that with
# the file, and adds what is missing. What is already there is left as it is:
# an agent, a team or a workflow of the same name that differs from the file
# is reported, and changed only with --update. Nothing is ever deleted, so it
# can be run again after the file was changed, or after it stopped halfway.
#
#   --url <address>      Where the app answers (default http://127.0.0.1:3000).
#   --user <name>        The administrator to sign in as (default: the one in
#                        the --env-file, else "admin").
#   --env-file <file>    The app's .env, for the administrator of the first
#                        start: the name (BOOTSTRAP_ADMIN_USERNAME), and the
#                        password (BOOTSTRAP_ADMIN_PASSWORD) when NEXUS_PASSWORD
#                        is not set. That password stops being right once it
#                        is changed in the app.
#   --file <file>        What the workforce should be (default: workforce.json
#                        next to this program). Its format is in README.md.
#   --dry-run            Say what would be done, and do nothing.
#   --yes                Do not ask before doing it.
#   --update             Also change what is there under the same name but
#                        differs from the file.
#   --only <parts>       Only these parts: accounts, providers, models,
#                        skills, agents, teams, workflows (separated by commas).
#   --account <name>     An account the app is to have, with --account-email
#                        and --account-role (owner, admin or user; user when
#                        it is not said). Its password comes in the
#                        environment, as NEXUS_ACCOUNT_PASSWORD, and is needed
#                        for a new account. One that is there under that name
#                        or that email is left as it is; with --update its
#                        role, name and email are made as asked, and its
#                        password when one is given. Needs to sign in as an
#                        owner: only an owner manages accounts.
#   --upload-skill <f>   A skill of your own that is not in the file: a
#                        SKILL.md, or a .skill or .zip of a folder with one.
#                        It is uploaded as on the Skills page, and replaces a
#                        skill of the same name. May be given more than once.
#   --only-usable        Afterwards, look at every model that is switched on
#                        and that the file does not name, and switch off the
#                        ones that cannot be used: a model that a provider
#                        without a key bills for, and a chat model that the
#                        provider refuses one word (no access, no credit, no
#                        such model). A model that is only limited or busy at
#                        the moment stays as it is. Nothing is deleted: a model
#                        is switched on again on the Models page. Each model
#                        that is asked is one request to its provider.
#   --test               Afterwards, ask each chat model of the file for one
#                        word, as the Test button on the Models page does. Each
#                        test is a small request that the provider bills.
#   --test-all           The same, for every chat model that is in the app,
#                        not only those the file names.
#   --test-media         Afterwards, have each image model of the file make one
#                        picture and each speech model say one sentence, join
#                        the first of each into a video where the server has
#                        ffmpeg, and delete what was made. The provider bills
#                        the picture and the sentence.
#   --keep-test-media    Keep what --test-media made in the library.
#   --try-run            Afterwards, one small project ("tryRun" in the file):
#                        its model plans the goal, the agents do the tasks, and
#                        the project is deleted again. With "everyAgent" in the
#                        file, a second project gives each agent of the file
#                        one small task, so that every agent is seen at work
#                        with its own model and tools. It takes minutes, and
#                        each of its requests is one the provider counts.
#   --keep-try-run       Keep what --try-run made on the Projects page.
#   --inventory-only     Say what the app has, and stop. No file is needed.
#
# In the file, a skill can also be one of your own: `"my-skill": {"uploaded":
# true}` names a skill that is uploaded on the Skills page (or with
# --upload-skill) and is not in the file. Agents and teams that name it get
# it when the app has it, and are made without it until then. A skill that
# an agent or a team was given by hand is kept when the file gives it others.
#
# The password is taken from the environment (NEXUS_PASSWORD) or from the
# --env-file, never from the command line, and is not printed. One sign-in is
# tried and no more: a wrong password is not tried again. An account with
# two-step sign-in cannot be used: this program has no code for it. The
# session it signed in with is ended before it exits.
#
# It ends with 0 when all is as the file says (or, with --dry-run, when it
# could be made so), 1 when something failed or stands in the way, 2 when the
# file or an option is wrong, 3 when it could not sign in, 4 when the app
# does not answer.
#
# Needs Python 3.8 or newer and nothing else.
import argparse
import difflib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AGENT = "xiero-nexus-workforce/1"
PARTS = ["accounts", "providers", "models", "skills", "agents", "teams", "workflows"]
ROLES = ["owner", "admin", "user"]
SKILL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024
# A skill of the owner's own that the file names and the app does not have.
MISSING = object()
CAPABILITIES = [
    "text", "reasoning", "tool_calling", "structured_output", "vision", "audio",
    "image_generation", "video_generation", "speech_generation", "embeddings", "streaming",
]
NON_CHAT = ["image_generation", "video_generation", "speech_generation", "embeddings"]
TOOLS = [
    "list_files", "read_file", "write_file", "edit_file", "delete_file",
    "run_command", "fetch_url", "http_request", "web_search",
]
KINDS = ["text", "image", "video", "audio", "render"]
ADAPTERS = ["openai-compatible", "anthropic", "gemini", "custom-http"]
# A gateway lists hundreds of models; the inventory names this many of a kind.
LISTED_AT_MOST = 60
PRICES = ["inputPricePerMTok", "outputPricePerMTok", "pricePerImage", "pricePerSecond", "pricePerMChars"]
MODEL_FIELDS = ["displayName", "contextWindow"] + PRICES
# What the app keeps of a skill (src/lib/skills/limits.ts).
SKILL_NAME_MAX = 80
SKILL_DESCRIPTION_MAX = 1024
SKILL_INSTRUCTIONS_MAX = 100000
SKILL_FILE_MAX_BYTES = 256 * 1024
SKILL_FILES_MAX = 60
SKILL_FILES_TOTAL_MAX = 2 * 1024 * 1024
SKILLS_PER_OWNER_MAX = 20
MEDIA_KEYS = {
    "aspectRatio": str, "durationSeconds": int, "resolution": str, "size": str, "voice": str,
    "speed": (int, float), "imageFrom": int, "subtitles": bool, "keepClipAudio": bool, "fit": str,
}


class Wrong(Exception):
    """The file or an option is wrong."""


class Stop(Exception):
    """Cannot go on. `code` is what the program ends with."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def say(text=""):
    print(text, flush=True)


def head(title):
    say()
    say(title)


def row(label, text):
    say("  %-12s %s" % (label, text))


def more(text, indent=6):
    say(" " * indent + text)


def plural(count, one, many=None):
    return "%d %s" % (count, one if count == 1 else (many or one + "s"))


def short(text, length=200):
    text = " ".join(str(text).split())
    return text if len(text) <= length else text[: length - 1] + "…"


# ── The file ─────────────────────────────────────────────────────────────────


def only_keys(obj, allowed, where):
    if not isinstance(obj, dict):
        raise Wrong("%s is not an object." % where)
    for key in obj:
        if key not in allowed:
            raise Wrong('%s has "%s", which is not one of: %s.' % (where, key, ", ".join(allowed)))


def text_of(value, where, most, least=0):
    if isinstance(value, list) and all(isinstance(line, str) for line in value):
        value = "\n".join(value)
    if not isinstance(value, str):
        raise Wrong("%s is text: a string, or a list of lines." % where)
    value = value.strip()
    if len(value) < least:
        raise Wrong("%s is empty." % where)
    if len(value) > most:
        raise Wrong("%s is %d characters long; the app takes %d." % (where, len(value), most))
    return value


def number_of(value, where, low, high, whole=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Wrong("%s is a number." % where)
    if whole and not isinstance(value, int):
        raise Wrong("%s is a whole number." % where)
    if value < low or value > high:
        raise Wrong("%s is between %s and %s." % (where, low, high))
    return value


def names_of(value, where, known=None, most=50):
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise Wrong("%s is a list of names." % where)
    if len(value) > most:
        raise Wrong("%s has %d entries; the app takes %d." % (where, len(value), most))
    out = []
    for item in value:
        item = item.strip()
        if known is not None and item not in known:
            raise Wrong('%s has "%s", which is not one of: %s.' % (where, item, ", ".join(known)))
        if item not in out:
            out.append(item)
    return out


def split_front_matter(text, where):
    """The front matter of a SKILL.md as written here: `key: value`, one line each."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    rest = text[end + 4:]
    if rest and not rest.startswith("\n"):
        return {}, text
    front = {}
    for line in text[4:end].split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_.-]+):\s*(.*)$", line)
        if not match:
            raise Wrong('%s: this program reads front matter of one line for each key ("name: ...", "description: ..."), and this line is not one: %s' % (where, short(line, 80)))
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1].replace('\\"', '"') if value[0] == '"' else value[1:-1].replace("''", "'")
        front[match.group(1).lower()] = value
    return front, rest[1:]


def text_file(path, where):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as err:
        raise Wrong("%s: %s cannot be read: %s." % (where, path, err.strerror or err))
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Wrong("%s: %s is not text (UTF-8). A skill holds text: an agent reads it." % (where, path))
    if "\x00" in text:
        raise Wrong("%s: %s is not text. A skill holds text: an agent reads it." % (where, path))
    return text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")


def read_skill(name, item, base):
    """A skill of the file: a folder with a SKILL.md, one Markdown file, or the words themselves."""
    where = 'Skill "%s"' % name
    only_keys(item, ["file", "description", "instructions", "uploaded", "about"], where)
    text_of(name, where + ": its name", SKILL_NAME_MAX, 1)
    if "uploaded" in item:
        # Not in the file: one the owner of the app uploads.
        if item["uploaded"] is not True:
            raise Wrong('%s: "uploaded" is true, for a skill that is uploaded on the Skills page and is not in this file.' % where)
        if any(key in item for key in ("file", "description", "instructions")):
            raise Wrong('%s is "uploaded": what it says is in the app, not in this file.' % where)
        return {"name": " ".join(name.split()), "uploaded": True, "about": text_of(item.get("about", ""), where + ": about", 400)}
    if "about" in item:
        raise Wrong('%s: "about" goes with "uploaded".' % where)
    files = []
    if "file" in item:
        if "instructions" in item:
            raise Wrong('%s has "file" and "instructions": one of the two says what the skill is.' % where)
        given = text_of(item["file"], where + ": file", 400, 1)
        target = os.path.normpath(os.path.join(base, given))
        if os.path.isabs(given) or not (target + os.sep).startswith(os.path.normpath(base) + os.sep):
            raise Wrong("%s: file is a path next to the definition file, not one that leaves its folder." % where)
        root = target if os.path.isdir(target) else None
        text = text_file(os.path.join(target, "SKILL.md") if root else target, where)
        front, body = split_front_matter(text, where)
        if front.get("name") and " ".join(front["name"].split()).lower() != " ".join(name.split()).lower():
            raise Wrong('%s: its SKILL.md calls it "%s". The two names are to be the same.' % (where, front["name"]))
        description = item.get("description", front.get("description", ""))
        if root:
            total = 0
            for folder, folders, names in os.walk(root):
                folders[:] = sorted(f for f in folders if not f.startswith(".") and f not in ("__MACOSX", "node_modules"))
                for file_name in sorted(names):
                    full = os.path.join(folder, file_name)
                    relative = os.path.relpath(full, root).replace(os.sep, "/")
                    if file_name.startswith(".") or relative.lower() == "skill.md":
                        continue
                    size = os.path.getsize(full)
                    if size > SKILL_FILE_MAX_BYTES:
                        raise Wrong("%s: %s is larger than %d KB, which is what a file of a skill can be." % (where, relative, SKILL_FILE_MAX_BYTES // 1024))
                    total += size
                    files.append({"path": relative, "content": text_file(full, where)})
            if len(files) > SKILL_FILES_MAX:
                raise Wrong("%s has %d files; a skill keeps %d." % (where, len(files), SKILL_FILES_MAX))
            if total > SKILL_FILES_TOTAL_MAX:
                raise Wrong("%s: its files are more than %d MB together." % (where, SKILL_FILES_TOTAL_MAX // (1024 * 1024)))
    else:
        body = text_of(item.get("instructions", ""), where + ": instructions", SKILL_INSTRUCTIONS_MAX)
        description = item.get("description", "")
    description = " ".join(text_of(description, where + ": description", SKILL_DESCRIPTION_MAX).split())
    body = body.strip()
    if not body and not description:
        raise Wrong("%s is empty: it has no instructions and no description." % where)
    if len(body) > SKILL_INSTRUCTIONS_MAX:
        raise Wrong("%s: its instructions are %d characters; a skill keeps %d. The long parts belong in files of the skill." % (where, len(body), SKILL_INSTRUCTIONS_MAX))
    return {"name": " ".join(name.split()), "description": description, "instructions": body, "files": files}


def read_definition(path):
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as err:
        raise Wrong("%s cannot be read: %s." % (path, err.strerror or err))
    except ValueError as err:
        raise Wrong("%s is not JSON: %s." % (path, err))
    only_keys(raw, ["about", "providers", "models", "skills", "agents", "teams", "workflows", "tryRun"], "The file")
    for key in ("agents", "teams", "workflows"):
        if not isinstance(raw.get(key, []), list):
            raise Wrong('"%s" is a list.' % key)

    providers = {}
    raw_providers = raw.get("providers", {})
    if not isinstance(raw_providers, dict):
        raise Wrong('"providers" is an object: the name or the kind of a provider, and its settings.')
    for name, item in raw_providers.items():
        where = 'Provider "%s"' % name
        only_keys(item, ["timeoutMs", "priority", "adapter", "baseUrl", "authType", "mediaApi", "notes"], where)
        settings = {}
        if "timeoutMs" in item:
            settings["timeoutMs"] = number_of(item["timeoutMs"], where + ": timeoutMs", 1000, 300000, True)
        if "priority" in item:
            settings["priority"] = number_of(item["priority"], where + ": priority", 1, 1000, True)
        describes = None
        if "adapter" in item or "baseUrl" in item:
            # Enough to add the provider when the app does not have it.
            if item.get("adapter") not in ADAPTERS:
                raise Wrong("%s: adapter is one of %s." % (where, ", ".join(ADAPTERS)))
            address = text_of(item.get("baseUrl"), where + ": baseUrl", 500, 1).rstrip("/")
            if not re.match(r"^https?://[^\s/]+", address):
                raise Wrong("%s: baseUrl is an address such as https://api.example.com/v1." % where)
            if item.get("authType", "bearer") not in ("bearer", "header", "none"):
                raise Wrong("%s: authType is bearer, header or none." % where)
            if item.get("mediaApi", "auto") not in ("auto", "openai", "openrouter", "xai"):
                raise Wrong("%s: mediaApi is auto, openai, openrouter or xai." % where)
            describes = {"name": text_of(name, where + ": its name", 80, 1), "adapter": item["adapter"], "baseUrl": address,
                         "authType": item.get("authType", "bearer")}
            if "mediaApi" in item:
                describes["mediaApi"] = item["mediaApi"]
            if item.get("notes"):
                describes["notes"] = text_of(item["notes"], where + ": notes", 1000)
        providers[name] = {"settings": settings, "describes": describes}

    models = {}
    raw_models = raw.get("models", {})
    if not isinstance(raw_models, dict):
        raise Wrong('"models" is an object: a name of your choice for each model.')
    for slot, item in raw_models.items():
        where = 'Model "%s"' % slot
        only_keys(item, ["provider", "model", "capabilities", "enabled"] + MODEL_FIELDS, where)
        if not isinstance(item.get("enabled", True), bool):
            raise Wrong("%s: enabled is true or false." % where)
        model = {
            "slot": slot,
            "enabled": item.get("enabled", True),
            "provider": text_of(item.get("provider"), where + ": provider", 120, 1),
            "model": text_of(item.get("model"), where + ": model", 200, 1),
            "capabilities": names_of(item.get("capabilities", []), where + ": capabilities", CAPABILITIES),
            "fields": {},
        }
        if "displayName" in item:
            model["fields"]["displayName"] = text_of(item["displayName"], where + ": displayName", 120, 1)
        if "contextWindow" in item:
            model["fields"]["contextWindow"] = number_of(item["contextWindow"], where + ": contextWindow", 1, 100000000, True)
        for price in PRICES:
            if price in item:
                model["fields"][price] = number_of(item[price], "%s: %s" % (where, price), 0, 100000)
        models[slot] = model

    off = [slot for slot, model in models.items() if not model["enabled"]]

    def slot_of(value, where, needed):
        if value is None and not needed:
            return None
        if not isinstance(value, str) or value not in models:
            raise Wrong("%s names a model of this file: one of %s." % (where, ", ".join(models) or "(the file has none)"))
        if value in off:
            raise Wrong('%s names the model "%s", which the file switches off.' % (where, value))
        return value

    skills = {}
    raw_skills = raw.get("skills", {})
    if not isinstance(raw_skills, dict):
        raise Wrong('"skills" is an object: the name of each skill, and where its SKILL.md is.')
    base = os.path.dirname(os.path.abspath(path))
    for name, item in raw_skills.items():
        key = " ".join(str(name).split()).lower()
        if key in skills:
            raise Wrong('Skill "%s" is in the file twice (names differ by more than their letters\' case).' % name)
        skills[key] = read_skill(str(name), item, base)

    def skills_of(item, where):
        """The skills an agent or a team is to have. None: the file does not say, and what it has is left alone."""
        if "skills" not in item:
            return None
        named = names_of(item["skills"], where + ": skills", most=SKILLS_PER_OWNER_MAX)
        keys = []
        for one in named:
            key = " ".join(one.split()).lower()
            if key not in skills:
                raise Wrong('%s names the skill "%s", which is not one of the file: %s.' % (where, one, ", ".join(s["name"] for s in skills.values()) or "(the file has none)"))
            if key not in keys:
                keys.append(key)
        return keys

    agents = []
    seen = set()
    for index, item in enumerate(raw.get("agents", [])):
        where = "Agent %d" % (index + 1)
        only_keys(item, ["name", "role", "instructions", "primary", "fallback", "temperature", "tools", "maxSteps", "memory", "skills"], where)
        name = text_of(item.get("name"), where + ": name", 80, 1)
        where = 'Agent "%s"' % name
        if name.lower() in seen:
            raise Wrong("%s is in the file twice." % where)
        seen.add(name.lower())
        agents.append({
            "name": name,
            "role": text_of(item.get("role"), where + ": role", 80, 1),
            "instructions": text_of(item.get("instructions", ""), where + ": instructions", 8000),
            "primary": slot_of(item.get("primary"), where + ": primary", True),
            "fallback": slot_of(item.get("fallback"), where + ": fallback", False),
            "temperature": float(number_of(item.get("temperature", 0.7), where + ": temperature", 0, 2)),
            "tools": names_of(item.get("tools", []), where + ": tools", TOOLS),
            "maxSteps": number_of(item.get("maxSteps", 12), where + ": maxSteps", 1, 40, True),
            "memory": item.get("memory", False),
            "skills": skills_of(item, where),
        })
        if not isinstance(agents[-1]["memory"], bool):
            raise Wrong("%s: memory is true or false." % where)

    teams = []
    seen = set()
    for index, item in enumerate(raw.get("teams", [])):
        where = "Team %d" % (index + 1)
        only_keys(item, ["name", "description", "agents", "skills"], where)
        name = text_of(item.get("name"), where + ": name", 80, 1)
        where = 'Team "%s"' % name
        if name.lower() in seen:
            raise Wrong("%s is in the file twice." % where)
        seen.add(name.lower())
        teams.append({
            "name": name,
            "description": text_of(item.get("description", ""), where + ": description", 500),
            "agents": names_of(item.get("agents", []), where + ": agents"),
            "skills": skills_of(item, where),
        })

    workflows = []
    seen = set()
    for index, item in enumerate(raw.get("workflows", [])):
        where = "Workflow %d" % (index + 1)
        only_keys(item, ["name", "description", "steps"], where)
        name = text_of(item.get("name"), where + ": name", 80, 1)
        where = 'Workflow "%s"' % name
        if name.lower() in seen:
            raise Wrong("%s is in the file twice." % where)
        seen.add(name.lower())
        raw_steps = item.get("steps", [])
        if not isinstance(raw_steps, list) or not raw_steps:
            raise Wrong("%s has no steps." % where)
        if len(raw_steps) > 40:
            raise Wrong("%s has %d steps; the app takes 40." % (where, len(raw_steps)))
        steps = []
        for number, step in enumerate(raw_steps, start=1):
            at = "%s, step %d" % (where, number)
            only_keys(step, ["title", "objective", "acceptanceCriteria", "role", "dependsOn", "outputFile", "kind", "media"], at)
            kind = step.get("kind", "text")
            if kind not in KINDS:
                raise Wrong("%s: kind is one of %s." % (at, ", ".join(KINDS)))
            depends = step.get("dependsOn", [])
            if not isinstance(depends, list) or not all(isinstance(d, int) and not isinstance(d, bool) for d in depends):
                raise Wrong("%s: dependsOn is a list of step numbers." % at)
            for dep in depends:
                if dep < 1 or dep >= number:
                    raise Wrong("%s depends on step %d, which does not come before it." % (at, dep))
            media = step.get("media", {})
            only_keys(media, list(MEDIA_KEYS), at + ": media")
            for key, value in media.items():
                if isinstance(value, bool) != (MEDIA_KEYS[key] is bool) or not isinstance(value, MEDIA_KEYS[key]):
                    raise Wrong("%s: media.%s has the wrong kind of value." % (at, key))
            if kind == "text" and media:
                raise Wrong("%s: a text step has no media options." % at)
            if "imageFrom" in media and (media["imageFrom"] not in depends or steps[media["imageFrom"] - 1]["kind"] != "image"):
                raise Wrong("%s: media.imageFrom names an image step that this step depends on." % at)
            if kind == "render":
                pool = [steps[d - 1] for d in depends] if depends else steps
                if not any(s["kind"] in ("image", "video") for s in pool):
                    raise Wrong("%s joins clips, but no step it depends on makes a video or an image." % at)
            entry = {
                "title": text_of(step.get("title"), at + ": title", 200, 1),
                "objective": text_of(step.get("objective"), at + ": objective", 4000, 1),
                "acceptanceCriteria": text_of(step.get("acceptanceCriteria", ""), at + ": acceptanceCriteria", 2000),
                "role": text_of(step.get("role"), at + ": role", 80, 1),
                "dependsOn": sorted(set(depends)),
                "kind": kind,
                "media": dict(media),
            }
            if step.get("outputFile"):
                entry["outputFile"] = text_of(step["outputFile"], at + ": outputFile", 256, 1)
            steps.append(entry)
        workflows.append({
            "name": name,
            "description": text_of(item.get("description", ""), where + ": description", 500),
            "steps": steps,
        })

    try_run = None
    if "tryRun" in raw:
        item = raw["tryRun"]
        only_keys(item, ["goal", "manager", "team", "maxTasks", "everyAgent"], "tryRun")
        if not isinstance(item.get("everyAgent", False), bool):
            raise Wrong("tryRun: everyAgent is true or false.")
        try_run = {
            "goal": text_of(item.get("goal"), "tryRun: goal", 8000, 1),
            "manager": text_of(item.get("manager"), "tryRun: manager", 80, 1),
            "team": text_of(item.get("team", ""), "tryRun: team", 80),
            "maxTasks": number_of(item.get("maxTasks", 3), "tryRun: maxTasks", 1, 40, True),
            "everyAgent": item.get("everyAgent", False),
        }
        if try_run["manager"] not in models or try_run["manager"] in off:
            raise Wrong('tryRun: manager names a model of this file that is not switched off; "%s" is none.' % try_run["manager"])
        if try_run["team"] and try_run["team"].lower() not in [t["name"].lower() for t in teams]:
            raise Wrong('tryRun: team names a team of this file; "%s" is none.' % try_run["team"])
        # With a team, each agent of that team gets a task; without one, each agent of the file.
        every = len(every_agent_names({"agents": agents, "teams": teams}, try_run["team"]))
        if try_run["everyAgent"] and every > 40:
            raise Wrong("tryRun: everyAgent gives each agent a task, and a project takes 40 tasks; there are %d agents. Name a team in tryRun to try that team." % every)

    return {"providers": providers, "models": models, "skills": skills, "agents": agents, "teams": teams, "workflows": workflows, "tryRun": try_run}


def every_agent_names(definition, team_name):
    """The agents that "everyAgent" gives a task: those of the try-run's team, or all of the file."""
    if team_name:
        for team in definition["teams"]:
            if team["name"].lower() == team_name.lower():
                members = set(m.lower() for m in team["agents"])
                return [a["name"] for a in definition["agents"] if a["name"].lower() in members]
    return [a["name"] for a in definition["agents"]]


def read_env_file(path):
    """The values of a .env file, read the way Node.js reads it."""
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError as err:
        raise Wrong("%s cannot be read: %s." % (path, err.strerror or err))
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key:
            continue
        value = value.strip()
        if value[:1] in ('"', "'", "`") and value.find(value[0], 1) > 0:
            quote = value[0]
            value = value[1 : value.find(quote, 1)]
            if quote == '"':
                value = value.replace("\\n", "\n")
        else:
            value = value.split("#", 1)[0].strip()
        values[key] = value
    return values


# ── The app ──────────────────────────────────────────────────────────────────


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class App:
    """The app's HTTP API, with the session of one sign-in."""

    def __init__(self, url):
        self.url = url.rstrip("/")
        self.cookie = ""
        # No proxy from the environment: the app is usually on this machine.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def call(self, method, path, body=None, timeout=40):
        headers = {"accept": "application/json", "user-agent": AGENT}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        if self.cookie:
            headers["cookie"] = self.cookie
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as err:
            response = err
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise Stop(4, "the app does not answer at %s%s (%s)." % (self.url, path, reason))
        try:
            raw = response.read()
        except (socket.timeout, ConnectionError, OSError) as err:
            raise Stop(4, "the app stopped answering at %s%s (%s)." % (self.url, path, err))
        for line in response.headers.get_all("set-cookie") or []:
            pair = line.split(";", 1)[0].strip()
            if pair.startswith("nexus_session="):
                self.cookie = pair if len(pair) > len("nexus_session=") else ""
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            parsed = None
        return response.getcode(), parsed

    def upload(self, path, name, content, timeout=120):
        """A file as the body of a request, its name in a header, as the pages of the app send one."""
        headers = {"accept": "application/json", "user-agent": AGENT, "content-type": "application/octet-stream",
                   "x-file-name": urllib.parse.quote(name, safe="")}
        if self.cookie:
            headers["cookie"] = self.cookie
        request = urllib.request.Request(self.url + path, data=content, method="POST", headers=headers)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as err:
            response = err
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as err:
            raise Stop(4, "the app does not answer at %s%s (%s)." % (self.url, path, getattr(err, "reason", err)))
        try:
            raw = response.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, socket.timeout, ConnectionError, OSError):
            parsed = None
        return response.getcode(), parsed

    def follow(self, path, body=None, timeout=1800):
        """A request that is answered with what happens, as it happens (server-sent events), to its end."""
        headers = {"accept": "text/event-stream", "user-agent": AGENT, "content-type": "application/json"}
        if self.cookie:
            headers["cookie"] = self.cookie
        request = urllib.request.Request(self.url + path, data=json.dumps(body or {}).encode("utf-8"), method="POST", headers=headers)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as err:
            try:
                return err.code, json.loads(err.read().decode("utf-8")), []
            except (ValueError, OSError):
                return err.code, None, []
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as err:
            raise Stop(4, "the app does not answer at %s%s (%s)." % (self.url, path, getattr(err, "reason", err)))
        events = []
        try:
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("data:"):
                    try:
                        event = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if isinstance(event, dict):
                        events.append(event)
        except (socket.timeout, ConnectionError, OSError):
            pass  # The run goes on in the app whether or not it is followed; how it ended is read from the project.
        return response.getcode(), None, events

    def get(self, path, key):
        status, data = self.call("GET", path)
        if status != 200 or not isinstance(data, dict) or key not in data:
            raise Stop(1, "the app did not answer GET %s as expected (%s%s)." % (path, status, reason_of(data)))
        return data[key]


def reason_of(data):
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and error.get("message"):
            return ": " + short(error["message"], 300)
        if isinstance(error, str) and error:
            return ": " + short(error, 300)
    return ""


def sign_in(app, user, password, source):
    status, data = app.call("POST", "/api/auth/login", {"identifier": user, "password": password})
    if status == 401:
        raise Stop(3, 'the app did not take the password of "%s" from %s. It was tried once and is not tried again.%s' % (
            user, source,
            " The password in .env is the one of the first start; it stops being right when it is changed in the app."
            if source != "NEXUS_PASSWORD" else ""))
    if status == 429:
        raise Stop(3, "the app takes no more sign-ins for now (too many attempts). Try again in ten minutes.")
    if status != 200 or not isinstance(data, dict):
        raise Stop(3, "signing in did not work (%s%s)." % (status, reason_of(data)))
    if data.get("twoFactorRequired"):
        sign_out(app)
        raise Stop(3, '"%s" signs in with a second step (a code from an app). This program has no code and does not ask for one.' % user)
    me = data.get("user") or {}
    if me.get("role") not in ("admin", "owner"):
        sign_out(app)
        raise Stop(3, '"%s" is not an administrator, and only an administrator can change the workforce.' % user)
    return me


def sign_out(app):
    if not app.cookie:
        return
    try:
        app.call("POST", "/api/auth/logout", {}, timeout=15)
    except Stop:
        pass
    app.cookie = ""


class State:
    """What the app has. `read` asks again."""

    def __init__(self, app):
        self.app = app
        self.upstream = {}  # provider id -> what the provider lists, or an error
        self.skill_texts = {}  # (skill id, when it was changed) -> its instructions and files

    def read(self):
        app = self.app
        self.providers = app.get("/api/providers", "providers")
        self.models = app.get("/api/models", "models")
        self.agents = app.get("/api/agents", "agents")
        self.teams = app.get("/api/teams", "teams")
        self.workflows = app.get("/api/workflows", "workflows")
        # Skills came with version 1.7: an app before that answers "not found".
        status, data = app.call("GET", "/api/skills")
        self.skills = data.get("skills") if status == 200 and isinstance(data, dict) and isinstance(data.get("skills"), list) else None
        # The accounts, as an administrator sees them.
        status, data = app.call("GET", "/api/admin/users")
        self.accounts = data.get("users") if status == 200 and isinstance(data, dict) and isinstance(data.get("users"), list) else None
        return self

    def skill_text(self, skill, with_files):
        """The words of a skill that is in the app: its instructions, and its files when asked."""
        key = (skill["id"], skill.get("updatedAt"), with_files)
        if key not in self.skill_texts:
            status, data = self.app.call("GET", "/api/skills/%s" % skill["id"])
            detail = data.get("skill") if status == 200 and isinstance(data, dict) else None
            files = {}
            if with_files:
                for item in (detail or {}).get("files") or []:
                    status, got = self.app.call("GET", "/api/skills/%s/files?path=%s" % (skill["id"], urllib.parse.quote(item["path"], safe="")))
                    files[item["path"]] = got.get("content") if status == 200 and isinstance(got, dict) else None
            self.skill_texts[key] = {"instructions": (detail or {}).get("instructions"), "files": files}
        return self.skill_texts[key]

    def read_server(self):
        status, tools = self.app.call("GET", "/api/agents/tools")
        self.tools = tools if status == 200 and isinstance(tools, dict) else None
        status, media = self.app.call("GET", "/api/media/capabilities")
        self.render = (media or {}).get("render") if status == 200 and isinstance(media, dict) else None
        return self

    def tool_works(self, name):
        if not self.tools:
            return True  # an older app: it has no tools, and says so itself
        for tool in self.tools.get("tools", []):
            if tool.get("name") == name:
                return bool(tool.get("available"))
        return False

    def listed(self, provider):
        """What the provider itself lists: {"models": [...], "suggested": {...}} or {"error": "..."}."""
        if provider["id"] not in self.upstream:
            status, data = self.app.call("POST", "/api/providers/%s/models/discover" % provider["id"], {}, timeout=90)
            if status == 200 and isinstance(data, dict) and data.get("ok"):
                self.upstream[provider["id"]] = {
                    "models": data.get("models") or [], "suggested": data.get("suggested") or {},
                    # From version 1.7: whether the provider's list says what its models cost.
                    "pricesListed": data.get("pricesListed"),
                }
            else:
                self.upstream[provider["id"]] = {"error": (reason_of(data)[2:] or "the app answered %s" % status)}
        return self.upstream[provider["id"]]

    def models_of(self, provider):
        return [m for m in self.models if m.get("providerId") == provider["id"]]


def caps_of(model):
    return [c.get("capability") for c in model.get("capabilities") or []]


def kind_of(capabilities):
    for capability, kind in (("text", "chat"), ("video_generation", "video"), ("image_generation", "image"),
                             ("speech_generation", "speech"), ("embeddings", "embedding"), ("audio", "transcription")):
        if capability in capabilities:
            return kind
    return "chat"


def is_media_only(capabilities):
    return "text" not in capabilities and any(c in capabilities for c in NON_CHAT)


def label_of(model):
    return model.get("displayName") or model.get("modelId") or "?"


def price_text(model):
    parts = []
    if model.get("inputPricePerMTok") is not None or model.get("outputPricePerMTok") is not None:
        parts.append("%s in / %s out per million tokens" % (
            "?" if model.get("inputPricePerMTok") is None else "%g" % model["inputPricePerMTok"],
            "?" if model.get("outputPricePerMTok") is None else "%g" % model["outputPricePerMTok"]))
    for key, unit in (("pricePerImage", "an image"), ("pricePerSecond", "a second"), ("pricePerMChars", "per million characters")):
        if model.get(key) is not None:
            parts.append("%g %s" % (model[key], unit))
    return ", ".join(parts) if parts else "no price set"


def tested_text(item):
    status = item.get("lastTestStatus")
    if status == "ok":
        return "last test ok"
    if status == "error":
        return "last test failed: " + short(item.get("lastTestError") or "no reason kept", 160)
    return "never tested"


def show_inventory(state, me):
    head("The app")
    row("Address", state.app.url)
    row("Signed in", '"%s", %s%s' % (
        me.get("username", "?"), "an owner" if me.get("role") == "owner" else "an administrator",
        "" if not me.get("twoFactorEnabled") else ", with two-step sign-in"))
    if state.accounts is not None:
        by_role = []
        for role in ROLES:
            names = sorted(a.get("username", "?") + ("" if a.get("status") == "active" else " (switched off)")
                           for a in state.accounts if a.get("role") == role)
            if names:
                by_role.append("%s: %s" % (plural(len(names), {"owner": "owner", "admin": "administrator", "user": "user"}[role]),
                                           ", ".join(names[:12]) + (", and %d more" % (len(names) - 12) if len(names) > 12 else "")))
        row("Accounts", "; ".join(by_role) or "none")
    if state.tools:
        row("Agent tools", "run_command %s; web_search %s%s" % (
            "works (a sandbox runner is set up)" if state.tools.get("sandbox") else "does not work: no sandbox runner is set up (SANDBOX_URL)",
            "works (%s)" % state.tools["search"] if state.tools.get("search") else "does not work: no search service is set up (SEARCH_PROVIDER)",
            "; agents reach only the hosts the administrator listed" if state.tools.get("hostsRestricted") else ""))
    else:
        row("Agent tools", "this version of the app does not say which tools work")
    if state.render:
        row("Joining", "clips can be joined into one video (ffmpeg %s)%s" % (
            state.render.get("ffmpegVersion") or "of an unknown version",
            "" if state.render.get("subtitles") else ", without subtitles") if state.render.get("available")
            else "clips cannot be joined into one video: no usable ffmpeg on the server")

    head("Providers and models")
    if not state.providers:
        row("Providers", "none. Add one on the Providers page, with its API key.")
    for provider in state.providers:
        credential = provider.get("credential")
        stored = credential.get("configured") if isinstance(credential, dict) else bool(credential)
        key = "takes no key" if provider.get("authType") == "none" else "a key is stored" if stored else "no key is stored"
        say("  %s (%s), %s" % (provider.get("name"), provider.get("adapter"), provider.get("baseUrl")))
        more("%s; %s; %s%s" % (provider.get("status"), key, tested_text(provider),
                               "; waits up to %g s for an answer" % (provider["timeoutMs"] / 1000.0) if provider.get("timeoutMs") else ""))
        rows = sorted(state.models_of(provider), key=lambda m: m.get("modelId", ""))
        shown_rows = rows
        if len(rows) > LISTED_AT_MOST:
            # A gateway's whole list was taken in: what was used or set first.
            used = [m for m in rows if m.get("lastTestedAt") or not m.get("enabled", True) or any(m.get(p) is not None for p in PRICES)]
            shown_rows = (used + [m for m in rows if m not in used])[:LISTED_AT_MOST]
        width = max([len(m.get("modelId", "")) for m in shown_rows] + [10])
        for model in shown_rows:
            caps = model.get("capabilities") or []
            shown = " ".join(c.get("capability", "?") + ("*" if c.get("verified") else "") for c in caps) or "(no capability set)"
            more("%-*s  %-9s %s" % (width, model.get("modelId"), kind_of(caps_of(model)), shown))
            more("%s%s; %s; %s%s" % (
                "" if not model.get("displayName") else '"%s"; ' % model["displayName"],
                "context %s" % ("{:,}".format(model["contextWindow"]) if model.get("contextWindow") else "not set"),
                price_text(model), tested_text(model),
                "" if model.get("enabled", True) else "; SWITCHED OFF"), indent=10)
        if len(rows) > len(shown_rows):
            more("... and %d more models of this provider are in the app: those that were tried or have a price are the ones shown." % (len(rows) - len(shown_rows)))
        if not rows:
            more("No model of this provider is in the app.")
        listing = state.listed(provider)
        if "error" in listing:
            more("Its own list of models could not be read: %s" % short(listing["error"], 300))
        else:
            have = set(m.get("modelId") for m in rows)
            rest = [name for name in listing["models"] if name not in have]
            more("The provider lists %s; %s." % (plural(len(listing["models"]), "model"),
                 "all of them are in the app" if not rest else "%d %s not in the app" % (len(rest), "is" if len(rest) == 1 else "are")))
            groups = {}
            for name in rest:
                groups.setdefault((listing["suggested"].get(name) or {}).get("type", "chat"), []).append(name)
            for kind in sorted(groups):
                names = groups[kind]
                if len(names) > LISTED_AT_MOST:
                    # Of a long list, what costs nothing is what is looked for most.
                    names = [n for n in names if "free" in n.lower()] + [n for n in names if "free" not in n.lower()]
                more("not in the app, %s: %s%s" % (kind, ", ".join(names[:LISTED_AT_MOST]),
                     "" if len(names) <= LISTED_AT_MOST else ", and %d more" % (len(names) - LISTED_AT_MOST)), indent=10)
    if state.models:
        more("(* after a capability: a request has shown that the model has it.)")

    by_id = dict((m["id"], m) for m in state.models)

    def model_name(row_id):
        if not row_id:
            return "none"
        model = by_id.get(row_id)
        return label_of(model) if model else "a model that is gone"

    skill_names = dict((s["id"], s.get("name")) for s in state.skills or [])
    head("Agents (%d)" % len(state.agents))
    for agent in state.agents:
        say("  %s (%s)%s" % (agent.get("name"), agent.get("role"), "" if agent.get("status") == "active" else ", SWITCHED OFF"))
        more("model %s, then %s%s; temperature %g" % (
            model_name(agent.get("primaryModelRowId")), model_name(agent.get("fallbackModelRowId")),
            "; the cheapest fitting model first" if agent.get("routingMode") == "auto" else "", agent.get("temperature", 0.7)))
        more("tools: %s; at most %s steps; %s; %s of instructions" % (
            ", ".join(agent.get("tools") or []) or "none", agent.get("maxSteps", "?"),
            "keeps notes" if agent.get("memoryEnabled") else "keeps no notes",
            plural(len(agent.get("instructions") or ""), "character")))
        if agent.get("skillIds"):
            more("skills: %s" % ", ".join(skill_names.get(i, "a skill that is gone") for i in agent["skillIds"]))
    agent_names = dict((a["id"], a.get("name")) for a in state.agents)
    head("Teams (%d)" % len(state.teams))
    for team in state.teams:
        say("  %s: %s" % (team.get("name"), ", ".join(agent_names.get(i, "an agent that is gone") for i in team.get("agentIds") or []) or "no agents"))
        if team.get("skillIds"):
            more("skills of the team: %s" % ", ".join(skill_names.get(i, "a skill that is gone") for i in team["skillIds"]))
    if state.skills is None:
        head("Skills")
        say("  This app has no skills: they came with version 1.7.")
    else:
        head("Skills (%d)" % len(state.skills))
        for skill in state.skills:
            users = len(skill.get("agentIds") or []) + len(skill.get("teamIds") or [])
            say("  %s%s: %s of instructions, %s; %s" % (
                skill.get("name"), "" if skill.get("enabled", True) else ", SWITCHED OFF",
                plural(skill.get("instructionChars") or 0, "character"), plural(len(skill.get("files") or []), "file"),
                "given to %d" % users if users else "given to no one"))
    head("Workflows (%d)" % len(state.workflows))
    for workflow in state.workflows:
        steps = workflow.get("steps") or []
        kinds = {}
        for step in steps:
            kinds[step.get("kind") or "text"] = kinds.get(step.get("kind") or "text", 0) + 1
        say("  %s: %s (%s)" % (workflow.get("name"), plural(len(steps), "step"), ", ".join("%d %s" % (kinds[k], k) for k in KINDS if k in kinds) or "empty"))


# ── What the file asks for ───────────────────────────────────────────────────


class Change:
    def __init__(self, part, text, do=None):
        self.part = part
        self.text = text
        self.do = do  # None: said only; another change does it


class Plan:
    def __init__(self):
        self.changes = []
        self.same = []  # what is already as the file says
        self.notes = []  # worth knowing, not in the way
        self.problems = []  # in the way: nothing is done while there is one

    def todo(self, parts):
        return [c for c in self.changes if c.do and c.part in parts]

    def left_out(self, parts):
        return [c for c in self.changes if c.do and c.part not in parts]


def one_named(items, name, key="name"):
    return [item for item in items if str(item.get(key, "")).strip().lower() == name.lower()]


def find_provider(state, wanted):
    found = one_named(state.providers, wanted) or one_named(state.providers, wanted, "adapter")
    if len(found) == 1:
        return found[0], None
    if not found:
        return None, 'there is no provider "%s" in the app (by name, or by kind: %s).' % (
            wanted, ", ".join(sorted(set("%s = %s" % (p.get("name"), p.get("adapter")) for p in state.providers))) or "it has none")
    return None, '"%s" fits %d providers (%s). Use the name of one.' % (wanted, len(found), ", ".join(p.get("name", "?") for p in found))


def api(app, method, path, body, timeout=60):
    status, data = app.call(method, path, body, timeout=timeout)
    if status not in (200, 201) or not isinstance(data, dict):
        raise Stop(1, "the app refused it (%s%s)." % (status, reason_of(data)))
    return data


def keyless(definition, name):
    """What the file says of a provider that this program can add: one that takes no key."""
    described = (definition["providers"].get(name) or {}).get("describes")
    return described if described and described["authType"] == "none" else None


def plan_accounts(state, options, plan, me):
    """The account that was asked for with --account: made, or with --update made as asked."""
    wanted = options.account
    if not wanted:
        return
    where = 'Account "%s"' % wanted["username"]
    password = os.environ.get("NEXUS_ACCOUNT_PASSWORD", "")
    if state.accounts is None:
        plan.problems.append("%s: this app does not show its accounts to \"%s\"." % (where, me.get("username", "?")))
        return
    if me.get("role") != "owner":
        plan.problems.append(
            '%s: "%s" is %s of the app, and only an owner manages accounts. From version 1.7 the first administrator '
            'of an app is its owner: upgrade the app, or sign in as an owner (--user).' % (
                where, me.get("username", "?"), "an administrator" if me.get("role") == "admin" else "no owner"))
        return
    by_name = [a for a in state.accounts if a.get("username") == wanted["username"]]
    by_email = [a for a in state.accounts if (a.get("email") or "").lower() == wanted["email"]]
    if by_name and by_email and by_name[0].get("id") != by_email[0].get("id"):
        plan.problems.append('%s: the app has that name on one account and %s on another ("%s"). Which of the two is meant is not clear.' % (
            where, wanted["email"], by_email[0].get("username")))
        return
    found = (by_name or by_email or [None])[0]
    if found is None:
        if len(password) < 10:
            plan.problems.append("%s is new and needs its first password: NEXUS_ACCOUNT_PASSWORD in the environment, at least 10 characters." % where)
            return

        def create():
            api(state.app, "POST", "/api/admin/users", {
                "username": wanted["username"], "email": wanted["email"], "role": wanted["role"], "password": password})

        plan.changes.append(Change("accounts", "%s <%s>: add it, as %s." % (where, wanted["email"], role_word(wanted["role"])), create))
        return
    differs = [key for key in ("username", "email", "role") if (found.get(key) or "") != wanted[key]]
    if found.get("status") != "active":
        plan.notes.append("%s is switched off in the app. That is left as it is." % where)
    sets_password = bool(password) and options.update
    if not differs and not sets_password:
        plan.same.append('account "%s" (%s)' % (wanted["username"], role_word(found.get("role"))))
        if password:
            plan.notes.append("%s is in the app: its password is left as it is; --update sets the one that was given." % where)
        return
    if found.get("id") == me.get("id"):
        plan.problems.append("%s is the account this signs in as. It changes its own name, email and password under Settings, and nobody changes their own role." % where)
        return
    if not options.update:
        plan.notes.append("%s is in the app and differs from what was asked (%s). It is left as it is; --update changes it%s." % (
            where, ", ".join(differs), ", and sets the password that was given" if password else ""))
        return
    if sets_password and len(password) < 10:
        plan.problems.append("%s: NEXUS_ACCOUNT_PASSWORD is shorter than 10 characters." % where)
        return

    def update(found=found):
        body = dict((key, wanted[key]) for key in differs)
        if sets_password:
            body["password"] = password
        api(state.app, "PATCH", "/api/admin/users/%s" % found["id"], body)

    what = differs + (["password"] if sets_password else [])
    plan.changes.append(Change("accounts", "%s: change it to what was asked (%s)%s." % (
        where, ", ".join(what), "; it is signed out everywhere" if sets_password else ""), update))


def role_word(role):
    return {"owner": "an owner", "admin": "an administrator", "user": "a user"}.get(role, "a user")


# Skill files that this run has uploaded already: asked for once, done once.
UPLOADED = set()


def plan_uploads(state, options, plan):
    """The skill files that were named with --upload-skill: each is uploaded as on the Skills page."""
    for given in options.upload_skill:
        full = os.path.abspath(given)
        if full in UPLOADED:
            continue
        name = os.path.basename(full)
        try:
            size = os.path.getsize(full)
        except OSError as err:
            raise Wrong("--upload-skill: %s cannot be read: %s." % (given, err.strerror or err))
        if size == 0:
            raise Wrong("--upload-skill: %s is empty." % given)
        if size > SKILL_UPLOAD_MAX_BYTES:
            raise Wrong("--upload-skill: %s is larger than %d MB, which is what a skill can be." % (given, SKILL_UPLOAD_MAX_BYTES // (1024 * 1024)))
        if state.skills is None:
            plan.problems.append('Skill file "%s": this app has no skills: they came with version 1.7. Upgrade the app first.' % name)
            continue

        def upload(full=full, name=name):
            with open(full, "rb") as handle:
                content = handle.read()
            status, data = state.app.upload("/api/skills/upload?onConflict=replace", name, content)
            if status not in (200, 201) or not isinstance(data, dict):
                raise Stop(1, "the app refused it (%s%s)." % (status, reason_of(data)))
            UPLOADED.add(full)
            for skill in data.get("skills") or []:
                more('%s "%s": %s of instructions%s.' % (
                    "replaced" if skill.get("replaced") else "added", skill.get("name"),
                    plural(skill.get("instructionChars") or 0, "character"),
                    ", %s" % plural(len(skill.get("files") or []), "file") if skill.get("files") else ""), indent=10)
            if data.get("leftOut"):
                more("left out of it: %s" % short(", ".join(str(item.get("path") if isinstance(item, dict) else item) for item in data["leftOut"]), 300), indent=10)

        plan.changes.append(Change("skills", 'Skill file "%s" (%s): upload it; a skill of the same name is replaced.' % (name, plural(size, "byte")), upload))


def plan_providers(state, definition, options, plan):
    """A provider that takes no key is added. One that is there is changed with --update only."""
    for name, wanted in definition["providers"].items():
        provider, problem = find_provider(state, name)
        described = wanted["describes"]
        if not provider:
            if not described:
                plan.problems.append('Provider "%s": %s' % (name, problem))
            elif described["authType"] != "none":
                plan.notes.append('Provider "%s" is not in the app and takes a key, which this program does not have: add it on the Providers page (%s, %s).' % (
                    name, described["adapter"], described["baseUrl"]))
            else:
                body = dict(described, **wanted["settings"])

                def add(body=body):
                    api(state.app, "POST", "/api/providers", body)

                plan.changes.append(Change("providers", 'Provider "%s": add it (%s, %s, no key).' % (name, described["adapter"], described["baseUrl"]), add))
            continue
        label = 'provider "%s"' % provider.get("name")
        if described and (provider.get("baseUrl") or "").rstrip("/") != described["baseUrl"]:
            plan.notes.append('%s%s has the address %s in the app and %s in the file. Left as it is.' % (
                label[0].upper(), label[1:], provider.get("baseUrl"), described["baseUrl"]))
        patch = dict((key, value) for key, value in wanted["settings"].items() if provider.get(key) != value)
        if not patch:
            plan.same.append(label)
            continue
        said = []
        if "timeoutMs" in patch:
            said.append("wait up to %g s for an answer instead of %s" % (
                patch["timeoutMs"] / 1000.0, "%g s" % (provider["timeoutMs"] / 1000.0) if provider.get("timeoutMs") else "an unknown time"))
        if "priority" in patch:
            said.append("priority %s instead of %s" % (patch["priority"], provider.get("priority")))
        if not options.update:
            plan.notes.append("%s%s differs from the file (the file says: %s). It is left as it is; --update changes it." % (
                label[0].upper(), label[1:], "; ".join(said)))
            continue

        def do(provider=provider, patch=patch):
            api(state.app, "PATCH", "/api/providers/%s" % provider["id"], patch)

        plan.changes.append(Change("providers", "%s%s: %s." % (label[0].upper(), label[1:], "; ".join(said)), do))


def plan_models(state, definition, options, plan):
    """Returns for each model of the file: the app's model, or what it will be once it is imported."""
    slots = {}
    imports = {}
    for slot, wanted in definition["models"].items():
        provider, problem = find_provider(state, wanted["provider"])
        if not wanted["enabled"]:
            rows = [m for m in state.models_of(provider) if m.get("modelId") == wanted["model"]] if provider else []
            if rows and rows[0].get("enabled", True):
                def switch_off(model=rows[0]):
                    api(state.app, "PATCH", "/api/models/%s" % model["id"], {"enabled": False})

                plan.changes.append(Change("models", 'Model "%s" (%s of %s): switch it off.' % (slot, wanted["model"], provider.get("name")), switch_off))
            else:
                plan.same.append('model "%s" (%s, %s)' % (slot, wanted["model"], "switched off" if rows else "not in the app"))
            continue
        if not provider and keyless(definition, wanted["provider"]):
            # Its provider is added first; what the provider lists is known after that.
            slots[slot] = {"id": None, "capabilities": list(wanted["capabilities"]) or ["text"], "label": wanted["model"], "provider": None}
            plan.changes.append(Change("models", 'Model "%s": take %s of %s into the app, once that provider is added.' % (
                slot, wanted["model"], wanted["provider"]), None))
            continue
        if not provider:
            plan.problems.append('Model "%s": %s' % (slot, problem))
            continue
        rows = [m for m in state.models_of(provider) if m.get("modelId") == wanted["model"]]
        name = "%s of %s" % (wanted["model"], provider.get("name"))
        if rows:
            model = rows[0]
            capabilities = caps_of(model)
            slots[slot] = {"id": model["id"], "capabilities": capabilities, "label": label_of(model), "provider": provider}
            if not model.get("enabled", True):
                plan.problems.append('Model "%s" (%s) is switched off on the Models page. Switch it on, or name another model.' % (slot, name))
            missing = [c for c in wanted["capabilities"] if c not in capabilities]
            patch = {}
            for field, value in wanted["fields"].items():
                if model.get(field) is None or (options.update and model.get(field) != value):
                    patch[field] = value
                elif model.get(field) != value:
                    plan.notes.append('Model "%s" (%s) has %s %s in the app and %s in the file. Left as it is.' % (slot, name, field, model.get(field), value))
            if missing:
                patch["capabilities"] = capabilities + missing
                slots[slot]["capabilities"] = patch["capabilities"]
            if patch:
                said = []
                if missing:
                    said.append("mark it for " + ", ".join(missing))
                said += ["set %s to %s" % (f, v) for f, v in patch.items() if f != "capabilities"]

                def do(model=model, patch=patch):
                    api(state.app, "PATCH", "/api/models/%s" % model["id"], patch)

                plan.changes.append(Change("models", 'Model "%s" (%s): %s.' % (slot, name, "; ".join(said)), do))
            else:
                plan.same.append('model "%s" (%s)' % (slot, name))
            continue
        listing = state.listed(provider)
        if "error" in listing:
            plan.problems.append('Model "%s": %s is not in the app, and the provider\'s list could not be read (%s).' % (slot, name, short(listing["error"], 200)))
            continue
        if wanted["model"] not in listing["models"]:
            close = difflib.get_close_matches(wanted["model"], listing["models"], n=4, cutoff=0.5)
            plan.problems.append('Model "%s": %s does not list a model "%s".%s' % (
                slot, provider.get("name"), wanted["model"], " It lists: %s." % ", ".join(close) if close else ""))
            continue
        # A model this program takes in gets the capabilities of the file,
        # and what the app makes of the provider's list where the file has none.
        suggested = list((listing["suggested"].get(wanted["model"]) or {}).get("capabilities") or [])
        exact = bool(wanted["capabilities"]) and set(wanted["capabilities"]) != set(suggested)
        capabilities = list(wanted["capabilities"]) if exact else suggested
        slots[slot] = {"id": None, "capabilities": capabilities, "label": wanted["model"], "provider": provider}
        imports.setdefault(provider["id"], (provider, []))[1].append(wanted["model"])
        then = (["mark it for %s, not for %s as the app would by itself" % (", ".join(capabilities), ", ".join(suggested) or "nothing")] if exact else [])
        then += ["set %s to %s" % (f, v) for f, v in wanted["fields"].items()]
        kind = kind_of(capabilities)
        plan.changes.append(Change("models", 'Model "%s": take %s into the app as %s %s model%s.' % (
            slot, name, "an" if kind[0] in "aeiou" else "a", kind, "; " + "; ".join(then) if then else ""), None))

    for provider, wanted in imports.values():
        def do(provider=provider, wanted=wanted):
            data = api(state.app, "POST", "/api/providers/%s/models/discover" % provider["id"], {"import": wanted}, timeout=90)
            if not data.get("ok"):
                raise Stop(1, "the provider's list could not be read%s." % reason_of(data))
            state.read()
            # What the list did not say about them comes from the file.
            for slot, item in definition["models"].items():
                if item["model"] not in wanted or (find_provider(state, item["provider"])[0] or {}).get("id") != provider["id"]:
                    continue
                rows = [m for m in state.models_of(provider) if m.get("modelId") == item["model"]]
                if not rows:
                    raise Stop(1, 'the app did not take "%s" in.' % item["model"])
                patch = dict(item["fields"])
                if item["capabilities"] and set(item["capabilities"]) != set(caps_of(rows[0])):
                    patch["capabilities"] = list(item["capabilities"])
                if patch:
                    api(state.app, "PATCH", "/api/models/%s" % rows[0]["id"], patch)

        plan.changes.append(Change("models", "Take %s of %s into the app: %s." % (
            plural(len(wanted), "model"), provider.get("name"), ", ".join(wanted)), do))
    return slots


def plan_skills(state, definition, options, plan):
    """
    Returns the IDs of the file's skills by their names in lower case (None for
    one that is still to be added), or None when the app has no skills at all.
    """
    wanted_all = definition["skills"]
    if state.skills is None:
        if wanted_all:
            said = "The file has %s, and this app has no skills: they came with version 1.7. Upgrade the app first." % plural(len(wanted_all), "skill")
            # Providers and models can still be made as the file says.
            if any(part in options.parts for part in ("skills", "agents", "teams")):
                plan.problems.append(said)
            else:
                plan.notes.append(said)
        return None
    ids = {}
    for key, wanted in wanted_all.items():
        where = 'Skill "%s"' % wanted["name"]
        found = [s for s in state.skills if " ".join((s.get("name") or "").split()).lower() == key]
        if wanted.get("uploaded"):
            # One of the owner's own: in the app or not, never made from this file.
            if found:
                ids[key] = found[0]["id"]
                plan.same.append('skill "%s" (uploaded)' % wanted["name"])
                if not found[0].get("enabled", True):
                    plan.notes.append("%s is switched off on the Skills page: no agent is given it. That is left as it is." % where)
            else:
                ids[key] = MISSING
                users = [a["name"] for a in definition["agents"] if key in (a["skills"] or [])] + \
                        ['team "%s"' % t["name"] for t in definition["teams"] if key in (t["skills"] or [])]
                plan.notes.append('%s is one of your own, and it is not in the app%s. Upload it on the Skills page (or with --upload-skill) and run this again: %s.' % (
                    where, " (%s)" % wanted["about"] if wanted.get("about") else "",
                    "%s %s made without it until then" % (", ".join(users), "is" if len(users) == 1 else "are") if users else "nothing of the file names it"))
            continue
        size = "%s of instructions%s" % (
            plural(len(wanted["instructions"]), "character"),
            ", %s" % plural(len(wanted["files"]), "file") if wanted["files"] else "")

        def save(wanted=wanted):
            api(state.app, "POST", "/api/skills", {
                "name": wanted["name"], "description": wanted["description"], "instructions": wanted["instructions"],
                "files": wanted["files"], "onConflict": "replace",
            })

        if not found:
            ids[key] = None
            plan.changes.append(Change("skills", "%s: add it (%s)." % (where, size), save))
            continue
        skill = found[0]
        ids[key] = skill["id"]
        differs = []
        if (skill.get("description") or "") != wanted["description"]:
            differs.append("description")
        have_files = sorted((f.get("path"), f.get("sizeBytes")) for f in skill.get("files") or [])
        want_files = sorted((f["path"], len(f["content"].encode("utf-8"))) for f in wanted["files"])
        same_list = have_files == want_files
        text = state.skill_text(skill, with_files=same_list and bool(want_files))
        if text["instructions"] != wanted["instructions"]:
            differs.append("instructions")
        if not same_list or any(text["files"].get(f["path"]) != f["content"] for f in wanted["files"]):
            differs.append("files")
        if not skill.get("enabled", True):
            plan.notes.append("%s is switched off on the Skills page: no agent is given it. That is left as it is." % where)
        if not differs:
            plan.same.append('skill "%s"' % wanted["name"])
        elif options.update:
            plan.changes.append(Change("skills", "%s: change it to what the file says (%s)." % (where, ", ".join(differs)), save))
        else:
            plan.notes.append("%s is in the app and differs from the file (%s). It is left as it is; --update changes it." % (where, ", ".join(differs)))
    return ids


def skill_ids_of(wanted, skill_ids, have=None):
    """
    The IDs of the skills an agent or a team of the file is to have; None in it
    for one that is still to be added. A skill of the owner's own that the app
    does not have is left out, and the skills it was given by hand (`have`)
    are kept after those of the file.
    """
    ids = [skill_ids.get(key) for key in wanted["skills"] if skill_ids.get(key) is not MISSING]
    return ids + [one for one in have or [] if one not in ids]


def plan_agents(state, definition, options, plan, slots, skill_ids):
    """Returns the names of the agents that are or will be there."""
    names = set(a.get("name", "").strip().lower() for a in state.agents)
    left = {}
    for wanted in definition["agents"]:
        where = 'Agent "%s"' % wanted["name"]
        stopped = False
        for which in ("primary", "fallback"):
            slot = wanted[which]
            if slot is None:
                continue
            if slot not in slots:
                stopped = True  # the model's own problem is already listed
            elif is_media_only(slots[slot]["capabilities"]):
                plan.problems.append('%s: its %s model "%s" is a %s model. An agent needs a chat model.' % (
                    where, which, slot, kind_of(slots[slot]["capabilities"])))
                stopped = True
        if stopped:
            continue
        tools = [t for t in wanted["tools"] if state.tool_works(t)]
        for tool in wanted["tools"]:
            if tool not in tools:
                left.setdefault(tool, []).append(wanted["name"])

        def body(wanted=wanted, tools=tools, have=None):
            made = {
                "name": wanted["name"], "role": wanted["role"], "instructions": wanted["instructions"],
                "primaryModelRowId": slots[wanted["primary"]]["id"],
                "fallbackModelRowId": slots[wanted["fallback"]]["id"] if wanted["fallback"] else None,
                "routingMode": "manual", "temperature": wanted["temperature"], "tools": tools,
                "maxSteps": wanted["maxSteps"], "memoryEnabled": wanted["memory"],
            }
            # Skills are said only where the file says them: an agent whose
            # skills the file does not name keeps what it was given by hand.
            if wanted["skills"] is not None and skill_ids is not None:
                made["skillIds"] = skill_ids_of(wanted, skill_ids, have)
            return made

        found = one_named(state.agents, wanted["name"])
        models = "%s%s" % (slots[wanted["primary"]]["label"], ", then %s" % slots[wanted["fallback"]]["label"] if wanted["fallback"] else "")
        if not found:
            def create(body=body):
                api(state.app, "POST", "/api/agents", body())

            names.add(wanted["name"].lower())
            plan.changes.append(Change("agents", '%s (%s): add it, on %s%s%s.' % (
                where, wanted["role"], models, "; tools: " + ", ".join(tools) if tools else "",
                "; skills: " + ", ".join(definition["skills"][k]["name"] for k in wanted["skills"] if skill_ids is None or skill_ids.get(k) is not MISSING)
                if wanted["skills"] and (skill_ids is None or any(skill_ids.get(k) is not MISSING for k in wanted["skills"])) else ""), create))
            continue
        if len(found) > 1:
            plan.notes.append("%s: the app has %d agents of this name. They are left as they are." % (where, len(found)))
            continue
        agent = found[0]
        now = body(have=agent.get("skillIds"))
        differs = []
        for key, value in now.items():
            if key == "name":
                continue
            have = agent.get(key)
            if key == "tools":
                same = sorted(have or []) == sorted(value)
            elif key == "skillIds":
                same = None not in value and sorted(have or []) == sorted(value)  # None: a skill that is still to be added
            elif key == "temperature":
                same = have is not None and abs(float(have) - value) < 1e-9
            elif key == "primaryModelRowId":
                same = value is not None and have == value  # None: the model is still to be taken in
            elif key == "fallbackModelRowId":
                same = have == value and (value is not None or not wanted["fallback"])
            else:
                same = have == value
            if not same:
                differs.append(key)
        if agent.get("status") != "active":
            plan.notes.append("%s is switched off in the app. That is left as it is." % where)
        if not differs:
            plan.same.append('agent "%s"' % wanted["name"])
        elif options.update:
            def update(agent=agent, body=body):
                api(state.app, "PATCH", "/api/agents/%s" % agent["id"], body(have=agent.get("skillIds")))

            plan.changes.append(Change("agents", "%s: change it to what the file says (%s)." % (where, ", ".join(shown(differs))), update))
        else:
            plan.notes.append("%s is in the app and differs from the file (%s). It is left as it is; --update changes it." % (where, ", ".join(shown(differs))))
    for tool, who in left.items():
        need = "a sandbox runner (SANDBOX_URL)" if tool == "run_command" else "a search service (SEARCH_PROVIDER)" if tool == "web_search" else "something this server lacks"
        plan.notes.append("%s needs %s, which this server does not have: left out for %s." % (tool, need, ", ".join(who)))
    return names


def shown(differs):
    """What differs, in the words of the file rather than of the app's API."""
    return ["skills" if key == "skillIds" else key for key in differs]


def plan_teams(state, definition, options, plan, agent_names, skill_ids):
    for wanted in definition["teams"]:
        where = 'Team "%s"' % wanted["name"]
        stopped = False
        for member in wanted["agents"]:
            found = one_named(state.agents, member)
            if len(found) > 1:
                plan.problems.append('%s: the app has %d agents named "%s", so it is not clear which one is meant.' % (where, len(found), member))
                stopped = True
            elif not found and member.lower() not in agent_names:
                plan.problems.append('%s: there is no agent "%s", in the app or in the file.' % (where, member))
                stopped = True
        if stopped:
            continue

        def body(wanted=wanted, have=None):
            ids = []
            for member in wanted["agents"]:
                found = one_named(state.agents, member)
                if len(found) != 1:
                    raise Stop(1, 'the agent "%s" is not there.' % member)
                ids.append(found[0]["id"])
            made = {"name": wanted["name"], "description": wanted["description"], "agentIds": ids}
            if wanted["skills"] is not None and skill_ids is not None:
                made["skillIds"] = skill_ids_of(wanted, skill_ids, have)
            return made

        found = one_named(state.teams, wanted["name"])
        if not found:
            def create(body=body):
                api(state.app, "POST", "/api/teams", body())

            plan.changes.append(Change("teams", "%s: add it, with %s." % (where, ", ".join(wanted["agents"]) or "no agents"), create))
            continue
        if len(found) > 1:
            plan.notes.append("%s: the app has %d teams of this name. They are left as they are." % (where, len(found)))
            continue
        team = found[0]
        by_id = dict((a["id"], a.get("name", "").strip().lower()) for a in state.agents)
        have = sorted(by_id.get(i, "?") for i in team.get("agentIds") or [])
        differs = []
        if have != sorted(m.lower() for m in wanted["agents"]):
            differs.append("agents")
        if (team.get("description") or "") != wanted["description"]:
            differs.append("description")
        if wanted["skills"] is not None and skill_ids is not None:
            want_skills = skill_ids_of(wanted, skill_ids, team.get("skillIds"))
            if None in want_skills or sorted(team.get("skillIds") or []) != sorted(want_skills):
                differs.append("skills")
        if not differs:
            plan.same.append('team "%s"' % wanted["name"])
        elif options.update:
            def update(team=team, body=body):
                api(state.app, "PATCH", "/api/teams/%s" % team["id"], body(have=team.get("skillIds")))

            plan.changes.append(Change("teams", "%s: change it to what the file says (%s)." % (where, ", ".join(differs)), update))
        else:
            plan.notes.append("%s is in the app and differs from the file (%s). It is left as it is; --update changes it." % (where, ", ".join(differs)))


def step_as_sent(step):
    out = {"title": step["title"], "objective": step["objective"], "acceptanceCriteria": step["acceptanceCriteria"],
           "role": step["role"], "dependsOn": step["dependsOn"]}
    if step.get("outputFile"):
        out["outputFile"] = step["outputFile"]
    if step["kind"] != "text":
        out["kind"] = step["kind"]
    if step["media"]:
        out["media"] = step["media"]
    return out


def step_compared(step):
    return {
        "title": str(step.get("title") or "").strip(), "objective": str(step.get("objective") or "").strip(),
        "acceptanceCriteria": str(step.get("acceptanceCriteria") or "").strip(), "role": str(step.get("role") or "").strip(),
        "dependsOn": sorted(set(step.get("dependsOn") or [])), "outputFile": step.get("outputFile") or None,
        "kind": step.get("kind") or "text", "media": step.get("media") or {},
    }


def plan_workflows(state, definition, options, plan, agent_names):
    roles = set(agent_names) | set(a.get("role", "").strip().lower() for a in state.agents)
    roles |= set(a["role"].lower() for a in definition["agents"])
    for wanted in definition["workflows"]:
        where = 'Workflow "%s"' % wanted["name"]
        unknown = sorted(set(s["role"] for s in wanted["steps"] if s["kind"] != "render" and s["role"].lower() not in roles))
        if unknown:
            plan.notes.append("%s gives steps to %s, and no agent has that name or role: such a step goes to the first agent of the project's team." % (
                where, ", ".join('"%s"' % u for u in unknown)))
        body = {"name": wanted["name"], "description": wanted["description"], "steps": [step_as_sent(s) for s in wanted["steps"]]}
        kinds = {}
        for step in wanted["steps"]:
            kinds[step["kind"]] = kinds.get(step["kind"], 0) + 1
        found = one_named(state.workflows, wanted["name"])
        if not found:
            def create(body=body):
                api(state.app, "POST", "/api/workflows", body)

            plan.changes.append(Change("workflows", "%s: add it, with %s (%s)." % (
                where, plural(len(wanted["steps"]), "step"), ", ".join("%d %s" % (kinds[k], k) for k in KINDS if k in kinds)), create))
            continue
        if len(found) > 1:
            plan.notes.append("%s: the app has %d workflows of this name. They are left as they are." % (where, len(found)))
            continue
        workflow = found[0]
        differs = []
        if [step_compared(s) for s in workflow.get("steps") or []] != [step_compared(s) for s in body["steps"]]:
            differs.append("steps")
        if (workflow.get("description") or "") != wanted["description"]:
            differs.append("description")
        if not differs:
            plan.same.append('workflow "%s"' % wanted["name"])
        elif options.update:
            def update(workflow=workflow, body=body):
                api(state.app, "PATCH", "/api/workflows/%s" % workflow["id"], body)

            plan.changes.append(Change("workflows", "%s: change it to what the file says (%s)." % (where, ", ".join(differs)), update))
        else:
            plan.notes.append("%s is in the app and differs from the file (%s). It is left as it is; --update changes it." % (where, ", ".join(differs)))


def make_plan(state, definition, options, me):
    plan = Plan()
    plan_accounts(state, options, plan, me)
    plan_providers(state, definition, options, plan)
    slots = plan_models(state, definition, options, plan)
    plan_uploads(state, options, plan)
    skill_ids = plan_skills(state, definition, options, plan)
    agent_names = plan_agents(state, definition, options, plan, slots, skill_ids)
    plan_teams(state, definition, options, plan, agent_names, skill_ids)
    plan_workflows(state, definition, options, plan, agent_names)
    plan.slots = slots
    return plan


# ── Trying the models ────────────────────────────────────────────────────────


def test_chat(state, definition, slots, everything=False):
    """One word from each chat model of the file, or of the app. Returns how many failed."""
    head("Chat models: one word from each")
    failed = 0
    done = set()
    wanted = []
    for slot in definition["models"]:
        found = slots.get(slot)
        if found and found["id"] and not is_media_only(found["capabilities"]):
            wanted.append((found["id"], '%s ("%s")' % (found["label"], slot)))
    if everything:
        providers = dict((p["id"], p) for p in state.providers)
        for model in sorted(state.models, key=lambda m: (providers.get(m.get("providerId"), {}).get("name", ""), m.get("modelId", ""))):
            provider = providers.get(model.get("providerId"), {})
            if model.get("enabled", True) and provider.get("status", "enabled") == "enabled" and not is_media_only(caps_of(model)):
                wanted.append((model["id"], "%s of %s (not in the file)" % (label_of(model), provider.get("name", "a provider"))))
    for model_id, label in wanted:
        if model_id in done:
            continue
        if done:
            time.sleep(1.5)  # a free provider takes one request a second
        done.add(model_id)
        started = time.time()
        status, data = state.app.call("POST", "/api/models/%s/test" % model_id, {}, timeout=300)
        if status == 200 and isinstance(data, dict) and data.get("ok"):
            usage = data.get("usage") or {}
            row("ok", '%s said "%s" in %.1f s; %s tokens in, %s out' % (
                label, short(data.get("sample", ""), 60), time.time() - started,
                usage.get("promptTokens", "?"), usage.get("completionTokens", "?")))
        else:
            failed += 1
            row("FAILED", "%s: %s" % (label, short((data or {}).get("error") or reason_of(data)[2:] or "the app answered %s" % status, 900)))
    if not done:
        row("Nothing", "the app has no chat model." if everything else "the file names no chat model that is in the app.")
    return failed


# What a provider answers when a model cannot be used with what the app has:
# no access, no credit, no such model. Not 408 and 429 (not now), not 5xx.
REFUSALS = (400, 401, 402, 403, 404, 405, 410, 422)
# A model is asked for one word and waited for this long; one that takes
# longer is not judged.
USABLE_WAIT_SECONDS = 100


def refusal_of(text):
    """The provider's refusal in an error of the app's model test: its HTTP status, or None."""
    match = re.search(r"Provider responded (\d{3})", text or "")
    code = int(match.group(1)) if match else None
    return code if code in REFUSALS else None


def only_usable(state, slots):
    """
    Switch off the models that cannot be used. Looks at every model that is
    switched on, of a provider that is switched on, and that the file does not
    name. Returns how many things failed.
    """
    head("Only what can be used: the models the file does not name")
    named = set(found["id"] for found in slots.values() if found and found.get("id"))
    switch_off = []  # (model, label, why)
    undecided = []   # (label, why)
    kept = 0
    asked = 0
    media = 0
    unpriced = []
    for provider in sorted(state.providers, key=lambda p: (p.get("name") or "").lower()):
        if provider.get("status", "enabled") != "enabled":
            continue
        models = [m for m in state.models_of(provider) if m.get("enabled", True) and m["id"] not in named]
        if not models:
            continue
        listed = state.listed(provider)
        suggested = listed.get("suggested") or {}
        keyless_provider = provider.get("authType") == "none"
        # A provider that lists a great many models and says nothing of their
        # prices: one word from each would be hundreds of requests.
        if not listed.get("pricesListed") and len(models) > 120:
            unpriced.append("%s (%d models)" % (provider.get("name"), len(models)))
            continue
        for model in sorted(models, key=lambda m: m.get("modelId", "")):
            label = "%s of %s" % (label_of(model), provider.get("name"))
            said = suggested.get(model.get("modelId")) or {}
            if keyless_provider and said.get("billed") is True:
                switch_off.append((model, label, "the provider bills for it, and has no key here"))
                continue
            capabilities = caps_of(model)
            if capabilities and "text" not in capabilities:
                # A model for pictures, video, speech, listening or embeddings: a
                # word cannot try it, and a picture or a voice is not made to find out.
                media += 1
                continue
            if asked:
                time.sleep(1.2)  # a free provider takes one request a second
            asked += 1
            try:
                status, data = state.app.call("POST", "/api/models/%s/test" % model["id"], {}, timeout=USABLE_WAIT_SECONDS)
            except Stop as err:
                if err.code != 4:
                    raise
                # The model took too long, or the app is gone: the app is asked, and says which.
                state.app.call("GET", "/api/health", timeout=15)
                undecided.append((label, "no answer within %d s" % USABLE_WAIT_SECONDS))
                continue
            if status == 200 and isinstance(data, dict) and data.get("ok"):
                kept += 1
                continue
            error = (data or {}).get("error") if isinstance(data, dict) else None
            error = error if isinstance(error, str) else reason_of(data)[2:] or "the app answered %s" % status
            code = refusal_of(error)
            if code:
                switch_off.append((model, label, "refused (%d): %s" % (code, short(error.split(": ", 1)[-1], 160))))
            else:
                undecided.append((label, short(error, 200)))
    failed = 0
    done = 0
    reasons = {}
    for model, label, why in switch_off:
        status, data = state.app.call("PATCH", "/api/models/%s" % model["id"], {"enabled": False})
        if status == 200:
            done += 1
            reasons.setdefault(why if why.startswith("the provider bills") else "the provider refused one word", []).append((label, why))
        else:
            failed += 1
            row("FAILED", "switching off %s: %s" % (label, reason_of(data)[2:] or "the app answered %s" % status))
    row("Asked", "%s for one word." % plural(asked, "chat model"))
    row("Stay on", "%s answered." % plural(kept, "model"))
    for reason, items in sorted(reasons.items()):
        row("Switched off", "%s: %s." % (plural(len(items), "model"), reason))
        shown_items = items[:LISTED_AT_MOST]
        if reason.startswith("the provider bills"):
            more(", ".join(label for label, _ in shown_items) + (", and %d more" % (len(items) - len(shown_items)) if len(items) > len(shown_items) else ""), indent=15)
        else:
            for label, why in shown_items:
                more("%s: %s" % (label, why), indent=15)
            if len(items) > len(shown_items):
                more("and %d more" % (len(items) - len(shown_items)), indent=15)
    if not done and not failed:
        row("Switched off", "nothing: no model was found that cannot be used.")
    if undecided:
        row("Not judged", "%s did not answer this time (limited, busy, or slow) and %s as %s. Run this again later." % (
            plural(len(undecided), "model"), "stays" if len(undecided) == 1 else "stay", "it is" if len(undecided) == 1 else "they are"))
        for label, why in undecided[:LISTED_AT_MOST]:
            more("%s: %s" % (label, why), indent=15)
    if media:
        row("Not asked", "%s for pictures, video, speech, listening or embeddings: a word cannot try %s." % (
            plural(media, "model"), "it" if media == 1 else "them"))
    for name in unpriced:
        row("Not asked", "%s: the provider's list does not say what they cost, and one word from each is too many requests." % name)
    if done:
        state.read()
        more("A model that was switched off is switched on again on the Models page.", indent=2)
    return failed


def test_media(state, definition, slots, keep):
    """One picture, one sentence, and the two joined. Returns how many failed."""
    head("Image and speech models: one picture, one sentence")
    failed = 0
    made = []
    picture = None
    sentence = None
    tried = False
    for slot in definition["models"]:
        found = slots.get(slot)
        if not found or not found["id"]:
            continue
        capabilities = found["capabilities"]
        if "image_generation" in capabilities:
            tried = True
            started = time.time()
            status, data = state.app.call("POST", "/api/media/images", {
                "modelRowId": found["id"], "aspectRatio": "1:1",
                "prompt": "A paper lantern glowing on a wooden table at dusk, soft warm light, shallow depth of field, no text.",
            }, timeout=400)
            assets = (data or {}).get("assets") if isinstance(data, dict) else None
            if status == 201 and assets and assets[0].get("status") == "ready":
                made += [a["id"] for a in assets]
                picture = picture or assets[0]["id"]
                row("ok", '%s ("%s") made a picture in %.1f s: %s, %s bytes' % (
                    found["label"], slot, time.time() - started, assets[0].get("mimeType"), assets[0].get("sizeBytes")))
            else:
                failed += 1
                made += [a["id"] for a in assets or [] if a.get("id")]
                row("FAILED", '%s ("%s"), a picture: %s' % (found["label"], slot, short(
                    ((assets or [{}])[0].get("error") if assets else None) or reason_of(data)[2:] or "the app answered %s" % status, 900)))
        if "speech_generation" in capabilities:
            tried = True
            started = time.time()
            status, data = state.app.call("POST", "/api/media/speech", {
                "modelRowId": found["id"], "text": "This is a short test of the voice. Everything is ready.",
            }, timeout=400)
            asset = (data or {}).get("asset") if isinstance(data, dict) else None
            if status == 201 and asset and asset.get("status") == "ready":
                made.append(asset["id"])
                sentence = sentence or asset["id"]
                row("ok", '%s ("%s") said a sentence in %.1f s: %s, %s s long' % (
                    found["label"], slot, time.time() - started, asset.get("mimeType"), asset.get("durationSeconds")))
            else:
                failed += 1
                if asset and asset.get("id"):
                    made.append(asset["id"])
                row("FAILED", '%s ("%s"), a sentence: %s' % (found["label"], slot, short(
                    (asset or {}).get("error") or reason_of(data)[2:] or "the app answered %s" % status, 900)))
    if not tried:
        row("Nothing", "the file names no image or speech model that is in the app.")
    if picture and sentence:
        if not (state.render or {}).get("available"):
            row("Not joined", "the server has no usable ffmpeg, so the picture and the sentence were not joined into a video.")
        else:
            status, data = state.app.call("POST", "/api/media/render", {
                "clipIds": [picture], "narrationIds": [sentence], "aspectRatio": "9:16", "fit": "cover",
                "subtitles": bool(state.render.get("subtitles")), "title": "Workforce check",
            })
            asset = (data or {}).get("asset") if isinstance(data, dict) else None
            if status != 201 or not asset:
                failed += 1
                row("FAILED", "joining the picture and the sentence: %s" % (reason_of(data)[2:] or "the app answered %s" % status))
            else:
                made.append(asset["id"])
                deadline = time.time() + 240
                while asset.get("status") == "pending" and time.time() < deadline:
                    time.sleep(2)
                    status, data = state.app.call("GET", "/api/media/%s" % asset["id"])
                    asset = (data or {}).get("asset") or {"status": "failed", "error": "the app answered %s" % status}
                if asset.get("status") == "ready":
                    row("ok", "the picture and the sentence joined into one video: %s, %s s long, %s bytes%s" % (
                        asset.get("mimeType"), asset.get("durationSeconds"), asset.get("sizeBytes"),
                        "; note: " + short(asset["error"], 200) if asset.get("error") else ""))
                else:
                    failed += 1
                    row("FAILED", "joining the picture and the sentence: %s" % short(asset.get("error") or "it did not finish in four minutes", 900))
    if made and not keep:
        gone = 0
        for asset_id in made:
            status, _ = state.app.call("DELETE", "/api/media/%s" % asset_id)
            gone += 1 if status == 200 else 0
        row("Tidied", "%s made for this check %s deleted from the library%s." % (
            plural(len(made), "file"), "was" if len(made) == 1 else "were",
            "" if gone == len(made) else " (%d could not be deleted)" % (len(made) - gone)))
    elif made:
        row("Kept", "%s made for this check %s in the library (--keep-test-media)." % (plural(len(made), "file"), "is" if len(made) == 1 else "are"))
    return failed


EVERY_AGENT = (
    "This is a check that you can work. The goal of the project: %(goal)s\n\n"
    "Write one sentence that says what you would do first for this goal, in your role. "
    "If you have a tool that writes files, save the sentence as %(file)s with it. "
    "Then give the sentence as your answer, and nothing else."
)


def try_run(state, definition, slots, keep):
    """Small projects done by the models of the file. Returns how many things failed."""
    spec = definition.get("tryRun")
    if not spec:
        head("A small project, to see the agents at work")
        row("Nothing", 'the file has no "tryRun": a goal, and the model that plans it.')
        return 0
    manager = slots.get(spec["manager"])
    if not manager or not manager["id"]:
        head("A small project, to see the agents at work")
        row("FAILED", 'the model "%s", which is to plan it, is not in the app.' % spec["manager"])
        return 1
    head("A small project, planned by the manager model")
    failed = try_project(state, definition, spec, manager, keep, every_agent=False)
    if spec["everyAgent"]:
        head('A small task for every agent of the team "%s"' % spec["team"] if spec["team"] else "A small task for every agent of the file")
        failed += try_project(state, definition, spec, manager, keep, every_agent=True)
    return failed


def try_project(state, definition, spec, manager, keep, every_agent):
    """One project, run to its end and deleted again. Returns how many things failed."""
    title = "Workforce check: every agent" if every_agent else "Workforce check: a planned goal"
    body = {"title": title, "goal": spec["goal"], "managerModelRowId": manager["id"], "maxTasks": spec["maxTasks"], "maxParallel": 1}
    workflow = None
    if every_agent:
        # One step for each agent of the file, by its name: no model has to plan, and every agent is seen at work.
        names = [name for name in every_agent_names(definition, spec["team"]) if len(one_named(state.agents, name)) == 1]
        if not names:
            row("FAILED", "none of the agents of the file is in the app.")
            return 1
        steps = [{"title": name, "role": name, "dependsOn": [], "acceptanceCriteria": "One sentence, in the answer.",
                  "objective": EVERY_AGENT % {"goal": spec["goal"], "file": "notes/%s.md" % "".join(c if c.isalnum() else "-" for c in name.lower())}}
                 for name in names]
        status, data = state.app.call("POST", "/api/workflows", {
            "name": title, "description": "Made by workforce.py --try-run, and deleted when the check ends.", "steps": steps})
        workflow = (data or {}).get("workflow") if isinstance(data, dict) else None
        if status != 201 or not workflow:
            row("FAILED", "the workflow of the check could not be made%s" % (reason_of(data) or ": the app answered %s" % status))
            return 1
        body.update(workflowId=workflow["id"], maxTasks=len(steps), maxParallel=2)
    elif spec["team"]:
        teams = one_named(state.teams, spec["team"])
        if len(teams) != 1:
            row("FAILED", 'the app has %d teams named "%s".' % (len(teams), spec["team"]))
            return 1
        body["teamId"] = teams[0]["id"]
    project = None
    failed = 0
    started = time.time()
    try:
        status, data = state.app.call("POST", "/api/projects", body)
        project = (data or {}).get("project") if isinstance(data, dict) else None
        if status != 201 or not project:
            row("FAILED", "the project could not be made%s" % (reason_of(data) or ": the app answered %s" % status))
            return 1
        # The answer is what happens in the run, as it happens, to its end.
        status, data, events = state.app.follow("/api/projects/%s/run" % project["id"])
        if status != 200:
            row("FAILED", "the run did not start%s" % (reason_of(data) or ": the app answered %s" % status))
            return 1
        deadline = time.time() + 600
        while True:
            status, data = state.app.call("GET", "/api/projects/%s" % project["id"])
            now = (data or {}).get("project") if isinstance(data, dict) else None
            if not now or now.get("status") not in ("queued", "planning", "running") or time.time() > deadline:
                break
            time.sleep(3)
        if not now:
            row("FAILED", "the project could not be read back: the app answered %s" % status)
            return 1
        agents = dict((a["id"], a.get("name", "?")) for a in state.agents)
        tasks = now.get("tasks") or []
        took = "%.0f s in all; %s tokens used by the tasks" % (time.time() - started, now.get("tokensUsed", "?"))
        if every_agent:
            row("Given", "one task to each of %s, two at a time; %s" % (plural(len(tasks), "agent"), took))
        else:
            row("Planned", "by %s: %s; %s" % (manager["label"], plural(len(tasks), "task"), took))
        attempts = attempts_of(state, project["id"])
        for task in tasks:
            good = task.get("status") == "succeeded"
            failed += 0 if good else 1
            answered = [a for a in attempts or [] if a.get("seq") == task.get("seq") and a.get("status") == "ok"]
            who = agents.get(task.get("agentId"), "no agent")
            row("ok" if good else "FAILED", "%s. %s: %s%s%s%s" % (
                task.get("seq"), who if every_agent else '"%s", by %s' % (short(task.get("title") or "", 70), who), task.get("status"),
                " on %s (%s)" % (answered[-1].get("model") or "a model that is gone", answered[-1].get("provider") or "?") if good and answered else "",
                "; %s" % plural(task.get("attempts") or 0, "attempt") if (task.get("attempts") or 0) != 1 else "",
                "; %s, %s" % (plural(task.get("steps") or 0, "model call"), plural(task.get("toolCalls") or 0, "tool call")) if task.get("steps") else ""))
            if not good and task.get("error"):
                more(short(task["error"], 600), indent=15)
            elif good and every_agent:
                more("it said: %s" % short(task.get("artifact") or "", 200), indent=15)
        said_by(state, attempts, events)
        ended = now.get("status")
        if ended in ("succeeded", "review") and tasks:
            summary = (now.get("finalDeliverable") or "").replace("\n", " ")
            if summary.startswith("(Synthesis step failed"):
                failed += 1
                row("FAILED", "the tasks were not summed up: %s did not answer. %s" % (manager["label"], short(summary, 400)))
            else:
                row("ok", 'the project ended as "%s"; summed up by %s, beginning: %s' % (ended, manager["label"], short(summary, 200)))
            notes = now.get("reviewNotes") or ""
            verdict = [line for line in notes.splitlines() if "VERDICT" in line.upper()]
            row("Review", verdict[-1].strip() if verdict else "there was none: no model of the reviewer answered")
            if verdict and "PASS" not in verdict[-1].upper():
                # Why: a reviewer that fails a project says what it missed, and
                # that is worth more than the word. Nothing is failed for it:
                # the tasks of this check are small on purpose.
                reasons = " ".join(line.strip() for line in notes.splitlines() if line.strip() and "VERDICT" not in line.upper())
                if reasons:
                    more("the reviewer said: %s" % short(reasons, 1400), indent=15)
        else:
            failed += 1
            row("FAILED", 'the project ended as "%s"%s' % (ended, ": " + short(now["error"], 600) if now.get("error") else ""))
    finally:
        if keep and project:
            row("Kept", 'the project "%s" is on the Projects page%s (--keep-try-run).' % (title, ", and its workflow on the Workflows page" if workflow else ""))
        else:
            gone = []
            if project:
                gone.append(("project", state.app.call("DELETE", "/api/projects/%s" % project["id"])[0]))
            if workflow:
                gone.append(("workflow", state.app.call("DELETE", "/api/workflows/%s" % workflow["id"])[0]))
            left = ["the %s (the app answered %s)" % (what, status) for what, status in gone if status != 200]
            what = "project and its workflow were" if project and workflow else "project was" if project else "workflow was"
            row("Tidied", "the %s deleted again." % what if not left else '"%s" could not be deleted: %s.' % (title, ", ".join(left)))
    return failed


def attempts_of(state, project_id):
    """Every attempt of the run's tasks, where the app tells (1.6 and newer): a task shows only its last error."""
    status, data = state.app.call("GET", "/api/projects/%s/attempts" % project_id)
    return (data or {}).get("attempts") if status == 200 and isinstance(data, dict) else None


def said_by(state, attempts, events):
    """What the models that did not answer said."""
    wrong = [a for a in attempts or [] if a.get("status") != "ok"]
    if wrong:
        row("Not answered", "%s; the task went on with the agent's next model:" % plural(len(wrong), "attempt"))
        for a in wrong:
            more("task %s, attempt %s: %s (%s) after %.0f s: %s" % (
                a.get("seq"), a.get("attempt"), a.get("model") or "a model that is gone", a.get("provider") or "?",
                (a.get("latencyMs") or 0) / 1000.0, short(a.get("error") or "no reason given", 300)), indent=15)
    elif attempts is None:
        row("Attempts", "this version of the app does not tell which model answered a task, or what the others said (1.6 does).")
    for event in events:
        if event.get("type") == "error":
            row("Said", "the run: %s" % short(str(event.get("message") or ""), 400))


# ── Go ───────────────────────────────────────────────────────────────────────


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Wrong("%s. See --help." % message)


def options_from(argv):
    parser = Parser(add_help=False, allow_abbrev=False)
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--user", default="")
    parser.add_argument("--env-file", default="")
    parser.add_argument("--file", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "workforce.json"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--only", default="")
    parser.add_argument("--account", default="")
    parser.add_argument("--account-email", default="")
    parser.add_argument("--account-role", default="")
    parser.add_argument("--upload-skill", action="append", default=[])
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--test-all", action="store_true")
    parser.add_argument("--only-usable", action="store_true")
    parser.add_argument("--try-run", action="store_true")
    parser.add_argument("--keep-try-run", action="store_true")
    parser.add_argument("--test-media", action="store_true")
    parser.add_argument("--keep-test-media", action="store_true")
    parser.add_argument("--inventory-only", action="store_true")
    parser.add_argument("-h", "--help", action="store_true")
    options, rest = parser.parse_known_args(argv)
    if rest:
        raise Wrong('unknown option "%s". See --help.' % rest[0])
    if options.help:
        with open(os.path.abspath(__file__), encoding="utf-8") as handle:
            for line in handle.read().splitlines()[1:]:
                if not line.startswith("#"):
                    break
                say(line[2:] if line.startswith("# ") else line[1:])
        raise SystemExit(0)
    if not options.url.startswith(("http://", "https://")):
        raise Wrong("--url is an address such as http://127.0.0.1:3000.")
    options.parts = PARTS
    if options.only:
        options.parts = names_of([p for p in options.only.split(",") if p.strip()], "--only", PARTS)
        if not options.parts:
            raise Wrong("--only names parts: %s." % ", ".join(PARTS))
    if options.account_email or options.account_role:
        if not options.account:
            raise Wrong("--account-email and --account-role go with --account, the username of the account.")
    if options.account:
        name = options.account.strip()
        if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", name):
            raise Wrong("--account is a username: 3 to 32 letters, numbers, and . _ -")
        email = options.account_email.strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email) or len(email) > 254:
            raise Wrong("--account needs --account-email, the address of the account.")
        role = (options.account_role or "user").strip().lower()
        if role not in ROLES:
            raise Wrong("--account-role is one of: %s." % ", ".join(ROLES))
        options.account = {"username": name, "email": email, "role": role}
    else:
        options.account = None
    return options


def run(argv):
    options = options_from(argv)
    definition = None if options.inventory_only else read_definition(options.file)

    password = os.environ.get("NEXUS_PASSWORD", "")
    source = "NEXUS_PASSWORD"
    # The name of the administrator of the first start is in the app's .env,
    # whichever of the two the password comes from.
    values = read_env_file(options.env_file) if options.env_file else {}
    user = options.user or values.get("BOOTSTRAP_ADMIN_USERNAME", "") or "admin"
    if options.env_file and not password:
        password = values.get("BOOTSTRAP_ADMIN_PASSWORD", "")
        source = "the app's .env (BOOTSTRAP_ADMIN_PASSWORD)"
        if not password:
            raise Wrong("%s sets no BOOTSTRAP_ADMIN_PASSWORD, and NEXUS_PASSWORD is not set: there is nothing to sign in with." % options.env_file)
    if not password:
        raise Wrong("NEXUS_PASSWORD is not set: the password of the administrator to sign in as.")

    app = App(options.url)
    status, health = app.call("GET", "/api/health", timeout=20)
    if status != 200 or not isinstance(health, dict) or health.get("status") != "ok":
        raise Stop(4, "%s/api/health does not say that the app is well (it answered %s)." % (app.url, status))

    me = sign_in(app, user, password, source)
    password = ""
    failed = 0
    try:
        state = State(app).read().read_server()
        show_inventory(state, me)
        if options.inventory_only:
            return 0

        plan = make_plan(state, definition, options, me)
        head("What the file asks for (%s)" % os.path.basename(options.file))
        todo = plan.todo(options.parts)
        for change in plan.changes:
            if change.part in options.parts:
                say("  " + ("+ " if change.do else "  ") + change.text)
        if plan.same:
            row("As the file", "%s: %s" % (plural(len(plan.same), "entry", "entries"), ", ".join(plan.same)))
        left_out = plan.left_out(options.parts)
        if left_out:
            row("Not now", "%s in parts that --only leaves out." % plural(len(left_out), "change"))
        for note in plan.notes:
            say("  note: " + note)
        for problem in plan.problems:
            say("  PROBLEM: " + problem)
        if plan.problems:
            head("Nothing was changed: %s in the way." % ("this is" if len(plan.problems) == 1 else "these are"))
            return 1
        if not todo:
            head("Nothing to do: the app has everything the file asks for%s." % (" in these parts" if options.only else ""))
        elif options.dry_run:
            head("Dry run: nothing was changed. %s would be made%s." % (
                plural(len(todo), "change"), not_tried(options, ", and %s")))
            return 0
        else:
            if not options.yes:
                if not sys.stdin.isatty():
                    head("Nothing was changed: run it again with --yes to make %s." % ("this change" if len(todo) == 1 else "these changes"))
                    return 1
                say()
                answer = input("Make %s in the app now? [y/N] " % ("this change" if len(todo) == 1 else "these %d changes" % len(todo)))
                if answer.strip().lower() not in ("y", "yes"):
                    head("Stopped; nothing was changed.")
                    return 1
            head("Doing it")
            done = 0
            # Part by part, each on what the part before it made: an agent
            # needs its model's ID, a team its agents'.
            for part in PARTS:
                if part not in options.parts:
                    continue
                state.read()
                fresh = make_plan(state, definition, options, me)
                if fresh.problems:
                    for problem in fresh.problems:
                        say("  PROBLEM: " + problem)
                    head("Stopped after %s. What was done stays; run it again once this is solved." % plural(done, "change"))
                    return 1
                for change in fresh.changes:
                    if change.part != part or not change.do:
                        continue
                    try:
                        change.do()
                    except Stop as err:
                        say("  FAILED  %s" % change.text)
                        more(str(err))
                        if err.code == 4:
                            raise
                        head("Stopped after %s. What was done stays; run it again once this is solved." % plural(done, "change"))
                        return 1
                    done += 1
                    say("  done    %s" % change.text)
            state.read()
            after = make_plan(state, definition, options, me)
            rest = after.todo(options.parts)
            if rest or after.problems:
                for change in rest:
                    say("  STILL TO DO: " + change.text)
                for problem in after.problems:
                    say("  PROBLEM: " + problem)
                head("%s made, and the app is still not as the file says." % plural(done, "change"))
                return 1
            plan = after
            head("%s made. Read back from the app: %s, %s, %s; everything the file asks for%s is there." % (
                plural(done, "change"), plural(len(state.agents), "agent"), plural(len(state.teams), "team"),
                plural(len(state.workflows), "workflow"), " in these parts" if options.only else ""))

        if options.dry_run:
            if not_tried(options, "%s"):
                say("Dry run: %s." % not_tried(options, "%s"))
            return 0
        if options.only_usable:
            failed += only_usable(state, plan.slots)
        if options.test or options.test_all:
            failed += test_chat(state, definition, plan.slots, options.test_all)
        if options.test_media:
            failed += test_media(state, definition, plan.slots, options.keep_test_media)
        if options.try_run:
            failed += try_run(state, definition, plan.slots, options.keep_try_run)
        if failed:
            head("%s failed. The workforce itself is as the file says." % plural(failed, "check"))
            return 1
        return 0
    finally:
        sign_out(app)


def not_tried(options, text):
    """What a dry run leaves out of the checks that were asked for."""
    tests = options.test or options.test_all or options.test_media or options.only_usable
    if tests and options.try_run:
        return text % "no model was tried and no project was run"
    if options.try_run:
        return text % "no project was run"
    return text % "no model was tried" if tests else ""


def main():
    try:
        return run(sys.argv[1:])
    except Wrong as err:
        print("error: %s" % err, file=sys.stderr)
        return 2
    except Stop as err:
        print("error: %s" % err, file=sys.stderr)
        return err.code
    except KeyboardInterrupt:
        print("error: interrupted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
