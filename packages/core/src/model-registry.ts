/**
 * The model registry snapshot (RTE-01, §8.1, §8.2, R04, E18).
 *
 * A registry entry is an exact provider API id with a versioned full tariff (input, output,
 * cache read, 5-minute and 1-hour cache write), context and output limits, supported effort
 * levels and default, lifecycle dates, data-retention eligibility, regions, health and
 * per-account eligibility. The bundled snapshot `multi-2026-10-08` carries the §8.1 documentation
 * baseline (Anthropic models on the Claude API) and the providers the owner admitted on 2026-09-27
 * (DOMAINS 7be3c43: OpenAI, Google, xAI, Z.ai, and Moonshot and DeepSeek behind consent;
 * registry-multi.ts), the serving hosts that reach them with each host's tariff (serving hosts R38;
 * registry-servings.ts, generated from models.dev on 2026-09-28), and names its sources.
 *
 * - Every fact was checked against the vendor pages on 2026-09-26, again on 2026-09-29, when
 *   Claude Sonnet 5.5 was added, and on 2026-10-08, when Claude Haiku 5.5 was added
 *   (`BUNDLED_REGISTRY_SOURCES` keeps each URL with its latest fetch date): the models overview, pricing, model deprecations, effort and API data retention pages,
 *   and Claude Code's model configuration. The research proposal
 *   (`.planning/research/v1.2-model-registry-proposal.json`) was the starting point; only facts
 *   the vendor pages confirmed are here.
 * - Claude Opus 5.5 (released 2026-09-22, $4/$20, cache read $0.20) is the Claude Code default
 *   and the approved baseline. Opus 5 stays as a legacy entry.
 * - Claude Sonnet 5.5 (released 2026-09-28, $2/$10, cache read $0.20, the same prices as Sonnet 5)
 *   is the model Claude Code's `sonnet` alias resolves to on the Anthropic API. Sonnet 5 is now a
 *   legacy model, still available and not deprecated.
 * - Claude Haiku 5.5 (released 2026-10-07, $0.10/$0.50 up to a 100,000-token prompt and five times
 *   that above it, cache read $0.01) is the model Claude Code's `haiku` alias resolves to on the
 *   Anthropic API (Claude Code 2.1.293). Haiku 4.5 is now a legacy model, still available and not
 *   deprecated.
 * - Retirement dates are the vendor's "not sooner than" commitments. Past that date a model stays
 *   recommended with the warning MODEL_RETIREMENT_DUE; only a firm `retiresOn`, status `retired`
 *   or the model found gone on this machine stops it (DOMAINS 9d1e7eb). Haiku 4.5 reaches its
 *   "not sooner than" date on 2026-10-15.
 * - Fable 5.1 is a Covered Model: it requires 30-day retention and is not ZDR eligible, so a
 *   zero-data-retention workspace is never routed to it.
 * - Only Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 and Opus 5 of these models change effort mid-session with the
 *   cache kept (per-message effort, beta `mid-conversation-output-config-2026-07-01`, on the
 *   Anthropic-operated platforms). Every model has its own cache, so a model switch is cold.
 * - No Claude 4.6+ model but Haiku 5.5 has a long-context price tier (a prompt over 100,000 tokens is
 *   billed at five times every price). Account eligibility is empty: without an
 *   administrator's account check, a model is eligible on a harness and sign-in only from local
 *   evidence (it ran there, or the harness lists it; model-offer.ts), within `harnessAccess`.
 * - Discovery (the provider's Models API) can mark a known entry's health; it never adds an id.
 *   An id the registry does not know is listed as unregistered and never used.
 */
import { readFile } from 'node:fs/promises';
import { MODEL_REGISTRY_REFUSALS, ModelRegistryContract, SERVING_HOSTS, hostMakerOf, type ModelRegistry, type RoutingModel, type Tariff } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { join } from 'node:path';
import { MULTI_PROVIDER_ENTRIES, MULTI_PROVIDER_HARNESS_ACCESS, MULTI_REGISTRY_SOURCES } from './registry-multi.js';
import { BUNDLED_SERVINGS, SERVING_SOURCES } from './registry-servings.js';

const FETCHED_ON = '2026-10-08T00:00:00Z';
/**
 * The snapshot date: the Anthropic facts are from 2026-10-08 (Claude Haiku 5.5 added), the OpenAI
 * facts from 2026-09-30, the other providers' from 2026-09-27 and the serving-host tariffs from
 * 2026-09-28.
 */
const SNAPSHOT_ON = '2026-10-08T00:00:00Z';
const MILLION = 1_000_000;
const PER_MESSAGE_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';
/** Where per-message effort works: the Anthropic-operated platforms, not Bedrock or Google Cloud. */
const PER_MESSAGE_EFFORT_PLATFORMS = ['claude-api'];
const ALL_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The vendor pages behind the bundled snapshot, with the date each was read. */
export const BUNDLED_REGISTRY_SOURCES: Readonly<Record<string, { readonly url: string; readonly fetchedOn: string }>> = Object.freeze({
  S26: { url: 'https://code.claude.com/docs/en/model-config', fetchedOn: '2026-10-08' },
  S27: { url: 'https://platform.claude.com/docs/en/models/overview', fetchedOn: '2026-10-08' },
  S28: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', fetchedOn: '2026-10-08' },
  'ANT-DEPREC': { url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations', fetchedOn: '2026-10-08' },
  'ANT-EFFORT': { url: 'https://platform.claude.com/docs/en/build-with-claude/effort', fetchedOn: '2026-10-08' },
  'ANT-RETENTION': { url: 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention', fetchedOn: '2026-10-08' },
  'OC-PROVIDERS': { url: 'https://opencode.ai/docs/providers/', fetchedOn: '2026-09-27' },
  'KILO-MODELS': { url: 'https://kilo.ai/models', fetchedOn: '2026-09-27' },
  'KILO-CATALOG': { url: 'https://kilo.ai/docs/code-with-ai/agents/custom-models', fetchedOn: '2026-09-27' },
  ...MULTI_REGISTRY_SOURCES,
  ...SERVING_SOURCES,
});

interface ClaudeFacts {
  readonly modelId: string;
  readonly family: string;
  readonly displayName: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** USD per million: input, output, cache read, 5-minute write, 1-hour write. */
  readonly prices: readonly [number, number, number, number, number];
  /** When the price took effect (the release, or the last price change). */
  readonly priceSince: string;
  readonly effortLevels: readonly string[];
  readonly defaultEffort: string | null;
  readonly perMessageEffort: boolean;
  readonly status: 'active' | 'legacy';
  readonly releasedOn: string;
  readonly retirementNotBefore: string;
  readonly zdrEligible: boolean;
  readonly requiredRetentionDays: number | null;
  readonly capabilities: readonly string[];
  /** A prompt longer than `aboveInputTokens` is billed at `multiplier` times every price (Haiku 5.5). */
  readonly longContext?: { readonly aboveInputTokens: number; readonly multiplier: number };
}

function day(date: string): string {
  return `${date}T00:00:00Z`;
}

function tariff(facts: ClaudeFacts): Tariff {
  const [input, output, read, write5m, write1h] = facts.prices;
  return {
    version: `anthropic-${FETCHED_ON.slice(0, 10)}`,
    currency: 'USD',
    effectiveAt: day(facts.priceSince),
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: read,
    cacheWritePerMillion: write5m,
    cacheWrite1hPerMillion: write1h,
    sourceId: 'S28',
    inputMicroUsdPerMillion: Math.round(input * MILLION),
    outputMicroUsdPerMillion: Math.round(output * MILLION),
    cacheReadMicroUsdPerMillion: Math.round(read * MILLION),
    cacheWriteMicroUsdPerMillion: Math.round(write5m * MILLION),
    cacheWrite1hMicroUsdPerMillion: Math.round(write1h * MILLION),
    storageMicroUsdPerMillionHour: null,
    ...(facts.longContext === undefined ? {} : { tiers: [{ aboveInputTokens: facts.longContext.aboveInputTokens, inputMultiplier: facts.longContext.multiplier, outputMultiplier: facts.longContext.multiplier, cacheMultiplier: facts.longContext.multiplier }] }),
  };
}

function claude(facts: ClaudeFacts): RoutingModel {
  return {
    provider: 'anthropic',
    modelId: facts.modelId,
    family: facts.family,
    displayName: facts.displayName,
    capabilities: ['text', 'vision', 'tools', 'structured-output', 'code', 'prompt-caching', ...facts.capabilities],
    contextTokens: facts.contextTokens,
    maxOutputTokens: facts.maxOutputTokens,
    effortLevels: [...facts.effortLevels],
    defaultEffort: facts.defaultEffort,
    effortSwitch: facts.perMessageEffort
      ? { keepsCache: true, betaHeader: PER_MESSAGE_EFFORT_BETA, platforms: [...PER_MESSAGE_EFFORT_PLATFORMS] }
      : { keepsCache: false, betaHeader: null, platforms: [] },
    regions: ['global'],
    health: 'unknown',
    tariff: tariff(facts),
    lifecycle: { status: facts.status, releasedOn: day(facts.releasedOn), retirementNotBefore: day(facts.retirementNotBefore), retiresOn: null, replacementModelId: null, sourceId: 'ANT-DEPREC' },
    dataGovernance: { zdrEligible: facts.zdrEligible, requiredRetentionDays: facts.requiredRetentionDays, sourceId: 'ANT-RETENTION' },
    cache: { mode: 'explicit', ttls: ['5m', '1h'], minTokens: null, perModel: true },
    accountEligibility: [],
    evaluationSliceIds: [],
    evaluationVersion: 'unevaluated',
    discoveredVia: 'vendor-docs',
    sourceIds: ['S26', 'S27', 'S28', 'ANT-DEPREC', 'ANT-EFFORT', 'ANT-RETENTION'],
  };
}

/** The §8.1 documentation baseline. Roles are hypotheses, not rankings; the router decides on evidence. */
export const BUNDLED_MODEL_REGISTRY: ModelRegistry = Object.freeze({
  schemaVersion: '1.0',
  snapshotId: 'multi-2026-10-08',
  fetchedOn: SNAPSHOT_ON,
  baselineModelId: 'claude-opus-5-5',
  entries: [
    claude({
      modelId: 'claude-opus-5-5', family: 'opus', displayName: 'Opus 5.5', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [4, 20, 0.2, 5, 8], priceSince: '2026-09-22', effortLevels: ALL_EFFORT, defaultEffort: 'medium', perMessageEffort: true,
      status: 'active', releasedOn: '2026-09-22', retirementNotBefore: '2027-09-22', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['adaptive-thinking', 'thinking-always-on', 'effort', 'per-message-effort'],
    }),
    claude({
      modelId: 'claude-fable-5-1', family: 'fable', displayName: 'Fable 5.1', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [10, 50, 0.25, 12.5, 20], priceSince: '2026-09-01', effortLevels: ALL_EFFORT, defaultEffort: 'high', perMessageEffort: true,
      status: 'active', releasedOn: '2026-09-01', retirementNotBefore: '2027-09-01', zdrEligible: false, requiredRetentionDays: 30,
      capabilities: ['adaptive-thinking', 'thinking-always-on', 'effort', 'per-message-effort'],
    }),
    claude({
      modelId: 'claude-sonnet-5-5', family: 'sonnet', displayName: 'Sonnet 5.5', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [2, 10, 0.1, 2.5, 4], priceSince: '2026-09-28', effortLevels: ALL_EFFORT, defaultEffort: 'high', perMessageEffort: true,
      status: 'active', releasedOn: '2026-09-28', retirementNotBefore: '2027-09-28', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['adaptive-thinking', 'effort', 'per-message-effort'],
    }),
    claude({
      modelId: 'claude-haiku-5-5', family: 'haiku', displayName: 'Haiku 5.5', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [0.1, 0.5, 0.01, 0.125, 0.2], priceSince: '2026-10-07', effortLevels: ALL_EFFORT, defaultEffort: 'medium', perMessageEffort: true,
      status: 'active', releasedOn: '2026-10-07', retirementNotBefore: '2027-10-07', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['adaptive-thinking', 'effort', 'per-message-effort'],
      longContext: { aboveInputTokens: 100_000, multiplier: 5 },
    }),
    claude({
      modelId: 'claude-opus-5', family: 'opus', displayName: 'Opus 5', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [5, 25, 0.5, 6.25, 10], priceSince: '2026-07-24', effortLevels: ALL_EFFORT, defaultEffort: 'high', perMessageEffort: true,
      status: 'legacy', releasedOn: '2026-07-24', retirementNotBefore: '2027-07-24', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['adaptive-thinking', 'effort', 'per-message-effort'],
    }),
    claude({
      modelId: 'claude-sonnet-5', family: 'sonnet', displayName: 'Sonnet 5', contextTokens: MILLION, maxOutputTokens: 128_000,
      prices: [2, 10, 0.2, 2.5, 4], priceSince: '2026-06-30', effortLevels: ALL_EFFORT, defaultEffort: 'high', perMessageEffort: false,
      status: 'legacy', releasedOn: '2026-06-30', retirementNotBefore: '2027-06-30', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['adaptive-thinking', 'effort'],
    }),
    claude({
      modelId: 'claude-haiku-4-5-20251001', family: 'haiku', displayName: 'Haiku 4.5', contextTokens: 200_000, maxOutputTokens: 64_000,
      prices: [1, 5, 0.1, 1.25, 2], priceSince: '2025-10-15', effortLevels: [], defaultEffort: null, perMessageEffort: false,
      status: 'legacy', releasedOn: '2025-10-15', retirementNotBefore: '2026-10-15', zdrEligible: true, requiredRetentionDays: null,
      capabilities: ['extended-thinking'],
    }),
    ...MULTI_PROVIDER_ENTRIES,
  ],
  // Which harness reaches these models, and how (owner decision DOMAINS 3f090fa; model landscape
  // 2026-09-27, harness keys). Claude Code runs Anthropic models natively; OpenCode and Kilo through
  // a provider config with an API key (owner 490b32a). Codex reaches them only through a gateway and
  // Antigravity lists none of them, so neither is mapped: there only a model that ran counts. The
  // other providers' rows are in registry-multi.ts.
  harnessAccess: [
    { harness: 'claude', provider: 'anthropic', access: 'native', sourceIds: ['S26'], idTemplate: '{id}', signIns: ['api-key', 'subscription', 'workspace'], unattendedAllowed: true, effortVia: 'flag', effortLevels: [...ALL_EFFORT] },
    { harness: 'opencode', provider: 'anthropic', access: 'provider-config', sourceIds: ['OC-PROVIDERS'], providerIds: ['anthropic'], idTemplate: '{provider}/{id}', signIns: ['api-key'], effortVia: 'variant' },
    { harness: 'kilocode', provider: 'anthropic', access: 'provider-config', sourceIds: ['KILO-MODELS'], providerIds: ['anthropic'], idTemplate: '{provider}/{id}', signIns: ['api-key'], effortVia: 'variant' },
    ...MULTI_PROVIDER_HARNESS_ACCESS,
  ],
  // OD-3: a route's baseline is the task's approved model when registered, else its harness's
  // default here. Opus 5.5 stays the Claude Code default (baselineModelId). OpenCode and Kilo run
  // several providers and have no default of their own: they fall back to baselineModelId. Codex's
  // default is GPT-6.1 Sol (it was GPT-6 Sol): each baseline learns under its own key
  // (learningSliceKey), so the change starts Codex's learning arms and first-try history afresh.
  harnessDefaults: [
    { harness: 'claude', baselineModelId: 'claude-opus-5-5' },
    { harness: 'codex', baselineModelId: 'gpt-6.1-sol' },
    { harness: 'antigravity', baselineModelId: 'gemini-3.8-flash' },
  ],
  // Serving hosts (R36, R38; design 3.2 and 3.3): which harness reaches which pinned host, through
  // the segment pinned in SERVING_HOSTS. OpenRouter and NVIDIA take an API key in the harness's
  // provider config; the Kilo Gateway is Kilo's own login. What each host serves, at what tariff,
  // is the generated BUNDLED_SERVINGS. A host here is not consent: a route through one needs the
  // host's and the maker's (R45), and NVIDIA has no consent text, so it is never routed to.
  harnessHosts: [
    { harness: 'opencode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['OC-PROVIDERS'] },
    { harness: 'kilocode', host: 'openrouter', segment: 'openrouter', signIns: ['api-key'], sourceIds: ['KILO-CATALOG'] },
    { harness: 'kilocode', host: 'kilo', segment: 'kilo', signIns: ['subscription'], sourceIds: ['KILO-MODELS'] },
    { harness: 'opencode', host: 'nvidia', segment: 'nvidia', signIns: ['api-key'], sourceIds: ['OC-PROVIDERS'] },
    { harness: 'kilocode', host: 'nvidia', segment: 'nvidia', signIns: ['api-key'], sourceIds: ['KILO-CATALOG'] },
  ],
  servings: [...BUNDLED_SERVINGS],
}) as ModelRegistry;

export type RegistryCheck = { readonly ok: true; readonly registry: ModelRegistry } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The harness provider ids each registry provider may appear under (R2), pinned in code (B's
 * security review, HIGH 5): a placed registry cannot relabel one provider's models as another's,
 * so the provider a route is consented for is the provider the harness sends it to.
 */
export const PROVIDER_ID_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  google: Object.freeze(['google-vertex']),
  zai: Object.freeze(['zai-coding-plan']),
  moonshot: Object.freeze(['moonshotai', 'moonshotai-cn']),
});

/** Whether `providerId` is one a harness may name `provider` by: itself or a pinned alias. */
export function providerIdMapsTo(providerId: string, provider: string): boolean {
  return providerId === provider || (Object.hasOwn(PROVIDER_ID_ALIASES, provider) && (PROVIDER_ID_ALIASES[provider] ?? []).includes(providerId));
}

/**
 * Checks a registry's harness spellings against the pinned provider map (HIGH 5, MEDIUM 4 and 10):
 * - every `harnessAccess` row's `providerIds` map to that row's provider;
 * - a model's own `harnessModels` id, where it has `provider/` segments, names its own provider in
 *   every one of them (owner decisions 8c1f85d, HOLE 1: `openrouter/moonshotai/kimi-k3` is a
 *   gateway's spelling and is refused, not only the segment nearest the model is checked), and its
 *   model part is not another registered model's id.
 * So what a plugin or a hook writes back is always a spelling of the model that was consented for.
 */
export function registrySpellingIssues(registry: ModelRegistry): readonly string[] {
  const issues: string[] = [...servingIssues(registry)];
  (registry.harnessAccess ?? []).forEach((row, index) => {
    (row.providerIds ?? []).forEach((id, at) => {
      if (!providerIdMapsTo(id, row.provider)) issues.push(`/harnessAccess/${index}/providerIds/${at}:PROVIDER_ID_NOT_THIS_PROVIDER`); // path-hygiene: allow a JSON pointer in an issue, not a path
    });
  });
  const ids = new Map<string, string>();
  for (const entry of registry.entries) ids.set(entry.modelId, entry.provider);
  registry.entries.forEach((entry, index) => {
    (entry.harnessModels ?? []).forEach((row, at) => {
      if (row.harness === 'antigravity') return;
      const parts = row.id.split('/');
      const model = parts[parts.length - 1] ?? '';
      const segments = parts.slice(0, -1);
      // A serving host's segment names a host, not the maker: a host spelling is a serving (R37).
      if (segments.some((segment) => HOST_SEGMENTS.has(segment))) issues.push(`/entries/${index}/harnessModels/${at}/id:HARNESS_ROW_IS_A_HOST`); // path-hygiene: allow a JSON pointer in an issue, not a path
      else if (segments.some((segment) => !providerIdMapsTo(segment, entry.provider))) issues.push(`/entries/${index}/harnessModels/${at}/id:PROVIDER_ID_NOT_THIS_PROVIDER`); // path-hygiene: allow a JSON pointer in an issue, not a path
      const bare = model.replace(/\[1m\]$/, '').replace(/:[0-9]{1,8}$/, '');
      if (bare !== entry.modelId && ids.has(bare)) issues.push(`/entries/${index}/harnessModels/${at}/id:NAMES_ANOTHER_MODEL`); // path-hygiene: allow a JSON pointer in an issue, not a path
    });
  });
  return issues;
}

/** Every pinned serving host's harness segment (`openrouter`, `kilo`, `nvidia`). */
const HOST_SEGMENTS: ReadonlySet<string> = new Set(SERVING_HOSTS.flatMap((host) => Object.values(host.segments).filter((segment): segment is string => typeof segment === 'string')));

/**
 * The serving checks the contract leaves to core (serving-hosts design 3.5, R37; owner decisions
 * 8c1f85d, T-R4 as amended). Each serving names a registry entry (SERVING_NO_ENTRY); a host model id
 * with a maker slug names that entry's maker through the pinned HOST_MAKER_SEGMENTS
 * (SERVING_WRONG_MAKER, so an override cannot relabel `openrouter/moonshotai/...` as another maker's);
 * (host, hostModelId) is unique (SERVING_DUPLICATE); its model part is not another entry's id
 * (SERVING_NAMES_ANOTHER_MODEL); a zero price is never a tariff (SERVING_FREE_PRICED); and every
 * harness a serving names reaches its host through a harnessHosts row (SERVING_HARNESS_NO_HOST).
 */
function servingIssues(registry: ModelRegistry): readonly string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  (registry.servings ?? []).forEach((serving, index) => {
    const at = `/servings/${index}`;
    const entry = registry.entries.find((e) => e.provider === serving.provider && e.modelId === serving.modelId);
    if (entry === undefined) issues.push(`${at}:SERVING_NO_ENTRY`);
    const cut = serving.hostModelId.indexOf('/');
    if (cut > 0 && hostMakerOf(serving.hostModelId.slice(0, cut)) !== serving.provider) issues.push(`${at}/hostModelId:SERVING_WRONG_MAKER`); // path-hygiene: allow a JSON pointer in an issue, not a path
    const key = `${serving.host}\u0000${serving.hostModelId}`;
    if (seen.has(key)) issues.push(`${at}:SERVING_DUPLICATE`);
    seen.add(key);
    const modelPart = serving.hostModelId.slice(cut + 1).toLowerCase();
    if (registry.entries.some((e) => e.modelId.toLowerCase() === modelPart && !(e.provider === serving.provider && e.modelId === serving.modelId))) issues.push(`${at}/hostModelId:SERVING_NAMES_ANOTHER_MODEL`); // path-hygiene: allow a JSON pointer in an issue, not a path
    if (serving.tariff !== null && serving.tariff.inputPerMillion === 0 && serving.tariff.outputPerMillion === 0) issues.push(`${at}/tariff:SERVING_FREE_PRICED`); // path-hygiene: allow a JSON pointer in an issue, not a path
    for (const harness of serving.harnesses ?? []) {
      if (!(registry.harnessHosts ?? []).some((row) => row.harness === harness && row.host === serving.host)) issues.push(`${at}/harnesses:SERVING_HARNESS_NO_HOST`); // path-hygiene: allow a JSON pointer in an issue, not a path
    }
  });
  return issues;
}

/** Validates an untrusted registry snapshot (for example a refreshed price file). */
export function validateModelRegistry(value: unknown): RegistryCheck {
  const checked = ModelRegistryContract.validate(value);
  if (!checked.ok) return { ok: false, issues: checked.issues.map((issue) => `${issue.path}:${issue.code}`) };
  const spelling = registrySpellingIssues(checked.value);
  if (spelling.length > 0) return { ok: false, issues: spelling };
  return { ok: true, registry: checked.value };
}

/**
 * The entry for a model id. With a provider the lookup is exact. Without one, an id that more
 * than one provider lists is ambiguous and returns null rather than an arbitrary entry.
 */
export function registryModel(registry: ModelRegistry, modelId: string, provider?: string): RoutingModel | null {
  const matches = registry.entries.filter((entry) => entry.modelId === modelId && (provider === undefined || entry.provider === provider));
  return matches.length === 1 ? (matches[0] as RoutingModel) : null;
}

/**
 * OD-3 (SPEC §8.1 amended): the baseline a route compares against and learning reconciles to. It
 * is the task's approved model when the registry lists it, else the harness's default in
 * `harnessDefaults`, else the registry's `baselineModelId` (the Claude Code default, and the
 * fallback for OpenCode and Kilo, which run several providers). A default that names no
 * registered model is skipped.
 */
export function routeBaseline(registry: ModelRegistry, harness?: string | null, approvedModelId?: string | null): string {
  if (approvedModelId !== undefined && approvedModelId !== null && registryModel(registry, approvedModelId) !== null) return approvedModelId;
  if (harness !== undefined && harness !== null) {
    const row = (registry.harnessDefaults ?? []).find((d) => d.harness === harness);
    if (row !== undefined && registryModel(registry, row.baselineModelId) !== null) return row.baselineModelId;
  }
  return registry.baselineModelId;
}

/** The day from which a model may be retired: an announced date, else the vendor's "not sooner than". */
export function retirementFrom(model: RoutingModel): string | null {
  const life = model.lifecycle;
  if (life === undefined) return null;
  return life.retiresOn ?? life.retirementNotBefore;
}

/** The firm retirement: the vendor's announced `retiresOn`, or null while only "not sooner than" is known. */
export function firmRetirement(model: RoutingModel): string | null {
  return model.lifecycle?.retiresOn ?? null;
}

/** A usable model's lifecycle warning: deprecated, or past its "not sooner than" date. */
export type LifecycleWarning = 'MODEL_DEPRECATED' | 'MODEL_RETIREMENT_DUE';

export type LifecycleCheck =
  | { readonly usable: true; readonly warning?: LifecycleWarning }
  | { readonly usable: false; readonly reasonCode: 'MODEL_RETIRED' };

/**
 * Whether the router may recommend a model at `nowMs` (owner decision 2026-09-27, DOMAINS 3ff4c0f
 * and 9d1e7eb: a model stays recommended until it is actually retired, by a firm date or found
 * gone). Refused: status `retired`, or on and after a firm `retiresOn`. Usable with a warning: a
 * deprecated model until it retires (`MODEL_DEPRECATED`), and a model past its "not sooner than"
 * date (`MODEL_RETIREMENT_DUE`: it may go any day; refresh the registry). A model found gone on
 * this machine is refused separately (model-availability.ts). An entry without lifecycle facts is
 * usable: the registry simply does not know.
 */
export function lifecycleCheck(model: RoutingModel, nowMs: number): LifecycleCheck {
  const life = model.lifecycle;
  if (life === undefined) return { usable: true };
  if (life.status === 'retired') return { usable: false, reasonCode: 'MODEL_RETIRED' };
  if (life.retiresOn !== null && Date.parse(life.retiresOn) <= nowMs) return { usable: false, reasonCode: 'MODEL_RETIRED' };
  if (life.status === 'deprecated') return { usable: true, warning: 'MODEL_DEPRECATED' };
  if (life.retirementNotBefore !== null && Date.parse(life.retirementNotBefore) <= nowMs) return { usable: true, warning: 'MODEL_RETIREMENT_DUE' };
  return { usable: true };
}

/** A model's lifecycle at one time, for the release gate and registry:check (A composes these, not copies). */
export interface LifecycleStatus {
  /** The router may recommend it (lifecycleCheck usable), perhaps with a warning. */
  readonly recommended: boolean;
  /** Status retired, or a firm retiresOn that has passed. */
  readonly retired: boolean;
  /** Registry data is stale: status still active or deprecated although the firm retiresOn has passed. */
  readonly stale: boolean;
  readonly warning: LifecycleWarning | null;
  readonly firmDate: string | null;
  readonly notBeforeDate: string | null;
}

/** The lifecycle of `model` at `nowMs`: the same rule the router applies (lifecycleCheck), with the dates. */
export function lifecycleStatus(model: RoutingModel, nowMs: number): LifecycleStatus {
  const check = lifecycleCheck(model, nowMs);
  const firmDate = model.lifecycle?.retiresOn ?? null;
  const firmPassed = firmDate !== null && Date.parse(firmDate) <= nowMs;
  return {
    recommended: check.usable,
    retired: !check.usable,
    stale: firmPassed && model.lifecycle?.status !== 'retired',
    warning: check.usable ? (check.warning ?? null) : null,
    firmDate,
    notBeforeDate: model.lifecycle?.retirementNotBefore ?? null,
  };
}

/** True only when the registry records that the model can serve a zero-data-retention workspace. */
export function zdrEligible(model: RoutingModel): boolean {
  return model.dataGovernance?.zdrEligible === true;
}

/**
 * True when an effort change keeps the prompt cache on this platform (per-message effort). The
 * platform is required (harness parity): `claude-api` for the Anthropic-operated platforms, or the
 * harness or cloud the session runs on, which a caller must name rather than inherit Claude's.
 */
export function effortSwitchKeepsCache(model: RoutingModel, platform: string): boolean {
  const effort = model.effortSwitch;
  return effort !== undefined && effort.keepsCache && effort.platforms.includes(platform);
}

/**
 * The prices in force at `nowMs`: the latest announced scheduled price that has taken effect,
 * else the base tariff. Tiers, the 1-hour write and the version carry over.
 */
export function tariffAt(value: Tariff, nowMs: number): Tariff {
  let current: Tariff = value;
  for (const row of value.scheduled ?? []) {
    if (Date.parse(row.effectiveAt) > nowMs) break;
    current = {
      ...current,
      effectiveAt: row.effectiveAt,
      inputPerMillion: row.inputPerMillion,
      outputPerMillion: row.outputPerMillion,
      cacheReadPerMillion: row.cacheReadPerMillion,
      cacheWritePerMillion: row.cacheWritePerMillion,
      // A scheduled change that names no 1-hour write leaves that price unknown.
      cacheWrite1hPerMillion: null,
      sourceId: row.sourceId,
    };
  }
  return current;
}

/** A promotional price whose announced end is near or past (R7), for the registry refresh. */
export interface PromotionalPrice {
  readonly modelId: string;
  readonly displayName: string | null;
  /** The announced end: the price holds at least until then (`Tariff.validUntil`). */
  readonly validUntil: string;
  /** Whole days from `nowMs` to `validUntil`; zero or less once it has passed. */
  readonly days: number;
  readonly ended: boolean;
}

/**
 * R7: the registry's promotional prices whose end falls within `windowDays` of `nowMs`, or has
 * passed. Past that date the vendor may charge more at any time, so the bundled dollars may be
 * low until the registry is refreshed. A reminder only: nothing here changes a price or a route.
 */
export function promotionalPricesEnding(registry: ModelRegistry, nowMs: number, windowDays = 30): readonly PromotionalPrice[] {
  const out: PromotionalPrice[] = [];
  for (const entry of registry.entries) {
    const until = entry.tariff.validUntil ?? null;
    if (until === null) continue;
    const at = Date.parse(until);
    if (!Number.isFinite(at)) continue;
    const days = Math.ceil((at - nowMs) / 86_400_000);
    if (days > windowDays) continue;
    out.push({ modelId: entry.modelId, displayName: entry.displayName ?? null, validUntil: until, days, ended: at <= nowMs });
  }
  return out.sort((a, b) => a.validUntil.localeCompare(b.validUntil) || a.modelId.localeCompare(b.modelId));
}

/** Micro-USD per million tokens from a USD-per-million tariff price. */
export function microPerMillion(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 1_000_000);
}

export interface TokenVolume {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens read from a warm cache. */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the cache. */
  readonly cacheWriteTokens?: number;
  /** The TTL of those writes: `1h` (Claude Code's subscription main conversation) or `5m` (default). */
  readonly cacheTtl?: CacheTtl;
}

export type CacheTtl = '5m' | '1h';

/**
 * The cache-write price for a TTL, USD per million. An unknown 1-hour price falls back to the
 * 5-minute write, then to the input price (a missing price never makes a model look cheaper
 * than its input price).
 */
export function cacheWritePrice(value: Tariff, ttl: CacheTtl = '5m'): number {
  const fiveMinute = value.cacheWritePerMillion ?? value.inputPerMillion;
  if (ttl === '5m') return fiveMinute;
  const oneHour = value.cacheWrite1hPerMillion;
  return oneHour === undefined || oneHour === null ? Math.max(fiveMinute, value.inputPerMillion) : oneHour;
}

function tokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Generation cost in micro-USD at list price, rounded up. Unknown cache prices are charged at
 * the input price (conservative: a missing cache price never makes a model look cheaper).
 */
export function generationCostMicroUsd(tariffValue: Tariff, volume: TokenVolume): number {
  // A long-context tier applies to the whole request once its input passes the threshold.
  const promptTokens = tokens(volume.inputTokens) + tokens(volume.cacheReadTokens) + tokens(volume.cacheWriteTokens);
  // R7: an `inclusive` tier applies from its threshold (xAI "reaches 200k"); otherwise above it.
  const tier = [...(tariffValue.tiers ?? [])].reverse().find((t) => promptTokens > t.aboveInputTokens || (t.inclusive === true && promptTokens === t.aboveInputTokens));
  const inputX = tier?.inputMultiplier ?? 1;
  const outputX = tier?.outputMultiplier ?? 1;
  const cacheX = tier === undefined ? 1 : (tier.cacheMultiplier ?? tier.inputMultiplier);
  const input = microPerMillion(tariffValue.inputPerMillion * inputX);
  const output = microPerMillion(tariffValue.outputPerMillion * outputX);
  const read = tariffValue.cacheReadPerMillion === null ? input : microPerMillion(tariffValue.cacheReadPerMillion * cacheX);
  const write = microPerMillion(cacheWritePrice(tariffValue, volume.cacheTtl) * cacheX);
  const total = tokens(volume.inputTokens) * input + tokens(volume.outputTokens) * output + tokens(volume.cacheReadTokens) * read + tokens(volume.cacheWriteTokens) * write;
  return Math.ceil(total / 1_000_000);
}

export interface DiscoveryResult {
  /** Ids both the registry and discovery know. */
  readonly known: readonly string[];
  /** Ids discovery reported that the registry does not know: never used. */
  readonly unregistered: readonly string[];
  /** Registry ids discovery did not report: marked unavailable in `registry`. */
  readonly missing: readonly string[];
  readonly registry: ModelRegistry;
}

/**
 * Applies one provider's Models API listing to a registry. Known ids keep their entries; missing
 * ids become `unavailable`; unknown ids are reported and never added. The provider is required
 * (harness parity): a listing only speaks for the provider it came from.
 */
export function applyDiscovery(registry: ModelRegistry, discoveredIds: readonly string[], provider: string): DiscoveryResult {
  const discovered = new Set(discoveredIds.filter((id) => typeof id === 'string'));
  const ids = new Set(registry.entries.filter((entry) => entry.provider === provider).map((entry) => entry.modelId));
  const known = [...ids].filter((id) => discovered.has(id)).sort();
  const missing = [...ids].filter((id) => !discovered.has(id)).sort();
  const unregistered = [...discovered].filter((id) => !ids.has(id)).sort();
  const entries = registry.entries.map((entry) =>
    entry.provider === provider && missing.includes(entry.modelId) ? { ...entry, health: 'unavailable' as const } : entry,
  );
  return { known, unregistered, missing, registry: { ...registry, entries } };
}

/** A refreshed registry an administrator placed at `<config>/model-registry.json`. */
export function modelRegistryFile(home: string): string {
  return join(jevrisPaths({ home }).config, 'model-registry.json');
}

/**
 * The registry for a home: a valid `<config>/model-registry.json` when present, else the
 * bundled snapshot. A present but invalid file returns null (routing unavailable), so a broken
 * price refresh never silently falls back to stale prices.
 */
/** Why a placed `model-registry.json` was refused (routing is then unavailable; no fallback to the bundled registry). */
export type ModelRegistryRefusal = (typeof MODEL_REGISTRY_REFUSALS)[number];

/** The largest `model-registry.json` read, bytes. */
export const MODEL_REGISTRY_MAX_BYTES = 1024 * 1024;

/**
 * The model registry from `<config>/model-registry.json`, or why it was refused. No file: the
 * bundled registry. A file that cannot be read, is over 1 MiB, is not JSON or fails the registry
 * contract is refused with its reason code: routing is then unavailable, never the bundled
 * registry in its place (an administrator's registry is authoritative).
 */
export async function loadModelRegistryChecked(options: { readonly home: string }): Promise<{ readonly registry: ModelRegistry } | { readonly registry: null; readonly reasonCode: ModelRegistryRefusal }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(modelRegistryFile(options.home));
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' ? { registry: BUNDLED_MODEL_REGISTRY } : { registry: null, reasonCode: 'MODEL_REGISTRY_UNREADABLE' };
  }
  return checkModelRegistryBytes(bytes);
}

/** Checks the bytes of a placed registry file: the size cap, JSON, then the registry contract. */
export function checkModelRegistryBytes(bytes: Uint8Array): { readonly registry: ModelRegistry } | { readonly registry: null; readonly reasonCode: ModelRegistryRefusal } {
  if (bytes.byteLength > MODEL_REGISTRY_MAX_BYTES) return { registry: null, reasonCode: 'MODEL_REGISTRY_TOO_LARGE' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { registry: null, reasonCode: 'MODEL_REGISTRY_NOT_JSON' };
  }
  const checked = validateModelRegistry(value);
  return checked.ok ? { registry: checked.registry } : { registry: null, reasonCode: 'MODEL_REGISTRY_INVALID' };
}

/** The loaded registry, or null when a placed file is refused (see `loadModelRegistryChecked`). */
export async function loadModelRegistry(options: { readonly home: string }): Promise<ModelRegistry | null> {
  return (await loadModelRegistryChecked(options)).registry;
}
