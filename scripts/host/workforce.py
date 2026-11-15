#!/usr/bin/env python3
# The workforce of a running Xiero Nexus AI, from a file: the models it works
# with, its agents, its teams and its workflows.
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
#   --only <parts>       Only these parts of the file: providers, models,
#                        agents, teams, workflows (separated by commas).
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
#   --inventory-only     Say what the app has, and stop. No file is needed.
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
import socket
import sys
import time
import urllib.error
import urllib.request

AGENT = "xiero-nexus-workforce/1"
PARTS = ["providers", "models", "agents", "teams", "workflows"]
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
PRICES = ["inputPricePerMTok", "outputPricePerMTok", "pricePerImage", "pricePerSecond", "pricePerMChars"]
MODEL_FIELDS = ["displayName", "contextWindow"] + PRICES
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


def read_definition(path):
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as err:
        raise Wrong("%s cannot be read: %s." % (path, err.strerror or err))
    except ValueError as err:
        raise Wrong("%s is not JSON: %s." % (path, err))
    only_keys(raw, ["about", "providers", "models", "agents", "teams", "workflows"], "The file")
    for key in ("agents", "teams", "workflows"):
        if not isinstance(raw.get(key, []), list):
            raise Wrong('"%s" is a list.' % key)

    providers = {}
    raw_providers = raw.get("providers", {})
    if not isinstance(raw_providers, dict):
        raise Wrong('"providers" is an object: the name or the kind of a provider, and its settings.')
    for name, item in raw_providers.items():
        where = 'Provider "%s"' % name
        only_keys(item, ["timeoutMs"], where)
        providers[name] = {}
        if "timeoutMs" in item:
            providers[name]["timeoutMs"] = number_of(item["timeoutMs"], where + ": timeoutMs", 1000, 300000, True)

    models = {}
    raw_models = raw.get("models", {})
    if not isinstance(raw_models, dict):
        raise Wrong('"models" is an object: a name of your choice for each model.')
    for slot, item in raw_models.items():
        where = 'Model "%s"' % slot
        only_keys(item, ["provider", "model", "capabilities"] + MODEL_FIELDS, where)
        model = {
            "slot": slot,
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

    def slot_of(value, where, needed):
        if value is None and not needed:
            return None
        if not isinstance(value, str) or value not in models:
            raise Wrong("%s names a model of this file: one of %s." % (where, ", ".join(models) or "(the file has none)"))
        return value

    agents = []
    seen = set()
    for index, item in enumerate(raw.get("agents", [])):
        where = "Agent %d" % (index + 1)
        only_keys(item, ["name", "role", "instructions", "primary", "fallback", "temperature", "tools", "maxSteps", "memory"], where)
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
        })
        if not isinstance(agents[-1]["memory"], bool):
            raise Wrong("%s: memory is true or false." % where)

    teams = []
    seen = set()
    for index, item in enumerate(raw.get("teams", [])):
        where = "Team %d" % (index + 1)
        only_keys(item, ["name", "description", "agents"], where)
        name = text_of(item.get("name"), where + ": name", 80, 1)
        where = 'Team "%s"' % name
        if name.lower() in seen:
            raise Wrong("%s is in the file twice." % where)
        seen.add(name.lower())
        teams.append({
            "name": name,
            "description": text_of(item.get("description", ""), where + ": description", 500),
            "agents": names_of(item.get("agents", []), where + ": agents"),
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

    return {"providers": providers, "models": models, "agents": agents, "teams": teams, "workflows": workflows}


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
    if me.get("role") != "admin":
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

    def read(self):
        app = self.app
        self.providers = app.get("/api/providers", "providers")
        self.models = app.get("/api/models", "models")
        self.agents = app.get("/api/agents", "agents")
        self.teams = app.get("/api/teams", "teams")
        self.workflows = app.get("/api/workflows", "workflows")
        return self

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
                self.upstream[provider["id"]] = {"models": data.get("models") or [], "suggested": data.get("suggested") or {}}
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
    row("Signed in", '"%s", an administrator%s' % (me.get("username", "?"), "" if not me.get("twoFactorEnabled") else ", with two-step sign-in"))
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
        say("  %s (%s), %s" % (provider.get("name"), provider.get("adapter"), provider.get("baseUrl")))
        more("%s; %s; %s%s" % (provider.get("status"), "a key is stored" if credential else "no key is stored", tested_text(provider),
                               "; waits up to %g s for an answer" % (provider["timeoutMs"] / 1000.0) if provider.get("timeoutMs") else ""))
        rows = sorted(state.models_of(provider), key=lambda m: m.get("modelId", ""))
        width = max([len(m.get("modelId", "")) for m in rows] + [10])
        for model in rows:
            caps = model.get("capabilities") or []
            shown = " ".join(c.get("capability", "?") + ("*" if c.get("verified") else "") for c in caps) or "(no capability set)"
            more("%-*s  %-9s %s" % (width, model.get("modelId"), kind_of(caps_of(model)), shown))
            more("%s%s; %s; %s%s" % (
                "" if not model.get("displayName") else '"%s"; ' % model["displayName"],
                "context %s" % ("{:,}".format(model["contextWindow"]) if model.get("contextWindow") else "not set"),
                price_text(model), tested_text(model),
                "" if model.get("enabled", True) else "; SWITCHED OFF"), indent=10)
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
                more("not in the app, %s: %s" % (kind, ", ".join(groups[kind])), indent=10)
    if state.models:
        more("(* after a capability: a request has shown that the model has it.)")

    by_id = dict((m["id"], m) for m in state.models)

    def model_name(row_id):
        if not row_id:
            return "none"
        model = by_id.get(row_id)
        return label_of(model) if model else "a model that is gone"

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
    agent_names = dict((a["id"], a.get("name")) for a in state.agents)
    head("Teams (%d)" % len(state.teams))
    for team in state.teams:
        say("  %s: %s" % (team.get("name"), ", ".join(agent_names.get(i, "an agent that is gone") for i in team.get("agentIds") or []) or "no agents"))
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


def plan_providers(state, definition, options, plan):
    """A provider is always there already (this program has no keys to add one with), so --update decides."""
    for name, wanted in definition["providers"].items():
        provider, problem = find_provider(state, name)
        if not provider:
            plan.problems.append('Provider "%s": %s' % (name, problem))
            continue
        label = 'provider "%s"' % provider.get("name")
        patch = dict((key, value) for key, value in wanted.items() if provider.get(key) != value)
        if not patch:
            plan.same.append(label)
            continue
        said = []
        if "timeoutMs" in patch:
            said.append("wait up to %g s for an answer instead of %s" % (
                patch["timeoutMs"] / 1000.0, "%g s" % (provider["timeoutMs"] / 1000.0) if provider.get("timeoutMs") else "an unknown time"))
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


def plan_agents(state, definition, options, plan, slots):
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

        def body(wanted=wanted, tools=tools):
            return {
                "name": wanted["name"], "role": wanted["role"], "instructions": wanted["instructions"],
                "primaryModelRowId": slots[wanted["primary"]]["id"],
                "fallbackModelRowId": slots[wanted["fallback"]]["id"] if wanted["fallback"] else None,
                "routingMode": "manual", "temperature": wanted["temperature"], "tools": tools,
                "maxSteps": wanted["maxSteps"], "memoryEnabled": wanted["memory"],
            }

        found = one_named(state.agents, wanted["name"])
        models = "%s%s" % (slots[wanted["primary"]]["label"], ", then %s" % slots[wanted["fallback"]]["label"] if wanted["fallback"] else "")
        if not found:
            def create(body=body):
                api(state.app, "POST", "/api/agents", body())

            names.add(wanted["name"].lower())
            plan.changes.append(Change("agents", '%s (%s): add it, on %s%s.' % (
                where, wanted["role"], models, "; tools: " + ", ".join(tools) if tools else ""), create))
            continue
        if len(found) > 1:
            plan.notes.append("%s: the app has %d agents of this name. They are left as they are." % (where, len(found)))
            continue
        agent = found[0]
        now = body()
        differs = []
        for key, value in now.items():
            if key == "name":
                continue
            have = agent.get(key)
            if key == "tools":
                same = sorted(have or []) == sorted(value)
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
                api(state.app, "PATCH", "/api/agents/%s" % agent["id"], body())

            plan.changes.append(Change("agents", "%s: change it to what the file says (%s)." % (where, ", ".join(differs)), update))
        else:
            plan.notes.append("%s is in the app and differs from the file (%s). It is left as it is; --update changes it." % (where, ", ".join(differs)))
    for tool, who in left.items():
        need = "a sandbox runner (SANDBOX_URL)" if tool == "run_command" else "a search service (SEARCH_PROVIDER)" if tool == "web_search" else "something this server lacks"
        plan.notes.append("%s needs %s, which this server does not have: left out for %s." % (tool, need, ", ".join(who)))
    return names


def plan_teams(state, definition, options, plan, agent_names):
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

        def body(wanted=wanted):
            ids = []
            for member in wanted["agents"]:
                found = one_named(state.agents, member)
                if len(found) != 1:
                    raise Stop(1, 'the agent "%s" is not there.' % member)
                ids.append(found[0]["id"])
            return {"name": wanted["name"], "description": wanted["description"], "agentIds": ids}

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
        if not differs:
            plan.same.append('team "%s"' % wanted["name"])
        elif options.update:
            def update(team=team, body=body):
                api(state.app, "PATCH", "/api/teams/%s" % team["id"], body())

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


def make_plan(state, definition, options):
    plan = Plan()
    plan_providers(state, definition, options, plan)
    slots = plan_models(state, definition, options, plan)
    agent_names = plan_agents(state, definition, options, plan, slots)
    plan_teams(state, definition, options, plan, agent_names)
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
                "modelRowId": found["id"], "aspectRatio": "9:16",
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
                "clipIds": [picture], "narrationIds": [sentence], "aspectRatio": "9:16",
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
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--test-all", action="store_true")
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

        plan = make_plan(state, definition, options)
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
                plural(len(todo), "change"), ", and no model was tried" if options.test or options.test_all or options.test_media else ""))
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
                fresh = make_plan(state, definition, options)
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
            after = make_plan(state, definition, options)
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
            if options.test or options.test_all or options.test_media:
                say("Dry run: no model was tried.")
            return 0
        if options.test or options.test_all:
            failed += test_chat(state, definition, plan.slots, options.test_all)
        if options.test_media:
            failed += test_media(state, definition, plan.slots, options.keep_test_media)
        if failed:
            head("%s failed. The workforce itself is as the file says." % plural(failed, "check"))
            return 1
        return 0
    finally:
        sign_out(app)


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
