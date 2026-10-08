# Jevris in Antigravity

This guide covers Google Antigravity on macOS, Linux and Windows. Every command below is in
`jevris help`. `--harness` accepts either `antigravity` or `agy`: both name the harness, not a
binary.

## Which Antigravity

Antigravity comes as three products. All three load plugins, hooks, MCP servers and skills
from the same global folder, `~/.gemini/config/plugins/<name>/`, and that is where
`jevris install` writes the Jevris plugin. So one install serves all three.

| Product | How it is found | Loads the Jevris plugin | Can be certified headlessly |
| --- | --- | --- | --- |
| Antigravity CLI (`agy`) | On PATH, or in its installer's folder: `~/.local/bin` on macOS and Linux, `%LOCALAPPDATA%\agy\bin` on Windows | Yes, in headless runs and sessions | Yes: it is the only product with a headless interface |
| Antigravity app (Antigravity 2.0, bundle id `com.google.antigravity`) | macOS: `/Applications/Antigravity.app` or `~/Applications` | Yes, inside the app | No: plugins load only in the GUI |
| Antigravity IDE (bundle id `com.google.antigravity-ide`) | macOS: `/Applications/Antigravity IDE.app` or `~/Applications` | Yes, inside the editor | No: plugins load only in the GUI; its `antigravity-ide` launcher opens the editor and does not run the agent |

Google documents no Windows or Linux install location for the app or the IDE, so Jevris does
not guess one there. `jevris doctor` names each product it finds on one line:

```
harness antigravity products: Antigravity CLI (agy) 1.2.11, certified for >=1.2.11 <1.3.0; Antigravity app 2.12.2 (GUI only); Antigravity IDE 2.5.5 (GUI only); all three load ~/.gemini/config/plugins/jevris; certify needs the CLI, because the app and IDE load plugins only in their GUI
```

## Install

Preview the plan first. `--dry-run` prints every planned change and changes nothing:

```
jevris install --harness antigravity --dry-run
```

Then apply it. Use `--yes` when you are not at a terminal:

```
jevris install --harness antigravity --yes
```

The runtime is copied to `<data>/runtime/<version>`, and the plugin's MCP server and hooks
point there. `<data>` is:
- `~/.jevris` on macOS
- `~/.local/share/jevris` on Linux
- `%LOCALAPPDATA%\Jevris` on Windows

Every changed file is backed up first. If a step fails, every change is restored.

If `agy` is found, install also registers the plugin with it. `agy plugin install` copies a
folder into `~/.gemini/config/plugins/<name>` and refuses that folder itself as the source, so
Jevris hands it a private copy from its data folder, which `agy` copies back unchanged, and then
deletes the copy. `agy plugin list` then shows `jevris`. If `agy` is not found, the app and the
IDE still load the plugin; install `agy` and run `jevris install --harness antigravity` again to
register it with the CLI. Jevris never writes into `~/.gemini/antigravity-cli/plugins` by hand.

## Files written

All of these are Jevris files, in Antigravity's documented global plugin location:

| Path (under your home) | What it is |
| --- | --- |
| `.gemini/config/plugins/jevris/plugin.json` | The plugin manifest, taken from `plugins/antigravity/plugin.json`. |
| `.gemini/config/plugins/jevris/mcp_config.json` | The MCP server, with the absolute runtime path: `{"mcpServers": {"jevris": {"command": "node", "args": ["<runtime>/plugins/shared/mcp.js", "--harness", "antigravity"]}}}`. The `--harness` argument tells the server which harness it serves, for handoff capability negotiation. |
| `.gemini/config/plugins/jevris/hooks.json` | One named hook group, `jevris-observe`. It covers PostToolUse (matcher `.*`), PreInvocation, PostInvocation and Stop. Each runs `node "<runtime>/dist/hook.mjs" --harness agy --event <Name>` with a 5 s timeout. The group is `"enabled": false` until a certification record covers your Antigravity version. |
| `.gemini/config/plugins/jevris/skills/jevris-<name>/SKILL.md` (and `reference.md`) | The 9 `jevris-*` skills, rendered from `plugins/shared/skills`. |
| `<data>/antigravity-install-receipt.json` | The receipt, with paths relative to your home. |

## Config keys

Install edits no shared config file. Everything Jevris needs lives in its own plugin folder.
If an earlier pre-release build added a `mcpServers.jevris` entry to `~/.gemini/config/mcp_config.json`, the
upgrade removes that entry and keeps the rest of the file.

## Verify inside Antigravity

- `agy plugin list` shows `jevris` as enabled.
- In Antigravity, `/mcp` lists the `jevris` server and its 17 tools.
- In a session, ask for the `jevris_status` tool.

Then run:

```
jevris doctor --harness antigravity
```

Doctor also runs the installed MCP server's handshake and this harness's hook fixture through
the installed launcher. It prints `harness antigravity mcp handshake: ok (...)` and
`harness antigravity hook fixture: ok (...)`, or `failed` with the reason.

Until Antigravity is certified on this host, the harness line ends with:
`not certified: no signed record covers this version on this host; fix: jevris certify --harness agy`.

## Certify

`jevris install` runs this certification for you after it installs (unless you pass
`--no-certify`). When that certification passes, install enables the hook group in the same run
and prints `antigravity hooks: enabled (certified in this run)`. Run certify yourself when an
install `certify` line names a fix, or after you upgrade the harness.

Certification needs the Antigravity CLI, `agy`, installed and signed in to Google. It uses a
temporary profile, never yours, and never opens the app or the IDE:

```
jevris certify --harness agy
```

`agy` is found on PATH first, then in its installer's folder. Install it with the official
installer (antigravity.google/docs/cli/install) if needed. Without it, certify prints
`jevris certify antigravity: not certified` and then:
`agy (the Antigravity CLI) is not on PATH or in its install folder; install it with the
official installer (antigravity.google/docs/cli/install) to certify Antigravity.`
When the app or the IDE is installed, the message adds that they load plugins only in the GUI,
so they cannot be certified headlessly. A record made with `agy` covers the plugin files that
the app and the IDE read too, but their in-GUI behavior is not certified by it.

The checks certify runs (`agy plugin install`, `agy plugin list`, `agy --help`, `agy models`
and the installed hook launcher) make no model call, so agy 1.2.11 did not need a Google
sign-in in the temporary profile. Antigravity has no custom model endpoint, so it has none of
the stub-provider cases the other harnesses run: whether `agy --model` accepts a routed model
slug is checked only in a real run on the maintainer's machine.

**The model listing (`models.list`).** Certify runs `agy models` twice with
`AGY_CLI_DISABLE_AUTO_UPDATE=true`, the opt-out Antigravity's documentation names (only the
literal `true` works; `1` does not, per agy issue 1046). Whether that keeps agy from writing its
`updater` files on `agy models` is not documented, so the certify run decides: any file under
`.gemini/antigravity-cli/updater` on either run fails the listing with `LISTING_SELF_UPDATE` and
the listing stays off, because a listing must never update your binary. Directly in
`.gemini/antigravity-cli`, the second run may touch the conversation database's `-shm` (and its
`-wal` when it is empty or gone), logs, and the cache of MCP tool descriptors
(`mcp/<server>/<tool>.json`, `instructions.md`); a conversation, config or any other file still
fails it with `LISTING_SIDE_EFFECT`.

Why the descriptor cache is allowed: `agy models` starts every MCP server in your configuration
(the global `~/.gemini/config/mcp_config.json`, the workspace `.agents/mcp_config.json` and the
plugins' `mcp_config.json`, Jevris's own included) and rewrites each server's descriptor cache as it
loads them. On the recorded second run that was 18 files under `mcp/jevris_jevris/`: 17 tool
descriptors and `instructions.md`. Antigravity documents no flag, environment variable or setting
that skips MCP loading for a run. Its changelog (1.1.9) says headless and one-shot runs block on MCP
server loading, its documented `disabled` key is per server, and issue 1088 reports that print mode
starts servers marked `"disabled": true` anyway. So Jevris cannot switch the loading off, and the
allowance is limited to descriptor files (`.json` names that do not look like a token, credential
or session, and `instructions.md`) directly under `mcp/<server>/`. If Antigravity adds such a switch,
the listing should use it and the allowance should go.

How often this runs: the sidecar lists Antigravity's models at most once a day (24 hours after the
last refresh), when the installed `agy` version changes, and when it has no listing yet. It does so
only while idle, one harness at a time, each run bounded to 10 seconds. Each run starts your
configured MCP servers once.

If a record comes from a `jevris certify` run outside install, reinstall to enable the hook
group:

```
jevris install --harness antigravity --yes
```

## What the hooks do

The hooks only observe:
- PostToolUse answers `{}`.
- PostInvocation answers `{}`.
- Stop answers with a decision that lets the stop proceed, with one exception, the verification
  stop gate. The agent must have stopped on its own (`model_stop`), be fully idle, and still be
  missing the evidence a certified reminder names. Then the first Stop answers
  `{"decision":"continue"}`, and its reason names only the missing evidence ids. A second Stop
  in the same run proceeds (`executionNum` 2 or more), so the gate continues once only.
- With `verification.backgroundAtStop` on (off by default), a Stop of the main agent that finds
  approved checks missing or stale also queues them in the background, and answers as above. Only in
  `bounded-auto` mode: in `advise` mode a Stop never runs checks. See
  [verification.md](../verification.md#background-verification-at-stop).
- Once `hooks.context` is certified, PreInvocation can add one ephemeral message. The other
  hooks cannot show text, so advice that comes due on them, such as a loop explanation after a
  failed tool call, is held for the session and sent as that message before the next
  invocation (at most the four newest, for up to an hour), once.
- A PostToolUse that carries an `error` gives the content-free failure record behind
  repeated-failure advice (closed codes and one-way digests that stay on this machine, never the
  error text, the command or a path). The error is free text: several lines, Windows line ends,
  colour codes and any length are all a failure (the hook cuts a string that would not fit its input
  limit, and the failure rules read the first 20,000 characters, with spacing, paths, hex ids and
  numbers folded, so the same failure with other line numbers is the same failure), and only its first
  line is kept as evidence. An `error` that is empty, blank or not text means the call did not fail.
  PostToolUse shows nothing, so when the same failure comes
  back the one advice line (which evidence would help most next, or that the repair attempts are
  used up) is held for the session and sent as the ephemeral message before the next invocation,
  once. The ephemeral message is part of the model's input, so the model reads the line. Until
  then the sidecar keeps the line in its memory for up to 10 minutes, never on disk, and drops it
  if it is not delivered in that time or the sidecar restarts. An event with no usable
  conversation id (the id can be null) is given no waiting line and gets no repeated-failure
  advice, because its failures cannot be told from another conversation's. Antigravity forwards
  no prompt text, so there is no new-task advice here. See [settings.md](../settings.md#jev-assist).
- Antigravity has no SessionStart event, so the one-line orientation the other harnesses get when a
  session starts is not sent here. The MCP server instructions and the `jevris-guide` skill carry it.

No hook ever denies or approves a tool.

A Stop that ended on an error (`terminationReason` `error`) is recorded as a failed turn: the
event carries only the fixed flag `errored: true`, never the error text. When the error text
matches a pinned access-limit pattern, the hook also sends an access signal, as an owned run's
port does, and keeps only the pattern's id and any stated reset. The wording is not certified on
Antigravity, so the limit is classified as uncertified. A Stop that ended any other way
(`model_stop`, `max_steps_exceeded`) carries neither, and counts as a finished turn.

What that pauses, on the `google` host under an unknown sign-in: a per-minute or per-second limit,
60 s; a daily or quota limit, 5 h (a stated reset is not trusted, since no wording is certified
here); a weekly limit, 7 days; "credit balance is depleted", "API key was reported as leaked" and
"API key is missing, invalid, or expired", each held as a 5-hour pause, never one with no expiry.
Other refusals, such as a bare 401 or `PERMISSION_DENIED`, are not recognised. An overload is
never a pause. These need the Stop hook, which install enables once `hooks.observe` is certified.
There is no certify case for Antigravity sessions, so `access.session` stays unsupported. See
[routing.md](../routing.md#what-jevris-notices-when-you-run-out).

## Owned workers

Jevris can run a task as an owned worker in the Antigravity CLI (never the app): one
`agy --input-format stream-json --output-format stream-json` turn
(`@jevris/cli/antigravity-worker`), with `--sandbox` and the model and effort chosen at start.
You never start it yourself. It starts only after you submit work (`jevris plan --submit`, or
`jevris_submit_task` in owned mode), under a lease, when Antigravity is the harness chosen for
the task's model ([routing.md](../routing.md#which-harness-runs-it)).

- The run works in the task's own git worktree, on its own branch, with the worktree as its
  working directory.
- The prompt goes on stdin as one user event, never on the command line.
- A registry model goes as its Antigravity slug, which names the effort (for example
  `gemini-3.8-flash-low`), so no `--effort` goes with it. A model id the registry does not
  know runs as given, with `--effort`.
- Jevris stops the run past 40 tool steps or after 30 minutes (`--print-timeout`). The CLI
  reports tokens, not money, so the run cannot be stopped at the task's budget.

Least privilege is weaker here than in the other harnesses:

- Antigravity takes tool pre-approval only from `~/.gemini/antigravity-cli/settings.json`,
  which Jevris never writes. Run headless, it allows reads and writes inside the workspace,
  and soft-denies shell commands unless that file allows them.
- So Jevris enforces the grant by watching the run. The run is killed and refused if:
  - the session starts in any permission mode other than `request-review`, or outside the
    worktree;
  - a tool step falls outside the grant: a write when only reads were granted, a shell command
    without Bash, or any web tool.
- **A read-only grant is enforced after the fact, not before.** The step has already started
  when Jevris sees it. The worker's outcome records this as `readOnlyEnforcement:
  after-the-fact`.
- Jevris never passes `--dangerously-skip-permissions`.

Antigravity signs in with a Google account. Its headless docs name no API-key sign-in, so an
`api-key` worker is refused. A subscription run sees no vendor or Google key. `jevris doctor`
shows this on one line:

```
harness antigravity auth: google sign-in (auto: always its Google sign-in; Antigravity refuses api-key)
```

An access limit ends the run as `access-limit`, and an overloaded service as `overloaded`, not as
the task failing. Antigravity reports a limit only as text, so the run is read for Gemini's own
error sentences in the result's error, else in the last 4 KiB of stderr of a failed run: a
depleted credit balance, an API key reported as leaked or as missing, invalid or expired, a daily,
usage or weekly quota, the per-minute or per-second limit, and a temporary overload. Only the
pattern's id and the stated reset are kept, never the text. Until a certify capture proves the
wording on your version, credit and a blocked key are held as a timed pause, and the pause lasts
the default time rather than the stated one.

If `workers.json` states `"antigravity": "api-key"`, the line says that owned workers there are
refused and how to fix it.

Using Antigravity this way is within its terms, as the project read them on 27 September 2026. Jevris runs
the official `agy` binary, under your own Google sign-in, with the models Antigravity offers. It
never takes that sign-in or its model access into another harness, product or API client.
Antigravity's terms forbid using its sign-in to reach Antigravity from other software, and Jevris
does not do that. So owned workers, routing and exploration among Gemini models here use the
Antigravity sign-in. Gemini models in OpenCode or Kilo are different: they follow the Gemini API
terms for the sign-in used there.


**Status in this build.** Certification does not gate the launch in 1.2. A submitted task whose
model runs here starts on its approved model whether or not `worker.route` is certified for
your agy version. Without it, route learning only advises: it does not change the model or set
an effort.

Certification (`worker.route`, "certified pending first use"): `jevris certify --harness agy`
checks, with no model call, that `agy --help` lists every flag the worker passes and that the
worker port passes the nine conformance cases against a stand-in, never the real `agy`.
Antigravity has no stub case, so certify never runs a worker turn on `agy` at all. It does not
prove the exact worker launch against your installed Antigravity. The record also states that a
read-only grant is enforced after the fact. On first use, the `init` event is checked before any
tool runs: `permission_mode`, the working directory and the model. A mismatch stops the run,
demotes `worker.route` for that version and starts one background re-check. Doctor's
`harness antigravity worker:` line shows the state, and adds that a read-only grant is enforced
after the fact. See [routing.md](../routing.md#what-certification-covers-for-owned-workers-in-12).

## Unsupported here

`jevris doctor` prints these on the `harness antigravity parity:` line:

- **PreToolUse.** Antigravity treats a PreToolUse `decision: "allow"` as auto-approving the tool call, which would override your native permissions. So Jevris never registers PreToolUse, a deliberate difference from the other harnesses. If a PreToolUse event reaches the adapter anyway, it prints nothing, so it makes no decision.
- **Compaction context.** Antigravity has no compaction events. A session saves its capsule with `jevris_checkpoint` and gets it back through the `jevris_handoff_export` tool. For the same reason there is no compaction omission check (C20) here; `jevris_checkpoint` with `contextPercent` still gives compaction-readiness advice (C19) when the caller says how full the context is.
- **Subagent routing (`hooks.route`).** No Antigravity hook can change a subagent's model. Jevris owned workers choose the model when the run starts instead (see Owned workers). For advice, use `jevris route`. The shared [model tier](../routing.md#model-tiers) applies here as advice text only (there is no actuator), within Google's own models and only with local evidence of a rung; the Google models in the registry are priced alike, so there is no rung a tier away and it is dormant today.
- **Status line.** Antigravity has no plugin status line. Run `jevris status`.
- **Permission decisions and the stop gate in a subagent.** Jevris makes no permission decision in a subagent, so Antigravity's own permissions govern it. The verification gate holds only the parent's Stop: Antigravity has no SubagentStop hook, and it does not document whether its hooks run inside a subagent.
- **Access limits in your own sessions (`access.session`).** Antigravity has no custom endpoint, so certify has no case for it. A session limit is still read from a Stop that ended on an error, through pinned text patterns only (see What the hooks do).

See [parity-matrix.md](parity-matrix.md) for all five harnesses.

## Uninstall

Preview what would be removed, then uninstall while keeping your data:

```
jevris uninstall --harness antigravity --dry-run
jevris uninstall --harness antigravity --keep-data
```

To also delete all Jevris data on this machine:

```
jevris uninstall --harness antigravity --delete-data
```

When `agy` is found, uninstall runs `agy plugin uninstall jevris`, then removes the files
the receipt lists.

## Windows

The plugin lives under `%USERPROFILE%\.gemini\config\plugins\jevris`, and `agy` is found
on PATH or in `%LOCALAPPDATA%\agy\bin`. Recording Windows takes one command on a
Windows machine with the Antigravity CLI installed:

```
jevris certify --harness agy
```
