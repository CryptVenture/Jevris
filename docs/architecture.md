# Architecture

Jevris keeps what must be deterministic out of the coding model. Facts, arithmetic, permissions and verification are ordinary software. Jev is asked only bounded questions. The coding model keeps writing the code, and the harness keeps deciding what a tool may do.

## Authority

| Kind | Who decides | How far it goes |
| --- | --- | --- |
| Observe | Jevris records what the harness did | On where Jevris is installed, unless the mode is `off` |
| Advise | Rules first; Jev only for a bounded question | Shown from mode `advise` up; never applied by itself |
| Actuate | A certified hook, runner or owned worker | Only in mode `bounded-auto` (the default), and only where a signed certification record covers the harness, its version and the OS; still under native permissions |

The `mode` setting (`off`, `observe`, `advise` or `bounded-auto`) is the single ceiling on all three. Other settings, host and organization policy can only lower it, and raising it needs a person at an interactive terminal. See [settings.md](settings.md#modes).

Native permissions and the sandbox stay authoritative. On a certified hook Jevris can add context. It can also choose a subagent's model (`hooks.route`) on Claude Code, Codex, Kilo and OpenCode, each only after that harness's own certification. The 1.2 release does not require it on Codex: there it routes only where its certify case passes on the installed version, and advises otherwise. It does so only with evidence for that subagent type (an active learned slice or a signed prior) and never over an explicit model or a pin. The sidecar receives only the subagent type. It returns only a model id, which Claude Code maps to `haiku`, `sonnet`, `opus` or `fable`, and the other harnesses receive in their own spelling. Antigravity gets the advice as text only (see [routing.md](routing.md#subagent-routes)). Subagent outcomes do not feed learning yet and 1.2 ships no signed prior, so in 1.2 it abstains in practice. Jevris never grants a tool, widens a sandbox, answers a permission prompt or writes a permission decision. Uncertified means observe only, and any failure (a late or missing sidecar, a refused frame) falls back to observe.

Certification records cover a harness version range, not one version, so a routine harness upgrade needs no manual step. Real use adds live evidence: each hook delivery the sidecar records, and each owned worker's first-use check, counts as conforming or malformed for one feature at one harness version (names and counts only, never content). A malformed one demotes that feature at once. `jevris doctor`, the sidecar's start and each SessionStart start a re-check in the background for a version outside every record's range, a demoted feature, or a record that predates a feature (`worker.route`): `jevris certify` in a throwaway profile, with no model call, at most once per version or demotion. A pass writes a record that covers the new version. Observation and advice never wait for it; only actuation of the features not yet covered does. The `worker.route` feature certifies how owned workers are routed (model and effort), "certified pending first use": certify checks the flags and the worker port with no model call, and the first real run checks its init before any tool runs. In 1.2 it does not gate starting a worker, and certify runs the port against a stand-in, not the real harness ([routing.md](routing.md#what-certification-covers-for-owned-workers-in-12)). See [harnesses/parity-matrix.md](harnesses/parity-matrix.md#how-to-read-it-on-your-machine).

## Processes

```text
 coding harness (Claude Code, Kilocode, Codex, OpenCode, Antigravity)
   |  hook event (stdin JSON)          |  MCP tool call (stdio)
   v                                   v
 hook launcher                       MCP server
 dist/hook.mjs, closed bundle        plugins/shared/mcp.js
   |  authenticated frame              |  runs the jevris CLI, arguments on stdin
   v                                   v
 sidecar  <---------------------------- jevris CLI
 dist/sidecar.mjs                     dist/cli.mjs
   |  decision engine, budgets, store, orchestrator
   |  the only process that reads the Jev key
   v
 Jev API (only with a key, within budget, and only with administrator consent for source)
```

- **Hook launcher.** Starts on every harness event, reads the event, asks the sidecar within the harness's hook deadline and prints the answer the harness expects. Its import graph has no store, SDK or keychain, so it starts fast. Late, missing or refused means "observe".
- **MCP server.** Exposes 17 tools. Each call runs the installed `jevris` command with the arguments on standard input; administration (install, settings, credentials, kill switch, policy, data deletion) is not reachable through MCP. See [mcp.md](mcp.md).
- **CLI.** The public commands, administration and operator tools. Commands start the sidecar on demand and fall back to a reduced, local answer that says so.
- **Sidecar.** One per user. Listens on a Unix socket, or a per-user named pipe on Windows, in an owner-only runtime folder, and authenticates every frame with a per-boot key in an owner-only file. It owns the decision store, the decision engine, budgets, route learning and the orchestrator. Lifecycle: hooks, commands and MCP tools start it on demand, and it exits when idle. When a service is installed for the home, an on-demand start asks the service manager to start the unit instead of spawning a second sidecar (a hook waits at most a moment for the manager, then answers rules-only; if the manager refuses or cannot be reached, the sidecar is started on demand, unless the service's own sidecar is alive but not answering). Install, and `jevris service install`, hand a sidecar that runs on demand over to the service by asking it to stop (the graceful shutdown request), so one sidecar remains. A reinstall replaces the runtime under it, so install asks a running sidecar on an older build to stop with the graceful shutdown request (in-flight requests drain first) and starts the installed build at once on the same endpoint, and the first hooks after the install are answered. A sidecar that was not running is not started, and neither is one when `JEVRIS_SIDECAR_AUTOSTART=0` is set. A supervised sidecar (`jevris service install`) is never started next to its service: it retires itself when its build is stale and it is idle (no connection, no request in flight, no verification run under way) and its service manager restarts it. `jevris sidecar restart` and `start` reach a supervised sidecar through its service manager (launchd, systemd or Task Scheduler), never by spawning an unsupervised one, because the manager does not restart a clean exit; when the manager cannot be reached the restart refuses with `SERVICE_UNREACHABLE` and stops nothing. The sidecar decides whether a stop may happen: while it is finishing a verification run it refuses (`VERIFICATION_RUNNING`) and keeps running, and only `jevris sidecar stop --force` overrides that; install never forces it. A restart that fails never fails the install; one line gives the reason code and the fix.
- **Owned workers.** For owned work, the orchestrator starts an installed harness headlessly, one leased task per run in its own git worktree, under your subscription login or an API key. All five harnesses can run one. Route learning may choose the model and effort only on a harness certified for `worker.route`; elsewhere it advises. The Claude Agent SDK runs only with an API key. See [routing.md](routing.md#owned-workers).

## Packages

All workspaces are private and bundled into the one published package.

| Package | Role |
| --- | --- |
| `@jevris/contracts` | Types and runtime schemas for every boundary (CLI, MCP, sidecar frames, hooks, evidence). No I/O. |
| `@jevris/platform` | Per-OS paths, process spawning, atomic writes, path identity and owner-only permissions. |
| `@jevris/core` | Rules, egress, the decision engine's pure parts, packets and redaction, advice, the model registry, the router and route learning, checkpoint, shortlist. No store or native addon at load. |
| `@jevris/store` | SQLite store (better-sqlite3): migrations, decisions, tasks, receipts, audit, backups. |
| `@jevris/provider-typesafe` | The only production Jev transport (`@typesafe-ai/sdk`), budgets and the sidecar decision engine. The transport owns each call's total deadline: connect, headers and the body read all end at it, even when the network or the SDK stalls, and a late call is `DEADLINE`. |
| `@jevris/orchestrator` | Task graphs, leases, reservations, owned workers and their harness and auth choice, verification runner and receipts, settings, memory capsules. |
| `@jevris/evals` | Evaluation protocol, corpus, holdout and review records. |
| `@jevris/languages` | Manifest-based workspace profiling and check proposals. |
| `@jevris/mcp` | The MCP server, emitted as `plugins/shared/mcp.js`. Every harness runs this one file. |
| `@jevris/adapter-*` | One per harness: its hook protocol, config files, install and doctor probes. `adapter-claude-sdk` drives owned Claude sessions through the optional Agent SDK, with an API key only. |
| `apps/cli`, `apps/sidecar`, `apps/hook` | The three programs above. `apps/cli` also holds install, doctor, certification and the owned-worker drivers for each harness CLI. |

## What stays local

Everything, by default: the store, logs, receipts, capsules, route learning and packs live in the Jevris data folder under your home, readable only by you. A Jev call sends only a bounded question and the evidence an administrator approved for egress; source is never sent without that consent. Remote telemetry is off. See [privacy.md](privacy.md) and [security.md](security.md).

## Distribution

One npm package, `@webventures/jevris`. `install` copies its runtime to `<data>/runtime/<version>/` and points every harness there, so nothing runs from the npm cache and no hook calls `npx`. See [installation.md](installation.md).
