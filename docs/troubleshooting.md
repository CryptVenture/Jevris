# Troubleshooting

Start with the doctor. It checks Node, the sidecar, the store, the keychain, egress, and each harness: the binary version, the installed files, the MCP handshake, a hook fixture through the installed command, managed policy and certification. It names a fix for every problem it finds.

```sh
jevris doctor                   # all harnesses
jevris doctor --harness codex   # one
jevris doctor --json            # for a bug report; it contains no secrets and no source
jevris status                   # mode, sidecar state and why it is degraded, if it is
```

### Reading the doctor

In a terminal, each doctor line starts with a mark. Only `!` and `✗` need you:

| Mark | Meaning |
| --- | --- |
| `✓` | Works. |
| `i` | A fact, or a limit by design (for example a harness's `parity` line). Nothing to do. |
| `!` | A problem you can fix. The line names the command. |
| `✗` | Something is damaged or failing, such as a failed MCP handshake or hook fixture. |

A terminal that is not UTF-8 shows `+` and `x` instead of `✓` and `✗`. The marks, colour and the Jevris logo appear only when the output is a terminal. A pipe, a file, `--json`, `--no-color`, `NO_COLOR`, `TERM=dumb` and `FORCE_COLOR=0` give plain text, and the words are the same either way.

`jevris doctor --json` prints one JSON document for a bug report or a script. Besides `report`, `harnesses`, `certifications`, `sidecar`, `auth` and `managedPolicies`, it has:

- `summary`: `installStatus`, `harnessProbe` and `eventProbe`;
- `lines`: every printed line with its `severity` (`ok`, `info`, `action`, `broken`, or `null` for a line that continues the one above);
- `privateFiles.loose`: any Jevris file or folder that other users could read, with its mode.

Each installed harness has a line that says whether a certification record covers it:

```text
harness claude: installed; ...; certified for <version range> (last verified <version>, <date>): plugin.install, mcp.tools, ...
harness claude: installed; ...; not certified: no signed record covers this version on this host; fix: jevris certify --harness claude
```

When every installed harness is covered, the `harnessProbe` and `installStatus` lines say so with each harness's range (`certified for <range>`), and Claude Code has a `claude.adapter` row like the other four harnesses.

Each harness Jevris can run an owned worker on also has an auth line: `subscription`, `api-key` or `unknown`, with where the mode came from (stated in `workers.json`, or `auto`) and what the harness reports. Antigravity signs in only with Google, so its line reads `harness antigravity auth: google sign-in (auto: always its Google sign-in; Antigravity refuses api-key)`; a stated `api-key` there is marked `!` with the fix.

A harness with a record also has a worker line, which says whether Jevris may start an owned worker there: `certified, pending first use`, `verified in use (N runs at <version>)`, `demoted: ...` or not certified with the fix. See [routing.md](routing.md#certification-of-worker-routing).

The `jevris command:` line says whether `jevris` on your PATH runs the launcher install wrote: `on PATH (<path>)`, which other `jevris` runs first (for example a global npm install), or `not on PATH:` with the line to add to your shell profile. See [installation.md](installation.md#the-jevris-command).

The egress lines follow `jevris egress status`. Until you approve source egress, the reason line is marked `i` (nothing leaves the machine by design) and names the fix:

```text
egressDecision: deny
egressReasonCode: EGRESS_NOT_APPROVED (nothing leaves this machine until you approve it; fix: run jevris egress approve (interactive))
```

When a managed or organization policy, an invalid `host.json`, or a policy file that breaks the rules on where an approval may live (a Jevris home or file inside a git work tree, a link, another owner, writable by others; see [privacy.md](privacy.md#approving-egress)) denies it, approving would not help, and the line points to `jevris egress status`, which says why. Once approved, the decision line reads `egressDecision: allow`.

`jevris certify --harness all` certifies every harness Jevris is installed in. After a harness upgrade you do not need to certify again: see [A harness was upgraded](#a-harness-was-upgraded).

The doctor's report has one line for the sidecar:

```text
sidecar: running; pid 4120, version 1.2.0, up 312 s, endpoint <socket or pipe>; store ok; kill switch clear
sidecar: idle; kill switch clear. The Jevris sidecar is idle. It starts on demand when a hook or command needs it, and stops again when idle.
sidecar: not-running; kill switch clear. The Jevris sidecar is not running, and autostart is off (JEVRIS_SIDECAR_AUTOSTART=0), so hooks and commands run rules-only until `jevris sidecar start`.
sidecar: not-running (degraded); kill switch clear. The Jevris sidecar's last run ended without cleaning up (a crash or a kill). ...
```

`idle` is normal: the sidecar stops when idle, and hooks and commands start it on demand. Not running because you set `JEVRIS_SIDECAR_AUTOSTART=0` is your choice, not a problem. It is marked degraded only when something is wrong: its last run ended without cleaning up, this install cannot start it, the kill switch is not clear, or its store is not usable. `foreign-locality` means the sidecar for this home runs in another environment (a container, WSL or another host): set `JEVRIS_HOME` to a folder inside this environment, or stop the other sidecar.

With `--json`, the same facts are in the `sidecar` object: `state`, `degraded`, `pid`, `version`, `uptimeMs`, `endpoint`, `store`, `killSwitch` and `message`.

Doctor reads the machine's access-limit record directly, without a sidecar, and prints what is paused in the words of `jevris route limits`:

```text
accessLimits: none in force
accessLimits: 2 in force, 1 untimed (jevris route limits lists them; clear one there at an interactive terminal)
accessLimit <class, scope, until when or how it clears, source>
```

`none in force` is `✓`. A count of timed pauses only is `i`, because each lifts by itself. An untimed pause (credit or a blocked account), or a record doctor could not read (`ACCESS_LIMITS_UNREADABLE`, which pauses nothing), is `!`. A full record adds an `accessLimits full` line. See [An account ran out, or its pauses look wrong](#an-account-ran-out-or-its-pauses-look-wrong).

A Codex usage reading (ChatGPT sign-in; see [routing.md](routing.md#what-jevris-notices-when-you-run-out)) adds one `accessUsage <harness> <sign-in>: ...` line per reading, with each window's band, whether it is weekly, and its reset. A used-up window, or usage Codex reports as not allowed, is `!`; anything else is `i`, including `ACCESS_USAGE_UNREADABLE`, which pauses and lifts nothing.

Doctor prints the effective `mode` and the layer that set it: the defaults, your `jevris.config.json`, or a ceiling in `organization.json`, `host.json` or the managed policy ([settings.md](settings.md#precedence)). Pass `--workspace <dir>` to include that repository's `.jevris/config.json`. The line is `i`. A problem with a file that caps the mode adds a `settings issue` line, marked `!`, with its fix:

```text
settings mode: observe (set by host.json (a ceiling))
settings issue: host: AUTHORITY_FILE_SHARED_WRITE; its ceiling still applies, but it grants nothing; make the file yours and owner-only (chmod 600)
```

A file refused as an authority (not yours, writable by others, inside a git repository) still caps the mode. A link, an unreadable file or one that does not match the host-policy contract, and a refused managed policy, cap it at `observe`. With `--json` the same facts are in the `settings` object: `mode`, `modeSource` and `issues`.

If the 1.2 upgrade moved your mode from `observe` (the old default) to `bounded-auto`, doctor and `jevris status` also print a `settings notice` line, marked `i`, until you run any `jevris configure set mode`, or for 30 days (`notice` in `--json`; `modeNotice` in the status result). See [settings.md](settings.md#modes).

Your own `jevris.config.json` shows as a `user:` issue when it is present but cannot be used (`INVALID_JSON`, `INVALID_CONFIG`, `UNREADABLE` or `NOT_REGULAR`). Jevris then ignores it and caps the mode at `observe`:

```text
settings mode: observe (set by your jevris.config.json)
settings issue: user: INVALID_JSON; your jevris.config.json cannot be used, so the mode is capped at observe; fix it by hand, or run jevris configure set mode off (or observe) to write a fresh one
```

`jevris configure set mode off` (or `observe`) moves the bad file aside to `jevris.config.json.invalid` and writes a fresh one; every other `configure set` is refused with `CONFIG_INVALID` until then. If that answers `CONFIG_DIR_REFUSED`, the config folder is a link, not yours, or its ACL cannot be set: make it a real folder you own and run it again. `CONFIG_WRITE_FAILED` means the fresh file could not be written (a full disk, say); nothing was changed and the mode stays capped at `observe`. See [settings.md](settings.md#your-file-cannot-be-used).

A command refused with `MODE_OFF` means Jevris is off: in off mode it makes no Jev call. Run `jevris configure set mode advise` (or another mode) at a terminal to turn it back on.

`Nothing was changed (CHANNEL_REFUSED): raising <key> to <value> widens what Jevris may do ...` means a `jevris configure set` would raise `mode`, `routing.managedWorkers` or `routing.mainSession`, and it did not come from a person at an interactive terminal. Run the same command yourself in a terminal, without `--yes` or `--json`, and answer `y`. Lowering needs no one. See [settings.md](settings.md#raising-what-jevris-may-do).

While the running sidecar has Jev turned off after a refused key, billing or account, doctor also prints its `jev: disabled for ...` line, marked `!`, with the command that clears it (see **degraded** below). Doctor asks only a sidecar that is already running: it never starts one and never reads the circuit file, so with no sidecar running there is no `jev` line.

## What the words mean

Jevris uses four words for "less than everything". None of them is an error in your code.

| Word | Meaning | What to do |
| --- | --- | --- |
| **refused** | Jevris declined a request for a safety reason, and nothing changed. Examples: a path outside the home, a symlink that escapes it, a config file that is not valid JSON, a missing administrator consent, a Jev key passed as an argument. The command exits 2. | Read the one-line reason; it names the input to fix. |
| **reduced** | It works, with less. `status` answers from local files because the sidecar is not running; an install is in place but not certified; a remote session (SSH, a container) is detected. | Nothing, unless you need the missing part. `jevris sidecar start` brings `status` back to full. |
| **unsupported** | This capability is not certified for this harness, harness version and operating system, so Jevris only observes and advises there. It never changes what the harness does. | See [platform-support.md](platform-support.md). A harness version outside a certified range is unsupported until a record covers it. |
| **degraded** | Decisions are running rules-only: no Jev key, the keychain is unavailable, the store did not open, the decision budget is spent, or the provider is failing and its circuit is open. | `jevris status` gives the reason; the sections below cover each. The circuit stays open for the provider's `Retry-After`, at most 15 minutes. A refused key, a billing failure or a forbidden account (HTTP 401, 402 or 403 from Jev) turns Jev calls off: status and doctor say `jev: disabled for billing (PROVIDER_BILLING)`, `disabled for the account (PROVIDER_DISABLED)` or `disabled for its API key (PROVIDER_DISABLED)`. After fixing billing or the account, run `jevris credential reenable` at a terminal: it asks once, calls nothing, and needs the running sidecar; Jevris then observes first and acts again after the usual successful calls. A refused key (401) clears only with a new key, `jevris credential set` (`reenable` answers `AUTH_NEEDS_NEW_KEY`). |

Your harness keeps working in every one of these states. Jevris failing never blocks a tool call on its own: when the sidecar is unreachable or late, the hook answers "observe" and the harness decides as it normally would.

## Node is too old

```text
jevris needs Node ^22.14.0 || >=23.6.0 (N-API 10 or later). This is Node v20.11.1 with N-API 9.
```

Jevris's native modules (better-sqlite3 and the keychain binding) need Node-API 10. Install Node 22.14.0 or later (22 LTS, 24 LTS or a current release) and run the command again. With a version manager, check that the shell your harness starts uses the same Node: harness hooks run the `node` on the harness's `PATH`.

## A native module does not load

```text
jevris: the OS keyring binding could not be loaded. Jevris continues rules-only: ...
```

The prebuilt binary for your platform did not load. Usually the Node version changed after install (for example a version manager switched to another major). Reinstall under the Node you use: from a checkout, `node bin/jevris.mjs install --yes`; after the release, `npm i -g @webventures/jevris` or `npx @webventures/jevris@latest install --yes`. The tested platforms are x64 and arm64 on macOS, Windows and glibc Linux ([platform-support.md](platform-support.md)); on anything else, such as Alpine Linux (musl), a prebuilt binary may be missing.

## The keychain is unavailable

`jevris credential set` or `status` reports that the keychain cannot be reached, and decisions run rules-only.

- **Linux over SSH, in a container or on a server.** The Jev key lives in the Secret Service (GNOME Keyring or KWallet), which needs a D-Bus session and an unlocked keyring. A headless session usually has neither. Either run Jevris from a desktop session, or start one for the shell:

  ```sh
  sudo apt-get install gnome-keyring dbus-user-session     # Debian and Ubuntu
  dbus-run-session -- sh -c 'printf "%s" "$KEYRING_PASSWORD" | gnome-keyring-daemon --unlock >/dev/null; jevris credential set'
  ```

  The key is then readable only inside a session with that keyring unlocked. Where no keyring can run (headless Linux, CI, WSL), you can instead name an owner-only key file or a systemd credential with `JEVRIS_CREDENTIAL_FILE` or `JEVRIS_CREDENTIAL_SYSTEMD`; see [security.md](security.md#the-jev-key). Jevris never searches for a key file by itself.
- **macOS.** A locked login keychain prompts once. If you chose "Deny", run `jevris credential set` again and allow access.
- **Windows.** Credential Manager is per user. Running the harness as another user (or from a service) needs the key stored for that user.

Without a key Jevris keeps working rules-only, which is a supported mode.

## The sidecar does not start

Commands start the local sidecar on demand. If `jevris status` shows it `not-running`, `refused` or `timeout`:

```sh
jevris sidecar status
jevris sidecar restart
```

- `refused`: the socket or pipe endpoint failed an ownership check (another user's file, a symlink, or on Windows a pipe that someone else created first). Jevris will not connect to it. Remove the stale files in the runtime folder (`~/.jevris/run`, `~/.local/state/jevris/run` or `%LOCALAPPDATA%\Jevris\run`) and restart.
- The store did not open: `status` shows the reason, for example read-only data folder, a store written by a newer Jevris (`schema-newer`, see [upgrade.md](upgrade.md#downgrade)), or disk full. The sidecar runs rules-only until it is fixed.
- The store is refused as copied from another machine or user: see [The store is refused as copied](#the-store-is-refused-as-copied).
- `sidecar build: ... runs an older build than the installed runtime` in `jevris doctor`: the sidecar started before a reinstall and still runs the old code. Run `jevris sidecar restart`. A sidecar retires itself once it is idle and its verification runs have ended, so the line also goes away on its own. Install itself restarts a running sidecar on the new build; the line after a reinstall means that restart did not happen (a verification run under way, autostart off with `JEVRIS_SIDECAR_AUTOSTART=0`, a supervised sidecar, or a start that failed; the `sidecar build:` line install printed says which and gives the fix).
- The sidecar comes back after a crash but not after `jevris sidecar stop`: that is `jevris service install` at work. The service manager does not restart a clean exit, so `jevris sidecar start` (or the next login) starts it again, through the service. `jevris sidecar restart` on a sidecar the service runs stops it cleanly and asks the service manager to start it; it never starts an unsupervised sidecar next to the service. If the manager cannot be reached it refuses with `SERVICE_UNREACHABLE` and stops nothing: run `jevris service status`, then `jevris service install`. `jevris service install` also stops a sidecar the service already runs first, so the manager starts it on the new unit on every OS; a sidecar that was started on demand is left as it is. `jevris service status` shows the unit. `jevris service uninstall` removes it, and the sidecar then starts on demand again. On Linux without a systemd user session (many containers and CI runners), `jevris service install` says so and changes nothing.
- In a container, `The sidecar (pid N) did not stop` although it was killed: the container has no init process to reap exited processes, so the sidecar stays a zombie and still looks alive. Start the container with an init, for example `docker run --init`.

### The store is refused as copied

`jevris doctor` shows `sidecar: running (degraded)` with `store unavailable (The Jevris store is refused: it has another machine identity ...)`.

Earlier releases tied the store to the host name, and on macOS the host name changes with the network. The sidecar now uses the stable machine id and re-stamps a store it can match to one of this machine's names by itself (see [configuration.md](configuration.md#the-stores-machine-identity)). A store it cannot match stays refused. When the file is yours and in your home, the message says it probably came from an earlier network name of this machine.

If you created the store on this machine, adopt it from a terminal:

```sh
jevris store adopt       # asks you to type yes; stops the sidecar and re-stamps the store
jevris sidecar start
```

To start a new store and keep the old one instead:

```sh
jevris sidecar stop
mv <data>/jevris.db <data>/jevris.db.refused-<date>
jevris sidecar start
```

`<data>` is the folder the message names, for example `~/.jevris`. Move any `jevris.db-wal` and `jevris.db-shm` beside it to the same name with `-wal` and `-shm` added. Never adopt a store copied from another machine or user; move it aside or run `jevris store restore <backup>`. `jevris store adopt` is refused without an interactive terminal, from hooks, MCP and scripts, and under `JEVRIS_TEST`.

### Counters, traces and a status line

- `jevris status` (and the MCP status tool) shows the last 7 days of deadline misses against the 900 ms target: hooks that answered late or without the sidecar, sidecar answers that came after the caller's deadline, subscribers that missed their slice, and circuit-breaker opens. The counts survive a sidecar restart. They are counts and names only, never event content.
  - "Hooks the sidecar did not answer" includes the hooks that found no sidecar running and started one (the status line says how many). That happens by design after the sidecar exits when idle (30 minutes without a request) and after a reinstall retires the old build; the hook runs rules-only for that one call and the next hook is answered. It is not a fault, but a count that is high while you use the harness continuously is worth a look in `~/.jevris/logs/sidecar.log` (`stopping`, `stopped` and `started` lines).
- `jevris sidecar metrics` shows decisions, abstentions, fallbacks to rules, stale decisions, retries, latency, tokens and cost for the last 24 hours (`--hours <n>` to change the window), and request counts since the sidecar started.
- `jevris sidecar diagnose on --minutes 15` adds request sizes and deadlines to the traces for a while. It never adds content, and it ends by itself.
- `jevris sidecar statusline` prints one line from a cache file the sidecar keeps. It does not contact the sidecar, so it is cheap enough for a status line command. Jevris never changes your harness's status line setting. If you want the line there, point your own status line command at it.

## A harness says a Jevris hook or MCP server failed

Harness hooks and MCP servers run from the runtime copy under `<data>/runtime/<version>/`. If that copy is gone (you deleted the data folder, or restored a backup of your home without it), the harness points at files that no longer exist.

```sh
jevris install --yes     # copies the runtime again and re-points every registration
```

Then restart the harness. `jevris doctor` runs the installed hook and MCP server and shows which harness is affected.

A hook that runs but seems to do nothing is usually working as designed: uncertified hooks observe only. Set `JEVRIS_HOOK_DEBUG=1` in the harness's environment to have the hook print its reason codes (never event content) to standard error.

Harnesses sometimes send the same hook event twice, for example after a slow answer. Jevris answers a repeat of an event it has already seen in one of three ways, and each is by design:

| Reason code (`JEVRIS_HOOK_DEBUG=1`) | What happened |
| --- | --- |
| `DUPLICATE_REPLAYED` | The harness sent the same event again within 5 minutes, and the first answer went out in time. The repeat gets that first answer again, unchanged, including a Stop continuation. Nothing runs again, so nothing is spent, leased or applied twice. The repeat gets the first decision even if a setting changed in between. If the kill switch is stopped, nothing is replayed. |
| `DUPLICATE_DELIVERY` | The first answer missed its deadline or was cancelled, so the repeat only observes. A subscriber spends its effect only when its answer is wanted, so nothing was spent the first time either. |
| `DELIVERY_BODY_MISMATCH` | The repeat reused the first event's delivery key with a different body, so the sidecar refused it. |

Replayed answers are held in the sidecar's memory only: at most 512 of them, each under 256 KiB, for 5 minutes. They are gone when the sidecar stops.

## A harness was upgraded

A certification record covers a range of harness versions, so most upgrades change nothing. When the new version is outside every record's range, the doctor line says so and a re-check starts in the background:

```text
harness opencode: installed; ...; not covered yet: <version> is outside the record covers <range> (...); re-checking in the background, no model call
```

`jevris doctor`, the sidecar's start and each harness SessionStart can each start the re-check. It also starts after live evidence demotes a feature (a hook delivery that does not have the expected shape, or an owned worker's failed first-use check), and once for a record written before a feature this Jevris certifies (`worker.route`). The re-check is `jevris certify` in a throwaway profile, with no model call, run at most once per version or per demotion, never in a test run and never under a home that is not your account's own. A pass writes a record that covers the new version; run `jevris doctor` again to see it. A failure names the features that failed with their fix, and only those wait: observation and advice go on meanwhile. The re-check needs an existing record for that harness on this machine; a harness never certified here needs `jevris certify --harness <name>` once.

## An owned worker was refused or did not start

`jevris status` and the task's record give the reason:

| Reason | What to do |
| --- | --- |
| `QUEUED` | Owned workers are not automatic: see [settings.md](settings.md#workers). |
| `QUEUED_NO_MODEL` | The task names no model, and no model was found for it: no installed harness reaches a registry model with a sign-in it holds and consent allows. Name a model in the plan, or sign in to a harness. |
| `unsupported: install ... and run jevris install --harness <name>` | No installed harness can run the task's model. Install the one named. |
| `workers.json: <problem>; owned workers are refused until it is fixed` (doctor) | Fix `workers.json` in the Jevris config folder. See [routing.md](routing.md#stating-the-mode-workersjson). |
| `ANTHROPIC_LOGIN_THIRD_PARTY` | A Claude model in OpenCode or Kilo needs `api-key` mode with `ANTHROPIC_API_KEY`. A Claude subscription runs only in Claude Code. |
| `api-key mode needs ... in the environment` (doctor's auth line) | Set the vendor key, or state `subscription` for that harness. |
| `not signed in; run ...` (doctor's auth line) | Sign in to the harness with the command named. |
| `XAI_API_KEY_MISSING` | `api-key` mode for a Grok model needs `XAI_API_KEY`. Set it, or state `subscription` to use the SuperGrok login in OpenCode or Kilo. |
| `XAI_PLAN_NOT_ELIGIBLE` | xAI refused the harness (HTTP 403). Whether a SuperGrok plan covers third-party harnesses is unconfirmed. Use `XAI_API_KEY`, or a plan xAI enables for that harness. |
| `XAI_AUTH_FAILED` | The harness could not sign in to xAI (HTTP 401, or no login). Sign in again in OpenCode or Kilo, or set `XAI_API_KEY`. |
| `WORKER_PROVIDER_UNKNOWN` | No entry in the model registry, and no known model family (Claude, GPT, Grok, Gemini), names the model's provider, or the registry lists it under a provider owned workers do not run yet. Jevris refuses the run and never sends an unknown model to Claude. Use a model id the registry lists (`jevris doctor` names the registry it reads). |
| `PROVIDER_CONSENT_REQUIRED` (or `PROVIDER_CONSENT_MISSING`, `PROVIDER_CONSENT_STALE`, `PROVIDER_CONSENT_REVOKED`) | An owned worker for Kimi (Moonshot) or DeepSeek runs only after you grant that provider consent, for today's consent text: `jevris consent provider <provider>` shows the text, and `jevris consent provider <provider> --grant` grants it. A provider whose consent you revoked is refused the same way. |
| `worker refused before starting (<CODE>)`, route answer `LAUNCH_NOT_STARTED` | A worker was refused before any harness process started, for the reason `<CODE>` names (look it up in this table). Nothing was spent: the lease and the route's reservation were settled at 0. Fix the named cause and start the task again. |
| `WORKER_MODEL_UNNAMED` | No harness that runs the model's provider can name the model, so nothing started. Name the model with an id the registry lists, or give your own `provider/model`, or remove a `workers.json` harness preference for that provider so another harness runs it. |
| Antigravity refused in `api-key` mode | Antigravity has no API-key sign-in. Set `"antigravity": "subscription"` in `workers.json`, or remove the entry. |
| `WORKER_INIT_...: ...` (for example `WORKER_INIT_MODEL`, `WORKER_INIT_BYPASS`, `WORKER_INIT_CWD`, `WORKER_INIT_AUTH`) | The harness started the run differently from what Jevris asked (another working directory, a bypass permission mode, a web tool, another model or sign-in). The run was stopped before any tool ran, `worker.route` is demoted for that harness version, and a background re-check starts. Run `jevris doctor` for the worker line. |
| `WORKER_AGENT_NOT_LOADED: ...` (OpenCode, Kilo) | The Jevris agent did not load, so the run's permissions would not have been the granted ones and it was refused. Check that your OpenCode or Kilo config does not block the agent Jevris passes. |
| `HOST_ROUTE_NOT_LAUNCHED: ...` | The task's linked session goes through a gateway or inference host, and the routed owned run could not launch there. The reason names the host and the code: `HOST_TARIFF_UNKNOWN`, `ROUTE_HOST_NOT_CERTIFIED`, a consent code such as `HOST_CONSENT_REVOKED`, `NOT_ON_SESSION_HOST` (the host cannot run the approved model), or `HOST_READ_FAILED` (the linked session could not be read). Nothing ran direct at the maker instead. Fix the named cause (`jevris certify --harness <name>`, or `jevris consent provider`), or link the task to a session on the maker's own API, then start the task again ([routing.md](routing.md#which-harness-runs-it)). |
| `ACTUATOR_UNCERTIFIED` (in the trace; the task still runs) | The harness is not certified for `worker.route`, so routing only advises: the router's choice is recorded as a counterfactual and the task runs on its approved model at the model's default effort. Run `jevris certify --harness <name>`. |
| `not certified here (WORKER_FLAG_MISSING)` (doctor's worker line) | The harness's help no longer lists a flag the worker passes. Update the harness or Jevris, then `jevris certify --harness <name>`. |
| status `access-limit` or `overloaded` | The harness's account ran out, or its provider was overloaded. The run stops and is not counted as the task failing. An access limit records a pause (see [routing.md](routing.md#access-limits-when-an-account-runs-out)); `jevris route limits` shows until when. An overload pauses nothing: start the task again later. A run recorded as `usage-limit` ended before this release read access limits, and recorded no pause. |
| `ACCESS_LIMITED: <class> on <scope> ...` | The account is paused on this machine after a rate limit, a usage window, exhausted credit or a blocked account, and nothing was launched. A timed pause says `paused until <time>`: the task resumes by itself once after that time, while automatic workers are on and the kill switch is clear ([routing.md](routing.md#what-a-pause-does)). A second limit after a resume waits for you. A pause with no expiry says how it clears, for example `clears with jevris route limits clear`: fix the account first, then clear it at a terminal. `jevris route limits` lists every pause ([routing.md](routing.md#access-limits-when-an-account-runs-out)). |
| `PROVIDER_OVERLOADED: ...` | The provider was overloaded. Nothing is paused; the reason says until when, and the task is retried by itself after that, up to 3 times, under the same conditions as an access limit. After that it waits for you. |

## Route advice abstained, or a route was only explained

Route advice (`jevris route`, the `route` skill, the `jevris_plan_route` tool) and subagent routes abstain rather than guess. The reason code says why. See [routing.md](routing.md).

| Reason | What to do |
| --- | --- |
| `CURRENT_MODEL_UNREGISTERED` | The session's model is not in the model registry, or it runs through a host whose id Jevris does not pin, so Jevris neither suggests a switch away from it nor routes the turn. Nothing to fix. An administrator can add the model with a model registry override ([configuration.md](configuration.md)). |
| `NOT_ON_HARNESS` | The model is in the registry, but this harness cannot run it: the registry's harness map gives it no access to that provider, or no id for the model there. The model stays as it is. Use a harness that reaches the provider. |
| `HOST_UNKNOWN` (Kilo and OpenCode turns and subagents) | Jevris cannot read the session's host from its model id, so it does not route from it. That includes a session on a gateway (for example `openrouter/...`) until Jevris routes through hosts. Switch yourself ([routing.md](routing.md)). |
| `NOT_ON_SESSION_HOST` (Kilo and OpenCode turns and subagents) | A route keeps the session's host, and the suggested model has not been seen served there. Jevris uses another host only when this harness has been seen running the model through exactly one host. The reason names the hosts it has seen, if any; with two or more, choosing one is yours. Run the model once through the host you want on that harness, or switch yourself ([routing.md](routing.md)). |
| `HOST_TARIFF_UNKNOWN` (Kilo and OpenCode routes through a gateway or host, and owned workers) | The serving host's price for this model is not known: its snapshot price is missing, disagrees with the host's own list, or is a free trial. Jevris then compares costs at the maker's list price, labelled an estimate, and gives advice only; it never switches a model on an estimate. Switch yourself, or use the maker's own provider ([routing.md](routing.md)). |
| `ROUTE_HOST_NOT_CERTIFIED` (Kilo and OpenCode turns and subagents) | The route goes through a gateway or inference host, or moves the session to another host, and this harness version's `route.host` certify case has not passed. The answer is advice naming the model, and you can switch yourself. `jevris certify` on a supported version turns it on ([routing.md](routing.md)). |
| `HOST_CONSENT_REQUIRED` and `HOST_CONSENT_REVOKED` (routes through a gateway or host) | The host the route would go through, or a host it forwards to (the Kilo Gateway forwards to OpenRouter), needs your consent, or its consent was revoked or cannot be read. Grant it with `jevris consent provider` ([privacy.md](privacy.md#consent-per-model-provider)). NVIDIA has no consent text, so it is never used. |
| `ALIAS_NOT_NEWEST` (Claude Code subagents) | The Agent tool takes only a family alias (`haiku`, `sonnet`, `opus`, `fable`), which means the family's current model. A route to an older model of that family abstains. |
| `ACCESS_LIMITED` | The suggested model's account is paused on this machine after an access limit, so the route does not use it. When your current model is paused, a main-session turn gets advice only; Jevris never switches you away to escape a limit. `jevris route limits` lists the pauses. |
| `BASELINE_ACCESS_LIMITED` (owned workers) | The baseline model's account is paused, so the router picked the best model that is not. Nothing to do. |
| `MODEL_NOT_ACCESSIBLE` | This harness, with this sign-in, said the model does not exist or you have no access. Only that harness and sign-in are affected ([routing.md](routing.md)). |
| `PROVIDER_CONSENT_REQUIRED` and the other `PROVIDER_CONSENT_*` codes | The model's provider needs your consent. Advice lists the providers it considered. See [privacy.md](privacy.md#consent-per-model-provider). |
| `ROUTE_CASE_NOT_RUN` or `ROUTE_CASE_FAILED` (doctor, `hooks.route`) | Certify's stub case for that harness's subagent route did not run or did not pass, so `hooks.route` is not certified and the sidecar shows the route as text only. Run `jevris certify --harness <name>`. |

## An account ran out, or its pauses look wrong

[routing.md](routing.md#access-limits-when-an-account-runs-out) explains how Jevris notices a limit and pauses an account. `jevris route limits` lists what is paused now, and `jevris doctor` prints an `accessLimits` count line and one `accessLimit` line per pause ([Reading the doctor](#reading-the-doctor)).

| Symptom or code | What to do |
| --- | --- |
| A pause you know has ended (you topped up, or fixed the account) | A pause with no expiry waits for you: `jevris route limits clear <n>` at an interactive terminal, with the sidecar running. For a Claude or Codex API key that Jevris passes, an `OPENROUTER_API_KEY` for an owned run through OpenRouter, or the maker key of a direct Kilo or OpenCode run, a different key also clears it; the reason names which key. A new maker key never clears a pause on the OpenRouter host, and a new host key never clears a maker pause. |
| A limit Jevris did not notice | Check the table in [routing.md](routing.md#what-jevris-notices-when-you-run-out). Codex sessions are not read (no Codex hook carries a failed turn). A Claude Code session is read only once `StopFailure` is registered: see the doctor line `harness claude hooks: StopFailure not registered yet ...` and run `jevris install --harness claude`. An owned run or a session through a custom base URL, `apiKeyHelper` or a project config that redefines the provider records nothing, by design. |
| `harness claude install: StopFailure registered, but access.session is not certified for <version>` (doctor) | The installed hook is ahead of the certification, for example after a Claude Code upgrade. Run `jevris install --harness claude`. |
| `ACCESS_LIMITS_UNREADABLE` | The record could not be read, so it pauses nothing, and no blocked task resumes. Doctor says why. If a newer Jevris wrote it, it is left untouched and nothing new is recorded until you upgrade. If the read failed only this time, nothing changed and it counts again once it reads. If it is damaged, the next pause recorded sets it aside. In every case `jevris route limits clear --all`, at an interactive terminal, rewrites it empty. |
| `accessLimits set aside: ...` (doctor) | A damaged record was set aside as `route-learning/access-limits.json.damaged-<time>` (at most 3 are kept, owner-only), so pauses recorded before it may be missing. Check `jevris route limits` against what you know of your accounts. `jevris route limits clear --all` or `jevris route learning reset --machine` removes the set-aside files. |
| `ACCESS_LIMITS_FULL` | The record holds 128 pauses. A new pause replaces the oldest expired or timed one; if every pause has no expiry, a new one is not recorded. Clear the ones you have dealt with. |
| `CHANNEL_REFUSED` (`route limits clear`, `credential reenable`) | Clearing needs a person at an interactive terminal: not a pipe, `--json` or a script. There is no `--yes`. |
| `SIDECAR_UNAVAILABLE` or `SIDECAR_NOT_RUNNING` | Start it with `jevris sidecar start`, then clear again. Neither command starts the sidecar itself. |

## Install or uninstall was refused

- **"the home ... does not exist"**: pass `--home` with an existing folder, or unset `JEVRIS_HOME`.
- **A config file is not valid JSON, JSONC or TOML**: Jevris will not rewrite a file it cannot parse. Fix the file (the message names it), then retry.
- **"changed after install"** on uninstall: you edited a file Jevris owns. It is left in place; delete it yourself if you do not need it.
- **A non-interactive install without `--yes`** prints the plan, changes nothing and exits 0 by design. Re-run with `--yes` to apply it.
- **A `certify <harness>:` line names a fix after install.** Install certifies each harness it installed (no model call); a harness that does not certify never fails the install. The summary then reads `mode: reduced for <harnesses>`. Run the `jevris certify --harness <name>` it names once the cause is fixed. `--no-certify` skips this step.

Every install and uninstall backs up the files it changes under `<data>/backups/`. A failed operation restores them itself.

## Windows

- **`npx` is blocked in PowerShell** ("running scripts is disabled", after the release): use `npx.cmd @webventures/jevris ...`, or run from Command Prompt.
- **`EPERM` or `EBUSY` while installing**: antivirus or an indexer briefly holds a file. Jevris retries atomic writes and its local record reads a few times; if it still fails, run the command again.
- **Long paths**: a very deep home or `JEVRIS_HOME` can exceed the 260-character limit in older tools. Enable long paths (`LongPathsEnabled`) or use a shorter `JEVRIS_HOME`.
- **A harness installed as a `.cmd` shim** (for example `codex.cmd` from npm) is found through `PATHEXT`. If `doctor` cannot find the harness, check that its folder is on your user `PATH` in a new terminal.
- **Roaming profiles**: config under `%APPDATA%\Jevris` roams; the store, runtime copy and backups under `%LOCALAPPDATA%\Jevris` stay on the machine. Run `jevris install --yes` on each machine.

## A command says Jevris produced an invalid result

`Refused (RESULT_CONTRACT_INVALID): Jevris produced an invalid <command> result (<path> <code>). Report this as a bug.` (exit 2) means the answer Jevris built failed its own output contract, so it was not printed. The named path and code say which field. Nothing you passed was wrong. Run the command again with `--json`, then follow [Report a problem](#report-a-problem) and include the path and code. A workspace folder with a long generated name (for example an OS temporary folder) does not cause this: paths are checked for known credential formats only.

## Report a problem

Run `jevris doctor --json` and attach its output to an issue: it contains versions, states and reason codes, never a key, a prompt or source text. It does contain file paths, such as your Jevris folders; edit them out if you prefer. For a security problem, follow [SECURITY.md](../SECURITY.md) instead of opening a public issue.
