# Changelog

All notable changes to Xiero Nexus AI are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Release channels (stable, rc, beta,
alpha, dev) are described in [RELEASING.md](RELEASING.md).

## [1.8.0-rc.3] - 2026-11-16

The third candidate for 1.8: a user is shown their own work, and nothing of
how the installation is set up. Providers and models are for administrators.

### Changed

- **A user sees no provider and no model**, on no page and in no answer of
  the API: not their names, not the lists, not a price or a cost. Providers,
  Models and Skills are not in a user's menu, and their pages and their API
  (`GET /api/providers`, `/api/models`, `/api/skills`, `/api/agents/tools`)
  are for administrators. Agents, teams and workflows are shown to a user by
  name and by what they are for: not what an agent is told, which model,
  tools and skills it has, nor what a workflow's steps tell their agents.
- **A user chooses no model: the app does.** In Chat, in a project, in
  Creative Studio, for a knowledge base that is searched by meaning, and
  with an API key, a model a user names is not used. An administrator marks
  the models that are **for users** on the Models page; while none of a kind
  is marked, the app takes the cheapest of that kind that is switched on.
  In Chat on the site, when the first choice fails, the next ones are asked
  (up to three in all). The Models page says which model users work with
  now, kind by kind.
- **What went wrong is said to a user without the setup.** An error, a
  failed task, a notification or a note of a running task that names a
  provider or a model, or holds what a provider answered, reads "This could
  not be done just now. Try again in a moment; if it stays that way, tell an
  administrator." An administrator who opens the same project reads what the
  provider said. Errors about the request itself are said as before: tokens
  used up, a file too large, a name that is taken.
- **The public API with a user's key** lists one model, `auto`
  (`GET /api/v1/models`), and takes `"model": "auto"`; any other name is
  answered 404 `model_not_found`, in the same words whether there is such a
  model or not. Its answers say `auto` where they said the model. An
  administrator's key names models as before, and can send `auto` too. A
  user's key is limited to no model and to no cost a month.
- **What the app writes about its own work names nothing to a user.** The
  line an image, a video or a voice-over leaves in a task is written without
  the model for a user's project ("Generated image. Asset …"), and read
  without it by a user where an older line has it. A result that could not
  be put together reads "(What the tasks made could not be put together into
  one deliverable just now. …)" in place of what the provider said. A
  user's project that cannot start says what is missing in plain words:
  that the installation is not set up for it, or that its team has no agent
  that is switched on.
- **Creative Studio for a user** has no model to choose, no price, no extra
  parameters and no word about providers: its advanced options are the exact
  size, where the request takes one.
- A user's Overview is about their own projects, files and tokens. Usage
  shows a user tokens and requests, without providers, models and costs.
- **The Reel template** describes a workflow by what it makes. What a project
  needs to run it (which kinds of model, ffmpeg on the server) is said to
  the administrator who builds the workflow, and no longer stands in the
  description that everyone reads. A user reads a description of an older
  version without that sentence.
- `scripts/host/workforce.json`: the descriptions of four teams and five
  workflows say what they make and which team goes with which workflow, and
  no longer which models a project needs. The workforce action with
  `--update` brings them to an installation that has the older ones.

### Added

- `forUsers` on a model (`POST /api/models`, `PATCH /api/models/{id}`), and
  `users` in `GET /api/models`: what users work with, kind by kind.
- 503 `not_set_up` when the installation has no model that can do what a
  user asked for.

### As it was

- Only an owner changes a role or a token limit. An administrator sees the
  accounts and their tokens, and is answered 403 when changing one. That is
  how 1.7 and the second candidate already worked; this candidate adds checks
  that hold it.

### Not hidden

- What a model wrote is the user's own work and is shown as it is, also when
  a model names itself in it.
- What an administrator wrote for people to read is shown to users as
  written: the names and descriptions of agents, teams and workflows, and
  the titles of a workflow's steps. Say there what something makes, not
  which model does it.
- A user who runs a project sees the titles of its tasks and what they
  delivered. What a task was told is not on the pages, and for a project that
  runs a workflow it is not in the API either.

## [1.8.0-rc.2] - 2026-11-16

The second candidate for 1.8: every account has a number of tokens it may
use, and an owner sets it.

### Added

- **A token limit for every account.** A new account may use 10,000,000
  tokens in all (`DEFAULT_TOKEN_LIMIT`), whether it registers or an owner
  makes it. What its work uses is counted against that: chat, the runs of its
  projects with every task in them, images, videos, voice-overs, the
  knowledge base, and the public API with its keys. Nothing is given back by
  the calendar: there is more when an owner raises the limit.
- **An owner sets the limit** of each account under **Users & Roles**, which
  shows every account with what it used and may use, and when making an
  account. An administrator sees the numbers and changes none. An owner is
  not held to a limit; what an owner uses is counted all the same.
- **With no tokens left, new work is refused** with 402 `token_limit_reached`
  and a sentence that says how much was used, of how much, and who can change
  that. Nothing is asked of a provider. **A run in progress stops:** the
  tasks that have not started are not started and say why, nothing more is
  asked of a model, and the run ends "for a look" with what its finished
  tasks made. A run of a project spends the tokens of the account the project
  belongs to, whoever starts it.
- The account is told in its notifications the moment its last tokens go.
  Everyone sees their own tokens under **Settings** and, in short, next to
  their name on every page; an account with none left is told on every page.
- `tokenLimit`, `tokensUsed` and `tokensLeft` in the answers about accounts
  (`GET /api/account/me`, `GET /api/admin/users`); `tokenLimit` in
  `POST /api/admin/users` and `PATCH /api/admin/users/{id}` (owners). The
  audit log has every change of a limit, from what to what, and each time an
  account used its last tokens (`account.tokens.used_up`).
- The inventory of `workforce.py` says how the app checks its models, what
  its last round found, and how many models it leaves out of its lists now.
  (The host scripts are not part of a release bundle: the Deploy workflow
  runs the ones of the branch it is started on.)

### Changed

- An image, a video and a voice-over are recorded with the tokens of their
  prompt where the provider counts none for them, as a chat already was.
  Usage shows those tokens.

### Not counted, and not exact

- A check of a model, by the worker or by an administrator, is counted for
  nobody. A request that the provider failed is not counted.
- The request in progress when the last tokens go is finished and counted in
  full, so an account can end somewhat above its limit; tasks of a run that
  work side by side can each use what was left.
- An image or a video costs its prompt in tokens, which is little: a limit in
  tokens does not hold media back the way it holds chat and runs back.

### Upgrade notes

- At its first start this version adds two columns to the database. Every
  account that is there gets a limit of 10,000,000 tokens and starts at 0
  used: what it used before the upgrade is not counted against it.
- The account the host scripts sign in with spends its own tokens on
  `--test` and `--try-run`, unless it is an owner.

## [1.8.0-rc.1] - 2026-11-16

The first candidate for 1.8: the app checks by itself that its models answer,
and offers only the ones that do. More of 1.8 follows in further candidates.

### Added

- **Models are checked automatically.** The background worker asks every chat
  model that is switched on for one word: soon after the model is added, then
  every six hours (`MODEL_HEALTH_INTERVAL_MINUTES`; `0` switches it off). It
  is the check the Test button of the Models page makes.
- **A model that fails its check is left out**: of the model lists of chats,
  projects, agents and settings, of the list of the public API
  (`GET /api/v1/models`) and of the automatic choice of the cheapest model.
  When a check passes again it is back. Nothing is switched off or deleted:
  the Models page shows the model as "left out of the lists", with what its
  provider said.
- A failing model is asked again after 15 minutes, then after twice as long
  each time, up to the interval, so that a model whose limit has passed comes
  back soon and one without credit is not asked all day. A model that worked
  and is limited or busy for a moment is asked once more after 20 seconds
  before it is taken away.
- **Check all now** on the Models page, and `GET` / `POST /api/models/health`
  for administrators: how the check is set, what the last round found, and a
  round on demand (all models, or the ones named).
- The audit log says when the check took a model away
  (`model.health.hidden`) and when it gave one back (`model.health.restored`).
- `workforce.py --skill-url <address>`: a skill file at an https address is
  fetched and uploaded as the Skills page does; the address of a file's
  page at MediaFire is followed to the file. `workforce.sh` also takes the
  address sealed for the node (`--skill-url-sealed`). A dry run fetches the
  file and names the skills it holds.

### Changed

- An agent that is set to a model which is not offered (switched off, or
  failing) shows that model in its form, with the reason, in place of an
  empty field. Saving the form changes nothing about it.
- What the app left out of an uploaded skill is said by its reason, with
  how many files and the first of them by name (host scripts).

### Not in it

- Image, video, speech and embedding models are not checked: a check would
  generate, and bill, a picture, a clip or a recording each time. They stay
  in the lists as before.
- An agent that is set to a failing model still asks it first, then its
  fallback: what an administrator chose by name is not overruled.

### Database

- One column, `models.check_failures`, added at the first start
  (`drizzle/0009_model_health.sql`).

## [1.7.0] - 2026-11-16

Skills, and owners. A skill is a way of working, written down once and read
by an agent with every task: uploaded as a `SKILL.md`, a `.skill` or a
`.zip`, or written on its page, and given to agents and to teams. An owner
is the account that manages the others. With them: a reviewer that is shown
the files it reviews, a way to cut a model list that has grown past what can
be used down to the models that answer, and a workforce file of sixteen
teams with a workflow and skills each. Two candidates of this release ran on
one real server; what was seen there, and what was not, is under Notes.

### Added

- **Skills.** A page where skills are uploaded, written, read with their
  files, switched off, downloaded and deleted. An upload is read by what it
  is: a Markdown or text file is one skill (front matter `name` and
  `description`, or the first heading and paragraph); a ZIP, whatever it is
  called, is the folders in it that hold a `SKILL.md`, each with its text
  files; a JSON file is one skill or a list. Only text is kept: an agent
  reads a skill and does not run it. What an archive holds beyond that
  (pictures, links, encrypted entries, paths that leave the folder) is left
  out and named. An archive is never unpacked to more than it announces, and
  one that announces more than 64 MB is refused before anything is unpacked.
  A skill of a name that is taken is refused, or replaces it when asked to,
  and then stays with the agents and teams that have it.
- **Skills of agents and of teams.** An agent has its own skills, and those
  of the project's team while it works there. They follow its instructions
  in every task, its own first, each in full while there is room (16,000
  characters a skill, 40,000 together); what does not fit is named with its
  description. An agent with tools gets `read_skill` for the rest of a long
  skill and for a skill's files, and reads only the skills it was given. The
  one who plans a project sees each agent's skills by name, and the reviewer
  reviews by its own and the team's.
- `GET` and `POST /api/skills`, `POST /api/skills/upload` (the file as the
  body, its name in `x-file-name`, `?onConflict=replace`), `GET`, `PATCH`
  and `DELETE /api/skills/{id}`, `GET /api/skills/{id}/files?path=`, and
  `GET /api/skills/{id}/download` (a `.skill`, or `?format=md`). Agents and
  teams take and give `skillIds`. Every signed-in user reads skills; an
  administrator changes them, and each change is in the audit log.
- **What a provider's list says a model costs.** Model discovery passes on
  the prices in a provider's list, and whether the provider counts a model
  as free, in the forms gateways use (a price per token as text with `"0"`
  for a free model, `isFree`, a price per million tokens with
  `usage_based_only`). A model that is imported gets the listed prices.
- **Known providers to start from.** The form for a new provider can be
  filled from a list: four providers that take no key, nine that give a
  free key, and two paid ones, each with its address, how it signs in, where
  a key is made and what it gave for nothing when the list was read
  (2026-11-15). The list is words in the form: no provider is added or
  called by it.
- `workforce.py --only-usable`: looks at every model that is switched on and
  that the file does not name, and switches off the ones that cannot be
  used: a model a provider without a key bills for (by the provider's list,
  without a request), and a chat model the provider refuses one word (no
  access, no credit, no such model). A model that is limited, busy or slow
  at the moment stays and is listed. Nothing is deleted.
- `workforce.py` reads **skills** from the file: a folder with a `SKILL.md`
  next to it, or the words themselves. It adds them, changes them with
  `--update` when a word differs, and gives each agent and team the skills
  the file names for it. The skills an agent or a team was given by hand
  are kept: the file adds skills and takes none away.
- **Sixteen teams** in the committed `workforce.json`, each with a workflow:
  software, short reels, product videos, brochures and catalogues, online
  stores, landing pages, Minecraft Java plugins, Bedrock add-ons, Minecraft
  server setups, custom Minecraft features, Pterodactyl Panel and Wings
  installations, Discord bots, social media carousels, SEO articles,
  proposals, and work on Xiero Nexus AI itself (the people of the Software
  Team with the owner's skill for it). Fifteen more agents for them,
  twenty-six in all.
- **Twenty skills** in `scripts/host/skills`, a folder each: design and copy
  that do not look machine-made, online stores, web build quality, SEO,
  product videos, short reels, brochures and catalogues, picture prompts,
  social media content, Paper plugins, Bedrock add-ons, Minecraft server
  setup, what makes a Minecraft product worth paying for, Pterodactyl Panel
  and Wings, Linux server hardening, Discord bots, technical writing,
  proposals, and reviewing.
- A fourth provider without a key in the file: Pollinations, with the one
  model its old open API still serves.
- `over-ssh.sh` and the Deploy workflow send the `skills` folder to the node
  with `workforce.json`.
- CI puts the file with its skills into the built app, runs **every**
  workflow of it to the end in a project of the team that names it, and
  tries `--only-usable` on a gateway that lists billed, refused, limited and
  free models.
- **Owners.** A third role above the administrator. An owner makes accounts
  with their role and first password, changes a username, an email, a
  password and a role, switches an account off and on, switches a lost
  second factor off, signs an account out everywhere, and deletes it. The
  first account of an installation is its owner. An installation from before
  has none: when its database is opened by this version, its first
  administrator becomes the owner, and the audit log says so
  (`system.owner.assigned`).
- **One's own username, email and password** are changed under Settings,
  each time with the current password. A new password signs every other
  session out.
- `POST /api/admin/users`, `DELETE /api/admin/users/{id}`, and
  `PATCH /api/admin/users/{id}` with `username`, `email`, `password`,
  `resetTwoFactor` and `signOut` beside `role` and `status` (owners);
  `PATCH /api/account/me` (one's own account). No password is in an answer
  or in the audit log; what changed is, by name.
- `workforce.py --account <name> --account-email <address> --account-role
  owner|admin|user`: an account the app is to have. Its password comes in
  `NEXUS_ACCOUNT_PASSWORD`. The program signs in as an owner for it and does
  not change the account it signs in as.
- **Skills of your own** in the workforce file: `"name": {"uploaded": true}`
  names a skill that is uploaded to the app and is not in the file, or in a
  repository others can read. Agents and teams that name it get it when the
  app has it. `workforce.py --upload-skill <file>` uploads one as the Skills
  page does.
- **Sealed for the node.** A password or a skill that has to pass the
  options of a workflow in a public repository is sealed with a key of the
  node and opened only there: the action `input-key` of `over-ssh.sh` and of
  the Deploy workflow makes the key and prints its public half,
  `sealed-output.sh seal-line` seals, and `workforce.sh` takes
  `--account-password-sealed` and `--skill-sealed`.
- `workforce.py --account` signs the account in once with the password that
  was given, and out again: that an account is there says little when
  nobody can use it.
- `workforce.py --try-run` says why a reviewer did not pass a project.

### Changed

- **The reviewer is shown the files.** It was given what each agent said at
  the end of its task, cut at 2,000 characters, so an agent that wrote a
  file with a tool and answered "I wrote the file" was failed for a file
  the reviewer never saw. It is now given the files of the project's
  workspace as well, with the room shared between tasks and files (8,000
  characters each, 64,000 together), every cut said, and the files each
  task wrote named. A file that a deliverable already holds is not shown
  twice, and that deliverable is marked as being the file: told that a task
  has a file and shown none under that name, a reviewer took the file for
  missing.
- **A task's output file holds the file.** An agent that can write files is
  told to save its output file itself and then to say in a few lines what
  it did; the file keeps what the agent saved, where the closing words used
  to replace it, and the task hands over the file followed by those words.
  An agent that saved its file and then said nothing has done its task. An
  agent without that tool is told that its answer is the file, and an
  answer that holds the file in a code fence is saved without the fence and
  the words around it (a document keeps its own code blocks).
- A model that turned its tools down is no longer told that it has them.
- The manager is given the files of the workspace by name and size when it
  sums a project up, so that it can say where a deliverable is, and is told
  that it works from the task outputs alone and never makes up what a file
  contains. Given the names without that, a model began its summary with
  thoughts on how to open them.
- **Administrators no longer change accounts.** They changed roles and
  switched accounts off; an owner does that now, and administrators see the
  accounts. The first administrator of an installation is its owner.
- `workforce.py` signs in as an owner as well as an administrator. The one
  of 1.6 asks for an administrator by that word and does not sign in to this
  version with the owner's account.
- `tryRun.everyAgent` gives a task to each agent of the try-run's team when
  it names one, and to each agent of the file otherwise: twenty-six agents
  are more requests than the free tiers allow in an hour.
- The reel's caption asks for 3 to 8 hashtags, as the skill of that team
  says.

### Notes

- **On the real server.** The upgrade from 1.6.0 to the first candidate and
  from there to the second, each by the upgrade action with its backup; the
  four new tables; the first administrator as the owner after the start of
  the second. The workforce of the file: 20 skills, 15 agents, 13 teams and
  13 workflows added and the earlier ones changed, the fourth provider
  without a key, one word from each of the eleven chat models of the file.
- **Only what can be used**, on that server: 31 chat models were asked for
  one word. 13 answered and stay on. 526 that a provider without a key
  bills for were switched off by the provider's list, without a request,
  and 9 that the provider refused: seven of Claude, whose key has no
  credit, and two of Gemini that are no longer offered. 9 were limited at
  that moment and stay as they are; 9 models for pictures, speech and
  listening were not asked.
- **The reviewer.** With the first candidate the reviewer's verdict was
  "fail" in both projects of the try-run, for a file it was not shown: it
  was given the sentence "I wrote README.md". With the second it judged the
  file: "concerns", with two findings in the README's own words (a default
  that two tables state differently, a configuration without its keys). In
  the try-run's other project it took a file whose content it had been
  shown as the deliverable for "not shown", and the manager began that
  summary with its thoughts on files it could not open. What the reviewer
  and the manager are told was changed for both (see Changed); those two
  changes were not seen on a server when this was released.
- **After the release, on that server with 1.7.0:** the try-run again. The
  reviewer quoted the file of a task whose deliverable was that file, and
  judged it; the manager summed the tasks up without a word on opening
  files. The verdicts were "concerns" for the planned project, with
  findings in the README's own words, and "fail" for the project that asks
  each agent for one sentence: a reviewer with the skills of a product team
  does not pass a sentence as a specification. That check shows each agent
  at work with its model and its tools, and its verdict says nothing more.
- **An owner's account and two skills of the owner's own** reached that
  server sealed for the node, through the options of a workflow anyone can
  read, and the account signed in with its password there.
- What a task saves as its output file was tested against the mock, whose
  agents answer as the tests script them. How real models hand over files,
  and how often a fence is taken off wrongly, is not known.
- Anyone who can reach the site can still register an account of their own,
  as an ordinary user: there is no switch for that yet.
- Seen on the real server with 1.6.0, after the release: the waiting at work
  with a provider. Kilo Gateway answered "sign up for free or come back
  later" for all its free models. A request to a model was asked again for
  85 seconds, and the next requests to that model were not waited for; each
  of the eleven agents' small tasks went on with the agent's second model and was
  done there, nine of them on models of OVHcloud, which allow two requests a
  minute. The project took ten minutes instead of a minute and a half. The
  app does not record a request that is sent again, so that the waiting let
  those tasks through at OVHcloud is concluded, not seen.
- Kilo Gateway's allowance without a key was used up after about a hundred
  requests of these tests in three quarters of an hour (what else was asked
  from that address is not known); its documentation speaks of 200 an hour.
  `workforce.json` says so now. Its answer then is "sign up for free": an
  account there gives a key, which the provider takes on the Providers page
  (the `workforce` action leaves how a provider signs in as it is).
- **How well a model follows a skill was not measured.** The checks show
  that a skill reaches the agent, the planner and the reviewer, and that its
  files can be read; no project was judged with and without one.
- The skills were written for this file. They say how the work is done and
  what must not be invented, and leave what changes with each release
  (versions, package names, flags) to the official documentation, which
  they tell the agent to read. They are untried as skills.
- The agents of the new teams write documents and files. On a server
  without a sandbox runner they compile nothing and run nothing, and no
  workflow touches a customer's machine: each ends with a test list, a
  checklist or a review for a person.
- One more provider without a key was looked at and not added: by a list
  that probes such providers twice a week, its only model with tools has
  asked callers without a key for one since 2026-11-05.

### Upgrading

- When 1.7 starts, the database gets four tables for skills, and the first
  administrator of the installation becomes its owner (the audit log says
  which account). Nothing has to be configured.
- Administrators no longer change roles or switch accounts off: an owner
  does. They still see the accounts.
- **Going back to 1.6 means putting the backup of the data back**, as
  `pterodactyl-upgrade.sh --restore` does: 1.6 does not know the role of an
  owner and would treat that account as an ordinary user.
- Use the host scripts of the same version as the app: `workforce.py` of 1.6
  asks for an administrator by that word and does not sign in to 1.7 with
  the owner's account.
- On a server that got the file of 1.6, the `workforce` action adds the
  skills, fifteen agents, fourteen teams, thirteen workflows and one
  provider. With `--update` it also gives the earlier agents and the reel
  team their skills and changes the reel's caption step. The models the file
  no longer names stay as they are; `--only-usable` switches off the ones
  that cannot be used.

## [1.6.0] - 2026-11-15

Providers that cost nothing, and what it takes to work with them: the app
waits and asks again when a provider says "too many requests", an agent keeps
its tools when that happens, a review is still written when the reviewer's
first model is busy, and every attempt of a task can be read afterwards. Also
in this release: the scripts that install, upgrade and set up the app on a
Pterodactyl node, by hand or from GitHub Actions. The new parts of the app
were tested against the local mock of the providers' APIs; what was done on a
real server is said under Notes.

### Added

- **Waiting for a provider that says "not now".** A request to a model
  provider that is answered with 429 (too many requests) is sent again: after
  the wait the provider asks for, or after 3, 10, 25 and 45 seconds when it
  names none, up to four times and two and a half minutes in all. A provider
  that says it is busy (503, or 529 at Anthropic) is asked again twice. A
  model that was waited for in vain, because its quota for the day is used
  up, is not waited for again for five minutes, then for longer, until it
  answers. `PROVIDER_RETRIES` sets how often a request is sent again (0 to
  8; 0 turns it off). Until now one such answer ended the attempt, and a
  tier that allows two requests a minute ended a project with it.
- **Every attempt of a task.** `GET /api/projects/{id}/attempts` lists, for
  the tasks of a project's last run, each model that was asked: the agent,
  the model and its provider, how long it took, the model calls and tool
  calls, and what the provider said when it failed. A task itself shows only
  its last error.
- **Deploying from GitHub Actions.** The workflow *Deploy to a Pterodactyl
  node*, started by hand, runs the host scripts on the node over SSH: a look
  at the node, the plan of an upgrade, the upgrade, or the disk report. It
  signs in with the repository's secrets `VPS_HOST`, `VPS_USER` and
  `VPS_PASSWORD` or `VPS_SSH_KEY`. The log of a public repository can be read
  by anyone, so what the node says is not printed there; it stays on the
  node, and can come back sealed for the holder of a key. See
  [scripts/host](scripts/host#from-github-actions).
- `scripts/host/over-ssh.sh` does the same from any machine. The script it
  starts on the node does not depend on the connection: when that is lost in
  the middle, an upgrade still finishes or goes back by itself, and
  `last-log` shows how it ended. The node's host key can be given, so that
  nobody else can answer in its place.
- **A first installation from the node**, `scripts/host/pterodactyl-install.sh`:
  for a server that was made in the panel and does not have the app yet. It
  downloads and checks the bundle for the Node.js of the server's image,
  writes `.env` with a new key and a password for the first administrator
  (neither is printed), and starts the server. For the common Node.js egg it
  writes the file that egg starts, a few lines that run the bundle with plain
  Node.js, and can move the source code that egg cloned into one folder. It
  deletes nothing and overwrites nothing. The workflow and `over-ssh.sh` have
  the actions `install-plan` and `install` for it.
- `pterodactyl-upgrade.sh --start` starts a server through Wings and waits
  until the app answers, without upgrading anything.
- `scripts/host/node-check.sh`: a read-only look at a node. It says whether
  Wings and Docker are there, which servers hold the app, what is in one
  server's files, what that server runs when it starts, and how the site's
  address is answered on the machine, without showing a setting's value.
  With `--try-image` it says what the server's image holds.
- **The public address**, `scripts/host/nginx-site.sh`: a site in the node's
  nginx for a name, with a certificate from Let's Encrypt (certbot), passed
  on to the port the panel gave the server. It adds one file and leaves the
  other sites as they are: it changes no file it did not write, reloads
  nginx only with a configuration nginx accepts without a new kind of
  warning, listens the way the sites that are there do, does not become the
  site for names nginx does not know, and takes its file out again when a
  step fails. The workflow and `over-ssh.sh` have the actions `site-plan`
  and `site` for it, and after `site` the runner asks the site from the
  outside with the certificate checked.
- **The workforce from a file**, `scripts/host/workforce.sh` with
  `workforce.py` and `workforce.json`: signs in to the running app as its
  administrator and adds the models, agents, teams and workflows the file
  names, through the app's own API. A provider that takes no key is added
  too; one that takes a key is not, since the program has none. What is
  there under the same name is reported and changed only with `--update`;
  nothing is deleted, and a model the file marks so is switched off.
  `--test`, `--test-all` and `--test-media` try the models with one small
  request each, which is the only way to learn that a model its provider
  lists can be called. `--try-run` has the agents do a small project, and
  with `everyAgent` gives each of them a task of its own; it says which
  model answered each task and what the others said. The workflow and
  `over-ssh.sh` have the actions `workforce-plan` and `workforce` for it.
- **A workforce that costs nothing**, in the committed `workforce.json`:
  eleven agents, two teams, and the workflows "Software delivery" and "Short
  Reels" (a vertical video of four pictures under their voice-overs, for
  providers without a video model), on free models. Each agent has its first
  model with Kilo Gateway; nine have their second with OVHcloud AI
  Endpoints and two with Gemini, on a key without billing, which also gives
  the voice. Kilo Gateway and OVHcloud take no key. LLM7, a third provider
  without a key, is added for models to pick by hand. What these providers
  allow is little, and what is sent to two of them may be logged: see
  [scripts/host](scripts/host#providers-that-cost-nothing).
- CI runs these against an SSH server on the runner itself, as a plain user
  with a key and as root with a password and through sudo, installs each
  bundle on a made-up Pterodactyl host, started through `ts-node` the way the
  common Node.js egg starts it, and sets a site up in a real nginx on the
  runner, next to other sites, with stand-ins for certbot and Let's Encrypt.
  It also puts the committed `workforce.json` into the app it built, with
  the mock providers, runs both workflows in a project, and does the file's
  try-run with a model that says "too many requests" every other time. No
  test signs in to a real node or asks a real provider.

### Changed

- **An agent keeps its tools when its model is limited or busy.** A first
  request that failed was taken to mean that the model takes no tools, and
  the same model was asked again without them. That is now done only when
  the request was refused (400, 404, 422). After "too many requests", a busy
  or broken provider, or no answer in time, the agent's next model is asked,
  with the tools.
- **A review is asked of the reviewer's next model** when its first does not
  answer, and then of the project's manager model, the way a task is. Before,
  a reviewer whose first model was busy left the project without a review.
- Only requests to model providers are sent again. Web pages an agent reads,
  webhooks, the sandbox runner and Git hosts are asked once, as before.

### Notes

- The host scripts were used on one real node on 2026-11-15: an
  installation, the check, the disk report, one upgrade that installed the
  same version again and one from 1.5.0 to the release candidate of this
  version, and the site in nginx with a certificate from Let's
  Encrypt, which the runner then saw answer from the outside. Going back by
  itself after a failed start has still only run against the stand-in for
  Wings, and taking a site out of nginx again after a failed step only in
  the test.
- When the site does not answer from the outside after an upgrade, the
  workflow's warning now says what was in the way (the name is not known, no
  connection, a certificate that is not accepted).
- Free models were tried on one real server on 2026-11-15, first with
  1.5.0, then with the release candidate of this version, whose program is
  the same. With the candidate, and the agents as the file has them but for
  the second model of two: every chat model of the file answered one word;
  the image model made a picture, which was joined with a spoken sentence; a
  project that a model planned ended as succeeded, with both its tasks done,
  a summary and a review; and a project that gave each of the eleven agents
  one small task ended with all eleven done at the first attempt, ten of
  them with a tool call, and a review. With 1.5.0 the planned project had
  ended twice with a task failed after "too many requests", and without a
  review.
- Whether a request was sent again in those projects cannot be seen from
  the outside, so **the waiting itself has been tested against the mock
  only**. What was seen on the server: a model whose allowance for the day
  was used up was passed over, and the task went on with the agent's next
  model and was done.
- The free models change, within a day. Of the models these providers
  listed as free: three did not serve (limited by their provider, or minutes
  for one word); Qwen3.5-397B at OVHcloud answered in seconds at times and
  not within five minutes at another, and is not in the file; the allowance
  of LLM7 without a key was used up after a few tasks, so no agent depends
  on it; its picture models answer "missing API key"; and the free English
  voice of OVHcloud wants another audio format than the app asks for.

### Upgrading

- Nothing has to be configured, and the database is not changed: 1.5 can
  open it again.
- A request that a provider keeps answering with "too many requests" now
  fails after the waits, up to two and a half minutes later than before; the
  requests to that model in the next minutes fail at once, as before.
  `PROVIDER_RETRIES=0` in `.env` gives the old behaviour throughout.
- `scripts/host/workforce.json` now describes a workforce on free providers.
  On a server that got the earlier file (agents on Claude and Gemini), the
  `workforce` action with `--update` moves the agents to the free models;
  without `--update` it adds the providers and models and reports the agents
  as different.

## [1.5.0] - 2026-11-15

Runs that go on in the background, tools and memory for agents, a knowledge
base, voice-over and joined videos, two more provider adapters, and an API.
As before, everything that talks to a provider was tested against a local
mock of the providers' APIs, written from their public documentation, and
**not against a live provider**. The two scripts for a Pterodactyl host were
tested against a stand-in for Wings, **not on a real node**. The README
describes each part under "Automation, tools and knowledge".

### Added

- **Runs in the background.** A project run is carried out by a worker inside
  the server instead of by the page that started it. It goes on when the page
  is closed, can be followed from any browser, and is picked up again after
  the server restarts. Three runs work at the same time (`RUN_CONCURRENCY`);
  further ones wait their turn.
- **Run history.** Every run of a project is kept with what it delivered. A
  run can be given an instruction of its own, and with *Memory* switched on a
  run is told what the earlier runs delivered.
- **Schedules.** A project can run by itself, at the times a cron expression
  names in a time zone, with an instruction for those runs. The form says the
  schedule in words and shows the next times.
- **Notifications.** A bell in the dashboard says when a run finished, failed
  or waits for approval, when a joined video is ready, and when something in
  the background went wrong. Each user can also have them sent to a
  **webhook**, signed with a secret.
- **Tools for agents.** An agent can be allowed to list, read, write, edit and
  delete files of the project's workspace, run commands in the sandbox runner,
  read web pages, call HTTP APIs and search the web (Brave, Tavily or
  SearXNG). It then works in steps, up to a limit set per agent, and every
  call is shown under its task. Needs a model that supports tool calling, on
  the OpenAI-compatible, Anthropic or Gemini adapter.
- **Memory for agents.** An agent with memory can keep short notes and look
  them up in later runs.
- **Knowledge base.** Collections of documents (pasted text, files, web
  pages) that agents and the chat can look things up in. Text, Markdown, CSV,
  JSON, HTML, PDF and .docx files are read. Search by words works at once and
  without a model; with an embedding model on the collection, search also
  goes by meaning.
- **Voice-over.** Text to speech in Creative Studio and as a task in
  projects, for speech models on the OpenAI-compatible and Gemini adapters.
- **Joining clips into one video.** Clips and still images are joined in
  order into one MP4, with voice-overs laid over them and, if wanted, their
  words as subtitles. This is done on the server and needs ffmpeg 4.2 or
  newer there (`FFMPEG_PATH`); without it everything else works and the page
  says what is missing.
- **A video can start from an image**: one from the library, or an uploaded
  one.
- **Reel template: voice-over and final cut.** The template can add a
  voice-over per scene and a last step that joins everything into one
  vertical video with subtitles.
- **Google Gemini adapter**: chat with streaming and tools, embeddings, image
  generation, speech, and model discovery.
- **Custom HTTP adapter**: chat with a JSON API that follows none of the
  known protocols. The provider's configuration says how a request is written
  and where the answer is in the response.
- **Tool calling** on the OpenAI-compatible and Anthropic adapters, and
  **embeddings** on the OpenAI-compatible adapter.
- **An API for other programs**, under `/api/v1`, in the format of OpenAI's
  API: models, chat completions (with tools and streaming), embeddings,
  images, speech and videos, plus starting project runs and reading their
  results. Access is by **API keys** made under Settings, each limited to
  what it may do, optionally to certain models, a number of requests a
  minute, and a number of tokens and an estimated cost a month.
- `GET /api/health` answers without signing in: `{"status":"ok"}` when the
  server and its database work. For uptime checks.
- Models have a price per million characters, for the cost estimate of
  speech. Usage & Costs lists speech and embedding requests.
- The status page (Observability) shows the background worker and what is
  waiting, and whether ffmpeg, the sandbox runner and a search provider are
  set up.
- **Two scripts for a Pterodactyl host**, in `scripts/host/`: one upgrades
  the app on a server from the node, with a backup, and goes back by itself
  when the new version does not come up; the other makes a read-only report
  of what fills the node's disk. See [RELEASING.md](RELEASING.md).
- `npm run test:e2e` now covers all of the above (about 590 checks) and the
  Anthropic adapter, which had no mock in this repository before. It can
  also click through the dashboard in a headless browser.

### Changed

- A video in progress is now checked on by the server, whether a page that
  shows it is open or not.
- The server stops within a few seconds when it is told to (the Stop button
  of a hosting panel, `docker stop`), also while pages are connected to it.
  Before, an open connection, such as a page following a run, could hold the
  stop until the panel killed the process.
- Dates and times are shown in the reader's own time zone and language, and
  "5m ago" stays current while a page is open.
- Model discovery sets the type of a model it recognises by its name as an
  image, video, speech or embedding model, marked as unverified. Before,
  every discovered model was imported as a chat model.
- A release bundle now carries a font for subtitles and the PDF reader, and is
  about 8 MB instead of 7 MB.
- CI runs the end-to-end checks and the tests of the host scripts.

### Fixed

- A project that was running when the server stopped stayed "running" for
  good and could not be run again. Runs are now picked up after a restart,
  and a project that an older version left like this is ended about a minute
  after the upgrade, with the message "The server stopped while this project
  was running. Run it again."
- The Copy button for recovery codes did nothing on a site opened over plain
  HTTP.
- An image or video model found by discovery showed up in chat and could not
  be chosen in Creative Studio until its type was set by hand.
- Some pages logged an error in the browser's console when the reader's time
  zone or language was not the server's.
- Buttons in page headers wrapped onto several lines on narrow screens.

### Upgrading

- The database is updated on the first start. **Back up `data/` first**: a
  database that 1.5 has opened cannot be used by 1.4 again.
- On Pterodactyl, `scripts/host/pterodactyl-upgrade.sh` does the upgrade with
  a backup; see "Upgrading on Pterodactyl" in [RELEASING.md](RELEASING.md).
- Set `APP_URL` to the public address of the site. Links in webhook messages
  and the file links the API returns are built from it.
- Nothing has to be configured for the new parts to appear. Joining clips
  needs ffmpeg on the server; web search needs `SEARCH_PROVIDER` and a key;
  running commands needs the sandbox runner, as before. The new settings are
  in `.env.example`.
- Agents keep working as before until they are given tools.

## [1.4.0] - 2026-11-12

Creative Workflows: image and video generation. It was tested against a local
mock of the providers' APIs, written from their public documentation, and
**not against a live provider**; the same goes for the Anthropic adapter. Setup
and limits are in the README under "Creative Workflows" and "Provider
adapters".

### Added

- Image and video generation through the gateway, for providers on the
  OpenAI-compatible adapter. A provider has a new **Image / video API** setting
  (Auto, OpenAI-style, OpenRouter, xAI) that says how its media requests are
  written.
- **Creative Studio**: write a prompt, choose a model, an aspect ratio, and
  the number of images or the length of a video, see a cost estimate, and
  generate. A video shows as in progress until the provider has finished it.
- **Media library**: generated files are stored on the server and can be
  previewed, played, downloaded, reused and deleted. Users see their own media;
  administrators can see everyone's. `MEDIA_PATH` sets the folder; the default
  is `media` next to the database file (`./data/media`).
- Models have a **Model type** (chat, image generation, video generation) and
  a price per image and per second of video, used for cost estimates. The new
  capability is *Video generation*.
- Projects can have an **image model**, a **video model** and a **media
  limit**. A task can then deliver an image or a video: its agent writes the
  prompt and the project's model generates the file, which is shown in the
  project. A running task says what it is doing.
- Workflow steps can deliver an image or a video, with an aspect ratio, a
  length and a resolution, and have a field for acceptance criteria.
- **Reel template** in the workflow builder: concept and script, storyboard,
  one vertical clip per scene, a cover image, and a caption with hashtags. The
  clips are separate files; they are not joined into one video.
- Usage & Costs lists image and video requests, with an estimated cost when
  the model has a price.
- `npm run test:e2e`: end-to-end checks of image and video generation against
  a mock provider that is part of the repository (`scripts/e2e/`).
- Anthropic provider adapter. A provider on the `anthropic` adapter can be
  tested, have its models discovered, and be used for chat (streaming
  included), agents and project runs, through Anthropic's Messages API with
  API version `2026-10-21` by default. Text chat only; temperature is not
  sent, because that API version rejects it.

### Changed

- A model marked *Image generation* (or *Video generation*) and not *Text* is
  now an image or video model: it is offered in Creative Studio and for media
  tasks, and no longer for chat, agents, the AI Manager or automatic routing.
  Earlier versions did not act on the mark, apart from automatic routing by
  capability. **After upgrading**, if a chat model carries that mark without
  *Text*, open Models, choose Edit and tick *Text*. Until then, an agent that
  uses such a model is answered by the project's manager model in project
  runs.
- Creating a project with a workflow that does not exist is refused. Before,
  the project was created and every run of it failed.
- The workflow builder renumbers "depends on" when a step is moved or removed.
  It no longer drops an unfinished step without saying so, and refuses a step
  that depends on a later one.

### Fixed

- Project runs: a task now receives the output of the tasks it depends on.
  That context was always empty before, so a task saw only its own objective.
- Opening some dashboard pages while signed out logged an error on the
  server, although the browser was correctly sent to the sign-in page.

### Upgrading

- The database is updated on the first start, as always. Generated files are
  kept in `data/media/`, so include that folder in backups.
- Existing projects have no image or video model, and a project's models are
  chosen when it is created: make a new project for media tasks.

## [1.3.1] - 2026-11-11

### Fixed

- `get-release.mjs` no longer depends on the GitHub API for the newest stable
  release, an exact version or `dev`. It uses GitHub's plain download links
  there, so it keeps working when the API's small anonymous allowance for a
  network address is used up. The `rc`, `beta` and `alpha` channels and
  `--list` still ask the API.

### Changed

- `get-release.mjs` rejects a word that is neither a channel nor a version,
  instead of searching for it.

## [1.3.0] - 2026-11-11

First published release. It includes everything from the 1.0.0–1.2.0
development milestones, which are listed further down in CHANGELOG.md.

### Added

- Parallel task execution: independent tasks run concurrently in
  dependency-ordered waves, capped by a per-project `maxParallel`.
- Per-project token budget, task limit and parallelism limit. A run stops and
  cancels its remaining tasks when the token budget is exceeded.
- Approval policy: a project can require an admin's approval before each run.
- Observability dashboard with per-agent run metrics (runs, success vs error,
  average latency, tokens) and recent agent runs.
- Automatic model routing: an agent in `auto` mode uses the cheapest enabled
  model, optionally restricted to a required capability.
- Step-based workflow builder: reusable ordered plans a project can run instead
  of AI-Manager planning.
- Releases: every push publishes ready-to-run bundles for Node.js 20 and 22
  (Linux x64). Each version gets a GitHub Release on the channel its suffix
  names (stable, rc, beta, alpha), and `dev-build` always holds the newest
  commit. See RELEASING.md.
- `get-release.mjs` downloads a release by channel or version and verifies its
  checksum.
- The dashboard shows the running version, channel and commit.
- `COOKIE_SECURE=false` allows sign-in over plain HTTP, for deployments without
  HTTPS.

### Fixed

- In production, signing in on a plain `http://` address silently did nothing,
  because browsers drop HTTPS-only cookies there. The sign-in and registration
  pages now say so and explain what to change.
- A production instance without a valid `SECRET_ENCRYPTION_KEY` now fails
  early, instead of later when a provider key is first stored.

### Removed

- `SESSION_SECRET`. It was documented as required but was never used; delete it
  from `.env`.

## [1.2.0] - 2026-11-11

Development milestone, published as part of 1.3.0.

### Added

- Project workspaces with path-validated file management.
- Sandboxed code execution through an external isolated runner. Code never runs
  on the application host; execution is disabled unless `SANDBOX_URL` is set.
  A reference runner lives in `sandbox-runner/`.
- Execution guardrails: command allowlist, shell-metacharacter rejection,
  per-run timeout and output caps.
- Workspace version snapshots (commit and restore).
- QA/Security review step after each run, and an optional hard QA gate that
  keeps a project in `review` unless the reviewer's verdict is `pass`.
- Remote Git: push the workspace to a GitHub repository as one commit through
  the GitHub Git Data API. Not yet tested against a live repository.

## [1.1.0] - 2026-11-04

Development milestone, published as part of 1.3.0.

### Added

- Agents (role, instructions, primary and fallback model, temperature) and teams.
- AI Manager orchestration: plans a goal into tasks, assigns them to agents and
  runs them in dependency order, with bounded attempts and cancellation.
- Task states, artifacts and per-attempt agent runs, with live progress over
  server-sent events.

## [1.0.0] - 2026-11-03

Development milestone, published as part of 1.3.0.

### Added

- Username/email/password authentication with scrypt hashing and database-backed
  sessions.
- Optional per-user two-factor authentication (TOTP) with single-use recovery
  codes.
- Admin and user roles enforced on every protected endpoint.
- Provider management with API keys encrypted at rest (AES-256-GCM) and never
  returned to the browser.
- SSRF protection for provider Base URLs.
- Model catalog with discovery, manual registration, capabilities and tests.
- Model gateway with an OpenAI-compatible adapter and streaming chat.
- Usage and estimated-cost tracking, and an audit log.
