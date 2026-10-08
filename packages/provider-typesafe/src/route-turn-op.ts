/**
 * The `route.turn` op (OD-8): the Kilo or OpenCode plugin asks, before a main-session turn's
 * `chat.message`, whether that turn is switched. C's core `routeTurn` answers; the answer is
 * checked against E's RouteTurnPayloadContract (8def761) and F's plugin renders it.
 *
 * The approved scope and the effective `routing.mainSession` are never taken from the request:
 * the sidecar supplies them through `turnContext` (B's state.ts, from D's approvedScopeFor and
 * the effective config). So the op is a factory the sidecar registers with that function; a
 * `scope` or `mainSession` a client sends is refused as an unknown key.
 *
 * Request: `{ harness, sessionId, messageId?, current: { providerID, modelID, variant? }, sliceId?, modelPin? }`.
 * The task slice comes from the sidecar's approved scope only (B's security review, LOW 11): a
 * `sliceId` in the request is accepted for compatibility and ignored, so a plugin cannot choose
 * which learned slice applies.
 */
import { MAIN_SESSION_MODES, RouteTurnPayloadContract, SESSION_LINK_VIA, TURN_HARNESSES, type DecisionRecord, type MainSessionMode, type ModelRegistry, type RouteServing, type RouteTurnPayload, type SessionLinkView, type SidecarOpContext, type SidecarOpDefinition, type SidecarOpOutcome } from '@jevris/contracts';
import { AdviceOnce, BUNDLED_MODEL_REGISTRY, judgeModelTier, readAccessLimits, readModelOffer, readSessionTier, resolveSpelling, seenSpellings, servingView, sessionSignedInParties, sessionSignedInProviders, tierEligibleModels, tierNoteOf, WORKSPACE_REVISIONS, loadLearningState, loadModelAvailability, loadModelRegistryChecked, locallyEligibleFor, routeTurn, unavailableModels, type MainSessionModeValue, type ModelTierDecision, type TierSignals, type TurnHarness, type TurnScope, type TurnTierInput } from '@jevris/core';
import { consentReaderOf, engineOf } from './engine-of.js';

/** What the sidecar knows about the turn that the plugin must not assert. */
export interface TurnContext {
  /** D's approved scope for the session (with the turn gate), or null when none maps to it. */
  readonly scope: TurnScope | null;
  /** The effective `routing.mainSession`; null when it could not be read (advice only). */
  readonly mainSession: MainSessionModeValue | null;
  /**
   * Access limits R73 (fixes A14): the session's sign-in, from the sidecar's own records, never the
   * request. Absent or null: unknown, which matches a limit recorded under either sign-in.
   */
  readonly authMode?: 'api-key' | 'subscription' | null;
  /**
   * Serving hosts R50 (B's 76c5d764): the harness's `route.host` certification for the recorded
   * session's version, from the sidecar's own records. Absent or anything but true: not certified.
   */
  readonly hostRouteCertified?: boolean;
}

/**
 * Step 2b (tiered routing): what the sidecar knows about the linked task for a tier-driven turn: its content-free signals and the
 * gate for a step UP (D's turn gate without the low-risk condition). It is asked for only when no learned slice named a model.
 */
export interface TurnTierContext extends TurnContext {
  readonly tierSignals?: object;
}

const KEYS = new Set(['harness', 'sessionId', 'messageId', 'current', 'sliceId', 'modelPin']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TURN_MODEL_ID = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
const HARNESS_MODEL = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/){0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?::[0-9]{1,8})?$/;
const VARIANT = /^[a-z][a-z0-9-]{0,31}$/;

interface TurnRequest {
  readonly harness: TurnHarness;
  readonly sessionId: string;
  readonly messageId: string | null;
  readonly current: { readonly providerID: string; readonly modelID: string; readonly variant: string | null };
  readonly sliceId: string | null;
  readonly modelPin: string | null;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Parses the request; null when anything is malformed or unknown. */
export function turnRequest(body: unknown): TurnRequest | null {
  if (!plain(body) || Object.keys(body).some((k) => !KEYS.has(k))) return null;
  const harness = body['harness'];
  if (typeof harness !== 'string' || !(TURN_HARNESSES as readonly string[]).includes(harness)) return null;
  const sessionId = body['sessionId'];
  if (typeof sessionId !== 'string' || !ID.test(sessionId)) return null;
  const messageId = body['messageId'];
  if (messageId !== undefined && messageId !== null && (typeof messageId !== 'string' || !ID.test(messageId))) return null;
  const current = body['current'];
  if (!plain(current) || Object.keys(current).some((k) => k !== 'providerID' && k !== 'modelID' && k !== 'variant')) return null;
  const providerID = current['providerID'];
  const modelID = current['modelID'];
  const variant = current['variant'] ?? null;
  if (typeof providerID !== 'string' || !PROVIDER_ID.test(providerID) || typeof modelID !== 'string' || !TURN_MODEL_ID.test(modelID)) return null;
  if (variant !== null && (typeof variant !== 'string' || !VARIANT.test(variant))) return null;
  const sliceId = body['sliceId'] ?? null;
  if (sliceId !== null && (typeof sliceId !== 'string' || !ID.test(sliceId))) return null;
  const modelPin = body['modelPin'] ?? null;
  if (modelPin !== null && (typeof modelPin !== 'string' || !HARNESS_MODEL.test(modelPin))) return null;
  return { harness: harness as TurnHarness, sessionId, messageId: typeof messageId === 'string' ? messageId : null, current: { providerID, modelID, variant }, sliceId, modelPin };
}

function nowOf(ctx: Pick<SidecarOpContext, 'engine'>): number {
  const engine = ctx.engine;
  if (engine !== null && typeof engine === 'object') {
    try {
      const now: unknown = Reflect.get(engine, 'now');
      if (typeof now === 'function') {
        const value: unknown = now.call(engine);
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
    } catch {
      // The real clock.
    }
  }
  return Date.now();
}

/**
 * The `route.turn` op. `turnContext` is the sidecar's: the approved scope for the session and the
 * effective main-session mode. It must not throw; if it does, the turn is advice only.
 */
export function createRouteTurnOp(
  turnContext: (ctx: SidecarOpContext, sessionId: string, harness: TurnHarness) => Promise<TurnContext> | TurnContext,
  turnTier?: (ctx: SidecarOpContext, sessionId: string, harness: TurnHarness) => Promise<TurnTierContext> | TurnTierContext,
): SidecarOpDefinition {
  return {
    op: 'route.turn',
    scope: 'advice',
    budget: 'hot',
    async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
      const request = turnRequest(ctx.body);
      if (request === null) return { ok: false, reasonCode: 'INVALID_REQUEST', message: 'send { harness: kilocode|opencode, sessionId, current: { providerID, modelID, variant? }, messageId?, sliceId?, modelPin? }' };
      let context: TurnContext;
      try {
        context = await turnContext(ctx, request.sessionId, request.harness);
      } catch {
        context = { scope: null, mainSession: null };
      }
      const loaded = await loadModelRegistryChecked({ home: ctx.home }).catch(() => ({ registry: null, reasonCode: 'MODEL_REGISTRY_UNREADABLE' as const }));
      const learning = loaded.registry === null ? null : await loadLearningState({ home: ctx.home, workspaceId: ctx.workspace.id }).catch(() => null);
      const consent = consentReaderOf(ctx);
      // 8c1f85d: another provider's model is written only through a host seen on this harness.
      const registry = loaded.registry;
      const authMode = context.authMode === 'api-key' || context.authMode === 'subscription' ? context.authMode : null;
      const locallyEligible =
        registry === null
          ? null
          : await locallyEligibleFor({
              home: ctx.home,
              registry,
              accountId: null,
              unavailable: unavailableModels(await loadModelAvailability(ctx.home, registry).catch(() => []), { harness: request.harness, authMode }),
              scope: { harness: request.harness, authMode },
            }).catch(() => null);
      const seen = await seenOn(ctx.home, request.harness, authMode);
      const turnInput = loaded.registry === null
        ? null
        : {
            harness: request.harness,
            current: request.current,
            registry: loaded.registry ?? BUNDLED_MODEL_REGISTRY,
            learning,
            sliceId: context.scope?.sliceId ?? null,
            scope: context.scope,
            mainSession: context.mainSession,
            killSwitchStopped: ctx.killSwitchStopped,
            modelPin: request.modelPin,
            nowMs: nowOf(ctx),
            providerConsent: consent,
            locallyEligible,
            // A missing or unreadable record gives none (fail-open, design 4.3).
            accessLimits: registry === null ? [] : (await readAccessLimits(ctx.home).catch(() => ({ entries: [] }))).entries,
            authMode,
            // R50: the spellings each model was seen with on this harness (listings and runs), so a
            // route keeps the session's host or takes the one other host seen; none when unreadable.
            seen,
            hostRouteCertified: context.hostRouteCertified === true,
          };
      let payload =
        loaded.registry === null || turnInput === null
          ? {
              harness: request.harness,
              mainSession: { mode: context.mainSession ?? 'advice-only', switched: false },
              outcome: 'abstain' as const,
              actuate: false,
              reasonCode: loaded.registry === null ? loaded.reasonCode : 'MODEL_REGISTRY_UNREADABLE',
              text: `The model registry file was refused (${loaded.registry === null ? loaded.reasonCode : 'MODEL_REGISTRY_UNREADABLE'}), so Jevris does not route this turn.`,
            }
          : routeTurn(turnInput);
      // Owner decision 2026-10-08 (step 2b; against OD-8): when no learned slice names a model, the shared tier of the linked
      // task's work may (rules first; no Jev call on the turn; Jev's pick of a recent `jevris route` counts only as a dearer rung).
      let tierCodes: readonly string[] = [];
      if (turnInput !== null && turnTier !== undefined && payload.outcome === 'abstain' && (payload.reasonCode === 'NO_PROMOTED_SLICE' || payload.reasonCode === 'UNKNOWN_SLICE') && context.scope !== null) {
        const picked = await tierForTurn(ctx, request, turnTier, turnInput.registry, authMode, nowOf(ctx)).catch(() => null);
        if (picked !== null) {
          const tiered = routeTurn({ ...turnInput, tier: picked.input });
          if (tiered.outcome === 'switch') {
            payload = tiered;
            tierCodes = picked.codes;
          }
        }
      }
      const checked = RouteTurnPayloadContract.validate(payload);
      if (!checked.ok) {
        ctx.trace({ event: 'decision.payload-invalid', reasonCode: 'PAYLOAD_INVALID', op: ctx.op, path: checked.issues[0]?.path ?? '' });
        return { ok: false, reasonCode: 'PAYLOAD_INVALID', message: 'the route.turn result did not match its contract' };
      }
      ctx.trace({ event: 'route.turn', reasonCode: checked.value.reasonCode, harness: request.harness, actuate: checked.value.actuate });
      // R55: the hosts as this turn saw them, kept for explain with the recorded decision.
      const serving = registry === null ? null : turnServing(registry, request, checked.value, seen, consent);
      await recordTurn(ctx, request, checked.value, context.scope, serving, tierCodes);
      return { ok: true, body: checked.value };
    },
  };
}

const TIER_WAIT_MS = 100;

/**
 * Step 2b: the tier of the linked task's work for a turn that no learned slice covers. Rules only (no engine, so no Jev call and
 * nothing recorded here: the turn's own record carries the codes). The baseline is the session's own model on its own provider; the
 * rungs are the models the router's gates leave eligible here, so a harness with no local evidence of them stays dormant. A fresh
 * session tier memo whose Jev pick is a dearer rung than the rules' on the same baseline raises the tier to that rung; it
 * never lowers one. Null: no tier (no signals, no ladder, baseline).
 */
async function tierForTurn(
  ctx: SidecarOpContext,
  request: TurnRequest,
  turnTier: NonNullable<Parameters<typeof createRouteTurnOp>[1]>,
  registry: ModelRegistry,
  authMode: 'api-key' | 'subscription' | null,
  nowMs: number,
): Promise<{ readonly input: TurnTierInput; readonly codes: readonly string[] } | null> {
  const answer = await turnTier(ctx, request.sessionId, request.harness);
  if (answer.tierSignals === undefined || answer.scope === null) return null;
  const sessionSpelling = `${request.current.providerID}/${request.current.modelID}`; // path-hygiene: allow a harness model id (provider/model), not a path
  const current = resolveSpelling(registry, request.harness, sessionSpelling);
  if (current === null) return null;
  const eligible = await tierEligibleModels({
    role: 'main',
    home: ctx.home,
    registry,
    trustedKeys: new Map(),
    killSwitchStopped: ctx.killSwitchStopped,
    sliceId: null,
    currentModel: current.modelId,
    pins: { modelPin: null, effortPin: null },
    nowMs,
    harness: request.harness,
    authMode,
    providerConsent: consentReaderOf(ctx),
    signedInProviders: sessionSignedInProviders(registry, request.harness, sessionSpelling),
  });
  if (eligible === null) return null;
  const rules = await judgeModelTier(
    null,
    { signals: answer.tierSignals as TierSignals, eligible: eligible.eligible, baselineModelId: current.modelId, volume: eligible.settings.defaultTaskVolume },
    { workspaceId: ctx.workspace.id, evidenceRevision: WORKSPACE_REVISIONS.current(ctx.workspace.id), deadlineMs: TIER_WAIT_MS },
    { assist: 'off', record: false },
  );
  let decision: ModelTierDecision = rules;
  const memo = readSessionTier(ctx.workspace.id, request.sessionId, nowMs, request.harness);
  if (memo !== null && memo.basis === 'tier-jev' && memo.baselineModelId === current.modelId && memo.tier !== 'baseline') {
    const at = (id: string): number => rules.candidates.indexOf(id);
    if (at(memo.targetModelId) > at(rules.targetModelId) && at(rules.targetModelId) >= 0) {
      decision = { ...rules, tier: 'step-up', targetModelId: memo.targetModelId, basis: 'tier-jev', label: "Jev's suggestion from structured features; not a learned route, not a signed prior", reasonCodes: [...rules.reasonCodes, 'TIER_JEV_MEMO'] };
    }
  }
  if (decision.tier === 'baseline' || decision.targetModelId === current.modelId) return null;
  const note = tierNoteOf(decision);
  const scope = answer.scope;
  const stepUpGate = scope.turnActuation === 'bounded-auto' && scope.turnReasonCode === null ? null : (scope.turnReasonCode ?? 'TURN_GATE_ADVISE');
  return {
    input: { tier: note.tier, targetModelId: note.targetModelId, basis: note.basis, label: note.label, reasonCodes: note.reasonCodes, stepUpGate },
    codes: [`TIER_SOURCE_${note.basis === 'tier-jev' ? 'JEV' : 'RULE'}`, `TIER_LEVEL_${note.tier.toUpperCase().replace(/-/g, '_')}`, ...note.reasonCodes],
  };
}

/** The model offer's seen spellings for this harness and sign-in; nothing seen when it cannot be read. */
async function seenOn(home: string, harness: TurnHarness, authMode: 'api-key' | 'subscription' | null): Promise<(modelId: string) => ReturnType<typeof seenSpellings>> {
  const offer = await readModelOffer(home).catch(() => null);
  return (modelId) => seenSpellings(offer, { harness, authMode }, modelId);
}

/** Reason codes of a switch left as advice because of its host (R50); shown as the view's host reason. */
const HOST_ADVICE_CODES: ReadonlySet<string> = new Set(['ROUTE_HOST_NOT_CERTIFIED', 'HOST_TARIFF_UNKNOWN']);

/**
 * Serving hosts R55: the serving view of a turn that named a model (switched or advice): the
 * session's spelling and host, the written spelling and its host, kept or changed, and the host
 * reason when the host is why it was advice only. Null for any other answer.
 */
function turnServing(registry: ModelRegistry, request: TurnRequest, payload: RouteTurnPayload, seen: (modelId: string) => ReturnType<typeof seenSpellings>, read: ReturnType<typeof consentReaderOf>): RouteServing | null {
  if (payload.outcome !== 'switch' || payload.model === undefined) return null;
  const sessionSpelling = `${request.current.providerID}/${request.current.modelID}`; // path-hygiene: allow a harness model id (provider/model), not a path
  const targetSpelling = `${payload.model.providerID}/${payload.model.modelID}`; // path-hygiene: allow a harness model id (provider/model), not a path
  const session = resolveSpelling(registry, request.harness, sessionSpelling);
  const target = resolveSpelling(registry, request.harness, targetSpelling);
  if (session === null || target === null) return null;
  try {
    return servingView({
      registry,
      harness: request.harness,
      sessionSpelling,
      targetSpelling,
      hostDecision: session.servingHost === target.servingHost ? 'kept' : 'changed',
      hostReasonCode: !payload.actuate && HOST_ADVICE_CODES.has(payload.reasonCode) ? payload.reasonCode : null,
      seen: seen(target.modelId),
      ...(read === undefined ? {} : { read }),
      signedIn: sessionSignedInParties(registry, request.harness, sessionSpelling, null),
    });
  } catch {
    return null;
  }
}

/** R55: serving views of recorded turn decisions, by decision id, for explain; bounded, this process only. */
const turnViews = new Map<string, RouteServing>();
const TURN_VIEWS_MAX = 256;

/** The serving view recorded with a main-session turn decision; undefined when there is none (another decision, or a restart since). */
export function turnServingOf(record: DecisionRecord | null): RouteServing | undefined {
  return record === null || !isTurnRecord(record) ? undefined : turnViews.get(record.decisionId);
}

/** The spec id of a main-session turn decision; explain reads its trace from these records. */
export const ROUTE_TURN_SPEC = 'route-turn';

const HARNESS_CODE: Readonly<Record<TurnHarness, string>> = { kilocode: 'TURN_HARNESS_KILOCODE', opencode: 'TURN_HARNESS_OPENCODE' };
const MODE_CODE: Readonly<Record<MainSessionMode, string>> = {
  'advice-only': 'TURN_MODE_ADVICE_ONLY',
  'plugin-bounded-auto': 'TURN_MODE_PLUGIN_BOUNDED_AUTO',
  'owned-sdk-approved': 'TURN_MODE_OWNED_SDK_APPROVED',
};
type LinkVia = (typeof SESSION_LINK_VIA)[number];
const LINK_CODE: Readonly<Record<LinkVia, string>> = { route: 'TURN_LINK_ROUTE', plan: 'TURN_LINK_PLAN', handoff: 'TURN_LINK_HANDOFF' };
const UNLINKED = 'TURN_UNLINKED';
const SWITCHED = 'TURN_SWITCHED';
const ADVICE = 'TURN_ADVICE';

/** Turn decisions already recorded, per workspace, harness, session and message. */
const turnRecorded = new AdviceOnce();

interface StoreLink {
  readonly sessionId: string;
  readonly harness: string;
  readonly taskId: string;
  readonly linkedAtMs: number;
  readonly via: LinkVia;
}

/**
 * The session's live link in B's store: the link; null when the store has the session and no live
 * link for it; undefined when there is no store, it could not be read, or it does not know the
 * session (then nothing is claimed either way, since B's reader answers undefined for all three).
 */
async function storeLinkOf(store: unknown, sessionId: string): Promise<StoreLink | null | undefined> {
  if (store === undefined || store === null) return undefined;
  try {
    const { getSession, sessionLinkFor } = await import('@jevris/store');
    const link = sessionLinkFor(store, sessionId);
    if (link === undefined) return getSession(store, sessionId) === undefined ? undefined : null;
    return (SESSION_LINK_VIA as readonly string[]).includes(link.via) ? { sessionId: link.sessionId, harness: link.harness, taskId: link.taskId, linkedAtMs: link.linkedAtMs, via: link.via as LinkVia } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OD-8, for explain: a turn that named a model (`outcome: 'switch'`, actuated or advice) is recorded
 * once per (session, message) as advice with no provider call. The reason codes carry the harness,
 * the mode, whether the session was linked (and how) and whether the turn was switched, so the
 * decision record needs no new field (agreed with E). A turn that abstained records nothing.
 * Without a message id, the switch target stands in for it, so one session records each target once.
 */
async function recordTurn(ctx: SidecarOpContext, request: TurnRequest, payload: RouteTurnPayload, scope: TurnScope | null, serving: RouteServing | null = null, extraCodes: readonly string[] = []): Promise<void> {
  if (payload.outcome !== 'switch' || payload.model === undefined) return;
  const engine = engineOf(ctx);
  if (engine?.recordAdvice === undefined) return;
  const turn = request.messageId ?? `${payload.model.providerID}/${payload.model.modelID}`; // path-hygiene: allow a harness model id (provider/model), not a path
  if (!turnRecorded.first(`${ctx.workspace.id}:${request.harness}:${request.sessionId}:${turn}`)) return;
  const link = await storeLinkOf(ctx.store, request.sessionId);
  const linkCode = link === undefined ? [] : [link === null ? UNLINKED : LINK_CODE[link.via]];
  const codes = [payload.reasonCode, HARNESS_CODE[payload.harness], MODE_CODE[payload.mainSession.mode], ...linkCode, payload.actuate ? SWITCHED : ADVICE, ...extraCodes.filter((c) => /^[A-Z][A-Z0-9_]{0,63}$/.test(c)).slice(0, 12)];
  try {
    const recorded = await engine.recordAdvice({
      specId: ROUTE_TURN_SPEC,
      workspaceId: ctx.workspace.id,
      evidenceRevision: WORKSPACE_REVISIONS.current(ctx.workspace.id),
      taskId: scope?.taskId ?? (link === null || link === undefined ? null : link.taskId),
      sessionId: request.sessionId,
      action: { kind: 'advise', templateId: ROUTE_TURN_SPEC, evidenceIds: [] },
      reasonCodes: [...new Set(codes)],
    });
    ctx.trace({ event: 'route.turn.recorded', reasonCode: recorded.ok ? 'RECORDED' : recorded.reasonCode, harness: request.harness });
    if (recorded.ok && serving !== null) {
      if (turnViews.size >= TURN_VIEWS_MAX) turnViews.delete(turnViews.keys().next().value as string);
      turnViews.set(recorded.decisionId, serving);
    }
  } catch {
    ctx.trace({ event: 'route.turn.recorded', reasonCode: 'JOURNAL_UNAVAILABLE', harness: request.harness });
  }
}

function isTurnRecord(record: DecisionRecord): boolean {
  return record.specId === ROUTE_TURN_SPEC && record.reasonCodes.some((code) => code === SWITCHED || code === ADVICE);
}

/**
 * explain's `trace.sessionLink` for a turn decision: the session's link to its task when the turn
 * was decided. Null when the record says the session was not linked. The link itself is read from
 * B's store and shown only while it is the same link (same way made, same task, made no later than
 * the decision); if it has since ended or changed, or the record predates link codes, the field is
 * absent rather than guessed. Absent for any decision that is not a main-session turn.
 */
export async function turnSessionLinkOf(store: unknown, record: DecisionRecord | null): Promise<SessionLinkView | null | undefined> {
  if (record === null || !isTurnRecord(record)) return undefined;
  if (record.reasonCodes.includes(UNLINKED)) return null;
  const via = (Object.keys(LINK_CODE) as LinkVia[]).find((v) => record.reasonCodes.includes(LINK_CODE[v]));
  if (via === undefined || record.sessionId === undefined) return undefined;
  const live = await storeLinkOf(store, record.sessionId);
  if (live === null || live === undefined || live.via !== via || !(TURN_HARNESSES as readonly string[]).includes(live.harness)) return undefined;
  if (record.taskId !== undefined && live.taskId !== record.taskId) return undefined;
  const decidedAt = Date.parse(record.timestamps?.receivedAt ?? '');
  if (!Number.isFinite(decidedAt) || live.linkedAtMs > decidedAt) return undefined;
  return { harness: live.harness as TurnHarness, sessionId: live.sessionId, taskId: live.taskId, linkedAtMs: live.linkedAtMs, via: live.via };
}

/** The main-session trace a turn record carries (E's `trace.mainSession`), or null for any other decision. */
export interface TurnMainSession {
  readonly harness: TurnHarness;
  readonly mode: MainSessionMode;
  readonly switched: boolean;
  /** The gate's reason when the turn was advice only; null when it was switched. */
  readonly reasonCode: string | null;
}

export function turnMainSessionOf(record: DecisionRecord | null): TurnMainSession | null {
  if (record === null || !isTurnRecord(record)) return null;
  const harness = (TURN_HARNESSES as readonly TurnHarness[]).find((h) => record.reasonCodes.includes(HARNESS_CODE[h]));
  const mode = (MAIN_SESSION_MODES as readonly MainSessionMode[]).find((m) => record.reasonCodes.includes(MODE_CODE[m]));
  if (harness === undefined || mode === undefined) return null;
  const switched = record.reasonCodes.includes(SWITCHED);
  const reason = record.reasonCodes[0];
  return { harness, mode, switched, reasonCode: switched || reason === undefined ? null : reason };
}
