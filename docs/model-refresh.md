# Model knowledge refresh

Model ids, prices, limits and lifecycle dates go stale. This is the procedure for any maintainer, or any agent in any harness, asked to "check the latest models and update the registry". Run it from the repository root. `npm run registry:check` and the release gate's model-retirement warning point here.

## When to run it

- Before every release.
- At least monthly.
- Whenever a vendor announces a model, a price change, a deprecation or a retirement.
- Whenever `jevris doctor` or a route answer names a model the registry does not know.

## Ground rules

1. **Primary sources first:** vendor model, pricing, deprecation, effort and data-retention pages. Then independent benchmarks: Artificial Analysis, the Terminal-Bench leaderboard, the SWE-bench-Live leaderboard. Record the URL and fetch date (YYYY-MM-DD) beside every fact.
2. **Never invent a number.** If a fact cannot be confirmed from a source, write `unconfirmed` and say why. A plausible guess is worse than a gap.
3. **Make no billed call.** Research reads public pages only. Run no model, harness or live test, and never use a stored Jev key.
4. **Keep secrets out.** Never write a secret, account id or email address into any file, argv or log.
5. **Change through a pull request.** Commit only the files below and open a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)). In a checkout that others commit to at the same time, commit with `node scripts/safe-commit.mjs -F <msg> --check -- <paths>`.
6. **Stay within the files below.** Touch only those files, unless the registry maintainer asks for more.

## What to check, per vendor and per model

Vendors: Anthropic, OpenAI, Google, xAI, DeepSeek, Qwen, Moonshot (Kimi), Zhipu (GLM), MiniMax and Mistral, plus any vendor a supported harness (Claude Code, Codex, OpenCode, Kilo, Antigravity) newly exposes.

For each model:

- **Identity:**
  - API ids and aliases;
  - the provider, and cloud-platform ids (Bedrock, Vertex, Azure);
  - release date and knowledge cutoff.
- **Lifecycle:** deprecation date and retirement date ("not sooner than" counts as retirement). **A retirement within 30 days is urgent.**
- **Limits:** context window, maximum input, maximum output and modalities.
- **Effort and reasoning:**
  - parameter names and levels, and the default;
  - whether an effort change keeps the prompt cache;
  - whether reasoning tokens are billed.
- **Prices:**
  - input, output and cached input;
  - cache write per TTL (5 minutes, 1 hour);
  - long-context tiers and their thresholds;
  - batch prices;
  - dated future price changes.
- **Caching:** automatic or explicit, TTL, minimum size, and whether the cache is per model (so a model switch starts cold).
- **Data:** retention, ZDR eligibility, and training on API data.
- **Access:**
  - which harnesses reach the model through a subscription login and which through an API key;
  - **the harness-to-model map:** for each harness (Claude Code `claude`, Codex `codex`, OpenCode `opencode`, Kilo `kilocode`, Antigravity `antigravity`) and each provider, whether the harness runs that provider's models `native`ly, through a `provider-config` with the user's own key, through a `gateway` or compatible endpoint, or not at all. Record it in the registries' `harnessAccess` rows (`{ harness, provider, access, sourceIds }`). The bundled registry maps only the pairs a vendor or harness page confirms, and leaves out gateway-only and unlisted pairs. On those pairs a model becomes eligible only after it has run there. The map only narrows: a model becomes eligible for routing from local evidence (it ran on that harness, or the harness lists it), never from the map alone;
  - any vendor terms restricting third-party use of subscription logins. Quote them exactly. For example, Anthropic's Agent SDK rule: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- **Coding benchmarks:** Terminal-Bench (current version), SWE-bench-Live, the AA Coding Agent Index and LiveCodeBench. Record each with the effort level used, cost per task if reported, and date. SWE-bench Verified is retired and contaminated, so record it only as historical.
- **Known issues:** refusal rates, tool-calling reliability, and parallel tool calls.

## Files

| File | Holds | Rule |
|---|---|---|
| `fixtures/registry/v1.2-model-registry-proposal.json` | Model entries for every vendor (the administrator's registry proposal), with `sources` and `entryNotes` | Every entry must pass `ModelRegistryContract` and the Ajv schema check. |
| `fixtures/registry/v1.2-cost-registry-proposal.json` | Price rows | Every row must pass `validatePriceRow`, and `section191` must still compute. |
| `packages/core/src/model-registry.ts` (`BUNDLED_MODEL_REGISTRY`, `BUNDLED_REGISTRY_SOURCES`) | The bundled snapshot (`multi-YYYY-MM-DD`): the Anthropic entries, the Anthropic `harnessAccess` rows, `harnessDefaults`, `harnessHosts` and the snapshot id | The registry maintainer only. Propose changes otherwise. A new snapshot id, updated tests and a fresh-clone `npm test` (`npm run verify:fresh`) are required. |
| `packages/core/src/registry-multi.ts` (`MULTI_PROVIDER_ENTRIES`, `MULTI_PROVIDER_HARNESS_ACCESS`, `MULTI_REGISTRY_SOURCES`) | The other providers' entries (OpenAI, Google, xAI, Z.ai, Moonshot, DeepSeek) and their `harnessAccess` rows | The registry maintainer only, the same as above. |
| `packages/core/src/registry-servings.ts` | Each serving host's servings and tariffs (OpenRouter, the Kilo Gateway, NVIDIA) | Generated; never edit it by hand. `node packages/evals/scripts/refresh-serving-tariffs.mjs` writes it (with `--write`) from a saved models.dev `api.json`, a models.dev checkout at the same commit and the Kilo Gateway's saved model list. It never fetches the network. |
| `fixtures/evaluation/cost-registry.json`, copied to `assets/evaluation/cost-registry.json` | Bundled cost registry | The registry maintainer only. `node packages/evals/scripts/refresh-prices.mjs --updates <reviewed-prices.json>` applies reviewed price rows (with `--write`), then `npm run assets:sync` copies the file into `assets/`. |

The bundled snapshot covers seven providers: Anthropic, OpenAI, Google, xAI, Z.ai, Moonshot and DeepSeek. Adding a provider or a model to it is the registry maintainer's decision. Until then, record the model in the proposal; an administrator can use it through their own `model-registry.json` in the Jevris config folder ([routing.md](routing.md#route-advice)).

## Validation

Build first (`npm run build`), then run:

```sh
npm run registry:check
```

It validates both proposals (`ModelRegistryContract` and the JSON Schemas for the model registry, `validatePriceRow` and `section191` for the prices), and the bundled registry, including its `harnessAccess` map: every row names a provider the registry has, no (harness, provider) pair repeats, and every source id resolves in `BUNDLED_REGISTRY_SOURCES`. It also checks that every serving-host row and serving names a source that resolves, and prints the count of servings per price basis. It prints one `WARN` line for each recommended model that may retire within 30 days, is past its "not sooner than" date (`MODEL_RETIREMENT_DUE`) or is deprecated, and for each promotional price that ends within 30 days or has ended. A warning does not fail the check. `--model <file>` and `--cost <file>` check other files.

If the bundled snapshot changed, also run:
- `npm test`;
- `node packages/core/scripts/route-learning-sim.mjs`, when prices or baseline candidates changed.

## Consequences to flag, not to decide

Report these to the release owner. Do not act on them yourself:

- **A retirement or deprecation of a model in the router's candidate set, or in a signed calibration baseline when the release ships one** (1.2 ships none). The router refuses retired models by date, but the owner must re-sign a baseline release if its baseline or candidates change.
- **A price change on a candidate or baseline model.** This alters routing economics and day-1 decisions.
- **A new model that could plausibly be a cheaper candidate for a low-risk slice.** State the evidence, and say whether published data is enough or whether a seed run would be needed. Also say whether the seed's size would grow; the owner approves that.
- **Changed subscription or terms rules for any harness.** This affects authentication support.
- **New schema gaps** the refresh exposes.

## Report format (under 400 words)

1. Changes, grouped by vendor: new models, price changes, limit changes, lifecycle changes. Include the dates of retirements.
2. Urgent items (retirements within 30 days, or baseline or candidate impact).
3. Validation results.
4. Items that could not be confirmed.
5. The commit hash of the changed files.
