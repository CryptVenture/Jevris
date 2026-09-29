---
name: route
description: Advice on which model to use for the main session and for workers. Never switches a model and always keeps a pinned one. Use when the user asks which model fits a task or whether to change model.
tools: jevris_plan_route
invocation: model
---

# Jevris route

Purpose: give model advice the user can act on. Jevris never switches the model itself.

Required evidence: the current model if known, and any model or effort the user pinned. See reference.md for the meaning of each outcome; read it only when an outcome is unclear.

Steps:
1. Call `jevris_plan_route` with `currentModel`, and `modelPin` or `effortPin` when the user pinned one. Add `taskId` when the advice is for one task.
2. Report `main.outcome` and `main.text`. When `main.pinState` is `pinned`, say the pin is kept.
3. Report worker advice only when it is present.

Output contract: one sentence of advice, one sentence of reason (`main.reasonCode` in plain words), and the cost basis when given. Never state that a model was changed: `applied` is always false.

Stop when:
- the outcome is `keep` or the reason is `PIN_RESPECTED`: say so and stop;
- the user must decide: give the advice and let the user switch models.
