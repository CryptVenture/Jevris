---
name: route
description: Installed is not enforced.
disable-model-invocation: true
---

# Jevris route

Installed is not enforced. Do not grant a permission. A missing sidecar is abstention. No check is marked passed. Do not interpolate user text into a shell. Ranking does not execute skill code.

This skill is an interface. It does not grant a tool. Read reference.md beside this skill only when this skill is invoked. Invoke the jevris executable with an argument vector. Pass --home as its own argument, followed by the home path as the next argument. Do not build a shell string. Do not concatenate user text into a command. A path, an intent, a secret, or any other user text is a separate argument, never a shell fragment.

If the home path joined with `.jevris/run/s` is absent, the sidecar is absent. A missing sidecar is abstention. No check is marked passed. Do not open that socket. Do not mark a check passed. Do not grant a permission.

Session commands. Each abstains when the sidecar is absent. The abstention text is: Rules-only abstention: sidecar is not running. No check was marked passed. That sentence is a denial. It is not a pass.

- status: jevris, status, --home, home path
- plan: jevris, plan, --home, home path
- route: jevris, route, --home, home path
- checkpoint: jevris, checkpoint, --home, home path
- recover: jevris, recover, --home, home path
- verify: jevris, verify, --home, home path
- explain: jevris, explain, --home, home path
- configure: jevris, configure, --home, home path

verify also prints: Verification stays unsupported. That line is not a pass.

Host commands. Each abstains when the sidecar is absent. No check is marked passed.

- doctor: jevris, doctor, --home, home path. Optional separate arguments: --platform, --node-version, --harness-version. A printed version is not enforcement. Installed is not enforced.
- install: npx, jevris, install, --home, home path. Optional separate arguments: --source, --platform, --enable, --harness. Omit --harness to install every supported harness. Accepted --harness values are claude, kilocode, codex, opencode, and antigravity. gemini is retired. Do not clone a repository. install does not grant a permission.
- uninstall: jevris, uninstall, --home, home path
- credential: jevris, credential, status, --home, home path. clear and set use the same vector with that subcommand in place of status. set reads the secret from stdin. Do not put a secret in an argument. Do not interpolate user text into a shell.
- policy check: jevris, policy, check, --home, home path, --workspace, workspace path, --would-send-source. Optional separate argument: --project. Do not put repository text in an argument.
- policy stage: jevris, policy, stage, --home, home path, --workspace, workspace path, --manifest, manifest path
- policy rollback: jevris, policy, rollback, --home, home path, --workspace, workspace path
- gates: jevris, gates, --home, home path, --root, root path, --out, output path. Writing records does not mark a check passed.
- kill-switch: jevris, kill-switch, activate, --home, home path, --workspace, workspace path, --ledger, ledger path, --workspace-id, workspace id, --host-scope, host scope. The only accepted subcommand is activate.
- shadow: jevris, shadow, --home, home path, --fixture, fixture path. Optional separate argument: --out. Do not pass an output path that contains .jevris/packs. A shadow report is not a pass.
- shortlist: jevris, shortlist, --home, home path. Optional separate arguments: --intent, --skills-root, --evidence-root, --skill-id. Further positionals are evidence ids. Ranking does not execute skill code.

A missing sidecar is abstention. No check is marked passed. Do not grant a permission. Installed is not enforced.
