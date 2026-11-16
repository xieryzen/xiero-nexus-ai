---
name: minecraft-bedrock-addon
description: How to design and write an add-on for Minecraft Bedrock Edition (behavior pack, resource pack and scripts) that loads without errors and is ready to package. Use for any Bedrock add-on work, from a new add-on to a review.
---

# Bedrock add-ons

An add-on is data the game reads strictly: one wrong field name or version and the content silently does not load. Be exact, and say what you could not check in the game.

## 0. Versions

- Use the Minecraft Bedrock version the task names. If it names none, target the current stable release and say which you assumed.
- JSON `format_version` values, component names and Script API versions change between releases, and a component that was experimental becomes stable or is renamed. If you have `fetch_url`, read the current reference before you rely on memory: `https://learn.microsoft.com/en-us/minecraft/creator/` (the add-on documentation and the Script API reference). Say what you could not verify.
- Prefer stable features. If something needs an experiment toggle or a beta API, say which toggle, in the README, and offer the stable alternative.

## 1. Two packs, one add-on

```
<Name>_BP/                      behavior pack: what things do
    manifest.json
    pack_icon.png               (binary: list it, a person adds it)
    items/  blocks/  entities/  recipes/  loot_tables/  spawn_rules/  trading/
    functions/                  .mcfunction files
    scripts/main.js             when the add-on has scripts
    texts/en_US.lang, texts/languages.json
<Name>_RP/                      resource pack: what things look and sound like
    manifest.json
    pack_icon.png
    textures/item_texture.json, textures/terrain_texture.json, textures/items/, textures/blocks/, textures/entity/
    blocks.json
    entity/  models/entity/  render_controllers/  animations/  attachables/
    sounds/, sounds/sound_definitions.json
    texts/en_US.lang, texts/languages.json
```

## 2. The manifest: where most add-ons break

- `format_version` 2.
- `header`: `name`, `description`, `uuid`, `version` as `[major, minor, patch]`, `min_engine_version`.
- `modules`: one of type `data` (behavior pack) or `resources` (resource pack), each with its own `uuid` and `version`. A script module is a third module in the behavior pack: `"type": "script"`, `"language": "javascript"`, `"entry": "scripts/main.js"`, its own `uuid`.
- **Every UUID is different**: header and each module, in both packs. Write real version-4 UUIDs, never a placeholder repeated, never the same one twice.
- `dependencies`: the behavior pack names the resource pack's **header** UUID and version, and the resource pack names the behavior pack's, so that applying one brings the other. Script modules are named here too: `{"module_name": "@minecraft/server", "version": "<a version that exists for the target game>"}`, and `@minecraft/server-ui` when forms are used.
- Raise `version` on every release: the game caches a pack by UUID and version.

## 3. Content rules

- Identifiers are `namespace:name` in lower case with underscores. The namespace is the creator's or the add-on's, never `minecraft` and never `minecon`.
- The same identifier ties the pieces together: the item or block or entity definition in the behavior pack, its texture key in `item_texture.json` or `terrain_texture.json` and `blocks.json`, its client entity in the resource pack, and its name in the `.lang` file (`item.<namespace>:<name>=...`, `tile.<namespace>:<name>.name=...`, `entity.<namespace>:<name>.name=...`). List these links for each piece of content so that none is forgotten.
- Each JSON file carries its own `format_version`, and the components allowed depend on it. Do not mix components from different eras in one file.
- JSON must be valid: no trailing commas, no comments in files the game reads.
- Textures are binary and cannot be written as text. Deliver a list: path, size in pixels (16 x 16 for standard items and blocks unless the task says otherwise), and a one-line description of what each shows, for an artist or a generator.
- Functions and commands use current command syntax; test each in the game.

## 4. Scripts

- Import from the modules named in the manifest: `import { world, system } from "@minecraft/server";`.
- Subscribe to events (`world.afterEvents...subscribe(...)`, `world.beforeEvents...`) rather than polling. Work on a timer goes through `system.runInterval` with the longest interval that works, and does little each run.
- In a before-event the world is read-only: defer changes with `system.run(() => { ... })`.
- Guard everything that can be missing: a player who left, an entity that is no longer valid, an unloaded chunk. Wrap calls that throw in `try` / `catch` and log something useful once.
- Persistent data in dynamic properties, with keys prefixed by the namespace, and sizes kept small.
- No stable API? Then the feature needs the beta API experiment: say so, and keep such code in one module.

## 5. What makes an add-on fit for sale

- Works in a fresh world with only the two packs, on the stable game, without experiments (or names exactly which are needed).
- Does not replace vanilla files unless that is the product; does not clash with other add-ons (namespaced everything, no global overrides of `player.json` without need).
- Names and descriptions in `.lang` files, at least `en_US`; more languages when the audience needs them.
- Survival-ready: recipes or another fair way to get each item, balanced numbers, a creative-menu category.
- A settings or guide item, or a `/function` help, when there is anything to configure.
- A README: what it adds, the game version, how to install, experiments needed, known limits, changelog.

## 6. Packaging

- Each pack folder is zipped with `manifest.json` at the top level of the archive and renamed `.mcpack`.
- Both `.mcpack` files (or both folders) zipped together and renamed `.mcaddon` install in one step.
- You deliver the folders as text files and the packaging steps; a person builds the archive and adds the icons and textures.

## 7. Testing (say plainly that it was not run unless it was)

A manual list for the person who tests:

1. Turn on the Content Log (Settings, Creator): any line in it at world load is a bug.
2. Fresh world, both packs applied, cheats on: does each item, block and entity exist (`/give`, `/setblock`, `/summon`) with its texture and its name?
3. Each recipe, each interaction, each script event, once in survival.
4. Leave and rejoin; a second player; `/reload` after a script change.
5. On a phone or a low-end device when the add-on has many entities or scripts on a timer.

## 8. Review checklist

- Are all UUIDs different, and do the dependencies point at header UUIDs?
- Does every identifier appear in every place it must (definition, texture key, lang)?
- Is every `format_version` one that allows the components used in that file?
- Valid JSON everywhere?
- Any use of the `minecraft` namespace for custom content? Any beta API without saying so?
- Does the README match what the packs contain?
