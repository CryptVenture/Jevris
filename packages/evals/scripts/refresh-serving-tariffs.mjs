#!/usr/bin/env node
/**
 * Serving-host tariff snapshot (serving-hosts design 6.1 and 6.2, R37 and R38).
 *
 *   node packages/evals/scripts/refresh-serving-tariffs.mjs --api <api.json> --source <models.dev checkout>
 *     --etag <api.json ETag> --commit <checkout commit> [--kgw <kilo-gateway-models.json>] [--date YYYY-MM-DD] [--write]
 *
 * A person downloads models.dev's `api.json` (noting its ETag), checks out the models.dev repository
 * at the same commit and, for the Kilo Gateway, saves its public model list. This script reads only
 * those files; it never fetches the network.
 *
 * - For each pinned serving host (`SERVING_HOSTS`), every source TOML under
 *   `providers/<host>/models/**` whose `base_model` names a registry model gives one serving; its
 *   host model id is the file's path, and its price is `api.json[host].models[hostModelId].cost`.
 *   `base_model` is the only link to the maker; a file without one is skipped. It is metadata
 *   inheritance, so the host model id must also name that model (`sameModel`): a `-pro` variant
 *   that inherits from a model is not that model.
 * - Prices are USD per 1M tokens, converted to integer micro-USD by string arithmetic from each
 *   number's shortest decimal text. More than 6 decimals is refused and the serving gets
 *   `tariffBasis: 'unknown'`, never a rounded price.
 * - A tier maps to multipliers only when each ratio is exact to 4 decimals; otherwise `unknown`.
 * - A zero input and output price is `free-tier` with no tariff; a partly zero price, a reasoning
 *   price that differs from the output price, or a missing price is `unknown`.
 * - The Kilo Gateway prices from its own list, so each `kilo` price must equal the saved list's
 *   (per-token strings); a disagreement or a missing row is `unknown`. Without `--kgw`, every `kilo`
 *   serving is `unknown`.
 * - The maker's own tariff stays from the vendor page; the script only prints where a host's price
 *   differs from it, for review.
 *
 * It prints every serving and writes `packages/core/src/registry-servings.ts` only with --write, and
 * only when the registry with the new servings passes `validateModelRegistry`. Run
 * `npm run registry:check` afterwards.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** models.dev's provider id for each pinned host (design 3.2). */
export const MODELS_DEV_HOSTS = Object.freeze({ openrouter: 'openrouter', kilo: 'kilo', nvidia: 'nvidia' });
/** models.dev's own ids for a maker that the harness map does not use (read from the 2026-09-28 checkout). */
export const MODELS_DEV_MAKERS = Object.freeze({ zhipuai: 'zai' });
export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const KILO_GATEWAY_URL = 'https://api.kilo.ai/api/openrouter/models';

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * A non-negative decimal as an integer scaled by 10^digits (a bigint), by string arithmetic; null
 * when it is not a plain decimal or has more than `digits` decimals. A number is read through its
 * shortest decimal text (`String(n)`), so an exponent form (1e-7) is refused.
 */
export function scaledDecimal(value, digits) {
  const text = typeof value === 'number' ? (Number.isFinite(value) && value >= 0 ? String(value) : '') : typeof value === 'string' ? value : '';
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > digits) return null;
  return BigInt(match[1]) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
}

/** USD per 1M tokens to integer micro-USD per 1M tokens; null when not exact to 6 decimals. */
export function microUsd(value) {
  const scaled = scaledDecimal(value, 6);
  return scaled === null || scaled > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(scaled);
}

/** A tier price over the base price as a multiplier exact to 4 decimals; null otherwise. */
export function exactMultiplier(tierMicro, baseMicro) {
  if (baseMicro <= 0 || tierMicro < 0) return null;
  const scaled = BigInt(tierMicro) * 10000n;
  if (scaled % BigInt(baseMicro) !== 0n) return null;
  return Number(scaled / BigInt(baseMicro)) / 10000;
}

/**
 * A models.dev `cost` object to a serving's tariff and basis. `meta` gives the tariff's version,
 * effectiveAt and sourceId. Returns `{ tariffBasis, tariff, reason }`, where reason explains an
 * `unknown`.
 */
export function tariffFromCost(cost, meta) {
  const unknown = (reason) => ({ tariffBasis: 'unknown', tariff: null, reason });
  if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) return unknown('COST_MISSING');
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return unknown('COST_MISSING');
  if (cost.input === 0 && cost.output === 0) return { tariffBasis: 'free-tier', tariff: null, reason: null };
  if (cost.input === 0 || cost.output === 0) return unknown('PARTLY_FREE');
  if (cost.reasoning !== undefined && cost.reasoning !== cost.output) return unknown('REASONING_PRICED');
  const input = microUsd(cost.input);
  const output = microUsd(cost.output);
  const cacheRead = cost.cache_read === undefined ? null : microUsd(cost.cache_read);
  const cacheWrite = cost.cache_write === undefined ? null : microUsd(cost.cache_write);
  if (input === null || output === null || (cost.cache_read !== undefined && cacheRead === null) || (cost.cache_write !== undefined && cacheWrite === null)) return unknown('PRICE_PRECISION');
  const tiers = [];
  for (const tier of Array.isArray(cost.tiers) ? cost.tiers : []) {
    const size = tier?.tier?.size;
    if (tier?.tier?.type !== 'context' || !Number.isSafeInteger(size) || size <= 0) return unknown('TIER_NOT_CONTEXT');
    const ti = microUsd(tier.input);
    const to = microUsd(tier.output);
    if (ti === null || to === null) return unknown('TIER_INEXACT');
    const inputMultiplier = exactMultiplier(ti, input);
    const outputMultiplier = exactMultiplier(to, output);
    let cacheMultiplier = null;
    if (tier.cache_read !== undefined) {
      const tc = microUsd(tier.cache_read);
      if (tc === null || cacheRead === null) return unknown('TIER_INEXACT');
      cacheMultiplier = exactMultiplier(tc, cacheRead);
      if (cacheMultiplier === null) return unknown('TIER_INEXACT');
    }
    if (inputMultiplier === null || outputMultiplier === null) return unknown('TIER_INEXACT');
    tiers.push({ aboveInputTokens: size, inputMultiplier, outputMultiplier, cacheMultiplier });
  }
  const float = (micro) => (micro === null ? null : micro / 1_000_000);
  const tariff = {
    version: meta.version,
    currency: 'USD',
    effectiveAt: meta.effectiveAt,
    inputPerMillion: float(input),
    outputPerMillion: float(output),
    cacheReadPerMillion: float(cacheRead),
    cacheWritePerMillion: float(cacheWrite),
    sourceId: meta.sourceId,
    inputMicroUsdPerMillion: input,
    outputMicroUsdPerMillion: output,
    cacheReadMicroUsdPerMillion: cacheRead,
    cacheWriteMicroUsdPerMillion: cacheWrite,
    cacheWrite1hMicroUsdPerMillion: null,
    ...(tiers.length === 0 ? {} : { tiers }),
  };
  return { tariffBasis: 'host', tariff, reason: null };
}

/**
 * The Kilo Gateway cross-check (OQ-6): the saved list's per-token prices (OpenRouter's form, USD
 * strings) must equal the tariff's input, output and, where both give one, cache-read prices.
 */
export function kiloGatewayAgrees(list, hostModelId, tariff) {
  const rows = Array.isArray(list?.data) ? list.data.filter((row) => row?.id === hostModelId) : [];
  if (rows.length !== 1) return { agrees: false, reason: 'KGW_MISSING' };
  const pricing = rows[0].pricing ?? {};
  // Per token to per 1M tokens in micro-USD: scale by 10^12.
  const perMillion = (text) => scaledDecimal(text, 12);
  const same = (text, micro) => {
    const got = perMillion(text);
    return got !== null && micro !== null && got === BigInt(micro);
  };
  if (!same(pricing.prompt, tariff.inputMicroUsdPerMillion) || !same(pricing.completion, tariff.outputMicroUsdPerMillion)) return { agrees: false, reason: 'KGW_DISAGREES' };
  if (pricing.input_cache_read !== undefined && tariff.cacheReadMicroUsdPerMillion !== null && !same(pricing.input_cache_read, tariff.cacheReadMicroUsdPerMillion)) return { agrees: false, reason: 'KGW_DISAGREES' };
  return { agrees: true, reason: null };
}

/** The `base_model` line of a models.dev TOML (top level, before any table); null when absent. */
export function baseModelOf(toml) {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return null;
    const match = /^\s*base_model\s*=\s*"([^"\\]{1,256})"\s*(?:#.*)?$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * The registry entry a `base_model` (`<models.dev provider>/<model id>`) names: the model id exactly,
 * and a provider that is the maker, one of its endpoint ids in the harness map, its pinned host maker
 * slug or models.dev's own id for it (`MODELS_DEV_MAKERS`). Null unless exactly one entry matches.
 */
export function linkBaseModel(registry, baseModel, hostMakerOf) {
  const cut = baseModel.indexOf('/');
  if (cut <= 0 || baseModel.indexOf('/', cut + 1) >= 0) return null;
  const mdProvider = baseModel.slice(0, cut);
  const modelId = baseModel.slice(cut + 1);
  const endpointsOf = (provider) => new Set((registry.harnessAccess ?? []).filter((row) => row.provider === provider).flatMap((row) => row.providerIds ?? [provider]));
  const matches = registry.entries.filter((e) => e.modelId === modelId && (e.provider === mdProvider || endpointsOf(e.provider).has(mdProvider) || hostMakerOf(mdProvider) === e.provider || MODELS_DEV_MAKERS[mdProvider] === e.provider));
  return matches.length === 1 ? { provider: matches[0].provider, modelId } : null;
}

function tomlFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tomlFiles(path));
    else if (name.endsWith('.toml')) out.push(path);
  }
  return out;
}

/**
 * Whether a host model id's model part is the registry model itself, not a variant that only
 * inherits from it: `base_model` is metadata inheritance, so `openai/gpt-5.6-luna-pro` names
 * `gpt-5.6-luna` as its base without being it. Equal ignoring case and `.` against `-`
 * (`claude-opus-5.5` is `claude-opus-5-5`); anything else is not the same model.
 */
export function sameModel(hostModelId, modelId) {
  const norm = (text) => text.toLowerCase().replace(/\./g, '-');
  return norm(hostModelId.slice(hostModelId.indexOf('/') + 1)) === norm(modelId);
}

/**
 * Builds the servings from the local inputs. `readToml(host)` lists `{ hostModelId, text }` for the
 * host's source files. Returns `{ servings, notes }`, where each note says why a file gave no
 * serving or why a serving is not `host`.
 */
export function buildServings({ registry, api, readToml, kgw, date, etag, hostMakerOf, hostModelIdPattern }) {
  const etag8 = etag.replace(/[^0-9A-Za-z]/g, '').slice(0, 8).toLowerCase();
  const mdSource = `MODELSDEV-${etag8}`;
  const kgwSource = `KGW-${date}`;
  const effectiveAt = `${date}T00:00:00Z`;
  const pattern = new RegExp(hostModelIdPattern);
  const servings = [];
  const notes = [];
  for (const [host, mdHost] of Object.entries(MODELS_DEV_HOSTS)) {
    for (const { hostModelId, text } of readToml(mdHost)) {
      const base = baseModelOf(text);
      if (base === null) continue;
      const entry = linkBaseModel(registry, base, hostMakerOf);
      if (entry === null) continue;
      if (!pattern.test(hostModelId)) {
        notes.push(`${host} ${hostModelId}: skipped, the host model id does not fit the pinned pattern`);
        continue;
      }
      if (!sameModel(hostModelId, entry.modelId)) {
        notes.push(`${host} ${hostModelId}: skipped, it inherits from ${entry.modelId} but is not that model`);
        continue;
      }
      const cut = hostModelId.indexOf('/');
      if (cut > 0 && hostMakerOf(hostModelId.slice(0, cut)) !== entry.provider) {
        notes.push(`${host} ${hostModelId}: skipped, its maker slug is not pinned to ${entry.provider}`);
        continue;
      }
      const cost = api?.[mdHost]?.models?.[hostModelId]?.cost ?? null;
      let priced = tariffFromCost(cost, { version: `${host}-${date}`, effectiveAt, sourceId: mdSource });
      const sourceIds = [mdSource];
      if (host === 'kilo' && priced.tariffBasis === 'host') {
        const check = kgw === null ? { agrees: false, reason: 'KGW_NOT_GIVEN' } : kiloGatewayAgrees(kgw, hostModelId, priced.tariff);
        if (kgw !== null) sourceIds.push(kgwSource);
        if (!check.agrees) priced = { tariffBasis: 'unknown', tariff: null, reason: check.reason };
      }
      if (priced.reason !== null) notes.push(`${host} ${hostModelId}: tariff unknown (${priced.reason})`);
      servings.push({ host, provider: entry.provider, modelId: entry.modelId, hostModelId, tariff: priced.tariff, tariffBasis: priced.tariffBasis, sourceIds });
    }
  }
  servings.sort((a, b) => (a.host + a.hostModelId < b.host + b.hostModelId ? -1 : a.host + a.hostModelId > b.host + b.hostModelId ? 1 : 0));
  const sources = { [mdSource]: { url: MODELS_DEV_URL, fetchedOn: date } };
  if (kgw !== null && servings.some((s) => s.sourceIds.includes(kgwSource))) sources[kgwSource] = { url: KILO_GATEWAY_URL, fetchedOn: date };
  return { servings, sources, notes };
}

/** The generated module's text. */
export function servingsModule({ servings, sources, date, commit, etag }) {
  return [
    '/**',
    ' * Serving-host tariffs (serving-hosts design 6.1, R38). Generated by',
    ' * packages/evals/scripts/refresh-serving-tariffs.mjs from a local models.dev snapshot; do not edit by hand.',
    ` * models.dev commit ${commit}, api.json ETag ${etag}, read ${date}.`,
    ' */',
    "import type { Serving } from '@jevris/contracts';",
    '',
    `export const SERVINGS_SNAPSHOT_ON = ${JSON.stringify(date)};`,
    '',
    '/** Where each serving source id was read. */',
    `export const SERVING_SOURCES: Readonly<Record<string, { readonly url: string; readonly fetchedOn: string }>> = Object.freeze(${JSON.stringify(sources, null, 2)});`,
    '',
    `export const BUNDLED_SERVINGS: readonly Serving[] = Object.freeze(${JSON.stringify(servings, null, 2)} as Serving[]);`,
    '',
  ].join('\n');
}

function arg(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

async function main() {
  const apiPath = arg('--api');
  const source = arg('--source');
  const etag = arg('--etag');
  const commit = arg('--commit');
  if (apiPath === null || source === null || etag === null || commit === null || !/^[0-9a-f]{7,40}$/.test(commit)) {
    process.stderr.write('usage: refresh-serving-tariffs.mjs --api <api.json> --source <models.dev checkout> --etag <etag> --commit <sha> [--kgw <file>] [--date YYYY-MM-DD] [--write]\n');
    process.exit(2);
  }
  const date = arg('--date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    process.stderr.write('refresh-serving-tariffs: --date must be YYYY-MM-DD\n');
    process.exit(2);
  }
  const contracts = await import('@jevris/contracts');
  const core = await import('@jevris/core');
  const api = JSON.parse(readFileSync(apiPath, 'utf8'));
  const kgwPath = arg('--kgw');
  const kgw = kgwPath === null ? null : JSON.parse(readFileSync(kgwPath, 'utf8'));
  const readToml = (mdHost) => {
    const dir = join(source, 'providers', mdHost, 'models');
    return tomlFiles(dir).map((path) => ({ hostModelId: relative(dir, path).split(sep).join('/').replace(/\.toml$/, ''), text: readFileSync(path, 'utf8') }));
  };
  const registry = core.BUNDLED_MODEL_REGISTRY;
  const built = buildServings({ registry, api, readToml, kgw, date, etag, hostMakerOf: contracts.hostMakerOf, hostModelIdPattern: contracts.HOST_MODEL_ID_PATTERN });
  for (const s of built.servings) {
    const maker = core.registryModel(registry, s.modelId, s.provider)?.tariff;
    const price = s.tariff === null ? s.tariffBasis : `${s.tariff.inputPerMillion}/${s.tariff.outputPerMillion}`;
    const differs = s.tariff !== null && maker !== undefined && (maker.inputPerMillion !== s.tariff.inputPerMillion || maker.outputPerMillion !== s.tariff.outputPerMillion);
    process.stdout.write(`${s.host} ${s.hostModelId} -> ${s.provider}/${s.modelId}: ${price}${differs ? ` (maker price ${maker.inputPerMillion}/${maker.outputPerMillion}; review)` : ''}\n`);
  }
  for (const note of built.notes) process.stdout.write(`note: ${note}\n`);
  // The snapshot that bundles these servings is read no earlier than they are.
  const fetchedOn = `${date}T00:00:00Z` > registry.fetchedOn ? `${date}T00:00:00Z` : registry.fetchedOn;
  const candidate = { ...registry, fetchedOn, servings: built.servings, harnessHosts: registry.harnessHosts ?? [] };
  const checked = core.validateModelRegistry(candidate);
  if (!checked.ok) {
    process.stderr.write(`refresh-serving-tariffs: the registry with these servings is refused: ${checked.issues.slice(0, 20).join(', ')}\n`);
    process.exit(1);
  }
  if (process.argv.includes('--write')) {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'src', 'registry-servings.ts');
    writeFileSync(out, servingsModule({ ...built, date, commit, etag }));
    process.stdout.write(`wrote ${out}; run npm run build and npm run registry:check\n`);
  } else {
    process.stdout.write('dry run: pass --write to update the servings\n');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
