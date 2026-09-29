---
name: explain
description: Explain one Jevris decision: outcome, reasons, resolved model, token usage, uncertainty and whether anything was applied. Use when the user asks why Jevris advised or did something.
tools: jevris_explain_decision, jevris_status
invocation: model
---

# Jevris explain

Purpose: make one decision understandable and auditable.

Required evidence: the decision id. When the user has none, call `jevris_status` and pick the decision they mean from its recent decisions.

Steps:
1. Call `jevris_explain_decision` with `decisionId`.
2. If `found` is false, say the decision is not recorded here and stop.
3. Otherwise give the outcome, the reason codes in plain words, the resolved model, token usage (or that it is unknown), the uncertainty and whether it was applied.

Output contract: start from `trace.rendered` when it is present; keep the uncertainty sentence as given. Never present a provider's confidence as accuracy.

Stop when:
- the explanation is given: stop. Explaining never changes a decision.
