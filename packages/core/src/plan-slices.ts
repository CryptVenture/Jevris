/**
 * Slice suggestions for the tasks of a plan (owner decision 2026-10-01, Jev as an active decision
 * aid). `jevris plan` and `jevris plan --submit` label each task with the slice and risk the route
 * classifier would give it, so a person reading the plan sees them beside the task.
 *
 * - A label for a person, nothing more. It never changes the plan, the task graph or what is
 *   submitted, never becomes a learned arm or a signed prior, and never actuates.
 * - The evidence is the one the route classifier uses: a task's own write scopes, acceptance check
 *   ids and title, reduced to counts, categories and codes. No path name leaves, and the title only
 *   as one screened evidence span when the administrator approved source egress.
 * - Rules answer first where they are sure; Jev is asked for the rest, with the route's gates
 *   (confidence 0.6, margin 0.15, risk score 2 or less; a protected path gets no slice and high risk).
 * - A plan is bounded: at most `PLAN_MAX_JEV_CALLS` distinct questions per plan (the rest get the
 *   rules answer, `PLAN_JEV_CAP`), asked in parallel inside one shared deadline (`PLAN_JEV_DEADLINE`
 *   for any still out at the end), identical tasks sharing one question and the engine's decision
 *   cache. Every miss, and an off or absent engine, is the rules answer with a reason code.
 * - A slice the plan declared is kept as given. The classifier still runs on it, and the two are
 *   recorded together (`SLICE_AGREE` or `SLICE_DIFFER`), so the outcome join can later score Jev
 *   against a plan-declared slice.
 * - One advisory `slice-classify` decision per task, with the task's id, joined to its outcome
 *   through the decision/outcome ledger. A repeated check of the same task and result records once.
 */
import { createHash } from 'node:crypto';
import { modeAllows, type Mode } from '@jevris/contracts';
import type { DecisionEngine } from './decision-engine.js';
import type { IntentContext } from './intent-decisions.js';
import { classifyTaskSlice, recordSliceClassification, sliceFeatures, sliceNeedsJev, type SliceAssist, type SliceClassification, type SliceFeatures, type SliceRisk } from './slice-classifier.js';
import { sliceCodeOf } from './slice-explain.js';

/** The most distinct questions one plan asks Jev; the rest of its tasks get the rules answer. */
export const PLAN_MAX_JEV_CALLS = 8;
/** The most tasks one plan labels (the most `plan --submit` takes). */
export const PLAN_MAX_TASKS = 256;
/** The longest a plan waits for Jev, in ms: the route's own wait, inside the hot budget. */
export const PLAN_SLICE_WAIT_MS = 700;
/** Time kept back from the request's remaining time for the rest of the answer, in ms. */
export const PLAN_SLICE_MARGIN_MS = 150;
/** Below this many ms to wait, Jev is not asked: a call cannot finish. */
export const PLAN_MIN_DEADLINE_MS = 150;

const SLICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECORD_BATCH = 8;
const DEFAULT_RECORD_GRACE_MS = 250;

/** What a plan says of one task, all optional. Nothing here is sent as text unless said. */
export interface PlanSliceTask {
  readonly id: string;
  /** Free text. Reduced to a verb class locally; sent only as a screened evidence span with egress approved. */
  readonly title?: string | null;
  /** The task's write scopes. Reduced to counts and categories; names are never sent. */
  readonly paths?: readonly string[] | null;
  /** The task's acceptance check ids. Reduced to kinds and a count. */
  readonly checkIds?: readonly string[] | null;
  /** The slice the plan declared for the task, when it did. */
  readonly sliceId?: string | null;
}

export type PlanSliceSource = 'given' | 'rules' | 'jev' | 'none';

export interface PlanSliceSuggestion {
  readonly taskId: string;
  /** The slice shown: the plan's own when it declared one, else the suggestion; null when none. */
  readonly slice: string | null;
  /** `given` (the plan declared it), `rules`, `jev`, or `none`. */
  readonly source: PlanSliceSource;
  /** The higher of the rules' hint and Jev's score; Jev can only raise it. */
  readonly risk: SliceRisk;
  readonly confidencePercent: number | null;
  /** Why the classifier answered as it did (`SLICE_*`, `PLAN_JEV_*`), content-free. */
  readonly reasonCode: string;
  /** The recorded advisory decision (`jevris explain` shows it); null when none was recorded. */
  readonly decisionId: string | null;
  /** Only for a declared slice: what the classifier said, who said it, and whether it agrees (null: no slice to compare). */
  readonly suggestedSlice?: string | null;
  readonly suggestedBy?: 'rules' | 'jev' | 'none';
  readonly agrees?: boolean | null;
}

/** Decisions already recorded for a task and result, so a repeated check records once. */
export interface PlanSliceMemory {
  get(key: string): string | null | undefined;
  set(key: string, decisionId: string | null): void;
}

export function createPlanSliceMemory(max = 4096): PlanSliceMemory {
  const seen = new Map<string, string | null>();
  const cap = Math.max(16, max);
  return {
    get: (key) => seen.get(key),
    set(key, decisionId) {
      seen.delete(key);
      seen.set(key, decisionId);
      if (seen.size > cap) {
        const oldest = seen.keys().next();
        if (oldest.done !== true) seen.delete(oldest.value);
      }
    },
  };
}

/** One per engine, so a repeated check of the same plan records once; a new engine (a restarted sidecar) records anew. */
const ENGINE_MEMORY = new WeakMap<object, PlanSliceMemory>();

function memoryOf(engine: DecisionEngine | null): PlanSliceMemory {
  if (engine === null) return createPlanSliceMemory(16);
  let memory = ENGINE_MEMORY.get(engine);
  if (memory === undefined) {
    memory = createPlanSliceMemory();
    ENGINE_MEMORY.set(engine, memory);
  }
  return memory;
}

export interface PlanSliceOptions {
  readonly assist: SliceAssist;
  /** The effective mode; absent reads as observe. Below observe nothing is asked or recorded. */
  readonly mode?: Mode;
  /** The kill switch was stopped when the request arrived: rules only, nothing recorded. */
  readonly killSwitchStopped?: boolean;
  /** How long the plan waits for Jev, in ms, shared by every question; past it the rules answers stand. */
  readonly deadlineMs: number;
  /** The longest the whole step may take, asks and records, in ms (default `deadlineMs` plus 250). */
  readonly totalMs?: number;
  /** The most distinct questions asked (default `PLAN_MAX_JEV_CALLS`). */
  readonly maxJevCalls?: number;
  /** Record one advisory decision per task (default true). */
  readonly record?: boolean;
  readonly memory?: PlanSliceMemory;
  /** The clock; tests inject one. */
  readonly now?: () => number;
}

export interface PlanSliceContext {
  readonly workspaceId: string;
  readonly evidenceRevision: string;
  readonly sessionId?: string | null;
}

/** The wait and the total for a request that has `remainingMs` left: Jev never holds the op past it. */
export function planSliceTimes(remainingMs: number): { readonly deadlineMs: number; readonly totalMs: number } {
  const left = Number.isFinite(remainingMs) ? Math.floor(remainingMs) : 0;
  const totalMs = Math.max(0, left - PLAN_SLICE_MARGIN_MS);
  return { deadlineMs: Math.max(0, Math.min(PLAN_SLICE_WAIT_MS, totalMs - 100)), totalMs };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The slice evidence of a plan's raw tasks, in the plan's order (`order` is the validated
 * topological order). A task may carry scheduling fields beside its node (`title`, `sliceId`); they
 * are read here and nowhere in the node check. A task that is not an object is left out.
 */
export function planSliceTasksOf(rawTasks: readonly unknown[], order: readonly string[]): PlanSliceTask[] {
  const byId = new Map<string, PlanSliceTask>();
  for (const raw of rawTasks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const id = own(r, 'id');
    if (typeof id !== 'string') continue;
    const title = own(r, 'title');
    const sliceId = own(r, 'sliceId');
    byId.set(id, {
      id,
      title: typeof title === 'string' ? title : null,
      paths: strings(own(r, 'writeScopes')),
      checkIds: strings(own(r, 'acceptanceCheckIds')),
      sliceId: typeof sliceId === 'string' && SLICE_ID.test(sliceId) ? sliceId : null,
    });
  }
  return order.flatMap((id) => byId.get(id) ?? []);
}

function featureKey(features: SliceFeatures, title: string): string {
  return JSON.stringify([features, title]);
}

function memoryKey(workspaceId: string, taskId: string, group: string, declared: string | null, r: SliceClassification): string {
  return createHash('sha256').update(JSON.stringify([workspaceId, taskId, group, declared, r.source, r.sliceId, r.risk, r.reasonCode])).digest('hex').slice(0, 40);
}

interface Group {
  readonly key: string;
  readonly features: SliceFeatures;
  readonly hints: { readonly title: string | null; readonly paths: readonly string[]; readonly checkIds: readonly string[] };
  readonly leader: number;
  assist: SliceAssist;
  skip: string | null;
  asks: boolean;
}

/**
 * Labels each task of a plan with a slice and a risk. Never throws and never waits past
 * `options.deadlineMs` for Jev: any failure is the rules answer with a reason code. The result holds
 * one entry per labelled task (the first `PLAN_MAX_TASKS`), in the order given.
 */
export async function suggestPlanSlices(engine: DecisionEngine | null, tasks: readonly PlanSliceTask[], ctx: PlanSliceContext, options: PlanSliceOptions): Promise<PlanSliceSuggestion[]> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const list = tasks.slice(0, PLAN_MAX_TASKS);
  if (list.length === 0) return [];
  const mode: Mode = options.mode ?? 'observe';
  const stopped = options.killSwitchStopped === true;
  const modeOk = modeAllows(mode, 'record');
  const canAsk = engine !== null && options.assist === 'classify' && !stopped && modeOk;
  const recordable = options.record !== false && engine !== null && engine.recordAdvice !== undefined && !stopped && modeOk;
  const egressApproved = engine !== null && (engine.sourceEgress?.() ?? 'denied') === 'approved';
  const deadlineMs = Number.isFinite(options.deadlineMs) ? Math.max(0, Math.floor(options.deadlineMs)) : 0;
  const totalMs = options.totalMs !== undefined && Number.isFinite(options.totalMs) ? Math.max(0, Math.floor(options.totalMs)) : deadlineMs + DEFAULT_RECORD_GRACE_MS;
  const maxCalls = Math.max(0, Math.floor(options.maxJevCalls ?? PLAN_MAX_JEV_CALLS));
  const memory = options.memory ?? memoryOf(engine);

  // One group per distinct set of features (and, with egress approved, title): identical tasks share one question.
  const declaredOf = (task: PlanSliceTask): string | null => (typeof task.sliceId === 'string' && SLICE_ID.test(task.sliceId) ? task.sliceId : null);
  const groups = new Map<string, Group>();
  const groupOfTask: string[] = [];
  // Tasks that declared no slice come first, so the cap serves the suggestions a person reads.
  const priority = list.map((_, i) => i).sort((a, b) => Number(declaredOf(list[a] as PlanSliceTask) !== null) - Number(declaredOf(list[b] as PlanSliceTask) !== null) || a - b);
  const features = list.map((task) => sliceFeatures({ title: task.title ?? null, paths: task.paths ?? null, checkIds: task.checkIds ?? null }));
  for (const i of priority) {
    const task = list[i] as PlanSliceTask;
    const f = features[i] as SliceFeatures;
    const title = typeof task.title === 'string' ? task.title.trim().slice(0, 300) : '';
    const key = featureKey(f, egressApproved ? title : '');
    groupOfTask[i] = key;
    if (!groups.has(key)) {
      groups.set(key, { key, features: f, hints: { title: task.title ?? null, paths: task.paths ?? [], checkIds: task.checkIds ?? [] }, leader: i, assist: 'classify', skip: null, asks: false });
    }
  }

  let used = 0;
  for (const g of groups.values()) {
    if (options.assist === 'off') {
      g.assist = 'off';
    } else if (stopped) {
      g.skip = 'PLAN_JEV_KILL_SWITCH';
    } else if (!modeOk) {
      g.skip = 'PLAN_JEV_MODE_OFF';
    } else if (canAsk && sliceNeedsJev(g.features)) {
      if (used >= maxCalls) g.skip = 'PLAN_JEV_CAP';
      else if (deadlineMs < PLAN_MIN_DEADLINE_MS) g.skip = 'PLAN_JEV_NO_TIME';
      else {
        used += 1;
        g.asks = true;
      }
    }
  }

  const intent: IntentContext = { workspaceId: ctx.workspaceId, evidenceRevision: ctx.evidenceRevision, deadlineMs: Math.max(1, deadlineMs) };
  const results = new Map<string, SliceClassification>();
  const runs = [...groups.values()].map(async (g) => {
    try {
      const r = await classifyTaskSlice(engine, g.hints, intent, { assist: g.assist, record: false, now, ...(g.skip === null ? {} : { skipAsk: g.skip }) });
      results.set(g.key, r);
    } catch {
      // Left out of `results`: the rules answer below.
    }
  });
  if ([...groups.values()].some((g) => g.asks)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), deadlineMs + 50);
    });
    try {
      await Promise.race([Promise.all(runs), late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } else {
    await Promise.all(runs);
  }
  // What had answered by now; an answer that arrives after this is not used.
  const settled = new Map(results);
  // A question still out at the deadline, or one that failed: the rules answer, no model.
  for (const g of groups.values()) {
    if (settled.has(g.key)) continue;
    settled.set(g.key, await classifyTaskSlice(null, g.hints, intent, { assist: 'classify', record: false, skipAsk: g.asks ? 'PLAN_JEV_DEADLINE' : 'SLICE_ERROR' }));
  }

  const out: PlanSliceSuggestion[] = [];
  const pending: { readonly index: number; readonly r: SliceClassification; readonly extra: readonly string[]; readonly key: string; readonly elapsed: number; readonly taskId: string }[] = [];
  list.forEach((task, i) => {
    const key = groupOfTask[i] as string;
    const group = groups.get(key) as Group;
    const base = settled.get(key) as SliceClassification;
    const leader = group.leader === i;
    // A follower shares the leader's question: its answer came from the same ask.
    const r: SliceClassification = leader ? base : { ...base, ...(base.asked ? { cacheHit: true } : {}), latencyMs: null };
    const declared = declaredOf(task);
    const agrees = declared === null || r.sliceId === null ? null : r.sliceId === declared;
    const extra = ['SLICE_PLAN_TASK', ...(declared === null ? [] : [`SLICE_GIVEN_${sliceCodeOf(declared)}`, ...(agrees === null ? [] : [agrees ? 'SLICE_AGREE' : 'SLICE_DIFFER'])])];
    const mkey = memoryKey(ctx.workspaceId, task.id, key, declared, r);
    const remembered = recordable ? memory.get(mkey) : undefined;
    if (recordable && remembered === undefined) pending.push({ index: i, r, extra, key: mkey, elapsed: leader ? (r.latencyMs ?? 0) : 0, taskId: task.id });
    out[i] = {
      taskId: task.id,
      slice: declared ?? r.sliceId,
      source: declared === null ? r.source : 'given',
      risk: r.risk,
      confidencePercent: r.confidence === null ? null : Math.round(r.confidence * 100),
      reasonCode: r.reasonCode,
      decisionId: remembered ?? null,
      ...(declared === null ? {} : { suggestedSlice: r.sliceId, suggestedBy: r.source, agrees }),
    };
  });

  // One advisory decision per task, in small parallel batches, and none once the step's time is used.
  for (let at = 0; at < pending.length; at += RECORD_BATCH) {
    if (now() - started >= totalMs) break;
    await Promise.all(
      pending.slice(at, at + RECORD_BATCH).map(async (p) => {
        try {
          const recorded = await recordSliceClassification(engine, p.r, { workspaceId: ctx.workspaceId, evidenceRevision: ctx.evidenceRevision, taskId: p.taskId, ...(typeof ctx.sessionId === 'string' ? { sessionId: ctx.sessionId } : {}) }, p.elapsed, p.extra);
          if (recorded.decisionId !== null) {
            memory.set(p.key, recorded.decisionId);
            out[p.index] = { ...(out[p.index] as PlanSliceSuggestion), decisionId: recorded.decisionId };
          }
        } catch {
          // Not recorded: the label stands without a decision id.
        }
      }),
    );
  }
  return out;
}
