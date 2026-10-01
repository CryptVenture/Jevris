---
name: status
description: Show what Jevris is doing in this workspace: mode, sidecar, recent decisions, model pin, workers, budget and kill switch. Use when the user asks about Jevris state or before relying on Jevris advice.
tools: jevris_status, jevris_explain_decision
invocation: model
---

# Jevris status

Purpose: report the current Jevris state for this workspace, in plain words.

Required evidence: none. Do not ask for paths or a home directory; Jevris takes them from the environment.

Steps:
1. Call `jevris_status` with no arguments.
2. Lead with its `summary` sentence, then give the mode, the sidecar state, the model pin, active workers, budget and whether the kill switch is on.
3. If the user asks about a listed decision, call `jevris_explain_decision` with its id.

Output contract: one short paragraph, then at most eight bullet lines. Say "reduced" when `mode` is `reduced`, and give the sidecar `reasonCode`.

Stop when:
- the tool returns an error: quote its first sentence and suggest running `jevris status` in a terminal;
- the answer is given: status changes nothing, so there is no follow-up.
