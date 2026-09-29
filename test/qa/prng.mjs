/**
 * Seeded generators for the property and state-machine suites (QA-03, QA-04).
 *
 * Every run derives its seed from one base seed: JEVRIS_QA_SEED when set (to replay a failure),
 * otherwise a fresh random one. A failing property names the base seed and the run index, and
 * `JEVRIS_QA_SEED=<seed> node scripts/test.mjs --no-build test/qa/<file>` replays it exactly.
 */
import { randomInt } from 'node:crypto';

export const RUNS = Number.parseInt(process.env.JEVRIS_QA_RUNS ?? '1000', 10);

export function baseSeed() {
  const fixed = process.env.JEVRIS_QA_SEED;
  if (fixed !== undefined && /^\d{1,10}$/.test(fixed)) return Number(fixed) >>> 0;
  return randomInt(0, 2 ** 32 - 1);
}

/** mulberry32: small, fast, and good enough to drive test inputs. */
export function prng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: (items) => items[int(0, items.length - 1)],
    subset: (items, max = items.length) => items.filter(() => next() < max / Math.max(1, items.length)),
    bytes: (n) => Uint8Array.from({ length: n }, () => int(0, 255)),
  };
}

/**
 * Runs `property(rand, run)` for `runs` seeded runs. A thrown error is rethrown with the seed,
 * the run index and the replay command in its message.
 */
export async function forAll(name, property, { runs = RUNS, seed = baseSeed() } = {}) {
  for (let run = 0; run < runs; run += 1) {
    const rand = prng((seed + Math.imul(run, 0x9e3779b1)) >>> 0);
    try {
      await property(rand, run);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`${name}: failed at run ${run} of ${runs}, seed ${seed}. Replay: JEVRIS_QA_SEED=${seed}\n${detail}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }
  return { runs, seed };
}
