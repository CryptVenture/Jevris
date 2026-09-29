# Remediation: an earlier install replaced `~/.codex/hooks.json`

This page is for anyone who ran `jevris install` from a build before v1.2. Versions before 1.2 were never published to npm, so it applies only if you ran an early build from source. Those installs could damage shared harness configuration. The main case is `~/.codex/hooks.json`: the old installer replaced the whole file with Jevris-only handlers. That removed hooks other tools had registered, such as GSD's `SessionStart` and `PostToolUse` hooks.

v1.2 edits shared files in place and restores them byte for byte on uninstall (see [installation.md](installation.md#what-install-changes-in-each-harness)). Upgrading does not repair damage an earlier install already did. Follow the steps below once, by hand.

## 1. Check whether you are affected

```bash
cat ~/.codex/hooks.json
ls ~/.jevris/
```

You are affected if either of these is true:

- `hooks.json` contains handlers whose command is `node ".codex/hooks/jevris.js"`. That path is relative, so it fails in every project. The file it points to has no entry point either.
- `~/.jevris/codex-install-receipt.json` (or `*-interface-receipt.json`) has `"schemaVersion": "1.0"` and lists `~/.codex/hooks.json` under `ownedPaths`.

## 2. Back up first

Copy every shared file and every receipt before you change anything:

```bash
stamp=$(date +%Y%m%d-%H%M%S)
for f in ~/.codex/hooks.json ~/.codex/config.toml \
         ~/.agents/plugins/marketplace.json \
         ~/.config/kilo/kilo.json ~/.config/kilo/kilo.jsonc \
         ~/.config/opencode/opencode.json ~/.config/opencode/opencode.jsonc \
         ~/.gemini/config/mcp_config.json; do
  [ -f "$f" ] && cp -p "$f" "$f.pre-remediation-$stamp.bak"
done
mkdir -p ~/jevris-receipts-$stamp && cp -p ~/.jevris/*receipt*.json ~/jevris-receipts-$stamp/ 2>/dev/null
```

These backups can contain secrets, for example environment values in `config.toml`. Delete them once you have checked the result.

## 3. Repair `~/.codex/hooks.json`

Do not delete the file, and do not hand-write another tool's hooks. The repair has three steps:

1. Remove only the Jevris handlers. Those are handlers whose command mentions `jevris.js`. Also drop any group or event left empty.
2. Re-register the hooks the other tool owns, using that tool's own installer.
3. Check the result.

For GSD, its own registration functions live in `~/.codex/gsd-core/bin/lib/runtime-hooks-surface.cjs`:

- `ensureCodexHooksJsonSessionStart(codexHome, { absoluteRunner })` registers `SessionStart` for `hooks/gsd-check-update.js`.
- `ensureCodexHooksJsonEvent(codexHome, 'PostToolUse', { absoluteRunner })` registers `PostToolUse` for `hooks/gsd-context-monitor.js`.

`absoluteRunner` is the JSON-quoted absolute path of your `node` binary, for example `JSON.stringify(process.execPath)`.

Jevris ships no repair script for this. A small script of your own can do it:

- copy `hooks.json` to `hooks.json.jevris-broken-<date>.bak`
- filter out the handlers matching `jevris.js` and drop emptied groups and events
- write the file back with two-space indentation
- call the two GSD functions above and print the result

Read it before you run it. Alternatively, re-running GSD's own Codex install does the same re-registration.

Then check:

```bash
node -e "const h=require(process.env.HOME+'/.codex/hooks.json').hooks; for (const [e,g] of Object.entries(h)) console.log(e, g.flatMap(x=>x.hooks).map(x=>x.command).join(' | '))"
```

You should see GSD's handlers, and no `.codex/hooks/jevris.js`.

## 4. Remove or upgrade the old Jevris install

**Do not use a pre-1.2 build to run `jevris uninstall --harness codex` against its own receipt.** That version treated `~/.codex/hooks.json` as a Jevris-owned file and deleted it.

From v1.2, a legacy v1 receipt is handled conservatively:

- Known shared files only have their Jevris entries stripped, and are never deleted:
  - `hooks.json`
  - `config.toml` (the `[mcp_servers.jevris]` table)
  - `marketplace.json` (the `jevris` plugin entry)
  - `kilo.json[c]` and `opencode.json[c]` (`mcp.jevris`)
  - `mcp_config.json` (`mcpServers.jevris`)
  - Claude Code's `settings.json` (only the old `enabledPlugins` key for Jevris)
- Any other file the old receipt lists is removed only when it carries a Jevris signature. A `package.json` is removed only when it is exactly the module-type marker Jevris wrote.
- A folder the old receipt lists is removed only when it holds a Jevris plugin manifest, or is the old Jevris hook runtime.
- Everything else the old receipt listed stays in place, and the command says so.

So with v1.2 you can run either command safely (until the release, run `node bin/jevris.mjs` from a checkout instead of `npx @cryptventure/jevris`):

```bash
npx @cryptventure/jevris uninstall             # remove everything
npx @cryptventure/jevris install --yes         # or reinstall: the old install is removed first
```

## 5. Leftovers to check by hand

A v1 install also wrote to directories that are shared with other tools. v1.2 may leave these in place, because it cannot always prove they are Jevris's own. Check each one. Remove it only if nothing else uses it.

| Path | Note |
| --- | --- |
| `~/.codex/hooks/run.js`, `~/.codex/hooks/operator-frame.js`, `~/.codex/hooks/vendor/` | Jevris hook runtime copied into Codex's shared hooks folder. GSD's own files there (`gsd-*.js`, `managed-hooks-registry.cjs`, `package.json` with `"type":"commonjs"`) must stay. |
| `~/.kilo/bin/` | The old Kilo runtime location. v1.2 runs every harness from the runtime copy in the Jevris data folder (see [installation.md](installation.md#the-runtime-copy)). |
| `~/.config/opencode/bin/` | The old OpenCode runtime location. v1.2 uses the same runtime copy. |
| `~/.config/kilo/plugin/package.json` | The old install could write a module-type marker here. Kilo's shared plugin folder may need its own; if another plugin relies on it, keep it. |
| `~/.kilo/skills/{status,checkpoint,route}`, `~/.config/opencode/skills/{status,checkpoint,route}` | Skill folder names without a namespace. Remove them only if their `SKILL.md` is the Jevris one. |

If you ran the test suite of a pre-v1.2 build, look also for top-level folders named `~/.j16*`, `~/.j17*` and `~/.j21*`. Its sidecar tests could leave them in the real home. The v1.2 test runner uses a temporary home and fails if a run touches the real one. Those folders contain only test data. You can delete them after a look.

## 6. What changed so this cannot happen again

- The installer never overwrites, reformats or deletes a file it does not own.
- Codex hooks are absolute, work from any directory, and have a Windows form.
- Tests run against a temporary home, never the real one. They never open the OS keychain and never start a real harness binary.
