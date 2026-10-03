/**
 * One entry for every surface operation (§11.2 commands and §6.4 tools):
 *   1. validate the input (inputs.ts),
 *   2. ask the sidecar, starting it on demand (IPC-13), and validate the body against the
 *      shared payload contract (commands.ts),
 *   3. otherwise answer from local state in reduced mode, naming why,
 *   4. wrap the payload in the result envelope and validate the whole result.
 *
 * The CLI prints the result (`--json`) or its rendering; the MCP server mirrors it in
 * `structuredContent`. Both therefore show the same answer.
 */
import { harnessModelRef, planSliceTasksOf, planTaskGraph, suggestPlanSlices } from '@jevris/core';
import { workerModelOf } from '@jevris/provider-typesafe';
import type { SidecarRequestResult } from './ports.js';
import {
  COMMAND_EXIT_CODES,
  HARNESS_IDS,
  MODE_OFF_REASON,
  MODE_OFF_REFUSED_OPS,
  PROVIDER_CONSENT_TEXT,
  PlanSliceSuggestionsContract,
  modeOffMessage,
  surfacePayloadContract,
  surfaceResultContract,
  type SidecarState,
  type SurfaceOperation,
  type SurfacePayloads,
  type SurfaceResult,
} from '@jevris/contracts';
import type { SurfaceContext } from './context.js';
import { parseOpInput, type OpInputs } from './inputs.js';
import { STATUS_LATENCY_DAYS, latencySummary } from './latency.js';
import {
  effectiveConfig,
  explainNotFound,
  harnessModelPin,
  killSwitchWriteRefusal,
  localCheckpoint,
  localConfigure,
  localEvidenceSelect,
  localHandoffExport,
  localHandoffImport,
  localRecover,
  localRoute,
  localStatus,
  localVerify,
  withHostSourceEgress,
} from './local.js';
import { summaryFor } from './render.js';
import { homeRefusal } from './home-guard.js';

export type OperationOutcome =
  | { readonly ok: true; readonly result: SurfaceResult; readonly exitCode: 0 | 1 }
  | { readonly ok: false; readonly exitCode: 2; readonly message: string; readonly reasonCode?: string }
  /** The sidecar took the request and did not answer in time: what it did is unknown, not refused. */
  | { readonly ok: false; readonly exitCode: 1; readonly message: string; readonly reasonCode: string };

interface SidecarView {
  readonly state: SidecarState;
  readonly reasonCode: string | null;
  readonly message: string | null;
}

const RUNNING: SidecarView = { state: 'running', reasonCode: null, message: null };

/** The sidecar op for each surface operation, by client scope. `null`: answered locally only. */
function sidecarOp(op: SurfaceOperation, scope: 'cli' | 'mcp'): string | null {
  if (op === 'configure') return null;
  // verify runs processes, so only the CLI (submit scope) may ask the sidecar to run checks.
  if (op === 'verify') return scope === 'cli' ? 'verify' : 'verify.status';
  return op;
}

/**
 * The harness an MCP server runs inside. The MCP server sets JEVRIS_HARNESS for its surface
 * calls from its own `--harness <id>` argument (the installer writes it into each harness's MCP
 * entry) and drops any inherited value. Only a known harness id counts; the CLI gives null. The sidecar negotiates a handoff for this harness from its own certification records,
 * so naming a harness never grants a capability by itself.
 */
export function surfaceHarness(ctx: Pick<SurfaceContext, 'scope' | 'env'>): (typeof HARNESS_IDS)[number] | null {
  if (ctx.scope !== 'mcp') return null;
  const value = ctx.env['JEVRIS_HARNESS'];
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value) ? (value as (typeof HARNESS_IDS)[number]) : null;
}

function requestBody(ctx: SurfaceContext, op: SurfaceOperation, input: unknown): unknown {
  if (op === 'recover') {
    const recover = input as OpInputs['recover'];
    return { taskId: recover.taskId, signals: recover.signals, rejectedApproaches: recover.rejectedApproaches };
  }
  if (op === 'route') {
    // The switch facts are optional on the route op, and an absent one is left out, not sent as null.
    // G20: the harness is the one the CLI named, else the MCP server's own; authMode only when named.
    const { remaining, contextTokens, session, harness: named, authMode, ...rest } = input as OpInputs['route'];
    const harness = named ?? surfaceHarness(ctx);
    return {
      ...rest,
      ...(remaining === null ? {} : { remaining }),
      ...(contextTokens === null ? {} : { contextTokens }),
      ...(session === null ? {} : { session }),
      ...(harness === null ? {} : { harness }),
      ...(authMode === null ? {} : { authMode }),
    };
  }
  if (op === 'evidence.get') {
    // P10: the selection the handle came from, only when the client named one.
    const { handle, selectionId } = input as OpInputs['evidence.get'];
    return selectionId === null ? { handle } : { handle, selectionId };
  }
  if (op === 'status') {
    // The sidecar cannot read the session's environment: the pinned harness model goes with the request.
    const modelPin = harnessModelPin(ctx.env);
    return modelPin === null ? input : { ...(input as object), modelPin };
  }
  if (op === 'handoff.import' || op === 'handoff.export') {
    const harness = surfaceHarness(ctx);
    return harness === null ? input : { ...(input as object), harness };
  }
  return input;
}

function failureView(result: Extract<SidecarRequestResult, { ok: false }>): SidecarView {
  const state: SidecarState =
    result.reason === 'unavailable' ? 'not-running' : result.reason === 'timeout' ? 'timeout' : result.reason === 'refused' ? 'refused' : 'rejected';
  return { state, reasonCode: codeOf(result.reasonCode, `SIDECAR_${result.reason.toUpperCase()}`), message: lineOf(result.message) };
}

function codeOf(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function lineOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const line = value.split('\n')[0]?.trim() ?? '';
  if (line.length === 0) return null;
  if (/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(line)) return 'The sidecar did not answer.';
  return line.slice(0, 500);
}

async function askSidecar(ctx: SurfaceContext, op: string, body: unknown): Promise<{ readonly view: SidecarView; readonly body?: unknown }> {
  if (ctx.autostart) {
    const ensured = await ctx.ports.sidecar.ensure({ home: ctx.home, waitMs: ctx.sidecarWaitMs });
    if (!ensured.ok) {
      const state: SidecarState = ensured.reason === 'starting' ? 'starting' : ensured.reason === 'refused' ? 'refused' : 'not-running';
      return { view: { state, reasonCode: `SIDECAR_${ensured.reason.toUpperCase()}`, message: lineOf(ensured.message) } };
    }
  }
  const answer = await ctx.ports.sidecar.request({
    home: ctx.home,
    op,
    workspace: ctx.workspaceRoot ?? ctx.workspaceId,
    body,
    scope: ctx.scope,
    timeoutMs: ctx.requestTimeoutMs,
    budget: 'background',
  });
  if (!answer.ok) return { view: failureView(answer) };
  return { view: RUNNING, body: answer.result };
}

function reasonText(view: SidecarView): string {
  switch (view.state) {
    case 'not-running':
      return 'The Jevris sidecar is not running, so this is a local reduced answer.';
    case 'starting':
      return 'The Jevris sidecar is still starting, so this is a local reduced answer. Retry in a moment.';
    case 'timeout':
      return 'The Jevris sidecar did not answer in time, so this is a local reduced answer.';
    case 'refused':
      return 'The Jevris sidecar refused this request, so this is a local reduced answer.';
    case 'rejected':
      return 'The Jevris sidecar rejected this request, so this is a local reduced answer.';
    case 'running':
      return 'The Jevris sidecar returned a result that does not match its contract, so this is a local reduced answer.';
  }
}

/** The rules-only slice labels of a sound plan, for a reduced answer (no sidecar, so no Jev and no record). */
async function localPlanSlices(tasks: readonly unknown[], graph: SurfacePayloads['plan']): Promise<{ readonly sliceSuggestions?: SurfacePayloads['plan']['sliceSuggestions'] }> {
  if (graph.taskCount === 0 || graph.order.length !== graph.taskCount) return {};
  try {
    const found = await suggestPlanSlices(null, planSliceTasksOf(tasks, graph.order), { workspaceId: 'local', evidenceRevision: 'local' }, { assist: 'classify', deadlineMs: 0, record: false });
    const checked = PlanSliceSuggestionsContract.validate(found);
    return checked.ok && checked.value.length > 0 ? { sliceSuggestions: checked.value } : {};
  } catch {
    return {};
  }
}

async function reduced<K extends SurfaceOperation>(
  ctx: SurfaceContext,
  op: K,
  input: OpInputs[K],
  view: SidecarView,
): Promise<{ readonly ok: true; readonly payload: SurfacePayloads[K] } | { readonly ok: false; readonly message: string; readonly reasonCode?: string }> {
  const reason = reasonText(view);
  const done = (payload: unknown) => ({ ok: true as const, payload: payload as SurfacePayloads[K] });
  switch (op) {
    case 'status':
      return done(await localStatus(ctx, reason));
    case 'explain': {
      const decisionId = (input as OpInputs['explain']).decisionId;
      const lookup = ctx.ports.engine.lookupDecision;
      if (lookup !== undefined) {
        try {
          const record = await lookup(decisionId, { home: ctx.home });
          if (record !== null) return done(traceOf(ctx, record));
        } catch {
          // A broken ledger is a not-found answer, never a crash.
        }
      }
      return done(explainNotFound(decisionId));
    }
    case 'route':
      return done(await routeLocally(ctx, input as OpInputs['route'], reason));
    case 'plan': {
      const tasks = (input as OpInputs['plan']).tasks;
      const graph = planTaskGraph(tasks);
      return done({ ...graph, ...(await localPlanSlices(tasks, graph)) });
    }
    case 'checkpoint': {
      const stopped = await killSwitchWriteRefusal(ctx, 'checkpoint');
      if (stopped !== null) return stopped;
      return done(await localCheckpoint(ctx, input as OpInputs['checkpoint']));
    }
    case 'recover':
      return done(localRecover(input as OpInputs['recover']));
    case 'verify':
      return done(localVerify(input as OpInputs['verify']));
    case 'configure': {
      const answer = await configureAnswer(ctx, input as OpInputs['configure']);
      return answer.ok ? done(answer.payload) : answer;
    }
    case 'task.get':
      return done({ taskId: (input as OpInputs['task.get']).taskId, found: false, task: null, receipts: [] });
    case 'evidence.select':
      return done(localEvidenceSelect(input as OpInputs['evidence.select']));
    case 'evidence.get':
      return done(await localEvidence(ctx, (input as OpInputs['evidence.get']).handle));
    case 'verification.record':
      return done({
        receiptId: (input as OpInputs['verification.record']).receiptId,
        accepted: false,
        reasonCode: 'RECEIPT_STORE_UNAVAILABLE',
        outcome: null,
        receiptCreated: false,
      });
    case 'task.submit':
      return done({ accepted: false, taskId: null, leaseIds: [], reasonCode: 'OWNED_MODE_UNAVAILABLE' });
    case 'handoff.export':
      return done(localHandoffExport(ctx, input as OpInputs['handoff.export']));
    case 'handoff.import': {
      const stopped = await killSwitchWriteRefusal(ctx, 'handoff.import');
      if (stopped !== null) return stopped;
      return done(await localHandoffImport(ctx, input as OpInputs['handoff.import']));
    }
    case 'capability.advise': {
      const local = await localCapabilityAdvice(ctx, input as OpInputs['capability.advise']);
      return local === null ? { ok: false, message: `${reason} This report needs the workspace: run it inside a repository or pass --workspace <dir>.` } : done(local);
    }
  }
  return { ok: false, message: 'Unknown operation.' };
}

/**
 * The test worker port line for status (ORC-03): D's gate over this process's environment and
 * the Jevris home. Null unless a test worker script is named; never throws.
 */
async function testWorkerDiagnostic(ctx: SurfaceContext): Promise<string | null> {
  const named = ctx.env['JEVRIS_TEST_WORKER_SCRIPT'];
  if (typeof named !== 'string' || named === '') return null;
  try {
    const orchestrator = await import('@jevris/orchestrator');
    const diagnostic = orchestrator.testWorkerPortStatus(ctx.env, ctx.home).diagnostic;
    return typeof diagnostic === 'string' ? diagnostic.slice(0, 500) : null;
  } catch {
    return 'test worker port: unknown (the orchestrator is not available)';
  }
}

/**
 * A delivery report without the sidecar: D's capability runs here on the same workspace state,
 * rules only (no engine is consulted locally). The answer is checked against the payload
 * contract; null when there is no workspace or the orchestrator cannot answer.
 */
async function localCapabilityAdvice(ctx: SurfaceContext, input: OpInputs['capability.advise']): Promise<SurfacePayloads['capability.advise'] | null> {
  if (ctx.workspaceRoot === null) return null;
  try {
    const orchestrator = await import('@jevris/orchestrator');
    const ws = orchestrator.openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspaceRoot });
    const answer = await orchestrator.adviseCapability(ws, { capabilityId: input.capabilityId, input: { ...input.input }, taskId: input.taskId, home: ctx.home, env: ctx.env });
    if (!answer.ok) return null;
    const checked = surfacePayloadContract('capability.advise').validate(answer.advice);
    return checked.ok ? checked.value : null;
  } catch {
    return null;
  }
}

/**
 * evidence.get without the sidecar: D's evidence store read directly (the same payload the op
 * returns, secrets redacted), validated against the payload contract; not found otherwise.
 */
async function localEvidence(ctx: SurfaceContext, handle: string): Promise<SurfacePayloads['evidence.get']> {
  const missing = { handle, found: false, mediaType: null, byteLength: null, text: null, truncated: false };
  if (ctx.workspaceRoot === null) return missing;
  try {
    const orchestrator = await import('@jevris/orchestrator');
    const ws = orchestrator.openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspaceRoot });
    const checked = surfacePayloadContract('evidence.get').validate(orchestrator.evidencePayload(ws, handle));
    return checked.ok ? checked.value : missing;
  } catch {
    return missing;
  }
}

/**
 * Main-session advice from C's pure router when it and a registry are available, else the
 * baseline answer. A pinned model is always kept (C10): a recommendation that contradicts
 * the pin is downgraded to keep.
 */
/**
 * Security review MEDIUM 9: without the sidecar, the CLI cannot read the stored consent, so local
 * advice is limited to the registry's providers that need no consent at all (no consent text and
 * no model marked as needing it). Every bundled provider has consent text (Anthropic since owner
 * decision c065d52, so a revoke of it counts), so offline advice suggests no model. Fail closed.
 */
function localConsentedProviders(registry: unknown): readonly string[] {
  const entries = Reflect.get(registry as object, 'entries');
  if (!Array.isArray(entries)) return [];
  const providers = new Set<string>();
  const marked = new Set<string>();
  for (const entry of entries as readonly unknown[]) {
    const provider = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'provider') : undefined;
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(provider)) continue;
    providers.add(provider);
    if (Reflect.get(entry as object, 'requiresProviderConsent') === true) marked.add(provider);
  }
  return [...providers].filter((p) => !Object.hasOwn(PROVIDER_CONSENT_TEXT, p) && !marked.has(p)).sort().slice(0, 64);
}

/** The provider the registry lists for a model id, or null. */
function registryProviderOf(registry: unknown, modelId: string): string | null {
  const entries = Reflect.get(registry as object, 'entries');
  if (!Array.isArray(entries)) return null;
  for (const entry of entries as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object' || Reflect.get(entry, 'modelId') !== modelId) continue;
    const provider = Reflect.get(entry, 'provider');
    return typeof provider === 'string' ? provider : null;
  }
  return null;
}

async function routeLocally(ctx: SurfaceContext, input: OpInputs['route'], reason: string): Promise<SurfacePayloads['route']> {
  const advise = ctx.ports.engine.adviseMainRoute;
  const loadRegistry = ctx.ports.engine.loadRegistry;
  const fallback = localRoute(input, reason);
  if (advise === undefined || loadRegistry === undefined) return fallback;
  try {
    const registry = await loadRegistry({ home: ctx.home });
    if (registry === null) return fallback;
    // G20: a harness model id (provider/model, [1m]) resolved to the registry id the router reads.
    const entries = Array.isArray((registry as { readonly entries?: unknown }).entries) ? registry : null;
    // A model that does not resolve to a registered one (a gateway or third-party id keeps only its
    // bare segment) is not the maker's model: the router is not asked, and a pin on it is still kept.
    // With the session's harness known, only that harness's spellings resolve (C 21d49e9).
    const resolve = (raw: string | null): string | null | undefined => {
      if (raw === null) return null;
      const ref = harnessModelRef(entries, raw, input.harness);
      return ref?.registered === true ? ref.modelId : undefined;
    };
    const currentModel = resolve(input.currentModel);
    const modelPin = resolve(input.modelPin);
    if (currentModel === undefined || modelPin === undefined) return fallback;
    input = { ...input, currentModel, modelPin };
    const snapshot = {
      sessionId: 'cli-session',
      workspaceId: ctx.workspaceId,
      revision: 'cli',
      mode: effectiveConfig(ctx).mode,
      requestedModelId: input.currentModel,
      actualModelId: input.currentModel,
      contextTokensEstimate: null,
      activeTaskIds: input.taskId === null ? [] : [input.taskId],
      observedAt: new Date(ctx.nowMs()).toISOString(),
    };
    const advice = advise(snapshot, registry, { modelPin: input.modelPin, effortPin: input.effortPin });
    const pinned = input.modelPin !== null;
    const contradicts = pinned && advice.outcome === 'recommend' && advice.recommendedModelId !== input.modelPin;
    const consentedProviders = localConsentedProviders(registry);
    // A recommended model of a provider outside the consented set is never shown (fail closed).
    const recommendedProvider = advice.recommendedModelId === null ? null : registryProviderOf(registry, advice.recommendedModelId);
    const unconsented = !contradicts && advice.outcome === 'recommend' && (recommendedProvider === null || !consentedProviders.includes(recommendedProvider));
    const kept = contradicts || unconsented;
    return {
      main: {
        currentModel: input.currentModel,
        modelPin: input.modelPin,
        pinState: pinned ? 'pinned' : 'unpinned',
        outcome: kept ? 'keep' : advice.outcome,
        recommendedModel: kept ? null : advice.recommendedModelId,
        reasonCode: contradicts ? 'PIN_RESPECTED' : unconsented ? 'PROVIDER_CONSENT_REQUIRED' : advice.reasonCode,
        costBasis: advice.costBasis,
        text: contradicts
          ? `Keep ${input.modelPin}. It is pinned, and Jevris never changes a pinned model.`
          : unconsented
            ? 'Keep the current model. The sidecar is not running, so Jevris cannot read your provider consent and suggests no model that needs it (jevris consent provider).'
            : advice.text,
        adviceKey: advice.adviceKey,
        consentedProviders,
      },
      worker: fallback.worker,
      applied: false,
    };
  } catch {
    return fallback;
  }
}

function traceOf(ctx: SurfaceContext, record: import('@jevris/contracts').DecisionRecord): SurfacePayloads['explain'] {
  let rendered = '';
  const explain = ctx.ports.engine.explainDecision;
  if (explain !== undefined) {
    try {
      rendered = explain(record);
    } catch {
      rendered = '';
    }
  }
  const usage = record.usage;
  const reasons = record.reasonCodes.slice(0, 16);
  if (rendered.trim().length === 0) {
    rendered = [
      `Decision ${record.decisionId}: ${record.outcome}.`,
      `Reasons: ${reasons.join(', ')}.`,
      `Model: ${record.modelResolved ?? 'none (no provider call)'}.`,
      usage === null ? 'Usage: unknown.' : `Usage: ${usage.inputTokens} input and ${usage.outputTokens} output tokens.`,
      `Billing basis: ${record.billingBasis}.`,
    ].join('\n');
  }
  return {
    decisionId: record.decisionId,
    found: true,
    trace: {
      outcome: record.outcome,
      reasonCodes: reasons,
      resolvedModel: record.modelResolved,
      usage: usage === null ? { known: false, inputTokens: null, outputTokens: null } : { known: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      uncertainty:
        record.calibration === undefined || record.calibration === null
          ? 'No calibration applies to this decision; treat it as advice, not a measured prediction.'
          : `Calibrated by ${record.calibration.id} version ${record.calibration.version}; the provider's confidence is not accuracy.`,
      policyVersion: record.policyVersion ?? null,
      applied: record.outcome === 'applied',
      rendered: rendered.slice(0, 4000),
      // US12: requested versus observed model from the record's own observation. The reduced
      // path has no store session row, so a missing observation stays unknown.
      models: workerModelOf(record, null),
    },
  };
}

/**
 * configure: D's loader and setter (SET-02, SET-03) when present, else the local file. Either
 * way the answer is validated against the configure payload contract, and source egress is the
 * host decision the egress guard enforces, never the file's preference.
 */
async function configureAnswer(ctx: SurfaceContext, input: OpInputs['configure']) {
  const port = ctx.ports.config;
  if (input.set === null && port.loadEffectiveConfig !== undefined) {
    try {
      const loaded = await port.loadEffectiveConfig({ home: ctx.home, workspaceRoot: ctx.workspaceRoot });
      const checked = surfacePayloadContract('configure').validate(loaded);
      if (checked.ok) return { ok: true as const, payload: await withHostSourceEgress(ctx, checked.value) };
    } catch {
      // Fall back to the local file.
    }
  }
  if (input.set !== null && ctx.scope === 'cli' && port.setConfigValue !== undefined) {
    try {
      const changed = await port.setConfigValue({ home: ctx.home, key: input.set.key, value: input.set.value, dryRun: input.dryRun, confirmed: input.confirmed });
      const checked = surfacePayloadContract('configure').validate(changed);
      if (checked.ok) return { ok: true as const, payload: await withHostSourceEgress(ctx, checked.value) };
      const refusal = changed as { message?: unknown; reasonCode?: unknown };
      if (typeof refusal.message === 'string' && refusal.message.length > 0) {
        const code = typeof refusal.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(refusal.reasonCode) ? refusal.reasonCode : undefined;
        return { ok: false as const, message: refusal.message.slice(0, 500), ...(code !== undefined ? { reasonCode: code } : {}) };
      }
    } catch {
      // Fall back to the local file.
    }
  }
  return localConfigure(ctx, input);
}

/** Exit 1 for a negative answer (not found, not verified, invalid plan, refused). */
function negative(op: SurfaceOperation, payload: unknown): boolean {
  const p = payload as Record<string, unknown>;
  switch (op) {
    case 'explain':
    case 'task.get':
    case 'evidence.get':
    case 'handoff.export':
      return p['found'] !== true;
    case 'plan':
      return p['valid'] !== true;
    case 'verify':
      return p['readiness'] !== 'verified';
    case 'verification.record':
    case 'task.submit':
    case 'handoff.import':
      return p['accepted'] !== true;
    case 'configure':
      return p['valid'] !== true;
    case 'capability.advise':
      // A pull request that is not ready is a negative answer, so a script can stop on it.
      return p['capabilityId'] === 'C57' && p['recommendation'] !== 'ready';
    default:
      return false;
  }
}

export async function runOperation<K extends SurfaceOperation>(ctx: SurfaceContext, op: K, rawInput: unknown): Promise<OperationOutcome> {
  const refusedHome = homeRefusal(ctx);
  if (refusedHome !== null) return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, message: refusedHome };
  // SSOT §4.2 (owner decision 0eb319de): in off, the asks that exist to consult Jev are refused,
  // from the CLI and the MCP tools alike, whether or not the sidecar runs; read-only commands work.
  if (MODE_OFF_REFUSED_OPS.includes(op) && effectiveConfig(ctx).mode === 'off') {
    return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, reasonCode: MODE_OFF_REASON, message: modeOffMessage(op) };
  }
  const parsed = parseOpInput(op, rawInput);
  if (!parsed.ok) return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, message: parsed.message };
  if (op === 'configure' && (parsed.input as OpInputs['configure']).set !== null && ctx.scope !== 'cli') {
    return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, message: 'Settings change only from the jevris CLI, never from a model tool call.' };
  }
  const remote = sidecarOp(op, ctx.scope);
  let view: SidecarView = { state: 'not-running', reasonCode: 'LOCAL_ONLY', message: null };
  let payload: SurfacePayloads[K] | undefined;
  if (remote !== null) {
    const asked = await askSidecar(ctx, remote, requestBody(ctx, op, parsed.input));
    view = asked.view;
    // D (21e3481): verify refuses a check id that is not approved, and nothing runs. That is a
    // refused input with D's message, never a local "not verified" answer that lists the id.
    if (op === 'verify' && view.state === 'rejected' && view.reasonCode === 'UNKNOWN_CHECK') {
      const why = view.message ?? 'a requested check is not approved; jevris verify profile lists the checks';
      return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, message: `Refused (UNKNOWN_CHECK): ${why.charAt(0).toUpperCase()}${why.slice(1)}. Nothing ran.` };
    }
    // A verify the sidecar did not answer in time was sent: its checks may be running there. Their
    // state is unknown, never "not run", and a slow sidecar is not a reduced one, so no local
    // answer stands in. Asking again joins the run under way; it never starts the checks twice.
    if (op === 'verify' && view.state === 'timeout') {
      const again = ctx.scope === 'cli' ? 'Run jevris verify again' : 'Call jevris_verify again';
      return {
        ok: false,
        exitCode: COMMAND_EXIT_CODES.negative,
        reasonCode: 'VERIFY_STATE_UNKNOWN',
        message: `The Jevris sidecar did not answer within ${String(Math.round(ctx.requestTimeoutMs / 1000))} s (${view.reasonCode ?? 'SIDECAR_TIMEOUT'}), so the state of the checks is unknown: they may still be running. ${again} to see them; it joins a run under way and never starts the checks twice.`,
      };
    }
    if (asked.view.state === 'running') {
      const checked = surfacePayloadContract(op).validate(asked.body);
      if (checked.ok) payload = checked.value;
      else view = { state: 'running', reasonCode: 'SIDECAR_INVALID_RESULT', message: 'The sidecar answer did not match its contract; update Jevris.' };
    }
  }
  const mode: 'full' | 'reduced' = payload !== undefined ? 'full' : 'reduced';
  if (payload === undefined) {
    const local = await reduced(ctx, op, parsed.input, view);
    if (!local.ok) return { ok: false, exitCode: COMMAND_EXIT_CODES.usage, message: local.message, ...(local.reasonCode !== undefined ? { reasonCode: local.reasonCode } : {}) };
    payload = local.payload;
  }
  if (remote === null) view = { state: view.state, reasonCode: null, message: null };
  if (op === 'status') {
    const testWorkerPort = await testWorkerDiagnostic(ctx);
    if (testWorkerPort !== null) payload = { ...(payload as SurfacePayloads['status']), testWorkerPort } as SurfacePayloads[K];
    // P8 (B a51d524): the persisted latency and deadline counters, only from a sidecar that answered.
    if (view.state === 'running') {
      const counters = await askSidecar(ctx, 'latency.counters', { days: STATUS_LATENCY_DAYS }).catch(() => null);
      const latency = counters !== null && counters.view.state === 'running' ? latencySummary(counters.body) : null;
      if (latency !== null) payload = { ...(payload as SurfacePayloads['status']), latency } as SurfacePayloads[K];
    }
  }
  const result = {
    schemaVersion: '1.0' as const,
    command: op,
    mode,
    sidecar: view,
    workspace: { id: ctx.workspaceId, root: ctx.workspaceRoot },
    summary: summaryFor(op, payload, mode),
    result: payload,
  };
  const checked = surfaceResultContract(op).validate(result);
  if (!checked.ok) {
    const where = checked.issues[0];
    return {
      ok: false,
      exitCode: COMMAND_EXIT_CODES.usage,
      // A result Jevris built failed its own contract. The reason code is named so the line is never a bare
      // "report a bug" (the CLI prints `Refused (RESULT_CONTRACT_INVALID): ...`).
      reasonCode: 'RESULT_CONTRACT_INVALID',
      message: `Jevris produced an invalid ${op} result (${where?.path ?? ''} ${where?.code ?? ''}). Report this as a bug.`,
    };
  }
  return { ok: true, result: checked.value as SurfaceResult, exitCode: negative(op, payload) ? COMMAND_EXIT_CODES.negative : COMMAND_EXIT_CODES.ok };
}
