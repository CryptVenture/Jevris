/**
 * Subagent outcomes, timing only (audit P13; owner decisions DOMAINS 9ce2ba5 and 7922ee3).
 *
 * For each subagent a harness reports, D keeps one row in collection `subagent-runs`, keyed by
 * harness, parent session and agent id. Every adapter reports a subagent the same way
 * (`worker.started` and `worker.finished` under the parent session, with the subagent's agent id):
 * Claude Code and Codex from SubagentStart and SubagentStop (with `agent_type`), Kilo and OpenCode
 * from a child session's `session.created` (naming `parentID`) and its idle, and Antigravity with
 * whatever arrives. The row holds: the subagent type and its slice (`subagentSliceId`), when it started
 * and stopped, the route C gave its launch (outcome and reason code, from C's in-memory note taken
 * at SubagentStart: `takeSubagentRoute`) when known, `not-applicable` on a harness whose subagent
 * model no route can set (C's SUBAGENT_ROUTE_HARNESSES: Claude Code, Codex, Kilo and OpenCode can;
 * Antigravity cannot), the model a Kilo or OpenCode child reported running, and whether the
 * parent's Stop later verified. Ids, codes and times only: no transcript is read and no prompt,
 * description or output is kept.
 *
 * R20 (C d4351f9): the hooks report no subagent cost or result, so a subagent's only label is its
 * parent's verification receipt. When the parent's Stop reads a verdict from a mandatory check's
 * receipt, each subagent of that session that had stopped is recorded once, as an observational
 * outcome (never explored, never a promotion on its own) under C's `subagentLearningKey`, on the
 * model it ran: the model it reported, else the routed model of a rendered route, else the
 * harness's baseline when the launch named no model. A launch that named a model or ran pinned is
 * never recorded (the person chose it).
 */
import { BUNDLED_MODEL_REGISTRY, SUBAGENT_ROUTE_HARNESSES, SUBAGENT_ROUTE_OUTCOMES, loadModelRegistry, routeBaseline, subagentSliceId, takeSubagentRoute, type SubagentRouteOutcome } from '@jevris/core';
import { recordSubagentOutcome } from './learning.js';
import { HARNESS_IDS, type HarnessId } from '@jevris/contracts';
import { resolveRunSpelling } from './model-spelling.js';
import type { WorkspaceServices } from '../workspace.js';
import { recordKey } from '../util.js';

export const SUBAGENT_RUNS = 'subagent-runs';
/** Rows kept per workspace; the oldest are dropped first. */
export const SUBAGENT_RUNS_MAX = 2048;
/** Subagent types listed in a summary (most runs first). */
const SUMMARY_TYPES_MAX = 32;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Whether C can route a subagent launch on this harness (a non-null actuator); elsewhere the route is not applicable. */
function routable(harness: string): boolean {
  return (SUBAGENT_ROUTE_HARNESSES as readonly string[]).includes(harness);
}

export interface SubagentRouteNote {
  readonly outcome: SubagentRouteOutcome;
  readonly reasonCode: string;
  /** The registry model the route proposed (C's note, c640d8c): set for a proposed, rendered or explained route. */
  readonly modelId?: string | null;
}

/** The parent's verdict a subagent is labelled with: a mandatory check's receipt. */
export interface SubagentVerdict {
  readonly kind: 'verified-pass' | 'verified-fail';
  readonly receiptId: string;
}

export interface SubagentRunRecord {
  readonly workspaceId: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly agentId: string;
  /** The harness's subagent type when it is a safe slice key, else null. */
  readonly subagentType: string | null;
  readonly sliceId: string | null;
  /** Null when only the stop was seen (the start came before Jevris). */
  readonly startedAtMs: number | null;
  /** The latest SubagentStop; null while it runs. */
  readonly stoppedAtMs: number | null;
  readonly stops: number;
  /** C's route note; `not-applicable` off Claude Code; null when no note was found. */
  readonly route: SubagentRouteNote | 'not-applicable' | null;
  /** The parent session's first verified Stop after this subagent stopped. */
  readonly parentVerifiedAtMs: number | null;
  /** The registry model a Kilo or OpenCode child reported running (message.completed), if any. */
  readonly reportedModel?: string | null;
  /** R42: the spelling the child reported and the host that served it (with `reportedModel`). */
  readonly reportedRaw?: string | null;
  readonly servingHost?: string | null;
  /** R20: the label recorded for this subagent (once), or why it was not recorded. */
  readonly learned?: { readonly kind: SubagentVerdict['kind']; readonly receiptId: string; readonly reasonCode: string } | null;
  readonly atMs: number;
}

const pending = new Set<Promise<unknown>>();

/** Runs a subagent record off the hook's answer path: it never delays or fails the answer. */
export function subagentInBackground(work: Promise<unknown>): void {
  const p = work.catch(() => undefined);
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Waits for background subagent records (tests and orderly shutdown). */
export async function drainSubagentRuns(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

function typeOf(agentType: unknown): { readonly subagentType: string | null; readonly sliceId: string | null } {
  if (typeof agentType !== 'string') return { subagentType: null, sliceId: null };
  const sliceId = subagentSliceId(agentType);
  return sliceId === null ? { subagentType: null, sliceId: null } : { subagentType: agentType, sliceId };
}

function routeOf(route: SubagentRouteNote | null | undefined): SubagentRouteNote | null {
  if (route === null || route === undefined) return null;
  if (!(SUBAGENT_ROUTE_OUTCOMES as readonly string[]).includes(route.outcome) || !REASON.test(route.reasonCode)) return null;
  const modelId: unknown = Reflect.get(route, 'modelId');
  return { outcome: route.outcome, reasonCode: route.reasonCode, ...(typeof modelId === 'string' && MODEL_ID.test(modelId) ? { modelId } : {}) };
}

const keyOf = (workspaceId: string, harness: string, sessionId: string, agentId: string): string => recordKey(workspaceId, harness, sessionId, agentId);

async function write(ws: WorkspaceServices, harness: string, sessionId: string, agentId: string, change: (prior: SubagentRunRecord | undefined) => SubagentRunRecord | null): Promise<SubagentRunRecord | null> {
  const k = keyOf(ws.workspaceId, harness, sessionId, agentId);
  return ws.hook.transact((tx) => {
    const next = change(tx.get<SubagentRunRecord>(SUBAGENT_RUNS, k));
    if (next === null) return null;
    tx.put(SUBAGENT_RUNS, k, next);
    const mine = tx
      .list<SubagentRunRecord>(SUBAGENT_RUNS)
      .filter((r) => r.workspaceId === ws.workspaceId)
      .sort((a, b) => b.atMs - a.atMs);
    for (const old of mine.slice(SUBAGENT_RUNS_MAX)) tx.delete(SUBAGENT_RUNS, keyOf(old.workspaceId, old.harness, old.sessionId, old.agentId));
    return next;
  });
}

function valid(harness: string, sessionId: string | null, agentId: string | null): sessionId is string {
  return HARNESS.test(harness) && sessionId !== null && agentId !== null && AGENT_ID.test(sessionId) && AGENT_ID.test(agentId);
}

/** SubagentStart: a subagent began in the parent session. A repeat start keeps the first time. */
export function noteSubagentStart(
  ws: WorkspaceServices,
  input: { readonly harness: string; readonly sessionId: string | null; readonly agentId: string | null; readonly agentType?: unknown; readonly nowMs: number },
): Promise<SubagentRunRecord | null> {
  const { harness, sessionId, agentId } = input;
  if (!valid(harness, sessionId, agentId) || agentId === null) return Promise.resolve(null);
  const type = typeOf(input.agentType);
  // C's note for this launch (PreToolUse and SubagentStart share no id): the oldest unclaimed one
  // for the session and type. Claimed only on a first start, so a repeat start takes nothing.
  const known = ws.state.get<SubagentRunRecord>(SUBAGENT_RUNS, keyOf(ws.workspaceId, harness, sessionId, agentId));
  const route: SubagentRunRecord['route'] =
    !routable(harness) ? 'not-applicable' : routeOf(known === undefined && type.subagentType !== null ? takeSubagentRoute(ws.workspaceId, sessionId, type.subagentType, input.nowMs) : null);
  return write(ws, harness, sessionId, agentId, (prior) => ({
    workspaceId: ws.workspaceId,
    harness,
    sessionId,
    agentId,
    subagentType: prior?.subagentType ?? type.subagentType,
    sliceId: prior?.sliceId ?? type.sliceId,
    startedAtMs: prior?.startedAtMs ?? input.nowMs,
    stoppedAtMs: prior?.stoppedAtMs ?? null,
    stops: prior?.stops ?? 0,
    route: prior?.route ?? route,
    parentVerifiedAtMs: prior?.parentVerifiedAtMs ?? null,
    atMs: input.nowMs,
  }));
}

/** SubagentStop: the subagent stopped (the latest stop wins; a stop-hook continuation stops again). */
export function noteSubagentStop(
  ws: WorkspaceServices,
  input: { readonly harness: string; readonly sessionId: string | null; readonly agentId: string | null; readonly agentType?: unknown; readonly nowMs: number },
): Promise<SubagentRunRecord | null> {
  const { harness, sessionId, agentId } = input;
  if (!valid(harness, sessionId, agentId) || agentId === null) return Promise.resolve(null);
  const type = typeOf(input.agentType);
  return write(ws, harness, sessionId, agentId, (prior) => ({
    workspaceId: ws.workspaceId,
    harness,
    sessionId,
    agentId,
    subagentType: prior?.subagentType ?? type.subagentType,
    sliceId: prior?.sliceId ?? type.sliceId,
    startedAtMs: prior?.startedAtMs ?? null,
    stoppedAtMs: input.nowMs,
    stops: (prior?.stops ?? 0) + 1,
    route: prior?.route ?? (!routable(harness) ? 'not-applicable' : null),
    parentVerifiedAtMs: prior?.parentVerifiedAtMs ?? null,
    atMs: input.nowMs,
  }));
}

/** The parent session's Stop verified: every subagent of it that had stopped before now is marked. */
export async function noteSubagentParentVerified(ws: WorkspaceServices, harness: string, sessionId: string | null, nowMs: number): Promise<number> {
  if (sessionId === null) return 0;
  const open = (r: SubagentRunRecord) => r.workspaceId === ws.workspaceId && r.harness === harness && r.sessionId === sessionId && r.stoppedAtMs !== null && r.stoppedAtMs <= nowMs && r.parentVerifiedAtMs === null;
  if (!ws.state.list<SubagentRunRecord>(SUBAGENT_RUNS).some(open)) return 0;
  return ws.hook.transact((tx) => {
    let n = 0;
    for (const r of tx.list<SubagentRunRecord>(SUBAGENT_RUNS).filter(open)) {
      tx.put(SUBAGENT_RUNS, keyOf(r.workspaceId, r.harness, r.sessionId, r.agentId), { ...r, parentVerifiedAtMs: nowMs });
      n += 1;
    }
    return n;
  });
}

/**
 * A Kilo or OpenCode child session named the model that answered (message.completed): kept on its
 * subagent run as the registry model, with the raw spelling and the host that served it (R42,
 * `resolveRunSpelling`), the model the subagent ran. Only a run already recorded is updated, and
 * only the first model counts.
 */
export async function noteSubagentModel(
  ws: WorkspaceServices,
  input: { readonly harness: string; readonly sessionId: string | null; readonly agentId: string | null; readonly model: string | null; readonly nowMs: number },
): Promise<string | null> {
  const { harness, sessionId, agentId, model } = input;
  if (!valid(harness, sessionId, agentId) || agentId === null || model === null) return null;
  const known = ws.state.get<SubagentRunRecord>(SUBAGENT_RUNS, keyOf(ws.workspaceId, harness, sessionId, agentId));
  if (known === undefined || (known.reportedModel ?? null) !== null) return null;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) return null;
  const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const run = resolveRunSpelling(registry, harness as HarnessId, model);
  if (run === null || !MODEL_ID.test(run.modelId)) return null;
  await write(ws, harness, sessionId, agentId, (prior) =>
    prior === undefined || (prior.reportedModel ?? null) !== null ? null : { ...prior, reportedModel: run.modelId, reportedRaw: run.raw, servingHost: run.servingHost },
  );
  return run.modelId;
}

/** Why a subagent is not labelled: the person chose its model, or what it ran is not known. */
function modelRan(row: SubagentRunRecord, baseline: string): { readonly modelId: string } | { readonly skip: string } {
  const route = row.route === 'not-applicable' ? null : row.route;
  if (route !== null && (route.reasonCode === 'EXPLICIT_MODEL' || route.reasonCode === 'PINNED')) return { skip: route.reasonCode };
  if ((row.reportedModel ?? null) !== null) return { modelId: row.reportedModel as string };
  if (route === null) return { skip: 'NO_ROUTE_NOTE' };
  // C's note names the model a route proposed (c640d8c); only a rendered route ran it.
  if (route.outcome === 'rendered') return typeof route.modelId === 'string' ? { modelId: route.modelId } : { skip: 'ROUTED_MODEL_UNKNOWN' };
  // The route set nothing (it abstained or only explained): the launch named no model, so the
  // subagent ran the harness's default.
  if (route.outcome === 'abstained' || route.outcome === 'explained') return { modelId: baseline };
  return { skip: 'ROUTE_NOT_SETTLED' };
}

/**
 * R20: the parent session's Stop read a verdict from a mandatory check's receipt. Each subagent
 * of that session that had stopped by then and has no label yet is labelled once with it, and
 * recorded (in the background) as an observational outcome under C's subagentLearningKey.
 */
export async function learnSubagentOutcomes(
  ws: WorkspaceServices,
  input: { readonly harness: string; readonly sessionId: string | null; readonly taskId: string | null; readonly risk: string; readonly verdict: SubagentVerdict; readonly nowMs: number },
): Promise<number> {
  const { harness, sessionId, verdict, nowMs } = input;
  if (sessionId === null || !MODEL_ID.test(verdict.receiptId)) return 0;
  const open = (r: SubagentRunRecord) => r.workspaceId === ws.workspaceId && r.harness === harness && r.sessionId === sessionId && r.stoppedAtMs !== null && r.stoppedAtMs <= nowMs && (r.learned ?? null) === null && r.subagentType !== null;
  if (!ws.state.list<SubagentRunRecord>(SUBAGENT_RUNS).some(open)) return 0;
  const registry = (await loadModelRegistry({ home: ws.home }).catch(() => null)) ?? BUNDLED_MODEL_REGISTRY;
  const baseline = routeBaseline(registry, harness, null);
  const labelled = await ws.hook.transact((tx) => {
    const out: { readonly row: SubagentRunRecord; readonly modelId: string }[] = [];
    for (const r of tx.list<SubagentRunRecord>(SUBAGENT_RUNS).filter(open)) {
      const ran = modelRan(r, baseline);
      tx.put(SUBAGENT_RUNS, keyOf(r.workspaceId, r.harness, r.sessionId, r.agentId), { ...r, learned: { kind: verdict.kind, receiptId: verdict.receiptId, reasonCode: 'skip' in ran ? ran.skip : 'RECORDED' } });
      if ('modelId' in ran) out.push({ row: r, modelId: ran.modelId });
    }
    return out;
  });
  for (const { row, modelId } of labelled) {
    recordSubagentOutcome(ws, { harness, subagentType: row.subagentType as string, agentId: row.agentId, taskId: input.taskId, modelId, kind: verdict.kind, receiptId: verdict.receiptId, risk: input.risk, nowMs, registry });
  }
  return labelled.length;
}

export function subagentRuns(ws: WorkspaceServices): readonly SubagentRunRecord[] {
  return ws.state.list<SubagentRunRecord>(SUBAGENT_RUNS).filter((r) => r.workspaceId === ws.workspaceId);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

export interface SubagentTypeSummary {
  readonly sliceId: string;
  readonly runs: number;
  readonly finished: number;
  /** Median start-to-last-stop time of the runs whose start and stop were both seen. */
  readonly medianDurationMs: number | null;
  readonly routed: number;
  readonly parentVerified: number;
}

export interface SubagentSummary {
  readonly runs: number;
  /** Started and not yet stopped. */
  readonly running: number;
  readonly finished: number;
  readonly parentVerified: number;
  /** Runs by C's route outcome for their launch; `unknown` when no note was found on Claude Code. */
  readonly routes: { readonly [K in SubagentRouteOutcome | 'not-applicable' | 'unknown']: number };
  /** Runs per harness. */
  readonly harnesses: { readonly [harness: string]: number };
  readonly types: readonly SubagentTypeSummary[];
}

/** The workspace's subagent runs as counts and times (P13; nothing here is a learning signal). */
export function subagentSummary(ws: WorkspaceServices): SubagentSummary {
  const rows = subagentRuns(ws);
  const routes = { proposed: 0, rendered: 0, explained: 0, abstained: 0, 'not-applicable': 0, unknown: 0 };
  const harnesses: { [harness: string]: number } = {};
  for (const r of rows) {
    routes[r.route === 'not-applicable' ? 'not-applicable' : (r.route?.outcome ?? 'unknown')] += 1;
    harnesses[r.harness] = (harnesses[r.harness] ?? 0) + 1;
  }
  const bySlice = new Map<string, SubagentRunRecord[]>();
  for (const r of rows) if (r.sliceId !== null) bySlice.set(r.sliceId, [...(bySlice.get(r.sliceId) ?? []), r]);
  const types = [...bySlice.entries()]
    .map(([sliceId, list]) => ({
      sliceId,
      runs: list.length,
      finished: list.filter((r) => r.stoppedAtMs !== null).length,
      medianDurationMs: median(list.filter((r) => r.startedAtMs !== null && r.stoppedAtMs !== null && r.stoppedAtMs >= r.startedAtMs).map((r) => (r.stoppedAtMs as number) - (r.startedAtMs as number))),
      routed: list.filter((r) => r.route !== null && r.route !== 'not-applicable' && r.route.outcome !== 'abstained').length,
      parentVerified: list.filter((r) => r.parentVerifiedAtMs !== null).length,
    }))
    .sort((a, b) => b.runs - a.runs || a.sliceId.localeCompare(b.sliceId))
    .slice(0, SUMMARY_TYPES_MAX);
  return {
    runs: rows.length,
    running: rows.filter((r) => r.startedAtMs !== null && r.stoppedAtMs === null).length,
    finished: rows.filter((r) => r.stoppedAtMs !== null).length,
    parentVerified: rows.filter((r) => r.parentVerifiedAtMs !== null).length,
    routes,
    harnesses,
    types,
  };
}
