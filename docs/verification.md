# Verification: check manifests and approval

Jevris treats work as complete only when real checks have run and passed on the current code.
A model's claim, a passing score or a summary never counts as proof. This page explains how
you declare checks, how you approve them, and what Jevris does with the results.

## 1. Declare the checks

Put a check manifest in the repository, in either of these files:

- `jevris.checks.json` at the repository root, or
- `.jevris/checks.json`.

```json
{
  "schemaVersion": "jevris-checks-1",
  "checks": [
    {
      "id": "unit",
      "argv": ["npm", "test"],
      "cwd": ".",
      "timeoutMs": 600000,
      "mandatory": true,
      "resultFormat": "auto",
      "inputScopes": ["src", "test", "package.json"],
      "requirementIds": ["R1"],
      "description": "Unit tests"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | A short name: letters, digits, `.`, `_` and `-`. |
| `argv` | The command as a list of arguments. It runs without a shell, so pipes, `;`, `&&`, `$` and redirections are never interpreted. The first item is a program name found on `PATH` or an absolute path; a relative path or a shell character in it is refused. |
| `cwd` | A folder inside the repository, relative to its root. |
| `timeoutMs` | From 1 second up to 6 hours. The default is 10 minutes. |
| `env` | Names of extra environment variables the check may see. Credential-like names (anything with KEY, TOKEN, SECRET, PASSWORD and so on) are refused. |
| `mandatory` | Whether completion needs this check to pass. The default is `true`. |
| `runnerId` | The runner that runs the check. The default is `local`. |
| `resultFormat` | `tap`, `junit`, `node-spec`, `exit-code` or `auto` (the default). |
| `resultFile` | For JUnit, the report file the check writes. |
| `inputScopes` | The files and folders the result depends on. When they change, the result goes stale. With none, a change anywhere in the tree makes it stale. |
| `requirementIds` | The requirements the check proves. |
| `hardware` | A hardware runner name, for checks that need attached hardware. |
| `description` | A short description, up to 500 characters. It is not part of the approved hash. |

A manifest may contain only these fields. Any other field is refused, including one that claims a
result (`passed`, `verified` and similar).

### Let Jevris propose checks

`jevris verify profile` looks at the repository (npm, pnpm, yarn, bun, Python, including uv
and Poetry, Cargo, Go, Maven, Gradle, CMake, .NET and PlatformIO), and proposes a manifest. It
proposes only commands whose tools it found. Nothing runs until you approve it.

## 2. Approve the checks

Jevris runs only checks you approved from the command line, the trusted channel:

```
jevris verify approve                 # approve the manifest in the repository
jevris verify approve --proposal      # approve what `verify profile` proposed
jevris verify revoke [<check-id> ...] # withdraw approval (all checks when none are named)
```

Until a check is approved, `jevris doctor` reports `verification: unsupported` and names this path: `jevris verify profile` to see the proposed checks, then `jevris verify approve --proposal`, or, when the repository already has `jevris.checks.json`, `jevris verify approve`.

Approval records the exact hash of each check. If anyone edits a check afterwards, even one
argument, the edited check does not run until you approve it again. Hooks, MCP tools and
models cannot approve checks.

Each `jevris verify approve` (with or without `--proposal`) replaces the approved set with exactly
the checks it approves. A check that is no longer in the manifest loses its approval; you do not
need `jevris verify revoke` for that.

Approving needs a person at an interactive terminal who answers `y`. `--yes`, `--json`, a pipe
and a script are refused with `CHANNEL_REFUSED`, and nothing is approved. The same holds for
trusting a CI issuer (`verify issuer add`) and for waivers (`verify waive`). Revoking an
approval or removing an issuer only narrows what counts, so `verify revoke` and
`verify issuer remove` also take `--yes`. A program running as you can fake a terminal; see
the same-user limit in [security.md](security.md#changes-that-need-a-person-at-a-terminal).

## 3. Run the checks

```
jevris verify                 # run the approved checks
jevris verify --check unit    # run only these checks (repeat --check)
jevris verify --task <id>     # run the checks a task needs
```

Only the CLI runs checks. The `verify` skill and the `jevris_verify` MCP tool read the same
status but never run a check and never mark one passed.

The runner:

- starts each command directly, without a shell, with a clean environment that holds only a
  short allowlist plus the variables the check names;
- records a receipt for each check: the command, the exit code, the time taken, the code
  revision and a hash of the full output;
- keeps the full output in the Jevris data folder (never in your repository), behind a
  handle such as `ev:3b1f…`, which `jevris evidence get <handle>` prints back;
- on macOS and Linux, starts each check with the file-mode mask of the shell that started
  Jevris (022 when that is unknown), not the private 077 the sidecar keeps for its own files, so
  a check behaves as it does when you run the same command yourself.

A long check keeps running after `jevris verify` answers. The answer comes within 40% of the
request's deadline (2 seconds of the CLI's 5), so a slow machine still gets it in time: checks
that have not finished by then are listed as running or queued. When even reading the status
after the run would miss that window, the answer lists
the approved checks from their last receipts (shown as `STALE`, since their freshness was not
confirmed) and names the ones running or queued. Each check without a current receipt carries a
reason code:

| Code | Meaning |
|------|---------|
| `RUNNING` | It is in the run now under way; its receipt is recorded when that run ends. |
| `QUEUED` | It waits for the run under way in this workspace, then runs. Requests made meanwhile join one queued run. |
| `NO_RECEIPT` | Nothing has run it yet and nothing is running it. |
| `STALE` | Its last receipt no longer matches the code (see Freshness). |

Run `jevris verify` again later to read the result. The plain-text answer says so in words, for
example:

```text
Not verified: 2 checks without a current passing receipt; 1 still running, 1 queued.
check test: not-run mandatory not-current receipt none reason RUNNING
test: still running in the background
check lint: not-run mandatory not-current receipt none reason QUEUED
lint: queued behind the run under way
Run jevris verify again later to read the result.
```

If the sidecar takes the request but does not answer in time, `jevris verify` says the state of
the checks is unknown (`VERIFY_STATE_UNKNOWN`, exit 1), never that nothing ran. Run it again:
it joins the run under way.

For a failed check, the answer names up to 20 failing tests the runner could read from its
output (ids and names only, secrets redacted) with the total, and the output's handle:
`jevris evidence get <handle>` prints it. The plain-text answer shows at most three names, then
how many more:

```text
check test: failed mandatory receipt r-17 reason EXIT_NONZERO
test failed: 12 failing tests (test/a.test.mjs: parses an empty file; test/b.test.mjs: keeps the order; test/c.test.mjs: rejects a bad id; and 9 more); details: jevris evidence get ev:<64 hex>
```

When no failing test could be read from the output, the line says so (`no failing test was
parsed from its output`), and the handle still leads to the full output.

`jevris evidence get` (and the `--json` result and the MCP tool) returns at most about 56,000
characters. A longer output keeps its first and last 28,000 characters, each cut at a line or word
boundary, with a line saying how many characters were left out of the middle, and `truncated` is
true. The full output stays in the local evidence store, unredacted. What is shown or sent is
redacted: vendor API keys, private keys, JWTs, `Authorization` header credentials
(`Authorization: Bearer <token>`) and the values of `password=`, `passwd=`, `secret=` and
`passphrase=` style assignments are replaced with `[redacted]`, and the label is kept.
Sentences that only mention a password are left as they are.

A check id that is not approved is refused with `UNKNOWN_CHECK` and the reason, exit code 2,
and nothing runs:

```text
Refused (UNKNOWN_CHECK): No approved check is named docs; jevris verify profile lists the checks. Nothing ran.
```

## 4. Freshness

A receipt is current only while its inputs are unchanged. When a file in the check's
`inputScopes` changes, or the branch or the lockfile changes, the receipt goes stale and the
check must run again. Stale receipts never count as passed.

Staleness is one-way. Jevris marks a receipt stale the first time it sees the inputs differ, and it
stays stale: putting the files back does not make that receipt current again. Run the check again
to get a new receipt. If the files were put back before Jevris looked, the receipt was never seen
stale and is still current. A receipt written by a run that already includes a new lockfile or
branch is not made stale by that change; only receipts made before it are.

To tell whether inputs changed, Jevris hashes the changed and untracked files in the background,
without holding the sidecar: it reuses a file's hash while its size and times are unchanged, and
it reads at most 256 MiB of new content per look. A file past that budget, or larger than 64 MiB,
is identified by its size (and time) instead of its content.

A check's output (up to 16 MiB kept) is stored the same way: hashed a piece at a time and
written in the background, and its test results are read in one pass over the text, so a check
with a large or malformed report does not stall other hooks. In the sidecar, an output of 256 KiB
or more is joined, hashed, parsed and given its distilled view in a separate worker thread, and
the sidecar goes on answering meanwhile. If that thread cannot start or does not answer, the same
work runs in the sidecar itself, with the same result.

## 5. Completion

A task is verified only when every mandatory check has a current, passing receipt. `unknown`
and `not-run` are never treated as passed. When evidence is missing, Jevris names the missing
checks and asks for them. It does not keep the session running forever: you can always stop,
and the work is then reported as unverified.

At a stop, Jevris asks at most once for the same missing evidence: the same checks, missing in
the same way. Other work landing in the checkout does not count as a new condition, and a stop
while every missing check is still running is labelled unverified without asking. A stop that
comes after a continuation (`stop_hook_active`) is never blocked. Once the work is verified, a
later gap may be asked about once more.

In Claude Code and Codex the one continuation is a Stop block. In Antigravity it is the first
Stop's `continue`, sent only when the agent stopped by itself (`model_stop`) and is fully idle;
a later Stop in the same run proceeds. Kilo and OpenCode have no stop gate yet. The reason
names a missing check that is still running or queued in the background as such, in the same
words as the stop report ("Still running in the background: test (running); ..."), and asks
only for the other missing checks. When every missing check is on its way, the reason says that
stopping again ends the turn labelled unverified.

## 6. CI results

You can import results from CI instead of running checks locally:

```
jevris verify issuer add <issuer-id> --key <public-key.pem> [--key-id <id>] [--repository <owner/name>]
jevris verify issuer list
jevris verify issuer remove <issuer-id>
jevris verify import-ci <bundle.json> --artifacts <folder>
```

The key is an Ed25519 public key in PEM form. The artifacts folder may hold at most 8 MiB.

A CI bundle counts only when:

1. its issuer is one you trust and, when you added it with `--repository`, the bundle names that
   repository;
2. its signature verifies with that issuer's key;
3. the artifact hashes match the files; and
4. it was produced for the current code revision. Results for another revision are recorded
   and immediately marked stale.

`verify issuer add` needs a person at an interactive terminal who answers `y`; it refuses
`--yes` (`CHANNEL_REFUSED`).

## 7. Waivers

When a required check cannot run (for example, the hardware is not attached), a person with
authority can waive it:

```
jevris verify waive <check-id> --reason "<why>" [--authority <name>]
```

The waiver records who waived it (`--authority`, by default your user name) and why. A waived check is reported as waived, never as
passed. A waiver needs a person at an interactive terminal who answers `y`; it refuses `--yes`
(`CHANNEL_REFUSED`).

## 8. Required checks

`jevris verify required <check-id>...` shows each named check as passed, failed, missing or
waived, in the order named. It runs nothing.
