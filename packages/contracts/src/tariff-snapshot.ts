/**
 * Prices fetched 2026-09-24. Integer micro-USD only.
 * Not a measured Jevris cost, and not an account quota.
 */

export const TARIFF_FETCHED_ON = '2026-09-24' as const;

export const accountQuota = null;

export interface TariffRow {
  readonly fetchedOn: typeof TARIFF_FETCHED_ON;
  readonly displayName: string;
  readonly modelId: string | null;
  readonly apiId: string | null;
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  readonly cacheReadMicroUsdPerMillion: number | null;
  readonly cacheWriteMicroUsdPerMillion: number | null;
  readonly eligibleForPrice: boolean;
  readonly eligibleForAutomation: boolean;
  readonly onFetchedModelsList: boolean;
}

const fetchedOn = TARIFF_FETCHED_ON;

function row(
  displayName: string,
  modelId: string | null,
  apiId: string | null,
  inputMicroUsdPerMillion: number,
  outputMicroUsdPerMillion: number,
  cacheReadMicroUsdPerMillion: number | null,
  eligibleForPrice: boolean,
  onFetchedModelsList: boolean,
): TariffRow {
  return {
    fetchedOn,
    displayName,
    modelId,
    apiId,
    inputMicroUsdPerMillion,
    outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: null,
    eligibleForPrice,
    eligibleForAutomation: false,
    onFetchedModelsList,
  };
}

export const tariffRows: readonly TariffRow[] = [
  row('jev-1.13.0', 'jev-1.13.0', 'jev-1.13.0', 42000, 0, null, true, true),
  row('jev-latest', 'jev-latest', null, 0, 0, null, false, false),
  row('jev-preview', 'jev-preview', null, 0, 0, null, false, false),
  row('Fable 5.1', null, null, 10000000, 50000000, 250000, false, false),
  row('Opus 5', null, null, 5000000, 25000000, 500000, false, false),
  row('Sonnet 5', null, null, 2000000, 10000000, 200000, false, false),
  row('Haiku 4.5', null, null, 1000000, 5000000, 100000, false, false),
];

export const tariffSnapshot = {
  fetchedOn,
  accountQuota: null,
  rows: tariffRows,
};
