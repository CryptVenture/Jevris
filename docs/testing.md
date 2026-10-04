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
4. Runs the latency-bound files last, each one alone, in the same `node --test` run (or, when the list is split into batches, each in a run of its own: see 5). These are the files whose assertions are wall-clock latency targets: an answer inside a hook deadline, a maintenance write under 50 ms, BUSY before a client deadline. They are listed in `SERIAL_TEST_FILES` in `scripts/test.mjs`:
   - `test/sidecar-lifecycle-load.test.mjs`
   - `apps/sidecar/test/maintenance-worker.test.mjs`
   - `apps/sidecar/test/daemon.test.mjs`
   - `packages/mcp/test/surface-e2e.test.mjs`
   - `packages/orchestrator/test/verify-background.test.mjs`

   Next to the suite's own parallel files, a host is loaded far past what those targets describe, so these files failed there while passing alone. The runner lists them after every other file, but node:test sorts the files it is given, so they can start early. `scripts/test-serial-gate.mjs`, imported into each test process, keeps each of them alone with a lock that both kinds of file respect. A serial file waits until no parallel file that has started is still running, then takes the lock. A parallel file that starts while a serial file holds the lock waits for it. A file that node:test has not started yet is never waited for, so waiting serial files cannot hold every slot while the files they wait for never start (the 20-minute stall in the first CI run). Their assertions are unchanged. Because it is still one run, coverage, the test events and the summary are that run's own. Each wait is capped at 60 minutes (`JEVRIS_SERIAL_GATE_WAIT_S`): on windows-latest the parallel files alone run for more than 20 minutes. A capped wait names the running parallel files it went ahead of, with their pids, on the serial file's stderr and again after the run (`serial gate: ... waited N s, its cap, and went ahead of ...`). After the run the runner also prints the 15 slowest files, each with its time from start to exit (`test: slow file N s <path>`). A file named on the command line follows the same rule.
5. Keeps the command line short enough. A `node --test` over every file takes one command line, and Windows refuses a command line over 32,767 characters (`spawnSync node ENAMETOOLONG`, with no test run at all): about 560 test files under a checkout such as `D:\a\Jevris\Jevris\` were past it. So the runner (`runTestFiles` in `scripts/test.mjs`, with the arithmetic in `scripts/argv-batches.mjs`) counts the command line first. A list that fits its budget (20,000 characters on Windows, 100,000 on Linux and macOS, which allow far more) is one `node --test`, in one process, exactly as above. A list that does not fit is handled in one of two ways.
   - A coverage run (`npm run coverage`) is never split, because branch coverage does not merge across processes: a merged report read about ten points low on branches in a trial. The full suite names its files as about twenty glob patterns instead (`apps/cli/test/*.test.mjs` and so on, from `testPatterns`), which `node --test` expands itself: the same files, one process, one coverage report. A coverage run of named files that does not fit stops with exit code 2 and asks for fewer files.
   - Any other run is split. The files other than the latency-bound ones run in as few batches as fit, one after another, in the order listed, and then each latency-bound file runs alone in a `node --test` of its own, after every other file has finished. All of them share the environment, the temporary home, the serial gate, the file bound and the suite lock, and every batch runs even when an earlier one failed, as one run runs every file. The run still reports once: each batch's counts are added into one summary (`ℹ tests N`, `ℹ pass N` and the rest, the lines `verify:fresh` reads) and the batches' event lines are joined into the one events file. The exit code is the first batch's non-zero code. The batches use the spec reporter on every Node version.

   When the run does not go in one process of file names, it first prints `test: N test files need a command line of M characters, over the budget of B ...` and says which of the two it does. `JEVRIS_TEST_ARGV_BUDGET=<characters>` (at least 1000) replaces the budget, to force that on any host: `JEVRIS_TEST_ARGV_BUDGET=1000 node scripts/test.mjs`. The runner does not pass that variable on to the test processes. `scripts/lint.mjs` batches its files the same way, and `lint/runner-argv.lint.mjs` fails on any script that starts `node --test` with a file list of its own. `test/test-runner-batches.test.mjs` checks the sizes for the real file set under a Windows runner root and a 200-character root, and that the patterns expand to exactly the suite's files.
6. Bounds every test file. `--test-timeout` (300 s) ends a test on Node 24 and later; Node 22 and 23 apply it to each whole file, so the runner passes it only on 24 and later (`testTimeoutArgs` in `scripts/test.mjs`). It does not end a file whose tests are done while its process stays up, for example on a leaked child that holds its pipes open. `scripts/test-file-bound.mjs`, imported into each test process after the serial gate, notes each write the file's process makes (node:test streams every test event through it). A file silent for `JEVRIS_TEST_FILE_SILENT_S` (default 600 s) prints `test file bound: <file> was silent for 600 s ...; it and the N process(es) it started were ended (FILE_SILENT_BOUND)`, sends SIGTERM and then SIGKILL to every process it started, and exits 1. The run reports that file as failed and ends. A latency-bound file's wait for its turn does not count.

Every run is isolated from your machine:

- **Temporary home.** `HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `JEVRIS_HOME` point into a fresh temp folder. The runner fingerprints the real home's Jevris-relevant paths before and after the run, and fails if they changed. `JEVRIS_HOME_GUARD=off` disables this check on unusual hosts. When it fails, it lists each added, removed or modified path with its time. A change made during the run by you or another program also trips it. There are two exceptions. The first is your own running sidecar: when `~/.jevris/run/endpoint.json` names a live sidecar serving your home, its routine refresh of `run/locality.json` and `statusline.json` is not counted. The second is a live Jevris install: an install receipt from before the run, or one you write during it by installing (no test process recorded it). Your own harness sessions keep writing to its folders during the run (hook deliveries, the store and its WAL, harness versions, logs), and a reinstall rewrites the harness files its receipts list (such as `~/.claude/plugins/jevris-local`). So a change that no test process wrote, inside the Jevris folders (`~/.jevris`, or the XDG and AppData equivalents) or at a path an install receipt lists before or after the run, is summarised as the live install's, per folder, and does not fail the run. Any other change in the guarded paths, such as a harness file no receipt names, still fails it. The test preload records every write a test process makes anywhere under the real home, in each child process it starts too (even with an explicit `env`), and including native SQLite databases opened for writing. It guards your real `XDG_CONFIG_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `APPDATA` folders the same way, even when they are outside the home. Any recorded write fails the run and is listed with the test file it came from; a child process carries its parent's test file. The ledger holds paths only. Paths inside the checkout and the temp folders are not counted as the home's.
- **Temporary folder.** Each run makes one folder under the OS temp directory, `jt-<random>`, and it holds everything the run creates. `TMPDIR`, `TMP` and `TEMP` point at it for every test process, and the temp HOME and the harness stubs live inside it. The runner removes the folder at the end, so a temp dir that a test forgets cannot pile up. `JEVRIS_KEEP_TEST_DIRS=1` keeps the folder for debugging. The test preload records every directory a test process creates directly in the real temp directory. The run fails when any of those are left, and it names them. Folders that other programs or concurrent runs create there never count, and neither does the live runtime folder `jevris-<uid>`. `JEVRIS_TEMP_GUARD=off` disables the check. Pack smoke gives each sandbox its own `TMPDIR` inside its work folder, and `scripts/ci-cell.mjs` uses a `jc-cell-<random>` scratch folder.
- **Removal on Windows.** A handle closes some time after its process exits, so on Windows a recursive, forced removal of a folder inside the run's temporary folder is retried for up to 30 s on `EPERM`, `EBUSY`, `ENOTEMPTY` or `EACCES` (`scripts/test-windows-remove.mjs`, loaded by the test preload). `scripts/remove-tree.mjs` does the same and names the processes that may still hold the folder.
- **Sidecar start wait.** Under a test run, JEVRIS_SIDECAR_WAIT_MS sets the CLI's sidecar autostart wait (the runner sets 60000; at most 60 s), because a cold start on a loaded host can outlast the product's 5 s. A story's sandbox keeps it.
- **No keychain.** `JEVRIS_TEST=1` plus a preload stop any test process from loading `@napi-rs/keyring`, so no OS credential store is opened. Code that needs a keyring gets a memory one injected.
- **No real harness.** Stub `claude`, `kilo`, `opencode`, `codex` and `agy` executables come first on `PATH`. The stubs log each call and exit 1. `JEVRIS_NO_LIVE_HARNESS=1` makes the probe code refuse a PATH lookup unless a binary path is injected. Every child process is killed as a whole tree on timeout.
- **The tripwire.** In a test run, the product refuses to start a real harness binary, or the macOS `security` tool, from outside the run's temporary folder: it throws a "test tripwire: refused to start the real ..." error instead. A harness login probe (`claude auth status`, `codex login status`) and the background certification re-check never run under a home that is not the OS account's own, so a real harness can never look for a keychain that is not there and open a "keychain cannot be found" dialog. `apps/cli/test/keychain-guard.test.mjs` holds these rules.
- **No real home in a test file.** A test never calls `os.homedir()`: run directly with `node --test <file>`, that is the real home. `lint/test-hygiene.lint.mjs` fails on it. Use a temporary directory or a sandbox's own home.
- **No machine-wide harness location.** A test result must not depend on which harness or app is installed. Product code reads the macOS `/Applications` folder or Claude Code managed settings (`/Library/Application Support/ClaudeCode`, `/etc/claude-code`) only through one module each, behind `liveHarnessAllowed`, which refuses in a test run (`JEVRIS_TEST`, a node test context or `JEVRIS_NO_LIVE_HARNESS`; `JEVRIS_LIVE_HARNESS=1` lifts it for a live smoke). `lint/isolation.lint.mjs` fails on any other file that names those locations.

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
2. Runs `npm ci --ignore-scripts` and `npm rebuild esbuild` (as CI installs; see [development.md](development.md)), `build`, `clean`, `lint`, `test`, `docs --check` and the pack check there. The test step runs the suite once under coverage, as `npm run coverage` does, and fails when a package falls below its floor in `coverage-floors.json`; its line names the packages below their floors. With `--future-days N`, it also runs `test:future`.
   The `clean` step is CI's "Build leaves the checkout unchanged" (`npm run check:clean`, which runs `scripts/check-clean-tree.mjs`). The script commits your overlay in the clone first, so the check sees only what the build changed. If the build changes a tracked file or writes a new one that `.gitignore` does not cover, the step fails and stops the run, on one line with each path and the command that regenerates it, for example `changed: plugins/shared/mcp.js (regenerate: npm run build ...)`. That is a generated file you overlaid or committed out of step with its sources: regenerate it from the same sources you commit, and overlay it.
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

`.github/workflows/ci.yml` runs nine cells: `ubuntu-latest`, `macos-latest` and `windows-latest`, each on Node `22.14.0`, `24` and `latest`, with `fail-fast: false`. Every cell runs `npm ci --ignore-scripts`, `npm rebuild esbuild` (why: [development.md](development.md#setup)), `npm run build`, `node scripts/emit-hook.mjs --check`, `npm run check:clean`, `npm run lint`, `npm test`, `npm run check:pack` and `npm audit signatures`. `check:clean` fails when the build changed a tracked file or wrote a new file that `.gitignore` does not cover, for example a committed generated file such as `plugins/shared/mcp.js` that is out of date. It names the command that regenerates each file. The Linux cells also run three opt-in tests by path: the cross-user sidecar refusal with a real second OS user, the container locality test, which starts the sidecar in a real `node:24` container sharing the home and checks that the host and a second container get `FOREIGN_LOCALITY`, and the ORC-12 test in `packages/orchestrator/test/control-service.test.mjs`, which runs two client containers against a service container on a private Docker network (it skips in `npm test` unless `JEVRIS_TEST_DOCKER_IMAGE` names an image and Docker answers; that step sets it to `node:24`). The Windows cells have 120 minutes, the others 30; the Windows limit is to be set from a measured whole-suite run (the runner prints the slowest files). A `windows-first` job runs, on Windows with Node 24, the tests of the file primitives every private write and authority read rest on (the real `icacls` and `whoami`, and the stats of a path and its open descriptor) and a few sandboxed CLI tests, so a Windows failure there shows in minutes. A separate `coverage` job on Ubuntu with Node 24 runs `npm run coverage`, which fails below a package's floor, and uploads the `coverage/` directory as an artifact. The `pack-smoke` job packs the tarball on each OS with Node 22.14.0, installs it into a temporary prefix, and runs every command against a temporary HOME with stub harness binaries (`node scripts/pack-smoke.mjs --full --npx`). The full smoke also runs the eight operations drills (crash, read-only store, corrupt store, disk full, interrupted update, stale result, rollback, offline) against the installed package, and then the threat-model suite runs. The job uploads the installed end-to-end, operations-drills and threat-model records that the release gates read. CI never runs the live-harness smoke and uses no secrets.

**Doctor proves it works.** `node scripts/pack-smoke.mjs --full`, which the CI pack-smoke job runs on each OS, has one more check. In a sandbox home of its own, the installed tarball installs into all five harnesses. The harnesses are certifiable stand-ins from `apps/cli/test/harness-cli-stubs.mjs`, first on PATH inside the sandbox temp folder, with `JEVRIS_LIVE_HARNESS=1`. The tarball then runs `jevris certify --harness all`, and `jevris doctor --json` must read `installStatus` full, `harnessProbe` certified and `eventProbe` passed. Every installed harness must have a certification record and a passing MCP and hook smoke. No line may have severity action or broken, with two exceptions. The first is the Codex `/hooks` trust line, which doctor cannot observe. The second is a harness line whose only miss is a feature certified by a stub-model turn (`hooks.route`, `session.route`, `models.list-hosts`, `route.host`, `worker.actual-model`). A stand-in harness starts no turn, so those features are proved only by the live certify run, and the pass line names the harnesses where this applied. No private file may be looser than 0700 or 0600. `scripts/doctor-proof.mjs` names each item that fails.

The `bench (<os>)` job runs the benchmark harness on each OS with Node 24 after the build: `node apps/sidecar/scripts/bench.mjs`. It measures cold start, warm start, the IPC round trip, a hot-path and a background rules decision, and a semantic decision against a local Jev stub. It uploads its record as the `bench-<os>` artifact, kept for 90 days. The job fetches the baseline, the `bench-<os>` record of the latest successful `ci` run on `main`, with `gh run download`. That needs `actions: read` on the job and on `release.yml`'s `ci` job. Then it runs with `--baseline <record> --ratio 1.5 --slack-ms 10`, and fails only for a regression that repeats (next paragraph). When no earlier record exists (the first run, or after the retention ends), it only records. Hosted runners vary, so this checks regressions only; the absolute latency targets need reference hardware. The bench job is not a required status check on `main`. The release workflow runs the whole CI workflow with the `bench-advisory` input, so there a failed benchmark step is recorded and reported in the job summary but does not stop the publish; the sidecar-load gate (above) covers performance for a release.

**How the bench gate decides (OBS-04).** A single p95 against a single earlier run is not a stable signal on hosted runners: between two runs the median of a series moves by 2 to 4 times, and a p95 over a handful of samples is one stalled request. Replaying the old rule (p95 above baseline × 1.5 + 10 ms) over the records of eight CI runs with no relevant code change tripped a series in 12 of 21 runs, and six alternating local rounds of 0b1237d against 0685dba measured the same. So the gate in `apps/sidecar/scripts/bench.mjs` works like this. It uses 8 cold starts, 100 rules decisions and 60 semantic ones. A series trips when its median is above baseline median × ratio + slack, or its p95 is above baseline p95 × 2 × ratio + 2 × slack. Before each pass the harness times three fixed workloads (a node start, a CPU loop and file fsyncs, `calibration` in the record); when this machine is slower than the baseline's on them, the limits widen by that ratio (at most 3 times), never narrow. Every series that tripped is then measured again alone on a fresh sidecar, up to `--rechecks` times (default 2), and the run fails only for a series that trips in the first pass and in every re-measure. The record written by `--out` is the first pass. A real slowdown moves the median, is not helped by a faster probe, and repeats, so it still fails: a 20 ms sleep added to the `recover` path fails the gate. The engineering targets (rules service p95 under 25 ms, launcher and IPC under 100 ms, semantic under 800 ms) are unchanged and are reported, not gated, on hosted runners.

To reproduce it locally:

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

The Jev feature suite (`JEVRIS_LIVE_JEV=1 npm run smoke:jev:features -- --evidence <file>`) is a second opt-in suite and never part of `npm test`. Where `smoke:jev` checks the API, this one runs every Jev decision the product makes through its real handler, engine and packet builders with fixed synthetic non-sensitive input: route slice classification, plan slice labels, check ranking, repeated-failure and new-task advice, the intent decisions C01 to C07, the security decisions C51 and C49, the worker-readiness question and every capability that asks Jev (C18 to C72, one case per consult site, run with source egress denied and approved in a temporary home), then the hot path through a real sidecar at the 900 ms budget (cold and cached, a burst of concurrent requests, a repeat sequence for the cache hit rate). Its record (`jev-features-suite-1`, not a release-evidence kind, never committed under `release-evidence/`) holds numbers and codes only: per case whether the call succeeded, whether our validators accepted the real answer, what Jev answered against the expected label and the rules, cold and cached time, tokens, micro-USD and why a rules fallback happened. The key comes only from the OS keystore through the product's resolver and everything else lives in a temporary home. The run stops at its caps (`--max-calls`, `--max-uusd` for the engine groups, `--sidecar-uusd` and `--hot-uusd` for the sidecars, which stop themselves on their own decision budget) and at the first 401, 402 or 403 or three 429s in a row. `--mock` runs the same suite against the conformance mock, which is what `npm test` does (`apps/sidecar/test/jev-features-script.test.mjs`, with one capability part), and each capability part has its own offline test that proves every case reaches Jev against the stub and that with egress denied no request carries a planted marker (`apps/sidecar/test/jev-feature-cases-*.test.mjs`). Real answers the suite observed are kept as numbers in `packages/provider-typesafe/test/fixtures/jev-real-answers.json` and replayed through the real engine by `real-answers.test.mjs`; a defect a live run finds gets a test built from the real shape.

On a machine with a real managed Jevris policy (see [configuration.md](configuration.md#managed-policy-administrators)), the tests that need an unmanaged host skip, and the runner prints one line naming the policy's location.

## Skipped tests

A skipped test must run on at least one CI job. The suite reports these skips on a green run (counts from run 36684174443, Node 24):

- **Linux and macOS, 4 skipped.** Three are Windows-only tests (`win32, real icacls ...` and the two `on Windows removeTree/rmSync ...` tests); they run on the Windows cells (`windows-first` runs the first two as well). The fourth is the ORC-12 container test, which needs Docker; the Linux cells run it by path in the `Container lease authority (ORC-12)` step.
- **Windows, 62 skipped.** POSIX-only tests: file modes, `sh` stubs, signals, uid and symlink privileges, and the launcher and shell-profile tests. Each runs on the Linux and macOS cells. Windows has its own tests for the same behaviour (fake `icacls`, `.cmd` stubs, `taskkill`).
- **A machine with a managed Jevris policy** skips the tests that need an unmanaged host (`managedHostSkip()` in `test/managed-host.mjs`). The runner prints one line naming the policy. No hosted runner has one, and no CI log prints that line.

Four files are never collected by `npm test` because they make billed or subscription model calls, and CI never runs them (no secrets, no live calls). Run one by hand with a model and a credential of your own, in a temporary home:

| File | What it checks | Run |
| --- | --- | --- |
| `apps/cli/test/live/claude-owned.live.mjs` | A real Claude Code owned session through the installed CLI (ORC-05), on a subscription login or an API key | `JEVRIS_LIVE_HARNESS=1 JEVRIS_LIVE_CLAUDE_MODEL=<model> CLAUDE_CODE_OAUTH_TOKEN=<token> node --test apps/cli/test/live/claude-owned.live.mjs` (or `ANTHROPIC_API_KEY=<key>`) |
| `apps/cli/test/live/codex-owned.live.mjs` | A real Codex owned session; the model is selected at turn start | `JEVRIS_LIVE_HARNESS=1 JEVRIS_LIVE_CODEX_MODEL=<model> OPENAI_API_KEY=<key> node --test apps/cli/test/live/codex-owned.live.mjs` (or `JEVRIS_LIVE_CODEX_AUTH=subscription`) |
| `packages/adapter-claude-sdk/test/live/owned-worker.live.mjs` | A live Agent SDK owned worker writes in its worktree and stops on abort (ORC-05, E-13); API key only | `JEVRIS_LIVE_HARNESS=1 JEVRIS_LIVE_CLAUDE_MODEL=<model> ANTHROPIC_API_KEY=<key> node --test packages/adapter-claude-sdk/test/live/owned-worker.live.mjs` |
| `packages/orchestrator/test/live/owned-worker-auth.live.mjs` | A subscription login runs through the Claude Code CLI worker and an API key through the Agent SDK (ORC-05) | `JEVRIS_LIVE_HARNESS=1 JEVRIS_LIVE_CLAUDE_MODEL=<model> CLAUDE_CODE_OAUTH_TOKEN=<token> node --test packages/orchestrator/test/live/owned-worker-auth.live.mjs` (or `ANTHROPIC_API_KEY=<key>`) |

Each file skips itself, with the missing variable named, unless `JEVRIS_LIVE_HARNESS=1` and a model are set. Build first (`npm run build`), because the orchestrator and SDK files import from `dist/`. The two opt-in files under `apps/sidecar/test/opt-in/` are not billed; CI runs them (see the CI section).

## Adding a test

1. Add `something.test.mjs` under the package `test/` directory.
2. Import the built module the same way existing tests do (`../dist/cli.js`, or the workspace package name). Use a temp home (`--home`) for anything that installs. With `JEVRIS_TEST=1`, install, uninstall, doctor, certify and `data delete` refuse to run without an explicit temporary home (exit 2, `HOME_REQUIRED_IN_TEST`) or against the real home (`REAL_HOME_IN_TEST`), and write nothing.
3. Assert plain text. Do not require ANSI color.
4. Run it alone with `node scripts/test.mjs <file>`, then run `npm test`. Never spawn a harness binary by name. Inject a stub path instead.
5. Write for a slow machine. The Windows CI cells run the whole suite in 25 to 40 minutes, start a process in seconds and answer a git call in seconds, so a test that assumes a fast host fails there and nowhere else. Wait for a condition with a generous bound (30 s or more; the wait ends as soon as the condition holds, so a fast host pays nothing), never a fixed sleep. Do not assert a step's exact run time such as "(0s)"; compare without the time text. Drive a deadline that is the behaviour under test with an injected clock or a deliberately stalled fake, not a tight real deadline. `lint/slow-ci.lint.mjs` fails a polling loop or a wait deadline under 10 s, a real sidecar start that waits under 10 s and an assertion that names an exact run time; an allowlist entry needs its reason. Asserting an elapsed-time window under 2 s is banned separately (QA-05, `lint/wall-clock.lint.mjs`). A test that abandons a Jev call at a deadline does not remove its Jevris home on a fixed sleep: the engine still settles the budget and the circuit breaker and ends the journal entry for that call, and it does a few durable writes before it sends. The test holds the stub's answer behind a gate and waits for the request to arrive, gives the call a long `lateGraceMs`, and in its cleanup waits on `trackEngine(engine).settled()` from `packages/provider-typesafe/test/engine-settle.mjs` before removing the home. A Stop test whose subject is a deadline reads the changed files once before the Stop, so a host that starts git slowly cannot turn the deadline under test into `CHECK_RELEVANCE_GIT_DEADLINE`. A test that drives a real engine gives its Jev calls a long deadline (`deadlineMs: 60_000` in the spec or the context) unless the deadline is the subject: the default is 2 s for the question helpers and 5 s for a consult, and a Windows runner took 2 s to 7 s for three calls (the engine's durable journal writes come before the request goes out), so the answer was `DEADLINE` where the test read Jev's. A test of the route op gives it a deadline object with a fixed time left (`{ budgetMs, remainingMs: () => n, expired: () => false }`, `fixedDeadline` in `packages/provider-typesafe/test/slice-classify.test.mjs`): the op's Jev wait is derived from it (the budget less 200 ms, and never more than the time left less 100 ms), so a budget of 60 200 gives a wait no loaded runner uses up and 900 gives the product's 700 ms. The one test of the real abandon holds the stub's answer behind a gate and asserts that the route returned while Jev had not answered, not how long that took. A gate (`jev.assist off`, mode off, the kill switch) is the answer's reason whatever the clock says, so a test of a gate also runs it with a deadline already past. Do not run `jevris verify` again to read a run's result: with no run under way it starts a second run, whose receipts land after the answer and replace the ones the test noted as the latest. Ask once, wait until `jevris sidecar status --json` reports `verificationRuns` 0, then read the status (`verifiedAfterRun` in `test/acceptance/us17.test.mjs`). A test that plans a service unit for another platform with that platform's own paths (`C:\Users\dev` on a macOS host) passes `pathRules` to `serviceInputForHome`, and reads the unit back in its own format; without `pathRules` the paths are this host's, which is what a test that writes the unit to a temp folder wants. `apps/sidecar/test/service-input-home.test.mjs` runs both. A test that reads a real sidecar's doctor view right after a start or a stop waits for the state it expects (`viewWhen` in `apps/cli/test/sidecar-view.mjs`, a 60 s bound): the view asks the sidecar for its health at its own short timeout, so one read on a loaded host can say `timeout` where the sidecar is only slow. A launcher test that asserts an exact reason such as `SIDECAR_STARTING` sets `JEVRIS_HOOK_DEADLINE_MS` to its largest value (4000), as the surface end-to-end does: under the 1500 ms default a slow start ends as `SIDECAR_TIMEOUT`. A test that reads the advisory record of the repeated-failure hook path gives `createRepeatedFailureHandler` a long `recordWaitMaxMs` (the product waits 250 ms and then answers without a decision id), and a test with a held gate proves the 250 ms bound itself; a test that starts many real engine calls at once gives `createSidecarEngine` a long `budgetLockTimeoutMs` (the budget file's lock gives up at 2 s and the call falls back to rules without sending). A test of the plan op that counts the journal's decisions does not race the op's 700 ms question: it gives the op an instant answer and runs the real engine's question in the background (`planOpEngine` in `packages/provider-typesafe/test/decision-engine.test.mjs`). An acceptance story that needs a check's outcome, its receipt or the task's receipts asks `jevris verify` once through `verifySettled` (`test/acceptance/verify-run.mjs`): the answer comes within 2 s and lists a slower check as running or queued, so when it does the story waits until the sidecar has no verification run under way and reads the same checks through the read-only status, and `renderVerify` renders the summary and the plain text from that settled payload, because a second `jevris verify` would start a second run. `--test-timeout` is 300 s per test on Node 24 and later, and a test that needs longer sets its own `timeout`.

Do not point tests at `fixtures/ssot/reference` from a product package.
