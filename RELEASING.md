# Releasing Jevris

Jevris is published to npm as one package, [`@cryptventure/jevris`](https://www.npmjs.com/package/@cryptventure/jevris). A release is a pushed tag. GitHub Actions builds the tag, publishes it with provenance to the `next` dist-tag, and attaches the release assets. Moving `latest` is a separate step, taken by the owner only when every release gate passes on evidence.

Nobody publishes from a laptop, and no workflow holds an npm token.

## One-time setup (repository owner)

| Step | Command or place |
| --- | --- |
| npm trusted publishing | On npmjs.com, package `@cryptventure/jevris`, Settings, Trusted publishing: GitHub Actions, repository `CryptVenture/Jevris`, workflow `release.yml`, environment `npm`. |
| GitHub environment `npm` | Repository Settings, Environments, `npm`. Restrict it to tags matching `v*.*.*` and add required reviewers. |
| GitHub environment `live-api` | Holds the secret `JEVRIS_JEV_API_KEY` for the manual live Jev suite (`live-jev.yml`). Add required reviewers. |
| Branch protection | `node scripts/branch-protection.mjs` prints the payload; `node scripts/branch-protection.mjs --apply` applies it with your own `gh` login. |
| Reserve the unscoped name | `node scripts/reserve-unscoped.mjs --publish` publishes a placeholder `jevris` whose only job is to point at `@cryptventure/jevris`. |
| Signing keys | Generate each key pair offline: `node scripts/release-evidence.mjs keygen --role <owner\|security-reviewer\|certification\|calibration> --key-id <id> --out <private dir>`. It writes the private key (owner-only, never commit it) and prints the public trust entry; `--add-trust` appends that entry to `assets/trust/release-keys.json` for you to commit in a reviewed change. Only evidence signed by a key in that file counts. It holds one key per role today: `cryptventure-owner-2026-09` (owner), `cryptventure-certification-2026-09` (certification), `cryptventure-calibration-2026-09` (calibration) and `cryptventure-security-reviewer-2026-09` (security-reviewer). The private keys stay with the owner. |

## Cut a release

1. Make sure `main` is green, including the `pack-smoke` job on all three operating systems.
2. Pick the version and write the changelog:

   ```sh
   node scripts/release-version.mjs              # proposes the next version from conventional commits and prints the notes
   node scripts/release-version.mjs --write      # bumps package.json and the lockfile and prepends CHANGELOG.md
   node scripts/release-version.mjs --write --as 1.3.0   # or choose the version yourself
   ```

   Planning, test, CI, build, style and chore commits stay out of the notes. `--write` prepends a new section and drops an `## Unreleased` section, so move anything written by hand there into the new section. When `CHANGELOG.md` already has a hand-written section for the version, as 1.2.0 does, and `package.json` already carries that version, skip `--write`: it would add a second, generated section above it, and the release notes take the first one. Edit the section if it needs plain words, then commit it.
3. Check locally, then rehearse the published artifact:

   ```sh
   npm ci && npm run build && npm run check:clean && npm run registry:check && npm test && npm run lint
   node scripts/release-check.mjs --tag v1.3.0
   npm run docs -- --check
   node scripts/pack-smoke.mjs --full --npx
   ```

4. Tag the commit on `main` and push the tag:

   ```sh
   git tag v1.3.0
   git push origin v1.3.0
   ```

   Release tags are full semver with a `v` prefix (`v1.3.0`, `v1.3.1-rc.1`). A two-part tag such as `v1.0` never triggers a release.

## What the release workflow does

`.github/workflows/release.yml` runs on the tag:

| Job | What it checks or does |
| --- | --- |
| `release-check` | The ref is a tag on a commit that is on `main`. The tag equals `v` plus the `package.json` version. The manifest is public-ready: name, `publishConfig.tag` `next`, exact runtime pins, optional Agent SDK peer. `CHANGELOG.md` has a section for the version; it becomes the release notes. |
| `ci` | The whole CI workflow: nine test cells (three operating systems, Node 22.14.0, 24 and latest), the coverage job, the installed pack smoke on three operating systems and the benchmark job on three operating systems. A failed job stops the release, except a benchmark regression: `release.yml` calls CI with `bench-advisory`, so the bench job records the result, reports it in the job summary and still passes. Performance is gated by the sidecar-load gate below. |
| `gates` | Builds the tag, checks that the generated plugin files and docs are current, writes the story, workflow and runtime-gate reports (`scripts/acceptance-report.mjs`), then runs `jevris gates` over them, the pack-smoke evidence and the signed records in `release-evidence/`. The report is attached to the release. A failed gate does not stop the publish to `next`; it stops promotion to `latest`. This report cannot see the owner-made records, which are committed after the tag (below), so it is not the verdict: `promote.mjs` is. |
| `publish` | `npm publish --provenance --access public --tag next` through npm trusted publishing (OIDC). Then a GitHub prerelease with the tarball, `SHA256SUMS`, the CycloneDX SBOM, `THIRD_PARTY_NOTICES.md` and the gates report. |
| `verify` | On macOS, Linux and Windows with Node 22.14.0: `npx @cryptventure/jevris@<version>` from the registry prints the version and runs `doctor` under a temporary home, and `npm audit signatures` verifies the registry signature and the provenance attestation. The registry can lag, so a missing version is retried with backoff. |

A manual run of the workflow from a tag ref defaults to a dry run: everything except the publish and the GitHub release.

Verify a downloaded tarball yourself:

```sh
sha256sum -c SHA256SUMS            # Linux
shasum -a 256 -c SHA256SUMS        # macOS
node scripts/checksums.mjs --check SHA256SUMS   # anywhere
npm audit signatures               # in a project that installed the package
```

## Evidence and the gates

`jevris gates` judges eight gates (API, harness, security, quality, economics, operations, portability, and perf, the sidecar load targets on the reference machine) and the story and workflow acceptance reports, from evidence records. Each record is a `jevris.evidence/1` envelope bound to a version, a commit and an environment, with a payload hash. Owner, reviewer and certification records must carry an Ed25519 signature from a key in `assets/trust/release-keys.json`. Stale, unsigned, mismatched or tampered records are listed as excluded and never count.

Evidence producers:

| Evidence | Produced by |
| --- | --- |
| Installed end to end, per OS | the `pack-smoke` CI job (`node scripts/pack-smoke.mjs --full --npx --evidence <file>`) |
| Live Jev API suite | `live-jev.yml` (manual, protected environment) or `JEVRIS_LIVE_JEV=1 npm run smoke:jev -- --evidence <file>` |
| Harness conformance and certification records | `JEVRIS_LIVE_HARNESS=1 npm run smoke:harness -- --evidence <dir> --signing-key <certification.pem> --key-id <id>` on each operating system, with the real harness binaries on `PATH` |
| Threat model suite, per OS | the `pack-smoke` CI job: `node apps/sidecar/scripts/threat-model-suite.mjs --out release-evidence/threat-model-<os>.json` (cross-user IPC needs a second local user named in `JEVRIS_TEST_OTHER_USER`) |
| Operations drills, per OS | the `pack-smoke` CI job: `node scripts/pack-smoke.mjs --full --drills-evidence release-evidence/operations-drills-<os>.json` runs the eight drills against the installed tarball |
| Seed run (optional; none for 1.2) | only for a release that ships a baseline: the owner, on their own subscription login, never an agent or CI: `node packages/evals/scripts/seed-run.mjs select --dataset ts=<ts.jsonl> --dataset js=<js.jsonl> --dataset go=<go.jsonl> --out <seed>` (SWE-bench-Live/MultiLang at 3638632e), the gold check with SWE-bench-Live's `python -m evaluation.evaluation --patch_dir gold` on `eval-candidates.jsonl`, `select ... --gold <results.json>`, then `JEVRIS_LIVE_HARNESS=1 node packages/evals/scripts/seed-run.mjs run --out <seed>` (24 runs: the baseline and the candidate model on the same 12 tasks), `predictions`, the same evaluator on `eval-dataset.jsonl` per model, then `priors` and `economics` with each model's `--report <model>=<results.json>`. |
| Baseline release (optional; none for 1.2) | `node packages/evals/scripts/baseline-release.mjs build --seed-dir <seed> --out <seed> --id <id> --expires <ISO>` and `... sign --proposal <seed>/baseline-proposal.json --key calibration.pem --key-id <id> --reviewer <id> --out <seed>`, then `node scripts/release-evidence.mjs baseline --release <seed>/calibration-release.json --seed-dir <seed>`. The release commit puts the same signed `calibration-release.json` at `assets/calibration/calibration-release.json`, so the package ships it as route learning's day-1 baseline (a file in the Jevris config folder overrides it) |
| Seed economics (optional; none for 1.2) | the owner, from the same seed: `node scripts/release-evidence.mjs economics --seed-dir <seed> --drills drills.json --key owner.pem --key-id <id>` (full cost and wall time per verified task, candidate against baseline, paired-bootstrap 95% intervals, the sample's plan, selection and run-record hashes). `drills.json` lists one `{ packId, disabled, independent, passed }` per shipped pack: `jevris.memory`, `jevris.observability` and `jevris.skill-advice`. The gate refuses a record that misses one |
| Calibration release | the reviewer: `node scripts/release-evidence.mjs calibration --proposal proposal.json --calibration cases.jsonl --holdout-cases holdout.jsonl --reviewer <id> --key calibration.pem --key-id <id>`; install the resulting `calibration-release.json` in the Jevris config folder. The sidecar loads it only when its key is a `calibration` key in the trust store |
| P0 decision register | the owner: `node scripts/release-evidence.mjs p0-register --answers p0.json --key owner.pem --key-id <id>` |
| Security review | the owner, over the independent reviewer's report, with the `security-reviewer` key: `node scripts/release-evidence.mjs security-review --review review.json --report <report file> --key <private dir>/cryptventure-security-reviewer-2026-09.pem --key-id cryptventure-security-reviewer-2026-09 --commit <release commit>`. It fills in the report's sha256 and the reviewed version. `review.json` holds `reviewer` (`name`, `organization`, `independent`), `reportLocation`, `scope` (all six: credential-leakage, source-leakage, model-created-authority, scoped-ipc, evidence-access, pack-updates) and `findings` (`id`, `severity`, `status`); no open critical or high finding may remain |
| Sidecar load (the perf gate) | the owner, on the reference machine (darwin arm64, Apple M4 Max, 16 cores, 64 GB), on the release commit: `npm run build && npm run bench:load -- --evidence release-evidence/sidecar-load.json`. `perf.sidecar-concurrency` needs all 13 locked targets met in a full run (not `--quick`), including `load.lifecycle50.busy` (no lifecycle hook answered BUSY during 50 subagents); see [docs/testing.md](docs/testing.md#sidecar-load-npm-run-benchload) |
| Story and workflow reports | `node scripts/acceptance-report.mjs --out <dir>` runs `test/acceptance` (US01 to US40, W01 to W12); the release workflow runs it on the tag |
| Runtime-gate report (quality and economics) | the same `node scripts/acceptance-report.mjs --out <dir>` then runs the files of the named tests in `RUNTIME_GATE_TESTS` (`apps/cli/src/release-gates.ts`) and writes `runtime-gate-report.json`: each named test, passed or not in this run. A skipped, renamed or missing test is not a pass |

`scripts/release-evidence.mjs` validates each record against its contract and checks its signature before writing `release-evidence/<kind>.json`, and says whether the key is trusted yet. `node scripts/release-evidence.mjs check <record.json>` verifies a record against the committed trust store. The script never publishes, uploads or reads a key from the environment.

The release commit is the tagged code commit. Every record whose kind is bound to the exact version is also bound to that commit (`COMMIT_MISMATCH` otherwise), whether CI or the owner made it:

1. Tag the code commit. The release run's CI jobs write their records at the tag, bound to it, and its `gates` artifact holds them in `gate-evidence/`.
2. Produce each owner-made record bound to the exact version (the live Jev suite, harness conformance, the sidecar load) from a checkout of that same commit, because each takes its commit from `HEAD`.
3. Commit the records that CI does not produce into `release-evidence/` afterwards, in a commit on `main` that changes nothing else. That commit is not the release commit and is never tagged. The tag's own `gates` report cannot see these records.
4. Merge the release run's `gate-evidence/` with that `release-evidence/`, and promote with `--commit <tag sha>` ([Promote to latest](#promote-to-latest)). That run is the verdict.

### The API gate

The API gate reads the newest accepted live `api-live-suite` record (mock-mode records never count). Its rows:

| Row | Passes when |
| --- | --- |
| `api.live-suite` | a live record for this version and commit exists, at most 30 days old |
| `api.suite-passed` | the suite's own verdict is `passed` (primitives, cancellation, caps, conservative estimate, every probe matched, every latency call ok, pinned model) |
| `api.primitives`, `api.cancellation`, `api.budget-caps` | Choice, Score and Noul answered; the caller's abort ended a call; an over-cap request was refused before sending |
| `api.error-taxonomy` | at least 3 error probes were answered by the provider with their expected code (invalid model and invalid schema `INVALID_REQUEST`, invalid key `PROVIDER_DISABLED`). A probe that ended in `DEADLINE` or `CANCELLED`, or with another code, shows no taxonomy |
| `api.usage-reconciled` | at least 30 calls reported usage, and the conservative estimate never fell below the provider's count |
| `api.latency-sample` | every latency call succeeded, at least 30, under the measuring timeout; the detail prints p50, p95, p99, max and the failed calls per reason code |
| `api.latency-envelope` | the envelope is known (the sample above). Inside the latency targets (p95 at most 800 ms, and at least 95% of calls within the 900 ms budget) it passes; outside them it is WARN, with p95 and the share within budget in the detail |

The latency targets are engineering targets to benchmark, not SLOs, so a measured envelope outside them does not fail the gate, but it is printed WARN and the release owner decides whether it ships. A call over the budget falls back in the product. The suite's record keeps every call's elapsed milliseconds and outcome; see [docs/testing.md](docs/testing.md).

For each harness advertised with owned-worker routing (its `plugins/<harness>/harness.json` lists `worker.route`; all five today), the gates also check its worker. `harness.<harness>.worker.<os>` needs the nine worker conformance cases under the `<harness>.worker` actuator, in the same real-binary conformance record. `portability.worker-route.<harness>.<os>` needs the published certification record to carry `worker.route` as certified. `jevris certify` and `smoke:harness` produce both, with no model call ("certified pending first use"). Billed owned-worker runs are not release gates.

A harness advertised with routing also needs its route actuators certified in the same record, each as `portability.<feature>.<harness>.<os>`:

| Predicate | Certification feature | Harnesses | What it proves |
|---|---|---|---|
| `portability.hooks-route.*` | `hooks.route` | Claude Code, Kilo, OpenCode | A subagent spawn takes the routed model (cases K1, K3, K4). 1.2 does not require Codex subagent routing for release; Codex routes subagents only where K2 certifies on the installed version, otherwise it advises. |
| `portability.worker-actual-model.*` | `worker.actual-model` | Codex, Kilo, OpenCode | An owned run's own hooks report the model it used (K8) |
| `portability.session-route.*` | `session.route` | Kilo, OpenCode | The main session switches model per turn |
| `portability.models-list-hosts.*` | `models.list-hosts` | Kilo, OpenCode | The model listing keeps each pinned host's spellings on that host (K13); a listing that did not run is never a pass |
| `portability.route-host.*` | `route.host` | Kilo, OpenCode | A route through a serving host reaches that host, and a project config that redefines the host refuses it (K14–K15). Certified only with `session.route` in the same run; without it, host changes and gateway routes stay advice |
| `portability.access-detect.*` | `access.detect` | Claude Code, Codex, Kilo, OpenCode | A rate limit, an exhausted credit and a refused sign-in, each in the API's own shape, reach the harness port as the right class with no remote text (K16–K18) |
| `portability.access-session.*` | `access.session` | Claude Code, Kilo, OpenCode | A session turn that fails on an access limit reaches the hooks, normalized, with no remote text (K19–K20). `unsupported` with `ACCESS_SESSION_EVENT_ABSENT` (the harness version never sends the event) is accepted; every other reason blocks |
| `portability.access-usage-read.*` | `access.usage-read` | Codex | The Codex usage read (`account/rateLimits/read`) runs against the loopback stub under OS network isolation (macOS `sandbox-exec` denying all but loopback, Linux an unprivileged network namespace), and the stub sees every request made to itself (K21). On win32 only, `unsupported` with `ACCESS_USAGE_ISOLATION_UNAVAILABLE` is accepted: there is no isolation for the case there, so a reading stays uncertified. On macOS and Linux every reason blocks, including that one. The Linux certify host must allow unprivileged user namespaces (on Ubuntu 23.10+, `kernel.apparmor_restrict_unprivileged_userns=0`); a host that restricts them records `ACCESS_USAGE_ISOLATION_UNAVAILABLE`, which blocks this row. |

`jevris certify` proves these against a loopback stub provider with a dummy key, so there is no model call and no cost. The harness in the throwaway profile is pointed at the stub: Claude Code through `ANTHROPIC_BASE_URL`, Codex through a `[model_providers.stub]` Responses provider, and Kilo and OpenCode through inline config that overrides the built-in anthropic provider's `baseURL`. Every other provider route and credential is removed from that profile's environment. Antigravity has no custom endpoint, so none of these applies to it, and its model-slug check stays owner-run.

Harness conformance and certification records are bound to the release: the conformance record must name the release commit, and a certification record counts only when a trusted `certification` key signed it. A record from a user's own `jevris certify` is signed with that machine's local key, which is not in `assets/trust/release-keys.json`, so the gates list it as excluded.

A certification record covers the harness version range that `plugins/<harness>/harness.json` declares (`compatibility`). A harness release inside the range needs no new record, and on a user's machine a version outside it is re-checked in the background (started by `jevris doctor`, the sidecar's start or a SessionStart), with no model call. So `jevris certify` and `smoke:harness` are for explicit live and release evidence, never for routine harness upgrades.

There is no seed run for 1.2 (owner decision, 26 September 2026): every user starts on the approved default, Opus 5.5 at medium effort, and route learning moves a workspace only in use. So the quality and economics gates read the release run itself:

- **Quality** requires `quality.learning-gate`: the named tests of the run-time learning gate pass in the release run. They are the owner-locked thresholds (`OWNER_LOCKED_LEARNING_THRESHOLDS`, `automaticPromotionReady()` in `packages/core/src/route-learning.ts`), the clamp to the hard limits, fast automatic demotion (C52, both windows), human pins, learning off, capped exploration, learning from the first outcome with no baseline, the local-evidence guard (no switch before both arms hold the locked minimum of the workspace's own randomized outcomes; a signed baseline or the machine prior never switches a workspace alone), and the machine-wide prior. The tests are in `packages/core/test/route-learning.test.mjs`, `packages/core/test/route-learning-machine.test.mjs`, the no-baseline product path in `packages/provider-typesafe/test/route-evaluation.test.mjs`, and the guard's status line in `apps/cli/test/route-learning-economics.test.mjs`. With no `assets/calibration/calibration-release.json` in the package, `quality.default-start` records that every workspace starts on the default.
- **Model retirement** (`quality.model-retirement`, in every quality gate: a model stays recommended until it is actually retired, by `status: retired` or a firm `retiresOn` date). It warns, printed `WARN`, and never fails the release, for a model the router still recommends when its firm or "not sooner than" date is within 30 days, when its "not sooner than" date has passed (`MODEL_RETIREMENT_DUE`: it may be retired any day), or when it is deprecated. It fails only on release data that contradicts itself: a retired model that shipped data still names (core's `shippedModelReferences`: the registry's baseline model and every bundled prior's model), a registry entry that still says active or deprecated after its firm date (core's `lifecycleStatus` calls it stale), or a shipped signed baseline that uses a retired model as a prior. The fix for both is a model refresh by [docs/model-refresh.md](docs/model-refresh.md), then `npm run registry:check`, which warns about the same models ahead of time. Never move a date only to clear either.
- **Economics** requires `economics.in-use`: the named tests that each workspace measures cost and time per verified task against the approved default, that `jevris explain` and status report it, and that routing reverts to the default when a candidate does not improve. It also requires `economics.pack-disable`: `test/pack-disable-drill.test.mjs` installs every pack the package ships into one workspace and disables each in turn, with the others staying active. The in-use tests are the `C16 economics` tests in `packages/core/test/route-learning.test.mjs`, explain on the product path in `packages/provider-typesafe/test/route-evaluation.test.mjs`, and `route learning status` in `apps/cli/test/route-learning-economics.test.mjs`.
- **A release that ships a baseline** gets the baseline checks back. When `assets/calibration/calibration-release.json` is in the package, the quality gate also needs the signed baseline release: a trusted `calibration` key, released, unexpired, this major.minor, method `beta-posterior` with its sources, at least 24 seed runs from one task selection and one set of run records, and the shipped file equal to the record's payload (`quality.baseline-release`, `quality.baseline-method`, `quality.baseline-shipped`, `quality.baseline-seed`). `npm run check:pack` refuses a shipped baseline that is not a released beta-posterior artifact signed by a `calibration` key in the package's own `assets/trust/release-keys.json`.
- **A seed economics record** (owner-signed, from the same seed) is still judged when present: `economics.sample-size` (12 paired tasks, 24 runs), `economics.seed-bound`, intervals, full cost, improvement and its pack-disable drills. One that is present but not accepted is named (`economics.report`).

No large offline trial is run.

The calibration release is also route learning's day-1 baseline: its priors come from published independent results and the owner's seed run. The package ships it at `assets/calibration/calibration-release.json` (in the `assets/` files entry), so a normal install has it with no extra step. The sidecar reads `<config>/calibration-release.json` first, as an administrator's or user's override, and otherwise the bundled one, and checks either the same way: the contract, a `calibration` key in `assets/trust/release-keys.json`, and whether it applies. Until the owner signs one and the release commit adds it, the file is absent, owned-worker routing stays advice only, and `jevris route` and `calibration.status` say there is no signed baseline release in this package (see [docs/routing.md](docs/routing.md#the-baseline)).

## Promote to latest

Only after the gates pass on the release candidate:

```sh
git checkout v1.3.0 && npm ci && npm run build
node scripts/promote.mjs --version 1.3.0 --evidence <dir> --commit <full sha>            # dry run: runs the gates
node scripts/promote.mjs --version 1.3.0 --evidence <dir> --commit <full sha> --apply    # npm dist-tag add … latest (your npm login, 2FA)
```

`<dir>` is the release run's `gate-evidence/` merged with the `release-evidence/` records committed after the tag, and `--commit` is the tag's commit (see [Evidence and the gates](#evidence-and-the-gates)). `promote.mjs` refuses a checkout whose `package.json` is another version, and runs `jevris gates` on that exact build first; with `--apply` it also refuses a prerelease, a missing `--commit` and a version the registry does not have. It is the only way `latest` moves.

## Roll back

npm versions are immutable. To take a bad release out of use:

1. Point `latest` back at the previous good version: `npm dist-tag add @cryptventure/jevris@<previous> latest`.
2. Deprecate the bad version with a reason users will see on install: `npm deprecate @cryptventure/jevris@<bad> "Broken: <what>. Use <previous> or <fixed>."`.
3. Fix forward with a patch release. Do not unpublish; it breaks installs that pinned the version and cannot be reused.

Installed copies keep working after a rollback: each install runs from its own versioned runtime copy under the Jevris data directory, never from the npm cache. Users move with `npx @cryptventure/jevris@<version> install` (see [docs/upgrade.md](docs/upgrade.md)).

## Rotate a secret or key

| Secret | Rotation |
| --- | --- |
| npm publishing | None to rotate: trusted publishing uses a short-lived OIDC token per run. If the trusted publisher setting is compromised, remove and re-add it on npmjs.com, and review the `npm` environment's reviewers. |
| `JEVRIS_JEV_API_KEY` | Issue a new key with the vendor, replace the secret in the `live-api` environment, revoke the old key with the vendor. |
| A signing key | Generate a new Ed25519 key pair offline, add the public key to `assets/trust/release-keys.json` in a release commit, re-sign the records that must stay valid, then remove the old public key. A removed key's records stop counting at once. |
| A user's own Jev key | `jevris credential set` replaces it in the OS keychain; `jevris credential clear` removes it. |

If a key or token leaks, rotate first, then deprecate any version whose evidence depended on it and cut a patch release with fresh evidence.
