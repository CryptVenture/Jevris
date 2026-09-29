/**
 * P7: a passive calibration report for Jev's conservative token estimator (decision-tokens.ts).
 *
 * Each ordinary Jev decision records the input-token estimate of the request it sent next to the
 * provider-reported usage (the decision record's `estimate` and `usage`). This report compares
 * them. No extra call is made.
 *
 * - The ratio is estimate / reported input tokens. The estimator is meant to be an upper bound, so
 *   a ratio below 1 is an under-estimate: a warning (ESTIMATE_BELOW_REPORTED), because the token
 *   gate may then pass a request the provider refuses.
 * - A request repacked after the provider refused its size (PACKET_REPACKED) is counted apart: the
 *   provider's refusal is itself evidence that the estimate was too low for that request.
 * - Only records made by the current encoder count; others are counted as `otherEncoder`.
 * - Guard (ADR-08, SPEC §2.1): the report never changes `SAFETY_FACTOR`, the overheads or the
 *   encoder. They change only by release.
 */
import { ENCODER_ID } from './decision-tokens.js';

export interface EstimatorSample {
  readonly estimate?: { readonly inputTokens: number; readonly encoderId: string } | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly reasonCodes?: readonly string[];
}

export interface RatioSummary {
  readonly min: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

export interface EstimatorCalibration {
  readonly schemaVersion: 'jevris-estimator-calibration-1';
  readonly encoderId: string;
  /** Decisions of the current encoder with an estimate and reported input tokens. */
  readonly samples: number;
  /** Decisions with an estimate made by another encoder (not compared). */
  readonly otherEncoder: number;
  /** estimate / reported input tokens, over the samples; null with none. */
  readonly ratio: RatioSummary | null;
  /** Samples whose estimate was below the reported input tokens. */
  readonly underEstimates: number;
  /** Decisions repacked after the provider refused the request's size. */
  readonly repacked: number;
  readonly status: 'no-samples' | 'ok' | 'under-estimate';
  /** ESTIMATE_BELOW_REPORTED and PROVIDER_REFUSED_SIZE when they apply. */
  readonly reasonCodes: readonly string[];
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Nearest-rank quantile of a sorted list. */
function quantile(sorted: readonly number[], q: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] as number;
}

export function estimatorCalibration(records: Iterable<EstimatorSample>, encoderId: string = ENCODER_ID): EstimatorCalibration {
  const ratios: number[] = [];
  let otherEncoder = 0;
  let repacked = 0;
  for (const r of records) {
    if (r.reasonCodes?.includes('PACKET_REPACKED') === true) repacked += 1;
    const e = r.estimate;
    if (e === undefined || e === null || !Number.isFinite(e.inputTokens) || e.inputTokens < 0) continue;
    if (e.encoderId !== encoderId) {
      otherEncoder += 1;
      continue;
    }
    const reported = r.usage?.inputTokens;
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported <= 0) continue;
    ratios.push(e.inputTokens / reported);
  }
  ratios.sort((a, b) => a - b);
  const underEstimates = ratios.filter((x) => x < 1).length;
  const ratio = ratios.length === 0 ? null : { min: round3(ratios[0] as number), p10: round3(quantile(ratios, 0.1)), p50: round3(quantile(ratios, 0.5)), p90: round3(quantile(ratios, 0.9)), max: round3(ratios[ratios.length - 1] as number) };
  const reasonCodes = [...(underEstimates > 0 ? ['ESTIMATE_BELOW_REPORTED'] : []), ...(repacked > 0 ? ['PROVIDER_REFUSED_SIZE'] : [])];
  return {
    schemaVersion: 'jevris-estimator-calibration-1',
    encoderId,
    samples: ratios.length,
    otherEncoder,
    ratio,
    underEstimates,
    repacked,
    status: ratios.length === 0 ? 'no-samples' : underEstimates > 0 || repacked > 0 ? 'under-estimate' : 'ok',
    reasonCodes,
  };
}

/** Plain-text lines for cost-report and doctor. */
export function estimatorCalibrationLines(report: EstimatorCalibration): string[] {
  if (report.samples === 0) {
    return [`Token estimator ${report.encoderId}: no decision with reported usage yet, so it is not calibrated here.${report.repacked > 0 ? ` ${report.repacked} request(s) were repacked after the provider refused their size (PROVIDER_REFUSED_SIZE).` : ''}`];
  }
  const r = report.ratio as RatioSummary;
  const lines = [`Token estimator ${report.encoderId}: estimate / reported input tokens over ${report.samples} decision(s): min ${r.min}, p10 ${r.p10}, median ${r.p50}, p90 ${r.p90}, max ${r.max}.`];
  if (report.underEstimates > 0) lines.push(`Warning: ${report.underEstimates} estimate(s) were below the reported input tokens (ESTIMATE_BELOW_REPORTED). The estimator is meant to be an upper bound; its safety factor changes only by release.`);
  if (report.repacked > 0) lines.push(`Warning: ${report.repacked} request(s) were repacked after the provider refused their size (PROVIDER_REFUSED_SIZE).`);
  if (report.otherEncoder > 0) lines.push(`${report.otherEncoder} older decision(s) from another encoder are not compared.`);
  return lines;
}
