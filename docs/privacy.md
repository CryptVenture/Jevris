# Privacy

Nothing leaves this machine unless an administrator allows it, and then only the fields a decision needs. Remote telemetry is off, and there is no hosted dashboard. The security boundary, the Jev key and the kill switch are on [security.md](security.md).

## What can leave this machine

Nothing leaves unless an administrator's `host.json` sets `egress` to `approved-scoped`; `jevris egress approve` is the supported way to set it (see [Approving egress](#approving-egress)). A file in the repository, a skill, a prompt or a model summary can never approve sending source. When a decision is sent to Jev, it carries only the fields the question needs, under the decision engine's request-size cap of 131072 bytes. While egress is not approved, a request to Jev carries no free text from the workspace or its tools, only bounded structured features: categories, counts, reason codes, sizes and salted hashes. Remote telemetry is off.

On a ChatGPT sign-in, the Codex model listing also asks Codex once how much of the plan is left (`account/rateLimits/read`). Codex answers it from OpenAI with your own login, as it does for its own usage display. No model runs, nothing is billed, and nothing from the workspace is sent. Jevris keeps only each window's band, whether it is weekly, its reset and whether usage is allowed (`route-learning/usage-readings.json`, at most 4 readings, owner-only), never the percentage, the account id, the plan or a credit balance. It is never sent with a Codex or OpenAI key in the environment. See [codex.md](harnesses/codex.md).

Your coding harness talks to its own model vendor, as it always does; Jevris does not change that. An owned worker is a run of that same installed harness, under your login or key, in a task's worktree, so what it sends to its vendor follows that harness and your account's terms, as when you run it yourself (see [routing.md](routing.md#owned-workers)).

## What is not consent

Only an administrator's `host.json` can approve egress. None of these can:

- a file in the repository, including `jevris.config.json`
- a sentence in a skill, a prompt or a model summary
- `enabledPlugins` or any other harness setting
- an MCP tool call or a hook event

## Approving egress

`jevris egress status` shows whether egress is approved, where that comes from (a managed policy, `host.json`, or the default), what may be sent (the field classes, the request byte cap and the local retention caps), and whether the Jev key is in the OS keychain. It never shows the key.

`jevris egress approve` works only for a person at an interactive terminal. It never runs from MCP, a hook, a script, a pipe or a test run. It first shows exactly what approval allows:
- the bounded, redacted fields a decision's question needs;
- secret and sensitive-path screening of every request, which stops a request on a finding;
- the request byte cap;
- that Jev keeps what it receives under the vendor's retention terms, and that local deletion is not vendor deletion.

It then asks you to type `approve egress`. Only then does it write `egress: approved-scoped` to `host.json`, atomically and owner-only (0600):
- a missing `host.json` is created with the defaults (see [configuration.md](configuration.md#hostjson));
- an existing one keeps every other field;
- an invalid one is refused, not replaced.

A managed policy or an `organization.json` that denies egress wins: `approve` then refuses and says why.

**Where the approval must live.** `host.json` and `organization.json` count only when all of these hold; otherwise they approve nothing, egress stays denied, and `jevris egress status` and `jevris doctor` name the reason code:

- the Jevris home is not inside a git work tree, such as a repository or a workspace (`JEVRIS_HOME_IN_WORK_TREE`): a repository that sets `JEVRIS_HOME` for your harness could otherwise supply its own approval;
- the file's folder is not inside a git work tree (`AUTHORITY_FILE_IN_WORK_TREE`);
- the file is a regular file, not a symbolic link (`AUTHORITY_FILE_SYMLINK`, `AUTHORITY_FILE_NOT_REGULAR`);
- on macOS and Linux, you own it (`AUTHORITY_FILE_NOT_OWNER`) and no group or other user can write it (`AUTHORITY_FILE_SHARED_WRITE`; `jevris egress approve` writes it 0600).

On Windows the owner and the ACL are not checked, only the other rules. The check runs where the approval is read: on every request at the transport guard, and in `egress status`, `doctor` and `approve`, which refuses before asking when the home is inside a work tree. A program running as you can still write a valid `host.json` in your real home; that is the same-user limit on [security.md](security.md#the-boundary-your-user-account).

`jevris egress revoke` sets `egress` back to `deny-until-approved`. Tightening is always allowed, so it needs no terminal. Both changes are recorded in the audit log (`egress.enable`, `egress.revoke`; `jevris audit export`). The transport guard reads the policy on every request, so a change applies without restarting the sidecar.

## Consent per model provider

Some model providers' terms train on what they receive by default or store it outside your region. Jevris never routes, suggests or launches a model from such a provider until you consent to that provider. Moonshot (Kimi) and DeepSeek always need this consent. Another provider that passed the registry review is allowed by default while you are signed in to it on an installed harness, and needs the same consent otherwise.

- Consent is given only by a person at an interactive terminal, through the Jevris CLI, after it shows that provider's training term and storage location. A repository file, a config file, an MCP tool call, a hook event or a model summary is never consent.
- The store keeps one row per provider: the version of the consent text you saw, when you gave it, and when it was revoked and that you revoked it. It holds no email address, account id or free text. Each grant and revoke is also in the audit log (`provider-consent.grant`, `provider-consent.revoke`).
- A grant counts only for the text you saw. When the text changes, Jevris asks again.
- Revoking always works, and needs no terminal. A stored revoke blocks the provider even while you are signed in to it, and a grant for an older text blocks it until you give consent again.
- You can revoke a provider you never granted, for example one allowed only because you are signed in to it. The stored row then shows the text version `none` and no grant time, and `jevris consent provider` lists it as `revoked (never granted)`. `jevris consent provider --all --revoke` revokes every granted provider, every provider the model registry names, and every serving host Jevris pins (a gateway such as OpenRouter, or an inference host such as NVIDIA), whether or not it was granted.
- A serving host is a consent party of its own, kept in the same place as a maker's consent. Each grant and revoke is audited with whether it was a maker or a host. A host that has no consent text in Jevris can never be granted, so Jevris never routes to it.
- Route advice (`jevris route` and the `jevris_plan_route` tool) names only models from the providers it was limited to, and lists them as `providers considered`. When the sidecar is not running, the CLI cannot read the stored consent, so its advice considers only providers that need no consent; every provider in the bundled registry has consent text, so it suggests no model.
- See and change it with `jevris consent provider` (the list), `jevris consent provider <id> --grant` (interactive terminal and a typed phrase) and `jevris consent provider <id> --revoke`. The list shows makers and serving hosts in two groups. A route through a host needs consent for the host and for the model's maker, so a grant for a host shows who the host passes your request to and says the maker's consent is needed too. OpenRouter and the Kilo Gateway are allowed while you are signed in to them; the provider they pass your request to may train on it by default. The Kilo Gateway passes requests to OpenRouter, so revoking OpenRouter also blocks routes through Kilo. NVIDIA has no consent text, so `--grant` refuses it (`CONSENT_TEXT_MISSING`). `jevris doctor` shows the hosts on a `servingHosts` line.
- Jevris learns which host a harness uses only on this machine: from the harness's own model listing and from the model a run or session reports. `route-learning/model-offer.json` keeps each spelling (for example `openrouter/moonshotai/kimi-k3`) and the host it goes to, never listing output or an account; `jevris route learning reset --machine` removes it ([configuration.md](configuration.md#retention)). Jevris does not route through a gateway or inference host yet, so today a host affects only its advice ([routing.md](routing.md#models-served-by-several-hosts)).
- Neither a grant nor a revoke ages out: a grant stays until you revoke it, and a revoke stays until you give consent again, because a revoke that aged out would let a signed-in provider through again. The ledger scope of `jevris data delete` removes every row with the store, and consent must then be given again.

### An administrator's model registry

Which providers and models exist, their prices and each provider's data terms come from the model registry. By default that is the snapshot bundled with Jevris. An administrator can place a replacement at `<config>/model-registry.json` (see [configuration.md](configuration.md)), for example to add a provider.

- The file is not signed. Anyone who can write your Jevris config folder can write it, which normally means you and administrators. It is trusted no more than the rest of that folder.
- It never grants consent. A provider it adds still needs your consent, or a sign-in where the rules above allow one.
- It must be at most 1 MiB, valid JSON and valid against the registry schema. If it is not, Jevris refuses it and routing is unavailable. Jevris never falls back to the bundled prices when an administrator meant to replace them. Rules-only decisions, hooks and verification keep working.
- `jevris status` and `jevris doctor` say which registry is in use (the `model registry:` line): the bundled snapshot, the administrator's override and its snapshot id, or a refused override with its reason code (`MODEL_REGISTRY_TOO_LARGE`, `MODEL_REGISTRY_NOT_JSON`, `MODEL_REGISTRY_INVALID` or `MODEL_REGISTRY_UNREADABLE`).

## Retention and deletion

Retention is local, and it runs at sidecar start and then daily:

- raw tool artifacts: 7 days;
- decision records and other redacted records: 30 days;
- pinned memory: kept until you unpin or delete it.
- route learning: kept until `jevris route learning reset --clear-evidence` or `jevris data delete`. Learning which model suits which kind of task takes weeks to months of outcomes, so the 7 and 30 day windows do not apply. What is kept is a per-workspace route-learning aggregate: policy versions, per-slice and per-model outcome counts and resource sums, and outcome ids from the last 30 days at most, used for reconciliation. It holds ids, counts, costs and times only, never text. It lives in `route-learning/` in the Jevris data folder, and the machine-wide prior pooled across your workspaces lives in `route-learning/machine/` under the same rule. `route-learning/model-availability.json` records the models found gone on this machine: model ids, reason classes, harness, sign-in mode, times and counts, never an error message, at most 64 entries and 64 KB, owner-only. It is in the same class; instead of an age window, an entry counts only under the model registry it was recorded with, and the next registry refresh clears it. `jevris route learning reset --machine` deletes it together with the machine-wide prior. `--clear-evidence` also withdraws the current workspace's share of the machine-wide prior.
- learning records in the store (ids, codes, counts, milliseconds and micro-USD only; never prompt, source or model text): each Jev decision joined to its task's verified outcome, each change of a session's model and whether model advice was followed, overridden or left without a change, daily counts of hook and sidecar deadline misses, and your accept or reject of a decision's advice with one of the fixed reasons (preference, unavailable-context, error or unspecified; never free text). They follow the decision window, 30 days, and never lengthen it. `jevris route learning reset --clear-evidence` and the `learning` scope of `jevris data delete` remove them sooner. They stay on this machine; a calibration case built from them reaches a release only after a person reviews it.
- access limits (`route-learning/access-limits.json`, one per machine, owner-only): each account pause's harness, sign-in, serving host and, for a rate limit, the model; its class, the id of the signal that caused it, whether an owned run or a session reported it, times, a repeat count and how its reset was decided. For a Claude or Codex API key that Jevris passes to an owned run, the `OPENROUTER_API_KEY` of an owned run through OpenRouter, or the one maker key of a direct Kilo or OpenCode run, it also keeps a 16-character fingerprint of that key (the first 64 bits of a SHA-256), never the key, so a new key can clear the pause; the fingerprint never appears in status, `jevris route limits`, doctor, the audit log or logs. It never holds provider text, headers, bodies or an email address. At most 128 pauses and 64 KiB; an entry is removed 7 days after it lifts. `jevris route limits clear` removes entries, and `jevris route learning reset --machine`, `jevris data delete` and `jevris uninstall --delete-data` remove the file.
- Codex usage readings (`route-learning/usage-readings.json`, owner-only, at most 4): the last reading per harness and sign-in, as bands, weekly flags, resets and whether usage is allowed; each reading replaces the one before. `jevris route learning reset --machine`, `jevris data delete` and `jevris uninstall --delete-data` remove the file.
- orchestration history (`orchestration/` in the data folder: hook delivery records, loop signals, stop reminders and reports, compaction deferrals, rehydration notes, evidence selections and reads) and owned worker run records: the redacted window, 30 days. A worker run whose effect is still held for reconciliation is kept until it is settled. The rest of `orchestration/` is live state (leases, budgets, worktrees, approvals, plans, memory) and is kept while the workspace exists.
- hook records in the store (`hook_records`: the sidecar's hook bookkeeping, such as loop signals, stop reminders and reports, restores, evidence selections and reads, and subagent runs; ids, codes, counts, times and paths, never text): 30 days after each record's last write, the decision window. The ledger scope of `jevris data delete` removes them with the store. A write reaches the disk within about a second, so a crash can lose at most the last second of this bookkeeping; receipts, budgets, money, permissions and consent are never written this way.
- the sidecar's spool (`spool/` in the data folder): hook events whose background work is waiting while the sidecar is busy, spilled from memory past 16 MiB. They are private files (mode 0600), each removed as soon as its work has run; work still waiting when the sidecar stops runs at its next start. `jevris data delete` removes the folder.
- live certification evidence (`live-evidence/events.jsonl`: harness, version, feature and a reason code, never event content): conforming entries follow the 30-day window. A demotion is kept, because it keeps a harness feature observe-only until a newer certification lifts it.

You can shorten these in `jevris.config.json` (`privacy.rawArtifactRetentionDays`, `privacy.decisionRetentionDays`). An administrator's `organization.json` or `host.json` can cap them. Nothing can lengthen them past those caps.

Deleted rows are removed with SQLite's `secure_delete`, which overwrites their content, and the write-ahead log is truncated, so deleted content does not linger in free space inside the file. The sidecar's own daily sweep runs in a background thread on a second connection to the store and deletes in batches of a few milliseconds each, with a pause between them, so a hook or command that needs the store waits at most about one batch (the sidecar log's `retention-swept` line records the longest batch as `longestWriteMs`); a store created by this version then returns its free space to the disk in small steps, and an older store reuses it. `jevris data purge` applies retention now and also compacts the file (`VACUUM`); `--dry-run` shows what would go.

**Local deletion is not vendor deletion.** `jevris data delete` removes Jevris data on this machine only. Anything already sent to Jev under an approved egress policy is governed by the vendor's retention and deletion terms, and has to be deleted with the vendor. "Not used for training" does not mean zero retention.

## Logs

Logs hold reason codes and ids. They never hold source text, prompts, request or response bodies, or keys. Provider errors are reported by code and status, never by copying the remote body.

Traces (`traces/trace-<date>.jsonl` in the Jevris state folder) follow each request from receipt to outcome. A trace line holds only event and operation names, the client kind, a request id, reason codes, Jevris decision ids, durations and counts. Workspace, task, session and delivery ids are written as keyed hashes. The key is private to your machine, so the hashes cannot be matched to anything elsewhere. Traces are owner-only, capped at 16 MiB a day and kept 7 days. `jevris sidecar diagnose on` adds request sizes and deadlines for at most an hour, then turns itself off. It never adds content, and turning it on or off is recorded in the audit log.

## Before you send proprietary source

Resolve the vendor's retention, subprocessors, residency, deletion and permitted source processing with your procurement or legal team first. "Not used for training" is not zero retention.

## Reporting problems

Do not attach customer source, keys, prompts or the store to issues or pull requests. `jevris doctor --json` contains none of these, and it is what a bug report needs.
