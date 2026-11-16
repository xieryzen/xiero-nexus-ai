---
name: minecraft-premium-product
description: What turns a Minecraft plugin or add-on into a product people pay for and keep: scope, configuration, documentation, versioning, the store page and support. Use when specifying, documenting or listing a premium plugin or add-on.
---

# A Minecraft product worth paying for

Buyers of premium plugins and add-ons are server owners and creators who have been burned: abandoned projects, broken updates, no documentation. What sells is trust that it works, keeps working and can be configured without the author.

## 1. Scope it like a product

Write a one-page specification before any code:

- **Who buys it** (survival server owner, minigame network, add-on player) and the problem in their words.
- **The core loop**: the one thing it does, described as what a player does and sees, step by step.
- **In the first version / later / never**: three short lists. A small plugin that is finished beats a large one that is not.
- **Every option the owner can change**, with its default. If owners will ask for it in the first week, it is an option now.
- **What it must work with** (economy, permissions, placeholders, proxies, other common plugins) and what it replaces.
- **Numbers**: target server size, the cost per tick or per player that is acceptable.
- **What is fair**: nothing that sells gameplay advantage in breach of Mojang's commercial usage rules; say so when a feature touches paid ranks or shops.

## 2. Quality bar

- Installs by dropping it in and starting: sensible defaults, no required editing.
- Everything a player reads can be translated and restyled.
- An update never wipes or silently changes an owner's configuration or data; migrations are automatic and logged; the changelog says what to check.
- Clear errors: what is wrong, in which file and line, what to do.
- No lag: the specification names the heavy parts and how they are bounded.
- A way out: data can be exported or is in a documented format.

## 3. Versions and changes

- Semantic versioning: `MAJOR.MINOR.PATCH`. Breaking a config, a command, a permission or the data format is a major version.
- A changelog entry for each release in the same order every time: Added, Changed, Fixed, Removed, and "What you need to do when updating".
- State the supported game versions and server software for each release; test on the oldest and newest of them.

## 4. Documentation (part of the product)

1. What it does, with one screenshot or GIF placeholder per feature (list what each should show).
2. Requirements and installation, in numbered steps.
3. Commands and permissions as a table: command, what it does, permission, default.
4. Configuration reference: every key, type, default, meaning, example.
5. Placeholders and API, when there are any.
6. FAQ from the questions a new owner asks; troubleshooting by symptom.
7. How to get support and what to include in a report (version, server software, log, config).

## 5. The store page

Marketplaces differ (for Java plugins: SpigotMC, BuiltByBit, Polymart, Modrinth for free ones; for Bedrock: the Marketplace is for partners only, other add-ons are sold or shared on creator sites). Read the rules of the one the client uses; do not assume.

A page that sells:

- First lines: what it does and for whom, without adjectives. Then three to five features, each one sentence that names something visible in the game.
- What it needs (versions, dependencies) and what it does not support, before the buyer has to ask.
- Proof: a test server address or video placeholder, the documentation link, the update history.
- Price and what it includes (updates, support, how many servers). Refund terms as the marketplace allows.
- No invented download counts, reviews or "used by" names.

## 6. Licensing and piracy

- Marketplaces identify the buyer in the downloaded file through placeholders they inject. Use the marketplace's documented mechanism only as it permits.
- No protection that phones home on start, disables the server, hides code that does something else, or collects data. Those get a product removed and harm honest buyers.
- State the licence in plain words: who may use it, on how many servers, whether the source may be changed.

## 7. Support

- A support channel and the hours it is answered.
- A bug report template.
- An update promise that can be kept ("supports the latest release within two weeks"), or none at all.

## Deliverable

When asked for a specification: the one-page spec of section 1 with defaults for every open choice.
When asked for documentation or a store page: complete text ready to paste, with `TODO(client)` for facts only the client has (price, links, test server).
