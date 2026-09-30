# Jevris in OpenCode

This guide covers the OpenCode CLI (`opencode`, tested with 1.18.32) on macOS, Linux and
Windows. Every command below is in `jevris help`.

## Install

Preview first. `--dry-run` prints each planned change and changes nothing:

```
jevris install --harness opencode --dry-run
```

Then apply it. `--yes` is required when you are not at a terminal:

```
jevris install --harness opencode --yes
```

Install copies the runtime to `<data>/runtime/<version>`:
- `~/.jevris` on macOS
- `~/.local/share/jevris` on Linux
- `%LOCALAPPDATA%\Jevris` on Windows

Every entry points at that copy. Each changed file is backed up first, and all of them are
restored if a step fails (exit 1). Exit 2 means nothing changed.

## Sign-in: subscription or API key

Jevris works with either. It reads which sign-in OpenCode holds from `opencode auth list`, which
lists each stored credential with its type and never its value:
- a stored OAuth login means `subscription`;
- stored keys only means `api-key`;
- no credential means no login.

An Anthropic OAuth login does not count, because Claude models through OpenCode need an API key.
If nothing can be read and nothing is stated, `jevris install` asks you once on a terminal and
records your answer in `workers.json`.

Jevris never reads, copies or shows a key or a token. It records only the mode: whether a
harness runs on a subscription login or on an API key. `jevris doctor` shows one line per
harness, for example:

```
harness opencode auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)
```

To choose the mode yourself, put it in `workers.json` in the Jevris config folder:

```json
{ "schemaVersion": "jevris-workers-1", "auth": { "opencode": "subscription" } }
```

Each harness can be `auto`, `subscription` or `api-key`, and a stated mode always overrides
what Jevris detects. `auto` (the default) decides for the provider of the model being run:
`api-key` when that provider's key is in the environment or an API key for it is stored in
OpenCode, `subscription` when only a login is stored for it, and a refusal before launch
(`<PROVIDER>_NO_LOGIN`, for example `XAI_NO_LOGIN`) when OpenCode holds nothing for it. A run
on a stored key is recorded as `api-key`. See
[routing.md](../routing.md#harness-sign-in-subscription-or-api-key) for the full order.

### Grok (xAI) models

Both work for Grok in OpenCode: a SuperGrok login through OpenCode's own sign-in, or an xAI API
key in `XAI_API_KEY`. Some SuperGrok plans may not include access from third-party harnesses;
this is not confirmed for every plan. If a Grok request fails with 403, your plan may not
include it, and `XAI_API_KEY` is the way in.

A `subscription` run never sees `XAI_API_KEY`, so it cannot bill the key by accident. To run
Grok on the key, set `XAI_API_KEY` or store the xAI key in OpenCode; `auto` then uses it. To
keep the SuperGrok login while the key is set, state `subscription` for OpenCode in
`workers.json`. When `XAI_API_KEY` is set,
`jevris doctor` names it (the name only, never the value), for example:

```
harness opencode auth: api-key (stated in workers.json; the harness reports an API key; XAI_API_KEY in the environment for Grok models)
```

## Files written

Paths are under your home. `XDG_CONFIG_HOME` moves `.config` when it points inside the home.

| Path | What it is |
| --- | --- |
| `.config/opencode/plugins/jevris.js` | The Jevris OpenCode plugin. It is rendered from `plugins/shared/shim.js` with OpenCode's values from `plugins/opencode/harness.json`, exports one function (`JevrisPlugin`), and is bound to `<runtime>/dist/hook.mjs`. |
| `.config/opencode/skills/jevris-<name>/SKILL.md` (and `reference.md`) | The 9 skills, rendered from `plugins/shared/skills`. |
| `.config/opencode/opencode.jsonc`, or `opencode.json` | Adds `mcp.jevris`. When Jevris creates the file, it also adds `$schema`. |
| `<data>/opencode-install-receipt.json` | The receipt, with paths relative to your home. |

OpenCode also reads every `SKILL.md` under `~/.claude/skills`. Jevris keeps its Claude plugin
out of that folder (it lives in `~/.claude/plugins/jevris-local`), so each Jevris skill appears
once in OpenCode. Never set
`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` for Jevris; it is not needed.

## Config keys

In `opencode.json[c]`, install adds:

```
"mcp": { "jevris": { "type": "local", "command": ["node", "<runtime>/plugins/shared/mcp.js", "--harness", "opencode"], "enabled": true } }
```

Every other key and comment stays byte for byte. Uninstall removes only `mcp.jevris`.

## Verify inside OpenCode

- `opencode mcp list`: `jevris` shows as `connected`.
- `opencode debug skill`: lists the 9 `jevris-*` skills, each once.
- In a session, call the `jevris_status` tool.

Then run:

```
jevris doctor --harness opencode
```

Doctor also runs the installed MCP server's handshake and this harness's hook fixture through
the installed launcher. It prints `harness opencode mcp handshake: ok (...)` and
`harness opencode hook fixture: ok (...)`, or `failed` with the reason.

The harness line says either:
- `certified for <version range> (last verified <version>, <date>): plugin.install, mcp.tools, skills.discovery, hooks.observe, hooks.context`
- `not certified: no signed record covers this version on this host; fix: jevris certify --harness opencode`

`jevris install` runs this certification for you after it installs (unless you pass
`--no-certify`). To run it yourself, for example after an upgrade, use the command below. It uses a temporary profile, not yours:

```
jevris certify --harness opencode
```

## What the plugin does

It uses the same hooks and events as Kilo, since Kilo is an OpenCode fork:
- 7 hooks: `event`, `tool.execute.before`, `tool.execute.after`, `chat.message`, `command.execute.before`, `experimental.session.compacting` and `experimental.chat.system.transform`.
- 11 bus events, read through `event.type`.

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
always installed; certify's `opencode.session.error` case (`access.session`) proves them on your binary. A session's
sign-in is not known, so a pause covers both sign-ins on that serving host, owned runs included,
until a later turn finishes or you clear it with `jevris route limits clear`. See
[routing.md](../routing.md#what-jevris-notices-when-you-run-out).

Every event is fire-and-forget: at most 8 run at once, and any extra is dropped. There are two
exceptions. Compaction may add lines to `output.context` within 1.5 s, and only once
`hooks.context` is certified. Jevris saves the capsule and adds its mandatory lines there, once
per session (the restore Claude Code gets at SessionStart). A new session also gets one orientation line (the mode, "advice only; permissions unchanged", and a pointer to `jevris_status`), held until the session's next message and sent once, when `hooks.context` is certified and Jevris is on. A top-level session's message and an unpinned `task` call
each wait at most 300 ms (below, and Model routing). Jevris never registers `permission.ask`.

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

Only the first line of the output or error is kept as evidence. Every other part update is still
dropped. This was read from the OpenCode source at v1.18.32 and Kilo at v7.8.1.

**Background verification at Stop.** `session.idle` of a top-level session is a Stop, so with
`verification.backgroundAtStop` on (off by default) it queues the approved checks that are missing
or stale in the background, like any other harness's Stop. A child session's idle is a subagent's
Stop and never queues. There is no stop gate here, so nothing continues the agent; the receipts
are there for the next Stop or session. See
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
(`jevris certify --harness opencode`; no provider is called), and until then Jevris only advises
(`jevris route`, the `jevris-route` skill). The maintainer's certify run on macOS on 28 September 2026
certified both for OpenCode 1.18.32, by that machine's local key. Other operating systems and versions are
certified when certify passes there.

- **A subagent (`hooks.route`).** A `task` call in a session the plugin saw
  start, which names no `model`, `provider` or `variant` of its own, waits at most 300 ms for
  Jevris's route. OpenCode's `task` tool takes no model, so the plugin holds the route for the
  child session that call starts and writes it to the child's first message. It does so only
  when the child still runs on its parent's turn model (an agent with a model of its own is a
  pin), runs as the agent the call asked for, and no other `task` call of that parent is in
  flight. Later messages of the child keep the model OpenCode stored for it.
  `opencode.subagent-route` must pass for `hooks.route` to be certified: the subagent ran on the
  routed model while the parent kept its own.
- **A main-session turn (`session.route`).** From the second message of a session the
  plugin saw start, the plugin also asks the sidecar's `route.turn` about that message, next to its
  event and within the same 300 ms. It writes the answer to that message's model only when the
  sidecar says to switch and the answer names this session and this message. The sidecar says so
  only under `routing.mainSession` `plugin-bounded-auto`, for a session linked to a low-risk task,
  with the kill switch clear, no budget exhausted, no model pin, and `session.route` certified (see
  [security.md](../security.md#routing-authority)). It also needs a model that route learning has
  promoted for the task's slice, so a new workspace gets advice only. OpenCode stores the session's model before the
  plugin sees the message, so a switch changes that one turn, and the next turn runs on the
  session's own model. The plugin reads the model OpenCode resolved for the message, not the one the
  message names, which is empty when you did not pick one. The first message the plugin sees in a
  session is never switched. When you change the model or variant yourself, that turn and the rest
  of the session are never switched.
  `opencode.session-route` must pass for `session.route` to be certified: the routed turn ran on the
  probe's model and the next, unrouted turn on the session's own.
- **A route through a gateway (`route.host`, serving hosts).** A route that changes the session's
  serving host, or any route through a gateway or third-party host (`openrouter/...`), needs
  `route.host` as well as `session.route`. Certify proves it with two cases against the loopback
  stub. `opencode.session-route-host` switches a turn on `openrouter/moonshotai/kimi-k3` to
  `openrouter/z-ai/glm-5.3` through a probe plugin's `output.message.model`: the harness must send
  the turn to the same provider with the nested id, and the next turn must return to the session's
  model; the plugin's guard, run on the folder the harness handed it, must allow the route there.
  `opencode.session-route-host-redefined` adds a project config that redefines
  `provider.openrouter`, and the same guard, run on that folder, must refuse the route. It passes
  on the guard's refusal alone; its detail notes whether opencode itself sent the turn to the
  project's redefined provider, which is why Jevris relies on its own guard and not on the
  harness. A same-maker route through the maker's own API needs only
  `session.route`.
- **Listed host spellings (`models.list-hosts`).** `opencode.models-list-hosts` runs `opencode models`
  with gateway and host providers in the throwaway profile's config. Each of
  `openrouter/moonshotai/kimi-k3` and `nvidia/moonshotai/kimi-k3` must be kept as its own spelling on its own host (the NVIDIA line as evidence
  only), and no `:free` or `~` line may be kept.
- **Where the host features stand.** Neither `models.list-hosts` nor `route.host` fails the
  harness. Until a certify run on your version passes these three cases, doctor lists them as not
  certified (`MODELS_LIST_HOSTS_NOT_RUN`, `ROUTE_HOST_CASE_NOT_RUN`, or
  `ROUTE_HOST_NEEDS_SESSION_ROUTE` when `session.route` did not pass in the same run), and a route
  through a gateway or third-party host stays advice only. The maintainer's certify run of 28 September
  2026 came before these cases, so no record certifies them yet; the next `jevris certify` run does.
- **The model listing (`models.list`).** Certify runs `opencode models` twice in the throwaway profile
  (`OPENCODE_DISABLE_AUTOUPDATE=1`) and checks the second run. Between the two runs
  it folds the profile's SQLite write-ahead logs into their databases (`opencode.db`), so frames the
  warm-up run left in `opencode.db-wal` when it was killed are not counted as a change of the second
  run. What the second run may still touch is `opencode.db-shm`, an empty or missing `opencode.db-wal`,
  caches and logs. A `opencode.db` that changed, or a `opencode.db-wal` that holds data, is a real write and
  fails it with `LISTING_SIDE_EFFECT`. The maintainer's first check (30 September 2026) named exactly
  those files, which is what the fold addresses; a certify run on the version after this change
  shows whether they were the warm-up's. The record of an earlier run keeps its result until you run
  `jevris certify --harness opencode` again.
- **Your project's config wins.** A route is never written to a provider that your project
  redefines, for example with its own `baseURL`. Before writing, the plugin reads `opencode.json[c]` and `.opencode/opencode.json[c]` in each
  folder from the working directory up to the worktree root. It writes nothing when one of them
  defines `provider.<the route's provider>`, cannot be read, is larger than 256 KiB, does not parse,
  or links outside the worktree. Your global config is trusted and not read. It also writes nothing when any of them holds `{env:` or `{file:`, even in a comment: OpenCode fills those in before it reads the file, keys included, so the plugin could not see which provider the file names. The files are read when the plugin loads and again before each route, and a refusal found at load holds until the harness restarts. The check gets
  200 ms.
- Any doubt, error or timeout writes nothing, and the harness runs as it chose. A route is only
  ever a model id from the model registry, after the provider consent check.

## Owned workers

Jevris can run a task as an owned worker in OpenCode: one headless `opencode run --format json`
turn (`@jevris/cli/opencode-worker`). You never start it yourself. It starts only after you
submit work (`jevris plan --submit`, or `jevris_submit_task` in owned mode), under a lease, when
OpenCode is the harness chosen for the task's model
([routing.md](../routing.md#which-harness-runs-it)).

- The run works in the task's own git worktree, on its own branch, with the worktree as its
  directory (`--dir`).
- The prompt goes on stdin, never on the command line.
- The run uses a Jevris agent given in `OPENCODE_CONFIG_CONTENT`. It denies every tool, then
  allows only the tools the task was granted. Web tools, subagents and paths outside the
  worktree stay denied. The same rules go in `OPENCODE_PERMISSION` for every agent. Your own
  config cannot widen them. If the Jevris agent did not load, the run is refused.
- A permission ask is rejected, never approved on your behalf. Jevris never passes `--auto`.
- The agent's `steps` caps the model steps at 40. Jevris also stops the run past the step cap,
  past the task's budget, or after 30 minutes. Effort is `--variant`.
- On a subscription, every provider key is removed from the run's environment, so it uses the
  login OpenCode stored (for Grok, a SuperGrok login works). With `api-key`, the model's
  provider key must be set, and `OPENCODE_AUTH_CONTENT={}` hides stored logins from the run.
- The model goes as the id the model registry gives for OpenCode, for example `zai/glm-5.3`,
  `moonshotai/kimi-k3` or `deepseek/deepseek-v4-pro`. A model the registry names no OpenCode id
  for is refused, unless you give your own `provider/model`, which passes as given. The key
  variables for `api-key` are the providers' own: `ZHIPU_API_KEY` for Zai, `MOONSHOT_API_KEY`
  for Moonshot and `DEEPSEEK_API_KEY` for DeepSeek (as models.dev lists them).
- A Claude model here needs `api-key` with `ANTHROPIC_API_KEY`: a Claude subscription login
  runs only in Claude Code, so Jevris refuses it (`ANTHROPIC_LOGIN_THIRD_PARTY`).
- An access limit ends the run as `access-limit` (or `overloaded`), not as the task failing.
  Jevris reads the error event's name (`APIError`, `ProviderAuthError`), its status, the
  structured code of a response body of at most 8 KiB, and the reset headers. A provider sign-in
  error is a blocked account, with the sign-in command. The message, the body and the header
  values are never kept. A run whose project config redefines the provider reports no limit.
  A pause with no expiry here clears with `jevris route limits clear` or a success, and, on an
  API-key run, when the key Jevris passed changes: the maker's key (such as `MOONSHOT_API_KEY`)
  for a direct run, or `OPENROUTER_API_KEY` for a run through OpenRouter. OpenCode sees no stored
  login on a key run, so that variable is its only credential. When a maker's key is in two
  variables with different values, no new-key clear is offered. A key set in your OpenCode config
  (`provider.<id>.options.apiKey`) is not seen: a new key clears only the key in the
  environment, so a run that still uses the config's key is refused and paused again.


**Status in this build.** Certification does not gate the launch in 1.2. A submitted task whose
model runs here starts on its approved model whether or not `worker.route` is certified for
your opencode version. Without it, route learning only advises: it does not change the model
or set an effort.

Certification (`worker.route`, "certified pending first use"): `jevris certify --harness opencode`
checks, with no model call, that `opencode run --help` lists every flag the worker passes
(`--format`, `--model`, `--agent`, `--dir`, `--variant`) and that the worker port passes the nine
conformance cases against a stand-in, never the real `opencode`. The real binary runs only in
the stub cases, against a local stub provider with a dummy key and a simpler command line than
a worker's. So certify does not prove the exact worker launch against your installed OpenCode.
On first use, the first event must be a `step_start` of
one session and the Jevris agent must have loaded. A failed check demotes `worker.route` for
that OpenCode version and starts one background re-check. Doctor's `harness opencode worker:`
line shows the state. See [routing.md](../routing.md#what-certification-covers-for-owned-workers-in-12).

OpenCode's JSON events do not name the model that answered. Certify's
`opencode.worker-actual-model` case checks, against the loopback stub, that an owned run's
own plugin events report the model its request carried; it certifies `worker.actual-model`.
Without it the model an owned run reports stays unconfirmed, and the harness still certifies.

## Unsupported here

These appear on the `harness opencode parity:` doctor line:

- **Status line.** OpenCode has no plugin status line. Run `jevris status`.
- **Permission decisions in a subagent.** Jevris makes none, so OpenCode's rules for the subagent's agent, plus the parent's denies, govern it, and no OpenCode stop is held. The child's events are recorded under the parent session (see What the plugin does).

See [parity-matrix.md](parity-matrix.md) for the full matrix.

## Uninstall

```
jevris uninstall --harness opencode --dry-run
jevris uninstall --harness opencode --keep-data
```

To also delete all Jevris data on this machine:

```
jevris uninstall --harness opencode --delete-data
```

A Jevris file you changed after install is reported and kept. `opencode.json[c]` loses only
`mcp.jevris`.

## Windows

Config lives under `%USERPROFILE%\.config\opencode`, and the MCP server runs as `node` from
the runtime copy. The Windows record takes one command on a Windows machine with OpenCode
installed:

```
jevris certify --harness opencode
```
