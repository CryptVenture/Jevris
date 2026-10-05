# Jevris in Kilo

This guide covers the Kilo CLI (`kilo`, tested with 7.7.9 and 7.8.1) on macOS, Linux and Windows. It
uses the flags in `jevris help install`, `jevris help uninstall`, `jevris help doctor` and
`jevris help certify`.

## Install

Preview first. `--dry-run` prints every planned change, file by file, and changes nothing:

```
jevris install --harness kilo --dry-run
```

Then apply the plan. `--yes` is required when you are not at a terminal:

```
jevris install --harness kilo --yes
```

Install copies the Jevris runtime to `<data>/runtime/<version>`, and every Kilo entry points
there, never at the npm cache or a checkout. `<data>` is:
- `~/.jevris` on macOS
- `~/.local/share/jevris` on Linux
- `%LOCALAPPDATA%\Jevris` on Windows

Every file install changes is backed up first, and all of them are restored if any step
fails. Exit code 1 means a step failed and everything was restored. Exit code 2 means
nothing was changed.

## Sign-in: subscription or API key

Jevris works with either. It reads which sign-in Kilo holds from `kilo auth list`, which
lists each stored credential with its type and never its value:
- a stored OAuth login means `subscription`;
- stored keys only means `api-key`;
- no credential means no login.

An Anthropic OAuth login does not count, because Claude models through Kilo need an API key.
If nothing can be read and nothing is stated, `jevris install` asks you once on a terminal and
records your answer in `workers.json`.

Jevris never reads, copies or shows a key or a token. It records only the mode: whether a
harness runs on a subscription login or on an API key. `jevris doctor` shows one line per
harness, for example:

```
harness kilo auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)
```

To choose the mode yourself, put it in `workers.json` in the Jevris config folder:

```json
{ "schemaVersion": "jevris-workers-1", "auth": { "kilo": "subscription" } }
```

Each harness can be `auto`, `subscription` or `api-key`, and a stated mode always overrides
what Jevris detects. `auto` (the default) decides for the provider of the model being run:
`api-key` when that provider's key is in the environment or an API key for it is stored in
Kilo, `subscription` when only a login is stored for it, and a refusal before launch
(`<PROVIDER>_NO_LOGIN`, for example `XAI_NO_LOGIN`) when Kilo holds nothing for it. A run
on a stored key is recorded as `api-key`. See
[routing.md](../routing.md#harness-sign-in-subscription-or-api-key) for the full order.

### Grok (xAI) models

Both work for Grok in Kilo: a SuperGrok login through Kilo's own sign-in, or an xAI API
key in `XAI_API_KEY`. Some SuperGrok plans may not include access from third-party harnesses;
this is not confirmed for every plan. If a Grok request fails with 403, your plan may not
include it, and `XAI_API_KEY` is the way in.

A `subscription` run never sees `XAI_API_KEY`, so it cannot bill the key by accident. To run
Grok on the key, set `XAI_API_KEY` or store the xAI key in Kilo; `auto` then uses it. To
keep the SuperGrok login while the key is set, state `subscription` for Kilo in
`workers.json`. When `XAI_API_KEY` is set,
`jevris doctor` names it (the name only, never the value), for example:

```
harness kilo auth: api-key (stated in workers.json; the harness reports an API key; XAI_API_KEY in the environment for Grok models)
```

## Files written

All paths are under your home directory: `~` on macOS and Linux, `%USERPROFILE%` on Windows.
`XDG_CONFIG_HOME` moves `.config` when it points inside the home.

| Path | What it is |
| --- | --- |
| `.config/kilo/plugin/jevris.js` | The Jevris Kilo plugin. It is rendered from the shared template `plugins/shared/shim.js` with Kilo's values from `plugins/kilocode/harness.json`, and bound to `<runtime>/dist/hook.mjs`. |
| `.config/kilo/skills/jevris-<name>/SKILL.md` (and `reference.md`) | The 9 skills, `jevris-status` through `jevris-guide`, rendered from `plugins/shared/skills`. |
| `.config/kilo/kilo.jsonc`, or `kilo.json` when no `.jsonc` exists | One key is added, `mcp.jevris`. Everything else in the file is kept byte for byte. |
| `<data>/kilocode-install-receipt.json` | The receipt: every path and edit Jevris made, stored relative to your home. |

Kilo also reads skills from `~/.claude/skills` and `~/.agents/skills`, and Jevris installs
nothing there. So each Jevris skill shows up in Kilo exactly once.

## Config keys

In `kilo.json[c]`, install adds one key:

```
"mcp": { "jevris": { "type": "local", "command": ["node", "<runtime>/plugins/shared/mcp.js", "--harness", "kilocode"], "enabled": true } }
```

That is the only key Jevris adds, and uninstall removes only that key.

## Verify inside Kilo

- `kilo debug info`: the plugin list names `.../kilo/plugin/jevris.js`.
- `kilo mcp list`: `jevris` shows as `connected`.
- `kilo debug skill`: lists `jevris-status`, `jevris-plan`, `jevris-route`, `jevris-checkpoint`, `jevris-recover`, `jevris-verify`, `jevris-explain`, `jevris-configure` and `jevris-guide`, each once.
- In a Kilo session, ask for the `jevris_status` tool. It answers with Jevris mode, sidecar state and the kill switch.

Then, outside Kilo:

```
jevris doctor --harness kilo
```

Doctor also runs the installed MCP server's handshake and this harness's hook fixture through
the installed launcher. It prints `harness kilocode mcp handshake: ok (...)` and
`harness kilocode hook fixture: ok (...)`, or `failed` with the reason.

The harness line reads `harness kilocode: installed; version 7.7.9; ...`. It ends in one of two ways:
- `certified for <version range> (last verified <version>, <date>): plugin.install, mcp.tools, skills.discovery, hooks.observe, hooks.context`
- `not certified: no signed record covers this version on this host; fix: jevris certify --harness kilo`

`jevris install` runs this certification for you after it installs (unless you pass
`--no-certify`). To run it yourself, for example after an upgrade, use the command below. It installs into a temporary profile, never
into your own:

```
jevris certify --harness kilo
```

## What the plugin does

The plugin forwards native events to the Jevris hook launcher and never makes a permission
decision:
- 7 hooks: `event`, `tool.execute.before`, `tool.execute.after`, `chat.message`, `command.execute.before`, `experimental.session.compacting` and `experimental.chat.system.transform`.
- 11 bus events: `session.created`, `session.idle`, `message.updated` (finished assistant messages only), `session.compacted`, `session.deleted`, `session.error`, `permission.asked`, `permission.replied`, `file.edited`, `command.executed` and `todo.updated`.

A turn that ends on an error is recorded as an access limit when its error says which: the
failed assistant message (`message.updated` with `info.error`) gives the error's name, status
and body code, with its provider; a `session.error` gives one only when it names the provider (a
sign-in error). The message, the body and the header values are never kept, and a failed
message is marked `errored`, so it never counts as a success. A project config that redefines
the provider records nothing.

What a session pause looks like: a rate limit takes its reset from the response headers, else
60 s backing off to 1 h; Z.ai's window codes, or any 429 whose headers give a reset more than
1 h away, pause the account until then (weekly when Z.ai's weekly code or the error says so);
HTTP 402 or a credit code, and HTTP 401 or an auth error, pause with no expiry. These events are
always installed; certify's `kilocode.session.error` case (`access.session`) proves them on your binary. A session's
sign-in is not known, so a pause covers both sign-ins on that serving host, owned runs included,
until a later turn finishes or you clear it with `jevris route limits clear`. See
[routing.md](../routing.md#what-jevris-notices-when-you-run-out).

Every event is fire-and-forget: at most 8 run at once, and any extra is dropped. There are two
exceptions. Compaction waits at most 1.5 s and may only add lines to `output.context`,
and only once `hooks.context` is certified for your Kilo version. Jevris saves the capsule and
adds its mandatory lines there, once per session (the restore Claude Code gets at SessionStart). A new session also gets one orientation line (the mode, "advice only; permissions unchanged", and a pointer to `jevris_status`), held until the session's next message and sent once, when `hooks.context` is certified and Jevris is on. A top-level session's message
and an unpinned `task` call each wait at most 300 ms (below, and Model routing).

**What the model sees on a turn.** When you send a message in a top-level session, the plugin
waits for Jevris's answer for up to 300 ms. It keeps any advice or explanation that comes back,
then adds it to the system prompt of every model call in that turn, through
`experimental.chat.system.transform`. Adding it needs no further call to Jevris. The next
message replaces the text, and the turn's end (`session.idle`) or deleting the session clears
it. A subagent's messages never wait. A slow answer adds nothing and is counted as
`SHIM_TIMEOUT`. Advice text shows only once `hooks.context` is certified for your version.

Advice that comes due between messages, such as a loop explanation after a failed tool call or a
stop reminder, is held for the session and sent with your next message (at most the four newest,
for up to an hour), once.

The plugin counts the deliveries it loses, which the launcher cannot see. That covers an event
dropped past the 8-call cap, a launcher that could not start, a compaction the plugin stopped
waiting for, and a launcher killed at its hard timeout (5 s for a delivery the plugin waits on:
compaction, a top-level message or an unpinned `task` call; 30 s otherwise).
Each is counted once, as `SHIM_DROPPED`, `SHIM_SPAWN_FAILED`, `SHIM_TIMEOUT` or `SHIM_KILLED`.
The counts travel with the next event that reaches the launcher, which writes one line per miss
(at most 64 per delivery) to `<state>/hook-latency.pending.jsonl` for the sidecar's latency
counters. No event content is kept.

A failed tool call becomes failure evidence, as in Claude Code. There are two cases:
- A bash call that exits non-zero: `metadata.exit` in `tool.execute.after`.
- A tool that throws: it never reaches `tool.execute.after`, but its part in `message.part.updated` ends in state `error`.

Both cases also give the content-free failure record behind repeated-failure advice (closed codes
and one-way digests that stay on this machine, never the error text, the command or a path), the
same as in Claude Code. A tool event cannot show a message in Kilo, so when the same failure comes
back the one advice line (which evidence would help most next, or that the repair attempts are used
up) waits for your next message and is added to that turn's system prompt, once. New-task advice
reads the `chat.message` text of the first message of a session, only with source egress approved. Its answer comes after the turn
has started, so it is shown with your next message. Both are advice only: they never block a message or a tool call and rewrite nothing (see
[settings.md](../settings.md#jev-assist)). Unlike a Claude Code or Codex `systemMessage`, the line is added to the system prompt, so the model reads it. A line that
has to wait is kept in the sidecar's memory for up to 10 minutes, never on disk, and is dropped if it is not shown in that time or the sidecar restarts. A message that carries the new session's orientation line shows that line alone; a waiting line it outranked is not taken, and comes with the next message. Only the first
message of a session is read for new-task advice, so a first message of fewer than 4 words (`NEW_TASK_TOO_SHORT`) uses up the session's one chance.

A `session.compacted` event carries no summary, so there is no compaction omission check (C20) here. A session saves its capsule with `jevris_checkpoint`, which also gives compaction-readiness advice (C19) when it is told how full the context is.

Only the first line of the output or error is kept as evidence. Every other part update is still
dropped. This was read from the OpenCode source at v1.18.32 and Kilo at v7.8.1.

**Background verification at Stop.** `session.idle` of a top-level session is a Stop, so with
`verification.backgroundAtStop` on (off by default) it queues the approved checks that are missing
or stale in the background, like any other harness's Stop. A child session's idle is a subagent's
Stop and never queues. There is no stop gate here, so nothing continues the agent; the receipts
are there for the next Stop or session. Only in `bounded-auto` mode: in `advise` mode an idle never
runs checks. See
[verification.md](../verification.md#background-verification-at-stop).

A subagent runs as a child session, and only its `session.created` names the parent
(`parentID`). The plugin remembers the parent of up to 512 child sessions and reports the
child's events under the parent session, as that subagent's work. The child's start, prompt,
idle, compaction and end become worker events, so a subagent never starts a task, stops a turn
or ends the parent's session.
The child's start carries the agent it runs as (`payload.agentType`) when the task tool gave it
its usual title, `<description> (@<agent> subagent)`. Only the agent name is kept, never the
description. The child's prompt always carries it.

## Model routing

Each route writes a model and nothing else: no tool, permission, prompt or config changes. Each is
certified on its own, only when its stub case passes on your installed binary
(`jevris certify --harness kilo`; no provider is called), and until then Jevris only advises
(`jevris route`, the `jevris-route` skill). The maintainer's certify run on macOS on 28 September 2026
certified both for Kilo 7.8.1, by that machine's local key. Other operating systems and versions are
certified when certify passes there.

- **A subagent (`hooks.route`).** A `task` call in a session the plugin saw
  start, which names no `model`, `provider` or `variant` of its own, waits at most 300 ms for
  Jevris's route. A call that names any of them is your pin and is never routed. Kilo's `task`
  tool does not apply a model argument, so the plugin holds the route for the child session that
  call starts and writes it to the child's first message, with its variant. It does so only when
  the child still runs on its parent's turn model (an agent with a model of its own is a pin),
  runs as the agent the call asked for, and no other `task` call of that parent is in flight.
  Later messages of the child keep the model Kilo stored for it. `kilocode.subagent-route` must
  pass for `hooks.route` to be certified: the subagent ran on the routed model while the parent
  kept its own.
- **A main-session turn (`session.route`).** From the second message of a session the
  plugin saw start, the plugin also asks the sidecar's `route.turn` about that message, next to its
  event and within the same 300 ms. It writes the answer to that message's model only when the
  sidecar says to switch and the answer names this session and this message. The sidecar says so
  only under `routing.mainSession` `plugin-bounded-auto`, for a session linked to a low-risk task,
  with the kill switch clear, no budget exhausted, no model pin, and `session.route` certified (see
  [security.md](../security.md#routing-authority)). It also needs a model that route learning has
  promoted for the task's slice, so a new workspace gets advice only. Kilo stores the session's model before the
  plugin sees the message, so a switch changes that one turn, and the next turn runs on the
  session's own model. The plugin reads the model Kilo resolved for the message, not the one the
  message names, which is empty when you did not pick one. The first message the plugin sees in a
  session is never switched. When you change the model or variant yourself, that turn and the rest
  of the session are never switched.
  `kilocode.session-route` must pass for `session.route` to be certified: the routed turn ran on the
  probe's model and the next, unrouted turn on the session's own.
- **A route through a gateway (`route.host`, serving hosts).** A route that changes the session's
  serving host, or any route through a gateway or third-party host (`openrouter/...`), needs
  `route.host` as well as `session.route`. Certify proves it with two cases against the loopback
  stub. `kilocode.session-route-host` switches a turn on `openrouter/moonshotai/kimi-k3` to
  `openrouter/z-ai/glm-5.3` through a probe plugin's `output.message.model`: the harness must send
  the turn to the same provider with the nested id, and the next turn must return to the session's
  model; the plugin's guard, run on the folder the harness handed it, must allow the route there.
  `kilocode.session-route-host-redefined` adds a project config that redefines
  `provider.openrouter`, and the same guard, run on that folder, must refuse the route. It passes
  on the guard's refusal alone; its detail notes whether kilo itself sent the turn to the
  project's redefined provider, which is why Jevris relies on its own guard and not on the
  harness. A same-maker route through the maker's own API needs only
  `session.route`.
- **Listed host spellings (`models.list-hosts`).** `kilocode.models-list-hosts` runs `kilo models`
  with gateway and host providers in the throwaway profile's config. Each of
  `openrouter/moonshotai/kimi-k3`, `kilo/moonshotai/kimi-k3`, `kilo/z-ai/glm-5.3` and
  `nvidia/moonshotai/kimi-k3` must be kept as its own spelling on its own host (the NVIDIA line as evidence
  only), and no `:free` or `~` line may be kept.
- **Where the host features stand.** Neither `models.list-hosts` nor `route.host` fails the
  harness. Until a certify run on your version passes these three cases, doctor lists them as not
  certified (`MODELS_LIST_HOSTS_NOT_RUN`, `ROUTE_HOST_CASE_NOT_RUN`, or
  `ROUTE_HOST_NEEDS_SESSION_ROUTE` when `session.route` did not pass in the same run), and a route
  through a gateway or third-party host stays advice only. The maintainer's certify run of 28 September
  2026 came before these cases, so no record certifies them yet; the next `jevris certify` run does.
- **The model listing (`models.list`).** Certify runs `kilo models` twice in the throwaway profile
  (`KILO_DISABLE_AUTOUPDATE=1`, `KILO_NO_DAEMON=1`) and checks the second run. Between the two runs
  it folds the profile's SQLite write-ahead logs into their databases (`kilo.db`), so frames the
  warm-up run left in `kilo.db-wal` when it was killed are not counted as a change of the second
  run. What the second run may still touch is `kilo.db-shm`, an empty or missing `kilo.db-wal`,
  caches and logs. A `kilo.db` that changed, or a `kilo.db-wal` that holds data, is a real write and
  fails it with `LISTING_SIDE_EFFECT`. The maintainer's first check (30 September 2026) named exactly
  those files, which is what the fold addresses; a certify run on the version after this change
  shows whether they were the warm-up's. The record of an earlier run keeps its result until you run
  `jevris certify --harness kilo` again.
- **Your project's config wins.** A route is never written to a provider that your project
  redefines, for example with its own `baseURL`. Before writing, the plugin reads `kilo.json[c]` and `opencode.json[c]`, at the folder itself and in its `.kilo` and `.kilocode` folders, in each
  folder from the working directory up to the worktree root. It writes nothing when one of them
  defines `provider.<the route's provider>`, cannot be read, is larger than 256 KiB, does not parse,
  or links outside the worktree. Kilo also loads the primary checkout's config inside a linked git worktree, which the plugin does not follow, so it writes no route in a linked worktree. Your global config is trusted and not read. It also writes nothing when any of them holds `{env:` or `{file:`, even in a comment: Kilo fills those in before it reads the file, keys included, so the plugin could not see which provider the file names. The files are read when the plugin loads and again before each route, and a refusal found at load holds until the harness restarts. The check gets
  200 ms.
- Any doubt, error or timeout writes nothing, and the harness runs as it chose. A route is only
  ever a model id from the model registry, after the provider consent check.

## Owned workers

Jevris can run a task as an owned worker in Kilo: one headless `kilo run --format json`
turn in the task's worktree (`@jevris/cli/kilo-worker`). You never start it yourself. It starts
only after you submit work (`jevris plan --submit`, or `jevris_submit_task` in owned mode), under
a lease, when Kilo is the harness chosen for the task's model
([routing.md](../routing.md#which-harness-runs-it)).

- The prompt goes on stdin, never on the command line.
- The run uses a Jevris agent given in `KILO_CONFIG_CONTENT`. It denies every tool, then
  allows only the tools the task was granted. Web tools, subagents and paths outside the
  worktree stay denied. The same rules go in `KILO_PERMISSION` for every agent. Your own
  config cannot widen them. If the Jevris agent did not load, the run is refused.
- A permission ask is rejected, never approved on your behalf. Jevris never passes `--auto`.
- The agent's `steps` caps the model steps. Jevris also stops the run past the step cap or the
  budget. Effort is `--variant`.
- `KILO_NO_DAEMON=1`: the run never attaches to a running Kilo daemon, which would run it in
  the daemon's environment instead of the one Jevris shaped.
- On a subscription, every provider key is removed from the run's environment, so it uses the
  login Kilo stored (for Grok, a SuperGrok login works). With `api-key`, the model's
  provider key must be set, and `KILO_AUTH_CONTENT={}` hides stored logins from the run.
- The model goes as the id the model registry gives for Kilo, `provider/model` with the
  models.dev provider ids Kilo ships (for example `zai/glm-5.3`, `moonshotai/kimi-k3`,
  `deepseek/deepseek-v4-pro`). A model the registry names no Kilo id for is refused, unless you
  give your own `provider/model`, which passes as given. The key variables for `api-key` are the
  providers' own: `ZHIPU_API_KEY` for Zai, `MOONSHOT_API_KEY` for Moonshot and `DEEPSEEK_API_KEY`
  for DeepSeek (as models.dev lists them).
- A Claude model here needs `api-key` with `ANTHROPIC_API_KEY`: a Claude subscription login
  runs only in Claude Code, so Jevris refuses it (`ANTHROPIC_LOGIN_THIRD_PARTY`).
- An access limit ends the run as `access-limit` (or `overloaded`), not as the task failing.
  Jevris reads the error event's name (`APIError`, `ProviderAuthError`), its status, the
  structured code of a response body of at most 8 KiB, and the reset headers. A provider sign-in
  error is a blocked account, with the sign-in command. The message, the body and the header
  values are never kept. A run whose project config redefines the provider reports no limit.
  A pause with no expiry here clears with `jevris route limits clear` or a success, and, on an
  API-key run, when the key Jevris passed changes: the maker's key (such as `MOONSHOT_API_KEY`)
  for a direct run, or `OPENROUTER_API_KEY` for a run through OpenRouter. Kilo sees no stored
  login on a key run, so that variable is its only credential. When a maker's key is in two
  variables with different values, no new-key clear is offered. A key set in your Kilo config
  (`provider.<id>.options.apiKey`) is not seen: a new key clears only the key in the
  environment, so a run that still uses the config's key is refused and paused again.


**Status in this build.** Certification does not gate the launch in 1.2. A submitted task whose
model runs here starts on its approved model whether or not `worker.route` is certified for
your kilo version. Without it, route learning only advises: it does not change the model or
set an effort.

Certification (`worker.route`, "certified pending first use"): `jevris certify --harness kilo`
checks, with no model call, that `kilo run --help` lists every flag the worker passes
(`--format`, `--model`, `--agent`, `--dir`, `--variant`) and that the worker port passes the nine
conformance cases against a stand-in, never the real `kilo`. The real binary runs only in the
stub cases, against a local stub provider with a dummy key and a simpler command line than a
worker's. So certify does not prove the exact worker launch against your installed Kilo.
On first use, the first event must be a `step_start` of
one session and the Jevris agent must have loaded. A failed check demotes `worker.route` for
that Kilo version and starts one background re-check. Doctor's `harness kilocode worker:`
line shows the state. See [routing.md](../routing.md#certification-of-worker-routing).

Kilo's JSON events do not name the model that answered. Certify's
`kilocode.worker-actual-model` case checks, against the loopback stub, that an owned run's
own plugin events report the model its request carried; it certifies `worker.actual-model`.
Without it the model an owned run reports stays unconfirmed, and the harness still certifies.

## Unsupported here

`jevris doctor` prints these on the `harness kilocode parity:` line:

- **Status line.** Kilo has no plugin status line. Run `jevris status`.
- **Legacy Kilo VS Code extension.** Not supported. Jevris writes neither `.kilocode/mcp.json` nor `mcp_settings.json`, and `jevris doctor --harness kilo` says so on its parity line. Use the Kilo CLI (`kilo`), which `jevris install` configures.
- **Permission decisions in a subagent.** Jevris makes none, so Kilo's rules for the subagent's agent, plus the parent's denies, govern it, and no Kilo stop is held. The child's events are recorded under the parent session (see What the plugin does).

The full matrix for all five harnesses is in [parity-matrix.md](parity-matrix.md):

| Feature | Kilo |
| --- | --- |
| Skills | 8 `jevris-*` skills in `~/.config/kilo/skills` |
| MCP tools | 17 tools, through `mcp.jevris` |
| Hooks and events | 7 hooks and 11 bus events |
| Context injection | Advice on each turn's system prompt, once certified; the capsule's mandatory lines at compaction, once certified |
| Route advice | A subagent's first message (`hooks.route`) and a main-session turn's model (`session.route`), each once certified; advice through `jevris route` |
| Status line | Unsupported |
| Certify | macOS: certified on the maintainer's machine by its local key, `worker.route` included; `hooks.route` and `session.route` certified for Kilo 7.8.1 when their stub cases passed (28 September 2026); `models.list` not certified (`LISTING_SIDE_EFFECT`); `models.list-hosts` and `route.host` not certified until a certify run passes their three host cases; Linux and Windows pending ([Certification](parity-matrix.md#certification)) |

## Uninstall

Preview first:

```
jevris uninstall --harness kilo --dry-run
```

Then remove Jevris. Your decisions and settings stay in the Jevris data folder (this is the
default):

```
jevris uninstall --harness kilo --keep-data
```

Or remove Jevris and also delete all Jevris data on this machine:

```
jevris uninstall --harness kilo --delete-data
```

Uninstall removes only what the receipt lists. If you edited a Jevris file after install,
it is reported and left in place. `kilo.json[c]` loses only `mcp.jevris`.

## Upgrading from an earlier Jevris

Earlier pre-release builds used another layout. Install migrates it: `~/.kilo/plugin/jevris.js` and the un-prefixed skills in
`~/.kilo/skills`. It looks only at files an old receipt lists and at the known old locations, and
removes one only when its content marks it as Jevris's. From `kilo.json[c]` it removes only the
`jevris` entry. Other skills in that folder are kept, and a listed file that is not recognisably
Jevris's is reported and left in place.

## Windows

Paths are the same under `%USERPROFILE%`. The MCP server runs as `node` from the runtime copy
in `%LOCALAPPDATA%\Jevris\runtime\<version>`. The Windows record takes one command
on a Windows runner with Kilo installed:

```
jevris certify --harness kilo
```
