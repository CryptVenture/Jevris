/**
 * The models eligible for a session on its own harness and sign-in, and the baseline they are judged against (owner decisions
 * 2026-10-08, tiered routing). One place for the subagent hook and the main-session line, so both read the same ladder: the
 * router's own gates (consent, lifecycle, harness access, local evidence or Claude Code's alias proof, access-limit pauses, the
 * routing policy) have already run on every model returned. Reads no task text and makes no Jev call.
 */
import type { ModelRegistry, RoutingModel } from '@jevris/contracts';
import { providerConsentGate, sessionBaseline, sessionModelRegistryId, sessionSignedInProviders, tierEligibleModels, type TokenVolume } from '@jevris/core';
import { consentReaderOf } from './engine-of.js';
import { ROUTE_FEATURE, type TriggerHandlerInput } from './sidecar-subscribers.js';

export interface SessionEligible {
  /** The session model's registry id, or the harness's own default when the session's model is unknown or unregistered. */
  readonly baselineModelId: string;
  readonly eligible: readonly RoutingModel[];
  readonly volume: TokenVolume;
}

export interface SessionEligibleUse {
  readonly nowMs: number;
  readonly authMode: 'api-key' | 'subscription' | null;
  readonly consentedProviders: readonly string[];
  readonly aliasCertified: boolean;
  /** The installed Claude Code version (null when unknown): a family alias counts as eligible only from the version it means the model. */
  readonly harnessVersion: string | null;
}

/** What the sign-in and consent gates need of one event: the consented providers for the session's model. */
export function sessionConsent(input: TriggerHandlerInput, registry: ModelRegistry, sessionModel: string | null): readonly string[] {
  return providerConsentGate(registry, sessionSignedInProviders(registry, input.event.harness, sessionModel), consentReaderOf(input.ctx)).consentedProviders;
}

/**
 * The eligible models and the baseline for the session. Null when the session has no baseline (a Kilo or OpenCode session whose
 * model Jevris does not know; never Claude's) or nothing can be judged. Never throws.
 */
export async function sessionEligible(
  input: TriggerHandlerInput,
  registry: ModelRegistry,
  sessionModel: string | null,
  use: SessionEligibleUse,
): Promise<SessionEligible | null> {
  try {
    const harness = input.event.harness;
    const resolved = sessionModelRegistryId(registry, harness, sessionModel, use.nowMs);
    const baseline = sessionBaseline(registry, harness, resolved);
    if (baseline === null) return null;
    const eligible = await tierEligibleModels(
      {
        role: 'main',
        home: input.ctx.home,
        registry,
        trustedKeys: new Map(),
        killSwitchStopped: input.ctx.killSwitchStopped === true,
        sliceId: null,
        currentModel: baseline,
        pins: { modelPin: null, effortPin: null },
        nowMs: use.nowMs,
        harness,
        authMode: use.authMode,
        consentedProviders: use.consentedProviders,
      },
      harness === 'claude' ? { certified: use.aliasCertified, nowMs: use.nowMs, harnessVersion: use.harnessVersion } : undefined,
    );
    if (eligible === null) return null;
    return { baselineModelId: baseline, eligible: eligible.eligible, volume: eligible.settings.defaultTaskVolume };
  } catch {
    return null;
  }
}

/** Whether hooks.route is certified for Claude Code's family-alias proof (HARNESS_ALIAS); false elsewhere and on any failure. */
export async function aliasCertifiedFor(input: TriggerHandlerInput): Promise<boolean> {
  return input.event.harness === 'claude' && input.certified !== undefined ? await input.certified(ROUTE_FEATURE).catch(() => false) : false;
}
