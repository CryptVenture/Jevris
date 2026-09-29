# Configuration files

Every file Jevris reads, where it lives and who may write it.

## Folders

| | Config folder | Data folder | State folder | Runtime folder |
| --- | --- | --- | --- | --- |
| macOS | `~/.config/jevris` | `~/.jevris` | `~/.jevris` | `~/.jevris/run` |
| Linux | `$XDG_CONFIG_HOME/jevris` (default `~/.config/jevris`) | `$XDG_DATA_HOME/jevris` (default `~/.local/share/jevris`) | `$XDG_STATE_HOME/jevris` (default `~/.local/state/jevris`) | `<state>/run` |
| Windows | `%APPDATA%\Jevris` | `%LOCALAPPDATA%\Jevris` | `%LOCALAPPDATA%\Jevris\state` | `%LOCALAPPDATA%\Jevris\run` |

`--home <dir>` or `JEVRIS_HOME` moves all of them under that directory. Jevris creates every folder owner-only (`0700`; on Windows an access list for you and SYSTEM only) and refuses a folder that is a symbolic link or owned by someone else.

None of these files changes a native harness permission. Jevris never reads a secret from any of them.

## The files

| File | Where | Written by | Purpose |
| --- | --- | --- | --- |
| `jevris.config.json` | config | you, through `jevris configure set` | Product settings: mode, routing, orchestration, privacy and retention choices. See [settings.md](settings.md). |
| `.jevris/config.json` | the root of a repository | anyone who can commit to it | May only lower limits or switch features off. Repository content is untrusted: it can never widen a setting or grant consent. |
| `organization.json` | config | your administrator | A ceiling over the product settings: mode, source egress, retention, request size, provider pin, the monthly Jev decision budget. |
| `host.json` | config | your administrator | Host policy for the provider gate: mode, egress consent, retention maximums, request budget, a ceiling on the monthly Jev decision budget, model pin, pack privileges. |
| `policy-active.json`, `policy-previous.json` | config | Jevris, on every accepted load of `host.json` (for example `jevris policy check`) | Snapshots of the active host policy and the one it replaced. `jevris policy rollback` and `jevris kill-switch activate` restore the previous one when it is no wider than `host.json`. |
| `kill-switch.json` | config | `jevris kill-switch` | Stops every Jevris effect. See [Kill switch](#kill-switch). |
| `calibration-release.json` | config | an administrator or user (optional) | A signed calibration release, checked against the calibration keys in the package's trust store. Enables calibrated routing only for the task slices it covers, for the Jev model, question text and state encoding it names. When present it is the only release read, and a broken one abstains. A package may also ship a baseline release (`assets/calibration/calibration-release.json`); version 1.2 ships none, so without this file calibrated routing abstains (`NO_RELEASE`). See [routing.md](routing.md#the-baseline). |
| `model-registry.json` | config | your administrator (optional) | A refreshed model registry used in place of the bundled snapshot: models, prices, limits, harness access and each provider's data terms per sign-in. A file that is not a valid registry is refused and makes routing unavailable rather than fall back to older prices; the reason is `MODEL_REGISTRY_TOO_LARGE` (over 1 MiB), `MODEL_REGISTRY_NOT_JSON`, `MODEL_REGISTRY_INVALID` or `MODEL_REGISTRY_UNREADABLE`. `jevris status` shows `model registry: bundled snapshot <id>`, `model registry: administrator override <id>` or `model registry: override refused (<reason>), routing unavailable`. `jevris doctor` shows the same (`modelRegistry: bundled snapshot <id>`, `modelRegistry: administrator override <file> (snapshot <id>) ...` or `modelRegistry: the administrator override <file> was refused (<reason>) ...`), a `dataTerms <provider>:` line per provider with its terms for each sign-in, and `providerConsent:` with each provider's consent state (see [privacy.md](privacy.md#consent-per-model-provider)). `jevris route` and `jevris explain` show the data terms line for the model they name. |
| `workers.json` | config | you | Owned workers: each harness's sign-in mode (`auto`, `api-key` or `subscription`) and the preferred harness per model provider. Schema `jevris-workers-1`. See [routing.md](routing.md#stating-the-mode-workersjson). |
| `control.json` | config | you | Optional: the control service that owned workers on several hosts share. See [multi-host.md](multi-host.md). |
| `packs/` | data | `jevris pack install`, `jevris policy stage` | Installed policy and skill packs. A pack whose privileges grow stays inactive until the change is approved. See [packs.md](packs.md). |
| `certifications/` | data | `jevris certify`, and the background re-check that doctor, the sidecar's start or a SessionStart starts | Signed certification records, each for a harness version range. On this machine, a record signed by its local certification key or by a key in the package's trust store counts; the release gates accept only the trust store. |
| `reverify/` | data | the background re-check | One marker per re-checked harness version (or demotion): running, passed or failed, with the failing features. |
| `live-evidence/events.jsonl` | data | the sidecar (hook deliveries) and owned workers (first-use checks) | Live certification evidence: per harness, version and feature, conforming and malformed counts and any demotions. Names, versions, counts and reason codes only, never content. Append-only, owner-only, compacted past 1 MiB with every demotion kept. |
| `route-learning/` | data | the sidecar | Route learning per workspace: policy versions and outcome counts, no text. Its own retention class. See [routing.md](routing.md#where-it-is-kept). |
| `*-install-receipt.json` | data | `jevris install` | What each install wrote, so uninstall removes exactly that. |
| `jevris.db` | data | the sidecar | The decision store. See [The store](#the-store). |

## How the layers combine

Settings are built in this order, and each later layer can only make things safer: defaults, then `jevris.config.json`, then the repository's `.jevris/config.json`, then `organization.json`, then the `mode` and Jev decision budget ceilings of `host.json` and a managed `policy.json` (the lowest ceiling wins; `configure` and `status` name the layer that set the mode). The effective mode is the single ceiling on what Jevris does: `off` does nothing, `observe` records and asks Jev without showing anything, `advise` also shows advice, and `bounded-auto` (the default) also acts on certified capabilities. `routing.managedWorkers` never exceeds it, and below `bounded-auto` the main session is advice-only. The details, including every key and which layer may change it, are in [settings.md](settings.md).

`host.json` and `organization.json` are validated against the host-policy contract. A file that fails validation is not ignored silently: `jevris status` and `doctor` report `HOST_POLICY_INVALID` or `ORGANIZATION_POLICY_INVALID`, source egress stays denied, the mode is capped at `observe`, retention is capped at the defaults (7 days for raw artifacts, 30 days for decisions) and the Jev decision budget at the default 5 USD, so an invalid file can never lengthen retention or raise spending.

## Which file holds each settings block

The settings are one JSON document, `jevris.config.json`, with administrator ceilings in `host.json` and `organization.json`. Every key, its default and who may change it are in [settings.md](settings.md).

| Settings block | Product file and keys | Ceiling |
| --- | --- | --- |
| `mode` | `jevris.config.json` `mode` | `mode` in `host.json`, `organization.json` and a managed `policy.json`; a repository's `.jevris/config.json` may only lower it |
| `provider` | `jevris.config.json` `provider.*`; the key itself only in the OS keychain (`jevris credential set`) | `organization.json` `pin.model`; `credentialRef` is always `host-secret:typesafe-primary` |
| `decisions` | `jevris.config.json` `decisions.*` | `organization.json` `budget.maxRequestBytes`; `budget.monthlyDecisionMicroUsd` in `host.json`, `organization.json` and a managed `policy.json` caps `decisions.monthlyBudgetMicroUsd`; a repository's `.jevris/config.json` may only lower it, for that workspace; `allowUncalibratedActuation` is always `false` |
| `privacy` | `jevris.config.json` `privacy.*` | egress: only `host.json`, `organization.json` or a managed policy approves it; retention: the `retention` maximums of all three |
| `routing` | `jevris.config.json` `routing.*`; `calibrationArtifact` comes from `calibration-release.json` | `routing.respectHumanPins` is always `true` |
| `orchestration` | `jevris.config.json` `orchestration.*` | a repository's `.jevris/config.json` may only lower it |
| `compaction` | `jevris.config.json` `compaction.*` | fixed in this release |
| `packs` | `packs/` in the data folder | `host.json` `packPrivileges` |

## host.json

Every field is required except `budget.monthlyDecisionMicroUsd`; an unknown field makes the file invalid.

```json
{
  "schemaVersion": "1.0",
  "mode": "advise",
  "egress": "deny-until-approved",
  "retention": { "rawArtifactRetentionDays": 7, "decisionRetentionDays": 30 },
  "budget": { "maxRequestBytes": 65536 },
  "pin": { "model": "jev-1.13.0", "respectHumanPins": true },
  "packPrivileges": [],
  "credentialRef": "host-secret:typesafe-primary",
  "installerEnvName": "JEVRIS_INSTALLER_KEY",
  "allowUncalibratedActuation": false
}
```

| Field | Meaning |
| --- | --- |
| `mode` | `off`, `observe`, `advise` or `bounded-auto`: the most Jevris may do on this host. A `host.json` that cannot be used (a link, invalid JSON, not the contract) caps the mode at `observe`. |
| `egress` | `deny-until-approved` (default) or `approved-scoped`. Only this administrator file can approve sending source; a repository file, a prompt or a model summary never can. Set it with `jevris egress approve` (interactive terminal and a typed phrase) and `jevris egress revoke`; see [privacy.md](privacy.md#approving-egress). |
| `retention` | Maximum days to keep raw artifacts (0 to 365) and decisions (0 to 3650). A user's `privacy` settings can shorten them, never lengthen them. |
| `budget.maxRequestBytes` | Largest request Jevris may send to Jev (1 KiB to 16 MiB). `jevris egress status` shows the lowest cap of these files. In 1.2 the decision engine does not read this field yet: it enforces its built-in cap of 131072 bytes. |
| `budget.monthlyDecisionMicroUsd` | Optional. A ceiling on the monthly Jev decision budget, in whole micro-USD (0 to 1000000000). It caps your `decisions.monthlyBudgetMicroUsd` and so every workspace's cap. The same field in `organization.json` and a managed `policy.json` is a ceiling too; the lowest wins. See [The Jev decision budget](#the-jev-decision-budget). |
| `pin.model` | The Jev model version decisions are calibrated for. In 1.2 the decision engine always requests `jev-1.13.0`. `respectHumanPins` is always `true`: Jevris never overrides a model you pinned. |
| `packPrivileges` | Privileges a pack may use on this host. |
| `credentialRef` | Always `host-secret:typesafe-primary`: the key lives in the OS keychain (`jevris credential set`), never in this file. |
| `installerEnvName` | An environment variable name an installer may use to hand over the key once. |
| `allowUncalibratedActuation` | Always `false`. |

When `host.json` is missing, `jevris egress approve` (or `revoke`) creates it with these defaults and the chosen `egress`:
- `mode` `bounded-auto`: no ceiling beyond your own settings, as with no file;
- retention 7 and 30 days;
- `budget.maxRequestBytes` 131072;
- `pin.model` `jev-1.13.0`;
- no pack privileges;
- `credentialRef` `host-secret:typesafe-primary`;
- `installerEnvName` `JEVRIS_INSTALLER_KEY`.

In an existing file it changes only `egress`.

## The Jev decision budget

Jevris's own calls to Jev are paid for from a monthly decision budget. It covers only Jevris's decisions, never your harness's own model usage, and it is separate from the budgets of owned work (`jevris plan --submit --limit-micro-usd`, `jevris budget`). Money is counted in whole micro-USD (1 USD is 1000000), never as a floating-point number.

**The machine-wide limit.** `decisions.monthlyBudgetMicroUsd` in `jevris.config.json` sets it; the default is 5000000 (5 USD) per calendar month (UTC). Every workspace on this machine spends from it. It may be 0 to 1000000000 (1,000 USD); the maximum guards against a typo and is not a price estimate. 0 means no Jev calls at all: every decision runs rules-only and says so.

```
jevris configure set decisions.monthlyBudgetMicroUsd 2000000     # 2 USD a month
jevris configure set decisions.monthlyBudgetMicroUsd 0           # no Jev calls
```

Raising the limit above its effective value lets Jevris spend more, so it needs a person at an interactive terminal who answers `y`; `--yes`, `--json`, a pipe, a script, MCP, a hook and a test run are refused with `CHANNEL_REFUSED` (see [settings.md](settings.md#raising-what-jevris-may-do)). Lowering it, or setting the value it has, never asks.

**Ceilings.** `budget.monthlyDecisionMicroUsd` in `host.json`, `organization.json` or a managed `policy.json` caps the limit; the lowest wins, and `jevris configure` shows the effective value. A ceiling file that cannot be used caps the limit at the default 5 USD, as it caps retention, and a `jevris.config.json` that cannot be used falls back to the default too, never to the value it held.

**A workspace's own cap.** A workspace may have a monthly cap inside the machine-wide limit:

```
jevris configure workspace-budget                 # show this workspace's cap and the limit
jevris configure workspace-budget 500000          # 0.50 USD a month for this workspace
jevris configure workspace-budget none            # no cap of its own
```

The cap is kept on this machine, in the host orchestration ledger under the data folder (`orchestration/host/jev-budget-caps`), keyed by the workspace's id, like owned mode. Setting a first cap or a lower one needs nothing; a higher cap, or `none`, lets that workspace spend more and needs a person at an interactive terminal, with the same refusals. A repository's committed `.jevris/config.json` is not consent: its `decisions.monthlyBudgetMicroUsd` may only lower that workspace's budget (a higher value is ignored), and never touches the machine-wide limit. The lower of the stored cap and the repository's value applies. A cap record that cannot be read counts as 0, so that workspace runs rules-only until the cap is set again.

**How it is spent.** The budget file is `<data>/decision-budget.json`, shared by every process. Each call reserves its estimated cost before it is sent and settles it afterwards. A reservation must fit both the machine-wide limit and the workspace's cap, checked together under one cross-process lock, so no two processes can overspend either. A call whose usage is unknown (a timeout that may have been billed) holds its reservation until it is reconciled. The sidecar reads both limits at every reservation, so a change applies to the next decision without a restart, and the month's spent amount is kept.

**When it runs out.** When the machine-wide limit has no room, every decision runs rules-only with the reason codes `BUDGET` and `BUDGET_MACHINE_LIMIT`. When a workspace's cap has no room, only that workspace's decisions do, with `BUDGET` and `BUDGET_WORKSPACE_CAP`; other workspaces go on. `BUDGET_ZERO` is added when the cap that stopped it is set to 0. Both start again on the first day of the next month (UTC).

**Seeing it.** `jevris status` shows the month's spend against the machine-wide limit, against this workspace's cap if it has one, and the reset date; while a cap has no room, decision health is `degraded` and the reason names the cap. `jevris cost-report` shows the same amounts with the decision calls' cost. `jevris doctor` adds a `jev budget:` line while the machine-wide limit is spent (an action) or set to 0 (a fact).

## The sidecar

The sidecar is the one long-running Jevris process per user. It holds the store, reads the Jev key, and answers hooks, MCP tools and CLI commands. It starts on demand and needs no service. The first command, hook or MCP call that needs it starts it in the background, and it exits after 30 minutes without requests (`JEVRIS_SIDECAR_IDLE_MS` changes that; `0` never exits; under `jevris service` it never exits for idleness). Set `JEVRIS_SIDECAR_AUTOSTART=0` to stop hooks, MCP tools and the public commands (`status`, `plan`, `route` and the rest) from starting it. A sidecar that is already running still answers them; with none running they answer rules-only, and a hook gives the harness its plain "no decision" answer (reason `SIDECAR_AUTOSTART_OFF` with `JEVRIS_HOOK_DEBUG=1`). The administration commands (`store`, `audit`, `data purge`, `authorize`) always start it, because it is the store's only writer.

| Command | What it does |
| --- | --- |
| `jevris sidecar status [--json]` | pid, version, uptime, endpoint, store and kill-switch state. Exit 1 when it is not running (hooks and commands then run rules-only). |
| `jevris sidecar start` / `stop` / `restart` | Start it now, ask it to finish in-flight work and exit, or both. |
| `jevris service install` / `uninstall` / `status` | Optional. Runs the sidecar as a per-user service: a LaunchAgent (`~/Library/LaunchAgents/dev.jevris.sidecar.plist`), a systemd user unit (`~/.config/systemd/user/jevris-sidecar.service`) or a Scheduled Task at logon (`\Jevris\Sidecar`). The service starts it at login without an idle exit. It restarts the sidecar after a crash, and a clean `jevris sidecar stop` is respected until the next login. Without a systemd user session (for example in a container) the command says so, and the sidecar still starts on demand. |

Files in the runtime folder, all owner-only, recreated at each start and removed at a clean stop:

| File | Purpose |
| --- | --- |
| `endpoint.json` | Where the sidecar listens, its pid, version and boot id. |
| `key-cli`, `key-hook`, `key-mcp` | The per-surface keys that sign requests. A hook key cannot administer Jevris. |
| `sidecar.pid`, `sidecar.lock`, `spawn.lock` | One sidecar per user; a stale lock from a crashed sidecar is recovered. |
| `s` (macOS, Linux) | The Unix socket. A socket left by a sidecar that is gone is detected with a connect probe and removed at the next start. Anything at that path that is not a socket is never removed. |

**Hook events.** The sidecar records each hook event, then asks its subscribers (the decision engine, the orchestrator and the security triage) for advice. It waits for each one for at most 700 ms, and never longer than 80% of the hook's remaining deadline, so the hook still answers in time. A subscriber that has not answered by then is queued: the event is answered without its advice, and the hook's reason is `SUBSCRIBER_QUEUED` (see [mcp.md](mcp.md#troubleshooting-with-the-reason-code)).

The queued work is never dropped. It keeps running in a bounded background pool (4 jobs at once), in order per session and subagent: a later event of the same session waits behind it. Hook requests always go first; background work waits while a hook is being answered, unless nothing else in the background is running. Two kinds of event are never queued by choice: a session start (the capsule restore) waits for that session's earlier work, such as a capsule write, and then runs inside the hook's full deadline, and so does a Stop. If more background work is waiting than fits in memory (16 MiB), the rest goes to private files under `spool/` in your Jevris data folder. Each file is removed once its work has run, and work left there when the sidecar stops runs at the next start. The files hold the event bodies, so `jevris data delete` removes them with the data folder.

The sidecar admits at most 24 hook and other quick requests, and 8 background ones, at a time. A request that arrives when its pool is full is answered `BUSY` at once rather than left to time out. Eight more slots are kept for the hook events whose answer must not be lost: SessionStart (a compact restore), Stop (a reminder) and PreCompact (the capsule). Those events are admitted from the kept slots when the ordinary pool is full, so load does not turn them into `BUSY`. While one of them runs, new quick requests are admitted only while fewer than four run, and the rest are answered `BUSY` at once, so the answer is not slowed by other requests sharing the sidecar. The same holds for connections: past the sidecar's 64 open connections, eight more are accepted, and a request on one of them is served only if it is one of those events; anything else there is answered `BUSY`. Only a signed hook request for one of those events can use the kept slots. A request whose work runs past its deadline counts against the background pool until it finishes. `jevris status` shows these queues.

Where it listens:

- **macOS and Linux:** the Unix socket `<runtime>/s`. When that path is too long for a socket (over 103 bytes), the socket moves to `$XDG_RUNTIME_DIR/jevris/`, `$TMPDIR/jevris-<uid>/` or `/tmp/jevris-<uid>/`. That folder must be yours and `0700`, and the socket name is derived from your runtime folder, so two homes never share a socket.
- **Windows:** a named pipe `\\.\pipe\jevris-<user hash>-<random>`. The name is new at every start, and the pipe's access list allows only you and SYSTEM. `endpoint.json` records the current name.

Nothing listens on a TCP port.

Logs are in `<state>/logs`, owner-only. They hold reason codes and ids, never source text, prompts or keys.

**Deliveries the Kilo and OpenCode plugin lost.** These harnesses load the Jevris plugin in their own process, and it starts the hook launcher for each event. The launcher cannot see a delivery that never reached it, so the plugin counts each one under one of these codes:

| Code | When |
| --- | --- |
| `SHIM_DROPPED` | An event arrived while 8 deliveries were already running, so the plugin dropped it. |
| `SHIM_SPAWN_FAILED` | The launcher could not be started, or the event could not be written to it. |
| `SHIM_TIMEOUT` | The plugin stopped waiting: after 1.5 s for compaction, or after 300 ms for a top-level message. The session goes on with nothing added. |
| `SHIM_KILLED` | The launcher ran past its hard timeout (5 s for compaction, 30 s otherwise) and was killed. |

The counts go with the next event that reaches the launcher, which appends one line per miss (at most 64 per delivery) to `<state>/hook-latency.pending.jsonl`. A line holds the harness, the code, the elapsed milliseconds and a time, and nothing from the event. The file is written owner-only and stops growing at 64 KiB. The sidecar folds it into the store's daily latency counters at start and at each flush, then removes it. The counters hold only harness, code, count and time; `jevris data delete` removes them with the rest of the data folder.

## The store

`<data>/jevris.db` is a SQLite database written only by the sidecar. Beside it:

| File | Purpose |
| --- | --- |
| `jevris.db-wal`, `jevris.db-shm` | SQLite's write-ahead log. |
| `jevris.db.writer` | The single-writer lock: pid, machine and role of the process that holds the store. The machine is a hash of the stable machine id, so a stale lock from before a network name change is still recognised as this machine's. |
| `jevris.db.authz-key` | The key that signs single-use authorizations (`jevris authorize`). Never exported. |
| `jevris.db.diagnostic.json` | Written when the store fails (disk full, corruption, read-only); `jevris sidecar status` shows it. |
| `jevris.db.pre-restore-<time>` | The store as it was before `jevris store restore`. |
| `<data>/evidence/` | Raw tool artifacts, kept for the raw-artifact retention period. |
| `<state>/jev-circuit.json` | The Jev circuit breaker per provider and account: its state (closed, open, half-open, observe-only or disabled), why it is disabled (`AUTH`, `BILLING` or `ACCOUNT`), when, how long it stays open (at most 15 minutes), and a 16-character fingerprint of the Jev key, never the key. Only the sidecar writes it, owner-only (`0600`). A missing or damaged file starts closed. A billing or account disable clears with `jevris credential reenable` at a terminal, a key refusal with a new key (`jevris credential set`). Not swept by age; `jevris data delete` and `jevris uninstall --delete-data` remove it. |
| `<data>/decisions/`, `<data>/decision-budget.json` | Decision journal and budget, archived into the store every minute. A journal entry older than the decision retention period is not archived, and the daily sweep removes such entries from the journal, so a decision the sweep removed from the store does not come back. |

| Command | What it does |
| --- | --- |
| `jevris store status` | Schema version, whether an upgrade is pending, and the sidecar's view of the store. |
| `jevris store migrate --dry-run` | Lists pending schema migrations and changes nothing. Without `--dry-run` it stops the sidecar and applies them; a destructive step takes a backup first. |
| `jevris store backup <file>` | A consistent, owner-only, integrity-checked copy. The file must be new, inside your home and not reached through a symbolic link. |
| `jevris store export <file>` | Every durable table as JSON lines, without authorization secrets. |
| `jevris store restore <file>` | Stops the sidecar, checks the backup (integrity, same machine and user, a schema this Jevris understands), keeps the current store as `.pre-restore-<time>`, and installs the backup. A backup made by an earlier Jevris under one of this machine's host names is accepted when it is your file in your home, and is installed with this machine's identity. |
| `jevris store adopt` | Marks your own store as this machine's after it was refused as copied (see [The store's machine identity](#the-stores-machine-identity)). Interactive terminal only: it asks you to type `yes`, stops the sidecar, re-stamps the store and records a `store.adopt` audit row. It refuses a file that is not yours or not in this home, a symbolic link, a corrupt store and a store another process holds. |
| `jevris audit export <file>` / `jevris audit verify` | The hash-chained audit log as JSON lines, or a check that no row was altered. |
| `jevris data purge [--dry-run]` | Apply retention now. |

The store refuses a network file system (NFS, SMB, AFP, network drives) and a store copied from another machine or user. A store written by a newer Jevris is refused until you upgrade.

### The store's machine identity

The store records a host scope: a hash of this machine's stable id, your user, the platform and the real path of your home. The machine id is `IOPlatformUUID` on macOS, `/etc/machine-id` (or `/var/lib/dbus/machine-id`) on Linux and `MachineGuid` on Windows; your user is the numeric uid, or the account SID on Windows. The raw id is never stored or printed. A store whose scope does not match is refused as copied (`host-scope-mismatch`).

- Earlier releases derived the scope from the host name. On macOS the host name follows the network, so a network change could make Jevris refuse its own store. When the sidecar opens a store stamped that way, and the scope matches this machine under one of its names (`hostname`, and on macOS `scutil --get LocalHostName` with and without `.local`, and `scutil --get ComputerName`), and the file is yours and in your home, it re-stamps the store in one transaction, logs `HOST_SCOPE_MIGRATED` and records a `store.adopt` audit row.
- A store that matches none of these stays refused. If it is your file in your home, `jevris doctor` and `jevris sidecar status` say that it probably came from an earlier network name and give the fix: `jevris store adopt`, or stop the sidecar and move it aside. See [troubleshooting.md](troubleshooting.md#the-store-is-refused-as-copied).
- If the machine id cannot be read, Jevris uses the host-name scope, and `jevris doctor` shows `storeIdentity: host name (<reason>)`. Otherwise doctor shows `storeIdentity: machine id`.

## Retention

Every file uses the same two names:

- `rawArtifactRetentionDays`: raw tool artifacts, default 7, range 0 to 365;
- `decisionRetentionDays`: decision records and other redacted records, default 30, range 0 to 3650.

| Where | Key | Role |
| --- | --- | --- |
| `jevris.config.json` | `privacy.rawArtifactRetentionDays`, `privacy.decisionRetentionDays` | Your choice. |
| `organization.json` | `retention.rawArtifactRetentionDays`, `retention.decisionRetentionDays` | Your organization's maximum. |
| `host.json` | `retention.rawArtifactRetentionDays`, `retention.decisionRetentionDays` | This host's maximum. |

The effective value is your choice, capped by both maximums. There are no minimums.

`organization.json` and `host.json` must each be a complete, valid host-policy document. A file with an unknown key (for example `rawDays`) is invalid. It is reported as `HOST_POLICY_INVALID` or `ORGANIZATION_POLICY_INVALID`, and retention is then capped at the defaults, so a broken file never lengthens retention.

Pinned memory is kept until you unpin or delete it. Route learning (`<data>/route-learning/`, the machine-wide prior in `route-learning/machine/` and the models-found-gone record `route-learning/model-availability.json` included) is its own retention class: the 7-day and 30-day sweeps never touch it, and only `jevris route learning reset --clear-evidence` or `jevris data delete` removes it; `jevris route learning reset --machine` clears the machine-wide prior alone (see [routing.md](routing.md#where-it-is-kept)). Retention runs when the sidecar starts, then daily.

The files beside the store have these classes:

| Path in the data folder | Class | Swept |
| --- | --- | --- |
| `orchestration/<workspace>/state/` and `orchestration/host/`: `hook-deliveries`, `loop-signals`, `loop-explained`, `stop-reminders`, `stop-reports`, `compaction-deferrals`, `rehydrations`, `evidence-selections`, `evidence-reads`, `task-estimates`, `restore-outcomes`, `integration-reverts`, `revert-scan`, `subagent-runs` | redacted history (ids, commit ids, ranks, outcomes, estimates, costs, token counts and times; no text) | after `decisionRetentionDays` (30), by the record's last write |
| `orchestration/host/worker-runs` | redacted run records | after `decisionRetentionDays` (30), by the run's end; a run whose owned effect is `held` is kept until it is settled |
| every other `orchestration/` collection (leases, reservations, budgets, worktrees, fences, plans, approvals, escalations, memory, probes) | live state | never by age; `jevris data delete` removes it |
| `live-evidence/events.jsonl` | certification evidence | conforming lines after `decisionRetentionDays` (30); demotions are kept |
| `route-learning/` | route learning | never by age |
| `route-learning/model-availability.json` | route learning | never by age; the next model registry refresh clears it (at most 64 entries), and `jevris route learning reset --machine` deletes it |
| `route-learning/model-offer.json` | route learning: which models each harness and sign-in was seen running or listing (schema `jevris-model-offer-2`), with the harness's own spelling of each (for example `openrouter/moonshotai/kimi-k3`) and the serving host it goes to; ids, times, harness versions and reason codes, never listing output, a path, a workspace or an account. At most 64 listings of 256 models each and 512 runs, 256 KiB, owner-only. A version 1 file still reads: it proves a model but not a host, and the next write is version 2 | never by age; `jevris route learning reset --machine` deletes it, and `jevris data delete` and `jevris uninstall --delete-data` remove it with the rest of `route-learning/` |
| `route-learning/access-limits.json` | route learning: the machine's access pauses per harness, sign-in and serving host (classes, model ids, times and counts, and for an API-key run where Jevris holds the key a 16-character fingerprint of it, never the key; no text), at most 128 entries and 64 KiB, owner-only. `jevris route limits` lists it and `jevris route limits clear` removes pauses from it ([routing.md](routing.md#seeing-and-clearing-pauses)) | never by age; an entry drops itself 7 days after its pause ends, and `jevris route learning reset --machine`, `jevris data delete` and `jevris uninstall --delete-data` remove the file |
| `route-learning/access-limits.json.damaged-<time>` | route learning: an access-limit record that could not be parsed, set aside unchanged before a new record was written, so a person can look at it; owner-only, at most 3 (the oldest goes first). A record that could not be read for another reason, or that a newer Jevris wrote, is never set aside or written over | never by age; `jevris route limits clear --all`, `jevris route learning reset --machine`, `jevris data delete` and `jevris uninstall --delete-data` remove them |
| `route-learning/usage-readings.json` | route learning: the last read-only Codex usage reading per sign-in (for each window a percentage band, a weekly flag and a checked reset at most 8 days ahead, whether usage was allowed, and whether the read was certified; never the raw reading, text, an account id or a key), at most 4 readings and 4 KiB, owner-only. A reading that allows usage with no window exhausted can lift that sign-in's usage pause early | never by age; each reading replaces its sign-in's, and `jevris route learning reset --machine`, `jevris data delete` and `jevris uninstall --delete-data` remove the file |
| `route-learning/calibration-cases/<workspace>.json` | route learning: local calibration cases, each a provider probability beside a verified task outcome (ids, codes and numbers; no text), for a person to review, written by `jevris route learning export-cases`. Jevris never loads, applies or uploads it; only a reviewer-signed calibration release can use its cases | after `decisionRetentionDays` (30), by the file's last export (each export replaces it), because its cases come from the decision outcomes in the store and learning never lengthens retention; `jevris route learning reset --clear-evidence` removes this workspace's, and `jevris data delete` and `jevris uninstall --delete-data` remove it |

The hook records table in the store (`hook_records`, schema 8) holds the sidecar's hook bookkeeping that used to be files under `orchestration/`. Each row is swept after `decisionRetentionDays` (30) by its last write. The sidecar buffers these writes and commits them together at most a second later, and when it stops.

The provider consent table (`provider_consent`, schema 9) is not swept. Neither a grant nor a revoke ages out: a grant stays until you revoke it, a revoke stays until consent is given again, and `jevris data delete` removes both. See [privacy.md](privacy.md#consent-per-model-provider).

`jevris data purge [--dry-run]` reports the orchestration records, live-evidence lines and local calibration cases files it removes (or would remove) beside the store rows and raw files.

## Kill switch

| File (config folder) | Written by | Purpose |
| --- | --- | --- |
| `kill-switch.json` | `jevris kill-switch activate` / `clear` / `drill` | `{"stopped": true or false, "at", "channel", "actor", "reason"}`. Read on every sidecar request. A missing file means running. A file that is unreadable, oversized, not UTF-8, not JSON, or without a boolean `stopped` means stopped. |
| `kill-switch-log.jsonl` | the same commands | The last 500 activations, clears and drills, owner-only. The store's audit log holds the same events, hash-chained. |
| `kill-switch-drill.json` | `jevris kill-switch drill` only | Written only when every drill check passed. A pack that asks to act automatically stays inactive until this record exists. |

| Command | Notes |
| --- | --- |
| `jevris kill-switch status [--json]` | Stopped or clear, with who, when and why. |
| `jevris kill-switch activate [--reason <text>]` | Works without any prepared file. Reports each step; if the sidecar is running, in-flight owned effects are held for reconciliation and audited. |
| `jevris kill-switch clear` | Interactive terminal only; refused from MCP, hooks and scripts. |
| `jevris kill-switch drill` | Activates, checks that a running sidecar reports stopped and that a damaged flag fails closed, restores the previous state, then records the drill. |

While the switch is stopped:

- hook events are recorded, but no advice or decision follows from them;
- every sidecar operation that changes something answers `KILL_SWITCH`;
- the MCP owned-mode submit is refused;
- `jevris data delete` refuses (`KILL_SWITCH_ACTIVE`) and keeps the data and the kill-switch files, so deleting data never lifts a stop.

## Managed policy (administrators)

Administrators deliver policy to admin-owned locations that users cannot write:

| OS | Location |
| --- | --- |
| macOS | `/Library/Application Support/Jevris/` |
| Linux | `/etc/jevris/` |
| Windows | `%ProgramData%\Jevris\` or the registry key `HKLM\Software\Policies\Jevris` |

Two files can go there:

- `policy.json` is a complete host-policy document, the same contract as `host.json`. On Windows it can also be the `Policy` registry value (`REG_SZ`, the same JSON).
- `kill-switch.json` is `{"stopped": true, "reason": "..."}`. On Windows it can also be the `KillSwitch` registry value (`REG_DWORD`, 1 stops).

Jevris checks ownership before it reads either file:

- On macOS and Linux, the file and every folder above it must be owned by root and writable by no one else.
- On Windows, only SYSTEM, Administrators and TrustedInstaller may have write access.

A file that fails the check, for example a world-writable one, is refused:

- A refused `policy.json` approves nothing. Source egress stays denied, retention is capped at the defaults, the mode is capped at `observe`, and `status` reports `MANAGED_POLICY_REFUSED`.
- A refused or malformed `kill-switch.json` counts as stopped.

With a managed `policy.json` in place, the user's `host.json` and `organization.json` are user files. They can only narrow the managed policy. A user file that would widen it is ignored and reported as `POLICY_WIDEN`.

The managed kill switch is read on every request. On Windows the registry value is read by starting `reg.exe`, so the sidecar keeps each answer for about a second and refreshes it in the background: a change there takes effect within about a second while Jevris is in use, and an answer is never more than 5 seconds old. `jevris kill-switch status` shows whether your organization or you stopped Jevris. `jevris kill-switch clear` clears only your own flag, so setting `mode` to `off` or clearing your own switch never turns off the organization's controls.

Live checks on an MDM- or GPO-managed machine for each OS are still outstanding.

## Authorizations

`jevris authorize <action> --scope <scope> [--ttl-minutes <n>]` mints a single-use approval from an interactive terminal. It expires after 5 minutes by default, and after at most 15.

The actions are `task.exception`, `kill-switch.clear`, `data.delete`, `policy.change`, `credential.set` and `budget.increase` (scope: the budget id). Approving source egress takes no authorization: `jevris egress approve` asks the person at the terminal directly. The scope is a plain name, for example a task id or `ledger`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `JEVRIS_HOME` | The home Jevris uses instead of your home directory (`--home` overrides it). |
| `JEVRIS_SIDECAR_AUTOSTART=0` | Hooks, MCP tools and the public commands never start the sidecar. A running sidecar still answers; with none they answer rules-only. `jevris sidecar start` and the administration commands still start it. |
| `JEVRIS_SIDECAR_IDLE_MS` | Milliseconds without requests before an on-demand sidecar exits (default 1800000, 30 minutes; `0` never exits). |
| `JEVRIS_SIDECAR_ENTRY` | Path of the sidecar entry to start (development builds only). |
| `JEVRIS_BIN` | An absolute path to the `jevris` entry for the MCP server to run, instead of the one `jevris install` recorded. |
| `JEVRIS_HOOK_DEADLINE_MS`, `JEVRIS_HOOK_OBSERVE_ONLY=1` | The hook launcher's deadline (100 to 4000 ms, default 1500), and observe-only mode. See [mcp.md](mcp.md#settings). Each hook opens one connection: it sends its event straight to the sidecar, and starts the sidecar (without waiting for it) only when that finds none. A hook that answers without the sidecar appends one line to `<state>/hook-latency.pending.jsonl`, holding the harness, a reason code, the milliseconds and the time. That covers its watchdog, the deadline, the sidecar starting or unreachable, and a client-side miss (`TIMEOUT`, `HANDSHAKE_TIMEOUT`, `BUSY`, `CONNECT_*`, `ECONNREFUSED`, `CLOSED`). The sidecar folds that file into its daily latency counters. Observe-only and autostart off are choices, and they write nothing. |
| `JEVRIS_OWNED_MODE` | Not read. No environment variable turns owned mode on; `jevris configure owned-mode on --workspace <dir>` does, per workspace. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | Your harness vendors' keys. Jevris only checks whether one is set, to decide an owned worker's `auto` sign-in mode (on OpenCode and Kilo, together with the provider and type of the credentials the harness has stored), and passes it on only to an `api-key` run; it never logs or stores one. A subscription run never sees them. See [routing.md](routing.md#harness-sign-in-subscription-or-api-key). |
| `JEVRIS_CREDENTIAL_FILE=/absolute/path` | Headless Linux, CI and WSL only: the Jev key from an owner-only file outside any git work tree, read only when the keychain has no key. Refused unless it is `chmod 600` and yours. See [security](security.md#headless-machines-the-opt-in-key-file). |
| `JEVRIS_CREDENTIAL_SYSTEMD=<name>` | The same, from a systemd credential: `$CREDENTIALS_DIRECTORY/<name>`. Set only one of the two. |
| `JEVRIS_HOOK_DEBUG=1` | The hook launcher prints its reason codes (never event content) to standard error. |
| `NO_COLOR`, `TERM=dumb`, `FORCE_COLOR=0` | `jevris` prints plain text in a terminal too, as with `--no-color`. Colour, marks and the logo appear only when standard output is a terminal; a pipe, a file and `--json` are always plain. |
| `FORCE_COLOR=1`, `2` or `3` | In a terminal, 16 colours, 256 colours or true colour. It does not add colour to a pipe. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Linux folders, used only when Jevris runs in your own home. |
| `XDG_RUNTIME_DIR`, `TMPDIR` | Where a too-long socket path moves on macOS and Linux. |
