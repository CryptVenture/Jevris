import type { SidecarOpContext } from '@jevris/contracts';
import { NO_STORED_CONSENT, type DecisionEngine, type ProviderConsentReader } from '@jevris/core';

/** The engine the sidecar built, when it looks like one. */
export function engineOf(ctx: Pick<SidecarOpContext, 'engine'>): DecisionEngine | null {
  const engine = ctx.engine as Partial<DecisionEngine> | null | undefined;
  if (engine === null || engine === undefined || typeof engine !== 'object') return null;
  return typeof engine.decide === 'function' && typeof engine.lookup === 'function' ? (engine as DecisionEngine) : null;
}

/**
 * The engine's stored-consent reader (createSidecarEngine's `providerConsent`, B's store). With no
 * reader, every provider falls back to OD-4's signed-in default (NO_STORED_CONSENT); a reader that
 * throws reads as PROVIDER_CONSENT_UNREADABLE in the gate, which blocks.
 */
export function consentReaderOf(ctx: Pick<SidecarOpContext, 'engine'>): ProviderConsentReader {
  const engine = ctx.engine;
  if (engine === null || engine === undefined || typeof engine !== 'object') return NO_STORED_CONSENT;
  try {
    const read: unknown = Reflect.get(engine, 'providerConsent');
    return typeof read === 'function' ? (read as ProviderConsentReader) : NO_STORED_CONSENT;
  } catch {
    return NO_STORED_CONSENT;
  }
}
