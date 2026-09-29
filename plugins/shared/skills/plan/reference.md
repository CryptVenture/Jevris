# Task object shape

Each entry in `tasks` is one object:

- `id`: letters, digits, `.`, `_` or `-`; unique in the plan.
- `schemaVersion`: `"1.0"`.
- `workspaceId`, `revision`: the same for every task in one plan.
- `state`: `"proposed"` for new work.
- `requirementIds`: at least one requirement id.
- `dependencyIds`: ids of tasks that must finish first.
- `writeScopes`: paths or globs the task may change, such as `src/api`.
- `acceptanceCheckIds`: the checks that prove the task is done.
- `rootBudgetId`: the budget the task spends from.

Two tasks in the same wave may not share a write scope. Put one after the other with a dependency instead.
