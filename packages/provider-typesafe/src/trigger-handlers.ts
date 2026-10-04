/**
 * Trigger handlers the decision subscriber runs (C01..C16 capability paths). Each handler turns
 * one trigger into at most one hook proposal, through `decide()` on the sidecar's engine or a
 * deterministic core function.
 */
import {
  AdviceOnce,
  adviseMainRoute,
  adviseSubagentRoute,
  evaluateRoute,
  loadLearningState,
  loadModelAvailability,
  readAccessLimits,
  readModelOffer,
  seenSpellings,
  noteSubagentRoute,
  subagentSliceId,
  SUBAGENT_ROUTE_ACTUATORS,
  locallyEligibleFor,
  providerConsentGate,
  sessionSignedInProviders,
  unavailableModels,
  checkEvidenceSufficiency,
  loadModelRegistry,
  readPins,
  registryModel,
  harnessModelRef,
  type IntentContext,
  type RequiredArtifact,
  type ModelOffer,
  type SeenSpelling,
  type TriggerKind,
} from '@jevris/core';

/** The spellings each model was seen with on this harness and sign-in (serving hosts R51). */
function seenSpellingsOn(offer: ModelOffer | null, harness: string, authMode: string | null): (modelId: string) => readonly SeenSpelling[] {
  return (modelId) => seenSpellings(offer, { harness, authMode }, modelId);
}
import { FAILURE_ARTIFACT_IDS, HARNESS_MODEL_ID_PATTERN, type FailureArtifactId } from '@jevris/contracts';
import type { HookProposal, TriggerHandler, TriggerHandlerInput } from './sidecar-subscribers.js';
import { FAILURE_ARTIFACT_TEXT } from './failure-advice.js';
import { newTaskAdvice, repeatedFailureAdvice } from './live-handlers.js';
import { scopeChangeAdvice } from './scope-handler.js';
import { bundledCalibrationPath, trustedCalibrationKeys } from './calibration-trust.js';
import { adviceIgnored, openAdvice } from './advice-adherence.js';
import { consentReaderOf } from './engine-of.js';

const routeOnce = new AdviceOnce();
/** What the hook route wire (HookOutcome `route.model`, E b250627) can hold. */
const WIRE_MODEL = new RegExp(HARNESS_MODEL_ID_PATTERN);

/** The route-advice seam, replaceable in tests (an evaluated recommendation needs a signed release). */
export interface ModelChangeAdviceDeps {
  readonly advise?: typeof adviseMainRoute;
  readonly once?: AdviceOnce;
  readonly evaluate?: typeof evaluateRoute;
}

/** A model id from a bounded payload label (the adapters cap it at 128 characters). */
function modelLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * RTE-06, C10: a model-change request gets route advice as a visible explanation, but only
 * when there is an evaluated recommendation: keeping the model, a pin or an abstention says
 * nothing new, so the hook stays silent (observe). The user's pin travels in the event body
 * (`pins`) from the hook and is never overridden; the advice never changes the model, and each
 * advice key is shown once.
 */
export async function modelChangeAdvice(input: TriggerHandlerInput): Promise<HookProposal | null> {
  return modelChangeAdviceWith(input, {});
}

/**
 * `modelChangeAdvice` with its seams. The advice is marked shown only by the proposal's `commit`,
 * which the subscriber runs when this answer is delivered (never on a missed slice).
 */
export async function modelChangeAdviceWith(input: TriggerHandlerInput, deps: ModelChangeAdviceDeps): Promise<HookProposal | null> {
  const once = deps.once ?? routeOnce;
  const advise = deps.advise ?? adviseMainRoute;
  const registry = await loadModelRegistry({ home: input.ctx.home });
  if (registry === null) return null;
  const body = plain(input.ctx.body) ? input.ctx.body : {};
  const pins = readPins(body['pins']);
  // G14: PreModelSwitch names the model asked for in `to_model` (the adapter's `toModel`) and the
  // one it leaves in `from_model`; `event.model` is only the active model.
  const payload = input.event.payload ?? {};
  const requestedRaw = modelLabel(payload['toModel']) ?? modelLabel(payload['requestedModel']) ?? modelLabel(input.event.model);
  const fromRaw = modelLabel(payload['fromModel']);
  // The one resolver on the event's harness (8c1f85d): a gateway or third-party id is not the
  // maker's model, so it gets no advice under the maker's consent.
  const resolve = (raw: string | null): string | null => {
    const ref = raw === null ? null : harnessModelRef(registry, raw, input.event.harness);
    return ref !== null && ref.registered ? ref.modelId : null;
  };
  const requested = resolve(requestedRaw);
  const from = resolve(fromRaw);
  const slice = typeof body['sliceId'] === 'string' ? body['sliceId'] : null;
  // The evaluated selection for the model asked for, on this harness and sign-in. The switch is
  // already asked for, so its warm prefix moves either way: the advice weighs the requested model
  // against the router's choice, not against staying (no switch guard). No slice, a pin or a
  // requested model outside the registry: nothing is evaluated and nothing is recommended.
  const rawAuth = body['authMode'];
  const authMode = rawAuth === 'api-key' || rawAuth === 'subscription' ? rawAuth : null;
  const evaluation =
    slice === null || pins.modelPin !== null || requested === null || registryModel(registry, requested) === null
      ? null
      : await (deps.evaluate ?? evaluateRoute)({
          role: 'main',
          home: input.ctx.home,
          registry,
          trustedKeys: await trustedCalibrationKeys(input.ctx.home),
          bundledCalibration: bundledCalibrationPath(input.ctx.home),
          killSwitchStopped: input.ctx.killSwitchStopped === true,
          sliceId: slice,
          currentModel: requested,
          pins,
          nowMs: input.engine?.now?.() ?? Date.now(),
          harness: input.event.harness,
          authMode,
        }).catch(() => null);
  const selection = evaluation?.selection ?? null;
  const advice = advise(
    {
      sessionId: input.envelope.sessionId,
      workspaceId: input.envelope.workspaceId,
      revision: input.envelope.expectedRevision,
      mode: 'observe',
      requestedModelId: requested,
      actualModelId: null,
      contextTokensEstimate: null,
      activeTaskIds: input.envelope.taskId === undefined ? [] : [input.envelope.taskId],
      observedAt: input.envelope.occurredAt,
    },
    registry,
    pins,
    { selection, switchDecision: null, costBasis: selection === null ? 'unknown' : (selection.costEstimates?.length ?? 0) > 0 ? 'maker-price-estimate' : 'api-list-price' },
  );
  if (advice.outcome !== 'recommend' || once.seen(advice.adviceKey)) return null;
  const key = advice.adviceKey;
  const advised = advice.recommendedModelId;
  // P5: advice this session did not follow twice is not repeated (the hook stays silent).
  if (advised !== null && adviceIgnored(input.ctx, 'model-change', input.envelope.sessionId, slice, advised)) return null;
  const commit = (): boolean => {
    if (!once.first(key)) return false;
    // Delivered: open it for adherence. Model-change advice has no decision record, so its id derives
    // from the advice key and the time, keeping a delivery after a sidecar restart distinct.
    if (advised !== null) openAdvice(input.ctx, { decisionId: `advice-${key.replace(/^sha256:/, '').slice(0, 32)}-${(input.engine?.now?.() ?? Date.now()).toString(36)}`, adviceKind: 'model-change', sessionId: input.envelope.sessionId, slice, advisedModel: advised, currentModel: from, atMs: input.engine?.now?.() ?? Date.now() });
    return true;
  };
  return { hookOutcome: { kind: 'explain', text: advice.text }, reasonCode: advice.reasonCode, commit };
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : null;
}

function texts(value: unknown, maxItems: number, max: number): string[] {
  return Array.isArray(value) ? value.slice(0, maxItems).map((v) => text(v, max)).filter((v): v is string => v !== null) : [];
}

function list(value: unknown, maxItems: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, maxItems).filter(plain) : [];
}

function intentContext(input: TriggerHandlerInput): IntentContext {
  const remaining = input.ctx.deadline.remainingMs();
  return {
    workspaceId: input.envelope.workspaceId,
    evidenceRevision: input.revision ?? input.envelope.expectedRevision,
    sessionId: input.envelope.sessionId,
    ...(input.currentRevision === undefined ? {} : { currentRevision: input.currentRevision }),
    ...(input.stillUseful === undefined ? {} : { stillUseful: input.stillUseful }),
    ...(input.envelope.taskId === undefined ? {} : { taskId: input.envelope.taskId }),
    deadlineMs: Math.max(1, Math.min(2000, remaining)),
    options: { signal: input.ctx.signal, deadline: input.ctx.deadline },
  };
}

function bodyPart(input: TriggerHandlerInput, key: string): Record<string, unknown> | null {
  const body = plain(input.ctx.body) ? input.ctx.body : {};
  const part = body[key];
  return plain(part) ? part : null;
}

function artifactsOf(value: unknown): RequiredArtifact[] {
  return list(value, 32).flatMap((a) => {
    const id = text(a['id'], 64);
    if (id === null) return [];
    // A fixed-vocabulary id (failing-test-output, stack-trace, ...) carries its own fixed description:
    // a caller's free text is never read for it, so an id alone is a complete artifact.
    const known = (FAILURE_ARTIFACT_IDS as readonly string[]).includes(id);
    const description = known ? FAILURE_ARTIFACT_TEXT[id as FailureArtifactId].phrase : text(a['description'], 300);
    if (description === null) return [];
    const location = text(a['location'], 1000);
    return [{ id, description, available: a['available'] === true, fresh: a['fresh'] === true ? true : a['fresh'] === false ? false : null, ...(location === null ? {} : { location }) }];
  });
}

/**
 * INT-04 (C05), the rules part: after a failure that carries `evidence: { required, obtainable? }`, ask for
 * one specific artifact that is missing or stale before escalating. Only the workspace root is an approved
 * location; nothing outside it is suggested.
 *
 * This runs on the hook path with no engine, so it never waits on Jev and sends nothing: a failure's
 * diagnostics are the error's own text, which stays in the harness. C05's Jev questions (is the evidence
 * enough, which listed artifact next) are asked by the repeated-failure adviser, over the fixed vocabulary of
 * artifacts only (`failure-advice.ts`), where a failure has come back and the question is worth a call.
 */
export async function evidenceAdvice(input: TriggerHandlerInput): Promise<HookProposal | null> {
  const evidence = bodyPart(input, 'evidence');
  if (evidence === null) return null;
  const required = artifactsOf(evidence['required']);
  if (required.length === 0) return null;
  const root = input.ctx.workspace.root;
  const result = await checkEvidenceSufficiency(
    null,
    {
      objective: 'Choose a fix for the current failure.',
      required,
      obtainable: artifactsOf(evidence['obtainable']),
      approvedRoots: root === null ? [] : [root],
    },
    intentContext(input),
  );
  if (result.outcome !== 'request-artifact') return null;
  const where = result.artifact.location === null ? '' : ` (${result.artifact.location})`;
  return { hookOutcome: { kind: 'explain', text: `Jevris: before escalating, get ${result.artifact.id}: ${result.artifact.description}${where}.` }, reasonCode: result.reasonCode, ...(result.decisionId === null ? {} : { decisionId: result.decisionId }) };
}

/**
 * Claude Code subagent routing (owner decision 2026-09-27, DOMAINS 9ce2ba5: build it, abstain by
 * default). A PreToolUse(Agent/Task) event gets a route proposal `{ model }` (a registry id; the
 * launcher maps it to a Claude Code alias and builds updatedInput from the native input) only when
 * `adviseSubagentRoute` finds evidence for the subagent type: an active learned route for
 * `subagent:<type>`, or a signed calibration release for that slice. An uncertified route shows
 * its fallback text as explain. Reads `payload.subagentType` and whether `payload.requestedModel`
 * is present, never the prompt. Records no learning outcome (D records SubagentStop later).
 */
export async function subagentRouteAdvice(input: TriggerHandlerInput): Promise<HookProposal | null> {
  const signal = input.ctx.signal as { readonly aborted?: boolean };
  if (signal.aborted === true) return null;
  const payload = plain(input.event.payload) ? input.event.payload : {};
  const subagentType = typeof payload['subagentType'] === 'string' ? payload['subagentType'] : null;
  const explicitModel = typeof payload['requestedModel'] === 'string' && payload['requestedModel'].length > 0;
  // Cheap refusals first: no file is read for a route that cannot be proposed.
  // R20: every harness in the actuator table may be advised (Antigravity as explain text only).
  if (!Object.prototype.hasOwnProperty.call(SUBAGENT_ROUTE_ACTUATORS, input.event.harness) || subagentType === null) return null;
  const nowMs = input.engine?.now?.() ?? Date.now();
  // P13: what this launch got, for D's SubagentStart timing record (codes only, never learning).
  // Stamped with the subscriber's clock (the envelope's time), the clock that upgrades the note.
  const noteAtMs = Number.isFinite(Date.parse(input.envelope.occurredAt)) ? Date.parse(input.envelope.occurredAt) : nowMs;
  const note = (outcome: 'proposed' | 'abstained', reasonCode: string, modelId: string | null = null): void => {
    noteSubagentRoute({ workspaceId: input.envelope.workspaceId, sessionId: input.envelope.sessionId, subagentType, reasonCode, outcome, atMs: noteAtMs, modelId });
  };
  if (explicitModel) return (note('abstained', 'EXPLICIT_MODEL'), null);
  const sliceId = subagentSliceId(subagentType);
  if (sliceId === null) return (note('abstained', 'SUBAGENT_TYPE_INVALID'), null);
  const body = plain(input.ctx.body) ? input.ctx.body : {};
  const pins = readPins(body['pins']);
  if (pins.modelPin !== null) return (note('abstained', 'MODEL_PINNED'), null);
  const registry = await loadModelRegistry({ home: input.ctx.home });
  if (registry === null) return (note('abstained', 'REGISTRY_INVALID'), null);
  const authMode = body['authMode'] === 'api-key' || body['authMode'] === 'subscription' ? body['authMode'] : null;
  const gone = unavailableModels(await loadModelAvailability(input.ctx.home, registry).catch(() => []), { harness: input.event.harness, authMode });
  const learning = await loadLearningState({ home: input.ctx.home, workspaceId: input.envelope.workspaceId }).catch(() => null);
  // OD-4 (B's security review, MEDIUM 4 and 9): the same consent gate as actuation. The session is
  // signed in to its harness's own provider and its model's; any other provider needs a grant.
  const sessionModel = typeof input.event.model === 'string' && input.event.model.length > 0 ? input.event.model : null;
  const consentedProviders = providerConsentGate(registry, sessionSignedInProviders(registry, input.event.harness, sessionModel), consentReaderOf(input.ctx)).consentedProviders;
  // Owner decision 3f090fa and B's review (MEDIUM 4): the model must be eligible on this harness
  // and sign-in from local evidence (listed by the harness or run here).
  const locallyEligible = await locallyEligibleFor({ home: input.ctx.home, registry, accountId: null, unavailable: gone, scope: { harness: input.event.harness, authMode } }).catch(() => []);
  // A signed calibration release for the subagent slice is the other evidence (routeTask's selection).
  let signedPrior: { readonly modelId: string; readonly releaseId: string } | null = null;
  const evaluation = await evaluateRoute({
    role: 'worker',
    home: input.ctx.home,
    registry,
    trustedKeys: await trustedCalibrationKeys(input.ctx.home),
    bundledCalibration: bundledCalibrationPath(input.ctx.home),
    killSwitchStopped: input.ctx.killSwitchStopped,
    sliceId,
    currentModel: null,
    pins,
    nowMs,
    // A subagent runs on the event's harness: account eligibility comes from evidence there
    // (DOMAINS 3f090fa), and the model must be one that harness names (R20).
    harness: input.event.harness,
    authMode,
    consentedProviders,
  }).catch(() => null);
  const selection = evaluation?.selection ?? null;
  if (selection !== null && selection.outcome === 'select' && selection.modelId !== null && evaluation?.calibrationId !== null && evaluation?.calibrationId !== undefined) {
    signedPrior = { modelId: selection.modelId, releaseId: evaluation.calibrationId };
  }
  const advice = adviseSubagentRoute({
    harness: input.event.harness,
    subagentType,
    explicitModel,
    sessionModel,
    pins,
    registry,
    nowMs,
    unavailableModels: gone,
    learning,
    signedPrior,
    consentedProviders,
    locallyEligible,
    // Access limits R73 (design E5); a missing or unreadable record gives none (fail-open).
    accessLimits: (await readAccessLimits(input.ctx.home).catch(() => ({ entries: [] }))).entries,
    authMode,
    // Serving hosts R51: the child keeps the parent's host, a gateway included. Seen spellings from
    // the model offer; host consent from B's reader; route.host from the sidecar (B's 76c5d764),
    // never the plugin: the sidecar replaces any claim on the event body.
    seen: seenSpellingsOn(await readModelOffer(input.ctx.home).catch(() => null), input.event.harness, authMode),
    providerConsent: consentReaderOf(input.ctx),
    hostRouteCertified: body['hostRouteCertified'] === true,
  });
  // 43cb54c: a learned effort that is worked out but not applied (Codex) is named in the trace too.
  input.ctx.trace({ event: 'subagent-route', reasonCode: advice.reasonCode, ...(advice.outcome === 'propose' && advice.effortNotApplied !== null ? { effortNotApplied: advice.effortNotApplied } : {}) });
  if (advice.outcome !== 'propose') return (note('abstained', advice.reasonCode), null);
  note('proposed', advice.reasonCode, advice.modelId);
  // No consuming effect, but the subscriber still refuses the answer when its slice has ended.
  // Claude Code's route carries the registry id (its adapter spells the alias). Elsewhere it
  // carries the harness's own id (Codex's bare id, Kilo's and OpenCode's provider/model) and, for
  // a learned effort, the harness's variant (E b250627). Where the harness cannot apply a route
  // (Antigravity) or the wire cannot hold the id, it is explain text.
  const wireModel = input.event.harness === 'claude' ? advice.modelId : advice.harnessModel;
  // Serving hosts R51: a proposal priced by estimate, or through a host without route.host, is explained only.
  const routable = advice.actuator !== null && advice.blockedReason === null && wireModel.length <= 128 && WIRE_MODEL.test(wireModel);
  const hookOutcome = routable
    ? ({ kind: 'route', model: wireModel, ...(advice.variant === null ? {} : { variant: advice.variant }) } as const)
    : ({ kind: 'explain', text: advice.text } as const);
  return { hookOutcome, fallbackText: advice.text, reasonCode: advice.reasonCode, commit: () => true };
}

export const DEFAULT_TRIGGER_HANDLERS: Partial<Record<TriggerKind, readonly TriggerHandler[]>> = Object.freeze({
  'model-change-request': [modelChangeAdvice],
  'worker-creation': [subagentRouteAdvice],
  // One handler: C01, C04 and C02 over the request the adapter supplies, only with egress approved.
  'new-task': [newTaskAdvice],
  'diff-boundary': [scopeChangeAdvice],
  'new-failure-family': [evidenceAdvice],
  // The live adviser first (it reads the adapter's content-free `failure` features and asks C05 over them);
  // `evidenceAdvice` adds C05's rules request for a missing artifact, with no call.
  'repeated-failure': [repeatedFailureAdvice, evidenceAdvice],
});
