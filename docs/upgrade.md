# Upgrade, downgrade and uninstall

## Upgrade

Run the install of the version you want. It replaces the previous install in one operation.

1.2.0 is a release candidate and is not on the npm registry yet, so until the release, upgrade from your checkout (see [installation.md](installation.md#install-from-a-checkout-until-the-release)):

```sh
git pull
npm ci --ignore-scripts
npm rebuild esbuild
npm run build
node bin/jevris.mjs install --dry-run    # see what changes
node bin/jevris.mjs install --yes
jevris doctor
```

After the release:

```sh
npx @webventures/jevris@latest install --dry-run    # see what changes
npx @webventures/jevris@latest install --yes
jevris doctor
```

With a global install (after the release), `npm i -g @webventures/jevris@latest` first, then `jevris install --yes`. The `jevris` launcher that install writes moves to the new runtime on each install. Updating the global package alone does not move your harnesses: they keep running the runtime copy they were installed with until you run `install` again.

What `install` does on an upgrade:

1. Copies the new runtime to `<data>/runtime/<new version>/`.
2. Removes the previous version's registrations in each harness, using its install receipt, and writes the new ones pointing at the new runtime. A v1.0 or v1.1 install is recognised and cleaned up the same way.
3. Runs a smoke check through the installed files: an MCP handshake and a hook fixture per harness.
4. On any failure, restores every file it touched and removes the new runtime copy. Your harnesses are left on the old version.
5. On success, deletes runtime copies that no install receipt points at any more.

The first time a new version's sidecar opens the decision store, it applies any schema migrations (see below).

A running sidecar keeps the code it started with, even when you reinstall the same version. Install compares its build with the runtime it just installed. The comparison uses a build id, a hash of the runtime's bundle manifest, not the version string. When the builds differ, install prints one `sidecar build:` line:
- A sidecar with no verification run under way is stopped with a graceful shutdown (in-flight requests finish first), and install starts the installed build at once (on the same socket path; a Windows pipe gets a new name at every start), so the first hooks after the install are answered and do not run rules-only. Install starts a sidecar only if one was running before, and not when `JEVRIS_SIDECAR_AUTOSTART=0` is set (the line then says `jevris sidecar start`). If the start fails, install still succeeds and the line names the reason code; the next hook or `jevris sidecar start` starts it.
- A sidecar with a verification run under way is left to finish it. It then restarts itself on the installed build.
- A sidecar under `jevris service install` restarts itself once idle, and its service manager starts the new build. Install never starts a second, unsupervised sidecar next to it. To move it to the new build at once, run `jevris sidecar restart`: it stops the sidecar cleanly and the service manager starts it again. A sidecar from before build ids cannot retire itself; `jevris service install` stops it (it is the service's own) and the service manager starts it again, on macOS, Linux and Windows.

`jevris doctor` flags a sidecar still on an older build, with the fix `jevris sidecar restart`.

After the release, pre-release versions are published under the `next` tag: `npx @webventures/jevris@next install --yes`.

## When a harness upgrades

Upgrading Claude Code, Codex, Kilo, OpenCode or Antigravity needs nothing from you. A certification record covers a range of harness versions. When a version is outside every record's range, `jevris doctor`, the sidecar's start or the next SessionStart re-checks that harness in the background with no model call, and a pass extends the certification. Upgrading Jevris itself works the same way: a record written before a feature this version certifies (owned workers, `worker.route`; the harness model listing, `models.list`, for every harness but Claude Code) is re-checked once. Until then, only actuation of the uncovered features waits; observation and advice go on. See [troubleshooting.md](troubleshooting.md#a-harness-was-upgraded).

## Downgrade

Install the older version the same way. From a checkout, check out the older commit or tag, then build and install it:

```sh
git checkout <commit-or-tag>
npm ci --ignore-scripts
npm rebuild esbuild
npm run build
node bin/jevris.mjs install --yes
```

After the release, from npm:

```sh
npx @webventures/jevris@<version> install --yes
```

Files and harness registrations roll back cleanly. The decision store may not: an older Jevris never writes a store schema it does not understand. If a newer version migrated the store, the older version refuses it with `schema-newer`, and its sidecar runs rules-only until you restore a store it knows. `jevris doctor` and `jevris status` say so. To get the older version's decisions back, restore a backup taken before the upgrade, as described in [Store migrations](#store-migrations).

## Store migrations

The decision store is one SQLite file in the data folder (`jevris.db`). Its schema version is separate from the package version.

- Migrations run on open, one version at a time, each in its own transaction. A process killed mid-migration leaves the previous version intact, and the next open resumes.
- Two processes never migrate at once: a lock row serialises them.
- Before a migration that drops or rewrites data, Jevris writes a backup next to the database (`jevris.db.pre-v<N>-<time>.bak`).
- A changed or unknown migration refuses the open instead of guessing.
- Schema 6 adds the learning records (decision outcomes, session model changes, advice adherence and latency counters). It only adds tables, so no backup is written; an older Jevris then refuses the store with `schema-newer`.
- Schema 7 adds the decision feedback table (your accept or reject of a decision's advice, with a fixed reason). It also only adds a table.
- Schema 8 adds the hook records table: the sidecar's hook bookkeeping (loop signals, stop reminders and reports, restores, evidence selections and reads, subagent runs), which used to be one file per record under `<data>/orchestration/`. It only adds a table. Records already in those files stay there and age out as before.
- Schema 9 adds the provider consent table (one row per model provider you consented to: the consent text version, when you gave it, and when you revoked it). It only adds a table.
- Schema 10 adds the session link table, which records the task a Kilo or OpenCode session was started for, so per-turn switching can check the link. It also adds a column with the time each harness session was last seen, filled in from the start time for existing sessions. It adds only a table and a column.

To roll the store back after a downgrade:

1. Stop the sidecar: `jevris sidecar stop`.
2. Move `jevris.db` aside (keep it until you are sure).
3. Restore the `jevris.db.pre-v<N>-<time>.bak` backup, or a backup you took yourself, as described in [configuration.md](configuration.md#the-store).
4. Run the older Jevris.

## Uninstall

```sh
jevris uninstall --dry-run      # what would be removed
jevris uninstall                # keeps your Jevris data (the default, --keep-data)
```

Use `--harness <name>` to remove Jevris from one harness only. Uninstall removes only what Jevris added:

- Jevris keys are taken out of shared config files, and the rest of each file is restored byte for byte, including your edits made after the install.
- A Jevris-owned file that you changed after the install is reported and left in place for you to decide.
- The runtime copy is removed once no harness uses it.
- The `jevris` command goes with the last harness: the launcher (`~/.local/bin/jevris`, or `%LOCALAPPDATA%\Jevris\bin\jevris.cmd` and that folder when it is empty), the marked PATH block in your shell profile, and the folder install added to your Windows user PATH. Uninstalling one harness while others stay keeps them. Each is removed only when its marker or the install receipt proves it is Jevris's own. A folder install created for them (such as `~/.local/bin`) goes only when it is empty; one that was there before install is never removed. A `jevris` that is not Jevris's own, or a PATH block you edited by hand, is left in place and named in a `next:` line.

`--keep-data` keeps the decision store, receipts, logs and packs, so a later install picks up where you left off. `--delete-data` also deletes them.

## Delete your data

```sh
jevris uninstall                # first: take Jevris out of every harness
jevris data delete              # then: delete the data and state folders
```

Both stop the sidecar first, and refuse if it will not stop (`data delete` answers `SIDECAR_RUNNING`). With a `--home` that is not your account's own home, the per-user service is left alone, and the next step names `jevris service uninstall --home <home>`. While the kill switch is stopped, `data delete` deletes nothing (`KILL_SWITCH_ACTIVE`): run `jevris kill-switch clear` first. `jevris data delete --dry-run` lists what would go and changes nothing.

Order matters. `data delete` removes the runtime copy along with the data, so a harness still registered would point at files that are gone. Uninstall first (or run `jevris uninstall --delete-data`, which does both in the right order).

`data delete` removes the data folder (the store, receipts, packs, certifications, route learning and the runtime copy) and, on Linux, the separate state folder, plus a pre-1.2 `~/.jevris` on Linux and Windows if one is left. It also removes the kill switch's files. It refuses a symlinked or foreign folder instead of following it. `--scope` narrows or widens what goes: a comma list of `ledger`, `capsules`, `learning`, `config`, `credential`, `data` (the default) or `all` (the data folder, the config folder and the Jev key). Without `--scope config` or `all`, it leaves the config folder (settings, host and organization policy), which you can remove yourself:

| | Config folder |
| --- | --- |
| macOS, Linux | `~/.config/jevris` (or `$XDG_CONFIG_HOME/jevris`) |
| Windows | `%APPDATA%\Jevris` |

It also leaves the Jev key in the OS keychain unless the scope names `credential` or `all`; `jevris credential clear` removes it. Deleting local data does not delete anything held by the Jev vendor under its own retention terms; see [privacy.md](privacy.md).

## Remove the command

The launcher install wrote is removed by `jevris uninstall` (see above). A checkout is yours to delete once you have uninstalled; the harnesses never ran from it. For a global npm install (after the release):

```sh
npm rm -g @webventures/jevris      # a global install
npm cache clean --force             # optional: drop npx's cached copy
```

Neither affects installed harnesses: remove those with `jevris uninstall` first.
