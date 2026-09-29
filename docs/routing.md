# Model routing, route learning and owned workers

Jevris advises which model, and which effort level, suits a piece of work. For your main session it only advises: you, or your harness, decide. For owned workers, the harness runs that Jevris starts itself to do a leased task, it may choose the model and effort when the run starts, within the limits on this page.

- [Route advice](#route-advice)
- [Harness sign-in: subscription or API key](#harness-sign-in-subscription-or-api-key)
- [Access limits: when an account runs out](#access-limits-when-an-account-runs-out)
- [Models served by several hosts](#models-served-by-several-hosts)
- [Owned workers](#owned-workers)
- [Route learning](#route-learning)

## Route advice

```sh
jevris route --model claude-opus-5-5
jevris route --task fix-parser --slice bounded-edit
```

The same advice is the `jevris_plan_route` MCP tool and the `route` skill. It never switches a model and never overrides a model you pinned: `applied` is always `false`, and `--pin` (or `modelPin`) is always kept. A switch of the main session is priced with the cost of moving its cached prompt prefix to the new model; without `--warm-prefix` that cost is unknown, and the advice keeps the current model. Every option is in [cli.md](cli.md#jevris-route).

`mode` is the ceiling on everything below ([settings.md](settings.md#modes)). In `off`, `jevris route` is refused with `MODE_OFF`. Advice needs `advise` or above. A model switch or an owned worker needs `bounded-auto`, the default; `routing.mainSession`, `routing.managedWorkers` and `orchestration.enabled` can only narrow it.

The baseline model on Claude Code is Opus 5.5 (`claude-opus-5-5`): 1M tokens of context, 128K tokens of output, default effort `medium`. Codex's baseline is GPT-6 Sol (`gpt-6-sol`) and Antigravity's is Gemini 3.8 Flash (`gemini-3.8-flash`), each at its harness's default effort (the registry's `harnessDefaults`). The product ships a model registry snapshot (`multi-2026-09-29`) with seven providers: Anthropic (Opus 5.5, Fable 5.1, Sonnet 5.5, Opus 5 (legacy), Sonnet 5 (legacy), Haiku 4.5), OpenAI (GPT-6 Astra, Sol and Luna; GPT-5.6 Sol, Terra and Luna), Google (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.1 Pro preview), xAI (Grok 4.7, Grok 4.6), Z.ai (GLM-5.3), Moonshot (Kimi K3) and DeepSeek (DeepSeek V4 Pro, DeepSeek V4.1 Flash). Every entry carries its sources, its list price in integer micro-USD beside the float form, any long-context tier or announced price change, and its provider's data terms per sign-in. Claude Sonnet 5.5 (`claude-sonnet-5-5`, released 28 September 2026) costs $2 input and $10 output per million tokens ($0.20 cache reads, $2.50 and $4 for 5-minute and 1-hour cache writes), the same as Sonnet 5, with 1M tokens of context, 128K of output and effort `low` to `max` (default `high` on the API; Claude Code starts it at `medium`). Contributors refresh it with the procedure in [CONTRIBUTING.md](../CONTRIBUTING.md#model-knowledge-refresh).

**Other providers pass the same gates, and two more.** The non-Anthropic entries are unevaluated: no signed prior covers them, so learning explores them only with the evidence described under [Board priors](#board-priors-for-a-model-with-no-calibration), and a model becomes eligible on a harness only from local evidence. Two gates are new. A model marked `requiresProviderConsent` (Kimi K3 and both DeepSeek models, whose providers train on content by default) is eliminated with gate `provider-consent` until you grant that provider consent (`jevris consent provider`). For an owned worker, a provider you are signed in to on an installed harness (an API key or a subscription) needs no grant unless you revoked it or the consent text changed, and any other provider needs one. Route advice, subagent routes and per-turn switches use the same rule for the session: its harness's own provider and its current model's provider count as signed in, and `jevris route` lists the providers its advice considered. Consent that cannot be read, for example with no store open, allows no provider. A model no installed harness reaches is eliminated with gate `no-harness` (`NO_HARNESS_FOR_PROVIDER`). A `preview` model (Gemini 3.1 Pro preview) may be named in advice, but an automated route, such as an owned worker's, eliminates it with gate `preview`. The default residency policy allows only `global` regions, so Grok, GLM, Kimi and DeepSeek also need an allowed region. An administrator can still replace the registry with an unsigned `model-registry.json` in the Jevris config folder, validated against the registry schema. Some rules are fixed in the code, so a replacement registry cannot loosen them. Moonshot, DeepSeek and any provider without a consent text always need a grant, whatever the file marks. A harness spelling must name its own provider (for example `moonshotai/` only for Moonshot) and never another registered model. A file that breaks this is refused as `MODEL_REGISTRY_INVALID`. See the [parity matrix](harnesses/parity-matrix.md).

## Harness sign-in: subscription or API key

Each harness can run on your subscription login or on a vendor API key. Both are supported equally. Jevris reads only which mode is in use, never a key, a token, an email or an account id.

### Stating the mode: `workers.json`

`workers.json` in the Jevris config folder (see [configuration.md](configuration.md#folders)) states the mode per harness, and optionally which harness runs each model provider's models:

```json
{
  "schemaVersion": "jevris-workers-1",
  "auth": { "claude": "subscription", "codex": "api-key", "opencode": "subscription", "kilo": "auto", "antigravity": "auto" },
  "harness": { "anthropic": "claude", "openai": "codex", "xai": "opencode", "google": "antigravity" }
}
```

| Key | Values |
| --- | --- |
| `auth.<harness>` | `auto` (the default), `api-key` or `subscription`, for `claude`, `codex`, `opencode`, `kilo` and `antigravity`. |
| `harness.anthropic` | `claude`, `opencode` or `kilo` |
| `harness.openai` | `codex`, `opencode` or `kilo` |
| `harness.xai` | `opencode` or `kilo` |
| `harness.google` | `antigravity`, `opencode` or `kilo` |
| `harness.zai`, `harness.moonshot`, `harness.deepseek` | `opencode` or `kilo` |

For Claude Code and Codex, `auto` means `api-key` when the harness's vendor key is set in the environment (`ANTHROPIC_API_KEY` for Claude Code; `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex), and `subscription` otherwise.

OpenCode and Kilo hold their own logins and keys for each model provider, so for them `auto` follows what the harness holds for the provider of the model being run, first match wins:

1. The provider's key is set in the environment (for example `XAI_API_KEY` for a Grok model): `api-key`.
2. The harness's credential list cannot be read (not installed, or not probed in a test run or under a home that is not your account's own): `subscription`.
3. The harness has an API key stored for the provider: `api-key`. A run on a stored key is billed to that key and recorded as `api-key`, never as a subscription.
4. The harness has an OAuth login stored for the provider: `subscription`. An Anthropic login does not count; see the Claude rule below.
5. Nothing is stored for the provider: the run is refused before it starts with `<PROVIDER>_NO_LOGIN` (for example `XAI_NO_LOGIN` or `OPENAI_NO_LOGIN`), and the message says how to sign in or store a key in the harness, or which variable to set.

Each run records the mode it used and where the mode came from: `declared` (workers.json), `environment`, `stored-key`, `stored-login` or `undetected`. Jevris reads only each stored credential's provider and type, never a value. `undetected` is a subscription Jevris assumes but never saw, so on its own it does not count as signed in for the provider-consent default. The provider counts once Jevris has seen a harness on this machine run one of its models (a main session's reported model, or an owned run's). Until then a model from it runs only with its consent, a key in the environment, or the mode declared in workers.json (for example `"auth": {"claude": "subscription"}`). Antigravity signs in only with Google: its `auto` is always that sign-in, and `api-key` is refused. A file that is not valid JSON, lacks the `schemaVersion`, or names an unknown harness, provider or value refuses every owned worker until it is fixed. `jevris doctor` prints `workers.json: <problem>; owned workers are refused until it is fixed`.

### What doctor shows

For each installed harness, `jevris doctor` prints one auth line, for example:

```text
harness claude auth: subscription (auto: no vendor key in the environment; the harness reports a subscription login)
harness opencode auth: api-key (stated in workers.json; not detected; XAI_API_KEY in the environment for Grok models)
harness antigravity auth: google sign-in (auto: always its Google sign-in; Antigravity refuses api-key)
harness kilo auth: unknown (not detected, and not stated); state it in <config>/workers.json (subscription or api-key), for example {"schemaVersion":"jevris-workers-1","auth":{"kilo":"subscription"}}
```

Doctor asks each harness which sign-in it holds, with commands that only read:

- Claude Code: `claude auth status --json`. Codex: `codex login status`.
- OpenCode and Kilo: `opencode auth list` and `kilo auth list`. Jevris reads only each stored credential's provider and type, never a value. A stored OAuth login is a subscription, stored keys only are an API key, and no credential is no login. An Anthropic OAuth login does not count, because a Claude subscription runs only in Claude Code. This line sums up the harness as a whole; a run decides for the provider of its model, in the order above.

Doctor never runs these probes in a test run, or under a home that is not your account's own. `jevris install` runs the same detection. On a terminal it asks once for each harness it cannot detect and records the answer in `workers.json`, keeping the rest of the file. A stated mode in `workers.json` always wins over detection.

### Rules that follow from the mode

- **A subscription run never sees a vendor key**, so it cannot bill a key by accident. **A key run never sees a subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`), so it cannot spend your plan by accident. Values are moved in memory only; nothing is written to disk or argv.
- **Claude and the Agent SDK.** Anthropic does not allow third-party products to use a claude.ai login through the Claude Agent SDK. So the Agent SDK runs only with an API key (`ANTHROPIC_API_KEY`). On a subscription, Jevris runs your installed Claude Code (`claude -p`) under your own login.
- **Claude models in OpenCode or Kilo** need `api-key` mode: `ANTHROPIC_API_KEY` in the environment, or an Anthropic API key stored in the harness. A Claude subscription login runs only in Claude Code, so Jevris refuses the run with `ANTHROPIC_LOGIN_THIRD_PARTY`.
- **Grok models (xAI)** run in OpenCode or Kilo. On a subscription they use the harness's own SuperGrok login, and the run never sees `XAI_API_KEY`. In `api-key` mode they use `XAI_API_KEY` or an xAI key stored in the harness; declaring `api-key` with neither is refused with `XAI_API_KEY_MISSING`. Under `auto`, the order above applies: `XAI_API_KEY` or a stored xAI key is `api-key`, a stored SuperGrok login is `subscription`, and nothing stored is `XAI_NO_LOGIN`. Whether a SuperGrok plan covers third-party harnesses is unconfirmed, so an HTTP 403 from xAI is named `XAI_PLAN_NOT_ELIGIBLE`, and an HTTP 401 or a missing login `XAI_AUTH_FAILED`, each with its fix.
- **Antigravity** runs only on its Google sign-in. A subscription run sees no vendor or Google key. Jevris reads this as within Antigravity's terms: it runs the official `agy` binary under your own sign-in and never takes that sign-in or its model access into another harness, product or API client, which is what the terms forbid. So owned workers, routing and exploration among Gemini models on Antigravity use that sign-in. Gemini in OpenCode or Kilo follows the Gemini API terms for the sign-in used there.
- Whether driving the other harness CLIs under a subscription is acceptable under each vendor's terms is flagged for the owner's legal review. It is not asserted as settled.

### Costs follow the mode

| Mode | What Jevris counts |
| --- | --- |
| API key | Dollars, priced per token from the model registry. |
| Subscription | Usage-limit consumption. There is no per-token charge, so dollars appear only as a labelled API-equivalent estimate. |

Usage is compared only within one vendor's pool. A Codex allowance and a Claude allowance are not the same currency. When route learning weighs a candidate from another vendor than the baseline, for example GPT-6 Luna against Opus 5.5 on a subscription, it compares API-equivalent dollars instead. Explain then says "API-equivalent dollars, an estimate". The same vendor, or an API key, keeps the rule in the table.

**Access limits.** When a run or a session hits a rate limit, a usage window, exhausted credit or a blocked account, Jevris pauses that account on this machine; see [Access limits: when an account runs out](#access-limits-when-an-account-runs-out).

A limit is recorded as an outcome, not as the task failing. With some harnesses on each mode, each harness is priced by its own mode. `jevris route --auth-mode <mode>` labels a main-session switch cost the same way, and `jevris cost-report` keeps Jevris's own decision costs apart as actual, API-equivalent estimate and counterfactual. Those decision calls to Jev are capped at 5 USD per calendar month (UTC); when that is spent, decisions run rules-only until the next month. The cap is not user-settable in this release (see [configuration.md](configuration.md#the-jev-decision-budget)).

## Access limits: when an account runs out

A harness can stop because its account has run out: a short rate limit, a usage window (a 5-hour, daily or weekly allowance), exhausted credit, or a blocked account or refused key. Jevris notices this from the harness's own error, pauses that account on this machine, and keeps routing and owned workers away from it until it recharges. It never spends a call to test whether a pause has ended. A pause only narrows what Jevris routes and launches; it never grants anything. An overloaded provider is different: it is the provider's load, not your account, so it is never recorded as a pause.

### What Jevris notices when you run out

This is the state of this release, per harness and sign-in. "Owned run" is a worker Jevris starts; "session" is your own interactive harness session. A session's sign-in is not known to the hook, so a pause from a session applies to both sign-ins of that harness and host, owned runs included.

| Harness and source | Rate limit | 5-hour or daily window | Weekly window | Credit exhausted | Account blocked or key refused |
| --- | --- | --- | --- | --- | --- |
| Claude Code, owned run, API key (Agent SDK) | Yes, reset from the response headers | Yes, with the reported reset | Yes, with the reported reset; an Opus-only or Sonnet-only weekly limit pauses only that family | Yes, no expiry | Yes, no expiry |
| Claude Code, owned run, subscription (`claude -p`) | Yes, from the rejected rate-limit event or the rate-limit error code | Yes, the five-hour window with its reset | Yes, with its reset; an Opus or Sonnet weekly window pauses only that family | Yes (billing error code), no expiry | Yes (sign-in error code), no expiry |
| Claude Code, session | Yes, 60 s backing off to 1 h | Yes, until the stated reset; "You've hit your session limit" or "usage limit reached" with no usable time is paused as a 5-hour window, doubling on repeats | Yes, 7 days or the stated reset; a limit that names Opus or Sonnet pauses only that family, any other every Claude model on that account | Yes, no expiry | Yes, no expiry |
| Codex, owned run (either sign-in) | Yes, from a pinned wording (Codex reports limits only as text) | Yes, from a pinned wording | Yes, from a pinned wording | Held as a timed 5-hour window, unless `access.detect` is certified for your Codex version | Held as a timed 5-hour window, unless `access.detect` is certified for your Codex version |
| Codex, session | No: Codex hooks carry no failed-turn error | No | No | No | No |
| Kilo and OpenCode, owned run (either sign-in) | Yes, reset from the response headers, else 60 s backing off to 1 h | Yes for Z.ai's window codes, and for a 429 whose headers give a reset more than 1 h away | Yes for Z.ai's weekly code | Yes (HTTP 402 or a credit code), no expiry | Yes (`ProviderAuthError` or HTTP 401), no expiry, with the sign-in command |
| Kilo and OpenCode, session | Yes, reset from the response headers, else 60 s backing off to 1 h | Yes for Z.ai's window codes, for any 429 whose headers give a reset more than 1 h away, and for a 429 that says "session limit" or "usage limit reached" with no reset header (a 5-hour window) | Yes for Z.ai's weekly code, or when the error says weekly | Yes (HTTP 402 or a credit code), no expiry | Yes (HTTP 401 or an auth error), no expiry |
| Antigravity, owned run | Yes for a per-minute or per-second limit | Yes for a daily or usage quota, for the default time (a stated reset is not trusted) | Yes, weekly quota | Held as a timed pause, never one with no expiry | "API key was reported as leaked" and "The API key is missing, invalid, or expired.", each held as a timed pause |
| Antigravity, session | Yes for a per-minute or per-second limit, 60 s | Yes for a daily or quota limit, 5 h (a stated reset is not trusted) | Yes, 7 days | Held as a 5-hour pause, never one with no expiry | "API key was reported as leaked" and "The API key is missing, invalid, or expired.", each held as a 5-hour pause; other refusals are not recognised |

Where the table says "Yes", the pause starts from that harness's own error channel. Where it says 5 hours, that is the default base of a usage window; a workspace's route-learning cooldown changes it ([What is paused](#what-is-paused)). A session is watched only when its hooks are installed:

- **Claude Code** registers its `StopFailure` hook only once a certification record proves `access.session` for your installed Claude Code (see the [parity matrix](harnesses/parity-matrix.md#access-limits)). Until then a Claude Code session's limit is not read at all. `jevris install --harness claude` adds the hook once the record allows it, and `jevris doctor` says when the two disagree.
- **Antigravity** sessions are read through its `Stop` hook, which install enables once `hooks.observe` is certified.
- **Kilo and OpenCode** session events are always installed.

A session whose provider endpoint is redirected (a custom base URL, `apiKeyHelper`, or a project config that redefines the provider) records nothing, because Jevris cannot tell whose account it is.

**Owned runs.** An owned run through a harness CLI ends as `access-limit` (or `overloaded`), not as the task failing, and records the pause the table gives. Each port reads its harness's own error channel; `jevris certify` checks those readers (the `<harness>.access-limit.*` cases, `access.detect`). A run whose endpoint is redirected (a base-URL override, a custom provider, or a project config that redefines the provider) reports no limit, for the same reason as a session. A subscription run has no key to fingerprint, so its pause with no expiry clears with `jevris route limits clear` or a later success.

**Codex usage read (ChatGPT sign-in).** Besides reading errors, the Codex model listing asks Codex once how much of the plan is left (`account/rateLimits/read`, answered by OpenAI from your own login; no model runs and nothing is billed). It is sent only when `routing.modelListing` is on and `models.list` is certified, never with `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment, and only when `codex login status` says ChatGPT. It waits at most 3 s after the models. A used-up window, or usage reported as not allowed, pauses owned Codex runs on that sign-in until the reset, always as a timed pause. A reading lifts a pause only when `access.usage-read` is certified for your Codex version. The reading must also say usage is allowed and show no used-up window. Even then it lifts only that sign-in's usage-window pauses last seen at least 2 minutes before the reading, never exhausted credit, a blocked account, a rate limit or a held text match. Certify case `codex.usage-read` proves the read under the operating system's network isolation (macOS `sandbox-exec`, Linux a network namespace with only loopback). On Windows, or where that isolation cannot start, the feature stays unsupported (`ACCESS_USAGE_ISOLATION_UNAVAILABLE`) and a reading only sets pauses. See [codex.md](harnesses/codex.md).

### What is paused

A pause covers one harness, one sign-in (API key, subscription, or unknown for a session) and the serving host that answered. A rate limit also names the model, and a weekly family limit names the family; every other class pauses the whole account on that host. For a Claude or Codex API key that Jevris passes to an owned run, the pause also carries a 16-character fingerprint of the key, so a pause with no expiry on that key covers another harness using the same key. An owned run through OpenRouter on an API key carries the fingerprint of the host's own key (`OPENROUTER_API_KEY`), never the maker's, and a direct Kilo or OpenCode run on an API key carries the fingerprint of the one maker key Jevris passes. A host key and a maker key therefore never clear each other's pauses. The Kilo Gateway is a sign-in, not a key, so its pauses carry no fingerprint.

| Class | How long |
| --- | --- |
| Rate limit | 60 s, doubling on each repeat up to 1 h. A reported reset more than 1 h away makes it a usage window. |
| Usage window | The reported reset, when it is in the future and at most 8 days away. Otherwise the base, doubling on each repeat up to 7 days: 5 hours, or the workspace's route-learning cooldown (`limitCooldownHours`, clamped to 15 minutes to 168 hours) when its learning state sets one; a weekly window is 7 days. The doubling starts again after 7 quiet days. A limit that says it is a session or usage limit is a usage window even with no usable reset, never a 60-second rate limit. |
| Credit exhausted, account blocked | No expiry, when the harness or API reports it in a structured field, or when a pinned text pattern matched on a channel that a signed certification record proves for the running harness version (`access.detect` for an owned run, `access.session` for a session, at the version the session reported, else the installed one). Any other wording matched only as text is held as a timed usage window instead, so a changed or forged message cannot pause an account for good. |
| Overloaded | Never paused. An owned run's task is blocked with `PROVIDER_OVERLOADED`. |

### What a pause does

- **Owned workers.** Before each launch the runner checks the record. A paused scope launches nothing, and the task is blocked, never failed, with a reason naming the class, the scope and when it ends, for example `ACCESS_LIMITED: usage-window on claude api-key anthropic paused until 2026-09-28T17:00Z (reported); resumed once then if owned workers run automatically and its checks are still approved, else start it again then`. Every owned path checks it:
  - A routed task leaves paused models out. When the baseline itself is paused, the router picks the best model that is not (`BASELINE_ACCESS_LIMITED`).
  - When the router does not launch (routing not certified, or no route), the approved model goes to the same launch check. A paused baseline therefore launches nothing, and the task is blocked with `ACCESS_LIMITED`; there is no fallback port that runs it anyway.
  - The one bounded escalation skips a paused model, and a task that names no model leaves paused models out of its default set.
  - Route learning labels a run that hit a limit `usage-limited` on every path (routed, unrouted, uncertified and escalated). It is counted, never a success or a failure.
- **Subagent routes and main-session turns.** A route never proposes a paused model, and it answers `ACCESS_LIMITED` when its target is paused. When your current model is paused, a main-session turn gets advice only; Jevris never moves your session to another model to escape a limit.
- **Every workspace on the machine.** The record is per machine, so a limit hit in one workspace pauses that account for the others too.

### How a pause ends

- A timed pause lifts at its reset. Entries are removed 7 days after they lift.
- Any pause clears when a run on exactly that scope then succeeds. A session's pause clears when a later turn in it finishes without an error; the failed turn itself never clears its own pause.
- A pause with no expiry clears with `jevris route limits clear`. For a Claude or Codex API key that Jevris passes, it also clears when that key changes; so does a pause from an owned run through OpenRouter when the `OPENROUTER_API_KEY` Jevris passes changes (its reason says "the openrouter API key"), and a pause from a direct Kilo or OpenCode run on a maker's API key when that maker's key changes (for example "the moonshot API key"). For Kilo and OpenCode, Jevris fingerprints a maker key only when exactly one distinct key is set across that maker's variables. A maker whose key sits in two variables with different values (`GEMINI_API_KEY` and `GOOGLE_API_KEY`, or `OPENAI_API_KEY` and `CODEX_API_KEY`) gets no new-key clear there, because which one the harness reads is not known. Only the environment key is seen: a key set in the Kilo or OpenCode config (`provider.<id>.options.apiKey`) is not, so changing it does not clear a pause. Antigravity has no key Jevris passes, so its pauses never clear on a new key. The task reason names only the ways that apply to it.
- **A blocked task resumes by itself, once per limit episode.** While the sidecar runs, it checks every minute; with the sidecar stopped, nothing resumes. A task blocked with `ACCESS_LIMITED` or `PROVIDER_OVERLOADED` goes back to ready, and owned work continues, only when all of these hold:
  - automatic workers are on (`orchestration.enabled` and `routing.managedWorkers` `bounded-auto`) and the kill switch is clear;
  - the wait is over: the reset time passed, the pause was cleared (by you or by a later success), or a new key was stored for that harness;
  - no pause covers the task's model on the harness and sign-in it ran on;
  - the task is still blocked for that reason, and every acceptance check of the task is still approved.

  A pause with no reset time resumes the task only after it is cleared: by you with `jevris route limits clear`, by a later success, or by a new key for Claude, Codex, an owned run through OpenRouter, or a direct Kilo or OpenCode maker key. An overloaded task is retried the same way after the time its reason gives, up to 3 times. If the task hits a limit again after its one resume, or its retries are used up, it waits for you: its reason says so, and you start it again. In advise or observe mode nothing resumes, and an access record that cannot be read resumes nothing (`ACCESS_LIMITS_UNREADABLE`).

### Seeing and clearing pauses

```sh
jevris route limits
jevris route limits --json
jevris route limits clear 2
jevris route limits clear --all
```

- `jevris route limits` lists each pause in force with its number, class, scope, when it lifts (or since when) and whether it came from an owned run or a session. It reads the record directly and needs no sidecar.
- `jevris route limits clear` removes the numbered pauses, or all of them. It works only for a person at an interactive terminal, asks once, has no `--yes`, needs the running sidecar and is audited (the count and classes only).
- `jevris status` shows `access limits: N active (see jevris route limits)` and one line per pause while any pause is in force, and says so when the record cannot be read or is full. `jevris doctor` reads the record without a sidecar and prints an `accessLimits` count line and one `accessLimit` line per pause, in the same words; a timed pause is information there, while a pause with no expiry, or a record it cannot read, is an action ([troubleshooting.md](troubleshooting.md#reading-the-doctor)).
- `jevris status` also shows the last Codex usage reading per sign-in, under `usage readings (the harness's own account windows):`. For each window it shows a band (under 50%, 50-80%, 80-100% or used up), whether it is weekly, and its reset, plus "usage not allowed" when Codex said so. It never shows the percentage or the raw reading. `jevris doctor` prints one `accessUsage` line per reading. A used-up window or usage not allowed is an action there; anything else, including an unreadable readings file (`ACCESS_USAGE_UNREADABLE`, which pauses and lifts nothing), is information.
- If the record cannot be read, it pauses nothing, so the harness's own limit is what stops a launch. `jevris route limits clear --all` rewrites it empty. The record is described in [configuration.md](configuration.md#retention) and [privacy.md](privacy.md).

## Main-session turns on Kilo and OpenCode

With `routing.mainSession` at `plugin-bounded-auto` (the default; see [settings.md](settings.md)), the Kilo and OpenCode plugins ask the sidecar before each main-session turn whether to switch that turn's model. The sidecar's `route.turn` answers. Only that turn's model changes, and your configuration stays as it is.

It abstains by default. It names a model only when all of these hold:

- the turn's task slice has a promoted model in this workspace's route learning, learned against the model the session is running (its baseline);
- the promoted model is in the registry, usable today and named on that harness (its `provider/model`, with a variant for a learned effort);
- its provider is the session's own, or you have granted consent for it (`jevris consent provider`).

A pin, the kill switch, an unregistered or gateway model, or a slice with no promotion each give an abstention with its reason.

A route keeps the session's host. A host is the service that receives the request: the maker's own API, a gateway such as OpenRouter, or a third-party host.

- **Same maker.** The new model is written through the provider id the session already uses, so a `moonshotai-cn` or `google-vertex` session stays there. A change of effort only keeps the session's model id exactly.
- **Another maker.** Another maker's model is served by another host, so it is written only when this harness has listed or run the model through exactly one host, with one spelling there and a known price. `jevris explain` then says the host changed, and the route stays advice until the harness's `route.host` certify case passes. Otherwise the answer is `NOT_ON_SESSION_HOST`, naming the hosts seen, and the model stays as it is. Moonshot (`moonshotai`, `moonshotai-cn`) and Google (`google`, `google-vertex`) each have two hosts on Kilo and OpenCode, so where both have been seen Jevris never picks one for you.
- **A session model Jevris cannot read.** A session whose model id names no host Jevris knows gives `HOST_UNKNOWN`, and every route from it abstains.
- **Gateways and inference hosts.** Jevris reads a gateway or inference-host id (`openrouter/...`, the Kilo gateway's `kilo/...`, `nvidia/...`) as a registry model served by that host ([Models served by several hosts](#models-served-by-several-hosts)). A session on a gateway keeps it: the new model is written through the same gateway, with a spelling this harness has listed or run there. A direct session moves to a gateway only when that gateway is the one host seen serving the model here, you have granted it, and its price for the model is known. A host whose id Jevris does not pin gives `HOST_UNKNOWN`.

A same-maker route through the maker's own API is switched under the harness's `session.route` certify case, as before. A route that changes host, or goes through a gateway or inference host, is advice only until the harness's `route.host` certify case also passes ([Models served by several hosts](#models-served-by-several-hosts)).

A named model switches the turn only when the mode is `plugin-bounded-auto`, the task's approved scope has the turn gate open and the task is low-risk. The gate is open when the session is linked to that task: an owned worker's session, linked from the moment its harness first names the session id, or a session you linked from a terminal with `jevris route --task <id> --link`, or with `jevris handoff import <capsule.json> --link` when you continue a handed-off task (undo either with `jevris route --unlink`; `jevris status` lists the links, including those of your owned workers' worktrees, marked `worker`, up to 16). A session that only happens to run beside one active task gets advice, `SESSION_NOT_LINKED`. The gate also needs the harness's `session.route` certify case passes, the kill switch allows it and no budget is exhausted. Otherwise the answer is advice, with the reason it was not switched (for example `MAIN_SESSION_ADVICE_ONLY`, `TURN_ROUTE_UNCERTIFIED` or `RISK_NOT_LOW`), and you can switch yourself. Claude Code, Codex and Antigravity main sessions stay advice only.

`jevris status` shows, per harness, the main-session mode and whether its turns can be switched, or why not. A turn that named a model is recorded once per message, and `jevris explain <decision-id>` shows the mode it ran under, whether its model was switched or only advised, and the session link it was decided under while that link still stands (or that the session was not linked).

## Subagent routes

When a harness starts a subagent, Jevris may propose its model. It does so only with evidence for that subagent type: an active learned slice or a signed prior. It never proposes over an explicit model or a pin.

| Harness | Tool | The route sets | A learned effort |
| --- | --- | --- | --- |
| Claude Code | Agent | the family alias (`haiku`, `sonnet`, `opus`, `fable`), only when the alias means that model | not carried: abstains |
| Codex | `spawn_agent` | Codex's model id | not applied, by design: the route sets the model only |
| Kilo | `task` | the child session's `provider/model` | the variant |
| OpenCode | `task` | the child session's `provider/model` | not carried: abstains |
| Antigravity | none | nothing: the advice is shown as text | none |

On Kilo and OpenCode a subagent route keeps the parent session's host in the same way as a main-session turn, and abstains with `NOT_ON_SESSION_HOST` or `HOST_UNKNOWN` where it cannot. That includes a session on a gateway.

Each harness's slice learns against that harness's baseline, so a route learned on Claude Code's subagents is never proposed on Codex. A route is applied only after that harness's `hooks.route` certify case passes. Until then it is shown as text. On Kilo and OpenCode it is also never written to a provider that the project's own config redefines ([security.md](security.md#routing-authority)).

## Models served by several hosts

The same model can reach you through more than one host: the maker's own API, a gateway that forwards your request, or a host that runs the model's weights itself. Jevris records which host a harness used, because the host decides where your code goes, under whose terms, and at what price.

**The hosts Jevris knows.** Besides each maker's own API, three hosts are pinned in Jevris. An id Jevris does not pin is not a host to it: a model spelled through one is unregistered, gets no advice and is recorded nowhere.

| Host | Kind | Harnesses | Forwards to |
| --- | --- | --- | --- |
| OpenRouter (`openrouter`) | gateway | Kilo, OpenCode | the model's provider |
| Kilo Gateway (`kilo`) | gateway | Kilo | OpenRouter |
| NVIDIA (`nvidia`) | inference host | Kilo, OpenCode | none: it runs the model |

**Which host serves which model.** The model registry lists each host's servings: the model, the host's own id for it and the host's price. The bundled snapshot `multi-2026-09-29` has 39 servings on OpenRouter, the Kilo Gateway and NVIDIA, read on 28 September 2026 from models.dev and cross-checked against the Kilo Gateway's own public model list; NVIDIA serves Kimi K3 and GLM-5.3 on a free tier. Claude Sonnet 5.5 has no serving yet: it was released after those tariffs were read. The registry refuses a serving that names no registry model, relabels the maker, repeats another, names a different model, puts a price on a free tier, or names a harness the host is not on. `npm run registry:check` shows the serving counts, and the [model refresh procedure](../CONTRIBUTING.md#model-knowledge-refresh) refreshes them.

**How a spelling is read.** One resolver turns a harness's spelling into a model and the host that serves it, and back. On OpenCode, `anthropic/claude-opus-5.5` is Claude Opus 5.5 from Anthropic's own API, and `openrouter/anthropic/claude-opus-5.5` is the same model served by OpenRouter. A gateway spelling counts only when the registry pins that serving for that harness. Kilo's and OpenCode's model listings, every owned run, and every main-session and subagent model the harness reports keep the spelling and its host in the [model offer](#which-models-your-account-can-use-here). A run that only asked for its model, without the harness reporting it back, never counts through a gateway.

**Consent is per host and maker.** A route through a host needs consent for the maker and for the host ([privacy.md](privacy.md#consent-per-model-provider)):

- OpenRouter and the Kilo Gateway each have their own consent text. Like a maker's, they are allowed while you are signed in to them and not revoked, or after you grant them with `jevris consent provider <host> --grant`. The maker's consent is still needed: Moonshot and DeepSeek always need a grant, whichever host serves them.
- NVIDIA has no consent text in Jevris, so it cannot be granted and Jevris never routes to it.
- A revoked or stale consent, or a consent store Jevris cannot read, blocks. The Kilo Gateway forwards to OpenRouter, so a blocked OpenRouter also blocks a route through the Kilo Gateway.

**Host routes are advice until certified.** A route that changes host, or goes through a gateway or inference host, is advice only until the harness's `route.host` certify case passes. That case is certified only together with `session.route`, on Kilo and OpenCode. A same-maker route through the maker's own API is unaffected: it stays under `session.route` for main-session turns and `hooks.route` for subagents. Until then such a route is advice with `ROUTE_HOST_NOT_CERTIFIED`, and you can switch yourself. Whatever the certification, Jevris acts on a route only when the price of both models on their hosts is known; a price known only as the maker's list price is advice with `HOST_TARIFF_UNKNOWN`. Owned workers follow the same price rule ([troubleshooting.md](troubleshooting.md)).

**Prices through a host.** Route advice prices each model at its tariff on the session's host: a pinned gateway or inference host at the tariff in the registry's snapshot, the maker's own API at the maker's list price. Where the host's tariff for a model is not known, advice uses the maker's list price and says so ("the maker's list price as an estimate; the serving host's tariff is not known"); no route acts on such a price (see above). Route learning records the host that served each outcome and prices its API-equivalent dollars at that host's tariff. A price comparison in which either side is only an estimate is `RESOURCE_UNKNOWN`, so no model is promoted on a guessed price. `jevris doctor` prints one `hostTariffs` line that counts the servings in the registry routing reads, per host and per price basis, and names each source with the day it was read, for example `hostTariffs: 39 servings on 3 hosts (kilo 18, nvidia 3, openrouter 18): 37 at the host's tariff, 2 free-tier, 0 unknown (routes through a free-tier or unknown tariff give advice only); from ...`. It is information only. A registry with no servings says that a route through a serving host gives advice only.

**What `route` and explain show about hosts.** `jevris route` names the session's host and, for its recommendation or a pinned route, the host the model would go through, whether the route kept the session's host (and if not, the reason code `route.turn` gives), the price basis with its snapshot source, and each party's consent state (`granted`, `signed-in-default`, `required`, `revoked`, `no-text`, or `blocked`, for a gateway whose downstream host is blocked). `jevris explain <decision-id>` shows the same for a main-session turn, while the sidecar that decided it is still running: it is not kept in the decision record, so it is gone after a restart.

## Owned workers

An owned worker is a headless run of an installed harness that Jevris starts to do one leased task in its own git worktree. You never start it yourself.

### When one starts

Owned work starts only after an explicit submit. There are two ways to submit:

- `jevris plan --submit`, from the CLI only. A new root budget needs a person at a terminal or a single-use terminal authorization (see [security.md](security.md#changes-that-need-a-person-at-a-terminal)).
- The MCP tool `jevris_submit_task`, only while owned mode is on for the workspace. It needs the id of a root budget that already exists there (see [mcp.md](mcp.md#owned-mode-only)).

A worker starts only when all of these hold:

- `mode` is `bounded-auto`, `orchestration.enabled` is `true` and `routing.managedWorkers` is `bounded-auto`, all the defaults from install (see [settings.md](settings.md#workers));
- the kill switch is clear;
- the task has a model to run (below).

Otherwise the task is queued (`QUEUED`, or `QUEUED_NO_MODEL` when workers are automatic but no model is found for the task).

At launch, two more checks apply. The harness must hold a sign-in for the model's provider. The provider must have consent where it needs one ([privacy.md](privacy.md#consent-per-model-provider)). A run that fails either check is refused before it starts (see [Which harness runs it](#which-harness-runs-it)).

After a submit, later work starts on its own under the same conditions:

- When a task is verified, the tasks that were waiting on it start. So the next wave of the plan needs no new submit.
- When `recover` finds a failed owned task failing the same way again, Jevris relaunches it once on the next stronger model the task approved. This is the one bounded escalation. A new passing check result is still the only way it completes.

Certification of `worker.route` is not one of these conditions in 1.2. It decides only whether route learning may change the model or effort ([below](#certification-of-worker-routing)).

### Which models a task may use

A task that names models (`models` in the plan) routes only among them, starting from the first.

A task that names none routes among every model in the registry that:

- an installed harness reaches, with a sign-in it holds;
- is from a provider the consent rules allow (Kimi and DeepSeek need `jevris consent provider <provider> --grant`);
- is from the baseline's provider, or runs on an API key. A vendor you did not name is never explored on a subscription login, except Gemini models on Antigravity's own sign-in.

Its baseline is the default of the first installed harness among Claude Code, Codex and Antigravity. The router's explanation lists each model left out and why (`NO_HARNESS`, `EXPLORATION_NEEDS_API_KEY` or a `PROVIDER_CONSENT_*` code). Every other rule stands: bounded-auto acts only on low-risk tasks, a lasting switch needs 12 local outcomes, and the budget, the kill switch and native permissions apply.

### Which harness runs it

1. The model's provider comes from the model registry when it lists the id. Otherwise it comes from the id: `gpt-*`, `o<n>` and `codex*` are OpenAI, `grok*` and `xai/…` are xAI, `gemini*` and `google/…` are Google, and `claude-*` and Claude Code's aliases (`opus`, `sonnet`, `haiku`) are Anthropic. Any other id is refused (`WORKER_PROVIDER_UNKNOWN`); it is never sent to Claude.
2. If `workers.json` names a harness for that provider, only that harness is used. Otherwise the provider's own harness is tried first (Claude Code for Anthropic, Codex for OpenAI, Antigravity for Google; xAI, Z.ai, Moonshot and DeepSeek have none), then OpenCode, then Kilo.
3. The first of those whose driver loads on this host runs the task, in the mode `workers.json` states or `auto` decides.

When none can, the task's run is reported as unsupported with the install step that would fix it.

A worker refused before any harness process starts (for example `HOST_NO_LOGIN`, `WORKER_PROVIDER_UNKNOWN` or `WORKER_MODEL_UNNAMED`) spends nothing. Its lease and its route reservation are settled at 0 rather than held as unknown spend. The router's answer is `LAUNCH_NOT_STARTED`, and the task fails with `worker refused before starting (<CODE>)`. A run that did start keeps its hold until it settles.

**Through a gateway or inference host (Kilo and OpenCode).** When a task's linked session goes through a pinned serving host, such as OpenRouter or the Kilo Gateway, a routed owned run goes through that same host, and the router prices each model at that host.
- The route launches only when all three of these hold:
  - the host's price for the model is known, not an estimate (else `HOST_TARIFF_UNKNOWN`);
  - `route.host` is certified for the harness version (else `ROUTE_HOST_NOT_CERTIFIED`);
  - the host and maker pair has consent: the host signed in, any host it forwards to, and the maker behind it with its own grant (else a consent code such as `HOST_CONSENT_REVOKED`).
- Before the router picks, models the host cannot run are left out (`NOT_ON_SESSION_HOST`), and so are non-baseline models on a harness not certified for `worker.route` (`ACTUATOR_UNCERTIFIED`). The router is also offered only models whose maker has its own grant through that host. The session counts as signed in to the host only, never to the maker, so a maker you are signed in to directly on the harness is not enough. The router therefore never picks a model the launch would refuse, and no budget is reserved for a model left out.
- An access pause for such a run uses the host's scope (harness, sign-in and host), the same as a session through that host: the run is checked, recorded, cleared, blocked and resumed there. A pause on the maker's own API does not stop it, and a pause on the host does. A run whose host route cannot be resolved has no scope, so nothing is checked or recorded for it (`ACCESS_SCOPE_UNKNOWN` on the run record).
- In any of these cases the task is blocked with `HOST_ROUTE_NOT_LAUNCHED`, and a reason naming the host and the code:
  - the route through the host does not launch;
  - the host cannot run the approved model, or no model is left for it;
  - the linked session cannot be read (`HOST_READ_FAILED`).

  A routed run never falls back to running direct at the maker.
- A run that is not routed (routing off, or no route decision) runs direct through the maker's own API, even when a gateway session is linked. Only a routed run follows the session's host. A task with no linked gateway session routes as before.

### The drivers

All five harnesses run owned workers:

| Harness | Run | Effort |
| --- | --- | --- |
| Claude Code | One `claude -p` turn in stream-json on a subscription or a key; the Claude Agent SDK instead, with an API key, when it is installed | `--effort`, or the Agent SDK's `effort` option (Haiku models take none) |
| Codex | One `codex exec --json` thread (see [harnesses/codex.md](harnesses/codex.md)) | `--config model_reasoning_effort=...` |
| OpenCode | One `opencode run --format json` turn | `--variant` |
| Kilo | One `kilo run --format json` turn | `--variant` |
| Antigravity | One `agy` stream-json turn, CLI only | The model slug (`gemini-3.8-flash-low`); `--effort` only for a model the registry does not know |

**Model ids.** Each driver starts the model under the id its harness uses, taken from the model registry, not guessed from the name. A model's own row for the harness wins (Antigravity's `gemini-3.8-flash-medium`). Otherwise the harness's access row builds the id: the plain id on Codex, `provider/model` on OpenCode and Kilo with the harness's own provider id (`moonshotai/kimi-k3`). When the registry names no id for the model on that harness, the run is refused. On OpenCode and Kilo you can still give your own `provider/model`, which is passed as given. The model listings are read the same way: every provider id the registry names for the harness counts, and each listed id is stored as the registry's id.

**Effort.** The effort route learning chooses reaches the harness. Each harness takes its nearest level that is not above the one asked, from the levels the registry lists for that model on that harness (Gemini has no `xhigh` or `max`). An API-key Claude run through the Agent SDK gets the effort as the SDK's `effort` option. The effort the harness was actually given is kept on the run record and in the learning event; a run at the model's default records none.

The harness guides describe each driver's limits: [Codex](harnesses/codex.md), [OpenCode](harnesses/opencode.md#owned-workers), [Kilo](harnesses/kilocode.md#owned-workers) and [Antigravity](harnesses/antigravity.md#owned-workers). The drivers share these rules:

- The prompt goes on standard input, never on the command line.
- The model, and the effort level, are chosen when the run starts. An active turn is never re-steered.
- Only the tools the task was granted are allowed (read, search and edit tools by default). Web tools are denied. Jevris never passes a flag that skips permissions, and a permission prompt the run cannot show is refused, never approved for you.
- A step or turn cap, the task's budget and a wall-clock timeout bound each run. Cancelling the task, or the timeout, kills the whole process tree.
- A run stopped by its first-use check (see below) leads its reason with the code, for example `WORKER_INIT_MODEL: ...`.
- Before the run starts it is written to the store as a pending owned effect. The kill switch holds it, and only a person reconciles it (`jevris task reconcile`).

### Certification of worker routing

`worker.route` is the feature of a harness's certification record that covers owned workers. In 1.2 it does not gate the launch. A submitted task starts on its approved model whether or not the harness is certified. The feature decides only whether route learning may change that model or its effort ([below](#routing-acts-only-on-a-certified-harness)). It is "certified pending first use": `jevris certify` checks what it can without a model call, and the first real run checks the rest.

What `jevris certify --harness <name>` checks for `worker.route` (no model call):

- **The flags.** The harness's help (`claude --help`, `codex exec --help`, `opencode run --help`, `kilo run --help`, `agy --help`) must list every flag the worker passes. A missing flag fails the feature with `WORKER_FLAG_MISSING`, naming the flag.
- **The port.** Each worker port passes the nine conformance cases (event validation, duplicate delivery, cancellation, stale revision, output shape, permission preservation, user pin, offline fallback and unsupported capability) against a stand-in for the harness's headless stream, never the real binary. The cases are recorded under `<harness>.worker` ids.

The record also lists what certify cannot prove:

- Claude Code: the worker passes `--max-turns`, which `claude --help` does not list, so the first real run proves it.
- Antigravity: a read-only grant is enforced after the fact (the run is killed), not before.
- Codex: the stream names no working directory, model or permissions, so the first-use check covers only the thread start. The rest is the command line Jevris builds.

**First use.** Every run checks the session's first event before any tool runs:

| Harness | First-use check | On a mismatch |
| --- | --- | --- |
| Claude Code | The working directory is the task's worktree, the permission mode is not a bypass, no web tool is loaded, the model is the one chosen, and the sign-in (subscription or key) is the one decided | The run is stopped |
| Antigravity | `permission_mode` is `request-review`, the working directory is the worktree, and the model is the one chosen | The run is stopped |
| OpenCode, Kilo | The first event is a `step_start` of one session, and the Jevris agent loaded | A missing Jevris agent refuses the run; a wrong first event is recorded |
| Codex | The first event is `thread.started` | Recorded; the run is not stopped |

Effort is checked from what Jevris passes (the `--effort` or `--variant` flag, or Antigravity's model slug): no first event reports it.

A run on the harness's own binary records its check as live evidence. A passed check counts as one run verified in use. A failed check demotes `worker.route` for that harness version and starts one background re-check (see [troubleshooting.md](troubleshooting.md#a-harness-was-upgraded)).

`jevris doctor` prints one worker line per installed harness that has a record, in one of these forms:

```text
harness claude worker: certified, pending first use (the first owned run checks its init before any tool runs)
harness claude worker: verified in use (3 runs at 2.1.283)
harness claude worker: demoted: an owned run's first-use check failed; re-checking in the background, no model call
harness claude worker: not certified here (WORKER_FLAG_MISSING); fix: jevris certify --harness claude
harness claude worker: not certified yet: the record for 2.1.283 predates owned-worker certification; fix: jevris certify --harness claude
```

The Antigravity line adds that a read-only grant is enforced after the fact. A record written before `worker.route` existed starts one background re-check, so an upgrade of Jevris certifies it with no step from you. The `actuator worker.route` row reads `certified` and names the harnesses whose record covers it, or `unsupported` with the fix `jevris certify --harness all` (no model call).

### Routing acts only on a certified harness

Before route learning swaps the model or sets an effort, Jevris checks that the harness the model would run on is certified for `worker.route`. When it is not, routing only advises. The router's choice is recorded as a counterfactual, and `ACTUATOR_UNCERTIFIED` is traced. The task still runs, on its approved model at the model's default effort. That model runs on the harness chosen as usual ([Which harness runs it](#which-harness-runs-it)), certified or not. The router's choice is never launched on an uncertified harness, and a failed check counts as uncertified.

### What certification covers for owned workers in 1.2

Certification of owned workers has two limits in 1.2:

- **The worker cases never run your harness.** Certify's nine worker cases run each worker port against a Node stand-in for the harness's headless stream. The real binary is used only to read its help for the worker's flags.
- **The real binary runs only a simplified launch.** It runs, with a dummy key against a local stub provider, only in the stub cases: `worker-actual-model` on Codex, OpenCode and Kilo, and the access-limit cases on Claude Code, Codex, OpenCode and Kilo. Those runs use a simpler command line than a real worker does. Antigravity has no stub case.

So on your machine, certify does not prove the exact worker launch against your installed harness. The first real run's first-use check is the first proof of it.

## Route learning

Route learning decides, per workspace and per task slice (for example `bounded-edit`), which model and effort an owned worker should use. It starts from a signed baseline on day 1 and keeps learning from outcomes in that workspace. Main-session routing is advice only, except for the per-turn switch on Kilo and OpenCode described above.

### The baseline

A day-1 baseline is a signed calibration release that a package can ship at `assets/calibration/calibration-release.json`, signed by a `calibration` key in the package's trust store. Version 1.2 ships none (see below). It holds published independent benchmark results, plus an optional owner seed run, as a prior for each model and effort. A baseline shapes each slice's starting posterior. A slice still switches only once this workspace has 12 of its own randomized outcomes on both arms. Other slices, and high-risk ones, stay advice only.

A `calibration-release.json` in the Jevris config folder overrides the bundled one (for an administrator's own release). When that file exists it is the only one read: if it is invalid, expired or signed by an untrusted key, routing abstains rather than falling back. Both are checked the same way: the contract, the signature against the package's `calibration` keys, and whether the release applies to the slice, the Jev model, the questions and the encoding.

Version 1.2 ships no signed baseline: there is no seed run for it. Every workspace starts on the route's baseline at its default effort (Opus 5.5 at medium on Claude Code), and moves a slice only on its own outcomes, through the locked thresholds below. `jevris route` says there is no signed baseline release in this package and no calibration release in the config folder. A later release may ship a baseline built from an optional seed run.

### Board priors for a model with no calibration

A model the signed baseline has no prior for may take a provisional one from an independent coding-agent board: Terminal-Bench 4.0 (it seeds the `terminal` slice), the success-rate components of the Artificial Analysis Coding Agent Index, and SWE-rebench (both seed `issue-fix`). Another slice reads a board only when the `priorSlices` setting maps it to one of these. The rows ship in the package with a source and date each. The rows in 1.2 come from Terminal-Bench and the Artificial Analysis index, and cover Anthropic models only; none comes from SWE-rebench yet.

- A row counts only when the board operator published it with its trial count. A vendor-reported result never counts. A row older than 120 days, or from an older version of a board that the table also has a newer version of, stops counting.
- The prior counts for at most 12 outcomes. The weight is halved when the board ran the model on another harness than the one that would run it here, and halved again at another effort. Each local outcome on the arm takes one outcome off the prior's weight.
- A model qualifies when the Wilson 95% lower bound of its board rate, taken over the board's trials times the same halvings, is at least the baseline's prior point less the 0.075 margin. The baseline's point is its signed prior when there is one, else its own board row. A signed release for the slice overrides any board prior.
- A qualified prior lets the model be explored, on a low-risk task under bounded-auto only, and it informs advice. It never switches a slice: that still needs 12 local randomized outcomes per arm.
- A model from another vendor than the baseline's is explored only with evidence for the slice: a signed or qualified board prior, or outcomes here or elsewhere on this machine. Unknown quality stays out of an automated route.

With today's rows no Claude model qualifies against Opus 5.5: each is below it by more than the margin on both boards.

### How it learns

- Every outcome updates a Bayesian (Beta) posterior per slice and arm, seeded from the baseline prior. The prior counts for at most 30 outcomes, so local evidence overturns a weak prior quickly.
- Outcomes are labelled only by deterministic sources: a verification receipt, a revert, a retry, or a run that ended with no receipt. A model's own judgement is never a label.
  - A run that ends with no receipt is labelled `run-incomplete`, a failure that carries the run's spend. That covers a failed, timed-out, max-turns, budget-exceeded or refused run, and a write outside the task's paths. A run that stops at a usage limit or another access limit, or on an overloaded provider, is not counted as incomplete, whatever status its harness reported. Neither is a run that is aborted or finds its model gone.
  - A revert or a retry within 30 days turns an earlier pass of the same route into a failure, and carries no second cost. A revert is recorded when a verified task is reopened (its receipt is invalidated) and its checks then fail. A revert is also recorded when git reverts the commit that integration made for an owned task: after a check run, and when an integration is read, Jevris looks in the commits since the merge (merges from the last 30 days at most, and never longer than `privacy.decisionRetentionDays`; the latest 2,000 commits are read) for git's standard line `This reverts commit <id>.` naming that commit. It keeps only the two commit ids and reads no other message text. A conflict at integration is not the task's fault and is not a revert.
  - After the one bounded escalation, the failed route is labelled a retry. The stronger run is its own route: it is not randomized, and its receipt is learned.
  - Stale, cancelled and usage-limited runs are counted but never labelled a success or a failure.
- An **arm** is a model at an effort level. Besides the baseline model at its default effort (Opus 5.5 at `medium` on Claude Code), learning tries the baseline model at `low` and `high` by default, where the model lists those levels. Changing effort on a model that keeps its prompt cache across effort changes has no cache-transition cost; changing model does.

### Task size

A route reserves for the task's expected size. The router starts from a default bounded edit and only ever raises it. It takes the larger, per field, of that default, the 90th percentile of input and output tokens over at least 5 finished owned runs of the slice here, and the 90th percentile of total tokens per route over the last 30 days of route learning (at least 12 routes, in the default's input/output split). `jevris explain` with a slice shows the task size it assumes. A task's estimate is also kept against what its runs actually committed, with wall time and tokens, so plan estimates can be checked. None of this lowers a reservation or changes a budget cap.

### Risk class

Learning explores, and follows a slice it has switched, only on a **low-risk** route. Jevris gives each owned task a risk class when the task is created, by fixed rules, never by a model and never from the task's text. A task is `low` only when all of these hold:

- it has at least one acceptance check;
- its write scopes are inside the workspace: relative, with no `..` and no symlink;
- together those scopes cover at most **5 files** (a locked limit). An existing directory counts the files below it. A path that does not exist yet counts as one file when its name has an extension. A glob, `.`, or a new path with no extension counts as unbounded;
- none of those paths is protected. The protected classes are auth, secrets, CI, deploy, migrations, lockfiles and git internals;
- it is not labelled `security` (the plan task's `labels`).

A task that fails a rule is `high` when the reason is a protected path, a security label or a scope outside the workspace, and `medium` otherwise.

A plan may make a task riskier with `"risk": "medium"` or `"risk": "high"`, but never make it low. A declared `"low"` is ignored.

A low-risk task whose plan names no slice routes under `bounded-edit`. A task that is not low keeps no slice unless its plan names one, so the router keeps its approved model. The class and its reason codes are kept on the task (for example `PROTECTED_CI`, `TOO_MANY_FILES`) and sent to learning with every outcome.

Route and outcome use one baseline. The router's baseline is the task's approved model when the registry lists it; otherwise it is the harness's default in the registry's `harnessDefaults`: Opus 5.5 on Claude Code, GPT-6 Sol on Codex, Gemini 3.8 Flash on Antigravity. OpenCode and Kilo, which run several providers, fall back to Opus 5.5. The learning note carries that baseline, and the outcome is reconciled against it. Each baseline learns under its own key, so a slice routed from Claude Code, Codex and Antigravity, or for tasks with different approved models, learns three ways at once and never demotes one baseline's slice for another's outcomes: the registry's own baseline (Opus 5.5) keeps the bare slice id, and any other is `<slice>::<model>`, for example `bounded-edit::gpt-6-sol`. A pin on a slice holds under every key, and the board priors and the machine-wide pool use the slice itself. `jevris explain` names the baseline as the default arm, and `jevris route learning` lists each key. It carries the rules-only choice for the same route (`rulesModelId`).

The thresholds are locked by the owner:

| Setting | Value |
| --- | --- |
| Non-inferiority margin | 0.075 of the verified-success rate |
| Activate a cheaper arm | when P(worse than the baseline by more than the margin) < 0.10 |
| Demote | when that probability rises above 0.40, or the recent window shows a regression |
| Activate a costlier arm (a higher effort) | only when no cheaper arm qualifies and P(not better than the baseline) < 0.10; demoted above 0.40 |
| Anti-flap floor | 5 labelled outcomes on a slice after any change, before it changes again |
| Local evidence before any switch | 12 of this workspace's own randomized outcomes (low-risk routes with a logged propensity) on both the candidate and the default; a signed baseline or the shared machine prior shapes the posterior but never switches a slice alone |
| Demotion window | the last 20 outcomes (at least 10) |
| Exploration | 10% (the cap) of eligible low-risk `bounded-auto` routes while a slice is advise-only, 5% once it has switched; never on a pinned slice or with learning off |
| What "cheaper" means | follows the harness's mode: dollars on an API key, usage-limit consumption on a subscription |

Demotion is always automatic and fast: the slice goes back to the baseline model at its default effort.

### Cost and time per verified task

Each workspace measures, per slice and arm (the default arm included), what a verified task really costs: the arm's spend over every route it ran, failures and retries included, divided by its verified successes. It keeps billed dollars on an API key; on a subscription it keeps tokens, quota-weighted usage, and an API-equivalent dollar estimate (the route's usage at list price). Wall time per verified task is kept the same way. `jevris route learning status` and `jevris explain --slice` show each arm against the approved default, for example `Per verified task claude-sonnet-5: $1.1000 billed, 1.0 min wall time, 27 verified over 30 routes (vs claude-opus-5-5: cost 1.03x, ...)`.

Once both a cheaper arm and the default have at least 5 verified tasks in the workspace, these realized figures decide the resource side, before any release figure, effort order or list price. A cheaper arm that turns out not to be cheaper per verified task (for example, because retries make it cost more) goes back to the default (`NOT_CHEAPER_PER_VERIFIED`, or `MORE_USAGE_PER_VERIFIED` on a subscription). A costlier arm activated as an upgrade is expected to cost more, and stays bound by the probably-better rule above. The check is arithmetic on recorded outcomes; no model judges it.

### You stay in control

```sh
jevris route learning status
jevris route learning off
jevris route learning pin bounded-edit claude-opus-5-5 --effort low --yes
jevris route learning pin bounded-edit --advise --yes
jevris route learning unpin bounded-edit --yes
jevris route learning automatic off
jevris route learning reset --clear-evidence --yes
jevris route learning reset --machine --yes
jevris route learning export-cases
```

- A pin always wins: learning never changes a pinned slice, and an advice-only pin never launches a worker.
- `off` stops every switch and all exploration in the workspace. Outcomes are still counted; `on` turns it back on.
- `automatic on` is the default: changes the evidence supports apply at once. With `automatic off`, each change waits as a proposal for `accept` or `reject`.
- Every change is a new policy version, so `rollback <version>`, `reset`, `pin` and `unpin` undo it.
- `export-cases` writes this workspace's local calibration cases (each Jev decision's per-question provider probability beside its verified task outcome) to `route-learning/calibration-cases/` for a person to review. Jevris never applies or uploads them; `reset --clear-evidence` removes the file. It needs the sidecar and asks nothing.
- Only the CLI changes learning; no MCP tool or hook can. `off` and `automatic off` only lower what learning may do, so they apply at once; every other change needs `--yes` or a y/N answer at a terminal.

### Why a slice routes as it does

`jevris explain <decision-id> --slice <slice>` adds the slice's route learning to the trace: its mode (active, advice only or pinned), the policy version that set it, the signed baseline prior and the local outcomes shown apart, and the posterior. With `--json`, `trace.learning` carries the same facts as numbers:

| Field | Meaning |
| --- | --- |
| `sliceId`, `mode`, `version`, `lines` | The slice; `advise`, `auto` (shown as active) or `pinned`; the policy version; the explanation lines |
| `baseline` | The signed release id and its priors (`modelId`, `effort`, `rate`, `pseudoCount`, `sampleSize`, `sourceId`), or `null` when no release covers the slice |
| `posteriors[]` | Per arm: `modelId`, `effort`, `armId` (`model@effort` for a non-default effort), `alpha`, `beta`, `mean`, the `prior`, the `local` successes and failures, and `harmVsBaseline`, the probability of being worse than the baseline by more than the margin, and `machine`: the other workspaces' part on this machine (`successes`, `failures`, `rate`, `pseudoCount`, `contributors`), or `null` when none ran the arm |
| `economics` | `defaultArmId`, `minVerified` (5), and per arm `armId`, `modelId`, `effort`, `isDefault`, `routes`, `verified`, `costPerVerifiedMicroUsd` (billed; null when nothing was billed), `apiEquivalentPerVerifiedMicroUsd`, `tokensPerVerified`, `usagePerVerified`, `wallMsPerVerified`, and `costRatioVsDefault`, `usageRatioVsDefault`, `wallRatioVsDefault` (below 1 is better; null when either side is unknown). Money is integer micro-USD. |

While a slice is advise-only, explain and `jevris route learning status` say what it is waiting for, for example `Waiting for 7 more local outcomes on claude-opus-5-5 at low effort before a switch to it.`, and `--json` carries `guard` (`minLocalPerArm`, and `waiting[]` with each arm's `armId`, `local` and `remaining`).

The MCP tool `jevris_explain_decision` takes the same slice as `sliceId`.

### Where it is kept

`<data>/route-learning/<workspace id>.json`, owner-only. It holds policy versions, per-slice and per-arm outcome counts and resource sums, and the outcome ids of the last 30 days at most, for reconciling reverts and retries. It holds ids, counts, costs and times, never text, and nothing in it leaves the machine.

### Learning shared across your workspaces

General route learning is shared by the workspaces on one machine, so work in any project helps every other one. Each workspace writes its own contribution to `<data>/route-learning/machine/`: counts and resource sums per slice and arm (successes, failures, routes, cost, tokens, wall time) and the latest usage-limit reset per model. A contribution file is named by a random token, not the workspace, and holds no path, repository name, task text or workspace id.

- Only general slices are shared: `bounded-edit`, `issue-fix`, `terminal`, `test-fix`, `refactor`, `feature`, `docs`, `review`, `research`, `debug` and `migration` (`SHARED_SLICE_IDS` in `@jevris/core`), or a slice that the `priorSlices` setting maps to one of them. Any other slice stays in its workspace.
- A workspace starts from the other workspaces' outcomes, counted as at most 12 outcomes per arm (a locked cap), plus any signed baseline. Its own outcomes then move its posterior as before. It never reads its own contribution, so nothing is counted twice, and the shared history never switches a slice without the workspace's own 12 outcomes on each arm.
- Until a workspace has 3 local observations on each arm, the cost per verified task measured in the other workspaces decides the resource check (when both arms have 5 verified tasks there).
- A usage limit or another access limit is the account's: a hit in one workspace keeps the others from exploring or launching into it until it resets or clears.
- A pin or `off` in a workspace still wins. A workspace with learning off neither contributes nor reads. Demotion is decided in each workspace on its own outcomes.
- `jevris route learning reset` leaves the shared layer; `--clear-evidence` also withdraws this workspace's contribution and removes this workspace's learning records from the store (decision outcomes and advice adherence; it reports `STORE_PURGED` or `NO_STORE`, and on a refusal points to the `learning` scope of `jevris data delete`); `--machine` clears the shared layer for every workspace. A plain `jevris uninstall` keeps it with the rest of your data; `jevris uninstall --delete-data` removes it.

Route learning is its own retention class. Learning needs weeks of outcomes, so the 7-day and 30-day sweeps never touch it. `jevris route learning reset --clear-evidence` and `jevris data delete` remove it. See [privacy.md](privacy.md#retention-and-deletion).

### Which models your account can use here

Route learning and the router only choose a model that your harness and sign-in can actually use. On a default install, a model is eligible for a harness and sign-in only with local evidence:

- **It ran there**, and the harness reported that model back (`RAN_HERE`).
- **The harness lists it** (`LISTED_BY_HARNESS`), from the harness's own model listing, which makes no billed call and runs no model.
- **Claude Code lists its models** through an idle `initialize` request that runs no model; until `models.list` is certified for your Claude Code version, a Claude model becomes eligible there only after it has run once.
- **A model found gone or not accessible is never eligible**, whatever the other evidence says (see below).
- Otherwise it is not eligible: `NO_LOCAL_EVIDENCE`, or `NOT_ON_HARNESS` when the registry's harness map gives that harness no access to the model's provider and the model has not run there.

**An administrator's registry decides alone.** When an administrator places a model registry with account checks, those checks decide, and local evidence is not used.

**The harness map.** The shipped registry carries `harnessAccess`, which harness reaches which model provider and how it spells the model there: Claude Code natively for Anthropic, Codex natively for OpenAI, Antigravity natively for Google, and OpenCode and Kilo through a provider configuration (OpenCode as `provider/model`, for example `moonshotai/kimi-k3` or `google-vertex/gemini-3.8-flash`). A model whose id differs on a harness carries a `harnessModels` row: Antigravity names the effort in the model (`gemini-3.8-flash-high`). Kilo resolves ids against the models.dev catalog it ships, so it spells them as OpenCode does (`zai/glm-5.3`, `moonshotai/kimi-k3`). A gateway or inference-host spelling (`openrouter/...`, Kilo's own gateway `kilo/...`, `nvidia/...`) names a registry model only through a serving the registry pins for that host and harness ([Models served by several hosts](#models-served-by-several-hosts)). It is never a direct provider run, because a gateway may fall back to another model. Each row also records the sign-ins it accepts and how the harness takes an effort level. The [model refresh procedure](../CONTRIBUTING.md#model-knowledge-refresh) keeps the map current, and `npm run registry:check` checks it.

**On a fresh install nothing is eligible yet**, so routing changes nothing until a model has run on that harness and sign-in, or a listing names it.

**Why a model is or is not eligible.** `jevris explain <decision-id> --slice <slice>` adds one line per model, for example `claude-sonnet-5 is not eligible: it has not run on this machine and no harness listing names it (NO_LOCAL_EVIDENCE).`, or one line saying the administrator's registry decides. It never names the account.

The record is `<data>/route-learning/model-offer.json`, one per machine, owner-only. It holds model ids, harnesses, sign-in modes, times, harness versions and reason codes, never listing output or an account. Since version 2 it also keeps, for each listed line and each run, the harness's own spelling of the model (for example `openrouter/moonshotai/kimi-k3`) and the host that spelling goes to, so a route can keep the host the harness was seen using. A version 1 record still proves the model but not a host. A run that only asked for its model, without the harness reporting it back, counts only through the maker's own API, never a gateway. It is in the route-learning retention class, and `jevris route learning reset --machine` removes it.

**Where the evidence comes from.**

- **Runs.** At the end of every owned run whose harness reported the model back, Jevris records that model as having run on that harness and sign-in. It keeps the spelling the harness used (for example `moonshotai-cn/kimi-k3`) and the host that served it, and records a spelling only when it names one registry model. A main session's or subagent's reported model is recorded the same way.
- **Clean runs.** An owned run that completed cleanly without reporting its model counts, as weaker evidence, only when the model it was started with is the maker's exact id, reached directly or through the harness's provider config. It never counts through a gateway, which can fall back to another model, or for an alias.
- **Listings.** The sidecar refreshes each harness's own model listing while it is idle: one harness at a time, each listing bounded to 10 seconds, again after 24 hours or when the harness's installed version changes. Claude Code lists through an idle `claude -p` stream-json session that sends only the `initialize` control request, Codex through its app-server `model/list`, OpenCode and Kilo through their `models` command, and Antigravity through `agy models`. Each is used only once a certification record covers the `models.list` feature for that harness version and OS. `jevris doctor` prints one `models` line per installed harness saying whether it lists its models.

`routing.modelListing` (`on` by default) controls the listings; `jevris configure set routing.modelListing off` stops every one. Until a run or a listing is recorded, no model is eligible on a default install, so routing changes nothing.

### Models found gone on this machine

A model stays recommended until it is actually retired: by the vendor's firm retirement date, or when a launch or provider call on this machine finds it gone, whichever comes first. A "not sooner than" retirement date is only a warning.

- `MODEL_GONE`: the vendor's own API says the model no longer exists, such as the Claude API's 404 `not_found_error`. Jevris then never recommends, explores or launches that model on this machine, on any harness.
- `MODEL_NOT_ACCESSIBLE`: one harness and sign-in cannot use the model ("does not exist or you do not have access"). It affects only that harness with that sign-in; other harnesses are unaffected. A harness's own "not found" is always this, never `MODEL_GONE`, because it can come from that harness's provider configuration, gateway or plan. That covers OpenCode's and Kilo Code's `ProviderModelNotFoundError`, and Codex's, Claude Code's and Antigravity's messages once a capture confirms them.

The record is `<data>/route-learning/model-availability.json`, one per machine. It holds the model id, the reason, the harness and sign-in mode, where and when the model was seen, and the registry snapshot in force. It never holds an error message, a workspace, a path or an account. The next registry refresh clears it.

```sh
jevris route learning gone
jevris route learning gone clear claude-opus-5-5 --yes
jevris route learning gone clear --all --yes
```

- `gone` (or `gone list`) shows each model found gone, in the same words as `jevris route learning status`, `jevris explain --slice` and `jevris doctor`.
- `gone clear <model-id>` and `gone clear --all` clear the record now. They need `--yes` or a y/N answer at a terminal. A clear with nothing to clear exits 0 and changes nothing.
- `gone` works from any folder, because the record belongs to the machine, not a workspace.
- In `jevris doctor`, a model found gone is an action line that names the clear command to run once the model is back. A model not accessible from one harness is an info line.
