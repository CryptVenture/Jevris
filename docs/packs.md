# Policy packs

A pack adds declarative decisions, evidence selectors and rules to Jevris. It can also add a separate executable component, but only one that is signed and trusted. Installing a pack never activates it. A person approves the exact change a version makes, and the pack then runs as a canary before it becomes stable. `jevris pack` is an administration command. No MCP tool or model can install, approve or enable a pack.

## The shipped packs

| Pack | What it does |
| --- | --- |
| `jevris.observability` | Local traces, counters and status. It advises only and sends nothing. |
| `jevris.memory` | Advises when to checkpoint and what a capsule restores. It never compacts on its own. |
| `jevris.skill-advice` | Ranks installed skills for a task. It never runs a skill or uploads the repository. |

All three are advise-only. `jevris pack list` lists them as `built-in:`, with the folder to pass to `jevris pack install`. The release gates need a passing disable drill for each of them (see [../RELEASING.md](../RELEASING.md)).

## Install and inspect

```bash
jevris pack inspect ./my-pack          # validate it; show signature, delta and conflicts
jevris pack install ./my-pack          # copy it in as a draft; prints the delta hash
jevris pack list                       # installed packs, stage, active version, workspaces
```

A pack id must start with `jevris.` (for example `jevris.acme-routing`). `install` checks the manifest, the pinned file hashes and the signature. It copies the pack to `<data>/packs/<id>/<version>` and records it as a `draft`.

The **delta** is what the version adds compared with the active version and your host policy. It lists executables, egress destinations, tool access, data scopes, actions, effects and retention, each with a reason code, for example `EXECUTABLE_ADDED`, `EGRESS_DESTINATION_ADDED` or `RETENTION_INCREASED`. An item beyond the host policy is marked `POLICY_CEILING` and cannot be approved. The delta hash binds the pack, both versions, the manifest and the items. If the active version changes before you approve, the old hash is refused with `DELTA_STALE`, and `jevris pack inspect` shows the new one.

Signatures are Ed25519 over the manifest, and the manifest pins every file. The signature state is one of `verified`, `unsigned`, `unlisted-publisher`, `unknown-key` or `bad-signature`. A declarative pack does not need a signature. A pack with an executable component cannot be activated unless it is signed by a publisher you trust (`UNSIGNED_EXECUTABLE`, `PUBLISHER_NOT_ALLOWED`):

```bash
jevris pack publisher list
jevris pack publisher add acme --key acme.pub.pem --key-id acme-2026   # asks at a terminal; no --yes
jevris pack publisher remove acme
```

## From draft to stable

| Stage | How a version gets there |
| --- | --- |
| `draft` | `jevris pack install <dir>` |
| `fixture-tested` | `jevris pack test <id>@<version>` runs the pack's fixtures against its rules. A pack with decisions needs fixtures. |
| `shadow-approved` | `jevris pack shadow <id>@<version> --report <file>` attaches shadow evidence with at least one record and no actuation: either a shadow report or the comparison record that `jevris shadow --fixture <file> --out <file>` writes. A file that is neither, or that shows the shadow run applied, sent or actuated anything, is refused. |
| `canary` | `jevris pack approve <delta-hash>` activates the version. It needs a person at an interactive terminal who answers `y`; `--yes`, `--json`, a pipe or a script is refused with "Nothing was changed (CHANNEL_REFUSED): ..." and exits 2 (see [security.md](security.md#changes-that-need-a-person-at-a-terminal)). Approval saves the active host policy as `policy-previous.json`. |
| `stable` | `jevris pack promote <id>`, after passing canary metrics over at least 20 tasks |

```bash
jevris pack test jevris.acme-routing@1.0.0
jevris shadow --fixture labels.json --out shadow.json
jevris pack shadow jevris.acme-routing@1.0.0 --report shadow.json
jevris pack approve sha256:...                       # the delta hash from install or inspect
jevris pack canary jevris.acme-routing --metrics canary.json
jevris pack promote jevris.acme-routing
```

The canary metrics file has `schemaVersion` (`"1.0"`), `packId`, `version`, `tasks`, `verifiedSuccessRate`, `baselineVerifiedSuccessRate` and `privacyViolations`, and optionally `tolerance` (default 0.02, at most 0.5). A quality regression is a verified-success rate below the baseline by more than the tolerance. It rolls back to the previous version. A privacy violation also activates the kill switch, and so does any regression when you pass `--kill-switch`.

Every new version goes through the same stages, including one that only changes a decision's question or criteria. Its delta hash is new, and it cannot be approved before its fixtures and shadow run.

Two packs that claim the same exclusive domain (`conflicts: ["exclusive:<domain>"]`) cannot both be active. The second is refused at approval or enable with `EXCLUSIVE_CONFLICT`.

## Use a pack in a workspace

An active pack does nothing until you enable it for a workspace:

```bash
jevris pack enable jevris.acme-routing --workspace ~/src/app
jevris pack disable jevris.acme-routing --workspace ~/src/app
```

Disabling removes only the pack's enablement for that workspace. The workspace's files are not touched. While the kill switch is stopped, no pack activates and loaded packs are held at observe.

## Roll back

```bash
jevris pack rollback jevris.acme-routing
```

Rollback makes the previous version active again, or leaves the pack with no active version when there was none. If the version took a data backup before an irreversible storage migration, rollback restores that backup and keeps the replaced data beside it. It keeps the pack's history, its workspace enablement, your settings and your host policy.

## Uninstall

```bash
jevris pack uninstall jevris.acme-routing                   # remove its versions; keep its data
jevris pack uninstall jevris.acme-routing --cleanup         # also delete the kept data (asks, or --yes)
```

Uninstall deactivates the pack, drops its enablement in every workspace and deletes its version folders under `<data>/packs/<id>/`. It never touches a file in a workspace, another pack or your settings. It keeps the pack's data folder and backups and lists them under `kept`. The registry keeps the pack's history, and a later `jevris pack install` starts again from a draft. `--cleanup` also deletes `<data>/packs/<id>`. It asks on a terminal; without one it needs `--yes`, otherwise it prints "Nothing was changed." and exits 2. An id that was never installed is refused with `PACK_UNKNOWN`.

## Executable components

An executable component runs only in the active, signed and allowlisted version, and only with its pinned hash. It runs as a separate `node --permission` process:

- it can read only its own version folder, and write only its data folder when it declares that;
- it gets no child processes, workers, addons, WASI or network;
- its environment is empty, except what Windows needs to start Node;
- it has a timeout and a 64 KiB answer cap.

Only the actions the manifest declares are kept. Node below 25 cannot deny network access under the permission model, so executables never run there (`ISOLATION_UNAVAILABLE`).

## Exit codes

`0` done; `1` a check failed (fixtures failed, canary regression); `2` a usage error or a refusal, with the reason code printed. `--json` prints one document. A refusal is `{ "ok": false, "reasonCode": ..., "detail": ... }`. See [cli.md](cli.md#jevris-pack) for every flag.
