import { createRequire } from 'node:module';

/**
 * Native addon probe (BLD-13). better-sqlite3 is the only store driver; node:sqlite is not
 * a silent fallback (E-31). A failed load gives one plain diagnostic line, never a stack,
 * and the caller continues rules-only. The keyring binding is probed only by its one
 * owner module (apps/cli credential.ts), which keeps it away from test processes.
 */

export interface NativeAddonSpec {
  readonly name: string;
  /** What the product does without the addon, in one sentence. */
  readonly effect: string;
  /** Proves the binding, not only the JS wrapper, loads. Throws on failure. */
  readonly verify?: (loaded: unknown) => void;
}

export type NativeProbe =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly name: string; readonly code: string; readonly diagnostic: string };

export const BETTER_SQLITE3: NativeAddonSpec = {
  name: 'better-sqlite3',
  effect: 'Jevris continues rules-only: the ledger and store are off.',
  verify: (loaded) => {
    // The JS wrapper loads the .node binding lazily; opening an in-memory db proves it.
    if (typeof loaded !== 'function') throw Object.assign(new Error('addon'), { code: 'ERR_ADDON_SHAPE' });
    const Ctor = loaded as new (file: string) => { close(): void };
    new Ctor(':memory:').close();
  },
};

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return 'LOAD_FAILED';
}

export function nativeDiagnostic(spec: NativeAddonSpec, code: string): string {
  return `jevris: the native module ${spec.name} could not be loaded (${code}). ${spec.effect} Run "jevris doctor" for details; reinstalling on a supported Node (^22.14.0 || >=23.6.0) usually fixes it.`;
}

export interface ProbeOptions {
  /** Resolve from this module URL (default: this package). */
  readonly from?: string;
  /** Injected loader for tests. */
  readonly load?: (name: string) => unknown;
}

export function probeNativeAddon(spec: NativeAddonSpec, options: ProbeOptions = {}): NativeProbe {
  const load = options.load ?? createRequire(options.from ?? import.meta.url);
  try {
    const loaded = load(spec.name);
    if (spec.verify !== undefined) spec.verify(loaded);
    return { ok: true, name: spec.name };
  } catch (error) {
    const code = codeOf(error);
    return { ok: false, name: spec.name, code, diagnostic: nativeDiagnostic(spec, code) };
  }
}
