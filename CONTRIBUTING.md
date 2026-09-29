# Contributing

Changes land on `main` through a pull request that passes the required checks. Build what the documented behaviour in [docs/](docs/README.md) describes; do not add behaviour it does not. If you want to change that behaviour, open a feature request first.

## Set up

1. Use Node `^22.14.0 || >=23.6.0` (the same range the package supports). CI runs 22.14.0, 24 and the current release on macOS, Linux and Windows.
2. Fork `CryptVenture/Jevris` on GitHub, clone your fork, and create a branch from `main`.
3. From the repository root:

   ```sh
   npm ci
   npm run build
   npm run lint
   npm test
   ```

   `npm test` builds first, so `npm run build` is optional before it.
4. Read [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md), [docs/testing.md](docs/testing.md) and the pages in [docs/](docs/README.md) for the area you change.

## Rules that keep the product safe

- Native harness permissions stay authoritative. Nothing in Jevris grants a permission, widens a sandbox or answers a permission prompt.
- Jev gets only bounded questions (choose, score, none of the above). Completion is accepted only from independent evidence.
- No source leaves the machine without administrator consent. A repository file or a model summary is not consent.
- Secrets never reach logs, argv, error text or config files. `@typesafe-ai/sdk` belongs only in `@jevris/provider-typesafe`.
- An install never damages another tool's configuration: edits to shared files are receipt-based and reversible byte for byte.
- Product code never reads `fixtures/` at runtime, including the specification examples, schemas and reference suite copied into `fixtures/ssot/` for the tests. Runtime data lives in `assets/`.
- A dynamic `import()` of a workspace package uses a string literal, so the bundle includes it.

## Tests

`npm test` builds, then runs every `*.test.mjs` with `node --test` under a temporary `HOME`, stub harness binaries on `PATH` and the OS keychain blocked. So:

- A test never opens the real keychain: inject a memory keyring.
- A test never starts a real harness binary (`claude`, `kilo`, `opencode`, `codex`, `agy`). Inject a stub path; in a test run the product's tripwire throws rather than start a real harness binary from outside the run's temporary folder.
- A test uses temporary directories, never your real home or harness config, and never calls `os.homedir()` (`lint/test-hygiene.lint.mjs` fails on it). The runner fails the run when the real home's Jevris-relevant paths changed, or when a test left a folder in the real temp directory.
- A deadline test uses an injected clock and asserts the outcome; no test asserts a wall-clock window under 2 s.
- A test that pins its clock to a date signs and expires its fixtures at that same clock. A release signed on the real clock and checked at a pinned date fails once the real date passes it. `lint/pinned-clock.lint.mjs` flags the mix unless the pinned line says `// pinned-clock: <reason>`.
- A gate test is a paired conditional test: missing or invalid evidence gives not-a-pass, valid synthetic evidence gives pass.

Live suites (the Jev API, real harness binaries) are opt-in and never part of `npm test`. See [docs/testing.md](docs/testing.md).

`npm run build` and `npm test` take a lock on the checkout (`.jevris-suite.lock`), so a second build waits while a suite runs. A full `npm test` also waits for any other full suite on the same machine. `node scripts/suite-lock.mjs --status` and `--host-status` name the holder. Never remove a lock folder by hand. See [docs/testing.md](docs/testing.md#one-suite-at-a-time-on-a-machine).

## Commits

- One logical change per commit, in the [Conventional Commits](https://www.conventionalcommits.org) format (`feat(cli): ...`, `fix(store): ...`, `docs: ...`). `scripts/release-version.mjs` builds the release notes from them.
- Every commit builds and passes the tests on its own.
- Do not commit `node_modules/`, `dist/`, `.env`, API keys, tokens or remote response bodies.
- Before you push, run `npm run lint` and `npm test`. To check your committed branch the way CI does, run `npm run verify:fresh`: it clones `HEAD` into a temporary folder and runs `npm ci`, the build, lint, the suite under coverage, `docs --check` and the pack check there ([docs/development.md](docs/development.md#useful-scripts)).
- Optional: in a checkout that several people or agents commit to at once, `node scripts/safe-commit.mjs -m "<message>" --check -- <path>...` (or `-F <message-file>`) commits only the paths you name. It builds the commit from a pinned base in a private index, refuses a tree that changes any other path, compiles that exact tree with `--check`, and moves the branch with a compare-and-swap. Exit 0 committed, 1 refused (nothing written), 3 the branch moved meanwhile: run it again. In your own fork a plain `git commit` is fine.

## Model knowledge refresh

Model ids, tariffs and capabilities go stale. When you refresh them, or when a release needs current model facts, follow [docs/model-refresh.md](docs/model-refresh.md): the sources to fetch, how to date and cite each fact, and which files to update. Then run `npm run build && npm run registry:check`. It validates the model registry proposal (`fixtures/registry/`) against ModelRegistryContract and the JSON Schemas, every cost row with validatePriceRow, the cost figures that `section191` computes, and the registry bundled with the product. It prints one line per check and exits 1 on any failure.

## Pull requests

1. Push your branch to your fork and open a pull request against `main`. Use the pull request template.
2. State which documented behaviour the change serves, how you tested it, and what it deliberately does not do.
3. CI must pass: the nine test cells, the installed pack smoke on three operating systems, CodeQL and dependency review ([docs/testing.md](docs/testing.md#continuous-integration)). The branch must be up to date with `main`, and every review conversation resolved.

A green local suite is not a certification of a harness's hook behaviour or of a live Jev call.

## Documentation

User-facing behaviour belongs in `docs/`. `docs/cli.md` and `docs/platform-support.md` are generated: after changing a command's help text, run `npm run build && npm run docs`; `npm run docs -- --check` fails when either page is stale, and the release fails on it. `npm run lint` fails when a page documents a command, subcommand or flag the CLI does not have, links to a missing file, or repeats a retired claim.

## Releases

See [RELEASING.md](RELEASING.md).

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go to [SECURITY.md](SECURITY.md), not to a public issue.
