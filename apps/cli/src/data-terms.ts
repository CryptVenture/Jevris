/**
 * The data line for each provider and sign-in (owner decision 7be3c43; SPEC 8.1 registry review
 * §5 item 2): what a provider does with what it receives, per sign-in, from the registry's
 * `dataGovernance.bySignIn` (C's facts, reason codes only). E owns the wording; the facts stay in
 * the registry, so a refresh changes them without a code change. A reason code without wording
 * here is described from the row's own fields.
 */
import { consentText, type HarnessId, type ModelRegistry, type RoutingModel, type SurfacePayloads, type SurfaceResult } from '@jevris/contracts';
import { harnessModelRef, resolveSpelling, type ResolvedSpelling } from '@jevris/core';

type SignInTerms = NonNullable<NonNullable<RoutingModel['dataGovernance']>['bySignIn']>[number];

const SIGN_IN_TEXT: { readonly [signIn: string]: string } = {
  'api-key': 'API key',
  subscription: 'subscription sign-in',
  workspace: 'workspace sign-in',
  unpaid: 'unpaid key',
};

const LOCATION_TEXT: { readonly [code: string]: string } = {
  cn: "the People's Republic of China",
  sg: 'Singapore',
  us: 'the United States',
  eu: 'the EU',
  global: 'any region the provider uses',
};

const REASON_TEXT: { readonly [code: string]: string } = {
  API_NO_TRAINING: 'not used for training',
  WORKSPACE_SETTINGS_APPLY: 'your account or workspace settings decide training and retention',
  PAID_TIER_NO_TRAINING: 'paid tier: not used for training; logged for a limited time to detect abuse',
  UNPAID_TIER_TRAINS_OUTSIDE_EEA_CH_UK: 'used for training outside the EEA, Switzerland and the UK, and people may read it; Jevris cannot tell a paid key from an unpaid one',
  ANTIGRAVITY_COLLECTION_ON_BY_DEFAULT: 'data collection is on until you turn it off in Antigravity settings',
  NO_CONTENT_STORED: 'not stored',
  TRAINS_ON_CONTENT: 'may be used to improve its models',
  TRAINS_BY_DEFAULT_OPT_OUT: 'used for training by default; you can opt out in your account',
};

function fromFields(row: SignInTerms): string {
  return row.trainsOnContent === true ? 'may be used for training' : row.trainsOnContent === false ? 'not used for training' : 'terms not established';
}

/** One sign-in's terms, e.g. `API key: not used for training, kept 30 days`. */
export function signInTermsText(row: SignInTerms): string {
  const parts = [REASON_TEXT[row.reasonCode] ?? fromFields(row)];
  if (typeof row.retentionDays === 'number' && row.retentionDays > 0) parts.push(`kept ${String(row.retentionDays)} days`);
  if (typeof row.location === 'string') parts.push(`stored in ${LOCATION_TEXT[row.location] ?? row.location}`);
  return `${SIGN_IN_TEXT[row.signIn] ?? row.signIn}: ${parts.join(', ')}`;
}

/** Each provider's terms per sign-in, the first row per sign-in across its entries. */
export function providerDataTerms(models: readonly RoutingModel[]): ReadonlyMap<string, readonly SignInTerms[]> {
  const out = new Map<string, SignInTerms[]>();
  for (const model of models) {
    const rows = model.dataGovernance?.bySignIn ?? [];
    if (rows.length === 0) continue;
    const list = out.get(model.provider) ?? [];
    for (const row of rows) if (!list.some((r) => r.signIn === row.signIn)) list.push(row);
    out.set(model.provider, list);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Doctor's `dataTerms <provider>:` lines, one per provider with terms in the registry. */
export function dataTermsDoctorLines(models: readonly RoutingModel[]): string[] {
  return [...providerDataTerms(models)].map(([provider, rows]) => `dataTerms ${provider}: ${rows.map(signInTermsText).join('; ')}`);
}

/**
 * The data line for one model under a sign-in, e.g. `data terms (openai): API key: not used for
 * training, kept 30 days`. The model is resolved through the loaded registry (a harness model id
 * resolves too). With a known auth mode only that sign-in's row shows (a subscription also shows
 * the workspace row, which Jevris cannot tell apart); with none, every row does. Null when the
 * registry has no terms for it: nothing is guessed (C).
 */
export function modelDataTermsLine(registry: ModelRegistry | null, rawModel: string | null, authMode: string | null, harness: HarnessId | null = null): string | null {
  // A registry port may hand back something that is not a registry (a test double): no line.
  if (registry === null || rawModel === null || !Array.isArray(Reflect.get(registry, 'entries'))) return null;
  const served = servedSpelling(registry, rawModel, harness);
  // Only a registered model has terms: a gateway or third-party id keeps its bare segment for
  // display, and that segment must not pick the maker's terms (serving hosts, owner 8c1f85d). A
  // spelling the harness's resolver reads as a pinned host's serving names its maker's entry.
  const ref = served === null ? harnessModelRef(registry, rawModel) : null;
  const entry =
    served !== null
      ? registry.entries.find((e) => e.modelId === served.modelId && e.provider === served.provider)
      : ref?.registered === true
        ? registry.entries.find((e) => e.modelId === ref.modelId)
        : undefined;
  const rows = entry?.dataGovernance?.bySignIn ?? [];
  const wanted = authMode === 'api-key' ? ['api-key'] : authMode === 'subscription' ? ['subscription', 'workspace'] : null;
  const shown = wanted === null ? rows : rows.filter((row) => wanted.includes(row.signIn));
  if (entry === undefined || shown.length === 0) return null;
  const via = served?.via === 'host' ? `, served by ${served.servingHost}` : '';
  return `data terms (${entry.provider}${via}): ${shown.map(signInTermsText).join('; ')}`;
}

/** The harness spelling through serving-hosts' one resolver (R39); null without a harness or a match. */
function servedSpelling(registry: ModelRegistry, rawModel: string, harness: HarnessId | null): ResolvedSpelling | null {
  if (harness === null) return null;
  try {
    return resolveSpelling(registry, harness, rawModel);
  } catch {
    return null;
  }
}

/**
 * Serving hosts R55 (design 8): for a spelling that goes through a pinned serving host, the host's
 * own data line from its pinned consent text, beside the maker's. Null for a maker's own API or a
 * spelling that does not resolve.
 */
export function hostDataTermsLine(registry: ModelRegistry | null, rawModel: string | null, harness: HarnessId | null): string | null {
  if (registry === null || rawModel === null || harness === null || !Array.isArray(Reflect.get(registry, 'entries'))) return null;
  const served = servedSpelling(registry, rawModel, harness);
  if (served === null || served.via !== 'host') return null;
  const text = consentText(served.servingHost);
  return text === undefined
    ? `data terms (${served.servingHost}, the serving host): Jevris has no consent text for it, so it never routes there`
    : `data terms (${served.servingHost}, the serving host): ${text.training}`;
}

/** The data line for an explain or route result, from the model it names; null otherwise. */
export function resultDataTermsLine(result: SurfaceResult, registry: ModelRegistry | null): string | null {
  if (result.command === 'route') {
    const p = result.result as SurfacePayloads['route'];
    // R55: the harness's own spelling when the answer carries it (a host route is not a bare id).
    const raw = p.main.serving?.targetSpelling ?? p.main.serving?.spelling ?? p.main.recommendedModel ?? p.main.currentModel;
    const harness = p.main.harness ?? null;
    return joinLines([hostDataTermsLine(registry, raw, harness), modelDataTermsLine(registry, raw, p.main.authMode ?? null, harness)]);
  }
  if (result.command === 'explain') {
    const p = result.result as SurfacePayloads['explain'];
    const models = p.trace?.models;
    const raw = p.trace?.serving?.targetSpelling ?? p.trace?.serving?.spelling ?? models?.observed ?? models?.requested ?? null;
    const harness = p.trace?.mainSession?.harness ?? null;
    return joinLines([hostDataTermsLine(registry, raw, harness), modelDataTermsLine(registry, raw, null, harness)]);
  }
  return null;
}

function joinLines(lines: readonly (string | null)[]): string | null {
  const kept = lines.filter((l): l is string => l !== null);
  return kept.length === 0 ? null : kept.join('\n');
}
