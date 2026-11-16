---
name: code-review-checklist
description: How to review code, configuration and technical documents so that the findings can be acted on: what to look for, how to report it and how to give a verdict. Use for QA, testing, security and review tasks.
---

# Reviewing technical work

A review is useful when the author can fix each finding without asking what was meant, and when a clean pass can be trusted.

## How to review

1. Read the task's acceptance criteria and the specification first. A review is against those, not against taste.
2. Read all of the deliverable before writing anything. If you have tools to read the workspace files, read the files themselves, not only the summary of them.
3. Trace the main path by hand: the first use, from start to finish, with real values.
4. Then try to break it: empty input, very long input, the wrong type, twice at once, in the wrong order, without permission, with the network or the database gone, after a restart.

## What to look for

- **Does it do what was asked?** Each acceptance criterion: met, partly, not met, with where you saw it.
- **Is it complete?** Placeholders, `TODO`, `...`, a function that is named and not written, a file that is referred to and not there, a feature in the documentation that is not in the code.
- **Correctness**: wrong conditions, off-by-one, null or missing values, numbers with the wrong unit, time zones, money in floats.
- **Failure**: what the user sees on each error; whether anything is left half-done; whether a retry is safe.
- **Security**: input used in a query, a command, a path or markup without checking; secrets in code, configuration, logs or documents; a missing permission check; data trusted because it came from the client side; overly broad access.
- **Concurrency and resources**: shared state changed from two places; work on a thread that must not block; connections, files and tasks that are not closed or cancelled.
- **Operations**: can it be configured without changing code; does an update keep existing data and settings; are errors logged with enough to act on.
- **Tests**: do they test behaviour that matters, would they fail if the code were wrong, what is not covered.
- **Documents and runbooks**: can each step be followed as written; is each command real; is there a check after each step; is any secret written down.

## How to report

Findings in order of harm, each as:

```
[BLOCKER | MAJOR | MINOR | NOTE] <file or section>:<line or heading>
What: one sentence on what is wrong.
Why it matters: what happens to the user or the system.
Fix: the change, concretely; code when it is short.
```

- BLOCKER: wrong results, data loss, a security hole, or it does not run.
- MAJOR: a criterion not met, or a failure in a likely situation.
- MINOR: a defect with a small effect.
- NOTE: an improvement, clearly optional.

Then:

- **What is good** and should be kept, in two or three lines. Reviews that only list faults teach nothing.
- **What you could not check** and why (for example: it was not run; a file was not available). Never report something as tested when you only read it.
- **Verdict**: pass, pass with the listed fixes, or fail, with the one reason that decides it.

## Rules

- Quote the line. A finding without a place is an opinion.
- No finding you cannot explain. If you suspect but are not sure, say "check" and say how.
- Do not rewrite the work in your review; say what must change.
- Style is a NOTE unless the project has a rule about it.
- Be exact about your own limits: reading is not running.
