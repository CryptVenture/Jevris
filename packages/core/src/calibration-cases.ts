/**
 * P4 local calibration cases (owner decision DOMAINS 7922ee3; coordinator go-ahead 2026-09-27).
 *
 * Each Jev decision records the provider's per-question probability (`answerProbabilities`, numbers
 * and codes only). Once the decision's task has a verified outcome (B's `decision_outcome` join),
 * the pair is a calibration case: `{ sliceId, probability, outcome, modelId? }`, the shape the
 * release pipeline's `proposeCalibration` reads.
 *
 * Guardrails:
 * - The export is a proposal input for a person to review. Nothing here loads it, applies it or
 *   changes a threshold; only a reviewer-signed calibration release does (`release-evidence.mjs
 *   calibration`).
 * - It never leaves the machine: no op sends it anywhere. It lives under
 *   `<data>/route-learning/calibration-cases/`, so `jevris data delete --scope learning` removes it,
 *   and `removeLocalCalibrationCases` serves `route learning reset --clear-evidence`.
 * - It never outlives the labels it came from: the retention sweep (B's
 *   CALIBRATION_CASES_RETENTION, e8225dd) removes a file whose last export is older than
 *   `decisionRetentionDays`, the window of the `decision_outcome` rows.
 * - Text-free: ids, codes, numbers and times. No question text, packet text or decision id.
 * - Only a verified outcome counts: success is a verified pass, failure a verified failure
 *   (verified-fail, reverted, retried, run-incomplete). Abandoned and unknown tasks and
 *   session-window joins are counted apart, never turned into cases.
 */
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionRecord } from '@jevris/contracts';
import { durableWrite, jevrisPaths } from '@jevris/platform';
import { taskOutcomeOfLabels, type JoinedOutcome } from './decision-outcomes.js';

export const LOCAL_CALIBRATION_SCHEMA = 'jevris-local-calibration-cases-1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CASES = 10_000;

/** `<data>/route-learning/calibration-cases`: B's CALIBRATION_CASES_RETENTION sweeps a file whose last export is older than the decision window. */
export function localCalibrationDir(home: string): string {
  return join(jevrisPaths({ home }).data, 'route-learning', 'calibration-cases');
}

export function localCalibrationFile(home: string, workspaceId: string): string {
  if (!ID.test(workspaceId)) throw new Error('workspaceId is not a valid id');
  return join(localCalibrationDir(home), `${workspaceId}.json`);
}

/** One case, in the release pipeline's CalibrationCase shape. */
export interface LocalCalibrationCase {
  readonly sliceId: string;
  readonly probability: number;
  readonly outcome: boolean;
  readonly modelId?: string;
}

/** Cases of one question of one decision spec version, asked of one Jev model. */
export interface LocalCalibrationGroup {
  readonly decisionSpecId: string;
  readonly decisionSpecVersion: string | null;
  readonly questionHash: string | null;
  readonly questionId: string;
  readonly questionType: 'noul' | 'choice' | 'score';
  /** The resolved Jev model of the answers. */
  readonly model: string;
  /** The records carry no task slice, so each case's slice is its decision spec; the reviewer may re-slice. */
  readonly sliceBasis: 'decision-spec';
  readonly successes: number;
  readonly failures: number;
  readonly cases: readonly LocalCalibrationCase[];
}

export interface LocalCalibrationCases {
  readonly schemaVersion: typeof LOCAL_CALIBRATION_SCHEMA;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly reviewState: 'unreviewed';
  /** Plain statements of what this file is and is not. */
  readonly notice: readonly string[];
  readonly groups: readonly LocalCalibrationGroup[];
  readonly totals: { readonly decisions: number; readonly cases: number };
  /** Joined decisions that gave no case, by reason. */
  readonly excluded: {
    readonly sessionWindowOnly: number;
    readonly notVerified: number;
    readonly noRecord: number;
    readonly noProbabilities: number;
    readonly overCap: number;
  };
}

export const LOCAL_CALIBRATION_NOTICE: readonly string[] = Object.freeze([
  'Local calibration cases for a person to review. Jevris never loads, applies or uploads this file.',
  'Only a reviewer-signed calibration release can use them: split them into calibration and holdout cases, then run release-evidence.mjs calibration.',
  'A probability here is the provider answer to one question, not a success probability of the task.',
]);

export interface BuildLocalCalibrationInput {
  readonly workspaceId: string;
  readonly nowMs: number;
  /** B's decision_outcome rows for this workspace. */
  readonly rows: readonly JoinedOutcome[];
  /** The decision's record from the journal, or null when it is gone. */
  readonly readRecord: (decisionId: string) => Promise<DecisionRecord | null>;
}

export async function buildLocalCalibrationCases(input: BuildLocalCalibrationInput): Promise<LocalCalibrationCases> {
  const byDecision = new Map<string, JoinedOutcome[]>();
  for (const r of input.rows) byDecision.set(r.decisionId, [...(byDecision.get(r.decisionId) ?? []), r]);
  const groups = new Map<string, { head: Omit<LocalCalibrationGroup, 'successes' | 'failures' | 'cases'>; cases: LocalCalibrationCase[] }>();
  const excluded = { sessionWindowOnly: 0, notVerified: 0, noRecord: 0, noProbabilities: 0, overCap: 0 };
  let decisions = 0;
  let cases = 0;
  for (const [decisionId, list] of [...byDecision.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const task = list.filter((r) => r.joinBasis === 'task');
    if (task.length === 0) {
      excluded.sessionWindowOnly += 1;
      continue;
    }
    const outcome = taskOutcomeOfLabels(task);
    if (outcome !== 'verified-success' && outcome !== 'verified-failure') {
      excluded.notVerified += 1;
      continue;
    }
    let record: DecisionRecord | null = null;
    try {
      record = await input.readRecord(decisionId);
    } catch {
      record = null;
    }
    if (record === null || (record.workspaceId !== undefined && record.workspaceId !== input.workspaceId)) {
      excluded.noRecord += 1;
      continue;
    }
    const answered = (record.answerProbabilities ?? []).filter((a) => Number.isFinite(a.probability) && a.probability >= 0 && a.probability <= 1);
    const model = record.modelResolved;
    if (answered.length === 0 || model === null || model === 'jevris-rules' || !ID.test(record.specId)) {
      excluded.noProbabilities += 1;
      continue;
    }
    if (cases + answered.length > MAX_CASES) {
      excluded.overCap += 1;
      continue;
    }
    decisions += 1;
    const observed = record.workerModel?.observed;
    for (const a of answered) {
      const head = {
        decisionSpecId: record.specId,
        decisionSpecVersion: record.specVersion ?? null,
        questionHash: record.hashes?.questionHash ?? null,
        questionId: a.questionId,
        questionType: a.type,
        model,
        sliceBasis: 'decision-spec' as const,
      };
      const key = JSON.stringify([head.decisionSpecId, head.decisionSpecVersion, head.questionHash, head.questionId, head.questionType, head.model]);
      const group = groups.get(key) ?? { head, cases: [] };
      group.cases.push({ sliceId: record.specId, probability: a.probability, outcome: outcome === 'verified-success', ...(typeof observed === 'string' ? { modelId: observed } : {}) });
      groups.set(key, group);
      cases += 1;
    }
  }
  return {
    schemaVersion: LOCAL_CALIBRATION_SCHEMA,
    createdAt: new Date(input.nowMs).toISOString(),
    workspaceId: input.workspaceId,
    reviewState: 'unreviewed',
    notice: LOCAL_CALIBRATION_NOTICE,
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, g]) => ({ ...g.head, successes: g.cases.filter((c) => c.outcome).length, failures: g.cases.filter((c) => !c.outcome).length, cases: g.cases })),
    totals: { decisions, cases },
    excluded,
  };
}

/** Writes the export (mode 0600) and returns its path, or a reason code. */
export async function writeLocalCalibrationCases(home: string, exported: LocalCalibrationCases): Promise<{ readonly ok: true; readonly file: string } | { readonly ok: false; readonly reasonCode: 'INVALID_WORKSPACE' | 'WRITE_FAILED' }> {
  if (!ID.test(exported.workspaceId)) return { ok: false, reasonCode: 'INVALID_WORKSPACE' };
  const file = localCalibrationFile(home, exported.workspaceId);
  try {
    await mkdir(localCalibrationDir(home), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reasonCode: 'WRITE_FAILED' };
  }
  const written = await durableWrite(file, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 });
  return written.ok ? { ok: true, file } : { ok: false, reasonCode: 'WRITE_FAILED' };
}

/** Removes one workspace's export, or every export without a workspace. Missing is fine. */
export async function removeLocalCalibrationCases(home: string, workspaceId?: string): Promise<{ readonly ok: boolean }> {
  const gone = async (file: string): Promise<boolean> => {
    try {
      await rm(file);
      return true;
    } catch (error) {
      return (error as { readonly code?: string }).code === 'ENOENT';
    }
  };
  if (workspaceId !== undefined) return { ok: ID.test(workspaceId) && (await gone(localCalibrationFile(home, workspaceId))) };
  let names: string[] = [];
  try {
    names = await readdir(localCalibrationDir(home));
  } catch {
    return { ok: true };
  }
  let ok = true;
  for (const name of names) if (!(await gone(join(localCalibrationDir(home), name)))) ok = false;
  try {
    await rmdir(localCalibrationDir(home));
  } catch {
    // a file appeared meanwhile; data delete removes the directory anyway
  }
  return { ok };
}

/** Plain-text lines for the CLI. */
export function localCalibrationLines(exported: LocalCalibrationCases, file: string | null): string[] {
  const x = exported.excluded;
  const skipped = x.sessionWindowOnly + x.notVerified + x.noRecord + x.noProbabilities + x.overCap;
  return [
    `Local calibration cases: ${exported.totals.cases} from ${exported.totals.decisions} decision(s) with a verified task outcome, in ${exported.groups.length} question group(s).${file === null ? '' : ` Written to ${file}.`}`,
    `Not turned into cases: ${skipped} (${x.notVerified} not verified, ${x.sessionWindowOnly} joined only by session, ${x.noRecord} without a record, ${x.noProbabilities} without a provider probability${x.overCap > 0 ? `, ${x.overCap} over the cap` : ''}).`,
    ...LOCAL_CALIBRATION_NOTICE,
  ];
}
