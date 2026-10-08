# Jevris in Codex

This guide covers the Codex CLI (`codex`, tested with 0.157.1) on macOS, Linux and Windows.
Every command below is in `jevris help`. Which versions and operating systems a signed record
covers is in [platform-support.md](../platform-support.md); `jevris doctor` shows what your
machine holds. See "Certify" below.

## Install

Preview first. `--dry-run` lists every planned change and changes nothing:

```
jevris install --harness codex --dry-run
```

Then apply it. Use `--yes` when you are not at a terminal:

```
jevris install --harness codex --yes
```

The runtime is copied to `<data>/runtime/<version>`:
- macOS: `~/.jevris`
- Linux: `~/.local/share/jevris`
- Windows: `%LOCALAPPDATA%\Jevris`

The plugin's MCP server and hooks point at that copy. Every changed file is backed up first,
and all changes are restored if a step fails.

When `codex` is on PATH, install also runs `codex plugin add jevris@<marketplace>`. When it is
not, install prints that command for you to run. Either way, the next step is yours: start
Codex, run `/hooks`, and review and trust the Jevris hooks. Codex does not run plugin hooks
until you do.

## The plugin v2 layout

Jevris ships as a Codex plugin in your personal marketplace. It never writes a top-level
`[mcp_servers.jevris]` table and never edits `~/.codex/hooks.json`.

| Path (under your home) | What it is |
| --- | --- |
| `.codex/plugins/jevris/plugin.json` | The plugin manifest (agent-plugins schema), from `plugins/codex/plugin/plugin.json`, with the runtime version, author, license and homepage. |
| `.codex/plugins/jevris/mcp.json` | The MCP server: `{"mcpServers": {"jevris": {"type": "stdio", "command": "node", "args": ["<runtime>/plugins/shared/mcp.js", "--harness", "codex"]}}}`. |
| `.codex/plugins/jevris/hooks/hooks.json` | 11 hooks: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop and Interrupt. Each runs `node '<runtime>/dist/hook.mjs' --harness codex` with a short explicit timeout: 10 s for PreCompact, 5 s or less for the rest, and 2 s for SessionEnd and Interrupt. On Windows each hook also gets `commandWindows`. |
| `.codex/plugins/jevris/skills/jevris-<name>/SKILL.md` (and `reference.md`) | The 9 `jevris-*` skills, rendered from `plugins/shared/skills`. |
| `.codex/plugins/jevris/skills/jevris-<name>/agents/openai.yaml` | Only for the skills that run when you ask for them (`jevris-checkpoint` and `jevris-configure`): `policy.allow_implicit_invocation: false`, so Codex never picks them by itself. |
| `.agents/plugins/marketplace.json` | One entry, named `jevris`, is added to `plugins`, with source `{"source": "local", "path": "./.codex/plugins/jevris"}`. If the file does not exist, it is created with the name `jevris-local`. |
| `.codex/config.toml` | One table is added: `[plugins."jevris@<marketplace>"]` with `enabled = true`. |
| `<data>/codex-install-receipt.json` | The receipt, with paths relative to your home. |

`CODEX_HOME` moves `.codex` when it points inside your home.

## Config keys

- `.agents/plugins/marketplace.json`: the `plugins` entry named `jevris`. Your other entries and the marketplace name are kept.
- `.codex/config.toml`: the table `[plugins."jevris@<marketplace>"]`. Your other tables, comments and blank lines stay byte for byte. Jevris appends its table at the end of the file.

Uninstall removes only these two entries.

## Verify inside Codex

- `codex plugin list` shows `jevris` as enabled.
- `codex mcp list` shows `jevris`.
- In Codex, `/hooks` lists the Jevris hooks. Trust them.
- In a session, call the `jevris_status` tool.

Then run:

```
jevris doctor --harness codex
```

Doctor also runs the installed MCP server's handshake and this harness's hook fixture through
the installed launcher. It prints `harness codex mcp handshake: ok (...)` and
`harness codex hook fixture: ok (...)`, or `failed` with the reason.

Until Codex is certified on this host, the harness line ends with
`not certified: no signed record covers this version on this host; fix: jevris certify --harness codex`.

## Certify

`jevris install` runs this certification for you after it installs (unless you pass
`--no-certify`). Run it yourself when an install `certify` line names a fix, or after you
upgrade the harness.

On a machine with Codex installed and signed in, run the command below. It uses a temporary
profile, never yours. What a record covers, and what is certified on which operating system,
is in [the parity matrix](parity-matrix.md#certification):

```
jevris certify --harness codex
```

**The model listing (`models.list`).** Certify runs `codex app-server`'s model listing twice in
the temporary profile and checks the second run. Besides caches and logs, that run may touch only
Codex's own startup files, directly in its home folder: a SQLite database's
`-shm` file, its `-wal` file when it is empty or gone afterwards, the log database
`logs_<n>.sqlite` and its side files, and anything in the temporary folder `.tmp`. Codex's
per-process helper folder `tmp/arg0/codex-arg0*` (the `apply_patch` and `applypatch` links, the exec
wrapper and a `.lock`, which Codex makes in `<home>/tmp/arg0` at every startup and clears when stale)
is a temporary folder too and never counts. Between the two runs, certify folds every write-ahead
log in the temporary profile into its database, so frames the warm-up run left behind are not
counted against the second run; a `-wal` that still holds data after the second run holds a real
write of that run (Codex's `goals`, `memories`, `queue` and `state` databases each showed one on
the first check) and fails it. Any other
write fails the listing, including a change to a main `.sqlite` file, `config.toml`,
`auth.json`, a rules file or a session. A listing that fails this check is recorded as
`LISTING_SIDE_EFFECT`, and Jevris then does not ask Codex for its model list.

## What the hooks do

PermissionRequest is never registered, so Codex's own approval stays authoritative. Without a
signed record that covers your Codex version and OS, the hooks only observe. With one, what they
may do also depends on your `mode` (see [settings.md](../settings.md#modes)):

- **Context.** Once `hooks.context` is certified, `hookSpecificOutput.additionalContext` may be
  added on SessionStart, UserPromptSubmit, SubagentStart, PostToolUse and PreToolUse (`advise`
  and `bounded-auto`). On a fresh session start the SessionStart context is one orientation line
  (the mode, "advice only; permissions unchanged", and a pointer to `jevris_status`); a compaction
  or resume sends the capsule alone.
- **Compaction, resume and project memory (Jev, advice only).** As in Claude Code, a `PostCompact` event that carries a `compact_summary` is checked in memory against the saved objective, constraints and decisions (C20), and what it left out is restored first at the next session start; an event with no summary is only recorded. A resume with more than one saved capsule is judged from counts and an age bucket, never text (C21), as in Claude Code. See [claude-code.md](claude-code.md#what-the-hooks-do) and [privacy.md](../privacy.md).
- **Stop reminder.** With approved checks whose passing evidence is missing, a Stop is blocked
  once for the same missing evidence, naming the checks, the most relevant to the change first
  (needs `hooks.context`; the order is advice, see
  [Which check first](../verification.md#which-check-first)). See
  [verification.md](../verification.md). Otherwise Stop and SubagentStop answer `{}`, as Codex
  requires, and the stop proceeds.
- **Background verification at Stop.** With `verification.backgroundAtStop` on (off by default), a
  main-session Stop that finds approved checks missing or stale also queues them in the background,
  and the Stop answers as before; a SubagentStop never queues. Only in `bounded-auto` mode: in
  `advise` mode a Stop never runs checks. See
  [verification.md](../verification.md#background-verification-at-stop).
- **Subagent routing.** The one permission decision a Jevris hook in Codex makes is the `allow` of a
  routed `spawn_agent` call, and only where `hooks.route` is certified. See "Subagent routing"
  below.

Codex has no dedicated tool-failure hook. An MCP tool whose result has `isError: true` is taken
as a failed tool call, with its first error line as evidence for recovery advice. A shell
command's `tool_response` is only its output, with no exit status, so a failing command is not
recognised as a failure (a recorded vendor limit).

Only that MCP case feeds repeated-failure advice. Its content-free failure record is the same as
in Claude Code (closed codes and one-way digests, never the error text or the tool input). A
Bash or `apply_patch` result stays a finished call and gives no failure record, so Codex gives
no repeated-failure advice for a failing shell command. New-task advice reads the `UserPromptSubmit`
prompt of the first message of a session, only with source egress approved. Both lines are shown as a `systemMessage` at the next
prompt or tool event, never block, and rewrite nothing (see
[settings.md](../settings.md#jev-assist)). A `systemMessage` is shown to you and is not put in
the model's context. A line that has to wait is kept in the sidecar's memory for up to 10
minutes, never on disk, and is dropped if it is not shown in that time or the sidecar restarts.
Only the first prompt of a session is read, so a first prompt of fewer than 4 words
(`NEW_TASK_TOO_SHORT`) uses up the session's one chance for new-task advice.

Hooks also fire in a subagent thread, on the root `session_id` with the thread's `agent_id`.
Jevris reports those events under the parent session, as that subagent's work: a subagent's
prompt or compaction is a worker event, and the verification gate answers only the parent's
Stop.

## Sign-in and owned workers

Codex works with Jevris on a ChatGPT subscription login or on an API key. `jevris doctor` asks
`codex login status` which one it holds (it only reads) and prints a `harness codex auth:` line.
`auto` means `api-key` when `OPENAI_API_KEY` or `CODEX_API_KEY` is set, else `subscription`. To
state it yourself, set `"auth": { "codex": "subscription" }` (or `"api-key"`) in `workers.json`;
see [routing.md](../routing.md#harness-sign-in-subscription-or-api-key).

An owned worker on an OpenAI model is one `codex exec` thread in the task's worktree:

- On a subscription, every vendor key is removed from the run's environment, and a stored
  API-key login, or no login, refuses the run before any model call.
- With `api-key`, the key is offered to `codex exec` as `CODEX_API_KEY`.
- The sandbox is `read-only` unless the task may write, then `workspace-write` (the worktree
  only). Network access and web search are off, `approval_policy` is `never`, and Jevris never
  passes a bypass flag. Codex's own managed requirements still apply.
- A route's effort level goes in `model_reasoning_effort`.
- Codex reports tokens, not money, so the run's spend is recorded as uncertain.
- An access limit ends the run as `access-limit` (or `overloaded`), not as the task failing.
  Codex reports a limit only as text, so Jevris matches pinned wordings in the failed turn's
  message, else an error event's, and keeps only the pattern id. stderr counts only for a run
  that exited with no error event, and only for a usage window, a rate limit or an overload. A
  credit or sign-in wording pauses for the default time, not indefinitely, until a certify
  capture proves it. A run through `OPENAI_BASE_URL` or a custom `model_provider` reports no
  limit.

**When your account runs out.** An owned Codex run ends as `access-limit` and records an access
pause, read from Codex's `exec --json` errors as the list above describes (checked by certify's
cases `codex.access-limit.rate`, `.credit` and `.auth`, feature `access.detect`). A pause with no expiry on a `CODEX_API_KEY` or `OPENAI_API_KEY` that
Jevris passes clears when that key changes. Your own Codex sessions are not read: no Codex hook
event carries a failed turn's error, so `access.session` is unsupported here. See
[routing.md](../routing.md#what-jevris-notices-when-you-run-out).

**How much of your plan is left (usage read).** On a ChatGPT sign-in, the model listing's
`codex app-server` session also sends one `account/rateLimits/read`. Codex answers it from your
account, so this is a request Codex makes to OpenAI. No model runs, and nothing is billed.
- **When:** only when `routing.modelListing` is on and `models.list` is certified. It is never sent
  with `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment, or when `codex login status` does not
  say ChatGPT.
- **What Jevris keeps:** only each window's used share as a band (under 50%, 50-80%, 80-100% or
  used up), whether it is the weekly window, its reset, and whether Codex says ordinary usage is
  allowed. Nothing else is read, such as the account id, the plan or a credit balance.
- **What it does:** a used-up window, or usage reported as not allowed, pauses owned Codex runs on
  that sign-in until the reset (a timed pause, never one with no expiry). A reading lifts that
  sign-in's usage pause only when `access.usage-read` is certified for your Codex version, it says
  usage is allowed, and nothing is used up.
- **Certify (`access.usage-read`, case `codex.usage-read`):** `jevris certify --harness codex` runs `codex
  app-server` against a local stub, under the OS's network isolation, with a dummy login in a
  throwaway folder. On macOS that is `sandbox-exec` with a profile that allows only loopback and
  denies the name-resolving services; on Linux, a user and network namespace with `lo` and
  nothing else, except the kernel's fallback tunnel devices (`tunl0`, `gre0`, `gretap0`,
  `erspan0`, `ip_vti0`, `ip6_vti0`, `sit0`, `ip6tnl0`, `ip6gre0`). A host with a tunnel module
  loaded creates those in every new namespace; they are accepted only while down, with no address
  and no route.
  - **The checks:** from inside the isolation, the case checks that an outbound connect is refused
    and a name does not resolve. It then checks that every request reached only the stub and that
    the answer carries the stub's windows.
  - **Not certified:** on Windows, or where the isolation cannot start (user namespaces disabled,
    a nested sandbox), the feature is recorded unsupported (`ACCESS_USAGE_ISOLATION_UNAVAILABLE`),
    and a reading only ever sets a pause.
  - **Cost:** no model runs and nothing is billed.
- **Bounds:** the read waits at most 3 s after the models, and a failed or slow read leaves the
  listing as it was. `jevris doctor` shows the last reading.


In 1.2, certification does not gate the launch of an owned worker. A submitted task whose model
runs here starts on its approved model either way. The `worker.route` feature, "certified
pending first use", decides only whether route learning may change the model or effort.
`jevris certify --harness codex` checks, with no model call, that `codex exec --help` lists every
flag the worker passes (`--json`, `--model`, `--sandbox`, `--skip-git-repo-check`, `--config`)
and that the worker port passes the nine conformance cases against a stand-in, never the real
`codex`. The real binary runs only in the stub cases, against a local stub provider with a
dummy key and a simpler command line than a worker's. So certify does not prove the exact
worker launch against your installed Codex. Codex's stream
names no working directory, model or permissions, so the first-use check is only that the first
event is `thread.started`; the rest is the command line Jevris builds. A failed check is
recorded and demotes `worker.route` for that Codex version, but does not stop the run. Doctor's
`harness codex worker:` line shows the state. See [routing.md](../routing.md#certification-of-worker-routing).

## Subagent routing (`hooks.route`)

Codex 0.157.1's source lets a PreToolUse hook rewrite a `spawn_agent` call, model included, when it answers `allow` with `updatedInput`, and the subagent still inherits the parent's approval policy and sandbox. Jevris uses that answer for one thing only: when the sidecar routes a subagent, the hook copies the `spawn_agent` input, adds `model` (a Codex model id such as `gpt-6-astra`) and answers `allow` with that `updatedInput`. It sets the model only: when the route carries a learned effort, that effort appears in the explain text and is never written into the call.

Under `features.multi_agent_v2`, Codex offers `spawn_agent` inside a tool namespace and names the call to the hook `<namespace>spawn_agent`. Jevris reads the default namespace's name, `collaborationspawn_agent`, as `spawn_agent`; a call in a namespace you set yourself is never routed. It never routes a call that already names `model` or `reasoning_effort`, never touches any other tool, and every other answer stays free of a permission decision.

Doctor lists `hooks.route` for Codex only after certify's `codex.subagent-route` case passes on your binary against the stub provider. That case runs in `codex app-server` with approval policy `on-request`, answers the parent's `spawn_agent` call with the installed adapter's own route answer, and passes only when the subagent runs on the routed model and its escalated shell call still asks for approval (the case declines it, and the write must not happen). A subagent shell call the hook never saw, or no approval request, fails it. The hook smoke alone never certifies it. Until it passes, doctor reports `hooks.route` as not certified (`ROUTE_CASE_NOT_RUN` or `ROUTE_CASE_FAILED`), and the sidecar sends explain text instead of a route.

It has not passed on Codex 0.157.1 yet: in certify runs the case never saw the subagent's shell call (`SHELL_NOT_SEEN`). So in 1.2 Codex subagent routing is advice only. Even where the case passes, Jevris proposes a model only with evidence for that subagent type (an active learned slice or a signed prior), so in 1.2 it abstains in practice. The Claude Code default for a low-risk launch (a cheaper model for one call, judged from the subagent type and the size of its brief) is not applied on Codex. Jevris owned workers choose the Codex model when the turn starts instead: each run is one `codex exec` thread in the task's worktree, read-only unless the task may write, with no network and nothing approved on your behalf. For advice, use `jevris route`.

## Unsupported here

These appear on the `harness codex parity:` doctor line:

- **Status line.** Codex has no plugin status line. Run `jevris status`.
- **PermissionRequest.** Never registered, so native approval stays authoritative.
- **Failed shell commands.** A Bash or apply_patch PostToolUse carries only the output text, with no exit status, so a failed shell command is recorded as finished. Failure evidence comes only from an MCP result with `isError`.
- **Subagents.** Jevris makes no permission decision in a subagent, so Codex's approval policy, which a subagent shares with its parent, governs it. The verification gate holds only the parent's Stop, never SubagentStop. An agent role that turns plugins off runs without Jevris.
- **Access limits in your own sessions (`access.session`).** No Codex hook event carries a failed turn's error, so a limit hit in a Codex session is not recorded.

Doctor also prints a `harness codex hookTrust:` line: Codex keeps its `/hooks` trust decisions to itself, so doctor cannot read them. Run `/hooks` in Codex to review and trust the Jevris hooks.

See [parity-matrix.md](parity-matrix.md) for all five harnesses.

## Uninstall

```
jevris uninstall --harness codex --dry-run
jevris uninstall --harness codex --keep-data
```

To also delete all Jevris data on this machine:

```
jevris uninstall --harness codex --delete-data
```

When `codex` is on PATH, uninstall runs `codex plugin remove jevris@<marketplace>`. It then
removes the plugin files, the marketplace entry and the `config.toml` table.

## Upgrading from an earlier Jevris

Earlier pre-release installs wrote `[mcp_servers.jevris]` into `config.toml`, plus Jevris hook
handlers in `~/.codex/hooks.json`. Install removes only that table and the handlers that run
Jevris. Hooks you added to `~/.codex/hooks.json` stay byte for byte.

## Windows

Paths live under `%USERPROFILE%\.codex`. Each hook gets
`commandWindows: node "<runtime>\dist\hook.mjs" --harness codex`. The TOML table name and
paths are escaped, and paths with spaces work. To certify on Windows, run this on a Windows
machine with Codex installed and signed in:

```
jevris certify --harness codex
```
