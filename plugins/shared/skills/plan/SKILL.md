---
name: plan
description: Validate a task graph before work starts: cycles, unknown dependencies, missing acceptance checks, conflicting write scopes; returns waves and the critical path. Use when splitting work into tasks.
tools: jevris_plan, jevris_get_task
invocation: model
---

# Jevris plan

Purpose: check that a set of tasks can be scheduled safely, and show the order.

Required evidence: the task list. Each task needs an id, its dependencies, write scopes, acceptance check ids and requirement ids. The exact shape is in reference.md; read it only when you build the task objects.

Steps:
1. Build the task objects from the user's plan. Do not invent acceptance checks; ask when one is missing.
2. Call `jevris_plan` with `tasks`.
3. If `valid` is true, give the waves in order, the critical path and the ready tasks.
4. If `valid` is false, list each issue with its task id and code, then the advice lines.
5. To look at a stored task, call `jevris_get_task` with its id.

Output contract: waves as numbered lines, one task id list per wave. Issues as `taskId: CODE` lines.

Stop when:
- the plan is invalid: report the issues and wait for the user to change the plan;
- the plan is valid: report it. Planning does not start work or grant leases.
