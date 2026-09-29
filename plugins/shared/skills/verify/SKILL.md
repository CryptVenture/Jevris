---
name: verify
description: Report whether the declared acceptance checks have current passing runner receipts. Never runs a check and never marks one passed. Use before saying work is done.
tools: jevris_verify, jevris_get_task
invocation: model
---

# Jevris verify

Purpose: say honestly whether the work is verified. Only a runner receipt proves a check passed.

Required evidence: the acceptance check ids, and the task id when there is one. Read reference.md only when the user asks what a receipt is.

Steps:
1. Call `jevris_verify` with `checkIds` (and `taskId`).
2. Report `readiness` and, for each check, whether it has a current passing receipt.
3. For a task, call `jevris_get_task` to list its acceptance checks and receipts.

Output contract: one readiness line, then one line per check. Say "verified" only when `readiness` is `verified`. Never describe a check as passed from test output you saw yourself.

Stop when:
- readiness is not `verified`: name the missing or failing checks and tell the user to run them with `jevris verify` in a terminal;
- readiness is `verified`: report it and stop.
