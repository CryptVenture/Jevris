/**
 * Decision cache (DEC-09, §7.2). An identical packet under identical policy may replace a call.
 *
 * The key covers every validity input: workspace, evidence (packet) hash, question-set version
 * with criteria order, state encoder, provider route, resolved model or pin, policy version and
 * calibration version. Any change misses. Security-related decisions are never cached, and there
 * is no cross-workspace sharing (the workspace is part of the key and entries are per process).
 */
import { contentHash, type DecisionResult } from '@jevris/contracts';

export interface CacheValidity {
  readonly workspaceId: string;
  readonly packetHash: string;
  readonly questionHash: string;
  /** Question ids and Choice criteria in wire order. */
  readonly questionOrderHash: string;
  readonly encoderId: string;
  readonly route: string;
  readonly model: string;
  readonly policyVersion: string;
  readonly calibrationVersion: string | null;
}

export interface CachedDecision {
  readonly result: DecisionResult;
  readonly sourceDecisionId: string;
  readonly storedAtMs: number;
}

export type CacheRefusal = 'SECURITY_DECISION' | 'NOT_CACHEABLE';

export interface DecisionCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function cacheKey(validity: CacheValidity): string {
  return contentHash([
    validity.workspaceId,
    validity.packetHash,
    validity.questionHash,
    validity.questionOrderHash,
    validity.encoderId,
    validity.route,
    validity.model,
    validity.policyVersion,
    validity.calibrationVersion,
  ]);
}

/** Security-related decisions (sensitive risk or a security spec) are never cached. */
export function cacheable(input: { readonly risk?: string | undefined; readonly specId: string; readonly security?: boolean }): boolean {
  if (input.security === true || input.risk === 'sensitive') return false;
  return !/(?:^|[._-])(?:security|secret|permission|auth|egress|credential)(?:[._-]|$)/i.test(input.specId);
}

export class DecisionCache {
  readonly #entries = new Map<string, CachedDecision>();
  readonly #max: number;
  readonly #ttl: number;
  readonly #now: () => number;
  #hits = 0;
  #misses = 0;

  constructor(options: DecisionCacheOptions = {}) {
    this.#max = Math.max(1, options.maxEntries ?? 512);
    this.#ttl = Math.max(1, options.ttlMs ?? 10 * 60 * 1000);
    this.#now = options.now ?? (() => Date.now());
  }

  get(validity: CacheValidity): CachedDecision | null {
    const key = cacheKey(validity);
    const hit = this.#entries.get(key);
    if (hit === undefined || this.#now() - hit.storedAtMs > this.#ttl) {
      if (hit !== undefined) this.#entries.delete(key);
      this.#misses += 1;
      return null;
    }
    // Refresh recency.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    this.#hits += 1;
    return hit;
  }

  set(validity: CacheValidity, result: DecisionResult, sourceDecisionId: string): void {
    const key = cacheKey(validity);
    this.#entries.delete(key);
    this.#entries.set(key, { result, sourceDecisionId, storedAtMs: this.#now() });
    while (this.#entries.size > this.#max) {
      const first = this.#entries.keys().next();
      if (first.done === true) break;
      this.#entries.delete(first.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  stats(): { readonly entries: number; readonly hits: number; readonly misses: number } {
    return { entries: this.#entries.size, hits: this.#hits, misses: this.#misses };
  }
}
