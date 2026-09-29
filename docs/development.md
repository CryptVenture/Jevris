# Development

## Layout

```text
apps/cli          the jevris command: public commands, install, doctor, gates
apps/sidecar      the local authenticated service commands and hooks talk to
apps/hook         the hook launcher, bundled as one closed file
packages/*        contracts, core rules, store, orchestrator, provider, evals, languages,
                  platform (paths, spawn, durable writes), mcp, one adapter per harness
plugins/          one shared plugin source (plugins/shared: skills, mcp.js, the Kilo/OpenCode
                  plugin template shim.js) and each harness's own manifests; install
                  renders every harness's files from them into the target home
packs/            the policy packs the package ships (memory, observability, skill-advice)
assets/           runtime data the product reads (schemas, support matrix, trust store,
                  cost registry and evaluation corpus)
scripts/          build, bundle, test runner, pack smoke, release and docs tooling
test/, lint/      repository-level tests and lints; each workspace also has test/
fixtures/         test fixtures, never read at runtime: fixtures/ssot holds the specification's
                  examples, schemas, user stories and frozen reference suite, and
                  fixtures/registry the model and cost registry proposals
docs/             this documentation
bin/jevris.mjs    the package entry: checks Node-API, then loads dist/cli.mjs
```

## Setup

Node `^22.14.0 || >=23.6.0`, then from the root:

```sh
npm ci
npm run build      # tsc -b over the project references, emit plugin files, bundle dist/
npm run lint       # repository and workspace lints
npm test           # builds first, then every *.test.mjs under a temporary HOME
node bin/jevris.mjs --help
```

`npm run build` is the supported build. It runs `tsc -b` on the root `tsconfig.json` (never `tsc -b -p`), `scripts/emit-hook.mjs` (the generated plugin sources `plugins/shared/mcp.js`, `plugins/shared/shim.js` and `plugins/claude/hooks/hooks.json`, checked against their packages) and `scripts/bundle.mjs`, which bundles every workspace into `dist/` and fails when:

- a bundle imports anything but Node built-ins and the three runtime dependencies;
- the hook bundle's graph reaches the store, an SDK or the keychain;
- a workspace uses a dynamic `import()` with a non-literal argument;
- a runtime file names a development-only tree such as `fixtures/`.

A workspace that imports another must list it in its `package.json` dependencies and its `tsconfig.json` references, or a clean `tsc -b` fails.

## One plugin source

Git keeps one copy of each plugin file. `plugins/shared` holds the skills, the MCP server and the Kilo Code and OpenCode plugin template; each harness folder holds only that harness's own manifests. Install renders the rest into the target home. `lint/dry.lint.mjs` fails when a generated plugin file is tracked, when anything is written to `dist/plugins`, or when two plugin files are identical or nearly so (the same after whitespace and case, or 90% of their lines shared). The allowed file list is `PLUGIN_FILES` in `scripts/release-policy.mjs`.

## Useful scripts

| Command | What it does |
| --- | --- |
| `npm run verify:fresh -- [--overlay <path>...] [--future-days N]` | The full CI check of a commit, on a fresh clone instead of your working tree. It clones HEAD into a temporary folder and copies the named working-tree paths over it; a path that no longer exists but is in HEAD is deleted in the clone, and a path in neither is refused (exit 2). The last line names the overlay (`PASS at <commit> with 3 overlay path(s): 2 copied, 1 removed`). It then runs `npm ci`, the build, lint, the suite once under coverage (`scripts/coverage.mjs`, so a package below its floor in `coverage-floors.json` fails the test step, as in CI), `docs --check` and `check:pack`, and `test:future` when `--future-days` is given. Before every step it checks that it is in the clone, never this checkout, including from paths with spaces. It waits its turn for the host suite lock (below), prints the exact counts and removes the clone; logs are kept on a failure. `--dir <parent>` picks the temporary folder, and `--keep` keeps the clone |
| `npm run test:future -- --days N` | The suite with every test process, and each Node child it starts, living N days ahead (default 90): `Date` and file times move together. A test that fails only here depends on today's date (a fixed date beside a real-clock one, an expiring fixture, or a bundled model reaching its retirement date) |
| `npm run coverage` | The suite with coverage; fails below a package's floor in `coverage-floors.json` |
| `npm run check:clean` | After a build, fails when the build changed a tracked file or wrote one `.gitignore` does not cover, and names the command that regenerates it |
| `npm run registry:check` | After a build, validates the model and cost registry proposals and the registry bundled with the product, including the sources of its serving hosts. It warns (`WARN`, exit 0) about each bundled model the router still recommends that may retire within 30 days, is past its "not sooner than" date (`MODEL_RETIREMENT_DUE`) or is deprecated, and about each bundled promotional price whose announced end (`validUntil`) is within 30 days or has passed; the release gate warns on the same models and fails only on inconsistent data ([RELEASING.md](../RELEASING.md#evidence-and-the-gates), model retirement). See [model-refresh.md](model-refresh.md) |
| `node scripts/safe-commit.mjs -F <message-file> --check -- <path>...` | Optional. Commits only the named paths from a pinned base, race-safe in a checkout others commit to at the same time (see [CONTRIBUTING.md](../CONTRIBUTING.md#commits)) |
| `node scripts/suite-lock.mjs -- <command>` | Runs a command under the checkout's suite lock; `--status` names the holder. `--host-status` names the holder of the host suite lock. That lock is machine-wide: `npm run test:future`, `npm run verify:fresh` and every Docker cell or suite-running `ci-cell.mjs` run one at a time on this machine, queued with a `waiting for suite lock held by pid N since T` line. Single test files and lint never wait for it. It lives in the system temp directory and records only a pid and a start time; a lock whose pid is dead is taken over |
| `JEVRIS_LIVE_HARNESS=1 npm run smoke:harness` | Certifies each real harness binary on `PATH` in temporary profiles (opt-in; never in `npm test`) |
| `npm run check:pack` | Packs the tarball and checks its file list, size budget and bundle policy, and that it ships each plugin file once (no rendered harness tree, no duplicate) |
| `npm run smoke:pack` | Installs the packed tarball into a temporary prefix and home and runs every command (`-- --full --npx` for the whole matrix, the operations drills and the doctor proof) |
| `npm run bench:load -- [--quick] [--only <scenario,...>] [--out <file>] [--evidence <file>]` | After a build, the sidecar load run: 20 and 50 concurrent subagents, the same during an 8-check verify, 2600 events in one session, and restores and Stop reminders under 20 and under 50 subagents, each in a temporary home. It prints every locked target and exits 1 when one is not met; the reference machine and the `perf.sidecar-concurrency` gate are in [testing.md](testing.md#sidecar-load-npm-run-benchload). It holds the host suite lock and is never part of `npm test` |
| `npm run docs` | Regenerates `docs/cli.md` and `docs/platform-support.md` from the built product. The platform page also reads the accepted certification records in `release-evidence/`, so an uncommitted record there changes it: do not commit the page from such a checkout. `npm run docs -- --check` exits 1 when a page is stale |
| `node scripts/emit-hook.mjs --check` | Fails when a committed generated plugin file drifted from its source |
| `node scripts/ci-cell.mjs --docker --node 22.14.0` | Runs the Linux CI cell in Docker |
| `node scripts/repeat-tests.mjs [--runs N]` | After a build, runs the hook and sidecar suites 20 times in a row (the weekly `stability` workflow) |

## Compiler contract

`tsconfig.base.json`: target and lib ES2022, `module` and `moduleResolution` NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `types: []`, declarations on. TypeScript 7.0.2.

## Conventions

- Per-OS differences go through `@jevris/platform` (paths, spawning, atomic writes, owner-only files). No other package spells an OS difference.
- Money is integer micro-USD (`bigint` in the store). Never a `number` for currency.
- Hook and MCP commands are `node` plus an absolute path inside the installed runtime copy. Never `npx`.
- Error and log text carries reason codes, never a request or response body, a secret or source text.

## Specification

The maintainers keep the specification, requirements, roadmaps and milestone history outside this repository. The parts the tests check against are copied into `fixtures/ssot/`: the specification's examples and JSON Schemas, its user stories (the acceptance suite asserts every Then clause) and the frozen reference suite, which `npm test` builds and runs. Revalidate vendor facts (model id, price, SDK version, harness events) before treating them as current. Model ids, prices and capabilities are refreshed with the procedure in [model-refresh.md](model-refresh.md), then checked with `npm run registry:check`.
