/**
 * Sonnet-first routing where people look (owner decision 2026-09-30, visibility): the views behind
 * `jevris status`, `jevris explain --slice` and `jevris cost-report`. Each is read from the local
 * first-try ledger (`first-try.ts`) and the registry, and carries ids, counts, probabilities and
 * integer micro-USD only. A view changes nothing: the verdict is the router's own
 * `firstTryVerdict` over the ledger's own history with the owner-locked thresholds, the shares are
 * its `firstTryShares`, the ladder is its `firstTryCandidate`, and a cost per verified task is its
 * `costPerVerified`. Nothing here is a second copy of that arithmetic, and nothing invents a
 * figure: where the data to compute one does not exist the field is null.
 */
import {
  BUNDLED_MODEL_REGISTRY,
  DEFAULT_COST_ASSUMPTIONS,
  DEFAULT_TASK_VOLUME,
  costPerVerified,
  firstTryPhase,
  firstTryShares,
  firstTryVerdict,
  harnessFirstTry,
  learningSettings,
  loadLearningState,
  loadModelRegistryChecked,
  loadRoutingPolicy,
  nextTaskShare,
  type FirstTryHistory,
  type FirstTryVerdict,
  type LearningSettings,
} from '@jevris/core';
import { HARNESS_IDS, surfacePayloadContract, type FirstTryGroup, type FirstTrySetting, type FirstTrySliceCounts, type FirstTrySliceView, type FirstTryStatus, type HarnessId, type ModelRegistry, type SidecarOpContext, type SidecarOpDefinition, type SidecarOpOutcome } from '@jevris/contracts';
import { openWorkspace, type WorkspaceServices } from '../workspace.js';
import { isId, isPlain, own } from '../util.js';
import { firstTryHistory, firstTryReports, firstTryRows, type FirstTryRow } from './first-try.js';

const GROUPS_MAX = 8;
const COST_GROUPS_MAX = 16;

/** One (slice, baseline, first-try model) of the ledger, with its history and the verdict a route would reach now. */
interface Group {
  readonly sliceId: string;
  readonly baselineModelId: string;
  readonly firstTryModelId: string;
  readonly rows: readonly FirstTryRow[];
  readonly latest: FirstTryRow;
  readonly history: FirstTryHistory;
  readonly verdict: FirstTryVerdict;
  /** The reason code the ledger kept when the verdict last moved the slice; null while it never has. */
  readonly changeReason: string | null;
}

async function groupsOf(ws: WorkspaceServices, sliceId?: string): Promise<{ readonly groups: readonly Group[]; readonly settings: LearningSettings }> {
  const loaded = await loadLearningState({ home: ws.home, workspaceId: ws.workspaceId }).catch(() => null);
  const settings = learningSettings(loaded?.settings ?? {});
  const byKey = new Map<string, FirstTryRow[]>();
  for (const row of firstTryRows(ws)) {
    if (sliceId !== undefined && row.sliceId !== sliceId) continue;
    const key = `${row.sliceId}|${row.baselineModelId}|${row.firstTryModelId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const kept = new Map(firstTryReports(ws).map((r) => [`${r.sliceId}|${r.baselineModelId}|${r.firstTryModelId}`, r.reasonCode]));
  const groups: Group[] = [];
  for (const [key, rows] of byKey) {
    const latest = rows.reduce((a, b) => (b.atMs > a.atMs ? b : a));
    const history = firstTryHistory(ws, { sliceId: latest.sliceId, baselineModelId: latest.baselineModelId, firstTryModelId: latest.firstTryModelId });
    // The verdict a route would reach now: the same function and the same settings the router uses.
    const verdict = firstTryVerdict({ history, candidate: { breakEven: latest.breakEven, overheadMicroUsd: latest.overheadMicroUsd }, settings });
    groups.push({ sliceId: latest.sliceId, baselineModelId: latest.baselineModelId, firstTryModelId: latest.firstTryModelId, rows, latest, history, verdict, changeReason: history.state === null ? null : (kept.get(key) ?? null) });
  }
  return { groups: groups.sort((a, b) => (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : a.baselineModelId < b.baselineModelId ? -1 : a.baselineModelId > b.baselineModelId ? 1 : a.firstTryModelId < b.firstTryModelId ? -1 : 1)), settings };
}

const whole = (value: number | null): number | null => (value === null ? null : Math.round(value));

// ------------------------------------------------------------------------------------------ status

const noCounts = (): { firstTry: number; baselineFirst: number; learning: number } => ({ firstTry: 0, baselineFirst: 0, learning: 0 });

function countPhase(counts: { firstTry: number; baselineFirst: number; learning: number }, group: Group): void {
  const phase = firstTryPhase(group.verdict);
  if (phase === 'first-try') counts.firstTry += 1;
  else if (phase === 'baseline-first') counts.baselineFirst += 1;
  else counts.learning += 1;
}

/**
 * The `status` view: per harness the registry's first-try and baseline models and how many of this
 * workspace's slices start on the first try, start on the baseline or are still learning. `off` for
 * the whole view when `routing.firstTry` is `baseline`, and for a harness with no first-try step
 * (Antigravity: no cheaper active model, and its stronger one is a preview). With no workspace
 * (`ws` null) the counts are zero.
 */
export async function firstTryStatusView(input: { readonly home: string; readonly ws: WorkspaceServices | null; readonly setting: FirstTrySetting; readonly nowMs?: number }): Promise<FirstTryStatus> {
  const checked = await loadModelRegistryChecked({ home: input.home }).catch(() => ({ registry: null, reasonCode: 'MODEL_REGISTRY_UNREADABLE' as const }));
  const registry: ModelRegistry | null = checked.registry;
  const slices = input.ws === null ? [] : (await groupsOf(input.ws).catch(() => ({ groups: [] as readonly Group[] }))).groups;
  const other = noCounts();
  if (registry === null) {
    for (const group of slices) countPhase(other, group);
    return { setting: input.setting, unavailable: 'reasonCode' in checked ? checked.reasonCode : 'MODEL_REGISTRY_UNREADABLE', harnesses: [], other };
  }
  const policy = await loadRoutingPolicy({ home: input.home, registry }).catch(() => null);
  const volume = policy?.defaultTaskVolume ?? DEFAULT_TASK_VOLUME;
  const overhead = { verificationMicroUsd: policy?.assumptions.verificationMicroUsd ?? DEFAULT_COST_ASSUMPTIONS.verificationMicroUsd, ...(policy?.assumptions.cacheTransitionMicroUsd === undefined ? {} : { cacheTransitionMicroUsd: policy.assumptions.cacheTransitionMicroUsd }) };
  const nowMs = input.nowMs ?? Date.now();
  const harnesses: FirstTryStatus['harnesses'][number][] = [];
  const claimed = new Set<Group>();
  for (const row of registry.harnessDefaults ?? []) {
    if (!(HARNESS_IDS as readonly string[]).includes(row.harness) || harnesses.some((h) => h.harness === row.harness)) continue;
    const ladder = harnessFirstTry({ registry, harness: row.harness as HarnessId, volume, overhead, nowMs });
    const counts = noCounts();
    for (const group of slices) {
      if (group.baselineModelId !== ladder.baselineModelId) continue;
      claimed.add(group);
      countPhase(counts, group);
    }
    const off = input.setting === 'baseline';
    harnesses.push({
      harness: ladder.harness,
      state: off || !ladder.on ? 'off' : 'on',
      reasonCode: off ? 'FIRST_TRY_OFF' : ladder.on ? null : ladder.reasonCode,
      baselineModelId: ladder.baselineModelId,
      firstTryModelId: ladder.on ? ladder.candidate.modelId : null,
      strongerIsPreview: !ladder.on && ladder.strongerIsPreview,
      slices: counts,
    });
  }
  for (const group of slices) if (!claimed.has(group)) countPhase(other, group);
  return { setting: input.setting, unavailable: null, harnesses: harnesses.slice(0, 8), other };
}

// ------------------------------------------------------------------------------------------ explain

function groupView(group: Group, settings: LearningSettings): FirstTryGroup {
  const { history, verdict, rows, latest } = group;
  const ft = history.firstTry;
  const ctl = history.control;
  const started = { firstTry: rows.filter((r) => r.arm === 'first-try').length, control: rows.filter((r) => r.arm === 'control').length, open: rows.filter((r) => r.state === 'open').length };
  const total = started.firstTry + started.control;
  const next = nextTaskShare(verdict, firstTryShares(settings, history));
  const attempt = (a: { readonly sumMicroUsd: number; readonly n: number }) => ({ meanMicroUsd: a.n === 0 ? null : Math.round(a.sumMicroUsd / a.n), samples: a.n });
  return {
    baselineModelId: group.baselineModelId,
    firstTryModelId: group.firstTryModelId,
    verdict: firstTryPhase(verdict),
    reasonCode: verdict.reasonCode,
    lastChange: history.state === null || group.changeReason === null ? null : { mode: history.state.mode, reasonCode: group.changeReason, atFinished: history.state.changedAtFinished },
    started,
    firstTry: { finished: ft.tasks, verified: ft.verified, firstAttemptPass: ft.firstAttemptPass, firstAttemptFail: ft.firstAttemptFail, handedOff: ft.escalated },
    control: { finished: ctl.tasks, verified: ctl.verified },
    controlShare: { observed: total === 0 ? null : started.control / total, nextTaskArm: next.arm, nextTaskShare: next.share },
    breakEven: { value: verdict.breakEven, basis: verdict.breakEvenBasis, overheadMicroUsd: Math.round(latest.overheadMicroUsd), firstAttempt: attempt(ft.firstAttemptCost), stepUpAttempt: attempt(ft.stepUpAttemptCost) },
    pBelowBreakEven: verdict.pBelowBreakEven,
    pWorseThanBaseline: verdict.pWorseThanBaseline,
    costPerVerified: { firstTryMicroUsd: whole(verdict.costPerVerifiedFirstTry), controlMicroUsd: whole(verdict.costPerVerifiedControl), estimate: ft.estimate || ctl.estimate },
    thresholds: { demoteAbove: settings.deactivateAbove, reinstateBelow: settings.activateBelow, minFinishedToReinstate: settings.minLocalPerArm, antiFlapFloor: settings.flapFloor, margin: settings.nonInferiorityMargin },
  };
}

/** The `explain --slice` view: one group per baseline and first-try model this slice has a ledger row for; none when no first-try task has run for it. */
export async function firstTrySliceView(input: { readonly ws: WorkspaceServices; readonly sliceId: string; readonly setting: FirstTrySetting }): Promise<FirstTrySliceView> {
  const { groups, settings } = await groupsOf(input.ws, input.sliceId);
  return { sliceId: input.sliceId, setting: input.setting, groups: groups.slice(0, GROUPS_MAX).map((group) => groupView(group, settings)) };
}

/**
 * The sidecar's `explain` op with the slice's first-try view added to the trace when the request
 * names a slice (`sliceId`). The answer is checked against the surface contract; one that does not
 * fit is sent without the view. Any other request, and any failure to read the ledger, passes
 * through unchanged.
 */
export function withFirstTryExplain(definition: SidecarOpDefinition, setting: (ctx: SidecarOpContext) => FirstTrySetting | Promise<FirstTrySetting>): SidecarOpDefinition {
  return {
    ...definition,
    async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
      const outcome = await definition.handle(ctx);
      try {
        const slice = isPlain(ctx.body) ? own(ctx.body, 'sliceId') : undefined;
        if (!outcome.ok || typeof slice !== 'string' || !isId(slice) || ctx.workspace.root === null || !isPlain(outcome.body)) return outcome;
        const trace = own(outcome.body, 'trace');
        if (!isPlain(trace)) return outcome;
        const ws = openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(isId(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
        const view = await firstTrySliceView({ ws, sliceId: slice, setting: await setting(ctx) });
        const next = { ...outcome.body, trace: { ...trace, firstTry: view } };
        return surfacePayloadContract('explain').validate(next).ok ? { ...outcome, body: next } : outcome;
      } catch {
        return outcome;
      }
    },
  };
}

// ------------------------------------------------------------------------------------- cost report

export interface FirstTryCostGroup {
  readonly sliceId: string;
  readonly baselineModelId: string;
  readonly firstTryModelId: string;
  /** First-try tasks started (finished or not), handed up once, and completed on the first attempt (verified, no hand-off). */
  readonly started: number;
  readonly handedUp: number;
  readonly completedOnFirstTry: number;
  readonly finished: number;
  readonly verified: number;
  /** Control tasks (baseline first) finished and verified: the baseline estimate's sample. */
  readonly controlFinished: number;
  readonly controlVerified: number;
  /** Every attempt's cost over the finished first-try tasks, integer micro-USD; null when any attempt's cost is unknown. */
  readonly spentMicroUsd: number | null;
  /** The control's cost per verified task times this group's verified first-try tasks; null without a control with a verified task and known costs. */
  readonly baselineEstimateMicroUsd: number | null;
  /** Baseline estimate minus spent: positive saved, negative spent more; null when either is unknown. */
  readonly savedMicroUsd: number | null;
  readonly estimate: boolean;
}

export interface FirstTryCostView {
  readonly setting: FirstTrySetting;
  readonly started: number;
  readonly open: number;
  readonly handedUp: number;
  readonly completedOnFirstTry: number;
  readonly finished: number;
  readonly verified: number;
  readonly controlStarted: number;
  readonly controlVerified: number;
  /** Groups with a finished first-try task, and how many of them have both figures (the money totals cover only those). */
  readonly slices: number;
  readonly compared: number;
  readonly spentMicroUsd: number | null;
  readonly baselineEstimateMicroUsd: number | null;
  readonly savedMicroUsd: number | null;
  /** True when any counted cost is an API-equivalent estimate (a subscription run), not billed dollars. */
  readonly estimate: boolean;
  readonly groups: readonly FirstTryCostGroup[];
}

/** The cost-report view of a workspace with no first-try task: all counts zero, no figure. */
export function emptyFirstTryCostView(setting: FirstTrySetting): FirstTryCostView {
  return { setting, started: 0, open: 0, handedUp: 0, completedOnFirstTry: 0, finished: 0, verified: 0, controlStarted: 0, controlVerified: 0, slices: 0, compared: 0, spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, estimate: false, groups: [] };
}

/**
 * The `cost-report` view: how many tasks started on the first try, were handed up and completed on
 * the first try, and the spend of the first-try tasks against the baseline estimate, which is the
 * control share's measured cost per verified task (the tasks the route ran baseline first) times
 * the verified first-try tasks. A figure is null where its data does not exist.
 */
export async function firstTryCostView(input: { readonly ws: WorkspaceServices; readonly setting: FirstTrySetting }): Promise<FirstTryCostView> {
  const { groups } = await groupsOf(input.ws);
  const out: FirstTryCostGroup[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((r) => r.arm === 'first-try');
    const ft = group.history.firstTry;
    const ctl = group.history.control;
    const spent = ft.tasks > 0 && ft.costKnownTasks === ft.tasks ? Math.round(ft.costMicroUsd) : null;
    const controlPerVerified = costPerVerified(ctl);
    const baselineEstimate = ft.tasks > 0 && controlPerVerified !== null ? Math.round(controlPerVerified * ft.verified) : null;
    out.push({
      sliceId: group.sliceId,
      baselineModelId: group.baselineModelId,
      firstTryModelId: group.firstTryModelId,
      started: rows.length,
      handedUp: rows.filter((r) => r.handedOffTo !== null).length,
      completedOnFirstTry: rows.filter((r) => r.state === 'verified' && r.handedOffTo === null).length,
      finished: ft.tasks,
      verified: ft.verified,
      controlFinished: ctl.tasks,
      controlVerified: ctl.verified,
      spentMicroUsd: spent,
      baselineEstimateMicroUsd: baselineEstimate,
      savedMicroUsd: spent === null || baselineEstimate === null ? null : baselineEstimate - spent,
      estimate: ft.estimate || ctl.estimate,
    });
  }
  const sum = (pick: (g: FirstTryCostGroup) => number): number => out.reduce((total, g) => total + pick(g), 0);
  const comparable = out.filter((g) => g.finished > 0);
  const compared = comparable.filter((g) => g.savedMicroUsd !== null);
  const all = firstTryRows(input.ws);
  return {
    setting: input.setting,
    started: sum((g) => g.started),
    open: all.filter((r) => r.state === 'open').length,
    handedUp: sum((g) => g.handedUp),
    completedOnFirstTry: sum((g) => g.completedOnFirstTry),
    finished: sum((g) => g.finished),
    verified: sum((g) => g.verified),
    controlStarted: all.filter((r) => r.arm === 'control').length,
    controlVerified: sum((g) => g.controlVerified),
    slices: comparable.length,
    compared: compared.length,
    spentMicroUsd: compared.length === 0 ? null : compared.reduce((total, g) => total + (g.spentMicroUsd ?? 0), 0),
    baselineEstimateMicroUsd: compared.length === 0 ? null : compared.reduce((total, g) => total + (g.baselineEstimateMicroUsd ?? 0), 0),
    savedMicroUsd: compared.length === 0 ? null : compared.reduce((total, g) => total + (g.savedMicroUsd ?? 0), 0),
    estimate: compared.some((g) => g.estimate),
    groups: out.slice(0, COST_GROUPS_MAX),
  };
}

/** The workspace a sidecar request names, or null for the global workspace. */
export function firstTryWorkspaceOf(ctx: Pick<SidecarOpContext, 'home' | 'workspace' | 'store'>): WorkspaceServices | null {
  if (ctx.workspace.root === null || ctx.workspace.id === 'global') return null;
  return openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspace.root, ...(isId(ctx.workspace.id) ? { workspaceId: ctx.workspace.id } : {}), store: ctx.store });
}
