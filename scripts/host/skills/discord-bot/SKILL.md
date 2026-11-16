---
name: discord-bot
description: How to design and write a Discord bot that is reliable, respects Discord's rules and limits, and can be deployed and handed over. Use for new bots, new commands and reviews.
---

# Discord bots

## 0. Versions and sources

- Use the library and version the task names. If it names none, use discord.js on a current Node.js LTS (or discord.py on a current Python when the client prefers Python), and say which version you assumed.
- Discord's API and the libraries change. If you have `fetch_url`, read the current guide before relying on memory: `https://discordjs.guide/` and `https://discord.com/developers/docs`. Say what you could not verify.

## 1. Design before code

- **Commands**: a table of slash commands with options, who may use each (default member permissions), and whether the reply is visible to all or only to the user.
- **Intents**: the smallest set that works. Reading message text, member lists and presences are privileged intents: they must be switched on in the developer portal and justified; prefer slash commands, buttons and modals, which need none of them.
- **Permissions**: the bot's invite link asks for the permissions it uses, not Administrator.
- **Data**: what is stored (per guild, per user), where, and how it is deleted when a guild removes the bot or a user asks.
- **Failure**: what the user sees when something goes wrong.

## 2. Structure

```
src/
  index.js            client, intents, loading of commands and events, login
  deploy-commands.js  registers slash commands (guild-scoped while testing, global for release)
  commands/<group>/<name>.js   one file per command: data (builder) and execute()
  events/<name>.js             one file per event
  lib/                         storage, helpers
.env.example          DISCORD_TOKEN, CLIENT_ID, GUILD_ID (for testing)
README.md
```

## 3. Rules that prevent the usual failures

- The token comes from the environment, is never in the code, the repository or a log. `.env` is in `.gitignore`; `.env.example` has names only.
- An interaction must be acknowledged within three seconds: reply at once, or defer and edit the reply when the work is done.
- Every command handler is wrapped: an error is logged with the command name, and the user gets a short private message that something went wrong.
- Check permissions and the bot's own role position before moderation actions; say clearly when the bot cannot act.
- Never mention everyone or roles from user input: set allowed mentions to none by default.
- User text is never executed, evaluated or used as a path. Limit lengths.
- Rate limits are the library's job; do not loop over members or messages with a request each when a bulk endpoint or a cache will do.
- Long-running state (cooldowns, open tickets) survives a restart when it matters: store it.
- Register commands with a separate script, not on every start.
- For many guilds: caches kept small, and sharding named as the next step with the point at which it is needed.

## 4. Deliverables

- Complete source files that run: no `...` in place of code.
- `README.md`: creating the application and bot in the developer portal, which intents to switch on, the invite link with scopes (`bot`, `applications.commands`) and permissions, environment variables, how to register commands, how to run.
- Deployment notes for where the client hosts it: a process manager or a container with restart on failure; on a game panel, the Node.js image, the start command and the variables. Logs go to standard output.
- A test list: each command with valid and invalid input, without permission, in a direct message, with the bot's role too low, after a restart.

## 5. Review checklist

- Any privileged intent that is not needed?
- Any path where an interaction is not answered in time?
- Any secret in code or logs?
- Can user input cause a mention, a crash or an unintended action?
- What happens when the database or Discord is slow?
