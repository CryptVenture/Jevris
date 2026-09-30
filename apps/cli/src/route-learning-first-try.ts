/**
 * The Sonnet-first lines of `jevris route learning status` (owner decision 2026-09-30): what this
 * workspace measured for each slice that was routed to a cheaper first-try model, read from the
 * local first-try ledger. Ids, counts and figures only. Every money figure is labelled an estimate
 * when any attempt was priced from usage at list price, and quality is never claimed: a verified
 * task is a passing check, not a measure of the code.
 */
import { costPerVerified, wallPerVerified, type FirstTryStats } from '@jevris/core';
import { firstTryOf, firstTryReports, openWorkspace, readEffectiveConfig, type FirstTrySliceReport } from '@jevris/orchestrator';

export interface FirstTryStatus {
  readonly setting: 'auto' | 'baseline';
  readonly slices: readonly {
    readonly sliceId: string;
    readonly baselineModelId: string;
    readonly firstTryModelId: string;
    readonly mode: 'first-try' | 'baseline';
    readonly reasonCode: string;
    readonly firstTry: FirstTryFigures;
    readonly control: FirstTryFigures;
    readonly openTasks: number;
  }[];
}

interface FirstTryFigures {
  readonly tasks: number;
  readonly verified: number;
  readonly handedOff: number;
  readonly costPerVerifiedMicroUsd: number | null;
  readonly wallPerVerifiedMs: number | null;
  readonly costIsEstimate: boolean;
}

function figures(s: FirstTryStats): FirstTryFigures {
  const cost = costPerVerified(s);
  const wall = wallPerVerified(s);
  return { tasks: s.tasks, verified: s.verified, handedOff: s.escalated, costPerVerifiedMicroUsd: cost === null ? null : Math.round(cost), wallPerVerifiedMs: wall === null ? null : Math.round(wall), costIsEstimate: s.estimate };
}

export function firstTryStatus(input: { readonly home: string; readonly workspaceRoot: string; readonly slice?: string }): FirstTryStatus {
  let setting: 'auto' | 'baseline' = 'auto';
  try {
    setting = firstTryOf(readEffectiveConfig({ home: input.home, workspaceRoot: input.workspaceRoot }).config);
  } catch {
    // An unreadable configuration reads as the default here; the route reads it again at launch.
  }
  const reports: readonly FirstTrySliceReport[] = (() => {
    try {
      return firstTryReports(openWorkspace({ home: input.home, workspaceRoot: input.workspaceRoot }));
    } catch {
      return [];
    }
  })();
  return {
    setting,
    slices: reports
      .filter((r) => input.slice === undefined || r.sliceId === input.slice)
      .map((r) => ({ sliceId: r.sliceId, baselineModelId: r.baselineModelId, firstTryModelId: r.firstTryModelId, mode: r.mode, reasonCode: r.reasonCode, firstTry: figures(r.firstTry), control: figures(r.control), openTasks: r.open })),
  };
}

function money(micro: number | null, estimate: boolean): string {
  return micro === null ? 'not measured yet' : `$${(micro / 1_000_000).toFixed(4)}${estimate ? ' (estimate at list prices)' : ''}`;
}

function arm(label: string, f: FirstTryFigures): string {
  return `${label} ${String(f.tasks)} finished, ${String(f.verified)} verified${label === 'first try:' ? `, ${String(f.handedOff)} handed off` : ''}; cost per verified task ${money(f.costPerVerifiedMicroUsd, f.costIsEstimate)}`;
}

export function firstTryLines(status: FirstTryStatus): string[] {
  const lines = [`Sonnet-first routing (routing.firstTry ${status.setting}): low-risk owned tasks go to a cheaper first-try model with one hand-off on a failed check. Quality: unknown; a verified task is a passing check, not a quality score.`];
  if (status.slices.length === 0) return [...lines, 'No first-try tasks have run in this workspace yet.'];
  for (const s of status.slices) {
    lines.push(`- ${s.sliceId}: ${s.firstTryModelId} before ${s.baselineModelId}, now ${s.mode === 'first-try' ? 'first-try' : 'baseline-first'} (${s.reasonCode}); ${String(s.openTasks)} open.`);
    lines.push(`    ${arm('first try:', s.firstTry)}`);
    lines.push(`    ${arm('control (baseline first):', s.control)}`);
  }
  return lines;
}
