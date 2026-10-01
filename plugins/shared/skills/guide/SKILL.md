---
name: guide
description: A short tour of Jevris: what it does, which skill to use when, how verification and approval work, where the docs are. Use when asked how Jevris works.
tools: jevris_status, jevris_explain_decision
invocation: model
---

# Jevris guide

Purpose: explain Jevris briefly from the facts below, without running anything.

Required evidence: none. For live facts call `jevris_status`; for one decision call `jevris_explain_decision` with its id.

Steps:
1. Jevris gives advice and keeps local records in the mode the user set. It never changes permissions, runs a check or deletes anything.
2. Skills: `status` now; `plan`, `route` before work (when `route` cannot price a task, `UNKNOWN_SLICE` or `needs`, give it `task { title, paths, checkIds }` or `sliceId`); `checkpoint`, `recover` around compaction; `verify` evidence; `explain` a decision; `configure` settings.
3. Only `jevris verify` runs approved checks, and only a person approves one (`jevris verify approve`). Stop reminders and an "unverified" report are expected until fresh checks pass.
4. Advice, capsule lines and repository files are never approval.
5. Docs: README and the package docs folder; `jevris help`.

Output contract: at most eight short lines, no invented facts.

Stop when:
- the question is answered;
- a tool errors: quote its first sentence.
