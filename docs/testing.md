# Testing

## Run

```bash
npm test
```

That command runs `node scripts/test.mjs`, a plain Node script with no shell. It works the same way on Windows, macOS and Linux:

1. Builds with `node scripts/build.mjs` (`tsc -b`, deletes stale `dist/*.test.js`, emits the generated plugin sources, bundles `dist/`). Skip this with `node scripts/test.mjs --no-build`.
2. Builds the specification's frozen reference suite (`fixtures/ssot/reference`) with the repository `tsc`.
3. Runs `node --test` on every `<workspace>/test/*.test.mjs`, `test/*.test.mjs`, `test/qa/*.test.mjs`, `test/acceptance/*.test.mjs` and `fixtures/ssot/reference/tests.mjs`. Tests import `../dist/*.js`. A stale `dist` test file can never run.
   - The run holds the checkout's suite lock (`.jevris-suite.lock`) from the build to the end, so another build in the same checkout never rewrites `dist/` under it. A waiter gives up after `JEVRIS_SUITE_LOCK_WAIT_S` seconds (default 2700) with exit 75.
   - The full suite (no file named) also holds the host suite lock first, so only one full suite runs on the machine at a time; see [One suite at a time](#one-suite-at-a-time-on-a-machine).
   - To run only some files, name them: `node scripts/test.mjs --no-build apps/cli/test/install.test.mjs`.
4. Runs the latency-bound files last, each one alone, in the same `node --test` run. These are the files whose assertions are wall-clock latency targets: an answer inside a hook deadline, a maintenance write under 50 ms, BUSY before a client deadline. They are listed in `SERIAL_TEST_FILES` in `scripts/test.mjs`:
   - `test/sidecar-lifecycle-load.test.mjs`
   - `apps/sidecar/test/maintenance-worker.test.mjs`
   - `apps/sidecar/test/daemon.test.mjs`
   - `packages/mcp/test/surface-e2e.test.mjs`
   - `packages/orchestrator/test/verify-background.test.mjs`

   Next to the suite's own parallel files, a host is loaded far past what those targets describe, so these files failed there while passing alone. The runner lists them after every other file. `scripts/test-serial-gate.mjs`, imported into each test process, holds each of them until every other file has finished, then lets them through one at a time. Their assertions are unchanged. Because it is still one run, coverage, the test events and the summary are that run's own. The wait is capped at 20 minutes (`JEVRIS_SERIAL_GATE_WAIT_S`). A capped wait names each file it waited for, with its pid and whether it still runs (or `never started`), on the serial file's stderr and again after the run (`serial gate: ... waited N s, its cap, for ...`). A file named on the command line follows the same rule.
5. Bounds every test file. `--test-timeout` (120 s) ends a test on Node 24 and later; Node 22 and 23 apply it to each whole file, so the runner passes it only on 24 and later (`testTimeoutArgs` in `scripts/test.mjs`). It does not end a file whose tests are done while its process stays up, for example on a leaked child that holds its pipes open. `scripts/test-file-bound.mjs`, imported into each test process after the serial gate, notes each write the file's process makes (node:test streams every test event through it). A file silent for `JEVRIS_TEST_FILE_SILENT_S` (default 600 s) prints `test file bound: <file> was silent for 600 s ...; it and the N process(es) it started were ended (FILE_SILENT_BOUND)`, sends SIGTERM and then SIGKILL to every process it started, and exits 1. The run reports that file as failed and ends. A latency-bound file's wait for its turn does not count.

Every run is isolated from your machine:

- **Temporary home.** `HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `JEVRIS_HOME` point into a fresh temp folder. The runner fingerprints the real home's Jevris-relevant paths before and after the run, and fails if they changed. `JEVRIS_HOME_GUARD=off` disables this check on unusual hosts. When it fails, it lists each added, removed or modified path with its time. A change made during the run by you or another program also trips it. There are two exceptions. The first is your own running sidecar: when `~/.jevris/run/endpoint.json` names a live sidecar serving your home, its routine refresh of `run/locality.json` and `statusline.json` is not counted. The second is a live Jevris install: an install receipt from before the run, or one you write during it by installing (no test process recorded it). Your own harness sessions keep writing to its folders during the run (hook deliveries, the store and its WAL, harness versions, logs), and a reinstall rewrites the harness files its receipts list (such as `~/.claude/plugins/jevris-local`). So a change that no test process wrote, inside the Jevris folders (`~/.jevris`, or the XDG and AppData equivalents) or at a path an install receipt lists before or after the run, is summarised as the live install's, per folder, and does not fail the run. Any other change in the guarded paths, such as a harness file no receipt names, still fails it. The test preload records every write a test process makes anywhere under the real home, in each child process it starts too (even with an explicit `env`), and including native SQLite databases opened for writing. It guards your real `XDG_CONFIG_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `APPDATA` folders the same way, even when they are outside the home. Any recorded write fails the run and is listed with the test file it came from; a child process carries its parent's test file. The ledger holds paths only. Paths inside the checkout and the temp folders are not counted as the home's.
- **Temporary folder.** Each run makes one folder under the OS temp directory, `jt-<random>`, and it holds everything the run creates. `TMPDIR`, `TMP` and `TEMP` point at it for every test process, and the temp HOME and the harness stubs live inside it. The runner removes the folder at the end, so a temp dir that a test forgets cannot pile up. `JEVRIS_KEEP_TEST_DIRS=1` keeps the folder for debugging. The test preload records every directory a test process creates directly in the real temp directory. The run fails when any of those are left, and it names them. Folders that other programs or concurrent runs create there never count, and neither does the live runtime folder `jevris-<uid>`. `JEVRIS_TEMP_GUARD=off` disables the check. Pack smoke gives each sandbox its own `TMPDIR` inside its work folder, and `scripts/ci-cell.mjs` uses a `jc-cell-<random>` scratch folder.
- **Sidecar start wait.** Under a test run, JEVRIS_SIDECAR_WAIT_MS sets the CLI's sidecar autostart wait (the runner sets 60000; at most 60 s), because a cold start on a loaded host can outlast the product's 5 s.
- **No keychain.** `JEVRIS_TEST=1` plus a preload stop any test process from loading `@napi-rs/keyring`, so no OS credential store is opened. Code that needs a keyring gets a memory one injected.
- **No real harness.** Stub `claude`, `kilo`, `opencode`, `codex` and `agy` executables come first on `PATH`. The stubs log each call and exit 1. `JEVRIS_NO_LIVE_HARNESS=1` makes the probe code refuse a PATH lookup unless a binary path is injected. Every child process is killed as a whole tree on timeout.
- **The tripwire.** In a test run, the product refuses to start a real harness binary, or the macOS `security` tool, from outside the run's temporary folder: it throws a "test tripwire: refused to start the real ..." error instead. A harness login probe (`claude auth status`, `codex login status`) and the background certification re-check never run under a home that is not the OS account's own, so a real harness can never look for a keychain that is not there and open a "keychain cannot be found" dialog. `apps/cli/test/keychain-guard.test.mjs` holds these rules.
- **No real home in a test file.** A test never calls `os.homedir()`: run directly with `node --test <file>`, that is the real home. `lint/test-hygiene.lint.mjs` fails on it. Use a temporary directory or a sandbox's own home.

Real-harness checks are opt-in and never part of `npm test`:

```bash
JEVRIS_LIVE_HARNESS=1 npm run smoke:harness
```

That command runs `jevris certify --harness <name>` for each harness binary it finds on `PATH` (`claude`, `kilo`, `codex`, `opencode`, `agy`). Pass `--harness <name>` (repeatable) to pick some. For each one, certify:

- installs Jevris into a temporary harness profile and a temporary Jevris home, never your real ones
- loads the plugin in the real binary and runs the conformance cases
- writes a certification record plus `harness-conformance` and `certification-record` evidence into `--evidence <dir>` (default `release-evidence/`)
- records in the `harness-conformance` evidence each stub case's id, whether it passed and its reason code, and the paths the model listing touched, so a failure can be read from the file. A case's detail text is never recorded; it is printed in certify's output only.
- records, for Codex's `codex.subagent-route` (K2), a trace of names and thread roles (`parent`, `child-<n>`): the app-server methods and item types each side sent, the hook calls and the stub's requests and replies. It never records a thread id, a command, a path or any content.

Records count toward the release gates only when they are signed with a trusted key: add `--signing-key <pem> --key-id <id>`. The script exits 0 when every harness it ran was certified, and 1 when one was not or none was found. It refuses to run when `JEVRIS_TEST`, `JEVRIS_NO_LIVE_HARNESS` or a test runner is set.

## One suite at a time on a machine

Several clones, Docker cells and the people or agents running them can share one machine. When full suites overlap, they starve each other, and the tests that wait on a sidecar or a deadline fail for reasons that have nothing to do with the code. So these runs take the **host suite lock** and run one at a time:

- `npm test` with no file named;
- `npm run test:future` with no file named;
- `npm run verify:fresh`;
- `scripts/ci-cell.mjs` for a Docker cell, or for any cell that runs the test or smoke step.

Lint, a build, and a test run of named files never wait for it.

- **The lock.** It is one folder per OS user in the real temp directory, `jevris-host-suite-<uid>.lock`, never in a home. It holds a token, the pid, the host name, the command and the start time.
- **Waiting.** A run that has to wait prints `waiting for suite lock held by pid N since T` once, then waits up to two hours (`JEVRIS_HOST_SUITE_LOCK_WAIT_S`). If the lock is still held after that, it exits with status 75 and names the holder.
- **First come, first served.** Each waiting run puts a ticket (its pid, start time and a token) in the queue folder beside the lock, `jevris-host-suite-<uid>.lock.queue`, and refreshes it while it waits. A run tries the lock only when no live ticket is older than its own, so runs take it in the order they arrived. It prints `host suite lock: waiting: N ahead` whenever that count changes. A ticket whose pid is no longer running, or that has not been refreshed for two minutes, is removed by the next waiter; a live waiter's ticket is never removed by anyone else. A run removes its own ticket when it takes the lock or gives up.
- **Stale locks.** A lock whose pid is no longer running is taken over. Never remove a lock folder by hand.
- **Nested runs.** A child of the holder inherits the hold (`JEVRIS_HOST_SUITE_LOCK_HELD`), so a runner started by verify:fresh or by a Docker cell does not wait for itself.
- **Checking.** `node scripts/suite-lock.mjs --host-status` prints who holds the lock and, in queue order, who is waiting. It removes nothing.

The per-checkout suite lock (`.jevris-suite.lock`) is unchanged, and it is still taken inside the host lock.

### Verifying on a fresh clone

A green run in your working tree does not prove a commit, because uncommitted files, yours or anyone else's in the same checkout, are in it. To check exactly what you commit, verify on a fresh clone of HEAD:

```bash
npm run verify:fresh -- --overlay <your paths...> [--future-days N]
```

The script:

1. Clones HEAD into a temp folder and copies only the overlay paths from your checkout into the clone. A path you deleted is deleted in the clone too, if HEAD has it. A path that is neither in your checkout nor in HEAD is refused with exit 2, and so are several paths passed as one argument: in zsh an unquoted `$PATHS` is not split, so list the paths or write `${=PATHS}`.
2. Runs `npm ci --ignore-scripts` and `npm rebuild esbuild` (as CI installs; see [development.md](development.md)), `build`, `lint`, `test`, `docs --check` and the pack check there. The test step runs the suite once under coverage, as `npm run coverage` does, and fails when a package falls below its floor in `coverage-floors.json`; its line names the packages below their floors. With `--future-days N`, it also runs `test:future`.
3. Before each step, checks that it is inside the clone and never in the main checkout.
4. Prints each step's counts and removes the clone. If a step fails, it keeps the logs and prints their folder. At its start it prunes folders kept by earlier runs: only the 3 newest stay, none older than 24 hours, and never one a live process uses (its owner runs, a process names it, or it changed in the last 15 minutes). The last line names the overlay, for example `verify:fresh: PASS at 3539015e with 3 overlay path(s): 2 copied, 1 removed`; check that the count matches the paths you meant to verify.

It holds the host suite lock for the whole run. With no `--overlay` it checks HEAD alone, which is what CI checks for a pushed commit. With `--overlay`, list exactly the paths you will commit. A failure that is already on HEAD without your overlay is not caused by your change; say so in the pull request.

## Lint

```bash
npm run lint
```

`scripts/lint.mjs` runs every `<workspace>/lint/*.lint.mjs` and `lint/*.lint.mjs` file under `node --test`. Checks that read product source text (import bans, wording, path hygiene) live there, not in `test/`. Behavioural tests do not read `src/*.ts`. The path-hygiene rule refuses `new URL(...).pathname`, `startsWith('/')` absolute checks, `/` path templates, and `homedir()`, `.jevris` or `.config/jevris` path literals outside `packages/platform`.

## Coverage

```bash
npm run coverage
```

`scripts/coverage.mjs` runs the suite with Node's test coverage over every workspace's built `dist` files. It writes `coverage/lcov.info` and `coverage/summary.json`, then fails if a package's line or branch coverage falls below its floor in `coverage-floors.json`. Raise a floor when coverage rises. Never lower one to make a run pass.

## Sidecar load (`npm run bench:load`)

`npm run bench:load` measures the sidecar under concurrent hook load. It checks the locked load targets, and exits 1 when one is not met. The reference machine is the owner's Mac: darwin arm64, Apple M4 Max, 16 cores, 64 GB. It is never part of `npm test` or CI, and it takes about ten minutes.

```bash
npm run build
npm run bench:load                                    # every scenario; prints each target
npm run bench:load -- --only subagents20 --quick      # one scenario, shortened, while you work
npm run bench:load -- --out load.json --evidence release-evidence/sidecar-load.json
```

Each hook is sent the way the launcher sends it: the Claude Code adapter, op `event`, the hot budget and a 1500 ms deadline. It is timed at the client. A subagent is SubagentStart, then three pairs of PreToolUse and PostToolUse, then SubagentStop. The targets:

| Scenario | Target |
| --- | --- |
| `subagents20`: 20 concurrent subagents for 60 s | hook p99 at most 250 ms; every hook answered (no DEADLINE, TIMEOUT, BUSY or other error) |
| `verify8`: the same during an 8-check verify, on a tree with 80 MB untracked | hook p99 at most 400 ms; `jevris status` p99 at most 1 s; ping p99 at most 100 ms |
| both runs above | event-loop delay p99 at most 50 ms in every 1 s window; no stall over 200 ms |
| `subagents50`: 50 concurrent subagents | every hook answered, or BUSY within 50 ms; at most 1% past the deadline |
| `history`: one session, 2600 sequential events | p50 of events 2401 to 2600 at most 1.5 times the p50 of events 1 to 200 |
| `lifecycle`: compact restores and Stop reminders during 20 subagents | never queued, never past the deadline |
| `lifecycle50`: PreCompact, compact restores and Stop, sent in the same tick as 50 subagents | never answered BUSY |

The `lifecycle50` hooks start in the same tick as the subagent burst, so they race it for the hot slots. Before the sidecar's answer lane, 12 of 36 of them were answered BUSY; with it, none are.

How the run works:

- **Isolation.** Every scenario runs in a child process with its own sandbox: a temporary home in the test environment (`JEVRIS_TEST=1`, the keyring blocked), stub harness binaries, and a fresh sidecar.
- **Timing.** An instrumented entry records event-loop delay each second. Measuring starts once the sidecar's start-up work has settled.
- **Nothing real.** No model is called, no real harness starts, and the real home is never touched.
- **One at a time.** The run holds the host suite lock, so no full suite runs beside it.
- **Other machines.** The numbers still print there, but only a full run on the reference machine counts.
- **The gate.** `--evidence <file>` writes a `sidecar-load` release-evidence record. The `perf.sidecar-concurrency` gate in `jevris gates` accepts only a full run on the reference machine, for the release version and commit, less than 14 days old.

The targets and the reference machine are defined once, in `apps/cli/src/release-gates.ts` (`SIDECAR_LOAD_TARGETS`, `SIDECAR_LOAD_REFERENCE`).

## Continuous integration

`.github/workflows/ci.yml` runs nine cells: `ubuntu-latest`, `macos-latest` and `windows-latest`, each on Node `22.14.0`, `24` and `latest`, with `fail-fast: false`. Every cell runs `npm ci --ignore-scripts`, `npm rebuild esbuild` (why: [development.md](development.md#setup)), `npm run build`, `node scripts/emit-hook.mjs --check`, `npm run check:clean`, `npm run lint`, `npm test`, `npm run check:pack` and `npm audit signatures`. `check:clean` fails when the build changed a tracked file or wrote a new file that `.gitignore` does not cover, for example a committed generated file such as `plugins/shared/mcp.js` that is out of date. It names the command that regenerates each file. The Linux cells also run two opt-in tests by path: the cross-user sidecar refusal with a real second OS user, and the container locality test, which starts the sidecar in a real `node:24` container sharing the home and checks that the host and a second container get `FOREIGN_LOCALITY`. A separate `coverage` job on Ubuntu with Node 24 runs `npm run coverage`, which fails below a package's floor, and uploads the `coverage/` directory as an artifact. The `pack-smoke` job packs the tarball on each OS with Node 22.14.0, installs it into a temporary prefix, and runs every command against a temporary HOME with stub harness binaries (`node scripts/pack-smoke.mjs --full --npx`). The full smoke also runs the eight operations drills (crash, read-only store, corrupt store, disk full, interrupted update, stale result, rollback, offline) against the installed package, and then the threat-model suite runs. The job uploads the installed end-to-end, operations-drills and threat-model records that the release gates read. CI never runs the live-harness smoke and uses no secrets.

**Doctor proves it works.** `node scripts/pack-smoke.mjs --full`, which the CI pack-smoke job runs on each OS, has one more check. In a sandbox home of its own, the installed tarball installs into all five harnesses. The harnesses are certifiable stand-ins from `apps/cli/test/harness-cli-stubs.mjs`, first on PATH inside the sandbox temp folder, with `JEVRIS_LIVE_HARNESS=1`. The tarball then runs `jevris certify --harness all`, and `jevris doctor --json` must read `installStatus` full, `harnessProbe` certified and `eventProbe` passed. Every installed harness must have a certification record and a passing MCP and hook smoke. No line may have severity action or broken, with two exceptions. The first is the Codex `/hooks` trust line, which doctor cannot observe. The second is a harness line whose only miss is a feature certified by a stub-model turn (`hooks.route`, `session.route`, `models.list-hosts`, `route.host`, `worker.actual-model`). A stand-in harness starts no turn, so those features are proved only by the live certify run, and the pass line names the harnesses where this applied. No private file may be looser than 0700 or 0600. `scripts/doctor-proof.mjs` names each item that fails.

The `bench (<os>)` job runs the benchmark harness on each OS with Node 24 after the build: `node apps/sidecar/scripts/bench.mjs`. It measures cold start, warm start, the IPC round trip, a hot-path and a background rules decision, and a semantic decision against a local Jev stub. It uploads its record as the `bench-<os>` artifact, kept for 90 days. The job fetches the baseline, the `bench-<os>` record of the latest successful `ci` run on `main`, with `gh run download`. That needs `actions: read` on the job and on `release.yml`'s `ci` job. Then it runs with `--baseline <record> --ratio 1.5 --slack-ms 10`, and fails when any p95 is worse than baseline × 1.5 + 10 ms. When no earlier record exists (the first run, or after the retention ends), it only records. Hosted runners vary, so this checks regressions only; the absolute latency targets need reference hardware. The bench job is not a required status check on `main`. The release workflow runs the whole CI workflow with the `bench-advisory` input, so there a failed benchmark step is recorded and reported in the job summary but does not stop the publish; the sidecar-load gate (above) covers performance for a release. To reproduce it locally:

```bash
npm run build
node apps/sidecar/scripts/bench.mjs --out bench.json                       # record
node apps/sidecar/scripts/bench.mjs --baseline bench.json --out bench-2.json  # compare
```

The required status checks on `main` are these twelve job names:

- `test (ubuntu-latest, 22.14.0)`
- `test (ubuntu-latest, 24)`
- `test (ubuntu-latest, latest)`
- `test (macos-latest, 22.14.0)`
- `test (macos-latest, 24)`
- `test (macos-latest, latest)`
- `test (windows-latest, 22.14.0)`
- `test (windows-latest, 24)`
- `test (windows-latest, latest)`
- `pack-smoke (ubuntu-latest)`
- `pack-smoke (macos-latest)`
- `pack-smoke (windows-latest)`

A repository admin applies them, together with `codeql (javascript-typescript)` and `dependency-review`, with one command:

```bash
node scripts/branch-protection.mjs            # print the payload (dry run)
node scripts/branch-protection.mjs --apply    # gh api PUT repos/CryptVenture/Jevris/branches/main/protection
```

Supply-chain checks: `codeql.yml` (CodeQL for JavaScript and TypeScript), `dependency-review.yml` (fails a pull request that adds a dependency with a moderate or worse advisory), `.github/dependabot.yml` (weekly npm and Actions updates). Every action is pinned by a full commit SHA, with the version in a comment.

Reproduce one cell locally:

```bash
node scripts/ci-cell.mjs                                  # this OS and this Node, on a clean copy of HEAD
node scripts/ci-cell.mjs --docker --node 22.14.0          # a Linux cell in the node:22.14.0 image
node scripts/ci-cell.mjs --docker --node 24 --working-tree --steps ci,build,test
```

Docker cells run as the image's unprivileged `node` user with `--init`, like a runner VM. `--working-tree` includes uncommitted files.

## What the suite covers

- **Workspace tests** (`<workspace>/test/*.test.mjs`): each package's behaviour through its built `dist`, including install and uninstall for all five harnesses, doctor and certification, the sidecar and its IPC, the store and its migrations, the decision engine, routing and route learning, the orchestrator and every owned-worker driver (against stub harness binaries), the MCP server and the hook launcher.
- **Acceptance** (`test/acceptance/`): one file per specification user story (`us01` to `us40`, from `fixtures/ssot/user-stories.json`) and workflow (`w01` to `w12`), asserting each Then clause through the product CLI, MCP and hooks. `node scripts/acceptance-report.mjs --out <dir>` reports them for the release gates.
- **Quality** (`test/qa/`): seeded property and state-machine suites of at least 1,000 runs that print their seed on failure, concurrency and crash-point tests, and contract and hook-stdin fuzzing.
- **The specification's reference suite** (`fixtures/ssot/reference/tests.mjs`), a byte-identical copy of the specification's frozen reference handoff. `fixtures/ssot/` also holds the specification's examples and JSON Schemas, which the contracts tests round-trip.

US36, the certified Windows launcher, stays pending until a Windows runner records its certification (`jevris certify --harness claude` there), so the story report reads 39 of 40 until then. Every workflow has a test.

## What the suite does not certify

- The installed `claude` binary's timeout behavior
- A live `https://api.typesafe.ai` round trip
- Hook semantics on a version you have not probed
- Coding quality of a model
- Windows behavior, until the `windows-latest` cells have run on GitHub Actions. Windows code paths (paths, ACLs, `.cmd` shims, rename retries) are unit-tested on every OS with an injected `platform` and fake ports.

The live Jev suite runs only with `JEVRIS_LIVE_JEV=1` (`npm run smoke:jev`, or the manual `live-jev.yml` workflow), never in `npm test`. A live suite that did not run is not a failed live call.

Its evidence record (kind `api-live-suite`) holds numbers and codes only, never a key, a request or a response body. Every latency call is one row: its elapsed milliseconds, whether it was ok, and for a failure its failure kind, HTTP status and reason code. `reasonCounts` counts the failed calls per reason code, and each error probe records its elapsed milliseconds too, so a failed run can be diagnosed from the record alone.

The suite measures; it does not decide. Every call, the error probes included, runs under a 10 s measuring timeout (the SDK's documented default), not the 900 ms hot-path budget. A slow call is then a measured latency instead of a `DEADLINE`, and an invalid key or model gets time for the provider's own 401 or 400. The record gives the uncensored p50, p95, p99 and max, the calls within the 900 ms budget (`withinBudget`, `withinBudgetFraction`) and whether p95 meets the 800 ms target (`p95WithinTarget`). Those are engineering targets, unmeasured until benchmarked, so they are recorded, not a pass bar: `passed` covers the API behaviour the release gate needs (primitives, cancellation, caps, the conservative estimate, the probes and the pinned model), and every latency call must still succeed. The product's hot path keeps its 900 ms budget. How `jevris gates` judges the record: [RELEASING.md](../RELEASING.md#the-api-gate). `npm run smoke:jev -- --mock` runs the same suite against the conformance mock.

On a machine with a real managed Jevris policy (see [configuration.md](configuration.md#managed-policy-administrators)), the tests that need an unmanaged host skip, and the runner prints one line naming the policy's location.

## Adding a test

1. Add `something.test.mjs` under the package `test/` directory.
2. Import the built module the same way existing tests do (`../dist/cli.js`, or the workspace package name). Use a temp home (`--home`) for anything that installs. With `JEVRIS_TEST=1`, install, uninstall, doctor, certify and `data delete` refuse to run without an explicit temporary home (exit 2, `HOME_REQUIRED_IN_TEST`) or against the real home (`REAL_HOME_IN_TEST`), and write nothing.
3. Assert plain text. Do not require ANSI color.
4. Run it alone with `node scripts/test.mjs <file>`, then run `npm test`. Never spawn a harness binary by name. Inject a stub path instead.

Do not point tests at `fixtures/ssot/reference` from a product package.
