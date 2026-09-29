# Jevris in simple terms

This page is for a developer deciding whether to use Jevris, and how. It explains what Jevris does and does not do, in plain words, and links to the detailed page for each topic. It describes version 1.2.0, a release candidate. Where this page and the product disagree, the product wins; the full command list is in [cli.md](cli.md).

## Contents

1. [What Jevris is](#1-what-jevris-is)
2. [How it fits your workflow](#2-how-it-fits-your-workflow)
3. [What it does by itself, and what it only advises](#3-what-it-does-by-itself-and-what-it-only-advises)
4. [Model routing and learning](#4-model-routing-and-learning)
5. [Owned workers and sign-in](#5-owned-workers-and-sign-in)
6. [Verification: when work counts as done](#6-verification-when-work-counts-as-done)
7. [Privacy and your data](#7-privacy-and-your-data)
8. [Models: the registry and retirement](#8-models-the-registry-and-retirement)
9. [What it costs you](#9-what-it-costs-you)
10. [Requirements and platforms](#10-requirements-and-platforms)
11. [Limits and honest caveats](#11-limits-and-honest-caveats)
12. [Should you use it?](#12-should-you-use-it)
13. [Glossary](#13-glossary)

## 1. What Jevris is

Jevris is a program that runs on your own machine, beside the AI coding tool you already use. It watches what the tool does, gives advice, keeps records, and checks whether work is really finished. It aims to lower the cost and the interruptions per correctly finished task. Every decision it makes can be looked up, and it never changes your permissions.

Three ideas run through it:

- **Facts, arithmetic, permissions and verification stay in ordinary code.** Counting tokens, pricing a model, deciding whether a test passed: none of this is left to a language model.
- **A small model answers only small, fixed questions.** That model is **Jev** (TypeSafe System One), a paid decision service. Jevris asks it things like "which of these options?", "score this", or "none of the above". Jev never writes code. Without a Jev key, Jevris still works, using its rules only.
- **Work is done only when real checks say so.** A model saying "done" does not count. A passing run of your own tests on the current code does.

What Jevris is **not**:

- **Not a coding model, and not a replacement for one.** Your harness's model (Claude, GPT, Gemini, Grok) still writes the code.
- **Not a chat proxy.** It does not sit between your harness and its model vendor. Your harness talks to its vendor exactly as before.
- **Not a hosted dashboard or a cloud service.** Everything runs and is stored on your machine. The interface is a command line (`jevris`) plus tools inside your harness.

## 2. How it fits your workflow

### The five harnesses

A **harness** is the coding tool you work in. Jevris installs into five: Claude Code, Codex, Kilo (the Kilo CLI), OpenCode and Antigravity (the `agy` CLI; the Antigravity app and IDE load the same plugin in their GUI). The legacy Kilo VS Code extension is not supported.

"Installed" means four things in each harness:

| Part | What it is | What it does for you |
| --- | --- | --- |
| **Hooks** | Small commands the harness runs on events such as "session started", "tool finished", "about to stop" | Let Jevris observe the session, and, where certified, add context or ask for missing evidence at Stop |
| **MCP tools** | 17 tools the model can call (MCP is the standard way harnesses expose tools to a model) | Status, planning, route advice, checkpoints, verification status, decision explanations and more ([mcp.md](mcp.md)) |
| **Skills** | 8 short instruction files: status, plan, route, checkpoint, recover, verify, explain, configure | Let you or the model use Jevris by name, for example `/jevris:status` in Claude Code |
| **The sidecar** | One background Jevris process per user, started on demand, stopped after 30 idle minutes | Holds the local database, reads the Jev key, answers hooks, tools and commands |

The hooks, tools and skills are thin. They pass requests to the sidecar. If the sidecar is late or down, the hook answers "observe" and your harness carries on as normal. Jevris never blocks a tool call because it failed.

Each harness supports a different subset of features. The [parity matrix](harnesses/parity-matrix.md) lists every feature per harness, with the reason for each gap. Per-harness guides: [Claude Code](harnesses/claude-code.md), [Codex](harnesses/codex.md), [Kilo](harnesses/kilocode.md), [OpenCode](harnesses/opencode.md), [Antigravity](harnesses/antigravity.md).

### A typical day

1. **Install once.** `jevris install --dry-run` prints every file it would change. `jevris install --yes` applies it. Install backs up every file first, keeps other tools' settings byte for byte, and restores everything if a step fails. It then certifies each harness without calling any model (see [section 3](#3-what-it-does-by-itself-and-what-it-only-advises)), and detects how each harness signs in.
2. **Finish the steps only you can take.** Restart Claude Code. In Codex, run `/hooks` and trust the Jevris hooks; Codex runs no plugin hook until you do.
3. **Check the result.** `jevris doctor` prints one line per fact. `✓` works, `i` is information or a limit by design, `!` is a problem with its fix, `✗` is something broken ([troubleshooting.md](troubleshooting.md#reading-the-doctor)).
4. **Work as usual.** You use your harness exactly as before. Jevris records what happens.
5. **What you see.** Mostly nothing. Sometimes a short Jevris note, for example that the same error keeps repeating, or that you are stopping with checks still missing. After a context compaction, a certified harness gets back a saved memory capsule. When you ask, you get answers: `jevris status`, `jevris verify`, `jevris route`, `jevris explain <decision-id>`.
6. **Before you call work done**, run `jevris verify`. It runs your approved checks and says "verified" or names what is missing.

`jevris sidecar statusline` prints one status line from a local cache, if you want to wire it into your own status line. Jevris never replaces your harness's status line setting.

Details: [installation.md](installation.md), [upgrade.md](upgrade.md).

## 3. What it does by itself, and what it only advises

Jevris separates three levels of authority, per feature:

| Level | Meaning | When |
| --- | --- | --- |
| **Observe** | Record what the harness did | Whenever the mode is not `off` |
| **Advise** | Say what it would do, with reasons | In `advise` and `bounded-auto` mode; advice is never applied by itself |
| **Actuate** | Actually change something in the session or start a run | Only in `bounded-auto` mode, only where a signed certification record covers the harness, its version and your OS, and still under the harness's own permissions |

### The mode: one setting over all of it

One setting, `mode`, caps everything above. `jevris configure set mode <value>` changes it, and your administrator can set a lower ceiling.

| Mode | What Jevris does |
| --- | --- |
| `off` | Nothing. The hooks do nothing, nothing is recorded, Jev is never asked (commands that would ask it say Jevris is off) and nothing runs in the background that reaches the network. |
| `observe` | Records what happens, and asks Jev what it would have advised. That answer is kept as a record and never shown. |
| `advise` | Also shows advice, including the one reminder at a stop that verification evidence is missing. |
| `bounded-auto` (the default) | Also acts, where a certification covers it: routes a subagent, switches a Kilo or OpenCode turn, starts owned workers for plans you submit. |

Raising the mode (for example from `observe` to `advise`, or back to `bounded-auto`) needs you at a terminal to answer `y`; `--yes`, a script or a model's shell cannot do it. Lowering it never asks. The other settings for the main session and owned workers can only narrow the mode, and the kill switch (`jevris kill-switch activate`) still stops everything in any mode. If you upgraded from an earlier build where the default was `observe`, a settings file that still says `observe` is moved to `bounded-auto` once, and `jevris status` tells you so; run `jevris configure set mode observe` afterwards to stay in observe.

### Certification

A **certification record** is a signed file that says "on this harness, in this version range, on this OS, these features were proven to work". `jevris certify` produces one. It installs Jevris into a throwaway profile, runs the real harness binary, and runs fixed test cases through the installed hook. It calls no model and costs nothing. `jevris install` runs it for you.

- A record covers a **version range** (the same minor version for all five harnesses today), on the one OS it ran on, for 30 days. A routine harness update inside that range needs nothing.
- When the harness moves past the range, Jevris re-checks in the background, with no model call, when you run `jevris doctor`, when the sidecar starts, or at the next session start. Observation and advice never wait for it.
- Real use counts too. If a live hook event arrives malformed, that one feature drops back to observe at once, and a re-check starts.
- Records made on your machine are signed with a local key, and count on your machine. Release records must be signed by a release key; there are none yet (see [section 11](#11-limits-and-honest-caveats)).

### What is actuated, and only after certification

| Action | Where | Feature it needs |
| --- | --- | --- |
| Add a saved memory capsule back into the model's context when a session resumes after a compaction | Claude Code and Codex (as added context). Kilo and OpenCode: Jevris saves the capsule at compaction, but adds no lines to it yet. Antigravity has no compaction event; its one-message context channel is rendered, but nothing proposes a message yet, and a capsule comes back through the `jevris_handoff_export` tool | `hooks.context` |
| One Stop reminder asking for missing verification | Claude Code, Codex and Antigravity (its Stop `continue`, first stop only) | `hooks.context` |
| Show Jevris advice to the model on each turn | Kilo and OpenCode, on the turn's system prompt | `hooks.context` |
| Start an owned worker with a chosen model and effort | All five harnesses | A task you submit (`jevris plan --submit`, or `jevris_submit_task` with owned mode on); `worker.route` certifies the model and effort routing, not the start |
| Choose a subagent's model when the subagent starts | Claude Code (the Agent tool); Codex (`spawn_agent`), Kilo and OpenCode (the child session's first message), each once its `<harness>.subagent-route` stub case passes on your binary | `hooks.route` |

The first three rows count as advice, so they also run in `advise` mode, still only where certified. Starting owned workers and choosing a subagent's model need `bounded-auto`.

On the last row: Jevris proposes a subagent model only with evidence for that subagent type (an active learned slice for it, or a signed prior). In Claude Code it maps the model to an alias the Agent tool accepts (`haiku`, `sonnet`, `opus` or `fable`). In Codex it passes a Codex model id, and never a reasoning effort. It never overrides a model the tool call already names or a pin, and in Codex never a call that names a reasoning effort either. For this decision the sidecar sees only the subagent type, never the prompt, and sends back only a model id. Subagent outcomes do not feed learning yet, because the hooks report no subagent cost or result, and 1.2 ships no signed prior. So in 1.2 it abstains in practice, and the subagent keeps the model its harness chooses.

What Jevris **never** does, anywhere: grant a permission, answer a permission prompt, widen a sandbox, pass a "skip permissions" flag, or override a model you pinned. Uncertified means observe and advise only.

The one permission decision Jevris writes is on a certified Codex subagent route. Codex applies a rewritten `spawn_agent` call only when the hook answers `allow`, so there, and only there, Jevris answers `allow` with the call's own input plus the model. It does this on no other tool. Certify's `codex.subagent-route` case first checks that the subagent still asks for approval under the parent's approval policy and sandbox. Details: [architecture.md](architecture.md), [parity-matrix.md](harnesses/parity-matrix.md#how-to-read-it-on-your-machine).

### The kill switch

`jevris kill-switch activate` stops every Jevris effect on the machine at once: hooks, sidecar operations and CLI actions. Pending owned-worker effects are held until a person settles them with `jevris task reconcile`. `jevris kill-switch clear` resumes, and needs a person at a terminal.

## 4. Model routing and learning

**Routing** means choosing which model, and which **effort** level (how much the model thinks: low, medium, high, xhigh, max), suits a piece of work.

### The main session: advice, and one turn at a time in Kilo and OpenCode

For the session you are typing in, Jevris advises. `jevris route --model claude-opus-5-5` gives advice, and `applied` is always false. It never changes your session's model and always keeps a model you pinned. In Claude Code, Codex and Antigravity that is all it does.

In Kilo and OpenCode, with `routing.mainSession` at `plugin-bounded-auto` (the default) and the mode at `bounded-auto`, the plugin may run one turn on a routed model. It does so only for a session linked to a low-risk task, never on the session's first message or after you change the model yourself, and the next turn runs on the session's own model again. It needs `session.route`, which is certified only when its stub case passes on your installed binary (on macOS, the maintainer's run certified it for Kilo 7.8.1 and OpenCode 1.18.32). `jevris configure set routing.mainSession advice-only` turns it off. See [routing.md](routing.md#main-session-turns-on-kilo-and-opencode). Switching a model mid-session throws away the cached prompt, so advice counts that cost; without `--warm-prefix` the cost is unknown and the advice keeps your current model. See [routing.md](routing.md#route-advice).

### The default model

The default and baseline in Claude Code is **Opus 5.5** (`claude-opus-5-5`) at **medium** effort: 1M tokens of context and 128K of output. The registry names a baseline for two more harnesses: GPT-6 Sol (`gpt-6-sol`) in Codex and Gemini 3.8 Flash (`gemini-3.8-flash`) in Antigravity, each at that harness's default effort. The bundled model registry (snapshot `multi-2026-09-28`) lists seven providers: Anthropic (Opus 5.5, Fable 5.1, Opus 5 (legacy), Sonnet 5, Haiku 4.5), OpenAI (GPT-6 Astra, Sol and Luna; GPT-5.6 Sol, Terra and Luna), Google (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.1 Pro preview), xAI (Grok 4.7, Grok 4.6), Z.ai (GLM-5.3), Moonshot (Kimi K3) and DeepSeek (DeepSeek V4 Pro, DeepSeek V4.1 Flash).

**Models from other providers start unevaluated.** Routing, account eligibility and cost per task cover every provider in the registry, in each harness that reaches it: Claude Code for Anthropic, Codex for OpenAI, Antigravity for Google, and OpenCode and Kilo for any of them through a provider configuration. No signed result covers the 15 models from outside Anthropic, so:

- A model becomes eligible on a harness only once it has run there or the harness has listed it.
- A score from an independent coding benchmark can give a model a provisional prior. That lets an owned worker try it on a low-risk task under bounded-auto only, and it never switches a slice: a lasting switch still needs 12 local outcomes per arm.
- Kimi K3 and both DeepSeek models are left out until you grant that provider consent (`jevris consent provider <provider> --grant`), because those providers train on content by default.
- Gemini 3.1 Pro preview can be named in advice, but never in an automated route, such as an owned worker's.
- The default residency policy allows only `global` regions, so Grok, GLM, Kimi and DeepSeek also need an allowed region.
- Owned workers run models from all seven providers. GLM, Kimi and DeepSeek workers run in OpenCode or Kilo, through a provider configuration, and a Kimi or DeepSeek worker is refused (`PROVIDER_CONSENT_REQUIRED`) until you grant that provider consent.

An administrator can still replace the registry with their own file ([routing.md](routing.md#route-advice)).

### Route learning (owned workers only)

Route learning decides, per workspace and per **slice** (a kind of task, such as `bounded-edit`, `test-fix` or `docs`), which model and effort an owned worker uses. An **arm** is one model at one effort level. By default it tries Opus 5.5 at low and high effort beside the default medium.

How it learns, in plain terms:

- **Day 1 is the default.** Version 1.2 ships no signed baseline (no seed run was done for it), so every slice starts on Opus 5.5 at medium.
- **Low-risk routes only.** Learning explores and switches only on routes a fixed rule classes as low risk. A task is low risk only when it has acceptance checks, writes at most 5 files inside the workspace, touches no protected path (auth, secrets, CI, deploy, migrations, lockfiles, git internals) and is not labelled `security`. A plan can mark a task riskier, never lower. Details: [routing.md](routing.md#risk-class).
- **Outcomes come only from facts.** A verification receipt is a success or failure. A revert or retry turns an earlier pass into a failure. Stale, cancelled and usage-limited runs are counted but never labelled. A model's opinion is never a label.
- **Each outcome updates a probability** (a Bayesian posterior) that an arm is as good as the default, within a margin of 0.075 of the verified success rate.
- **Local evidence guard.** A slice switches only after this workspace has 12 of its own randomized outcomes on both the candidate and the default. Nothing else can switch it.
- **Exploration** means occasionally trying another arm on purpose, to learn. It runs on 10% of eligible low-risk routes while a slice is advise-only, and 5% once it has switched. Never on a pinned slice, and never with learning off.
- **Demotion is fast and automatic.** If the chance that the arm is worse rises above 0.40, or a recent window of 20 outcomes shows a regression, the slice goes back to the default.
- **A costlier arm** (higher effort) is taken only when no cheaper arm qualifies and it is probably better.

**Shared across your projects.** General slices share a machine-wide prior (what your other workspaces on this machine learned). It counts for at most 12 outcomes per arm, it never switches a slice without the 12 local outcomes, and it never leaves the machine. It holds counts and costs only, never paths, repository names or text.

### Cost and time per verified task

For each slice and arm, Jevris divides everything an arm spent (failures and retries included) by its verified successes, and does the same for wall-clock time. On an API key that is billed dollars; on a subscription it is tokens and usage-limit use, with dollars only as a labelled estimate. Once both arms have 5 verified tasks, an arm that turns out not to be cheaper per verified task goes back to the default.

### You stay in control

| Command | Effect |
| --- | --- |
| `jevris route learning status` | Each slice's mode, the evidence, and what it is waiting for |
| `jevris route learning off` | No switching and no exploration in this workspace; outcomes still counted |
| `jevris route learning pin bounded-edit claude-opus-5-5 --effort low --yes` | Fix a slice to a model and effort. A pin always wins |
| `jevris route learning automatic off` | Each change waits as a proposal for `accept` or `reject` |
| `jevris route learning reset --yes` | Every slice back to the default; local outcomes kept |
| `jevris route learning reset --clear-evidence --yes` | Also delete local outcomes and withdraw this workspace's share of the machine prior |
| `jevris route learning reset --machine --yes` | Clear the machine-wide prior for every workspace |

Only the CLI changes learning; no MCP tool or hook can. **Why a slice routes as it does:** `jevris explain <decision-id> --slice bounded-edit` shows the mode, policy version, priors, local outcomes and posterior. `jevris status` shows recent decisions. Details: [routing.md](routing.md#route-learning).

## 5. Owned workers and sign-in

An **owned worker** is a headless run of one of your installed harnesses that Jevris starts itself, to do one task, in its own git **worktree** (a separate checkout of the repository). You do not start it by hand.

### They start only when you submit work

Orchestration is on from install, but nothing starts on its own. Owned workers start only when you submit a plan and all of these hold:

- `orchestration.enabled` is `true`. This is the default from install. If you set it to `false` with `jevris configure set`, submitted tasks only queue;
- `routing.managedWorkers` is `bounded-auto`, and so is `mode` (the setting never goes above the mode). Both are the default from install. Raising either again with `jevris configure set` needs you at a terminal;
- the kill switch is clear;
- a model is found for the task. A task that names models runs only among them. A task that names none routes among every model in the registry that an installed harness reaches with a sign-in it holds, from a provider the consent rules allow. A vendor you did not name is tried only on an API key, except Gemini models on Antigravity's own sign-in. If no model is found, the task queues (`QUEUED_NO_MODEL`).

Work arrives from `jevris plan --submit` (CLI only, with a spending limit you set) or, if you turn on owned mode for a workspace, from the `jevris_submit_task` MCP tool.

In `bounded-auto`, route learning changes a worker's model or effort only on low-risk routes (see [section 4](#4-model-routing-and-learning)), and only after 12 of this workspace's own outcomes on each arm. Every other route runs the task's approved model.

### What a worker may do

- Only the tools the task was granted (read, search and edit by default). Web tools are denied. The prompt goes on standard input.
- Bounded by a turn cap, the task's budget and a timeout. Cancelling kills the whole process tree.
- No permission prompt is ever approved for it; one it cannot show is refused.
- Its change stays in its worktree. `jevris integrate` prepares an integration and `jevris integrate approve` fast-forwards your checkout. Nothing is ever pushed.
- The first event of each run is checked before any tool runs (model, working folder, permission mode, sign-in; what can be checked varies by harness). A mismatch stops the run on Claude Code and Antigravity, and demotes the feature. Antigravity enforces a read-only grant only after the fact, by killing the run.

Details: [routing.md](routing.md#owned-workers).

### Sign-in: subscription or API key

Each harness can run on a **subscription login** (for example Claude Pro or Max, ChatGPT, SuperGrok, a Google sign-in) or on a **vendor API key**. Jevris supports both. It reads only which mode is in use, never a key, token, email or account id. `jevris doctor` prints one auth line per harness; `workers.json` in the Jevris config folder can state the mode and always wins over detection ([routing.md](routing.md#harness-sign-in-subscription-or-api-key)).

Rules that follow:

- A subscription run never sees a vendor key, and a key run never sees a subscription token, so neither bills the other by accident.
- **Only unmodified Claude Code uses an Anthropic subscription.** On a subscription, Jevris runs your own `claude -p`. The Claude Agent SDK runs only with an API key. Claude models in OpenCode or Kilo need an Anthropic API key; a Claude subscription there is refused (`ANTHROPIC_LOGIN_THIRD_PARTY`).
- Antigravity runs only on its Google sign-in, through the official `agy` binary. That is within Antigravity's terms (see below).

### The vendor-terms risk (read this)

The project owner reviewed the vendors' terms on 27 September 2026 and decided to keep subscription-login workers working as they do today. A neutral summary of that review, and of the owner's later decision on Antigravity:

- **Anthropic.** Its terms treat `claude -p` as Agent SDK use. They say third-party products may not route requests through Free, Pro or Max credentials, and that consumer accounts may not be accessed by script except through an API key. They also allow an end user to sign in to the unmodified `claude` binary with their own subscription.
- **Antigravity (Google).** Its terms forbid using the Antigravity sign-in to reach Antigravity from other products. Jevris does not do that: it runs the official `agy` binary under your own Google sign-in, with the models Antigravity offers, and never takes that sign-in or its model access into another harness, product or API client. So the owner decided that this use is within Antigravity's terms, and owned workers, routing and exploration among Gemini models there use that sign-in. Gemini models in OpenCode or Kilo follow the Gemini API terms for the sign-in used there.
- **API-key use is clearly permitted by Anthropic.** Antigravity takes no API key here.

So: if you let Jevris drive a harness on a subscription login other than Antigravity's, **you accept a risk to that account** (for example suspension). If that risk matters to you, set `api-key` for that harness in `workers.json`. Whether driving other harnesses (Codex, OpenCode, Kilo, SuperGrok logins) under subscription terms is acceptable is flagged for legal review and is not settled. The decision will be revisited when a vendor answers in writing.

## 6. Verification: when work counts as done

### Declare the checks

Put a **check manifest**, `jevris.checks.json`, at the repository root (or `.jevris/checks.json`). Each check is a command as a list of arguments (never a shell string), a timeout, whether it is mandatory, and the files its result depends on. `jevris verify profile` looks at your repository (npm, pnpm, Python, Cargo, Go, Maven, Gradle, .NET and more) and proposes checks. It writes nothing.

### Approve them

Nothing runs until you approve it at the command line: `jevris verify approve` (the manifest) or `jevris verify approve --proposal` (what `profile` proposed). Approval records a hash of each check. If anyone edits a check later, even one argument, it does not run until you approve it again. Hooks, MCP tools and models cannot approve checks.

### Run them and read the receipts

`jevris verify` runs the approved checks without a shell, in a clean environment. Each run leaves a **receipt**: command, exit code, time, code revision and a hash of the output. The full output stays in the Jevris data folder; `jevris evidence get <handle>` prints it. A failed check names up to 20 failing tests. Long checks keep running in the background; run `jevris verify` again to read the result.

- A receipt is **current** only while its inputs are unchanged. Change a file it depends on, the branch or the lockfile, and it goes **stale**.
- **Verified** means every mandatory check has a current, passing receipt. **Unverified** means at least one is missing, failed, stale or still running. `unknown` and `not-run` never count as passed.
- A waiver (`jevris verify waive`) records who waived a check and why; it is reported as waived, never as passed. Signed CI results can be imported (`jevris verify import-ci`).

### At Stop: one reminder, never a trap

When the session stops with evidence missing, Jevris asks at most once for the same missing evidence. In Claude Code, Codex and Antigravity (where certified) this is one continuation at Stop naming the missing checks, and saying which are already running. A stop right after that continuation is never blocked, and a stop while every missing check is still running is simply labelled unverified. You can always stop; the work is then reported as unverified. Subagent stops are never held. Kilo and OpenCode have no stop gate yet.

Details: [verification.md](verification.md).

## 7. Privacy and your data

### What stays on your machine

Everything, by default: the database, logs, receipts, capsules, route learning and packs live in the Jevris data folder, readable only by you. There is no hosted dashboard. Remote telemetry is off, and `configure` only lets you keep it off. Aggregate outcome sharing between users is not built.

### What goes to Jev, and when

Jev is called only if you store a Jev key (`jevris credential set`, kept in the OS keychain), only by the sidecar, only within the budget, and only for a bounded question: for example a planning or intent check, a capsule ranking, or a background check on content-free safety signals. Rules decide first; routine reads and keystrokes trigger no call.

**Source egress** (sending text from your workspace) is denied until you approve it:

- While denied, a request to Jev carries no free text: no code, diffs, tool output, error text or commit messages. Only categories, counts, reason codes, sizes and salted hashes.
- `jevris egress status` shows the setting, where it comes from and what may be sent.
- `jevris egress approve` works only for a person at a terminal. It shows what approval allows and asks you to type `approve egress`. Even then, text is secret-screened and size-capped.
- `jevris egress revoke` turns it off again, with no terminal needed.
- A repository file, a prompt, a skill or a model summary can never approve egress. A managed or organization policy that denies it wins.

Your harness keeps talking to its own model vendor as it always does, and owned workers are runs of that same harness under your account. Jevris does not change what those send.

### Retention

| Data | Kept |
| --- | --- |
| Raw tool artifacts | 7 days |
| Decision records and other redacted records | 30 days |
| Pinned memory | Until you unpin or delete it |
| Route learning (per workspace) | Until `jevris route learning reset --clear-evidence` or `jevris data delete`; the 7- and 30-day windows never touch it |
| The machine-wide prior | Until `jevris route learning reset --machine` or `jevris data delete` |

You may shorten the windows; an administrator can cap them. `jevris data purge` applies retention now. Deleted rows are securely erased.

### Uninstall and deletion

- `jevris uninstall` removes only what Jevris added, and **keeps your data** by default.
- `jevris uninstall --delete-data` also deletes the data folder. `jevris data delete` deletes it separately (uninstall first).
- The config folder and the Jev key in the keychain stay until you remove them (`jevris credential clear`).
- **Local deletion is not vendor deletion.** Anything sent to Jev under approved egress follows the vendor's retention terms. "Not used for training" does not mean zero retention.

Details: [privacy.md](privacy.md), [security.md](security.md), [upgrade.md](upgrade.md#uninstall).

## 8. Models: the registry and retirement

Jevris ships a **model registry**: model ids, prices, limits and lifecycle dates, from dated public sources. Prices come from it; they are never guessed.

A model stays recommended until it is actually retired:

- A vendor's **"not sooner than"** retirement date only warns (`MODEL_RETIREMENT_DUE`: may be retired any day; refresh the registry). A deprecated model also stays usable with a warning.
- Recommendations **stop** on a firm announced retirement date, on `status: retired`, or when the model is **found gone** on this machine.
- **Found gone**: an owned worker or provider call got a structured "this model does not exist" signal. Jevris then never recommends, explores or launches that model here. A model that only one harness and sign-in cannot reach is marked for that harness alone.
- `jevris route learning gone` lists them; `jevris route learning gone clear <model-id> --yes` clears one once the model is back. The next registry refresh clears the list.

Keeping the registry current is a maintainer task: the model-refresh procedure in [CONTRIBUTING.md](../CONTRIBUTING.md#model-knowledge-refresh) reads public pages only, then `npm run registry:check` validates the result. You get it by upgrading Jevris. Details: [routing.md](routing.md#models-found-gone-on-this-machine).

## 9. What it costs you

There are two separate costs:

| Cost | Who bills it | What Jevris does about it |
| --- | --- | --- |
| **Jev decision calls** | TypeSafe, on your Jev key | Optional. Capped by a decision budget (5 USD per calendar month by default in the sidecar). Each hot-path decision has a 900 ms deadline, at most 12 questions, and a 131,072-byte request cap. When the budget is spent, the deadline passes or the provider fails, Jevris falls back to rules. The dated tariff in the code is 0.042 USD per million input tokens, output free |
| **Your harness usage** | Your model vendor, on your subscription or API key | Jevris does not see or bill it. Owned workers use it; learning measures it per verified task. On an API key that is dollars; on a subscription it is usage-limit consumption |

`jevris cost-report` shows what Jevris's own decision calls cost, as three labelled measures: actual, API-equivalent estimate, and counterfactual (what another route would have cost, a hypothesis and never a saving). An unmeasured figure reads "unmeasured", never zero. A Learning section adds, as counts only, how owned tasks' estimates compared with what they committed, how restores and Stop reminders turned out, and how often evidence that a selection ranked was then read. A sidecar too old to answer leaves the section out. `jevris budget status <budget-id>` compares one plan's estimates the same way.

### Offline and rules-only

With no Jev key, no network, or the budget spent, Jevris runs **rules-only**. Hooks, observation, verification, receipts, checkpoints, status, plan validation, route advice and route learning all keep working; only the Jev questions stop. `jevris status` shows "degraded" with the reason. Owned workers still need their harness's own vendor, which needs the network.

## 10. Requirements and platforms

| | Detail |
| --- | --- |
| Node.js | `^22.14.0 \|\| >=23.6.0` (Node-API 10). An older Node exits with one plain line |
| Operating systems | macOS, Linux and Windows, on x64 or arm64. Native modules ship prebuilt; no compiler needed |
| Jev key | Optional. macOS Keychain, Windows Credential Manager or Linux Secret Service. On headless Linux, CI or WSL you may opt in to an owner-only key file or a systemd credential |
| A harness | At least one of the five, signed in with a subscription or an API key |
| Git | Owned workers run in git worktrees |

What has actually been tested:

- **CI** runs on macOS, Linux and Windows, with Node 22.14.0, 24 and the current release, plus an installed-package smoke test.
- **Live harness certification** exists on macOS only: the maintainer's own install certified all five harnesses there with a local key, owned workers (`worker.route`) included. Linux and Windows records are pending, and release-grade records (signed by a release key from a clean build) are pending on every OS. See the [parity matrix's Certification section](harnesses/parity-matrix.md#certification).
- **Linux** passed the full suite and the installed-package smoke test in containers; no live harness certification on Linux is recorded.
- **Windows** certification comes later. The Windows harness cells are expected to match macOS, but count as certified only once a Windows record exists.
- **Minimum harness versions** are not documented. Instead, each certification covers a version range, and `jevris doctor` says what is covered on your machine.

See [platform-support.md](platform-support.md) and [installation.md](installation.md).

## 11. Limits and honest caveats

- **Other providers' models are unproven here.** The 15 models from outside Anthropic carry no signed result: each becomes eligible only once it has run or been listed on your harness, is tried only on low-risk tasks, and needs 12 local outcomes before a lasting switch. Kimi and DeepSeek need your consent per provider, a preview model never enters an automated route, and GLM, Kimi and DeepSeek owned workers run only in OpenCode or Kilo (section 4).
- **Many controls are unsupported in some harnesses.** For example: no status line in any harness; Codex never registers PermissionRequest; Antigravity has no PreToolUse hook (its "allow" would grant permission) and no compaction event; Codex has no tool-failure hook and reports no exit status for shell commands, so a failing shell command there is not recognised as a failure; Antigravity hooks carry no user prompt. `jevris doctor` prints each gap on the harness's `parity` line. See the [parity matrix](harnesses/parity-matrix.md).
- **Subagents are observed, not governed.** A subagent's events are recorded under its parent session. Its stop is never held. For each subagent, in every harness that reports one, Jevris keeps only the harness, the subagent's type when the harness names it, when it started and stopped, the route reason code for its launch when the harness names the subagent's type (Jevris can choose the model only in Claude Code, and in Codex, Kilo and OpenCode once their stub case passes), and whether the parent session later verified. It never reads a subagent's transcript. The one label a subagent gets is its parent's: when the parent session's stop finds a mandatory check's receipt (a pass or a fail), each subagent that had stopped by then is recorded once for its type, on the model it ran, as an observation. An observation moves route learning a little but never switches a route on its own, and a subagent whose model a person chose is never recorded. It keeps the harness's native permissions. Certify checks the Codex subagent route with a real turn against a local stub provider, so no model is billed. That check has not passed yet on Codex 0.157.1, so Codex subagent routes are shown as text for now. The rest of subagent behaviour is not certified ([parity-matrix.md](harnesses/parity-matrix.md#subagents)).
- **Jevris makes no permission decisions, with one narrow exception.** Your harness's permissions and sandbox remain authoritative in every session, subagent and owned worker. The exception is the `allow` on a certified Codex `spawn_agent` route (section 3), which Codex needs before it applies the chosen model. The subagent still runs under the parent's approval policy and sandbox.
- **Your user account is the security boundary.** The sidecar keeps other users and the network out. It cannot contain something already running as you: a compromised OS account is outside what a same-user sidecar can reliably contain ([security.md](security.md)).
- **Performance targets are unmeasured.** The design targets (rules-only answers under 25 ms, launcher under 100 ms, Jev decisions under 800 ms inside the 900 ms budget) have not been benchmarked. They are not promises.
- **No live benchmark exists yet.** No live Jev benchmark, no measured end-to-end coding quality or cost result, and no seed run. Jevris makes no speed or cost claim; learning in your workspace is the only evidence it acts on.
- **Release status.** Version 1.2.0 is a release candidate and is not on npm yet; `npx @webventures/jevris` works only once it is. The release gates (`jevris gates`) do not pass yet: they need external evidence such as release-signed certification records per harness and OS (the [platform support](platform-support.md) table lists which exist), the live Jev suite, an independent security review, and Linux and Windows drills. See [RELEASING.md](../RELEASING.md).
- **Owned workers on subscriptions carry account risk** (section 5).

## 12. Should you use it?

### Who it is for

- A developer in a trusted repository they control, who uses one or more of the five harnesses.
- Someone who wants an honest "is this really done?" answer from their own tests, with receipts.
- Someone who wants a record of every decision and a way to ask why.
- Someone willing to try owned workers and let routing learn from verified outcomes over weeks, with pins and an off switch.

### Who it is not for (yet)

- Anyone who needs a signed, released, supported package today.
- Anyone who needs Windows certification, or live certification on Linux.
- Teams that need a hosted dashboard, shared cross-user learning, or central telemetry.
- Anyone who cannot accept any account risk on a subscription login and does not want to use API keys for owned workers.
- Anyone expecting it to enforce policy on a compromised machine, or to replace harness permissions.

### Checklist

- [ ] My Node is `^22.14.0 || >=23.6.0`.
- [ ] I use at least one of Claude Code, Codex, Kilo CLI, OpenCode or Antigravity.
- [ ] I am happy for Jevris to add plugin files to my harness config (backed up, and removable with `jevris uninstall`).
- [ ] I can declare my tests as a check manifest, or accept what `jevris verify profile` proposes.
- [ ] I understand that without source-egress approval nothing from my code goes to Jev, and I know who may approve it.
- [ ] If I will use owned workers on a subscription login other than Antigravity's, I accept the vendor-terms risk, or I will use API keys.
- [ ] I accept that this is a 1.2.0 release candidate with unmeasured performance.

### Getting started in 10 minutes

Until 1.2.0 is on npm, run from a checkout of this repository (`npm ci --ignore-scripts`, `npm rebuild esbuild`, `npm run build`, then `node bin/jevris.mjs` in place of `jevris` for the first install; install puts a `jevris` command on your PATH). Once released, `npx @webventures/jevris` works the same way.

```sh
jevris --version
jevris install --dry-run                 # see every change; nothing is written
jevris install --yes                     # install into all five harnesses and certify them (no model call)
jevris doctor                            # what works here, and the fix for anything that does not
jevris credential set                    # optional: store a Jev key; without one Jevris runs rules-only
jevris egress status                     # confirm nothing leaves the machine
jevris verify profile                    # in your repository: proposed checks
jevris verify approve --proposal         # approve them
jevris verify                            # run them; verified or what is missing
jevris status                            # mode, sidecar, recent decisions, kill switch
```

Then restart Claude Code (and check `/plugin` and `/hooks`), or trust the hooks in Codex with `/hooks`. To remove Jevris later: `jevris uninstall` (keeps data) or `jevris uninstall --delete-data`.

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Actuate** | Actually change something (add context, block a stop once, start a worker), as opposed to observing or advising |
| **Advise** | Say what Jevris would do and why, without doing it |
| **API key mode** | A harness billed per token on a vendor key |
| **Arm** | One model at one effort level, as a learning option |
| **Capsule** | A saved memory of the objective, constraints and changed files (`jevris checkpoint`), restored after compaction where certified |
| **Certification record** | A signed file proving which features work for a harness version range on an OS |
| **Check manifest** | `jevris.checks.json`: the commands that prove your work |
| **Compaction** | A harness shrinking the conversation to fit its context window |
| **Degraded** | Decisions run rules-only (no key, budget spent, provider failing) |
| **Doctor** | `jevris doctor`: the report of what works on this machine |
| **Effort** | How much a model reasons: low, medium, high, xhigh, max |
| **Egress** | Data leaving your machine. Source egress is denied until you approve it |
| **Exploration** | Deliberately trying another arm on a small share of routes, to learn |
| **Found gone** | A model a launch found missing on this machine; no longer recommended here |
| **Harness** | Your coding tool: Claude Code, Codex, Kilo, OpenCode or Antigravity |
| **Hook** | A command the harness runs on an event; Jevris uses hooks to observe and, where certified, act |
| **Jev** | TypeSafe System One, the paid decision model Jevris asks bounded questions |
| **Kill switch** | `jevris kill-switch activate`: stops every Jevris effect at once |
| **MCP** | Model Context Protocol: how a harness gives its model tools. Jevris adds 17 |
| **Observe** | Record only; change nothing |
| **Owned worker** | A headless harness run Jevris starts for one task in its own worktree |
| **Pin** | Your fixed choice of model (and effort) for a slice; always wins |
| **Posterior / prior** | The probability estimate after / before local outcomes |
| **Receipt** | The record of one check run: command, exit code, revision, output hash |
| **Reduced** | Works with less, for example status answered from local files |
| **Refused** | Declined for a safety reason; nothing changed |
| **Registry** | The bundled list of models with prices, limits and lifecycle dates |
| **Rules-only** | Jevris without Jev: deterministic rules alone |
| **Sidecar** | The one local background Jevris process per user |
| **Skill** | A short instruction file the harness loads by name |
| **Slice** | A kind of task for routing, such as `bounded-edit` or `test-fix` |
| **Stale** | A receipt whose inputs changed since it ran; it no longer counts |
| **Subscription mode** | A harness running on your plan's login, which spends usage limits rather than dollars |
| **Unsupported** | Not certified or not possible in this harness; Jevris only observes there |
| **Unverified** | At least one mandatory check lacks a current passing receipt |
| **Workspace** | A repository Jevris works in; learning and receipts are kept per workspace |
| **Worktree** | A separate git checkout an owned worker writes in, so your checkout is untouched |
