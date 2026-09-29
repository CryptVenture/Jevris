/**
 * SSOT §4.2 "Off: no Jev calls, no optimization actuation, and no invisible background network
 * activity" (owner decision 0eb319de, coordinator follow-up). Under off, the ops in
 * MODE_OFF_REFUSED_OPS are refused before they run, and every other op sees this engine: its reads
 * (lookup, entry, the clock, the circuit view) work, and anything that would call Jev, record a
 * decision or start a worker answers MODE_OFF instead.
 */
import { MODE_OFF_REASON } from '@jevris/contracts';

const REFUSED: { readonly [method: string]: () => unknown } = {
  decide: () => ({ abstained: true, reasonCode: MODE_OFF_REASON, fallback: null }),
  recordAdvice: () => ({ ok: false, reasonCode: MODE_OFF_REASON }),
  probeProvider: () => ({ probed: false, state: null, reasonCode: MODE_OFF_REASON }),
  routeManagedWorker: () => ({ launched: false, reasonCode: MODE_OFF_REASON, selection: null, decisionId: null }),
};

/** The engine an op sees while the mode is off. */
export function engineWhenOff(engine: unknown): unknown {
  if (engine === null || typeof engine !== 'object') return engine;
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(REFUSED, property)) {
        const refuse = REFUSED[property] as () => unknown;
        return typeof Reflect.get(target, property, receiver) === 'function' ? async () => refuse() : undefined;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
