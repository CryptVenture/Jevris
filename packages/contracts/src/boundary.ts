/**
 * SSOT boundary contracts for the `ssot_docs/examples` fixtures: the product configuration and
 * the pack manifest (ported one-for-one from `ssot_docs/schemas`) and the native Jev request
 * (§2.5, `ssot_docs/reference/jev-client.ts`).
 */
import { ACTION_KINDS } from './actions.js';
import { defineContract } from './contract.js';
import { JevQuestionsSchema } from './decision.js';
import { MODES, ModeSchema } from './domain.js';
import type { Json } from './json.js';
import { JEV_MODEL_PATTERN } from './primitives.js';
import { MAIN_SESSION_MODES } from './route-turn.js';
import * as S from './schema.js';

const Entry = S.string({ minLength: 1, maxLength: 256 });
const EntryList = S.array(Entry, { maxItems: 256, uniqueItems: true });

/** `routing.modelListing` values; `MODEL_LISTING_DEFAULT` applies when the key is absent. */
export const MODEL_LISTING_VALUES = ['on', 'off'] as const;
export type ModelListingSetting = (typeof MODEL_LISTING_VALUES)[number];
export const MODEL_LISTING_DEFAULT: ModelListingSetting = 'on';

/**
 * `routing.firstTry` (owner decision 2026-09-30, Sonnet-first routing): `auto` starts a low-risk
 * owned task on a cheaper first-try model of the baseline's vendor and hands it once to a stronger
 * model when its acceptance check fails; `baseline` runs the baseline first. Absent means `auto`.
 */
export const FIRST_TRY_VALUES = ['auto', 'baseline'] as const;
export type FirstTrySetting = (typeof FIRST_TRY_VALUES)[number];
export const FIRST_TRY_DEFAULT: FirstTrySetting = 'auto';

/**
 * `jev.assist` (owner decision 2026-10-01, Jev as an active decision aid): `classify` lets Jevris ask
 * Jev bounded classification questions (today: the task slice of a route request) from structured
 * features, with a rules fallback; `off` keeps every such decision rules-only. Absent means
 * `classify`. A repository may only lower it; raising it needs a person at a terminal.
 */
export const JEV_ASSIST_VALUES = ['off', 'classify'] as const;
export type JevAssistSetting = (typeof JEV_ASSIST_VALUES)[number];
export const JEV_ASSIST_DEFAULT: JevAssistSetting = 'classify';

/**
 * `decisions.monthlyBudgetMicroUsd` (owner decision 2026-09-29): the machine-wide monthly limit on
 * Jevris's own Jev decision calls, in integer micro-USD. Absent means the default, 5 USD. 0 means
 * no Jev calls (rules-only). The maximum is 1,000 USD, a bound on a typo, not a price estimate.
 */
export const JEV_BUDGET_DEFAULT_MICRO_USD = 5_000_000;
export const JEV_BUDGET_MAX_MICRO_USD = 1_000_000_000;

/** Integer micro-USD as dollars for a line of text, e.g. 5000000 -> "5.00 USD"; integer arithmetic only. */
export function jevBudgetText(microUsd: number): string {
  const cents = Math.floor(microUsd / 10_000);
  const rest = microUsd % 10_000;
  const whole = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return rest === 0 ? `${whole} USD` : `${whole}${String(rest).padStart(4, '0').replace(/0+$/, '')} USD`;
}

export const JevrisConfigSchema = S.object({
  schemaVersion: S.literal('1.0'),
  mode: ModeSchema,
  provider: S.object({
    kind: S.literal('typesafe-direct'),
    model: S.string({ pattern: JEV_MODEL_PATTERN }),
    credentialRef: S.string({ pattern: '^host-secret:[A-Za-z0-9_-]+$' }),
  }),
  decisions: S.object(
    {
      hotPathDeadlineMs: S.integer({ minimum: 1, maximum: 30_000 }),
      backgroundDeadlineMs: S.integer({ minimum: 1, maximum: 120_000 }),
      maxRequestBytes: S.integer({ minimum: 1024, maximum: 16_777_216 }),
      maxQuestions: S.integer({ minimum: 1, maximum: 12 }),
      allowUncalibratedActuation: S.literal(false),
    },
    {
      /**
       * The machine-wide monthly Jev decision budget, integer micro-USD (owner decision
       * 2026-09-29). Absent means JEV_BUDGET_DEFAULT_MICRO_USD; 0 means rules-only.
       */
      monthlyBudgetMicroUsd: S.integer({ minimum: 0, maximum: JEV_BUDGET_MAX_MICRO_USD }),
    },
  ),
  privacy: S.object({
    sourceEgress: S.enumOf(['deny-until-approved', 'approved-scoped']),
    remoteTelemetry: S.enumOf(['off', 'approved-aggregates']),
    rawArtifactRetentionDays: S.integer({ minimum: 0, maximum: 365 }),
    decisionRetentionDays: S.integer({ minimum: 0, maximum: 3650 }),
  }),
  routing: S.object(
    {
      /**
       * plugin-bounded-auto lets Kilo and OpenCode main sessions be switched per turn under
       * bounded-auto rules; every other harness's main session stays advice-only (SSOT schema,
       * amended 2026-09-27 with owner approval, f294e43). The install default is D's.
       */
      mainSession: S.enumOf(MAIN_SESSION_MODES),
      managedWorkers: S.enumOf(MODES),
      respectHumanPins: S.literal(true),
      calibrationArtifact: S.nullable(S.string({ maxLength: 256 })),
    },
    {
      /**
       * Whether the sidecar asks each installed harness to list the models it offers (owner
       * decision 2026-09-27, DOMAINS 3f090fa). Absent means `on`; `off` stops all listing.
       */
      modelListing: S.enumOf(MODEL_LISTING_VALUES),
      /** Sonnet-first routing (owner decision 2026-09-30). Absent means `auto`. */
      firstTry: S.enumOf(FIRST_TRY_VALUES),
    },
  ),
  orchestration: S.object({
    enabled: S.boolean(),
    maxConcurrentWorkers: S.integer({ minimum: 1, maximum: 32 }),
    maxWorkerDepth: S.integer({ minimum: 0, maximum: 4 }),
    maxRepairAttempts: S.integer({ minimum: 0, maximum: 10 }),
    maxStopContinuationsPerCondition: S.integer({ minimum: 0, maximum: 1 }),
  }),
  compaction: S.object({
    nativeAutoDeferral: S.boolean(),
    preserveMandatoryFacts: S.literal(true),
    rawTranscriptEditing: S.literal(false),
  }),
  packs: EntryList,
  },
  {
    /**
     * Verification settings (owner decision 2026-09-30). `backgroundAtStop` is `off` when absent:
     * `on` lets a main-session Stop queue the approved checks that are missing or stale in the
     * background. It never blocks the Stop.
     */
    verification: S.object({}, { backgroundAtStop: S.enumOf(['off', 'on']) }),
    /** Jev assist (owner decision 2026-10-01). `assist` is `classify` when absent. */
    jev: S.object({}, { assist: S.enumOf(JEV_ASSIST_VALUES) }),
  },
);
export type JevrisConfig = S.Static<typeof JevrisConfigSchema>;

export const JevrisConfigContract = defineContract<JevrisConfig>({
  name: 'JevrisConfig',
  description: 'Product configuration, the SSOT v1 handoff subset (ssot_docs/schemas/jevris-config.schema.json). Validity is not consent.',
  schema: JevrisConfigSchema,
});

export const PACK_DATA_SCOPES = [
  'task-metadata',
  'approved-source-spans',
  'approved-tool-output',
  'verification-receipts',
  'policy-metadata',
] as const;

export const PackManifestSchema = S.object({
  schemaVersion: S.literal('1.0'),
  id: S.string({ pattern: '^jevris\\.[a-z][a-z0-9.-]+$' }),
  version: S.string({ pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  maturity: S.enumOf(['experimental', 'canary', 'stable']),
  description: S.string({ minLength: 1, maxLength: 1000 }),
  requiresCapabilities: EntryList,
  fallbackCapabilities: EntryList,
  decisionSpecs: EntryList,
  actions: S.array(S.enumOf(ACTION_KINDS), { maxItems: 256, uniqueItems: true }),
  dataScopes: S.array(S.enumOf(PACK_DATA_SCOPES), { maxItems: 256, uniqueItems: true }),
  defaultMode: ModeSchema,
  conflicts: EntryList,
  fixtures: EntryList,
});
export type PackManifest = S.Static<typeof PackManifestSchema>;

export const PackManifestContract = defineContract<PackManifest>({
  name: 'PackManifest',
  description: 'Declarative pack manifest, the SSOT v1 handoff subset (ssot_docs/schemas/pack-manifest.schema.json).',
  schema: PackManifestSchema,
});

export const JevRequestSchema = S.object({
  model: S.string({ pattern: JEV_MODEL_PATTERN }),
  state: S.custom<string | readonly Json[] | { readonly [key: string]: Json }>({
    description: 'The evidence packet: a string, an array or an object of plain JSON.',
    anyOf: [{ type: 'string' }, { type: 'array' }, { type: 'object' }],
  }),
  questions: JevQuestionsSchema,
});
export type JevRequest = S.Static<typeof JevRequestSchema>;

export const JevRequestContract = defineContract<JevRequest>({
  name: 'JevRequest',
  description: 'Native Jev request: pinned model, state, one to twelve Choice, Score or Noul questions (§2.5).',
  schema: JevRequestSchema,
});
