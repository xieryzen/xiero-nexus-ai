---
name: minecraft-server-setup
description: How to plan, configure, secure and hand over a Minecraft server (Java with Paper and its forks, a proxy network, or Bedrock players through Geyser). Use for server setup, optimisation, plugin stacks and launch checklists.
---

# Setting up a Minecraft server

The owner wants a server that stays up, does not lag, cannot be griefed by a stranger and can be restored after a mistake. Decide each of these on purpose and write it down.

## 0. Versions and sources

- Use the Minecraft version the task names; otherwise the current stable release that the needed plugins support, and say which you assumed.
- Settings and their file locations move between releases. If you have `fetch_url`, read the current pages before you rely on memory: `https://docs.papermc.io/` (Paper, Velocity, Folia: configuration reference, start-up flags, security), `https://geysermc.org/wiki/` for Bedrock players, and each plugin's own documentation. Say what you could not verify.
- Never write a long list of JVM flags from memory. Take the recommended flags from the Paper documentation, quote where they came from, and change only the memory values.

## 1. Intake: ask or assume, and write it down

- Edition and version; game mode (survival, skyblock, minigames, modded); expected players at peak.
- One server or a network (lobby plus game servers behind a proxy).
- Java only, or Bedrock players too.
- Where it runs: a panel such as Pterodactyl, a VPS, a home machine; RAM, CPU (single-thread speed matters most), disk type.
- Who administers it and how experienced they are.
- Budget for premium plugins: default to free and open-source ones.

## 2. Software choice (say why)

- **Paper**: the default for almost every Java server.
- **Purpur**: Paper with more gameplay switches; choose it when one of those is needed.
- **Folia**: for very large single worlds with players spread out; many plugins do not support it. Not a default.
- **Velocity** as the proxy for a network, with modern forwarding and its secret on every backend; backends not reachable from the internet.
- **Geyser and Floodgate** to let Bedrock players join a Java server; needs a UDP port (19132 by default).
- Vanilla or Fabric/Forge only when the task needs them; say what that changes.

## 3. Sizing

- Memory: the heap is smaller than what the host gives. Leave about 1 to 1.5 GB (or 15 to 20 percent) of the container's memory outside the heap, or the process is killed. Set the minimum heap equal to the maximum.
- A rough start: 4 GB heap for a small survival server of up to about 20 players with a modest plugin set; more for many players, large view distances, or heavy plugins. Say that the number is a starting point to be checked with a profiler.
- Pre-generate the world inside a world border before opening (for example with Chunky): chunk generation is the main cause of lag on a new server.

## 4. Configuration: the values that matter

Give each change as file, key, value and the reason, in a table. The usual levers:

- `server.properties`: `view-distance` and `simulation-distance` (lowering simulation distance is the cheapest performance gain), `online-mode`, `max-players`, `white-list` during setup, `enforce-secure-profile`, the port.
- Paper's world defaults: despawn ranges, per-tick limits on chunk saving, entity collision limits, item and experience merge, hopper and redstone options, anti-xray.
- `spigot.yml`: entity activation and tracking ranges, mob spawn range.
- `bukkit.yml`: spawn limits and how often spawning runs.
- Start with safe, documented values. Do not turn every knob: each has a gameplay cost, and you name it (farms slow down, mobs vanish sooner).

## 5. Plugin stack

Small and maintained beats large. For each plugin: what it is for, whether it is free, and what breaks if it is removed. A typical base:

- Permissions: LuckPerms, with groups designed first (default, member, moderator, admin) and no wildcard for staff.
- Protection and rollback: a region plugin and a block logger (for example WorldGuard and CoreProtect).
- Essentials (homes, warps, kits): one suite, not three overlapping ones.
- Economy bridge and placeholders when other plugins need them (Vault, PlaceholderAPI).
- A profiler (spark) from day one.
- Backups: an automated plugin or the panel's backup feature, plus copies off the machine.
- Anti-cheat only when it is an open server, chosen for the version, with its false positives named.

Check each plugin supports the server version before listing it.

## 6. Security

- `online-mode=true`, or behind a proxy with forwarding secured by a secret and the backend port closed to the internet. An offline-mode server reachable from outside can be joined as any name, including an admin's.
- Operators: as few as possible; staff get permissions through groups, not `op`.
- Firewall: only the game port (and the proxy's, and Geyser's UDP port when used) is open. Panel, database and RCON are not exposed; RCON off unless needed, with a long password.
- Secrets (forwarding secret, database password, RCON password) are generated, never written into documents: write `<generated>` and where it is stored.
- Updates: a policy for the server jar and plugins, and a test server or a backup before each update.

## 7. Backups

- What: world folders, plugin data folders, the database, the configuration.
- How often, how many are kept, where the off-site copy goes.
- A restore is rehearsed once before launch. A backup that was never restored is a hope.

## 8. On a panel

- State the egg or image and Java version, the start-up command with memory variables, the ports as allocations (TCP for Java, UDP for Geyser), and which files the owner edits in the file manager.
- The container's memory limit and the heap are set together (see sizing).

## 9. Legal

The owner accepts the Minecraft EULA (`eula=true`) themselves. Paid ranks and shops must follow Mojang's commercial usage rules (no selling of gameplay advantages). Say this once in the handover.

## 10. Launch checklist and handover

- Fresh start has no errors in the log. Profiler shows healthy tick times with test players or a pre-generated world.
- Join as a default player: can they do only what they should?
- Griefing test: break and place in spawn, in another player's claim.
- Kill the server process: does it come back, is the world intact?
- Restore yesterday's backup to a test server.
- Handover document: how to start, stop and update; where each config lives; the staff groups; the backup and restore steps; what to check when it lags (profiler first); what was assumed and not verified.
