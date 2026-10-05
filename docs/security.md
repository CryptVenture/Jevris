# Security

Jevris runs as you, on your machine. This page says what that protects, what it does not, and what you can do about the rest. What can leave the machine, retention and deletion are on [privacy.md](privacy.md). Where each file lives is on [configuration.md](configuration.md).

## The boundary: your user account

Jevris runs as you. The sidecar, the hooks, the MCP server and the CLI are all processes of your OS user, and the files they keep are owned by you.

What that protects against:

- **Other users on the same machine.** The sidecar listens only on a Unix socket inside a directory that is yours alone (mode `0700`), or on Windows on a named pipe with a random name whose access list allows only you and SYSTEM. There is no TCP port, so nothing on the network can reach it.
- **Programs that do not have your keys.** Every request to the sidecar is signed with a key that only your processes can read: one key for the CLI, one for hooks, one for MCP. A request that is replayed, expired, tampered with or oversized is refused before any work starts.
- **One surface doing another's job.** A hook or an MCP tool cannot administer Jevris. The admin commands (`kill-switch`, `store`, `audit`, `data`, `authorize`) need the CLI key. MCP can submit a task only for a workspace where a person turned owned mode on (`jevris configure owned-mode on`, at an interactive terminal), only under a root budget that already exists there, and only while the kill switch is clear. One path starts a worker without owned mode: a `jevris_recover` call on a failed owned task can relaunch it once on a stronger model the task already approved, under that task's existing budget ([routing.md](routing.md#when-one-starts)).

- **The wrong machine.** Jevris runs where the coding process runs: in a container, in WSL or on the SSH host, not on the machine your IDE or its browser `localhost` is on. The sidecar records which execution environment it belongs to (`jevris sidecar status` shows `runs in:`), and a client on the other side of that boundary, such as the host of a dev container that shares your home directory, never treats it as its worker: it will not connect, will not start a second sidecar over it and will not signal its process. Set `JEVRIS_HOME` to a directory inside the environment where the coding process runs. When the home is on a mount that cannot hold a socket, the sidecar uses a private directory under `/tmp` inside that environment instead.

What it does not protect against:

- **Anything already running as you.** A fully compromised OS account is outside what a same-user sidecar can reliably contain; stronger enforcement needs separate principals and operating-system isolation. Malware running as you can read your files, your keychain entries (subject to the keychain's own prompts) and the sidecar's keys, just as it can read your SSH keys. `jevris doctor` prints this on every report.
- **Native harness permissions.** Jevris never grants, widens or replaces a permission in Claude Code, Codex, Kilo, OpenCode or Antigravity. Those stay authoritative.

## The Jev key

Only the sidecar reads the Jev key: from the OS keystore, or from the opt-in source described below for headless machines. Hooks and the MCP server never open the keychain: their bundles contain no keyring module, and a lint check fails if any other module resolves the key. Key variables (`TYPESAFE_API_KEY`, `JEV_API_KEY`, `JEVRIS_API_KEY`, `JEVRIS_INSTALLER_KEY` and any `JEVRIS_HOOK_*` token) are left out when the sidecar is started, and the sidecar also drops them from its own environment when it starts, so no process it starts inherits one.

`jevris credential set` stores the key in the OS credential store, under service `jevris` and account `typesafe-primary`. It reads the key from standard input or a hidden prompt, never from a command-line argument, because arguments are visible to other processes.

Who else can read it, per OS:

| OS | Store | Readable by |
| --- | --- | --- |
| macOS | Login keychain | Processes running as you. The keychain may ask you to allow a program that did not create the item; once you choose "Always Allow", that program reads it without asking. |
| Windows | Credential Manager (generic credential) | Any process running as your user. Windows does not prompt. |
| Linux desktop | Secret Service (GNOME Keyring, KWallet) | Any process in your unlocked login session. |
| Linux headless, CI, containers, WSL without a keyring | none, unless you opt in (below) | Without the opt-in, Jevris stores no key, decisions run rules-only and `jevris doctor` says so. Jevris never looks for a key in files, the repository or `.env`. |

### Headless machines: the opt-in key file

The OS keystore is the default source. Headless Linux, CI and WSL often have no keystore, so there you may opt in to one other source. You opt in by naming the source exactly. Jevris never searches for one.

| Variable | Source |
| --- | --- |
| `JEVRIS_CREDENTIAL_FILE=/absolute/path` | An owner-only file outside any repository |
| `JEVRIS_CREDENTIAL_SYSTEMD=<name>` | `$CREDENTIALS_DIRECTORY/<name>`, from systemd `LoadCredential=` or `systemd-creds` |

The sidecar reads the file only when the keychain has no key or cannot be opened. The keychain stays the default wherever it exists. If you set both variables, Jevris refuses both.

Jevris refuses the file, and stays rules-only, when any of these is true:
- the path is not absolute and normalized;
- the file is a symbolic link or not a regular file;
- the file is not owned by you;
- the file has any group or other permission bit (use `chmod 600`);
- its directory belongs to someone other than you or root, or group or other users can write it;
- any directory above it holds a `.git` entry, so the file is inside a git work tree;
- the file holds more than one line or more than 4096 bytes;
- the host is Windows (use Credential Manager there).

Jevris checks the file again on the open descriptor, so a swap between the check and the read is refused.

The sidecar log records only which source supplied the key (`credential-source`) or a reason code (`credential-opt-in-refused`). The key itself is never logged, echoed or written anywhere. Both variables hold a path or a name, never a key, so they reach the sidecar; the key variables listed above are still removed.

For a systemd service:

```ini
[Service]
LoadCredential=jev:/etc/jevris/jev.key
Environment=JEVRIS_CREDENTIAL_SYSTEMD=jev
```

Anyone who runs as your user can read an owner-only file, just as they can read your keychain entries. A file gives no prompt and no audit trail, so use it only where no keystore exists.

With no key, Jevris still works: every decision falls back to local rules, and nothing is sent anywhere.

## Harness logins and vendor keys

The Jev key is Jevris's own. Your coding harnesses sign in separately, on a subscription login or on a vendor API key, and Jevris supports both (see [routing.md](routing.md#harness-sign-in-subscription-or-api-key)). For those:

- Jevris records only which mode a harness uses, never a key, a token, an email or an account id. It never copies a harness's credential files.
- To decide an owned worker's mode, it checks whether a vendor key variable is set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY` and the like), and asks the harness which sign-in it holds with read-only commands (`claude auth status --json`, `codex login status`, `opencode auth list`, `kilo auth list`). From OpenCode and Kilo it reads only each stored credential's provider and type. Doctor names a variable that is set, never its value.
- An owned worker on a subscription runs with every vendor key removed from its environment, so it cannot bill a key by accident. A worker on a key runs with the subscription tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`) removed, so it cannot spend your plan by accident. Neither is written to disk or passed as an argument.
- The Claude Agent SDK runs only with an API key. A claude.ai login is used only by your own installed Claude Code.
- An owned worker gets only the tools its task was granted, no web tools, and never a flag that skips permissions. A permission prompt it cannot show is refused, never answered for you.
- An owned worker runs in its own git worktree, on its own branch. It starts only after an explicit submit, and in 1.2 its launch is not gated by harness certification ([routing.md](routing.md#what-certification-covers-for-owned-workers-in-12)).

## What stays on this machine, and how it is stored

| Data | Where (see [configuration.md](configuration.md)) | Protection |
| --- | --- | --- |
| The store `jevris.db`: decisions, tasks, verification receipts, workspace list, events (hashes only), audit log | data folder | Owner-only file (`0600`) in an owner-only folder; one writer (the sidecar). |
| Raw tool artifacts | `<data>/evidence` | Owner-only files. Kept 7 days by default. |
| Route learning | `<data>/route-learning` | Owner-only. Ids, counts, costs and times only, never text. Kept until `jevris route learning reset --clear-evidence` or `jevris data delete`. |
| Sidecar keys and endpoint | runtime folder | Owner-only; recreated at every sidecar start and removed when it stops. |
| Logs | `<state>/logs` | Owner-only. Reason codes and ids, never source text, prompts or keys. |

**Encryption.** Jevris does not encrypt its store itself. It relies on file ownership and on your disk encryption. Turn on FileVault (macOS), BitLocker or Device Encryption (Windows), or LUKS (Linux) on any machine that holds proprietary work. The store keeps hashes of events, not their content, and it never contains the Jev key.

**Copies to another machine.** The store records which user and machine created it. A store or backup copied to another machine or user is refused, rather than opened with the wrong owner. The store also refuses to open on a network file system.

**Backups.** `jevris store backup <file>` writes a consistent, owner-only copy and checks its integrity before reporting success. The file must be new, inside your home directory and not reached through a symbolic link. `jevris store restore <file>` stops the sidecar, checks the backup (integrity, the same machine and user, a schema this Jevris understands), keeps the current store beside it as `jevris.db.pre-restore-<time>`, and installs the backup. The restore replaces the store only: decision records in `<data>/decisions/` are left as they are (the command says so), so a decision made after the backup can still be explained, and the sidecar archives those journal files into the restored store again when it starts and every minute. Retention and `jevris data purge` remove old journal files. A backup holds everything the store holds, so keep it where you keep other private files.

**Exports.** `jevris store export <file>` and `jevris audit export <file>` write JSON lines, owner-only. Neither contains a key or the secret that signs authorizations.

**Crash dumps.** Jevris writes no core dumps and no Node diagnostic reports. The operating system can still save a crashed process's memory, and the sidecar's memory holds the Jev key while it runs:

- Linux: core dumps follow `ulimit -c` and `systemd-coredump`. Keep them off (`ulimit -c 0`) or restricted to root on shared machines.
- macOS: crash reports do not include process memory. Full core dumps only happen if you turned them on (`ulimit -c unlimited` and `/cores`).
- Windows: Windows Error Reporting can keep minidumps under `%LOCALAPPDATA%\CrashDumps` if you or your administrator enabled local dumps.

If you share a dump for support, rotate the Jev key afterwards with `jevris credential set`.

**The egress approval file.** `host.json` approves egress only from a regular file you own that no one else can write, with neither it nor the Jevris home inside a git work tree, so a repository that relocates `JEVRIS_HOME` cannot supply its own approval. The rules and their reason codes are on [privacy.md](privacy.md#approving-egress). The access-limit record is read without following a link and never past its size cap.

## The kill switch

`jevris kill-switch activate [--reason <text>]` stops every Jevris effect at once. Hook events are still recorded, but no advice or decision follows from them. Sidecar operations that record or change anything are refused (`KILL_SWITCH`), and owned work stops. That includes `jevris data purge` (a `--dry-run` is still allowed), `jevris route learning reset --clear-evidence` (the store learning purge), `jevris authorize`, `jevris consent provider --grant`, `jevris credential reenable`, `jevris route limits clear`, task cancel and revert, verification records, `checkpoint` and `handoff import`; each says to clear the kill switch first. You do not need a prepared rollback file. Owned effects still in flight are held for reconciliation, never repeated automatically, and the activation is written to the audit log. If a step fails, the command says which one.

- `jevris kill-switch status` shows whether it is stopped, and who stopped it, when and why.
- `jevris kill-switch clear` resumes. It works only from an interactive terminal, never from MCP, a hook or a script.
- `jevris kill-switch drill` checks that the switch works, then restores the previous state. It records a passed drill only when every check passed. A pack that asks to act automatically stays inactive until a drill has passed on this host.

A damaged, oversized or unreadable flag file counts as stopped.

Some operations stay available while stopped, each for a reason:

- `kill-switch activate`: the switch itself must always be able to turn on again.
- `audit record`: the audit log must keep recording, including what happens while stopped.
- `audit verify` and `audit export`: read-only checks on the audit trail. If the sidecar is not running they read the store file directly.
- `store backup` and `store export`: they copy your data out and change nothing, so you can still take a copy before clearing the switch.
- The automatic daily retention sweep keeps running while stopped. It only removes data past its retention period, which the configuration already allows. `jevris data purge` is a person's request and is refused.

An administrator can also stop Jevris for everyone on a machine with a managed kill switch (see [configuration.md](configuration.md#managed-policy-administrators)). A user cannot clear it, and a managed file that anyone other than an administrator could write counts as stopped.

**Known limit: "interactive terminal" is a same-user check, not a security boundary.** Jevris decides that a terminal is interactive when standard input and output are terminals. A program running as you can create a pseudo-terminal (for example with `script` or `expect`) and pass that check. The same applies to `jevris authorize`. The check stops a hook, an MCP tool or a plain script from clearing the switch by accident or by instruction, and every clear is written to the audit log with who cleared it and when. It cannot stop code that runs as you and sets out to get around it. A same-user check cannot stop that code, and no extra test (a parent-process check, a typed phrase) would change that, because code running as you can fake each one. To enforce a stop, use the managed kill switch: its files belong to an administrator, so a user, or a program running as the user, cannot clear it.

## The audit log

Kill-switch activations, clears and drills, retention sweeps, backups, restores, migrations, authorizations, egress approvals and revokes, provider consent grants and revokes, setting and removing the Jev key, changes of your source-egress preference (`policy.change`), data deletions, access-limit clears, and session links and unlinks are appended to a hash-chained log in the store. The log is append-only: rows cannot be edited or removed. `jevris audit verify` checks the chain and names the first row that was tampered with. `jevris audit export <file>` writes it without secrets.

## Suspicious text and risky tool calls

After a tool runs, Jevris reads what the tool returned for text that looks written to steer the agent, such as a fetched page, a file, a log or a skill description that says "ignore your instructions" or "the administrator approved this". Before a tool runs, it sorts the proposed call into no concern, caution or review. It looks at credential locations, network hosts, destructive or privileged commands, package installs, CI secrets and writes outside an owned task's scope, and it raises the call to review when suspicious text came earlier in the session. A write is judged against an owned task's scope only while the session has one, and the scope is the sidecar's own, read from the task's plan (a hook cannot send it). The result is a message in your harness, for example "Jevris: a closer review suggested before approving this Bash call (credential-access, network-egress)". It never approves or blocks anything: your harness's permission prompt and the host policy decide. The message never quotes the text or the command.

The text is checked in memory and is not stored. When a Jev key is configured, Jev may be asked afterwards, and only about signal families and effect classes. Jev can only raise a concern, never lower one, and what your harness shows comes from the local rules alone.

## Authorizations

Some actions need your explicit approval, for example accepting a task exception or deleting data through an automated path. `jevris authorize <action> --scope <scope> [--ttl-minutes <n>]` mints a single-use approval from an interactive terminal. It lasts 5 minutes by default and at most 15, and it is signed with a key the store keeps beside the database. A model, an MCP tool, a hook or text in the repository cannot create one.

## Changes that need a person at a terminal

A change that widens what counts as verified, who is trusted or what may leave the machine needs a person at an interactive terminal who answers `y`. `--yes`, `--json`, a pipe, a script, MCP, a hook and a test run are refused before anything is asked, with one line that names the reason code `CHANNEL_REFUSED`, and nothing changes:

- `jevris verify approve` (with or without `--proposal`): which checks count as verification.
- `jevris verify issuer add`: whose signed CI receipts count as passed.
- `jevris verify waive`: lets the required-check report complete without the check.
- `jevris configure owned-mode on`: lets MCP clients start owned work.
- `jevris configure set` of `mode`, `routing.managedWorkers`, `routing.mainSession` or `verification.backgroundAtStop` (`off` to `on`, which lets a Stop queue the approved checks in the background, in `bounded-auto` mode only: `advise` mode never runs checks at Stop) or `privacy.sourceEgress` (`deny-until-approved` to `approved-scoped`: your own half of source-egress consent, which sends nothing without the administrator's `jevris egress approve`) to a value above its current effective one: it widens what Jevris may do. Lowering, and setting the value a key already has, need no one. Install writes no settings file, so its defaults are not a raise.
- `jevris pack approve` and `jevris pack publisher add`: what a pack may run and send, and whose signed packs may run executable components.
- `jevris plan --submit` with a new root budget: it commits a spending limit and starts owned work. It takes either a y answer at an interactive terminal or `--authorization <id>`, a single-use authorization for `budget.increase` on that budget id that `jevris authorize` mints at a terminal for you (the same one `jevris budget update` takes to raise a limit). Otherwise the sidecar refuses the plan (`CHANNEL_REFUSED`, or `AUTHORIZATION_REFUSED` for an authorization that is used, expired, for another budget or for another person) and creates nothing. A plan under a budget that already exists in the workspace needs neither, so `--yes` still works for it; it cannot raise that budget (`BUDGET_CONFLICT`). An authorization is used when the sidecar checks it, so a plan refused after that needs a new one.
- Also: `jevris egress approve`, `jevris consent provider <provider> --grant`, `jevris route limits clear`, `jevris credential reenable`, `jevris kill-switch clear`, `jevris authorize` and linking a session to a task.

A change that only narrows takes a terminal answer or `--yes`: `jevris verify revoke`, `jevris verify issuer remove` and `jevris pack uninstall --cleanup`; `jevris configure owned-mode off` needs no confirmation. `jevris install --yes` still applies the plan it prints, including owned workers in bounded-auto.

A program running as you can fake a terminal, so this stops a model's shell tool, a hook or a script from making these changes by instruction, not code that sets out to get around it. That is the same-user limit described under [the kill switch](#the-kill-switch).

## Routing authority

Routing chooses which model, and so which provider, gets a turn or a subagent. The rules below say who can make that choice. The routing modes themselves are on [routing.md](routing.md).

- **Only the sidecar decides whether a turn may be switched.** For a Kilo or OpenCode main-session turn, the sidecar works out the answer from its own state, never from the request: the session must be one it recorded from that harness's own events and one started for its task (through a plan, a handoff or `jevris route` with the task), and it checks that task, the effective `routing.mainSession`, the kill switch, and whether the recorded harness version passed its session-route certification. A hook event, an MCP call, a plugin message or text in the repository cannot mark a turn as switchable. Any doubt means advice only.
- **Unlinked and child sessions get advice only.** A session with no linked task is never switched, even when exactly one task is active in the workspace. A subagent's or task's session never inherits the main session's approval to switch.
- **Linking a session to a task is a person's step.** Only the CLI can link a session (`jevris route --task <id> --link`, or `jevris handoff import <capsule.json> --link` as the last step of a handoff import), and only from an interactive terminal while the kill switch is clear; a plan link is made by the sidecar itself. The sidecar picks the session from its own records: a named session must match one exactly, and without a name exactly one recent Kilo or OpenCode session may be in view, or it lists the candidates and links nothing. Every link and unlink goes in the audit log, and a link ends with its session. Unlinking always works. A program running as you can still fake a terminal; that is within the same-user limit above.
- **A switch changes the model and nothing else.** The Kilo and OpenCode plugins write only a model: a subagent's first message, or a main-session message's model. The plugin checks the sidecar's answer again before it writes, and writes a turn's switch only for the session and message it asked about. A route may name only the model, its provider and its reasoning variant. It never adds a tool, widens a permission, changes the sandbox or rewrites the prompt.
- **A project cannot redirect a route.** A project config file can point a provider at another endpoint, so the plugin writes no route to a provider that a project config file redefines. It also writes none when such a file cannot be read, does not parse, is over 256 KiB, links outside the worktree, or holds `{env:` or `{file:` anywhere (the harness fills those in before parsing, keys included), and none in a linked Kilo worktree, whose primary checkout's config Kilo also loads. A refusal found when the plugin loads holds for the plugin's life, so removing a file after the harness read it does not lift it. It reads the files from the working directory up to the worktree root; your global config is trusted. See [Kilo](harnesses/kilocode.md#model-routing) and [OpenCode](harnesses/opencode.md#model-routing). The model named always comes from the model registry, after the consent check below. It never comes from repository text or a model's own answer.
- **Codex subagents.** Codex applies a hook's rewritten `spawn_agent` input only when the hook answers `allow`, so a certified Codex route is the one place Jevris writes a permission decision: `allow` with the call's own input, key for key, plus `model`, never on a call that already names a model or a reasoning effort and never on any other tool. Doctor lists `hooks.route` for Codex only after certify's `codex.subagent-route` case passes on the installed binary. That case runs with approval policy `on-request` and shows that the subagent took the routed model and that its request to write outside the read-only sandbox still reached Codex's approval prompt and, declined, did not run. Until then the sidecar sends explain text only.
- **Provider consent is one check, and routing cannot skip it.** Routing and worker launches ask the same stored consent (see [privacy.md](privacy.md#consent-per-model-provider)). A revoke blocks a provider even while you are signed in to it. You can revoke a provider you never granted. Neither a grant nor a revoke ages out. An unreadable consent store means no consent.
- **A route through a serving host needs the host and the maker.** A gateway (OpenRouter, the Kilo Gateway) or an inference host (NVIDIA) is a consent party of its own. A route through one needs the host's consent and the model maker's consent, each given at an interactive terminal, or each allowed by the signed-in default where its text allows that. Moonshot and DeepSeek always need a stored grant, whichever host serves them. A revoked, outdated or unreadable host consent blocks the route. So does one for any host it passes requests on to: the Kilo Gateway forwards to OpenRouter, so revoking OpenRouter also blocks routes through Kilo. A host with no consent text in Jevris (NVIDIA) can never be allowed, even with a stored grant. Being signed in through a gateway counts for the gateway, never for the maker behind it. Jevris does not route through a gateway or host yet: a session on one, or a route to one, gets advice only.
- **An administrator's registry cannot route around consent.** An administrator's model registry can add providers, models and servings, but it never grants consent, and a registry that is too large, not JSON or invalid is refused, with no fallback, which leaves routing unavailable. The makers that always need consent, the serving hosts and each host's maker segments are pinned in code, not read from the registry. The registry refuses a serving that relabels a model's maker, names another model, repeats one, prices a free tier, or names a harness that has no row for that host, and a harness model row may not use a host's segment. A zero price is recorded as a free tier, never as a known tariff.
- **A gateway cannot pass off another model.** A host spelling counts only when it names one registry model exactly. A moving alias (`~deepseek/...`), a free or routing suffix (`:free`), an unpinned host and a spelling with a context suffix never resolve, so they are never routed to and never count as evidence. Evidence through a gateway comes only from the model the harness reported: a run that only asked for its model counts only through the maker's own API, because a gateway can fall back to another model. The model offer records the host each run and listed line went to.
- **Source egress is a separate control.** `egress` governs what Jevris itself sends to Jev. Routing a turn to a third-party model is governed by provider consent and by your harness's own sign-in.

## Access limits: a forged limit cannot pause or free an account

Jevris pauses an account on this machine when a harness reports that it ran out ([routing.md](routing.md#access-limits-when-an-account-runs-out)). A pause only narrows routing and launches, and it never grants anything. The controls below keep a repository file, a model, a tool's output or a made-up error from pausing a provider for good, or from clearing a pause.

- **Only the harness's own error channel counts.** A pause comes from an owned run's error events, failed results and failed runs, or from the harness's own failed-turn hook event (Claude Code `StopFailure`; Kilo and OpenCode `session.error` or an errored assistant message; an Antigravity `Stop` that ended on an error). Tool output, a tool's stderr, assistant or model text, an MCP call and any other hook input never create one. A run that succeeded records nothing.
- **Structured fields before text, and text is never kept.** A status, an error type or a code decides first; a pinned text pattern is consulted only when none matched. The harness side passes on only the structured codes and the id of the pattern that matched, never the message, a body or a header value. Every port is tested with a canary that must not get through.
- **Uncertified text never pauses an account with no expiry.** Exhausted credit or a blocked account that is known only from a text pattern is held as a timed usage window, not as a pause with no expiry, unless the harness's signed certification record proves that channel for the running version: `access.detect` for an owned run, `access.session` for a session (at the version the session reported, else the installed one). The record is read with the same verifier as every other certification; a plugin's or port's own claim is never read, and a record that fails to verify reads as not certified. Antigravity has no certify case, so its text is always held as timed. A reset stated in text is used only when it is in the future and at most 8 days away; a header reset wins over text.
- **A redirected endpoint records nothing.** When a project config redirects the provider endpoint (Claude Code's `ANTHROPIC_BASE_URL` or `apiKeyHelper` in the workspace's `.claude/settings*.json`, a provider `baseURL` in a Kilo or OpenCode project config), or the host is one Jevris does not pin, no pause is recorded, because a wrong scope would pause the wrong account. Any doubt reads as redirected.
- **The Codex usage read pauses only for a time, and lifts only when certified.** On a ChatGPT sign-in the model listing's own `codex app-server` session sends one `account/rateLimits/read`, under the listing's gates (`routing.modelListing` on, `models.list` certified), never with `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment, and only when `codex login status` says ChatGPT. The parser reads only each window's used share, length and reset and `ordinaryUsageAllowed`; a window that does not parse drops the whole reading. The sign-in is the one Jevris launched with, never a value from the reply. A reading may lift a pause only when `access.usage-read` is certified for the running Codex version. Certify case `codex.usage-read` proves the read against a loopback stub under the operating system's network isolation (macOS `sandbox-exec` allowing only the stub's loopback port, Linux an unprivileged network namespace with only `lo`). The case first checks from inside that an outbound connect is refused and a name does not resolve. It uses a dummy login in a throwaway folder, never the real one. Even a certified reading lifts only that sign-in's usage-window pauses last seen at least 2 minutes before it, and only when usage is allowed and no window is used up; it never lifts exhausted credit, a blocked account, a rate limit or a held text match. On Windows, or where the isolation cannot start, the feature is unsupported (`ACCESS_USAGE_ISOLATION_UNAVAILABLE`) and nothing runs unisolated, so a reading only sets timed pauses.
- **Only Jevris's own classifier can record a pause.** The sidecar classifies every signal again itself, and the record accepts only its classifications.
- **Clearing is a person's step.** `jevris route limits clear` and `jevris credential reenable` work only from the CLI, for a person at an interactive terminal: hooks and MCP tools are refused, a pipe, `--json` or a test run is refused (`CHANNEL_REFUSED`), and there is no `--yes`. Neither starts the sidecar. Each is audited by count and class only, never a key, a fingerprint, a scope or text. Otherwise a pause clears only by its own reset, by a success on exactly that scope, or, for a Claude or Codex API key that Jevris passes, by a different key.
- **The record fails open.** An unreadable record pauses nothing, and status and doctor say so. This is on purpose: the vendor enforces its own limit, and a pause only saves a launch the vendor would refuse. It is never a safety control.

## Supply chain

The published package bundles its own code. It installs three runtime dependencies, each pinned to an exact version:

| Package | Pin | Why |
| --- | --- | --- |
| `better-sqlite3` | 13.0.3 | the store |
| `@napi-rs/keyring` | 2.1.0 | the OS credential store, opened only by the sidecar |
| `@typesafe-ai/sdk` | 0.6.0 | the Jev client, used only by the sidecar |

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency: npm does not install it for you, and Jevris uses it only for owned Claude workers that run on an API key.

Releases are published from CI with npm provenance, so `npm audit signatures` can check that a tarball was built from this repository. Version 1.2.0 is a release candidate and is not on the npm registry yet. See [RELEASING.md](../RELEASING.md).

## Reporting a problem

See [SECURITY.md](../SECURITY.md). Do not attach source, prompts, keys, the store, backups or crash dumps to an issue. `jevris doctor --json` contains none of these, and it is what a bug report needs.
