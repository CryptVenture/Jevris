/**
 * Routing contracts (§8.1-§8.4, RTE-01, RTE-06): the sourced model registry snapshot, the
 * human pins and the main-session route advice. A registry entry is an exact provider API id
 * with versioned full tariff, context and effort facts, regional eligibility, health and
 * per-account eligibility. Discovery never invents an id: every entry names its sources.
 */
import { QUALITY_EFFORT_LEVELS } from './calibration.js';
import { defineContract, timestampMs } from './contract.js';
import { HARNESS_MODEL_ID_PATTERN, Hash, HarnessIdSchema, Id, IdList, ModelId, NonNegativeInteger, PositiveInteger, ReasonCode, SECRET_PATTERNS, Timestamp, text } from './primitives.js';
import { TariffSchema, type ScheduledPrice, type Tariff } from './registry.js';
import * as S from './schema.js';
import { SERVING_HOST_IDS, servingHostOf } from './serving-hosts.js';

export const MODEL_HEALTH = ['healthy', 'degraded', 'unavailable', 'unknown'] as const;
export const DISCOVERY_SOURCES = ['models-api', 'vendor-docs', 'manual-review'] as const;
/** Vendor lifecycle states (active, legacy, deprecated, retired) plus preview for pre-GA models. */
export const MODEL_STATUSES = ['active', 'legacy', 'deprecated', 'retired', 'preview'] as const;

/**
 * The providers a bundled registry entry may name (owner decision 7be3c43). `RoutingModel.provider`
 * stays an Id so an administrator's override can add another; `registry:check` holds the bundled
 * snapshot to this list.
 */
export const PROVIDER_IDS = ['anthropic', 'openai', 'google', 'xai', 'zai', 'moonshot', 'deepseek', 'alibaba', 'minimax', 'mistral', 'meta'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How a session signs in to a provider, for data terms and eligibility per sign-in: an API key, a
 * consumer subscription, a business or enterprise workspace, or an unpaid tier.
 */
export const SIGN_INS = ['api-key', 'subscription', 'workspace', 'unpaid'] as const;
export type SignIn = (typeof SIGN_INS)[number];

/**
 * How a harness takes an effort level: a CLI flag (Claude Code), a config value (Codex), a model
 * variant (OpenCode, Kilo), a model name that carries it (Antigravity), or not at all.
 */
export const EFFORT_VIA = ['flag', 'config', 'variant', 'model-name', 'none'] as const;

/**
 * How a harness spells a registry model id (R2): as is, or behind one of the access row's provider
 * segments (`{provider}` is each of `providerIds`, else the registry provider id).
 */
export const HARNESS_ID_TEMPLATES = ['{id}', '{provider}/{id}'] as const;

/** A harness's own model name or effort token: a harness model id, or Antigravity's display name. */
const HARNESS_MODEL_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9 ._()+:/\\[\\]-]{0,127}$';
const HarnessModelName = S.string({ minLength: 1, maxLength: 128, pattern: HARNESS_MODEL_NAME_PATTERN, notPatterns: SECRET_PATTERNS });
const HARNESS_MODEL_ID = new RegExp(HARNESS_MODEL_ID_PATTERN);

/** A registry effort level mapped to the harness's own token (Codex `max` is `xhigh`). */
const EffortTokens = S.object({}, Object.fromEntries(QUALITY_EFFORT_LEVELS.map((level) => [level, HarnessModelName])) as { readonly [K in (typeof QUALITY_EFFORT_LEVELS)[number]]: typeof HarnessModelName });

/**
 * One model on one harness where the access row's defaults do not derive it (R2): its id there
 * (a harness model id; on Antigravity the display name), how it takes effort, and its effort tokens.
 */
export const HarnessModelSchema = S.object(
  { harness: HarnessIdSchema, id: HarnessModelName, effortVia: S.enumOf(EFFORT_VIA) },
  { efforts: EffortTokens, effortLevels: IdList({ maxItems: 16 }), defaultEffort: S.nullable(Id) },
);
export type HarnessModel = S.Static<typeof HarnessModelSchema>;

/** A provider's data terms for one sign-in: codes and facts only, never text (explain and doctor word them). */
export const SignInDataTermsSchema = S.object({
  signIn: S.enumOf(SIGN_INS),
  /** Whether the provider may train on the content under this sign-in; null when not established. */
  trainsOnContent: S.nullable(S.boolean()),
  retentionDays: S.nullable(NonNegativeInteger),
  /** Where the content is stored or processed (a region or country id); null when not established. */
  location: S.nullable(Id),
  reasonCode: ReasonCode,
  sourceId: Id,
});
export type SignInDataTerms = S.Static<typeof SignInDataTermsSchema>;

export const CACHE_MODES = ['explicit', 'implicit', 'both'] as const;

export const RoutingModelSchema = S.object(
  {
    provider: Id,
    modelId: ModelId,
    family: Id,
    capabilities: IdList({ maxItems: 64 }),
    contextTokens: PositiveInteger,
    maxOutputTokens: PositiveInteger,
    effortLevels: IdList({ maxItems: 16 }),
    regions: IdList({ minItems: 1, maxItems: 64 }),
    health: S.enumOf(MODEL_HEALTH),
    tariff: TariffSchema,
    accountEligibility: S.array(
      S.object({ accountId: Id, eligible: S.boolean(), checkedAt: Timestamp }),
      { maxItems: 64 },
    ),
    evaluationSliceIds: IdList(),
    evaluationVersion: Id,
    discoveredVia: S.enumOf(DISCOVERY_SOURCES),
    sourceIds: IdList({ minItems: 1, maxItems: 16 }),
  },
  {
    displayName: S.string({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9 .()-]+$' }),
    lifecycle: S.object({
      status: S.enumOf(MODEL_STATUSES),
      releasedOn: S.nullable(Timestamp),
      /** The vendor's commitment: not retired before this date (the retirement may come later). */
      retirementNotBefore: S.nullable(Timestamp),
      /** An announced retirement date. */
      retiresOn: S.nullable(Timestamp),
      replacementModelId: S.nullable(ModelId),
      sourceId: Id,
    }),
    dataGovernance: S.object(
      {
        /** Whether the model can serve a zero-data-retention workspace. */
        zdrEligible: S.boolean(),
        /** A retention period the vendor requires for this model, days (null when none). */
        requiredRetentionDays: S.nullable(NonNegativeInteger),
        sourceId: Id,
      },
      {
        /** The data terms per sign-in (7be3c43), one row per sign-in. */
        bySignIn: S.array(SignInDataTermsSchema, { maxItems: 4 }),
      },
    ),
    /** The effort level the provider applies when none is sent; null when effort is unsupported. */
    defaultEffort: S.nullable(Id),
    /**
     * How an effort change mid-session behaves. `keepsCache` is true only where the provider
     * documents a per-message change that keeps the prompt cache (with its beta and platforms);
     * elsewhere a new effort level restarts the cache like a model switch.
     */
    effortSwitch: S.object({ keepsCache: S.boolean(), betaHeader: S.nullable(Id), platforms: IdList({ maxItems: 16 }) }),
    /** R2: the model on a harness where the access row's defaults do not derive it; one row per harness. */
    harnessModels: S.array(HarnessModelSchema, { maxItems: 8 }),
    /** An input limit below the context window (for example 922K of a 1.05M context). */
    maxInputTokens: PositiveInteger,
    /** Prompt caching: explicit, implicit or both, its TTLs (such as 5m, 1h), the minimum prompt, and whether it is per model. */
    cache: S.object({ mode: S.enumOf(CACHE_MODES), ttls: IdList({ maxItems: 8 }), minTokens: S.nullable(PositiveInteger), perModel: S.boolean() }),
    /** The provider needs the user's egress consent before any content goes to it (7be3c43; PROVIDER_CONSENT_REQUIRED). */
    requiresProviderConsent: S.boolean(),
  },
);
export type RoutingModel = S.Static<typeof RoutingModelSchema>;

/**
 * How a harness reaches a provider's models (the model landscape's harness keys): `native`, a
 * `provider-config` with the user's own key, or a `gateway` / compatible endpoint.
 */
export const HARNESS_ACCESS = ['native', 'provider-config', 'gateway'] as const;

/**
 * One row of the harness-to-model map (owner decision DOMAINS 3f090fa): which providers' models a
 * harness can run, and how. The map only narrows: a model becomes eligible on a harness from
 * local evidence (it ran there, or the harness lists it), never from the map alone.
 */
export const HarnessAccessSchema = S.object(
  {
    harness: HarnessIdSchema,
    provider: Id,
    access: S.enumOf(HARNESS_ACCESS),
    sourceIds: IdList({ minItems: 1, maxItems: 16 }),
  },
  {
    /** R2: the harness's own provider segments for this provider (OpenCode `google-vertex` for google). */
    providerIds: IdList({ maxItems: 8 }),
    /** R2: how the harness spells a registry id; absent, only a model's harnessModels row names it there. */
    idTemplate: S.enumOf(HARNESS_ID_TEMPLATES),
    /** R2: the sign-ins through which the harness reaches the provider (the OD-4 signed-in default, R11). */
    signIns: S.array(S.enumOf(SIGN_INS), { uniqueItems: true, maxItems: 4 }),
    /** R2: whether an owned worker may run this provider's models on the harness unattended. */
    unattendedAllowed: S.boolean(),
    /** R2: how the harness takes effort, its levels for this provider and the level it applies when none is sent. */
    effortVia: S.enumOf(EFFORT_VIA),
    effortLevels: IdList({ maxItems: 16 }),
    defaultEffort: S.nullable(Id),
  },
);
export type HarnessAccess = S.Static<typeof HarnessAccessSchema>;

/**
 * How a serving's price is known (serving-hosts design 3.3, 6.1): the host's own tariff from the
 * dated snapshot, a free trial or free tier (never a known tariff), or not known.
 */
export const SERVING_TARIFF_BASES = ['host', 'free-tier', 'unknown'] as const;
export type ServingTariffBasis = (typeof SERVING_TARIFF_BASES)[number];

/**
 * A host's own model id, exact case (`moonshotai/Kimi-K3`): at most one `/`, and no `:` suffix,
 * `~` alias or `[1m]`, so a free variant (`:free`), a routing suffix (`:nitro`) or a moving alias
 * (`~deepseek/...-latest`) can never be a serving.
 */
export const HOST_MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$';

/**
 * One registry model served by one pinned host (serving-hosts design 3.3, R36). The entry stays
 * unique; a serving only says that `host` serves it as `hostModelId`, at what tariff. The host is
 * one of `SERVING_HOST_IDS`, so a serving can never name a maker (a maker is its own host) or an
 * unpinned host. C's registry checks add the cross-entry rules (the entry exists, the maker slug
 * matches, no duplicate).
 */
export const ServingSchema = S.object(
  {
    host: S.enumOf(SERVING_HOST_IDS),
    provider: Id,
    modelId: ModelId,
    hostModelId: S.string({ minLength: 1, maxLength: 192, pattern: HOST_MODEL_ID_PATTERN, notPatterns: SECRET_PATTERNS }),
    /** The host's tariff, with the integer micro-USD forms required; null unless `tariffBasis` is `host`. */
    tariff: S.nullable(TariffSchema),
    tariffBasis: S.enumOf(SERVING_TARIFF_BASES),
    sourceIds: IdList({ minItems: 1, maxItems: 16 }),
  },
  {
    /** Where the spelling applies; absent, every harness with a harnessHosts row for the host. */
    harnesses: S.array(HarnessIdSchema, { uniqueItems: true, minItems: 1, maxItems: 8 }),
  },
);
export type Serving = S.Static<typeof ServingSchema>;

/**
 * One harness reaching one pinned host (serving-hosts design 3.3, R36): the harness spelling's first
 * segment for it and the sign-ins through which the harness reaches it. The segment must be the
 * one pinned for that harness in `SERVING_HOSTS`, so an override cannot point a maker's segment at
 * a host or a host's segment at another host.
 */
export const HarnessHostSchema = S.object({
  harness: HarnessIdSchema,
  host: S.enumOf(SERVING_HOST_IDS),
  segment: S.string({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
  signIns: S.array(S.enumOf(SIGN_INS), { uniqueItems: true, maxItems: 4 }),
  sourceIds: IdList({ minItems: 1, maxItems: 16 }),
});
export type HarnessHost = S.Static<typeof HarnessHostSchema>;

export const ModelRegistrySchema = S.object(
  {
    schemaVersion: S.literal('1.0'),
    snapshotId: Id,
    fetchedOn: Timestamp,
    baselineModelId: ModelId,
    entries: S.array(RoutingModelSchema, { minItems: 1, maxItems: 256 }),
  },
  {
    /** The harness-to-model map, per provider. Absent: no harness is narrowed by it. */
    harnessAccess: S.array(HarnessAccessSchema, { maxItems: 128 }),
    /**
     * OD-3: each harness's default baseline, one row per harness, each a registry entry. The
     * top-level baselineModelId stays the Claude Code default.
     */
    harnessDefaults: S.array(S.object({ harness: HarnessIdSchema, baselineModelId: ModelId }), { maxItems: 8 }),
    /** Serving hosts (R36): the registry models a pinned gateway or inference host serves. Additive: schemaVersion stays 1.0. */
    servings: S.array(ServingSchema, { maxItems: 512 }),
    /** Serving hosts (R36): which harness reaches which pinned host, through which segment. */
    harnessHosts: S.array(HarnessHostSchema, { maxItems: 64 }),
  },
);
export type ModelRegistry = S.Static<typeof ModelRegistrySchema>;

export const ModelRegistryContract = defineContract<ModelRegistry>({
  name: 'ModelRegistry',
  description: 'A dated, sourced registry snapshot: exact API ids, full tariffs, context, effort, region, health and account eligibility (§8.1, §8.2).',
  schema: ModelRegistrySchema,
  refine: (value, issue) => {
    const seen = new Set<string>();
    value.entries.forEach((entry, index) => {
      const key = `${entry.provider}/${entry.modelId}`;
      if (seen.has(key)) issue(`/entries/${index}/modelId`, 'DUPLICATE_MODEL');
      seen.add(key);
      const tariff = entry.tariff;
      if (timestampMs(tariff.effectiveAt) > timestampMs(value.fetchedOn)) issue(`/entries/${index}/tariff/effectiveAt`, 'TARIFF_AFTER_SNAPSHOT');
      // A scheduled price is a known future change: strictly later than the tariff and each other.
      let last = timestampMs(tariff.effectiveAt);
      (tariff.scheduled ?? []).forEach((row, at) => {
        if (!(timestampMs(row.effectiveAt) > last)) issue(`/entries/${index}/tariff/scheduled/${at}/effectiveAt`, 'SCHEDULE_NOT_INCREASING');
        last = Math.max(last, timestampMs(row.effectiveAt));
      });
      checkIntegerPrices(tariff, `/entries/${index}/tariff`, issue);
      (tariff.scheduled ?? []).forEach((row, at) => checkIntegerPrices(row, `/entries/${index}/tariff/scheduled/${at}`, issue));
      const harnesses = new Set<string>();
      (entry.harnessModels ?? []).forEach((row, at) => {
        if (harnesses.has(row.harness)) issue(`/entries/${index}/harnessModels/${at}`, 'DUPLICATE_HARNESS');
        harnesses.add(row.harness);
        // Only Antigravity names a model by display name; every other harness takes a model id.
        if (row.harness !== 'antigravity' && !HARNESS_MODEL_ID.test(row.id)) issue(`/entries/${index}/harnessModels/${at}/id`, 'NOT_A_HARNESS_MODEL_ID');
      });
      let threshold = 0;
      (tariff.tiers ?? []).forEach((tier, at) => {
        if (!(tier.aboveInputTokens > threshold)) issue(`/entries/${index}/tariff/tiers/${at}/aboveInputTokens`, 'TIERS_NOT_INCREASING');
        threshold = Math.max(threshold, tier.aboveInputTokens);
      });
      const life = entry.lifecycle;
      if (life !== undefined && life.releasedOn !== null) {
        const released = timestampMs(life.releasedOn);
        if (life.retirementNotBefore !== null && timestampMs(life.retirementNotBefore) < released) issue(`/entries/${index}/lifecycle/retirementNotBefore`, 'RETIREMENT_BEFORE_RELEASE');
        if (life.retiresOn !== null && timestampMs(life.retiresOn) < released) issue(`/entries/${index}/lifecycle/retiresOn`, 'RETIREMENT_BEFORE_RELEASE');
      }
    });
    const pairs = new Set<string>();
    (value.harnessAccess ?? []).forEach((row, index) => {
      const key = `${row.harness}/${row.provider}`;
      if (pairs.has(key)) issue(`/harnessAccess/${index}`, 'DUPLICATE_HARNESS_ACCESS');
      pairs.add(key);
      if (!value.entries.some((entry) => entry.provider === row.provider)) issue(`/harnessAccess/${index}/provider`, 'PROVIDER_NOT_IN_REGISTRY');
    });
    const defaults = new Set<string>();
    (value.harnessDefaults ?? []).forEach((row, index) => {
      if (defaults.has(row.harness)) issue(`/harnessDefaults/${index}`, 'DUPLICATE_HARNESS');
      defaults.add(row.harness);
      if (!value.entries.some((entry) => entry.modelId === row.baselineModelId)) issue(`/harnessDefaults/${index}/baselineModelId`, 'DEFAULT_NOT_REGISTERED');
    });
    (value.servings ?? []).forEach((serving, index) => {
      const at = `/servings/${index}`;
      // Only a host's own tariff is a tariff; a free tier or an unknown price carries none.
      if (serving.tariffBasis === 'host' && serving.tariff === null) issue(`${at}/tariff`, 'SERVING_TARIFF_MISSING');
      if (serving.tariffBasis !== 'host' && serving.tariff !== null) issue(`${at}/tariff`, 'SERVING_TARIFF_NOT_HOST');
      if (serving.tariff !== null) {
        const tariff = serving.tariff;
        if (timestampMs(tariff.effectiveAt) > timestampMs(value.fetchedOn)) issue(`${at}/tariff/effectiveAt`, 'TARIFF_AFTER_SNAPSHOT');
        if (tariff.inputMicroUsdPerMillion === undefined) issue(`${at}/tariff`, 'INTEGER_PRICES_REQUIRED');
        // T-R4 as amended: a zero price is never a known tariff (a free trial is basis free-tier).
        if (tariff.inputPerMillion === 0 && tariff.outputPerMillion === 0) issue(`${at}/tariff`, 'SERVING_FREE_PRICED');
        checkIntegerPrices(tariff, `${at}/tariff`, issue);
        (tariff.scheduled ?? []).forEach((row, i) => checkIntegerPrices(row, `${at}/tariff/scheduled/${i}`, issue));
      }
    });
    const hostRows = new Set<string>();
    (value.harnessHosts ?? []).forEach((row, index) => {
      const key = `${row.harness}/${row.host}`;
      if (hostRows.has(key)) issue(`/harnessHosts/${index}`, 'DUPLICATE_HARNESS_HOST');
      hostRows.add(key);
      // The segment is pinned per harness; a harness with no pinned segment for the host has none.
      const pinned = servingHostOf(row.host)?.segments[row.harness];
      if (pinned === undefined || pinned !== row.segment) issue(`/harnessHosts/${index}/segment`, 'HOST_SEGMENT_NOT_PINNED');
    });
    const baseline = value.entries.filter((entry) => entry.modelId === value.baselineModelId);
    if (baseline.length === 0) issue('/baselineModelId', 'BASELINE_NOT_IN_REGISTRY');
    else if (baseline.length > 1) issue('/baselineModelId', 'BASELINE_AMBIGUOUS');
    else {
      // The approved baseline is what every route falls back to, so it cannot be retiring.
      const life = baseline[0]?.lifecycle;
      if (life !== undefined && (life.status === 'deprecated' || life.status === 'retired' || (life.retiresOn !== null && timestampMs(life.retiresOn) <= timestampMs(value.fetchedOn)))) issue('/baselineModelId', 'BASELINE_RETIRED');
    }
  },
});

/**
 * R7: the integer micro-USD form, when a price carries it, is whole (input and output together)
 * and agrees with the float form to the micro-dollar.
 */
function checkIntegerPrices(price: Tariff | ScheduledPrice, at: string, issue: (path: string, code: string) => void): void {
  const pairs = [
    ['inputPerMillion', 'inputMicroUsdPerMillion'],
    ['outputPerMillion', 'outputMicroUsdPerMillion'],
    ['cacheReadPerMillion', 'cacheReadMicroUsdPerMillion'],
    ['cacheWritePerMillion', 'cacheWriteMicroUsdPerMillion'],
    ['cacheWrite1hPerMillion', 'cacheWrite1hMicroUsdPerMillion'],
  ] as const;
  const record = price as unknown as { readonly [key: string]: number | null | undefined };
  const hasInput = record['inputMicroUsdPerMillion'] !== undefined;
  if (hasInput !== (record['outputMicroUsdPerMillion'] !== undefined)) issue(at, 'INTEGER_PRICES_INCOMPLETE');
  for (const [float, integer] of pairs) {
    const whole = record[integer];
    const value = record[float];
    if (whole === undefined || whole === null || value === undefined || value === null) continue;
    if (Math.round(value * 1_000_000) !== whole) issue(`${at}/${integer}`, 'PRICE_FORMS_DISAGREE');
  }
}

export const RoutePinsSchema = S.object({ modelPin: S.nullable(ModelId), effortPin: S.nullable(Id) });
export type RoutePins = S.Static<typeof RoutePinsSchema>;

export const ROUTE_ADVICE_OUTCOMES = ['keep', 'recommend', 'abstain'] as const;
export const PIN_STATES = ['pinned-kept', 'unpinned'] as const;
/**
 * `maker-price-estimate` (serving hosts R48, design 6.3): the route goes through a serving host
 * whose own tariff is not known, so its cost is the maker's list price, labelled an estimate.
 * Bounded-auto never switches on an estimate (HOST_TARIFF_UNKNOWN).
 */
export const COST_BASES = ['api-list-price', 'subscription-quota', 'unknown', 'maker-price-estimate'] as const;

export const RouteAdviceSchema = S.object({
  schemaVersion: S.literal('1.0'),
  outcome: S.enumOf(ROUTE_ADVICE_OUTCOMES),
  requestedModelId: S.nullable(ModelId),
  observedModelId: S.nullable(ModelId),
  recommendedModelId: S.nullable(ModelId),
  reasonCode: ReasonCode,
  costBasis: S.enumOf(COST_BASES),
  /** Expected saving and its interval in micro-USD, null when not computed. Never a measured saving. */
  estimate: S.nullable(
    S.object({
      expectedSavingMicroUsd: S.integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
      lowerMicroUsd: S.integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
      upperMicroUsd: S.integer({ minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }),
      transitionCostMicroUsd: NonNegativeInteger,
    }),
  ),
  pinState: S.enumOf(PIN_STATES),
  registrySnapshotId: Id,
  adviceKey: Hash,
  text: text(600),
});
export type RouteAdvice = S.Static<typeof RouteAdviceSchema>;

export const RouteAdviceContract = defineContract<RouteAdvice>({
  name: 'RouteAdvice',
  description: 'Main-session route advice: a templated recommendation naming model, reason, cost basis and pin state (§8.4, C10).',
  schema: RouteAdviceSchema,
  refine: (value, issue) => {
    if (value.outcome === 'recommend' && value.recommendedModelId === null) issue('/recommendedModelId', 'RECOMMEND_WITHOUT_MODEL');
    if (value.outcome !== 'recommend' && value.recommendedModelId !== null) issue('/recommendedModelId', 'MODEL_WITHOUT_RECOMMEND');
    if (value.estimate !== null && value.estimate.lowerMicroUsd > value.estimate.upperMicroUsd) issue('/estimate', 'INTERVAL_ORDER');
  },
});
