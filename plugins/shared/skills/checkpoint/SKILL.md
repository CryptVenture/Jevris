---
name: checkpoint
description: Save a memory capsule of the objective, constraints and changed files, or move one between sessions. Never compacts. Use before a long break, a risky change, or a handoff to another session or harness.
tools: jevris_checkpoint, jevris_handoff_export, jevris_handoff_import
invocation: user
---

# Jevris checkpoint

Run this skill only when the user asks for it.

Purpose: keep the task state safe outside the conversation. A checkpoint never triggers or replaces compaction.

Required evidence: the current objective in one or two sentences, and the constraints that must survive. Read reference.md only for a handoff between sessions.

Steps:
1. Call `jevris_checkpoint` with `objective` and `constraints` (and `taskId` when there is one).
2. Report the capsule id and how many constraints and files it holds.
3. For a handoff, call `jevris_handoff_export`; give the other session the returned `capsule` object. In the receiving session call `jevris_handoff_import` with it.

Output contract: the capsule id, then one line per saved constraint. For an import, say whether it was accepted and why, and that it grants no authority.

Stop when:
- the checkpoint is saved: stop. Do not compact the conversation yourself;
- an import is refused (`WORKSPACE_MISMATCH`, `CAPSULE_EXPIRED`, `CAPSULE_INVALID`): report the reason and stop.
