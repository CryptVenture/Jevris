# MCP tools and the hook launcher

Jevris gives your coding harness two things. The first is a set of **MCP tools**, which the model can call. The second is a **hook launcher**, which the harness runs on its lifecycle events.

Both are local programs that ship in the Jevris package:

| File | What it is |
| --- | --- |
| `plugins/shared/mcp.js` | The MCP server. Every harness, Claude Code included, runs this one file. |
| `dist/hook.mjs` | The hook launcher. |

Each file is a single self-contained JavaScript file that imports only Node.js built-in modules. Neither one needs `npx`, a shell, or network access.

This page covers:

- every tool, with its arguments, results and refusals;
- the MCP protocol versions the server speaks;
- how each harness starts the server;
- what the hook launcher does, for troubleshooting.

## What the tools can and cannot do

The tools give advice and keep local records for the current workspace. They never:

- switch a model, or override a model you pinned;
- change a permission, a harness setting or a Jevris setting;
- run a check, or mark a check passed;
- delete anything.

Every tool is marked `destructiveHint: false` and `openWorldHint: false`. Tools that only read or advise are also marked `readOnlyHint: true`. Every tool except `jevris_submit_task` is marked `idempotentHint: true`.

A model can't redirect a tool to another home directory or another project:

- **No tool accepts** a home directory, a repository root, an output path or a shell command.
- **The Jevris home** comes from the host environment: `JEVRIS_HOME`, or else your home directory.
- **The workspace** is the first of these that is set:
  1. `CLAUDE_PROJECT_DIR`;
  2. the first root the MCP client advertises (the server asks with `roots/list` when the client supports roots);
  3. the server's working directory.

  Jevris then uses the nearest folder at or above it that holds `.git`.

These stay on the administrator CLI, and no model can reach them through MCP:

- installing and uninstalling;
- changing settings;
- credentials;
- the kill switch;
- policy;
- data deletion.

## How a tool call is answered

Each tool maps to one Jevris operation. The server answers a call like this:

1. It runs the installed `jevris` command-line program.
2. It passes the arguments as JSON on standard input, never on the command line.
3. It passes the workspace in the `JEVRIS_WORKSPACE` environment variable.

The server finds the `jevris` program in this order. It never searches `PATH`.

1. `JEVRIS_BIN`, if it is an absolute path.
2. A `jevris-bin.json` pointer in the same folder as `mcp.js`, if there is one.
3. A `bin/jevris.mjs` in a parent directory of the server. In an installed runtime this is the runtime's own `bin/jevris.mjs`.

### Successful results

A successful call returns the command's result in two forms:

- **`structuredContent`**: the result object. It matches the tool's declared `outputSchema`.
- **One text block**: the same object as JSON.

Every result has the same envelope:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `"1.0"`. |
| `command` | The operation, for example `status` or `plan`. |
| `mode` | `full` when the Jevris sidecar answered. `reduced` when the answer was computed locally because the sidecar was not available (see below). |
| `sidecar` | `{ state, reasonCode, message }`. `state` is one of `running`, `not-running`, `starting`, `timeout`, `refused` or `rejected`. |
| `workspace` | `{ id, root }` for the workspace the answer is about. |
| `summary` | One plain sentence that describes the answer. |
| `result` | The operation's own payload, described per tool below. |

**Reduced mode** is a correct but smaller answer that doesn't need the sidecar:

- a task that is not found locally is reported as not found;
- a receipt that can't be recorded says so.

The `sidecar.reasonCode` says why the answer is reduced. Which code you see depends on whether the tool may start the sidecar. It may, unless `JEVRIS_SIDECAR_AUTOSTART=0` is set (see [Settings](#settings) under the hook launcher).

When the tool tried to start the sidecar and could not:

| `sidecar.reasonCode` | Meaning |
| --- | --- |
| `SIDECAR_UNAVAILABLE` | The sidecar could not be started. When a service is installed and its manager refused or could not be reached while the service's own sidecar is still alive but not answering, the message names `SERVICE_START_REFUSED` or `SERVICE_UNREACHABLE`, and no second sidecar is started beside it: run `jevris service status`, then `jevris sidecar restart`. |
| `SIDECAR_STARTING` | The sidecar is still starting. Retry in a moment. |
| `SIDECAR_REFUSED` | The sidecar refused to start or to be used, for example because of its scope. |

When the tool may not start the sidecar (`JEVRIS_SIDECAR_AUTOSTART=0`), or it started and then could not be reached:

| `sidecar.reasonCode` | Meaning |
| --- | --- |
| `NOT_RUNNING` | No sidecar is running. With `JEVRIS_SIDECAR_AUTOSTART=0` the message says autostart is off and nothing will start it, and names the fixes: run `jevris sidecar start`, or unset `JEVRIS_SIDECAR_AUTOSTART`. With autostart allowed it says to run `jevris sidecar start`, or retry, because the sidecar starts on demand. |
| `KEY_UNREADABLE` | A sidecar is running, but this client cannot read its key file. |
| `FOREIGN_LOCALITY` | The running sidecar belongs to another execution environment, so it is not used. |
| `CONNECT_FAILED`, `ECONNREFUSED`, `ENOENT`, `EAGAIN` | The endpoint is listed but the connection failed, for example after a crash. |
| `CONNECT_TIMEOUT` | The sidecar did not accept the connection in time. |
| `SIDECAR_TIMEOUT` | The sidecar did not answer in time. |
| `SIDECAR_REJECTED` | The sidecar rejected this request. |
| `SIDECAR_INVALID_RESULT` | The sidecar answered, but not in the expected shape. Update Jevris. |

The sidecar may also send its own specific reason code, such as `SCOPE_DENIED`. When it does, that code is shown instead.

`jevris_configure` is always answered locally and never asks the sidecar. Its result says `mode: "reduced"` with `sidecar.reasonCode` set to `null`.

### Errors and refusals

Errors come back as a tool result with `isError: true` and one text block. There is no `structuredContent` in that case.

| Text begins with | Cause | What to do |
| --- | --- | --- |
| `Refused (REFUSED):` | The arguments didn't match the tool's input, for example an unknown field such as `home`, a value that is too long, a malformed id or handle, or a `capabilityId` that belongs to the other advice tool (`jevris_advise` takes only its own ids, `jevris_delivery_report` only `C57`, `C58`, `C59`, `C60`, `C61` and `C64`). Also returned when a settings change arrives through MCP. | Fix the arguments. Change settings with the `jevris` CLI. |
| `Refused (MODE_OFF):` | Jevris is in `off` mode. In `off`, `jevris_plan_route`, `jevris_plan`, `jevris_recover`, `jevris_advise` and `jevris_delivery_report` are refused, whether or not the sidecar runs. The other tools still answer. | Raise the mode from a terminal, for example `jevris configure set mode advise`. |
| `Refused (KILL_SWITCH):` | The kill switch is on, so a tool that writes or starts work (for example `jevris_checkpoint`, `jevris_handoff_import`, `jevris_submit_task` or `jevris_verify`) is refused and changes nothing. | Clear it from a terminal with `jevris kill-switch clear`. |
| `Refused (VERIFY_STATE_UNKNOWN):` | `jevris_verify` did not get an answer from the sidecar in time, so the state of the checks is unknown. | Call `jevris_verify` again. |
| `Refused: the arguments must be an object.` | `arguments` was an array or a scalar value. | Send an object. |
| `The jevris CLI was not found next to this server.` | No `jevris` program could be resolved. | Run `jevris install` again. |
| `The jevris CLI could not be started.` | The program exists but failed to start. | Run `jevris doctor` in a terminal. |
| `Jevris did not answer within 20 seconds.` | The call timed out, and the child process was stopped. | Run `jevris status` in a terminal. |
| `The Jevris answer was larger than 1 MiB and was dropped.` | The result was too big. | Narrow the request. |
| `The jevris CLI returned no readable answer.` / `returned an unexpected answer.` | Version mismatch or a crash. | Update Jevris. |

An unknown tool name is a protocol error (`-32602`), not a tool result.

Malformed messages are protocol errors too, not tool results:

| Code | Cause |
| --- | --- |
| `-32700` | A line was not valid JSON. |
| `-32600` | The message was not a valid request: a batch, a bad id, or a message larger than 1 MiB. |
| `-32601` | The method does not exist. |

The server always sends the CLI a valid JSON object of at most 1 MiB, so a tool call cannot end in the CLI's own `INVALID_JSON` or `OVERSIZE` refusals. Those two codes exist only on the internal `jevris __surface` entry, which reads its arguments from standard input and is not part of the tool surface.

A cancelled call gets no response. The server stops the child process when the client sends `notifications/cancelled`.

## The tools

The server lists 17 tools. Every id field accepts 1 to 128 characters: letters, digits, `.`, `_` and `-`, starting with a letter or digit. Model fields accept the model as the harness names it: up to two `provider/` segments, then an id by the same rule, optionally ending with `:<digits>` and then `[1m]`.

### Read-only tools

#### `jevris_status`

Current mode, sidecar state, decision health, model pin, active workers, queued tasks, budget and kill switch for this workspace.

- **Arguments:** none.
- **Result:** the status report, the same one `jevris status --json` prints. In it:
  - `jevrisMode` is the effective mode for this workspace: your `mode` setting, lowered by any ceiling above it (the repository's `.jevris/config.json`, `organization.json`, `host.json` or a managed policy). It is the value `jevris configure` shows, and `modeSource` names where it comes from (see [settings.md](settings.md));
  - `routing.modelPin` is the model you pinned in the harness (`ANTHROPIC_MODEL`), which Jevris never changes; `null` when none is set;
  - `activeWorkers` lists the ids of this workspace's owned tasks that are leased or running;
  - `queuedTasks` is how many of this workspace's owned tasks are queued: in state `ready` or `validated`, waiting for a lease or a prerequisite. It is a count, and absent (or `null`) when the sidecar did not count. Between one worker ending and the next queued task being leased, `activeWorkers` is empty while `queuedTasks` is above 0, so the queue is idle only when `queuedTasks` is 0 and `activeWorkers` is empty. The hand-over has no time bound: wait on the two values, not on a delay.

#### `jevris_explain_decision`

Explains one recorded decision.

- **Arguments:** `decisionId` (required) and `sliceId` (optional: a task slice such as `bounded-edit`, or a route-learning key such as `bounded-edit::gpt-6.1-sol` as `jevris route learning status` lists it, to add that slice's route learning; a baseline other than Opus 5.5 learns under its own key, and each key compares its arms with its own baseline).
- **Result:** `{ decisionId, found, trace }`. `trace` contains:
  - `outcome` and `reasonCodes`;
  - `resolvedModel`;
  - token `usage` (`known: false` when not recorded);
  - `uncertainty`, in plain words;
  - `policyVersion`;
  - `applied`;
  - a `rendered` explanation of up to 4000 characters;
  - `models` (when recorded): the worker model requested and the one observed, kept apart;
  - `learning` (with `sliceId`): the slice's route-learning mode, policy version, the signed baseline prior and the local outcomes apart, and a posterior per arm (a model at an effort level). The fields are in [routing.md](routing.md#why-a-slice-routes-as-it-does);
  - for a main-session turn decision only: `mainSession` (the harness, the mode, whether the turn's model was switched or only advised, and the reason code), the session's `sessionLink` to its task, and the `serving` hosts.

  An unknown id returns `found: false`. It is not an error.

#### `jevris_select_evidence`

Picks the most relevant evidence for an intent. It returns handles and short labels, never file contents.

- **Arguments:**
  - `intent` (required, 1 to 500 characters);
  - `maxItems` (1 to 64, default 16).
- **Result:** `{ intent, items, missing, truncated }`, and `selectionId` when the sidecar recorded the selection. Pass it to `jevris_evidence_get` so the read counts against this selection.

#### `jevris_evidence_get`

Returns one evidence item by handle. The item is bounded, may be truncated, and passes through the same egress checks as the CLI.

- **Arguments:**
  - `handle` (required): `ev:` followed by 64 lower-case hex digits, as `jevris verify` names it. Any other form, such as `output:<id>`, is refused;
  - `selectionId` (optional): the `selectionId` of the `jevris_select_evidence` answer that listed the handle. Jevris records which selected evidence was read, as ids only.
- **Result:** `{ handle, found, mediaType, byteLength, text, truncated }`, and `output` when Jevris recorded how a tool or check output was shown to the model.

#### `jevris_get_task`

Returns a task with its state, acceptance checks and runner receipts.

- **Arguments:** `taskId` (required).
- **Result:** `{ taskId, found, task, receipts }`. When an owned worker was launched (or, in `observe` and `advise` mode, would have been) and Jev gave worker-readiness advice, it also carries `readiness: { decisionId, state }`, where `state` is `ready`, `not-ready`, `unsure` or `none` and `decisionId` is what `jevris explain` renders. It is advice only: the launch never depended on it. A blocked task also carries `task.stateReason`, a reason code such as `DEPENDENCY_CANCELLED` (a task it depended on was cancelled, so it can never start). In reduced mode `found` is `false`. `cancelRequested: true` appears, only while it holds, when a person's `jevris task cancel` was delivered to the task's running worker and the worker has not yet published its end: the task is not cancelled yet, and becomes cancelled shortly. For an owned task, `worker` is its latest worker run: the model requested and the model that did the work, kept apart, the run's status, and the cost only when the worker reported it.

#### `jevris_handoff_export`

Returns a portable memory capsule for another session or harness. The capsule grants no authority.

- **Arguments:** `capsuleId` (optional; the newest capsule when omitted) and `taskId` (optional).
- **Result:** `{ capsuleId, found, capsule, contentHash }`.

#### `jevris_verify`

Reports whether each declared check has a current passing runner receipt. It never runs a check and never marks one passed. Checks run only from the `jevris` CLI.

- **Arguments:**
  - `checkIds` (up to 512);
  - `taskId` (optional).
- **Result:** includes `ran: false`, one entry per check in `checks`, the `missing` checks and a `readiness` value: `verified`, `not-verified`, `needs-environment` or `no-checks`. Readiness is `verified` only when every mandatory check has a current passing receipt. `needs-environment` means the remaining mandatory checks only need other hardware or a runner; it is not verified. `no-checks` means no checks are approved yet (see [verification.md](verification.md)).

#### `jevris_configure`

Shows the effective Jevris settings and where each one comes from. This tool can only read settings. A `set` request through MCP is refused.

- **Arguments:** none.
- **Result:** includes the `effective` settings (with `modeSource`) and `nativePermissionsChanged: false`.

### Advice tools

These tools change no plan, file, setting or permission and are marked `readOnlyHint: true`. Two of them keep a local record of their advice: `jevris_plan_route` and `jevris_plan` each write advisory decisions to the local journal, and may ask Jev within the usual budgets and the `jev.assist` setting.

#### `jevris_plan_route`

Advice on the main-session model and on managed workers. It never switches a model and never overrides a pinned one.

- **Arguments** (all optional):
  - `currentModel`: the model as the harness names it, such as `claude-opus-5-5`, `claude-opus-5-5[1m]`, or `provider/model` from Kilo or OpenCode (up to two provider segments);
  - `modelPin`, in the same forms;
  - `effortPin`;
  - `taskId`;
  - `sliceId`: the task's slice, so a released calibration for it can apply to worker advice;
  - `task`: `{ title, paths, checkIds }`, what you know of the task. With no `sliceId`, Jevris classifies the slice from it (Jev from structured features, rules as the fallback; see [routing.md](routing.md#when-the-route-has-no-slice)) and the result carries a `slice` part saying how. Path names are never sent to Jev;
  - `remaining`: `{ inputTokens, outputTokens }` the rest of the task needs;
  - `contextTokens`;
  - `session`: `warmPrefixTokens` (required inside `session`: the cached prefix a switch would move), `cacheWarm`, `atBoundary`, `unitsSinceLastSwitch`, `switchesThisTask` and `authMode` (`api-key`, `subscription` or `unknown`, which labels the switch cost as list price or as an API-equivalent estimate).
- **Harness:** the server sends the harness it was installed for, so the advice names only models that harness can run with the session's sign-in (`session.authMode`). A CLI call with no `--harness` is not scoped.
- **Result:** `{ main, worker, applied: false }`, plus `slice` when Jevris classified the task and `needs` when the answer is a keep because the request gave too little. `needs` lists what to pass: a `sliceId` or a `task`, and `session.warmPrefixTokens` to price a switch.
  - `main.currentModel` is the registry id of the model you named (for example `claude-opus-5-5` for `anthropic/claude-opus-5-5[1m]`), or the bare id when the registry does not hold it.
  - `main.harness` names the harness the advice was scoped to, when there was one.
  - `main.pinState` is `pinned` or `unpinned`.
  - `main.outcome` is `keep`, `recommend` or `abstain`, with `recommendedModel`, `costBasis` and `authMode` when known.
  - `main.reasonCode` explains it. `PIN_RESPECTED` means a recommendation was withdrawn because you pinned a model. `CURRENT_MODEL_UNREGISTERED` means the current model is not in the model registry, so Jevris does not suggest a switch away from it. `ADVICE_NOT_FOLLOWED` means the same advice was not followed twice in this session, so it is not repeated. In reduced mode, `ROUTER_UNAVAILABLE` means no routing data was available, and `PROVIDER_CONSENT_REQUIRED` means Jevris could not read your provider consent, so it suggests no model that needs it.
  - `main.consentedProviders` lists the model providers the advice was limited to, after provider consent (`jevris consent provider`). `main.serving` names the host the session's model goes through, when it is known.
  - `worker.outcome` is `recommend` or `abstain`. Worker advice needs a released calibration for the slice.

  The same advice is `jevris route` in the CLI; see [routing.md](routing.md).

#### `jevris_plan`

Validates a task graph and labels each task with a slice and risk hint. It finds:

- cycles;
- unknown dependencies;
- missing acceptance checks and requirements;
- parallel tasks that write to the same scope.

- **Arguments:** `tasks` (required): 1 to 1024 task objects. Only each task's TaskNode fields are checked; the scheduling fields of a submitted task (`title`, `models`, `expectedOutputs` and so on) are allowed and ignored.
  - `requirements` (optional, at most 64 of `{ id, text }`): what the task list must cover. With Jev on and source egress approved, the result's `review.decomposition` holds a review score from 0 to 4 for how well the tasks cover each one (C03). A score is a number, not a whole level: Jev reports the expectation over the five levels in hundredths (for example 2.88), and the result keeps it, so two plans Jev ranked apart are not tied.
  - `candidates` (optional, at most 12 of `{ id, summary, constraints?, tradeoffs? }`): plans to compare. With Jev on and source egress approved, `review.plans` ranks them by a review score from 0 to 4 in the same way (C07).
  - Both send their text to Jev, so with egress not approved they are answered by the rules (`EGRESS_NOT_APPROVED`) and nothing is sent. A score is a review aid, never a feasibility verdict, and a person reviews every plan.
- **Result:** `{ valid, taskCount, order, waves, criticalPath, ready, issues, advice }`, plus `sliceSuggestions` for a sound graph: one `{ taskId, slice, source, risk, confidencePercent, reasonCode, decisionId }` per task, the slice and risk the route classifier gives it (Jev from structured features, rules as the fallback; see [routing.md](routing.md#slice-hints-for-the-tasks-of-a-plan)). A slice a task declares (`sliceId`) is kept as given, with `suggestedSlice`, `suggestedBy` and `agrees`. Advice for a person: it is not part of the plan, and no path name is sent to Jev.
  - `issues` codes are `DUPLICATE_TASK`, `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `CYCLE`, `WORKSPACE_SCOPE`, `INVALID_TASK`, `NO_ACCEPTANCE_CHECK`, `NO_REQUIREMENT` and `WRITE_OVERLAP`.
  - An invalid plan is a normal result with `valid: false`.
- **What it records:** the plan itself is never stored or changed, but each labelled task's hint is recorded as one advisory decision in the local journal (with no task id, because a checked plan's tasks do not exist; see [routing.md](routing.md#slice-hints-for-the-tasks-of-a-plan)), and with Jev on it may ask Jev up to 8 questions of the usual kind, within the budgets. It is an advice tool for that reason, not a read-only one. At most 256 tasks are labelled.

#### `jevris_recover`

Classifies repeated failures, oscillation and environment failures, and names one next action. A repeat is the same failure fingerprint seen at least twice; one failure is never a repeat. Oscillation is two failures taking turns, at least four in a row (A, B, A, B), in the order given, and its action is to restore the last checkpoint with the user's approval. An exhausted repair budget does not replace that action with a stop, because nothing is restored without a person's approval. It is advice: nothing is run or restored for you, with one exception. The exception is a failed owned task, named by `taskId`, whose failures repeat. When workers are automatic and the task has not escalated before, Jevris relaunches it once on the next stronger model the task approved ([routing.md](routing.md#when-one-starts)).

- **Arguments:**
  - `fingerprints`: up to 256 short failure descriptions, in order;
  - `environment`: one boolean per fingerprint, `true` for an environment failure;
  - `rejectedApproaches`: up to 32;
  - `taskId`.
- **Result:** `{ classification, action, advice, signals, rejectedApproaches }`. `action` is one of `continue`, `retrieve-missing-artifact`, `rerun-check-once`, `ask-focused-question`, `route-stronger-worker`, `restore-checkpoint-with-approval` or `stop-and-report`.

#### `jevris_delivery_report`

A delivery report on the change in this workspace, built from receipts, the task graph, git and the workspace files. It is advice only: it never opens, merges or comments on a pull request, never changes CI, never installs a package and never runs a migration. The CLI equivalent is `jevris delivery`.

- **Arguments:**
  - `capabilityId` (required): `C57` pull-request readiness, `C58` CI failure triage, `C59` dependency-upgrade risk, `C60` migration rehearsal, `C61` documentation drift or `C64` team configuration;
  - `taskId`;
  - `input`: `base` (C57, C59, C60, C61; the revision the change is measured from, default `HEAD`), `unresolvedComments` (C57), `migrations` (C60, up to 32 files) and `compatibility` (C60).
- **Result:** the capability's advice: `capabilityId`, `reasonCode`, a summary, ranked items and the guards that held.

#### `jevris_advise`

Orchestration, retrieval, verification and research advice from the task graph, receipts, git and the workspace files. It is advice only: nothing is started, run, cancelled, changed or approved. The CLI equivalent is `jevris advise <capability>`. One tool takes every id, so the tool list stays at 17 tools.

- **Arguments:**
  - `capabilityId` (required): `C25` dependency suggestions, `C26` worker-role allocation, `C28` duplicate work, `C30` handoff readiness, `C32` native workflow or team, `C33` installed-skill shortlist, `C34` repository evidence, `C35` documentation relevance, `C36` tool selection, `C37` tool-argument preflight, `C38` environment failure triage, `C40` visual findings, `C41` test impact, `C42` failure clusters, `C43` patch ranking, `C44` review areas, `C45` requirements-to-evidence audit, `C46` flaky tests, `C47` security-review escalation, `C62` release risk, `C67` question-improvement proposal, `C69` report disagreement, `C70` change campaign or `C72` embedded-development next step;
  - `taskId`;
  - `input`, the keys for that capability, and no others (an unknown key, a key of another capability, a value of the wrong shape or an input over its bounds is refused before anything runs): `base` (C41, C42, C44, C47), `planId` (C25), `phase`, `requiredTools` and `intent` (C26), `taskId`, `sourceRefs` and `diffHandle` (C30), `patches`, `taskIds` and `requirement` (C43), `protectedPaths` (C44), `requirementIds` and `requirementTexts` (C45), `checkId` (C46); `harness` and `collaborative` (C32); `intent` and `maxItems` (C33); `query` and `maxItems` (C34, C35); `intent`, `tools`, `allowlist` and `permittedEffects` (C36); `tool`, `args` (an object of up to 16 KiB) and `writeScopes` (C37); `receiptId`, `checkId` and `handle` (C38, one of the three names the recorded output); `findings` and `assertions` (C40); `incidents`, `rollout` and `exceptions` (C62); `specId`, `current`, `candidate` and `misclassifications` (C67); `reports` (C69, two to sixteen); `campaignId`, `modules`, `contract`, `canary` and `waveSize` (C70). C28 and C72 take no input.
- **Result:** the capability's advice. For `C28`, `ranked` lists duplicate pairs (`{ id: "T1~T2", label, reason }`) and `kept` the survivors. Cancelling a duplicate stays a person's act: `jevris task cancel` in the CLI.
- **Egress.** A capability whose question is about text you or the workspace give it (an intent, a query, a finding, a tool description, a command, a requirement, an incident id, a draft question, a contract, the arguments of a tool call) asks Jev about that text only when source egress is approved by the administrator and by your own preference. With it denied nothing quoted leaves the machine and nothing is asked: the rules answer (`source` is `rules`, with the rules' own reason code and no decision id). `C32`, `C44`, `C46`, `C47`, `C69` and `C72` judge counts and flags alone and are asked either way. [privacy.md](privacy.md#what-each-capability-asks-with-egress-denied) has the table. A `C67` draft or a `C70` campaign that holds a secret is refused with `SECRET_BLOCKED` before anything is sent or stored, and a `C67` threshold of `null` is none, the same as leaving it out.
- **Not offered here.** `C68` (safe speculative evaluation) creates and removes git worktrees and applies patches in them, which a tool that is read-only advice must not do, so it stays on the raw `capability.advise` op; the probe actions of `C32`, the skill roots of `C33` and the branch writing of `C67` stay there too, for the same reason.

### Tools that write local records

These tools write only under the Jevris data directory, never in your repository.

#### `jevris_checkpoint`

Saves a memory capsule of the objective, your constraints, the decisions made so far and the changed files. It never triggers or replaces the harness's own compaction.

- **Arguments:**
  - `objective` (up to 4000 characters);
  - `constraints` (up to 64, each up to 1000 characters);
  - `decisions` (up to 64, each up to 1000 characters): decisions made so far that are worth keeping after a compaction. After a compaction, one that the harness's summary left out is restored first, and the same list is what Jev's omission check (C20) judges when egress is approved;
  - `taskId`;
  - `contextPercent` (an integer, 0 to 100): how much of the context window is in use, if you know it. No harness hook reports it, so only the caller can say. It gives compaction-readiness advice (C19): from the rules, and from Jev when the use is between 70 and 90 percent and Jev is on. It never defers or starts a compaction.
- **Result:** includes the `capsuleId`, a `capsule:` handle, the items kept, and `compactionTriggered: false`. With `contextPercent` it also has `compaction`: `{ usedPercent, boundary, source, decisionId }`, where `boundary` is `none`, `prepare` or `recommend-boundary`, and `source` is `rules` or `jev`.
- **Constraints.** A constraint you add is also compared with the ones already held, only when source egress is approved by the administrator and by your own preference. A pair Jev finds contradictory is listed as a hypothesis, "may contradict each other (Jev's advice, not a finding)", and nothing is removed or changed (C23).

#### `jevris_record_verification`

Links an existing runner receipt to a check. It records only a pointer: it cannot create a receipt or mark a check passed.

- **Arguments:** `receiptId` and `checkId` (both required), and `taskId` (optional).
- **Result:** `{ receiptId, accepted, reasonCode, outcome, receiptCreated: false }`. `RECEIPT_STORE_UNAVAILABLE` means the sidecar was not available to record it.

#### `jevris_handoff_import`

Checks a capsule from another session and pins its facts as context. The checks are: the workspace matches, the capsule has not expired, and it matches the capsule format. Importing never grants authority or runs anything, and this tool never links a session to the capsule's task. Only a person at a terminal can, with `jevris handoff import <capsule.json> --link`.

- **Arguments:** `capsule` (required).
- **Result:** `{ accepted, reasonCode, capsuleId, facts, unresolved, authorityGranted: false }`. It may also carry `mode`, the result negotiated for this harness (`actuate`, `advice-only` or `blocked`), and `missingCapabilities`, what the capsule needs that this harness is not certified for here.

### Owned mode only

#### `jevris_submit_task`

Submits a task for Jevris-owned orchestration. The tool is always listed, but it works only while owned mode is on for the workspace. Only a person at an interactive terminal turns it on, with `jevris configure owned-mode on --workspace <dir>` and a y answer; `--yes` and environment variables do not. The sidecar checks it on every request, and the kill switch, or turning owned mode off, revokes it at the next request.

The task runs under a root budget that already exists in the workspace. This tool cannot create one; a new root budget comes only from `jevris plan --submit` at a terminal. A submitted task starts a worker when the usual conditions hold ([routing.md](routing.md#when-one-starts)); otherwise it is queued.

- **Arguments:** `task` (required): one task object, with `rootBudgetId`, the id of that existing root budget. `expectedOutputs` are names, not paths: each entry is letters, digits and `. _ : -` only, up to 128 characters, so `patch` is accepted and `out/file.txt` is not.
- **Result:** `{ accepted, taskId, leaseIds, reasonCode }`, plus `detail` on some refusals. It lists only the leases actually granted. An accepted task with no lease is queued, and `reasonCode` says why (`QUEUED`, `CAP_REACHED` when every worker slot is busy, and the others listed in [settings.md](settings.md#workers)); a task queued for `CAP_REACHED` starts when a slot frees, with no second submit. `OVER_BUDGET` is the first refusal of a task whose reservation does not fit its root budget (under the `pause-all` policy it also pauses the budget, and the task keeps `OVER_BUDGET`); `BUDGET_PAUSED` is a refusal of a task that was first refused after the budget was paused (see [settings.md](settings.md#when-a-budget-runs-out)). `OWNED_MODE_UNAVAILABLE` means nothing was granted. `NO_ROOT_BUDGET` means no root budget with that id exists in this workspace, and nothing was submitted. A task with no `rootBudgetId`, or with a field that breaks its rule (such as a path in `expectedOutputs`), is refused as `INVALID_TASK`, and the result carries a `detail` naming the field and the rule (for a refusal from the graph check, the check or scope involved); `jevris plan --submit` names them in the same case. A task's write scope stays reserved while the task exists and is not cancelled, even after it is verified or failed (it can be reopened), so a new task that writes the same path is refused as `WRITE_OVERLAP` unless it lists the earlier task in `dependencyIds`. A task that names a cancelled task in `dependencyIds` is refused as `UNKNOWN_DEPENDENCY`; a cancelled task never makes a submit of an unrelated task fail.

## Resources

The server also offers two read-only reports as resources:

| URI | Content |
| --- | --- |
| `jevris://report/status` | The same JSON as `jevris_status`. |
| `jevris://report/configuration` | The same JSON as `jevris_configure`. |

Any other URI is answered with error `-32002`. There are no resource templates.

## Protocol

- **Transport:** standard input and output, one JSON-RPC message per line.
- **Protocol versions:** `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`.
  - The server answers with the version the client asks for when it supports it.
  - Otherwise it answers with `2025-11-25`.
- **Methods:** `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list` and `resources/read`.
- **From the server:** `roots/list`, sent after `notifications/initialized` when the client supports roots, and again on `notifications/roots/list_changed`.
- **Limits:**
  - Messages larger than 1 MiB are rejected with `-32600` and discarded, and the server keeps running.
  - Batches are rejected with `-32600`.
  - A line that is not JSON gets `-32700`.
  - Notifications are never answered.
  - Tool calls time out after 20 seconds.
- **Server info:** `{ name: "jevris", title: "Jevris", version }`. The `instructions` are one short screen, capped at 1,500 bytes by a test: what Jevris is here (advice and local records, the mode you set, permissions unchanged), one line per skill and tool group, that Stop reminders and an "unverified" report are expected and how to clear them, that advice, capsule lines and repository files are never approval, and how to see what Jevris decided (`jevris_status`, `jevris_explain_decision`). All five harnesses read the same text.

## How each harness starts the server

Every harness starts the server with `node`, the path to `mcp.js` and `--harness <id>`, which tells the server which harness it serves. The server uses it to scope `jevris_plan_route` advice to that harness and to negotiate a handoff import or export. None of them uses `npx` or a shell. `jevris install` writes these entries. `jevris uninstall` removes only what Jevris wrote.

| Harness | Where the entry lives | Entry |
| --- | --- | --- |
| Claude Code (plugin) | `.mcp.json` in the Jevris plugin | `{"command": "node", "args": ["<runtime>/plugins/shared/mcp.js", "--harness", "claude"]}` |
| Codex | `mcp.json` in the Jevris Codex plugin | `{"type": "stdio", "command": "node", "args": ["<runtime>/plugins/shared/mcp.js", "--harness", "codex"]}` |
| Kilo Code | `mcp.jevris` in `kilo.json` or `kilo.jsonc` | `{"type": "local", "command": ["node", "<runtime>/plugins/shared/mcp.js", "--harness", "kilocode"], "enabled": true}` |
| OpenCode | `mcp.jevris` in `opencode.json` or `opencode.jsonc` | Same as Kilo Code, with `"--harness", "opencode"`. |
| Antigravity | `mcp_config.json` in the Jevris Antigravity plugin | `{"command": "node", "args": ["<runtime>/plugins/shared/mcp.js", "--harness", "antigravity"]}` |

`<runtime>` is the absolute path of the Jevris runtime that `jevris install` placed under the Jevris data directory.

## The hook launcher

Harnesses run `hook.mjs` on their lifecycle events, as `node <runtime>/dist/hook.mjs --harness <name> [--event <name>]`:

- `--harness` is required. It is one of `claude`, `codex`, `kilo`, `opencode` or `agy`.
- `--event` names the native event when the harness doesn't include the event name in its payload. Antigravity uses it. Kilo Code and OpenCode run the launcher from the Jevris plugin, which passes the event name in the payload.

The native event JSON arrives on standard input, and it must be valid UTF-8. The launcher reads at most 8 MiB. An input larger than the adapters' limit (128 KiB) is not dropped: the launcher cuts long strings, marked ` [cut by Jevris]`, until it fits.

### What it does with an event

1. It converts the native event into Jevris's common event form, using the adapter for that harness.
2. It sends the event to the sidecar's `event` operation with:
   - the event's de-duplication key, so a repeated delivery is recorded once;
   - scope `hook`;
   - a hot budget.
3. If no sidecar answered, it starts one without waiting for it, and this event is only observed. Later events are forwarded.
4. It chooses the strongest outcome that the sidecar's subscribers returned and that is **certified** for this harness version. The order, strongest first, is: `route`, `context`, `explain`.
   - An uncertified `route` or `context` is never applied.
   - If nothing qualifies, the event is only observed, and the launcher prints the harness's "no decision" answer (for most harnesses, nothing).
5. It prints the harness's own response format for that outcome. It never denies or asks on your behalf. The one `permissionDecision` it writes is Codex's certified `route`: `allow` with the `spawn_agent` call's own input plus `model`, because Codex applies a rewritten input only with `allow` (see [harnesses/codex.md](harnesses/codex.md)). A route is applied only from an input that reached the launcher whole, never from a cut one.

On a Stop event in Claude Code, Codex and Antigravity, a certified completion check can ask the agent to continue once, because declared checks have no current passing receipts. That is a Stop continuation, not a permission decision; see [verification.md](verification.md#5-completion).

### Guarantees

- **Always exits with code 0.** A failure is a silent observation, never a blocked tool.
- **Answers within its deadline.**
  - The deadline defaults to 1500 ms.
  - `JEVRIS_HOOK_DEADLINE_MS` can set it anywhere from 100 to 4000 ms.
  - A watchdog prints the observe response shortly after the deadline even if something hangs.
- **Never stores or logs your prompt or tool content.** It writes to standard error only when `JEVRIS_HOOK_DEBUG=1`, and then it writes only reason codes.
- **Never spawns the harness.** It reads harness settings in one case only: when a turn ends on an access-limit error, it checks whether the session's model endpoint is redirected. For Claude Code that is the environment and the workspace's `.claude/settings.json` and `settings.local.json`; for Kilo Code and OpenCode, the project config in the workspace. A redirected endpoint means no access signal is sent.

### Settings

| Variable | Effect |
| --- | --- |
| `JEVRIS_HOOK_OBSERVE_ONLY=1` | Never apply an outcome. The event is still forwarded. |
| `JEVRIS_HOOK_DEADLINE_MS` | The deadline, from 100 to 4000 ms. The default is 1500 ms. |
| `JEVRIS_HOOK_DEBUG=1` | Print one line per event to standard error: `jevris-hook <harness> <reason>`. |
| `JEVRIS_SIDECAR_AUTOSTART=0` | Never start the sidecar. A running sidecar still answers. |
| `JEVRIS_HOME` | The Jevris home. The default is your home directory. |

### Troubleshooting with the reason code

Run the harness with `JEVRIS_HOOK_DEBUG=1` and read the reason at the end of each `jevris-hook` line:

| Reason | Meaning |
| --- | --- |
| `INPUT_REFUSED` | The input was too large or not valid UTF-8. |
| `INVALID_JSON` | The input was not JSON. |
| `NORMALIZE_FAILED`, or an adapter code such as `UNKNOWN_EVENT`, `MISSING_FIELD` or `FOREIGN_PROTOCOL` | The adapter did not recognise the event. |
| `OBSERVE_ONLY` | `JEVRIS_HOOK_OBSERVE_ONLY=1` is set. |
| `DEADLINE`, `HOOK_DEADLINE` or `WATCHDOG` | The deadline passed before the sidecar answered. `WATCHDOG` means the watchdog answered for a launcher that hung. |
| `TIMEOUT`, `HANDSHAKE_TIMEOUT`, `BUSY`, `ECONNREFUSED`, `CLOSED` or a `CONNECT_` code | The connection to the sidecar failed or was too slow. |
| `SIDECAR_STARTING` | The sidecar is starting. Later events will be forwarded. |
| `SIDECAR_UNAVAILABLE` | No sidecar could be reached or started. Check `jevris status`. |
| `SIDECAR_SERVICE_START_REFUSED` or `SIDECAR_SERVICE_UNREACHABLE` | A service is installed for this home, and its manager (launchd, systemd or Task Scheduler) refused to start the sidecar or could not be reached, while the sidecar the service runs is alive but not answering. The hook started nothing beside it and answered rules-only. Run `jevris service status`, then `jevris sidecar restart`. When the sidecar is simply not running, a refusing or unreachable manager makes the hook start the sidecar on demand instead, and you see `SIDECAR_STARTING`. |
| `SIDECAR_AUTOSTART_OFF` | `JEVRIS_SIDECAR_AUTOSTART=0` is set and no sidecar is running, so none was started. Run `jevris sidecar start`, or unset the variable. |
| `SIDECAR_REFUSED`, or a code such as `SCOPE_DENIED` or `DELIVERY_BODY_MISMATCH` | The sidecar refused the event. `DELIVERY_BODY_MISMATCH`: a second event reused an earlier event's delivery key but carried a different body, so the earlier answer was not shown for it. |
| `DUPLICATE_DELIVERY` | The same event was already recorded. |
| `DUPLICATE_REPLAYED` | The harness sent the same event again within 5 minutes, and the first delivery's answer went out in time. The hook shows that same answer again, unchanged. Nothing runs again, so nothing is spent or applied twice. If the first delivery missed its deadline, the retry reads `DUPLICATE_DELIVERY` instead. |
| `NO_RESULT`, `NO_SUBSCRIBER_RESULT` or `NO_PROPOSAL` | The sidecar recorded the event and had nothing to add. |
| `SUBSCRIBER_QUEUED` | The sidecar recorded the event, but a subscriber did not answer within its time slice, so any advice it had was not waited for. Nothing is applied from it. The queued work still runs, in order per session. If it repeats, the machine may be under heavy load; `jevris status` shows the sidecar's state and queues. |
| `NOT_CERTIFIED` | A subscriber proposed context or a route, but it is not certified for this harness version, so it was not applied. Check `jevris doctor`. |
| `PROPOSED_BY_<SUBSCRIBER>` | The outcome a subscriber proposed was applied. |
| `ROUTE_NOT_RENDERED` or `ROUTE_INPUT_CUT` | A certified route was not applied: the adapter could not write it for this call (for example, the call already names a model), or the input had been cut to fit. |
| `STOP_CONTINUATION` | The agent was asked to continue once for missing verification evidence. |
| `KILL_SWITCH` | The kill switch is on. |
