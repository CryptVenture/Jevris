# Jevris in Claude Code

This guide covers Claude Code (`claude`, tested with 2.1.284) on macOS, Linux and Windows.
Every command below is in `jevris help`.

## Install

Preview first. `--dry-run` lists every planned change and changes nothing:

```
jevris install --harness claude --dry-run
```

Then apply it. Use `--yes` when you are not at a terminal:

```
jevris install --harness claude --yes
```

The runtime is copied to `<data>/runtime/<version>`:

| OS | `<data>` |
| --- | --- |
| macOS | `~/.jevris` |
| Linux | `~/.local/share/jevris` |
| Windows | `%LOCALAPPDATA%\Jevris` |

The plugin's hooks and MCP server point at that copy. Each changed file is backed up first,
and everything is restored if a step fails.

When `claude` is on PATH, install also runs these two commands against your profile:
- `claude plugin marketplace add ~/.claude/plugins/jevris-local`
- `claude plugin install jevris@jevris-local`

Claude may reformat `settings.json` while doing so. If it only reformatted the file, install
restores your exact bytes. When `claude` is not on PATH, install prints both commands for
you to run.

## Files written

Jevris installs a local marketplace plugin, `jevris@jevris-local`.
Nothing goes into `~/.claude/skills`. OpenCode and Kilo also read that folder, so a plugin
there would show every skill twice in those harnesses.

| Path (under your home) | What it is |
| --- | --- |
| `.claude/plugins/jevris-local/.claude-plugin/marketplace.json` | The local marketplace `jevris-local`. It has one plugin, source `./plugins/jevris`, at the runtime version. |
| `.claude/plugins/jevris-local/plugins/jevris/.claude-plugin/plugin.json` | The plugin manifest, from `plugins/claude/.claude-plugin/plugin.json`, with the runtime version, author, license and homepage. |
| `.claude/plugins/jevris-local/plugins/jevris/hooks/hooks.json` | 13 exec-form hooks, each `node <runtime>/dist/hook.mjs --harness claude` with a 5 s timeout. |
| `.claude/plugins/jevris-local/plugins/jevris/.mcp.json` | The MCP server: `node <runtime>/plugins/shared/mcp.js --harness claude`. |
| `.claude/plugins/jevris-local/plugins/jevris/skills/<name>/SKILL.md` (and `reference.md`) | The 8 skills: status, plan, route, checkpoint, recover, verify, explain and configure. They are rendered from `plugins/shared/skills`, with the Jevris MCP tools in `allowed-tools`. `checkpoint` and `configure` carry `disable-model-invocation: true`, so only you start them. |
| `.claude/settings.json` | Two keys are added in one edit (see below). |
| `<data>/claude-install-receipt.json` | The receipt, with paths relative to your home. |

## Config keys

In `.claude/settings.json`:

```
"extraKnownMarketplaces": { "jevris-local": { "source": { "source": "directory", "path": "<home>/.claude/plugins/jevris-local" } } },
"enabledPlugins": { "jevris@jevris-local": true }
```

Every other key, including your other plugins, hooks and marketplaces, is kept byte for byte.
The file is backed up before the edit. Uninstall removes only these two keys, and restores any
value that was there before.

## Verify inside Claude Code

1. Restart Claude Code.
2. Run `/plugin`. It lists `jevris@jevris-local` as enabled.
3. Run `/hooks`. It shows the Jevris hooks.
4. Run `/mcp`. It shows the `jevris` server with 17 tools.
5. Type `/jevris:status`, or ask Claude to call `jevris_status`.

From the shell, `claude plugin list --json` includes `"jevris@jevris-local"`.

Then run:

```
jevris doctor --harness claude
```

Doctor also runs the installed MCP server's handshake and this harness's hook fixture through
the installed launcher. It prints `harness claude mcp handshake: ok (...)` and
`harness claude hook fixture: ok (...)`, or `failed` with the reason.

If an administrator's managed settings stop hooks (`disableAllHooks` or
`allowManagedHooksOnly` in `managed-settings.json`), doctor prints
`harness claude policy: <path> disables all hooks (disableAllHooks); the Jevris hooks will not run, and Jevris does not work around managed policy`.
Certify then records every hook feature as not certified (`MANAGED_POLICY_BLOCKS_HOOKS`).
The file is read from `/Library/Application Support/ClaudeCode` (macOS), `/etc/claude-code`
(Linux), or `%ProgramFiles%\ClaudeCode` and `%ProgramData%\ClaudeCode` (Windows).

The harness line says either:
- `certified for <version range> (last verified <version>, <date>): plugin.install, mcp.tools, skills.discovery, hooks.observe, hooks.context, hooks.route, worker.route, models.list, access.detect, access.session` (only the features that passed are listed; a feature that did not pass is named with its reason code)
- `not certified: no signed record covers this version on this host; fix: jevris certify --harness claude`

`skills.discovery` is certified only when `claude plugin details jevris@jevris-local` names all 8 skills (status, plan, route, checkpoint, recover, verify, explain and configure). Otherwise certify prints the missing ones, and the feature is recorded as not certified (`SKILLS_NOT_DISCOVERED`).

`jevris install` runs this certification for you after it installs (unless you pass `--no-certify`). To run it yourself, for example after you upgrade Claude Code, use the command below. It uses a temporary profile, never your own. On macOS, Claude Code keeps your account HOME so it can find the login keychain without a "keychain cannot be found" dialog, while its settings, plugins and .claude.json go to a temporary CLAUDE_CONFIG_DIR. No model provider is called. Certify's stub cases run short turns against a loopback stub provider with a dummy key, and every other provider route and credential is removed from that run's environment. Two of them, `claude.hook-spawn` and `claude.subagent-route`, report their result and gate no feature yet. The access-limit cases gate `access.detect` and `access.session` (see "When your account runs out" below):

```
jevris certify --harness claude
```

## What the hooks do

Jevris registers exactly these 13 hooks:
- SessionStart, SessionEnd, UserPromptSubmit
- PreToolUse (Agent and Task only), PostToolUse, PostToolUseFailure
- PreCompact, PostCompact
- PreModelSwitch, PostModelSwitch
- SubagentStart, SubagentStop, Stop

A 14th, StopFailure, is added only once a signed record certifies `access.session` for your
installed Claude Code (see below).

No Jevris hook in Claude Code ever makes a permission decision. Without a signed record that
covers your Claude Code version and OS, the hooks only observe: their output is empty. With one, what they may do also
depends on your `mode` (see [settings.md](../settings.md#modes)): `observe` shows nothing,
`advise` adds context and the Stop reminder, and `bounded-auto` (the default) may also route a
subagent. A PreModelSwitch is at most explained in a `systemMessage`; it is never blocked or
answered with "ask", so the switch you asked for stays yours. The actuators:
- **Context.** `additionalContext` on SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart and PreToolUse (`hooks.context`).
- **Subagent routing.** PreToolUse(Agent/Task) `updatedInput` picks the model of a subagent that Claude Code itself starts (`hooks.route`). This only routes a model. It is not an owned worker: Jevris starts no other harness and no process for it (owned workers are [below](#sign-in-and-owned-workers)). It never sets `permissionDecision` and never overrides a model you pinned. The sidecar proposes only a registry model id. The hook maps it to an alias the Agent tool takes (`haiku`, `sonnet`, `opus` or `fable`) and sets it on your own tool input, so the prompt never leaves the hook. A model with no alias is never routed, and neither is a hook input Jevris had to cut to fit. A route to an older model of a family abstains (`ALIAS_NOT_NEWEST`), because the family alias resolves to the family's current model: since Claude Code 2.1.284, `sonnet` means Sonnet 5.5 on the Anthropic API, so a route to Sonnet 5 abstains. Jevris proposes a model only with evidence for that subagent type (an active learned slice for it, or a signed prior), never overrides a model the tool input already names, and never proposes the session's own model. For this decision the sidecar receives only the subagent type and the session's sign-in, and sends back only a model id. The sign-in is read from the variable names the hook inherits, never their values, by Claude Code's own precedence: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` means an API key, and `CLAUDE_CODE_OAUTH_TOKEN` alone means a subscription. With a cloud provider or none of these set, it is unknown and not sent. Once known, a model that sign-in could not use before is left out of the route. Subagent outcomes do not feed learning yet, because Claude Code's hooks report no subagent cost or result, and 1.2 ships no signed prior. So in 1.2 it abstains in practice, and the subagent keeps the model Claude Code chooses. For advice, use `jevris route`. Certify also runs a no-cost check of the vendor side (`stub case claude.subagent-route`, against a local stub provider): a probe hook sets the `haiku` alias with no permission decision, and the case reports whether the subagent then asks for a Haiku model. It is reported only, for now.
- **Stop reminder.** When the workspace has approved checks and a Stop comes while their passing evidence is missing, the Stop hook blocks that stop once for the same missing evidence, naming the checks (it needs `hooks.context`). A stop after that continuation is never blocked. See [verification.md](../verification.md).

Hooks also fire inside a subagent, on the parent's `session_id` with the subagent's `agent_id`.
Jevris reports those events under the parent session, as that subagent's work, and the
verification gate answers only the parent's Stop.

## Sign-in and owned workers

Claude Code works with Jevris on a subscription login or on an API key. `jevris doctor` asks
`claude auth status --json` which one it holds (it only reads) and prints one line, for example
`harness claude auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)`.
To state the mode yourself, set `"auth": { "claude": "subscription" }` (or `"api-key"`) in
`workers.json`; see [routing.md](../routing.md#harness-sign-in-subscription-or-api-key).

When Jevris runs an owned worker on a Claude model:

- On a subscription, it runs your installed Claude Code: one `claude -p` turn in stream-json,
  in the task's worktree, under your own login. Every vendor key is removed from the run's
  environment. Anthropic does not allow third-party products to use a claude.ai login through
  the Claude Agent SDK, so the SDK never runs on a subscription.
- With an API key (`ANTHROPIC_API_KEY`), it uses the Claude Agent SDK when that optional package
  is installed, else the same `claude -p` run. The subscription token is removed from a key run.
- The prompt goes on stdin. Only the granted tools are allowed (`--allowedTools`), web tools
  are disallowed, no MCP server is loaded, and Jevris never passes
  `--dangerously-skip-permissions`. `--max-turns` and `--max-budget-usd` bound the run. A
  route's effort level goes in `--effort`, except for a Haiku model, which has none.
- If the session reports a different sign-in from the one decided, the run is stopped at once.
- An access limit ends the run as `access-limit` (or `overloaded`), not as the task failing.
  Jevris reads a rejected rate-limit event (five-hour, weekly, or the Opus or Sonnet weekly
  window, with its reset), the last retry or assistant error code (billing, sign-in, rate limit,
  overload), and otherwise a pinned wording in an error result. A successful result wins. The
  run keeps the codes and a pattern id, never the text. A run with a base-URL override
  (`ANTHROPIC_BASE_URL` or a Bedrock, Vertex, Foundry or AWS one) or a cloud-provider switch,
  in the environment or in the `env` of a settings file Claude Code applies (the workspace's
  `.claude/settings*.json`, your own `settings.json` or the managed settings), or with an
  `apiKeyHelper` in one of them, reports no limit, because Jevris cannot tell which account
  answered.

### When your account runs out

Jevris pauses a Claude account on this machine when it runs out ("access limits"; the full
table is in [routing.md](../routing.md#what-jevris-notices-when-you-run-out)):

- **Owned runs with an API key (Agent SDK)** report the structured error: a rate limit with the
  reset from the response headers, the 5-hour and weekly windows with their reported reset
  (an Opus-only or Sonnet-only weekly limit pauses only that family), and exhausted credit or a
  refused key with no expiry. The pause carries a 16-character fingerprint of the key, so a new
  `ANTHROPIC_API_KEY` clears a pause with no expiry.
- **Owned runs on a subscription (`claude -p`)** end as `access-limit` and record the same
  pauses, read as the owned-run list above describes (certify cases `claude.access-limit.rate`,
  `.credit` and `.auth`, feature `access.detect`). A subscription
  has no key to fingerprint, so a pause with no expiry clears with `jevris route limits clear` or
  a later success.
- **Your own sessions** are read through the `StopFailure` hook, which install registers only
  once `access.session` is certified for your Claude Code (certify case
  `claude.session.stop-failure`, against a stub provider, no model call). Until then a session's limit is not read at all. A rate limit pauses
  that model for 60 s, backing off to 1 h. A 5-hour window is paused until its stated reset when
  the error gives one; "You've hit your session limit" or "usage limit reached" with no usable
  time is paused as a 5-hour window over the whole account, doubling on repeats. A weekly limit
  pauses for 7 days or until its stated reset: one that names Opus or Sonnet ("You've hit your
  Opus limit") pauses only that family's models, and any other every Claude model on that
  account.
  Exhausted credit and a blocked account or refused login pause with no expiry. A session's
  sign-in is not known, so the pause covers both sign-ins, owned runs included, until a later
  turn finishes or you clear it.
- A workspace whose `.claude/settings*.json` sets `env.ANTHROPIC_BASE_URL` or `apiKeyHelper`
  records nothing, and neither do your own or the managed settings when their `env` sets one.

`jevris doctor` says when the registered hook and the certification disagree:
`harness claude install: StopFailure registered, but access.session is not certified for <version>; fix: jevris install --harness claude`,
or `harness claude hooks: StopFailure not registered yet, although access.session is certified for <version>; to add: jevris install --harness claude`.


An owned worker starts only after you submit work (`jevris plan --submit`, or `jevris_submit_task`
in owned mode). In 1.2, certification does not gate that launch. The `worker.route` feature,
"certified pending first use", decides only whether route learning may change a worker's model
or effort here. `jevris certify --harness claude` checks, with no model call, that
`claude --help` lists every flag the worker passes and that the worker port passes the nine
conformance cases against a stand-in, never the real `claude`. So certify does not prove the
exact worker launch against your installed Claude Code. `--max-turns` is not in `claude --help`, so the record lists it as a limitation that
the first real run proves. That run checks its `system/init` event before any tool runs: the
working directory, the permission mode, the loaded tools, the model and the sign-in. A mismatch
stops the run, demotes `worker.route` for that Claude Code version and starts one background
re-check. Doctor's `harness claude worker:` line shows the state. See [routing.md](../routing.md#what-certification-covers-for-owned-workers-in-12).

**Which models your sign-in offers.** Once `models.list` is certified for your Claude Code
version, and while `routing.modelListing` is `on` (the default), Jevris asks Claude Code which
models your sign-in offers. It starts an idle
`claude -p --input-format stream-json` and sends only the `initialize` control request, which
answers with the model list. No user message is sent, so no model runs and nothing is billed.
The run saves no session, loads no MCP server or command, and turns hooks off for itself only.
On Windows that setting is passed as a file in a temporary folder, removed after the run, since
an npm-installed `claude.cmd` cannot be handed an argument with quotes. The account part of the answer is never read. Certify proves in its throwaway profile that, after a warm-up run, the
listing writes nothing but caches, logs and Claude Code's own entry for the listing process in
`.claude/sessions/`. The warm-up run's own entry may be removed, and
`.claude/plugins/known_marketplaces.json.lock` may be left only empty or gone. Until then, a Claude model becomes eligible after it
has run once.

## Unsupported here

The `harness claude parity:` doctor line shows:

- **Status line.** `statusLine` is a single user setting. Jevris would have to replace yours, so it never does. Run `jevris status`.
- **Subagents.** Jevris makes no permission decision in a subagent, so Claude Code's own permissions govern it, and the verification gate holds only the parent's Stop, never SubagentStop. A subagent whose tools list leaves out the Jevris MCP tools has none.

See [parity-matrix.md](parity-matrix.md) for all five harnesses.

## Uninstall

```
jevris uninstall --harness claude --dry-run
jevris uninstall --harness claude --keep-data
```

To also delete all Jevris data on this machine:

```
jevris uninstall --harness claude --delete-data
```

When `claude` is on PATH, uninstall runs `claude plugin uninstall jevris@jevris-local` and
`claude plugin marketplace remove jevris-local`, then removes the files the receipt lists
and the two settings keys.

## Upgrading from an earlier Jevris

Earlier pre-release installs used a skills-folder plugin (`~/.claude/skills/jevris`,
`jevris@skills-dir`). Install removes that folder only when it holds a Jevris plugin manifest,
and removes files an old receipt lists only when they carry a Jevris signature; anything else
is reported and left in place. It removes the `jevris@skills-dir` entry from `enabledPlugins`
and keeps your other entries.

## Windows

The hooks run exec-form `node` with the runtime path under `%LOCALAPPDATA%\Jevris`. Paths
with spaces and Unicode are passed as arguments, never through a shell. To certify on Windows,
run this on a Windows machine with Claude Code installed and signed in:

```
jevris certify --harness claude
```
