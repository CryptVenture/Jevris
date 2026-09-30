# Installation

Jevris is one npm package, [`@webventures/jevris`](https://www.npmjs.com/package/@webventures/jevris). Version 1.2.0 is a release candidate and is not on the npm registry yet: its release gates have not passed (see [RELEASING.md](../RELEASING.md)). Until the release, install from a checkout, as in [Install from a checkout](#install-from-a-checkout-until-the-release). After the release, it installs into your coding harnesses from the npm registry: no clone, no build, no compiler.

## Before you start

| Requirement | Detail |
| --- | --- |
| Node.js | `^22.14.0 \|\| >=23.6.0`. Jevris checks Node-API 10 before it loads anything; an older Node exits 2 with one line naming the version it needs. Check with `node --version`. |
| Operating system | macOS, Linux or Windows, on x64 or arm64. |
| npm | The one that ships with your Node. Until the release, `npm ci` and `npm run build` in a checkout; after the release, `npx` and `npm i -g` both work. |
| git | Until the release, to clone the repository. |
| A coding harness | Claude Code, Kilocode, Codex, OpenCode or Antigravity. Jevris installs into all five by default; a harness you do not use simply gets files it never reads, and `--harness` limits the install to one. Each harness may be signed in with a subscription or with an API key; both work (see [routing.md](routing.md#harness-sign-in-subscription-or-api-key)). |
| A Jev key (optional) | Without one Jevris runs rules-only. See [Store the Jev key](#store-the-jev-key). |

Which harness versions and operating systems are *certified* for more than observing is in [platform-support.md](platform-support.md).

## Install from a checkout (until the release)

```sh
git clone https://github.com/CryptVenture/Jevris.git
cd Jevris
npm ci --ignore-scripts   # prebuilt native modules: no C++ toolchain needed
npm rebuild esbuild       # the one install script a dependency needs
npm run build
node bin/jevris.mjs --version
node bin/jevris.mjs install --dry-run
node bin/jevris.mjs install --yes      # also writes the jevris command (see below)
jevris doctor
```

The build needs no compiler: the native modules ship prebuilt. `node bin/jevris.mjs install` behaves exactly like the npx install below: the same plan and prompt, `--harness` to install into one harness, the certification that follows, and the `jevris` command it writes. The installed harnesses run from the runtime copy in the Jevris data folder, not from the checkout, so you can move or delete the checkout afterwards. To upgrade, pull and repeat the build and install (see [upgrade.md](upgrade.md#upgrade)).

## Install with npx (after the release)

These steps work once 1.2.0 is on the npm registry.

```sh
npx @webventures/jevris install --dry-run
```

`--dry-run` prints every file Jevris would create, edit or remove, per harness, and changes nothing. When the plan looks right:

```sh
npx @webventures/jevris install --yes
```

Without `--dry-run` or `--yes`, an interactive terminal prints the plan and asks `Apply these changes? [y/N]`; a no changes nothing and exits 2. A non-interactive run (a script, CI) prints the plan, changes nothing and exits 0, with a last line telling you to re-run with `--yes`.

One harness only:

```sh
npx @webventures/jevris install --harness claude --yes      # claude | kilo | codex | opencode | antigravity
```

After a successful install, Jevris certifies each harness it installed, exactly as `jevris certify --harness all` does. This calls no model provider, and each harness runs in a throwaway profile. For Claude Code, Codex, Kilo and OpenCode, certify also runs a few short turns against a stub provider that Jevris starts on 127.0.0.1 with a dummy key, so the harness's model requests never leave your machine and nothing is billed. They check, among other things, whether a hook can route a subagent to another model, and whether a run's hooks report the model it actually ran on. For Codex, the probe hooks are passed for that one run with `--dangerously-bypass-hook-trust`, or for the one `codex app-server` thread with its `bypass_hook_trust` setting, so nothing is added to Codex's hook trust. These `stub case` lines are reported only, with one exception: Codex's `hooks.route` is certified only when its `codex.subagent-route` case passes. That case runs a turn in `codex app-server` with approval policy `on-request` and the read-only sandbox. A probe hook gives the parent's `spawn_agent` call the exact answer the installed Codex adapter renders for a route. The case passes only when the subagent then runs on the routed model, its request to write outside the sandbox still reaches Codex's approval prompt, and the write, declined, does not happen. Antigravity has no setting for another endpoint, so it has no such turn. A `certify <harness>:` line reports each result. A harness that does not certify never fails the install: its line names the reason and the `jevris certify --harness <name>` command that fixes it. `--no-certify` skips this step. Doctor then shows each certified harness straight away. Antigravity's hooks are written switched off until a certification record covers your Antigravity version. So when this step certifies Antigravity, the install switches its hooks on in the same run and prints `antigravity hooks: enabled (certified in this run)`. If they stay off, the line says so and names `jevris install --harness antigravity`. Claude Code's `StopFailure` hook, which notices when an account runs out, works the same way: it is registered only once a record certifies `access.session` for your Claude Code version. When this step certifies it, the install registers it in the same run and prints `claude hooks: StopFailure registered (certified in this run)`.

If a sidecar is already running an older build, install moves it onto the new one. With no verification run under way it stops the sidecar gracefully and starts the installed build at once (on the same socket path; a Windows pipe gets a new name at every start), so the first hooks after the install are answered. A sidecar that was not running is not started, a supervised one is restarted by its service, and `JEVRIS_SIDECAR_AUTOSTART=0` starts nothing. A `sidecar build:` line says which; if the start fails, install still succeeds and the line names the reason code.

Jevris also reads which sign-in each harness uses for owned workers, the way doctor does. It reads the mode only, never a key or token:

- Claude Code: from `claude auth status --json`.
- Codex: from `codex login status`.
- Kilo and OpenCode: from `kilo auth list` and `opencode auth list`. A stored OAuth login counts as a subscription, and stored keys only as an API key. An Anthropic OAuth login does not count, because a Claude subscription runs only in Claude Code.
- Antigravity: always its Google sign-in.

If nothing can be detected, and `workers.json` does not state the mode, an interactive terminal asks once per harness and records your answer in `<config>/workers.json`. That file always overrides detection.

The install ends with `next:` lines, only for steps Jevris cannot take for you:

- restart Claude Code, then check `/plugin` and `/hooks`;
- start Codex and run `/hooks` to review and trust the Jevris hooks;
- any harness command that failed or was not found, such as `codex plugin add` or `agy plugin install`.

### The `jevris` command

Install also gives you a `jevris` command, however you installed (npx, a source checkout or a global npm install). It is a small launcher that runs the installed runtime copy with the Node.js that ran install:

| | Launcher |
| --- | --- |
| macOS, Linux | `~/.local/bin/jevris` (a `sh` script, mode 0755) |
| Windows | `%LOCALAPPDATA%\Jevris\bin\jevris.cmd` (PowerShell and Command Prompt both run it) |

- An upgrade points it at the new runtime. If that Node.js is later removed, `jevris` says so and names the reinstall command instead of failing silently.
- The launcher carries a marker line. Install never overwrites a `jevris` there that is not Jevris's own; it leaves it and says so.
- If `jevris` on your PATH already runs something else, such as a global npm install, install leaves it alone and says which one runs.
- If the launcher's folder is not on your PATH, an interactive install asks once: `Add ~/.local/bin to your PATH in ~/.zprofile? [y/N]`. A yes appends one marked block (`# >>> jevris PATH >>>` ... `# <<< jevris PATH <<<`) to your shell's profile: `~/.zprofile` for zsh, `~/.bash_profile` (or `~/.profile` when there is none) for bash, `~/.config/fish/conf.d/jevris.fish` for fish, and `~/.profile` otherwise. On Windows the question adds the folder to your user PATH (`HKCU\Environment`); it is asked only when Jevris uses your own home, not a `--home` or `JEVRIS_HOME`. Open a new terminal afterwards.
- Without a terminal, or after a no, install prints the exact line to add instead, and never edits a profile. A no is remembered, so the question is not asked again.

`jevris doctor` shows `jevris command: on PATH (<path>)`, which other `jevris` runs first, or `not on PATH:` with the line to add. `jevris uninstall` removes the launcher, the marked block and the user PATH entry (see [upgrade.md](upgrade.md#uninstall)).

Then check the result:

```sh
jevris doctor              # or, after the release: npx @webventures/jevris doctor
```

In a terminal, each doctor line is marked `✓` (works), `i` (information, nothing to do), `!` (a problem you can fix; the line names the command) or `✗` (something failed). See [troubleshooting.md](troubleshooting.md#reading-the-doctor).

## Install globally (after the release)

```sh
npm i -g @webventures/jevris
jevris install --dry-run
jevris install --yes
jevris doctor
```

A global install gives you the `jevris` command through npm. Install writes its own launcher as well (see [The `jevris` command](#the-jevris-command)); when the npm one comes first on your PATH, install leaves it and says so. Neither is needed for the harness integrations, which run from the runtime copy described below.

## Where Jevris puts files

`--home` defaults to `JEVRIS_HOME`, then to your home directory. Every command prints the home it resolved. Under that home:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Config (settings, host and organization policy, kill switch, calibration release) | `~/.config/jevris` | `$XDG_CONFIG_HOME/jevris` (default `~/.config/jevris`) | `%APPDATA%\Jevris` |
| Data (decision store, receipts, packs, install receipts, backups, runtime copy) | `~/.jevris` | `$XDG_DATA_HOME/jevris` (default `~/.local/share/jevris`) | `%LOCALAPPDATA%\Jevris` |
| State (logs) | `~/.jevris` | `$XDG_STATE_HOME/jevris` (default `~/.local/state/jevris`) | `%LOCALAPPDATA%\Jevris\state` |
| Sidecar socket or pipe endpoint | `~/.jevris/run` | `<state>/run` | `%LOCALAPPDATA%\Jevris\run` |

The XDG and `%APPDATA%` variables apply only when Jevris uses your own home. With `--home` or `JEVRIS_HOME` set, the same sub-paths are used under that directory, so nothing is written outside it. Files and directories Jevris creates are readable by you only (mode 0600 and 0700 on macOS and Linux, your user's ACL on Windows).

### The runtime copy

`install` copies the package's runtime (the bundled `dist/` files, the plugin files and the three runtime dependencies) to `<data>/runtime/<version>/` and points every harness registration there. So:

- Clearing the npm or npx cache never breaks an installed harness.
- Upgrading installs a new version beside the old one and moves the pointers in one step; the old copy is removed once nothing points at it. See [upgrade.md](upgrade.md).
- Hooks call `node` with an absolute path inside the runtime copy. They never call `npx` and never reach the network to start.

### What install changes in each harness

Each harness gets its plugin or extension files, an MCP server registration, the Jevris skills and, where the harness supports them, hook registrations. The package ships one source for all of them, and install renders each harness's files from it into your home: the nine skills come from `plugins/shared/skills`, every harness runs the one hook entry `dist/hook.mjs` and the one MCP server `plugins/shared/mcp.js` inside the runtime copy, and Kilo Code and OpenCode get their plugin file from one template. Claude Code, for example, gets a local plugin marketplace at `~/.claude/plugins/jevris-local`, built from the manifests in `plugins/claude` (`.claude-plugin/plugin.json`, `hooks/hooks.json` and `.mcp.json`) and the rendered skills. Shared config files (such as `~/.claude/settings.json`, `~/.codex/config.toml` or an OpenCode `opencode.json`) are edited in place: only the Jevris keys change, and every other byte, comment and key order is kept. Before a file changes it is backed up under `<data>/backups/` (the last five sets are kept), and if any step or the post-install smoke check fails every touched file is restored.

Where a harness has its own plugin command, install runs it too: `claude plugin marketplace add` and `claude plugin install` for Claude Code, `codex plugin add` for Codex and `agy plugin install` for Antigravity. When the harness binary is not found, or the command fails, a `next:` line gives the command to run yourself. Uninstall runs the matching remove commands.

`jevris install --dry-run --harness <name>` lists every file and key that would change for one harness, and changes nothing. After installing, `jevris doctor --harness <name>` shows what that harness supports on this machine. Each harness has its own guide: [Claude Code](harnesses/claude-code.md), [Codex](harnesses/codex.md), [Kilo Code](harnesses/kilocode.md), [OpenCode](harnesses/opencode.md) and [Antigravity](harnesses/antigravity.md); [the parity matrix](harnesses/parity-matrix.md) compares them.

Hooks run in observe mode unless a signed certification record covers that harness, its version and your OS; where one does, they act only as far as `mode` allows (default `bounded-auto`). They make no permission decision for you, except that a certified Codex subagent route answers `allow` on the `spawn_agent` call it rewrites (see [security.md](security.md)). `doctor` tells you what is certified on this machine.

## Store the Jev key

Jevris reads the key from standard input and stores it in the OS keychain: the macOS Keychain, Windows Credential Manager or the Linux Secret Service. It never takes the key as an argument, and never writes it to a file or a log.

```sh
jevris credential set           # prompts without echo; or pipe it: printf '%s' "$KEY" | jevris credential set
jevris credential status        # stored or not, never the key itself
jevris credential clear
```

Only the local Jevris sidecar reads the key. Without a key, or when the keychain is unavailable (for example a Linux server with no Secret Service), Jevris keeps working rules-only. See [troubleshooting.md](troubleshooting.md#the-keychain-is-unavailable). On headless Linux, CI or WSL you can opt in to an owner-only key file or a systemd credential instead; see [security.md](security.md#the-jev-key).

The Jev key is only for Jevris's own decisions. Your harnesses keep their own sign-in.

## Windows

- Use Node from nodejs.org, winget (`winget install OpenJS.NodeJS.LTS`) or a version manager such as fnm or nvm-windows. Node 22.14.0 or later.
- After the release, PowerShell may block `npx.ps1` under a restricted execution policy. Run `npx.cmd @webventures/jevris ...` instead, or use Command Prompt. From a checkout, `node bin\jevris.mjs` works in both.
- Config is under `%APPDATA%\Jevris`, data under `%LOCALAPPDATA%\Jevris`. Roaming profiles carry only the config.
- The sidecar listens on a named pipe that only your user can open. Its name is random per start and is recorded in an owner-checked file under `%LOCALAPPDATA%\Jevris\run`.
- The Jev key goes to Windows Credential Manager under your account.
- Harness commands installed as `.cmd` shims (for example `codex.cmd`) are found through `PATHEXT` and run without a shell interpreting your arguments.

More in [troubleshooting.md](troubleshooting.md#windows).

## Install from source

For contributors, or to try an unreleased commit, use the steps in [Install from a checkout](#install-from-a-checkout-until-the-release) on the commit you want.

To test exactly what npm would publish, pack and install the tarball into a scratch prefix:

```sh
npm pack
npm i -g --prefix <scratch-dir> ./webventures-jevris-<version>.tgz
```

`npm run smoke:pack` does this end to end under a temporary home and prefix. See [development.md](development.md) and [testing.md](testing.md).

## Next

- [Upgrade, downgrade and uninstall](upgrade.md)
- [Troubleshooting](troubleshooting.md)
- [CLI reference](cli.md)
- [Settings](settings.md)
- [Model routing, route learning and owned workers](routing.md)
