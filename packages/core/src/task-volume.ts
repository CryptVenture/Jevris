/**
 * P11 (learning-coverage audit; owner decision DOMAINS 7922ee3): the router's task volume per
 * slice, from the tokens this workspace's routes of that slice actually used.
 *
 * - The measure is the 90th percentile (nearest rank) of total tokens per route over the raw
 *   learning window (30 days), one value per route (its largest report), from at least
 *   `VOLUME_MIN_ROUTES` routes.
 * - Guard: it only ever raises the volume. The volume is the larger of the default and the
 *   measured p90, keeping the default's input/output split, so a reservation never falls below
 *   the configured default or the measured p90. Budget caps are untouched.
 * - Text-free: counts and token numbers only.
 */
import type { TokenVolume } from './model-registry.js';
import type { LearningState } from './route-learning.js';

/** Routes of a slice needed before its measured volume counts (the local-evidence N). */
export const VOLUME_MIN_ROUTES = 12;

export interface SliceTaskVolume {
  readonly volume: TokenVolume;
  readonly basis: 'default' | 'measured-p90';
  /** Routes of the slice with reported tokens in the window. */
  readonly routes: number;
  /** Their 90th-percentile total tokens; null below `VOLUME_MIN_ROUTES`. */
  readonly p90Tokens: number | null;
}

/** Per route of the slice, its largest reported token total in the window. */
function routeTokens(state: LearningState, sliceId: string): number[] {
  const byRoute = new Map<string, number>();
  for (const e of state.events) {
    if (e.sliceId !== sliceId) continue;
    const t = e.tokens;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) continue;
    byRoute.set(e.routeId, Math.max(byRoute.get(e.routeId) ?? 0, t));
  }
  return [...byRoute.values()];
}

export function sliceTaskVolume(state: LearningState | null, sliceId: string, fallback: TokenVolume): SliceTaskVolume {
  const tokens = state === null ? [] : routeTokens(state, sliceId).sort((a, b) => a - b);
  if (tokens.length < VOLUME_MIN_ROUTES) return { volume: fallback, basis: 'default', routes: tokens.length, p90Tokens: null };
  const p90 = tokens[Math.min(tokens.length, Math.ceil(0.9 * tokens.length)) - 1] as number;
  const total = fallback.inputTokens + fallback.outputTokens;
  if (total <= 0 || p90 <= total) return { volume: fallback, basis: 'default', routes: tokens.length, p90Tokens: p90 };
  const factor = p90 / total;
  return {
    volume: { inputTokens: Math.ceil(fallback.inputTokens * factor), outputTokens: Math.ceil(fallback.outputTokens * factor) },
    basis: 'measured-p90',
    routes: tokens.length,
    p90Tokens: p90,
  };
}

/** One plain line for explain. */
export function sliceTaskVolumeLine(sliceId: string, v: SliceTaskVolume): string {
  const size = `${v.volume.inputTokens} input and ${v.volume.outputTokens} output tokens`;
  if (v.basis === 'measured-p90') return `Task size for ${sliceId}: ${size}, the 90th percentile of ${v.routes} measured routes, above the default; it only ever raises a reservation.`;
  if (v.p90Tokens !== null) return `Task size for ${sliceId}: the default, ${size}; the 90th percentile of ${v.routes} measured routes (${v.p90Tokens} tokens) is not larger.`;
  return `Task size for ${sliceId}: the default, ${size}; ${v.routes} of ${VOLUME_MIN_ROUTES} routes with measured tokens so far.`;
}
