---
name: technical-writing
description: How to write documentation people can follow without the author: READMEs, installation guides, configuration references, handover documents and changelogs. Use whenever the deliverable is documentation.
---

# Documentation people can follow

The reader is busy, is not the author, and is reading because something is not working yet. Every page starts from what they want to do.

## Before writing

- Who reads it (server owner, technician, end user) and what they already know.
- What they want to have done at the end.
- What you can state as fact: read the code, the configuration and the earlier deliverables you were given. Do not document a feature, a command or an option you have not seen. A gap is `TODO(author): ...`, and it is listed in your summary.

## Shapes

**README**

1. One sentence: what it is and for whom.
2. Requirements, with versions.
3. Installation as numbered steps, each one action, each with what you should see.
4. First use: the shortest path to a result.
5. Reference tables (commands, permissions, options).
6. Troubleshooting by symptom.
7. Support, licence.

**Configuration reference**: a table with key, type, default, what it does, example. Every key that exists, none that do not. Units always ("seconds", "blocks").

**Runbook / installation guide**: numbered steps; a command in a code block the reader can copy; then the check that shows it worked; then what to do if it did not. State the system it was written for at the top.

**Handover document**: what was delivered; where everything is (addresses, folders, accounts by name, never passwords); how to operate it day to day; how to update and restore; what was assumed; what is left to do, by whom.

**Changelog**: newest first; a version and a date; groups Added, Changed, Fixed, Removed; one line each in the user's words; and "When updating" for anything the reader must do.

## Rules

- Task first, explanation after. "To add a server: 1. ..." before any background.
- One action a step. A step that says "configure the firewall" is a chapter, not a step.
- Exact names: the menu label as it is written, the file with its full path, the command as typed. Code, commands, paths and keys in code formatting.
- Placeholders are obvious and explained once: `<your-domain>`.
- Never a secret: no real password, token or key in documentation. Say where it is stored.
- Warnings before the step they concern, not after.
- Short sentences, present tense, the reader as "you". No "simply", "just", "easy".
- The same thing has the same name everywhere.
- Write in the language the task asks for; keep commands and option names as they are.
- Tables for things that are compared; lists for things that are done in order; prose for why.

## Check before handing in

1. Follow your own steps in your head from a clean start: is anything assumed that was not said?
2. Is every command, option and path one you saw in the material?
3. Could a step fail silently? Add the check.
4. Read only the headings: do they form the reader's path?
5. List what you could not verify, at the end.
