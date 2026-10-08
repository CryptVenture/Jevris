# Jevris settings

Jevris keeps its own product settings in one file. These settings never change your
harness's native permissions: Claude Code, Codex, OpenCode, Kilo Code and Antigravity keep
deciding what a tool may do.

## Where the settings live

| File | Location | Who writes it | What it can do |
|---|---|---|---|
| `jevris.config.json` | the Jevris config directory (below) | you, with `jevris configure set` | sets the product settings |
| `.jevris/config.json` | the root of a repository | anyone who can commit to the repository | may only lower limits or switch features off |
| `organization.json` | the Jevris config directory | your administrator | sets a ceiling that nothing else can exceed |

Owned-worker sign-in (`workers.json`) and route learning are kept apart from these settings;
see [routing.md](routing.md). Every other file Jevris reads is listed in
[configuration.md](configuration.md).

The Jevris config directory is:

| OS | Directory |
|---|---|
| macOS | `~/.config/jevris` |
| Linux | `$XDG_CONFIG_HOME/jevris` (usually `~/.config/jevris`) |
| Windows | `%APPDATA%\Jevris` |

When you pass `--home <dir>` or set `JEVRIS_HOME`, the directory is `<home>/.config/jevris` on
macOS and Linux, and `<home>\AppData\Roaming\Jevris` on Windows.

## Precedence

Jevris builds the effective settings in this order. A later layer can only make things safer:

1. **Defaults** (the values in the table below).
2. **Your file**, `jevris.config.json`. Jevris checks it against the configuration contract.
   A missing file means the defaults. A file that is present but cannot be used (an unknown
   key or a wrong value, broken JSON, a file you cannot read, or a directory in its place) is
   ignored: the defaults are used, the mode is capped at `observe`, and `jevris configure`,
   `jevris status` and `jevris doctor` show a `user:` issue with the reason (see
   [Your file cannot be used](#your-file-cannot-be-used)).
3. **The repository file**, `.jevris/config.json`. Repository content is not trusted, so it
   may only lower the keys marked "workspace may lower" below. Anything else in it is ignored
   and reported as `NOT_NARROWABLE`, and a value of the wrong kind as `INVALID_VALUE`.
4. **Your organization's policy**, `organization.json`. It caps the mode, source egress,
   telemetry, retention, request size and the monthly Jev decision budget, and it pins the
   provider model.
5. **The administrator's ceilings on the mode and the Jev decision budget**: the `mode` and
   `budget.monthlyDecisionMicroUsd` in `host.json` and in a managed `policy.json`
   ([configuration.md](configuration.md#managed-policy-administrators)). With `organization.json`,
   the lowest of them wins. A mode ceiling also caps `routing.managedWorkers`.

A ceiling only lowers, so it still applies when its file would not count as an authority for
egress (not owned by you, writable by others, or inside a repository); the reason is shown as
an issue. A policy file that is a symbolic link, cannot be read or does not match the
host-policy contract caps the mode at `observe`, as does a refused managed policy, and the
problem is shown as an issue (`host:`, `organization:` or `managed:` and a code).

Last, the effective mode bounds two routing keys: `routing.managedWorkers` never exceeds it, and
below `bounded-auto` the main session is `advice-only`. `jevris configure` shows these as changed
by the layer that set the mode.

`jevris configure` shows the effective value of each key, which layer changed it, and `mode set
by`: the defaults, your file, or the ceiling that set the mode. `jevris status` and the
`jevris_status` tool show the effective `mode`, where it comes from (`modeSource`) and any
settings issue, from the same layers, whether the sidecar or the local reduced report answers.

## Modes

`mode` is the single ceiling on what Jevris does. Each mode adds one thing to the one before it:

| Mode | Records facts | Asks Jev (recorded, never shown) | Shows advice | Acts |
|---|---|---|---|---|
| `off` | no | no | no | no |
| `observe` | yes | yes | no | no |
| `advise` | yes | yes | yes | no |
| `bounded-auto` (default) | yes | yes | yes | yes, on certified capabilities |

- **off**: the hooks are a no-op. Nothing is recorded, Jev is not asked and nothing is shown.
  `jevris route`, `plan`, `recover` and `advise`, their MCP tools, and `jevris credential
  reenable` are refused with `MODE_OFF` and name the command that turns Jevris back on.
  Read-only commands keep working: `status`, `explain`, `doctor`, `configure`, `evidence get`
  and `verify` of your local checks. Any other command runs without asking Jev. The sidecar's
  own background work that reaches a harness or the network (the harness model listing, with
  Codex's usage read, and the certification re-check) does not run; local work (the store,
  retention) still does. The kill switch (`jevris kill-switch activate`) is separate and still
  stops everything in any mode.
- **observe**: Jevris records the facts of each event and asks Jev what it would have advised.
  That answer is recorded as a decision under `observe`; nothing is shown and no model is switched.
- **advise**: Jevris also shows advice: hook context, a subagent route as advice to the model (a
  PreToolUse context where `hooks.context` is certified, else text for you), and the
  one Stop continuation that asks for missing verification evidence (it counts as advice).
- **bounded-auto**: Jevris may also act where a signed certification covers the harness: route a
  subagent (on Claude Code, a low-risk launch to a cheaper model for that one call), switch a Kilo or OpenCode main-session turn, and start owned workers for plans you
  submit, each within its own gates (approved scope, budget, route learning).

`routing.mainSession`, `routing.managedWorkers` and `orchestration.enabled` can only narrow the
mode, never widen it. Each decision record names the mode it was made under.

Raising the mode with `jevris configure set` (to any value above the effective one, such as
`observe` to `advise`) needs a person at a terminal; lowering it, or setting the value it already
has, does not. See [Raising what Jevris may do](#raising-what-jevris-may-do).

Upgrading: before this release the default was `observe`, and `jevris configure set` always
wrote the whole file, so a file it wrote says `"mode": "observe"` whether or not you chose it.
Once per home, the sidecar at start (or the first `jevris configure set`) changes such a file to
`bounded-auto` and keeps every other key. After that one time, `observe` is your choice and is
never changed again. When your mode was moved, `jevris status` and `jevris doctor` show this line
until you run any `jevris configure set mode`, or for 30 days:

```text
Mode moved from observe (the old default) to bounded-auto by the 1.2 upgrade; run `jevris configure set mode observe` to go back.
```

## Showing and changing settings

```
jevris configure                         # show the effective settings
jevris configure set <key> <value>       # change one setting
jevris configure set <key> <value> --dry-run   # show the change without writing it
```

`configure set` accepts only the keys marked "you" in the table. It prints a key-by-key
difference and writes the file owner-only. It never edits native harness settings.

The file must hold every key except `routing.modelListing`, `decisions.monthlyBudgetMicroUsd` and `verification.backgroundAtStop`: one with another key missing does not match the contract and cannot be
used (see [Your file cannot be used](#your-file-cannot-be-used)). `configure set` always writes
the whole file, so the easiest way to start one is to set any key with it.

## Every key

| Key | Default | Who can change it | Values | Workspace may lower | Organization caps it |
|---|---|---|---|---|---|
| `mode` | `bounded-auto` | you (a raise needs you at a terminal; see [Raising what Jevris may do](#raising-what-jevris-may-do)) | `off`, `observe`, `advise`, `bounded-auto` | yes | yes (`mode`) |
| `provider.kind` | `typesafe-direct` | administrator | fixed | no | no |
| `provider.model` | `jev-1.13.0` | administrator | provider id | no | yes (`pin.model` replaces it) |
| `provider.credentialRef` | `host-secret:typesafe-primary` | `jevris credential` only | reference, never a secret | no | no |
| `decisions.hotPathDeadlineMs` | `900` | you | 100 to 30000 | yes | no |
| `decisions.backgroundDeadlineMs` | `5000` | you | 500 to 120000 | yes | no |
| `decisions.maxRequestBytes` | `131072` | administrator | bytes | no | yes (`budget.maxRequestBytes`) |
| `decisions.maxQuestions` | `12` | you | 1 to 12 | yes | no |
| `decisions.monthlyBudgetMicroUsd` | `5000000` (5 USD) | you (a raise needs you at a terminal; see [The Jev decision budget](#the-jev-decision-budget)) | 0 to 1000000000 whole micro-USD; `0` means no Jev calls (rules-only) | yes (for that workspace only) | yes (`budget.monthlyDecisionMicroUsd`, also in `host.json` and a managed policy) |
| `decisions.allowUncalibratedActuation` | `false` | nobody | always `false` | no | no |
| `privacy.sourceEgress` | `deny-until-approved` | you, as your own half of the consent only (raising it to `approved-scoped` needs you at a terminal; see [Source egress has two halves](#source-egress-has-two-halves)); the administrator's half is `jevris egress approve` | `deny-until-approved`, `approved-scoped` | no (a repository file cannot set it) | yes (`egress`) |
| `privacy.remoteTelemetry` | `off` | you may set `off` only | `off`, `approved-aggregates` | no | yes (forced `off` when `organization.json` denies egress) |
| `privacy.rawArtifactRetentionDays` | `7` | you | 0 to 365 | no | yes (`retention.rawArtifactRetentionDays`) |
| `privacy.decisionRetentionDays` | `30` | you | 0 to 3650 | no | yes (`retention.decisionRetentionDays`) |
| `routing.mainSession` | `plugin-bounded-auto` | you (a raise needs you at a terminal); `owned-sdk-approved` needs an administrator | `advice-only`, `plugin-bounded-auto`, `owned-sdk-approved` | no | yes (`advice-only` below `bounded-auto`) |
| `routing.managedWorkers` | `bounded-auto` | you (a raise needs you at a terminal; see [Raising what Jevris may do](#raising-what-jevris-may-do)) | `off`, `observe`, `advise`, `bounded-auto` | yes | yes (`mode`) |
| `routing.modelListing` | `on` | you | `on`, `off` | yes (switch off) | no |
| `routing.firstTry` | `auto` | you (raising `baseline` to `auto` needs you at a terminal; see [Raising what Jevris may do](#raising-what-jevris-may-do)) | `auto`, `baseline` | yes (lower to `baseline`) | yes (`mode`: it does nothing below `bounded-auto`) |
| `jev.assist` | `classify` | you (turning it back on from `off` needs you at a terminal; see [Raising what Jevris may do](#raising-what-jevris-may-do)) | `off`, `classify` | yes (switch off) | yes (`mode`, the Jev budget and the kill switch apply) |
| `verification.backgroundAtStop` | `off` | you (turning it on needs you at a terminal; see [Raising what Jevris may do](#raising-what-jevris-may-do)) | `off`, `on` | yes (switch off) | yes (`mode`: it does nothing below `bounded-auto`) |
| `routing.respectHumanPins` | `true` | nobody | always `true` | no | no |
| `routing.calibrationArtifact` | `null` | the release process | artifact id or `null` | no | no |
| `orchestration.enabled` | `true` | you | `true`, `false` | yes (switch off) | no |
| `orchestration.maxConcurrentWorkers` | `2` | you | 1 to 32 | yes | no |
| `orchestration.maxWorkerDepth` | `1` | you | 0 to 4 | yes | no |
| `orchestration.maxRepairAttempts` | `2` | you | 0 to 10 | yes | no |
| `orchestration.maxStopContinuationsPerCondition` | `1` | not through `configure set` | `0` (no Stop reminder), `1` | no | no |
| `compaction.nativeAutoDeferral` | `false` | you may set `false`; turning it on needs a certified adapter | `false` | no | no |
| `compaction.preserveMandatoryFacts` | `true` | fixed | `true` | no | no |
| `compaction.rawTranscriptEditing` | `false` | fixed | `false` | no | no |
| `packs` | `jevris.observability`, `jevris.memory`, `jevris.skill-advice` | pack commands | pack ids | no | no |

Keys that `configure set` refuses explain why. For example, `provider.model` is set by host
policy, and `provider.credentialRef` is managed with `jevris credential`. `privacy.sourceEgress`
is not one of them: it is your own half of source-egress consent, and you set it with `configure
set` at a terminal (see [Source egress has two halves](#source-egress-has-two-halves)).

Some keys are checked and shown, but not yet read by the product in 1.2:

- The decision engine uses its built-in limits instead of the `decisions.*` keys: at most
  131072 request bytes and 12 questions, with each decision's own deadline. It always requests
  `jev-1.13.0`, whatever `provider.model` says.
- `orchestration.maxWorkerDepth` limits nothing yet.
- Jevris sends no remote telemetry, whatever `privacy.remoteTelemetry` says.

`routing.mainSession` is `plugin-bounded-auto` from install. In `bounded-auto` mode it lets
Jevris switch the model of a Kilo or OpenCode main-session turn, and only when that harness's
`session.route` certify case passes, the task is low-risk, the kill switch is not stopped and no budget is exhausted. Every
other harness stays advice-only. `jevris configure set routing.mainSession advice-only` turns it
off. `jevris status` shows one `main session` line per harness: the mode it runs under and
either that its turns may be switched or why they get advice only, with the reason code. Without
the sidecar no certification is read, so every harness shows advice only. `jevris explain` on a
Kilo or OpenCode turn decision names the mode that turn ran under and whether its model was
switched.

`jevris configure show` reports source egress as the host decision that the egress guard
enforces, the same one `jevris egress status` shows, and then your `jevris.config.json`
preference apart from it:

```text
source egress: deny-until-approved (host policy; see jevris egress status); your jevris.config.json preference: approved-scoped
```

A preference of `approved-scoped` in your file never approves egress on its own. In `--json`,
`effective.sourceEgress` is the host decision, `effective.sourceEgressSource` is
`host-policy`, and `effective.sourceEgressPreference` is the file's value, or `null` when no
valid file sets it. Change the decision with `jevris egress approve` or `jevris egress revoke`.

## Source egress has two halves

Text from your workspace reaches Jev only when both halves of consent are on:

- **The administrator's half** is host policy: `jevris egress approve` at an interactive
  terminal writes `egress: approved-scoped` to `host.json`. It is what the egress guard enforces
  on every request, and what `effective.sourceEgress` shows. See
  [privacy.md](privacy.md#approving-egress).
- **Your half** is `privacy.sourceEgress` in your own `jevris.config.json`. Advice that quotes
  your text to Jev (the memory and compaction advice and the on-demand capabilities that quote
  what you give them; see [privacy.md](privacy.md#what-can-leave-this-machine)) is asked only
  when your half is `approved-scoped` as well. It never lets text out on its own: with the
  administrator's half missing, nothing is sent whatever your file says.

Set your half with `jevris configure set privacy.sourceEgress approved-scoped`. That widens what
may leave the machine, so it is a raise (see [Raising what Jevris may do](#raising-what-jevris-may-do)):
it needs a person at an interactive terminal who answers `y`, and it is refused before anything is
asked, with `CHANNEL_REFUSED`, from `--yes`, `--json`, a pipe, a script, a hook, MCP or a test
run:

```text
Nothing was changed (CHANNEL_REFUSED): raising privacy.sourceEgress to approved-scoped is your half of the consent for what may leave this machine, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).
```

`jevris configure set privacy.sourceEgress deny-until-approved` lowers it and asks no one. Every
written change, a raise or a lowering, is recorded in the audit log (`policy.change`, with the key
and the two values and nothing else; `jevris audit export`). A repository's `.jevris/config.json`
cannot set it at all (it is ignored with a `NOT_NARROWABLE` issue, as a repository file is not
consent), and an organization's `egress: deny-until-approved` caps it. Editing the file by hand
gives the same value, and any program that runs as you can do that; the terminal check is the
same-user limit described in [security.md](security.md#changes-that-need-a-person-at-a-terminal).

## The Jev decision budget

`decisions.monthlyBudgetMicroUsd` is the machine-wide monthly limit on Jevris's own Jev decision
calls, in whole micro-USD (1 USD is 1000000). Every workspace on this machine spends from it.
The default is 5000000 (5 USD); the range is 0 to 1000000000 (1,000 USD, a bound on a typo).
`0` means no Jev calls: every decision runs rules-only, and `jevris status` and
`jevris configure` say so. The key is optional in your file; without it the default applies.

| Change | Who |
|---|---|
| Raise the limit above its effective value | a person at an interactive terminal who answers `y` (never `--yes`, `--json`, a pipe, a script, MCP, a hook or a test run) |
| Lower it, or set the value it has | anyone who can run `jevris configure set`; nothing is asked |
| Cap it | `budget.monthlyDecisionMicroUsd` in `host.json`, `organization.json` or a managed policy; the lowest wins |
| Lower it for one workspace | that repository's `.jevris/config.json` (`decisions.monthlyBudgetMicroUsd`); a higher value there is ignored |

A ceiling file that cannot be used caps the limit at 5 USD. A `jevris.config.json` that cannot
be used gives the defaults, 5 USD, never the value it held.

A workspace may also have its own monthly cap inside the limit, kept per machine and set with
`jevris configure workspace-budget [<micro-usd>|none]` (see
[configuration.md](configuration.md#the-jev-decision-budget)). A first cap and a lower one need
nothing; a higher cap or `none` needs a person at an interactive terminal, with the same refusals.
The lower of that cap and the repository's value applies to the workspace. When the limit or a
workspace's cap has no room left, decisions there run rules-only with the reason codes
`BUDGET_MACHINE_LIMIT` or `BUDGET_WORKSPACE_CAP` (and `BUDGET_ZERO` when that cap is 0) until the
next calendar month (UTC). A change applies to the next decision without restarting the sidecar,
and the month's spent amount is kept.

## Fixed keys

Three keys are constants in this release, because their other value would be unsafe:
`decisions.allowUncalibratedActuation` is always `false`, `routing.respectHumanPins` is always
`true`, and `compaction.rawTranscriptEditing` is always `false`. `host.json` is separate: it is
host policy for the provider gate and is not part of these settings.

## Workers

Managed workers start for a plan you submit only when all of these are true:

- `orchestration.enabled` is `true`. This is the default from install. To turn it off, set it
  to `false` with `jevris configure set`,
- `routing.managedWorkers` is `bounded-auto`. This is the default from install. It is still
  capped by the effective `mode`,
- the kill switch is not engaged,
- the task names a model, or names none and an installed harness reaches a model that consent
  allows (see [routing.md](routing.md#which-models-a-task-may-use)).

Setting `routing.managedWorkers` back to `bounded-auto` after lowering it is a raise, so it needs
a person at a terminal (see [Raising what Jevris may do](#raising-what-jevris-may-do)). Install
does not ask: it writes no `jevris.config.json`, so the defaults apply.

In `bounded-auto`, route learning changes a worker's model or effort only on low-risk routes,
and only after this workspace has 12 of its own outcomes on each arm. Every other route keeps
the task's approved model, as advice. See [routing.md](routing.md#risk-class).

Otherwise a submitted task is queued. A queued task is accepted (`accepted: true`) with no
lease (`leaseIds` is empty), and the `reasonCode` of `jevris_submit_task` says why it waits.
`jevris_get_task` shows it `ready` or `validated` (not yet promoted), never `leased` or
`running`:

| `reasonCode` | The task |
|---|---|
| `LEASED` | was not queued: a worker was leased and started (its id is in `leaseIds`) |
| `QUEUED` | waits because workers are not automatic (the conditions above), or because a prerequisite in `dependencyIds` is not verified yet |
| `QUEUED_NO_MODEL` | names no model, and no eligible model is found |
| `QUEUED_WORKER_UNSUPPORTED` | has a model, but no worker port loads on this machine |
| `CAP_REACHED` | waits because `orchestration.maxConcurrentWorkers` (default 2) workers already run; it starts when a slot frees, with no second submit |
| `RESOURCE_BUSY` | waits because a resource it declares is held by a running worker |
| `OVER_BUDGET` | waits because its reservation does not fit what is left of its root budget (`jevris budget status`). Under the `pause-all` policy this first refusal also pauses the budget, and the task keeps this reason ([below](#when-a-budget-runs-out)) |
| `BUDGET_PAUSED` | waits because its root budget is paused (`jevris budget update <id> --resume`) and the task was first refused after the pause, so it was not the one that ran the budget out |

`CAP_REACHED` is a different reason from `QUEUED` on purpose: `QUEUED` sends you to the
conditions above, and a busy cap needs nothing changed. Other lease refusals can appear for a
task that was queued while another request took its slot (`NOT_READY`, `ALREADY_LEASED`) or with
a control service (`CONTROL_UNAVAILABLE`, `CONTROL_SERVICE_REQUIRED`); the task is queued in
each case. With orchestration enabled and `routing.managedWorkers` at `observe` or `advise`, the
router still records which model it would have chosen for a task that names one, and nothing is
started.

**Telling that the queue is idle.** `jevris status` lists the `active workers` (the tasks leased or
running) and, on the next line, `queued tasks: N`: the tasks waiting for a lease or a prerequisite
(state `ready` or `validated`). `jevris status --json` and the `jevris_status` result carry the
same as `activeWorkers` and `queuedTasks`. The queue is idle when `queued tasks` is `0` and
`active workers` is `none`. Read both: `active workers: none` alone is also true for a moment
between one worker ending and the next queued task being leased, while `queued tasks` is still
above 0. There is no time bound to wait for that hand-over (it took well under a second on a
quiet machine and more than a second on a loaded one), so wait on the two values and not on a
guessed delay. `queuedTasks` is absent when the sidecar did not count (it is not running, or the
workspace is unknown).

`routing.modelListing` (default `on`) lets the sidecar ask each installed harness which models
it offers, from the harness's own model listing. Only model ids are kept, and no model is
called. A model is eligible for routing only with such local proof, or after it has run once
on that harness. Set it to `off` to stop the listing; a workspace file may turn it off, never
on.

`routing.firstTry` (default `auto`) is Sonnet-first routing for owned workers. With `auto`, a
low-risk task that has an approved acceptance check starts on a cheaper model of the baseline's
own vendor (Sonnet 5.5 against Opus 5.5 on Claude Code) and is handed once to a stronger model
when its check fails; `baseline` runs the baseline first, as before. It changes which approved
model runs first and never what Jevris may do: permissions, scopes, the kill switch, budgets and
"only a passing check completes a task" are unchanged. It applies only while `mode` and
`routing.managedWorkers` are `bounded-auto`, route learning is on for the workspace, and the
slice is not pinned. See [routing.md](routing.md#sonnet-first-routing).

You can see what the setting does in three places, none of which changes a decision or sends
anything. `jevris status` (and the `jevris_status` MCP tool) prints one `first-try slices:` line:
per harness, the first-try model, the baseline, and how many slices start on the first try, start
on the baseline or are still learning. It reads `off` when `routing.firstTry` is `baseline` or the
harness has no cheaper step (Antigravity, whose only stronger model is a preview).
`jevris explain <decision-id> --slice <slice>` gives the slice's verdict with its counts and
numbers, and `jevris cost-report` has a first-try section. See
[routing.md](routing.md#seeing-sonnet-first-routing).

Which harness runs a worker, and whether it signs in with a subscription or an API key, is set
in `workers.json`, not in these settings. Route learning, which picks a worker's model and
effort per task slice, has its own commands (`jevris route learning`). Both are in
[routing.md](routing.md).

### When a budget runs out

Each root budget has a policy for work that is already running when it runs out: `finish-running`,
`cancel-newest` (cancels the newest running task, once) or `pause-all` (pauses the budget, so
nothing new starts until you resume it; running work finishes). The reason a task waits follows
one sequence:

1. The first task whose reservation does not fit is refused `OVER_BUDGET`. Under `pause-all`, that
   refusal also pauses the budget. Under `finish-running` and `cancel-newest` the budget is never
   paused.
2. A task keeps the reason of its first refusal for as long as the episode is open. Every later look
   at the queue (a worker ends and the next task is tried) finds the budget paused, and the task
   that was refused `OVER_BUDGET` stays `OVER_BUDGET`. The code does not turn into `BUDGET_PAUSED`.
3. A task that is first refused while the budget is already paused (one submitted after the pause)
   is `BUDGET_PAUSED`.
4. A resume (`jevris budget update <id> --resume`), or a raised limit with your terminal
   authorization, answers the episode. The next refusal starts the reasons again: a task that still
   does not fit at the same limit is `OVER_BUDGET`, and the policy does not pause the budget a
   second time.

`jevris budget status <id>` shows the budget's own state and each task's reason separately. Its
first line says `Budget <id> is paused` (in `--json`, `budget.paused` and `budget.policy`), and
every refused task is listed with its own reason code. A paused budget is therefore a state of the
budget, not a second reason for the task.

## Jev assist

`jev.assist` (default `classify`) lets Jevris ask Jev a bounded question where the answer is a label or a score and a rules answer exists. `classify` covers "Jev helps classify and rank advice", in these places: the task slice of a `jevris route` request that names none (see [routing.md](routing.md#when-the-route-has-no-slice)), the slice and risk hint beside each task of a `jevris plan` (see [routing.md](routing.md#slice-hints-for-the-tasks-of-a-plan)), which approved checks matter first for the change in front of the agent, which orders the Stop reminder and the run of `jevris verify` (see [verification.md](verification.md#which-check-first)), whether a Claude Code subagent launch is low risk enough for a cheaper model for that one call (a general-purpose or custom launch only, which the rules call high and Jev may lower at the confidence floors, with the rules' high standing on any miss; the rules judge a read-only type alone; see [routing.md](routing.md#a-low-risk-claude-code-launch)), whether a tool failure that comes back with different error text is the same failure (which evidence to obtain next is the rules' own pick, in a fixed order, and is not asked of Jev: measured live, that question cleared the confidence floors in 2 of 24 answers, so the evidence check C05 is by rule only), and, only with source egress approved, the kind of a new task, one question about it and the template to start from (C01, C02 and C04, see the "Repeated-failure, new-task and scope-change advice" row of [harnesses/parity-matrix.md](harnesses/parity-matrix.md)). The same setting also covers whether a change of scope needs a look (C06, on the diff boundary), the worker-readiness advice recorded when an owned worker is launched (see [routing.md](routing.md#owned-workers)) and the memory decisions (C19 to C24: compaction readiness, the check of a compaction summary, the pick between saved capsules, the spans of a long check output, constraint conflicts and project memory, see [privacy.md](privacy.md)). Where a decision quotes text, it also needs source egress approved by the administrator and by your own `privacy.sourceEgress: approved-scoped` There is no level above `classify`, and Jev never decides: every answer is advice, and every approved check still runs. The catalogue capabilities that `jevris_advise` and the checkpoint and recover tools run (C18 to C72) ask Jev only where a rules answer exists, use its answer at the same floors as the rest (a provider confidence of 0.6 or more, and for a Choice 0.15 between its best two options) and otherwise answer from the rules. Jev answers from structured features (counts, categories, codes), never source text, except that the new-task question sends the prompt as one screened span and only with egress approved (see [privacy.md](privacy.md)), so the question widens nothing that may leave the machine; the answer is advice, labelled as Jev's, and never an approval, a signed prior or a switch.

- `classify`: the question is asked. Rules answer first when they are sure; Jev is asked when they are not, inside the hot-path deadline, from the decision cache when the same features were asked before. A task on a protected path (CI, deploy, migrations, lockfiles, secrets, auth, git internals) is not asked: it is a high risk by the locked rules whatever Jev says. A check ranking is one request with one 0 to 4 score per open check (at most 12), counts only at a confidence of 0.6 or more, orders the checks by Jev's expected score to half a level (ties go to the rules' own order), and never holds a Stop or a verify up (rules order on a miss). The same-failure question and a new-task question run after the hook has answered (at most 1.5 s, no inner retries, a late answer only fills the decision cache), so they never delay a tool; the one short line is shown at the session's next event, and the rules advice stands when Jev is not asked or misses. A repeated failure that raises no same-failure question (the same error text again, an environmental failure, the repair attempts used up) is answered by the rules in the hook's own answer, with no call. A line that has to wait is held in the sidecar's memory only, for at most 10 minutes: it is dropped if no event can show it in that time, and a sidecar restart loses it (the decision it came from is already recorded). A line is taken off the queue only when an event shows it, after every subscriber has answered: when another subscriber's certified context outranks it at an event (the orientation line a Kilo or OpenCode session gets with its first message), the line stays held, with its original expiry and in its own session, and the next event that can show it does. Where it is shown differs by harness: Claude Code and Codex show it as a `systemMessage` to you, not to the model, while Kilo, OpenCode and Antigravity put it in the model's input (see [harnesses/parity-matrix.md](harnesses/parity-matrix.md)). An open point becomes the new-task question only at a certainty of 0.75 (not the 0.6 of the other decisions): Jev read all five fixed points of a clear request as somewhat material, so a lower bar would put a question on every task. New-task advice reads only the first prompt of a session (a session is one task), so a first prompt of fewer than 4 words stops it with `NEW_TASK_TOO_SHORT` and the session gets none. An event with no usable session id gets neither kind of advice, nothing is queued for it and nothing is asked (`REPEATED_FAILURE_NO_SESSION`, `NEW_TASK_NO_SESSION`).
- `off`: every such decision is rules-only. Nothing is sent and nothing is spent.

It follows the rest of the controls: below `observe` mode, with the kill switch on, with the Jev circuit open, billing or access disabled, or with no budget left (`BUDGET_MACHINE_LIMIT`, `BUDGET_WORKSPACE_CAP`), the decision runs rules-only and says why. A repository's `.jevris/config.json` can only set it to `off`. `jevris status` and `jevris configure` show it.

### Confidence floors

An answer from Jev is used only above a floor, and the floors are fixed, conservative defaults, not learned from your use. A Score or a Choice is used at a provider confidence of 0.6 or more, a Choice also at 0.15 or more between its best two options, and a Noul at a certainty of 0.6 (the one open point of a new task at 0.75). Below a floor the rules answer, with the reason code: that is the designed safe answer, not a failure.

What the floors meet in practice was measured over the live runs of 3 and 4 October 2026 (jev-1.13.0, 564 answers to the product's own synthetic questions). A Score's confidence has a median of 0.54 and 48 percent of Score answers are at or above 0.6, because on a scale of four or five levels the probability sits on adjacent levels, not on one; the Score answers at or above 0.6 were in the expected range in 22 of 22 cases. A Choice's confidence has a median of 0.77. A Noul's certainty has a median of 0.83, and 89 percent are at or above 0.6.

The specification says why a floor is not tuned from numbers like these. Choice and Score confidence is not the probability of being right, and a threshold belongs to one question, rubric, evidence format, model and population (section 2.2); a per-question threshold is selected on a calibration set under an error budget, reported on a separate holdout and shipped in a signed release that names the question and the model (sections 18.4 and 18.5), and a single live label tunes nothing. The numbers above are the starting point for that calibration, not a replacement for it. Nothing in 1.2.0 changes a floor.

## Raising what Jevris may do

A `jevris configure set` that raises `mode`, `routing.managedWorkers`, `routing.mainSession`,
`routing.firstTry` (`baseline` to `auto`), `jev.assist` (`off` to `classify`), `decisions.monthlyBudgetMicroUsd`, `verification.backgroundAtStop` (`off` to `on`) or `privacy.sourceEgress` (`deny-until-approved` to `approved-scoped`, your half of source-egress consent) above its current effective value (your file under the
administrator ceilings) needs a person at an interactive terminal who answers `y`. So does a
`jevris configure workspace-budget` that raises this workspace's cap or removes it. `configure set` shows the change and asks. It never takes `--yes`, and it refuses
`--json`, a pipe, a script, a hook, a model's shell and a test run (`JEVRIS_TEST=1`) before it
asks anything, with this line:

```text
Nothing was changed (CHANNEL_REFUSED): raising mode to advise widens what Jevris may do, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).
```

For the Jev decision budget the line says what the raise does instead: `raising
decisions.monthlyBudgetMicroUsd to 8000000 lets Jevris spend more on Jev calls, so it needs a
person at an interactive terminal ...`, and for `privacy.sourceEgress` that it is your half of the
consent for what may leave this machine. With `--json` the same text is the message of an error
line whose code is `CHANNEL_REFUSED`.
MCP never changes settings at all. Lowering, setting the value a key already has, and a dry run
need no one. The one-time upgrade of the mode (see [Modes](#modes)) and install's defaults are not raises made
through `configure set`, so they do not ask.

## Background verification at Stop

`verification.backgroundAtStop` is off by default. When you turn it on, a Stop of your main
session that finds approved checks missing or stale queues those checks to run in the background,
so the next Stop or session finds fresh receipts. It never blocks the Stop and never waits for a
run. It queues only checks in the current approval record, only when Jevris is on in
`bounded-auto` and the kill switch is clear, and never for a subagent's Stop. In `advise` mode (and
in `observe` and `off`) it never runs or queues a check, whatever the setting says: observing,
advising and acting are separate, and only `bounded-auto` acts. With the setting on and a lower
mode, `jevris status` and `jevris configure` say so in one line. Receipts are
ordinary receipts written by the runner. See [verification.md](verification.md#background-verification-at-stop).

A repository is not consent: the workspace `.jevris/config.json` can only turn it off, so a
repository cannot start runs on your machine. Turn it on with
`jevris configure set verification.backgroundAtStop on`; that needs you at a terminal, like any
change that widens what Jevris does. `jevris status` shows its state.

## Your file cannot be used

When `jevris.config.json` is present but cannot be read, is not JSON, or does not match the
configuration contract, Jevris does not use it: the defaults apply with the mode capped at
`observe`. `jevris configure`, `jevris status` and `jevris doctor` show a `user:` issue with
one of these reason codes: `INVALID_JSON`, `INVALID_CONFIG` (an unknown key, a missing key or a
wrong value), `UNREADABLE` (you cannot read it), `TOO_LARGE` (over 256 KiB) or `NOT_REGULAR` (a
directory or other non-file in its place). A missing file is not a problem; it means the defaults.

While the file cannot be used, `jevris configure set` writes nothing and names the file and
the fix. Two fixes work:

- Correct the file by hand; `jevris configure` lists the problems.
- Run `jevris configure set mode off` or `jevris configure set mode observe`. That moves the
  file aside to `jevris.config.json.invalid` and writes a fresh file with the defaults and that
  mode. A higher mode is a raise, so it needs you at a terminal first, and even then it is
  refused until the file is fixed.

The unusable file stays in place until the fresh one is safely written, so a failure never leaves you with no file, which would mean the `bounded-auto` defaults. The
folder is checked first: if it is a link (for example a GNU Stow folder), not yours, or its
Windows ACL cannot be set, nothing is touched and the command answers `CONFIG_DIR_REFUSED` with
the folder and the fix. A write or move that fails after that (a full disk, say) answers
`CONFIG_WRITE_FAILED`, and the unusable file is still, or again, in place, so the mode stays
capped at `observe`.
