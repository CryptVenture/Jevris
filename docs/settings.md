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
- **advise**: Jevris also shows advice: hook context, a subagent route as advice text, and the
  one Stop continuation that asks for missing verification evidence (it counts as advice).
- **bounded-auto**: Jevris may also act where a signed certification covers the harness: route a
  subagent, switch a Kilo or OpenCode main-session turn, and start owned workers for plans you
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
| `privacy.sourceEgress` | `deny-until-approved` | administrator | `deny-until-approved`, `approved-scoped` | no | yes (`egress`) |
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

Keys that `configure set` refuses explain why. For example, `privacy.sourceEgress` needs
administrator consent through host policy, and `provider.credentialRef` is managed with
`jevris credential`.

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

Otherwise a submitted task is queued and reported as `QUEUED`. A task that names no model is
`QUEUED_NO_MODEL` only when no eligible model is found. With orchestration enabled and
`routing.managedWorkers` at `observe` or `advise`, the router still records which model it
would have chosen for a task that names one, and nothing is started.

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

Which harness runs a worker, and whether it signs in with a subscription or an API key, is set
in `workers.json`, not in these settings. Route learning, which picks a worker's model and
effort per task slice, has its own commands (`jevris route learning`). Both are in
[routing.md](routing.md).

## Jev assist

`jev.assist` (default `classify`) lets Jevris ask Jev a bounded classification question where the answer is a label and a rules answer exists: today, the task slice of a `jevris route` request that names none (planned in the same release; see [routing.md](routing.md)). Jev answers from structured features (counts, categories, codes), never source text, so the question widens nothing that may leave the machine; the answer is advice, labelled as Jev's, and never an approval, a signed prior or a switch.

- `classify`: the question is asked. Rules answer first when they are sure; Jev is asked when they are not, inside the hot-path deadline, from the decision cache when the same features were asked before.
- `off`: every such decision is rules-only. Nothing is sent and nothing is spent.

It follows the rest of the controls: below `observe` mode, with the kill switch on, with the Jev circuit open, billing or access disabled, or with no budget left (`BUDGET_MACHINE_LIMIT`, `BUDGET_WORKSPACE_CAP`), the decision runs rules-only and says why. A repository's `.jevris/config.json` can only set it to `off`. `jevris status` and `jevris configure` show it.

## Raising what Jevris may do

A `jevris configure set` that raises `mode`, `routing.managedWorkers`, `routing.mainSession`,
`routing.firstTry` (`baseline` to `auto`), `jev.assist` (`off` to `classify`), `decisions.monthlyBudgetMicroUsd` or `verification.backgroundAtStop` (`off` to `on`) above its current effective value (your file under the
administrator ceilings) needs a person at an interactive terminal who answers `y`. So does a
`jevris configure workspace-budget` that raises this workspace's cap or removes it. `configure set` shows the change and asks. It never takes `--yes`, and it refuses
`--json`, a pipe, a script, a hook, a model's shell and a test run (`JEVRIS_TEST=1`) before it
asks anything, with this line:

```text
Nothing was changed (CHANNEL_REFUSED): raising mode to advise widens what Jevris may do, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).
```

For the Jev decision budget the line says what the raise does instead: `raising
decisions.monthlyBudgetMicroUsd to 8000000 lets Jevris spend more on Jev calls, so it needs a
person at an interactive terminal ...`. With `--json` the same text is the message of an error
line whose code is `CHANNEL_REFUSED`.
MCP never changes settings at all. Lowering, setting the value a key already has, and a dry run
need no one. The one-time upgrade of the mode (see [Modes](#modes)) and install's defaults are not raises made
through `configure set`, so they do not ask.

## Background verification at Stop

`verification.backgroundAtStop` is off by default. When you turn it on, a Stop of your main
session that finds approved checks missing or stale queues those checks to run in the background,
so the next Stop or session finds fresh receipts. It never blocks the Stop and never waits for a
run. It queues only checks in the current approval record, only when Jevris is on in
`bounded-auto` and the kill switch is clear, and never for a subagent's Stop. Receipts are
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
