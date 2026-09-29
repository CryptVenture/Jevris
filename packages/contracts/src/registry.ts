/** Chapter 6.2 ModelRegistryEntry. Price (tariff.version) and quality (evaluationVersion) are versioned independently. */
import { defineContract } from './contract.js';
import { Id, IdList, ModelId, PositiveInteger, Timestamp } from './primitives.js';
import * as S from './schema.js';

const Price = S.number({ minimum: 0, maximum: 1_000_000 });

const Multiplier = S.number({ minimum: 0, maximum: 100 });

/** An integer price in micro-USD per million tokens (owner decision 7be3c43): $0.075 is 75000. */
const MicroUsdPerMillion = S.integer({ minimum: 0, maximum: 1_000_000_000_000 });

/**
 * The integer micro-USD form of a price (R7). Optional beside the float form, which stays required
 * until core prices only from integers; when both are present they must agree (refined in the
 * registry contract). Gemini's explicit cache storage is charged per million tokens per hour.
 */
const IntegerPrices = {
  inputMicroUsdPerMillion: MicroUsdPerMillion,
  outputMicroUsdPerMillion: MicroUsdPerMillion,
  cacheReadMicroUsdPerMillion: S.nullable(MicroUsdPerMillion),
  cacheWriteMicroUsdPerMillion: S.nullable(MicroUsdPerMillion),
  cacheWrite1hMicroUsdPerMillion: S.nullable(MicroUsdPerMillion),
  storageMicroUsdPerMillionHour: S.nullable(MicroUsdPerMillion),
} as const;

/**
 * A long-context price tier: a request whose input exceeds `aboveInputTokens` is billed at the
 * multiplied prices for the whole request (for example OpenAI above 272K input: 2x input, 1.5x
 * output). Claude 4.6 and later have no tier.
 */
export const PriceTierSchema = S.object(
  {
    aboveInputTokens: PositiveInteger,
    inputMultiplier: Multiplier,
    outputMultiplier: Multiplier,
    /** Multiplier for cache reads and writes; the input multiplier when absent. */
    cacheMultiplier: S.nullable(Multiplier),
  },
  {
    /** R7: true applies the tier when the input reaches the threshold (xAI "reaches 200k"); absent is "exceeds". */
    inclusive: S.boolean(),
  },
);
export type PriceTier = S.Static<typeof PriceTierSchema>;

/** A dated price change that is already announced (for example a price rise on a known day). */
export const ScheduledPriceSchema = S.object(
  {
    effectiveAt: Timestamp,
    inputPerMillion: Price,
    outputPerMillion: Price,
    cacheReadPerMillion: S.nullable(Price),
    cacheWritePerMillion: S.nullable(Price),
    sourceId: Id,
  },
  IntegerPrices,
);
export type ScheduledPrice = S.Static<typeof ScheduledPriceSchema>;

/**
 * A versioned list price. `cacheWritePerMillion` is the default (5-minute) cache write; a vendor
 * with a longer TTL option records it in `cacheWrite1hPerMillion`. `tiers` and `scheduled` are
 * optional so a tariff written before they existed stays valid.
 */
export const TariffSchema = S.object(
  {
    version: Id,
    currency: S.literal('USD'),
    effectiveAt: Timestamp,
    inputPerMillion: Price,
    outputPerMillion: Price,
    cacheReadPerMillion: S.nullable(Price),
    cacheWritePerMillion: S.nullable(Price),
    sourceId: Id,
  },
  {
    cacheWrite1hPerMillion: S.nullable(Price),
    tiers: S.array(PriceTierSchema, { maxItems: 8 }),
    scheduled: S.array(ScheduledPriceSchema, { maxItems: 8 }),
    ...IntegerPrices,
    /** R7: a promotional price's end (for example "at least through 2026-11-21"); null when open-ended. */
    validUntil: S.nullable(Timestamp),
  },
);
export type Tariff = S.Static<typeof TariffSchema>;

export const ModelRegistryEntrySchema = S.object({
  provider: Id,
  modelId: ModelId,
  capabilities: IdList({ maxItems: 64 }),
  eligibilityPolicyId: Id,
  evaluationSliceIds: IdList(),
  evaluationVersion: Id,
  tariff: TariffSchema,
});
export type ModelRegistryEntry = S.Static<typeof ModelRegistryEntrySchema>;

export const ModelRegistryEntryContract = defineContract<ModelRegistryEntry>({
  name: 'ModelRegistryEntry',
  description: 'Provider, exact model id, eligibility, capabilities, versioned tariff and evaluation slices (§6.2).',
  schema: ModelRegistryEntrySchema,
});
