---
name: minecraft-paper-plugin
description: How to design and write a Minecraft Java server plugin for Paper (and Spigot, Purpur, Folia) that a server owner can run in production. Use for any Bukkit-family plugin work, from a new plugin to a review.
---

# Paper plugins

A plugin runs inside someone else's server, on the thread that ticks the world. A mistake lags or corrupts a server with players on it. Write for that.

## 0. Versions

- Use the Minecraft and Paper version the task names. If it names none, pick the current stable Paper release, say which you assumed, and write `api-version` to match.
- APIs change between releases. If you have `fetch_url`, read the current page before you rely on memory: `https://docs.papermc.io/paper/dev/` (getting started, commands, scheduler, Folia) and the Javadoc it links. Say what you could not verify.
- Java version: the one the target Minecraft needs (21 for 1.20.5 and later).

## 1. Project layout

```
build.gradle.kts            Gradle Kotlin DSL; paper-api as compileOnly; Shadow only if libraries are bundled
settings.gradle.kts
src/main/java/<group>/<plugin>/
    <Plugin>Plugin.java     extends JavaPlugin: wiring only
    command/                one class per command
    listener/               one class per concern
    service/                the logic, free of Bukkit where it can be
    storage/                interface + implementations (YAML, SQLite, MySQL)
    config/                 typed access to config.yml and messages.yml
src/main/resources/
    plugin.yml              name, version, main, api-version, commands, permissions, softdepend
    config.yml              every option commented, with a config-version
    messages.yml            every message a player sees
```

- Repository `https://repo.papermc.io/repository/maven-public/`; dependency `io.papermc.paper:paper-api:<version>-R0.1-SNAPSHOT` as `compileOnly`.
- Libraries that are bundled (for example HikariCP) are shaded and relocated into the plugin's own package, so that they cannot clash with another plugin's copy.
- `plugin.yml` `version` comes from the build (`processResources` with `expand`), not typed twice.

## 2. Rules of the main thread

- The Bukkit API (worlds, blocks, entities, inventories, players) is used on the server thread only. Never from an async task.
- Anything that waits is never on the server thread: database, files, HTTP, DNS. Run it async, then come back with a sync task to apply the result.
- No `Thread.sleep`, no blocking `.get()` / `.join()` on the main thread.
- Folia has no single main thread. If the plugin declares `folia-supported: true`, use the region, entity and global schedulers instead of `Bukkit.getScheduler()`, and never touch an entity or block from another region's thread. If Folia is out of scope, say so and do not declare it.
- Work per tick is bounded: no scan over all entities or all loaded chunks every tick. Spread work over ticks, cache, or react to events.
- Event handlers do the least they can. Pick the priority on purpose; use `ignoreCancelled = true` unless a cancelled event matters; never cancel at `MONITOR`.

## 3. What makes a plugin fit for a paying owner

- **Nothing hard-coded**: every message in `messages.yml` (MiniMessage format, with placeholders such as `<player>`), every number in `config.yml`, each with a comment that says what it does and its unit.
- **A reload command** that re-reads config and messages without a restart, and says what it could not apply.
- **Config that survives updates**: a `config-version` key; on load, missing keys are added with defaults and the owner's values are kept; a file that cannot be parsed is not overwritten, the plugin says where the error is and stops cleanly.
- **Permissions for everything**, named `<plugin>.<area>.<action>`, declared in `plugin.yml` with sensible defaults (`op`, `true`, `false`), and listed in the docs.
- **Commands** with tab completion, help text, clear errors for wrong arguments, and a check of who runs them (player or console).
- **Storage behind an interface**: flat file or SQLite by default so it works out of the box; MySQL/MariaDB as an option with a connection pool; schema created and migrated by the plugin; UUIDs as player keys, never names.
- **Clean start and stop**: `onEnable` fails fast with one clear log line when something required is missing; `onDisable` saves, cancels tasks and closes pools. `/reload` of the server and plugin managers are not supported, and the docs say so.
- **Integrations are optional**: Vault, PlaceholderAPI and others as `softdepend`, checked at runtime, with the feature switched off and one log line when they are absent.
- **Text**: Adventure components and MiniMessage; no legacy section-sign colour codes in new code.
- **Data on items and entities** in the `PersistentDataContainer` with a `NamespacedKey` of the plugin, never in lore or display names.
- **An API for other plugins** when it makes sense: custom events and a small service interface.
- **Logs** that help: one line at start with version and storage type; warnings with what to do; no stack trace for an expected problem; a debug option.

## 4. Security

- Never build SQL by joining strings: prepared statements.
- Treat everything a player types, names, signs and book text as hostile input: length limits, no MiniMessage tags from players unless they are escaped or the tag set is restricted.
- A permission check on every command and every action a GUI click triggers; never trust the title of an inventory to identify a menu (hold the menu object).
- No code that downloads and runs anything. An update check only reads a version number, can be switched off, and never blocks start-up.

## 5. Deliverables

- Source that builds: every file complete, with package lines and imports; no `// ...` in place of code. If a part is left out, name it.
- `README.md`: what it does, requirements (server software and version, Java), installation, commands and permissions table, configuration reference, placeholders, how to build.
- A test plan (see below) and what was not tested: you cannot start a server unless you have a tool that does.

## 6. Testing

- Unit tests for the logic that does not need a server.
- MockBukkit tests for commands and listeners where they add confidence.
- A manual test list on a real Paper server: fresh install; reload; each command as player, as console, without permission; wrong arguments; a second player; restart in the middle of an action; missing optional dependency; a broken config file.
- Check timings with a profiler (spark) when the plugin does work on a timer.

## 7. Review checklist

- Any Bukkit call off the server thread? Any blocking call on it?
- Any message or number that is not in a file?
- What happens with 200 players, with a full inventory, with the player offline, with the world unloaded?
- Is every scheduled task cancelled and every connection closed on disable?
- Are player names used as keys anywhere?
- Does the config survive an update? Does a broken config stop the plugin without wiping the file?
- Is every claim in the README true of the code?
