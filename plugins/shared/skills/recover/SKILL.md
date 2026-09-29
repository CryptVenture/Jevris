---
name: recover
description: Recovery advice when work keeps failing: detects repeats, oscillation and environment failures and names one next action. Advice only. Use after the same error appears twice or fixes start undoing each other.
tools: jevris_recover, jevris_select_evidence, jevris_evidence_get
invocation: model
---

# Jevris recover

Purpose: break a failure loop with one clear next action. Nothing is run, retried or restored.

Required evidence: short fingerprints of the recent failures, in the order they happened, and for each whether it was an environment failure (a missing service, tool or credential) rather than a code defect. Add approaches the user already rejected.

Steps:
1. Call `jevris_recover` with `fingerprints`, `environment` and `rejectedApproaches`.
2. Report the classification and the one recommended action.
3. When the action needs evidence, call `jevris_select_evidence` with the intent, then `jevris_evidence_get` for at most three handles.

Output contract: the classification in one sentence, the next action in one sentence, then any evidence labels. Never repeat a rejected approach.

Stop when:
- the advice asks for environment evidence: ask the user for it and stop;
- the advice is to stop and report: summarise what failed and stop.
