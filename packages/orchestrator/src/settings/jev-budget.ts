/**
 * The Jev decision budget's limits (owner decision 2026-09-29).
 *
 * - The machine-wide monthly limit is the setting `decisions.monthlyBudgetMicroUsd` in your
 *   jevris.config.json (default 5 USD), under the administrator ceilings (`budget.
 *   monthlyDecisionMicroUsd` in host.json, organization.json and a managed policy; the lowest
 *   wins). readEffectiveConfig applies them; `machineJevBudget` reads the result.
 * - A workspace may have its own monthly cap inside that limit. It is kept per machine, like owned
 *   mode: the host orchestration ledger, collection `jev-budget-caps`, keyed by the sidecar's
 *   workspace id, and changed only through the CLI (`jevris configure workspace-budget`). A
 *   repository's `.jevris/config.json` may lower the workspace's budget (`decisions.
 *   monthlyBudgetMicroUsd`), never raise it: repository content is not consent. The effective cap
 *   is the lower of the two; neither can exceed the machine-wide limit, which every reservation
 *   also meets.
 * - A cap record that cannot be read is a cap of 0 for that workspace (fail closed: its decisions
 *   run rules-only until the record is fixed or set again), like owned mode, which is off then.
 *
 * Money is integer micro-USD. Nothing here reads or spends the budget itself: core's
 * DecisionBudget does, asking these functions for the limits at every reservation.
 */
import { join } from 'node:path';
import { JEV_BUDGET_DEFAULT_MICRO_USD, JEV_BUDGET_MAX_MICRO_USD, type JevWorkspaceCapSource } from '@jevris/contracts';
export { jevBudgetText } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import { openLedger, type RecordLedger } from '../ledger.js';
import { isId } from '../util.js';
import { JEV_BUDGET_KEY, jevBudgetOf, readEffectiveConfig, type ConfigLocation } from './config.js';

/** The host ledger collection that keeps each workspace's cap. */
export const JEV_BUDGET_CAPS = 'jev-budget-caps';

export interface WorkspaceJevBudgetCapRecord {
  readonly workspaceId: string;
  /** The workspace's monthly cap, integer micro-USD. */
  readonly capMicroUsd: number;
  readonly changedAt: string;
  readonly changedBy: string;
}

export type StoredWorkspaceCap = { readonly state: 'none' } | { readonly state: 'set'; readonly record: WorkspaceJevBudgetCapRecord } | { readonly state: 'unreadable' };

function hostLedger(home: string): RecordLedger {
  return openLedger(join(jevrisPaths({ home }).data, 'orchestration', 'host'));
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= JEV_BUDGET_MAX_MICRO_USD;
}

/** The cap stored for a workspace: none, set, or a record that cannot be used. */
export function readWorkspaceJevBudgetCap(home: string, workspaceId: string): StoredWorkspaceCap {
  if (!isId(workspaceId)) return { state: 'none' };
  let raw: unknown;
  try {
    raw = hostLedger(home).get<unknown>(JEV_BUDGET_CAPS, workspaceId);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === undefined || raw === null) return { state: 'none' };
  const r = raw as { readonly [key: string]: unknown };
  if (typeof raw !== 'object' || r['workspaceId'] !== workspaceId || !isMoney(r['capMicroUsd']) || typeof r['changedAt'] !== 'string' || typeof r['changedBy'] !== 'string') return { state: 'unreadable' };
  return { state: 'set', record: { workspaceId, capMicroUsd: r['capMicroUsd'], changedAt: r['changedAt'], changedBy: r['changedBy'] } };
}

/**
 * Sets (a number) or removes (null) a workspace's cap. Only the CLI (the trusted terminal channel)
 * calls this; the CLI asks a person first when the change raises the cap (`raisesWorkspaceJevBudget`).
 */
export async function setWorkspaceJevBudgetCap(input: {
  readonly home: string;
  readonly workspaceId: string;
  readonly capMicroUsd: number | null;
  readonly channel: 'cli';
  readonly actor?: string;
  readonly nowMs?: number;
}): Promise<{ readonly ok: true; readonly record: WorkspaceJevBudgetCapRecord | null } | { readonly ok: false; readonly reasonCode: 'CHANNEL_REFUSED' | 'INVALID_WORKSPACE' | 'INVALID_AMOUNT' | 'STORE_UNAVAILABLE' }> {
  if (input.channel !== 'cli') return { ok: false, reasonCode: 'CHANNEL_REFUSED' };
  if (!isId(input.workspaceId)) return { ok: false, reasonCode: 'INVALID_WORKSPACE' };
  if (input.capMicroUsd !== null && !isMoney(input.capMicroUsd)) return { ok: false, reasonCode: 'INVALID_AMOUNT' };
  const record: WorkspaceJevBudgetCapRecord | null =
    input.capMicroUsd === null
      ? null
      : { workspaceId: input.workspaceId, capMicroUsd: input.capMicroUsd, changedAt: new Date(input.nowMs ?? Date.now()).toISOString(), changedBy: (input.actor ?? 'cli').slice(0, 64) };
  try {
    await hostLedger(input.home).transact((tx) => (record === null ? tx.delete(JEV_BUDGET_CAPS, input.workspaceId) : tx.put(JEV_BUDGET_CAPS, input.workspaceId, record)));
  } catch {
    return { ok: false, reasonCode: 'STORE_UNAVAILABLE' };
  }
  return { ok: true, record };
}

/**
 * Whether changing a workspace's cap from `current` to `next` raises it: a higher cap, or removing
 * one (no cap means the machine-wide limit). Setting a first cap, lowering one and the same value
 * never raise. An unreadable record counts as 0, so any change from it is a raise.
 */
export function raisesWorkspaceJevBudget(current: StoredWorkspaceCap, next: number | null): boolean {
  const now = current.state === 'set' ? current.record.capMicroUsd : current.state === 'unreadable' ? 0 : null;
  if (now === null) return false;
  return next === null || next > now;
}

/** The machine-wide monthly limit now, integer micro-USD: your setting under the administrator ceilings. */
export function machineJevBudget(input: ConfigLocation): number {
  try {
    return jevBudgetOf(readEffectiveConfig({ ...input, workspaceRoot: null }).config);
  } catch {
    // The resolver never throws in practice; if it does, the defaults' bound holds.
    return JEV_BUDGET_DEFAULT_MICRO_USD;
  }
}

export interface WorkspaceJevBudget {
  /** The workspace's own cap, integer micro-USD, or null when it has none. */
  readonly capMicroUsd: number | null;
  readonly source: JevWorkspaceCapSource | null;
  /** What `jevris configure workspace-budget` stored, apart from the repository's lowering. */
  readonly stored: StoredWorkspaceCap;
  /** The repository file's lowering, when it lowers the budget for this workspace. */
  readonly repositoryMicroUsd: number | null;
}

/**
 * A workspace's own cap: the lower of the stored cap and the repository file's lowering, or null
 * when neither applies. `workspaceRoot` null (an unknown root) leaves only the stored cap.
 */
export function workspaceJevBudget(input: { readonly home: string; readonly env?: ConfigLocation['env']; readonly workspaceId: string; readonly workspaceRoot: string | null }): WorkspaceJevBudget {
  const stored = readWorkspaceJevBudgetCap(input.home, input.workspaceId);
  let repository: number | null = null;
  if (input.workspaceRoot !== null) {
    try {
      const eff = readEffectiveConfig({ home: input.home, workspaceRoot: input.workspaceRoot, ...(input.env === undefined ? {} : { env: input.env }) });
      // Only the workspace layer's own lowering counts; the administrator ceilings are the machine-wide limit's.
      const note = [...eff.narrowed].reverse().find((n) => n.layer === 'workspace' && n.key === JEV_BUDGET_KEY);
      if (note !== undefined && /^\d{1,10}$/.test(note.to)) repository = Number(note.to);
    } catch {
      repository = null;
    }
  }
  if (stored.state === 'unreadable') return { capMicroUsd: 0, source: 'unreadable', stored, repositoryMicroUsd: repository };
  const own = stored.state === 'set' ? stored.record.capMicroUsd : null;
  if (own === null && repository === null) return { capMicroUsd: null, source: null, stored, repositoryMicroUsd: null };
  if (repository === null || (own !== null && own <= repository)) return { capMicroUsd: own, source: 'cap', stored, repositoryMicroUsd: repository };
  return { capMicroUsd: repository, source: 'repository', stored, repositoryMicroUsd: repository };
}
