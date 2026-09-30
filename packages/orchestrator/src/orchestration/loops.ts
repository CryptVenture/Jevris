/**
 * Loop and stall detection with bounded recovery (ORC-11, SSOT §10.4, C29, C38, W02).
 *
 * Deterministic signals come from tool events: command hashes, normalised diagnostic
 * fingerprints, diff hashes, repeated failing test ids and time without new evidence. Rules
 * classify first; when they are not decisive, Jev (Choice) classifies, and the rules answer when
 * the engine is absent. The action always comes from the §10.4 allowlist, per-task and
 * per-error-family budgets cap retries, and the approaches that failed are written to the
 * rejected-approach ledger, which the capsule carries.
 */
import type { WorkspaceServices } from '../workspace.js';
import { consultChoice } from '../capabilities/consult.js';
import { recordKey, safeText, sha256 } from '../util.js';

export const LOOP_CLASSES = ['no-signal', 'progress', 'repeated-failure', 'environment-failure', 'flaky-suspected', 'no-progress', 'patch-oscillation'] as const;
export type LoopClass = (typeof LOOP_CLASSES)[number];

export const RECOVERY_ACTIONS = [
  'continue',
  'retrieve-missing-artifact',
  'rerun-check-once',
  'ask-focused-question',
  'route-stronger-worker',
  'restore-checkpoint-with-approval',
  'stop-and-report',
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export type SignalKind = 'command' | 'diagnostic' | 'diff' | 'test-failure' | 'evidence';

export interface LoopSignal {
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly atMs: number;
  readonly kind: SignalKind;
  readonly hash: string;
  /** Error family for per-family budgets (compile, test, environment, network, other). */
  readonly family: string | null;
  readonly environment: boolean;
  /** Short, redacted label (never raw output). */
  readonly label: string;
}

export interface RejectedApproach {
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly fingerprint: string;
  readonly text: string;
  readonly evidence: readonly string[];
  readonly atMs: number;
}

const MAX_SIGNALS = 400;

// ------------------------------------------------------------------------------ signal making

/** Normalises a diagnostic so the same error with other line numbers, paths or ids matches. */
export function diagnosticFingerprint(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+|\/[^\s:]+/g, '<path>')
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  return sha256(norm).slice(0, 24);
}

const ENVIRONMENT = /\b(enotfound|econnrefused|econnreset|etimedout|eai_again|command not found|is not recognized as an internal or external command|no such file or directory.*(bin|exe)|enoent.*spawn|permission denied|eacces|cannot connect to the docker daemon|connection refused|service unavailable|could not resolve host|network is unreachable|missing (?:tool|toolchain|sdk))\b/i;

export function errorFamily(text: string): { readonly family: string; readonly environment: boolean } {
  if (ENVIRONMENT.test(text)) return { family: 'environment', environment: true };
  if (/\berror ts\d+|\berror\[e\d+\]|syntaxerror|compil(e|ation) (error|failed)|cannot find (module|symbol)/i.test(text)) return { family: 'compile', environment: false };
  if (/\bnot ok \d+|✖|\bfail(ed|ing)? (test|spec)|assertionerror|expected .* (to|but)/i.test(text)) return { family: 'test', environment: false };
  if (/\blint|eslint|prettier|ruff|clippy/i.test(text)) return { family: 'lint', environment: false };
  return { family: 'other', environment: false };
}

/** Failing test ids from TAP, node:test and JUnit-ish text. */
export function failingTestIds(text: string): readonly string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) out.add((m[1] ?? '').trim().slice(0, 200));
  for (const m of text.matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) if (!/failing tests:?$/.test(m[1] ?? '')) out.add((m[1] ?? '').trim().slice(0, 200));
  for (const m of text.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*>\s*<failure/g)) out.add((m[1] ?? '').slice(0, 200));
  return [...out].filter((s) => s.length > 0).sort();
}

export interface ToolObservation {
  readonly taskId: string | null;
  readonly atMs: number;
  readonly command: string | null;
  readonly failed: boolean;
  readonly output: string;
  readonly diffHash: string | null;
  /**
   * What makes this call the same approach as another: a one-way key (a digest of its input) and a
   * label that names the tool and a short form of the key, never the input. With a key, two failures
   * match only when their keys match; without one they match by output shape.
   */
  readonly identity?: { readonly key: string; readonly label: string };
}

/**
 * A label that names only a tool's argument keys and byte counts (`error: Bash(command) in=20
 * out=300`), the shape the hook fell back to before it carried a call's identity. Every failing
 * call with the same keys wears it, so it says nothing about which approach failed.
 */
export function isShapeOnlyLabel(label: string): boolean {
  return /^(?:error: )?[\w.:-]+\([^)]*\) in=\d+(?: out=\d+)?$/.test(label.trim());
}

/** True for a ledger text made of a shape-only label (`Approach that ends in "error: Bash(command) in=1 out=2" failed 3 times.`). */
export function isShapeOnlyApproachText(text: string): boolean {
  const quoted = /^(?:Approach|Oscillating change) that ends in "(.*)" failed \d+ times/.exec(text.trim())?.[1];
  return quoted !== undefined && isShapeOnlyLabel(quoted);
}

/** Signals from one tool observation. Output text is hashed and labelled, never stored. */
export function signalsFrom(workspaceId: string, obs: ToolObservation): readonly LoopSignal[] {
  const out: LoopSignal[] = [];
  const base = { workspaceId, taskId: obs.taskId, atMs: obs.atMs };
  const idKey = obs.identity?.key;
  if (obs.command !== null) out.push({ ...base, kind: 'command', hash: sha256((idKey ?? obs.command).trim()).slice(0, 24), family: null, environment: false, label: safeText(obs.identity?.label ?? obs.command, 120) });
  if (obs.diffHash !== null) out.push({ ...base, kind: 'diff', hash: obs.diffHash.slice(0, 24), family: null, environment: false, label: `diff ${obs.diffHash.slice(0, 8)}` });
  if (obs.failed) {
    const fam = errorFamily(obs.output);
    const firstError = obs.output.split(/\r?\n/).find((l) => /error|fail|not ok|✖|exception/i.test(l)) ?? obs.output.slice(0, 200);
    // With an identity the failure is the call itself: the output of a hook failure carries no error
    // text, and normalising its sizes would fold every call with the same keys into one failure.
    const hash = idKey === undefined ? diagnosticFingerprint(obs.output.slice(0, 8000)) : sha256(`failure\n${idKey}`).slice(0, 24);
    out.push({ ...base, kind: 'diagnostic', hash, family: fam.family, environment: fam.environment, label: safeText(obs.identity?.label ?? firstError, 200) });
    for (const id of failingTestIds(obs.output)) out.push({ ...base, kind: 'test-failure', hash: sha256(id).slice(0, 24), family: 'test', environment: false, label: safeText(id, 200) });
  } else {
    out.push({ ...base, kind: 'evidence', hash: sha256(`${obs.command ?? ''}\n${obs.output.slice(0, 4000)}`).slice(0, 24), family: null, environment: false, label: 'new evidence' });
  }
  return out;
}

export async function recordSignals(ws: WorkspaceServices, signals: readonly LoopSignal[]): Promise<void> {
  if (signals.length === 0) return;
  await ws.hook.transact((tx) => {
    const byTask = new Map<string, LoopSignal[]>();
    for (const s of signals) {
      const key = recordKey(ws.workspaceId, s.taskId ?? '-');
      const current = byTask.get(key) ?? tx.get<LoopSignal[]>('loop-signals', key) ?? [];
      current.push(s);
      byTask.set(key, current);
    }
    for (const [key, list] of byTask) tx.put('loop-signals', key, list.slice(-MAX_SIGNALS));
  });
}

export function loopSignals(ws: WorkspaceServices, taskId: string | null): readonly LoopSignal[] {
  return ws.state.get<LoopSignal[]>('loop-signals', recordKey(ws.workspaceId, taskId ?? '-')) ?? [];
}

export function rejectedApproaches(ws: WorkspaceServices, taskId: string | null): readonly RejectedApproach[] {
  return ws.state
    .list<RejectedApproach>('rejected-approaches')
    .filter((r) => r.workspaceId === ws.workspaceId && (taskId === null || r.taskId === taskId || r.taskId === null))
    // A row written before failures carried an identity names only argument keys and byte counts.
    .filter((r) => !isShapeOnlyApproachText(r.text))
    .sort((a, b) => a.atMs - b.atMs);
}

// ------------------------------------------------------------------------------ assessment

export interface LoopBudgets {
  /** Failures allowed per task before stopping (config `orchestration.maxRepairAttempts` + 1). */
  readonly perTask: number;
  /** Failures allowed per error family. */
  readonly perFamily: number;
  /** Time without new evidence that counts as a stall. */
  readonly stallMs: number;
}

export const DEFAULT_LOOP_BUDGETS: LoopBudgets = { perTask: 6, perFamily: 3, stallMs: 10 * 60_000 };

export interface LoopAssessment {
  readonly classification: LoopClass;
  readonly action: RecoveryAction;
  readonly advice: string;
  readonly source: 'rules' | 'jev';
  readonly decisionId: string | null;
  readonly signals: { readonly failures: number; readonly distinctFingerprints: number; readonly maxRepeat: number; readonly environmentFailures: number };
  readonly budgetExhausted: 'task' | 'family' | null;
  readonly rejectedApproaches: readonly string[];
}

const ACTION_OF: { readonly [C in LoopClass]: RecoveryAction } = {
  'no-signal': 'continue',
  progress: 'continue',
  'repeated-failure': 'route-stronger-worker',
  'environment-failure': 'ask-focused-question',
  'flaky-suspected': 'rerun-check-once',
  'no-progress': 'retrieve-missing-artifact',
  'patch-oscillation': 'restore-checkpoint-with-approval',
};

const ADVICE_OF: { readonly [C in LoopClass]: string } = {
  'no-signal': 'No repeated failure or stall is visible. Continue.',
  progress: 'Failures are changing, which suggests progress. Continue, and keep each rejected approach in the capsule.',
  'repeated-failure': 'The same failure keeps repeating. Hand the task, the capsule and the rejected approaches to a stronger worker, or ask the user for guidance. Do not try random changes.',
  'environment-failure': 'The failure comes from the environment (a missing tool, service or permission), not the source. Ask the user to fix the environment before retrying.',
  'flaky-suspected': 'One failure came back after changing results. Rerun the check once in the same environment to separate a flake from a real defect.',
  'no-progress': 'No new evidence for a while. Retrieve the missing artifact or context before continuing.',
  'patch-oscillation': 'The change is oscillating between the same states. Restore the last good checkpoint, with the user\'s approval, and pick a different approach.',
};

function maxRepeatOf(hashes: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

/** A diff state that returns after a different one: A, B, A. */
function oscillates(diffs: readonly string[]): boolean {
  const seen = new Map<string, number>();
  for (let i = 0; i < diffs.length; i += 1) {
    const h = diffs[i] as string;
    const prev = seen.get(h);
    if (prev !== undefined && i - prev >= 2 && diffs.slice(prev + 1, i).some((d) => d !== h)) return true;
    seen.set(h, i);
  }
  return false;
}

/**
 * Two failures taking turns: A, B, A, B (at least four in a row, exactly two distinct). This is the
 * oscillation the recover command can see from failure fingerprints alone, because the hook
 * records no diff hash. A, A, B, B and A, B, C, A are not alternation.
 */
export function alternatesFingerprints(hashes: readonly string[]): boolean {
  const n = hashes.length;
  if (n < 4) return false;
  const a = hashes[n - 1] as string;
  const b = hashes[n - 2] as string;
  if (a === b) return false;
  let run = 2;
  for (let i = n - 3; i >= 0; i -= 1) {
    if (hashes[i] !== (run % 2 === 0 ? a : b)) break;
    run += 1;
  }
  return run >= 4;
}

export interface AssessInput {
  readonly taskId: string | null;
  /** Extra fingerprints from the caller (the recover command line), in order. */
  readonly fingerprints?: readonly string[];
  /**
   * Ignored (RET-06): whether a failure is environmental is derived from the failure text
   * itself, never from a caller's claim. Kept so older callers still type-check.
   */
  readonly environment?: readonly boolean[];
  readonly nowMs?: number;
  readonly budgets?: LoopBudgets;
  readonly engine?: unknown;
  readonly remainingMs?: number;
  /** Record the rejected approach for repeated or oscillating failures (default true). */
  readonly record?: boolean;
}

export async function assessLoop(ws: WorkspaceServices, input: AssessInput): Promise<LoopAssessment> {
  const nowMs = input.nowMs ?? Date.now();
  const budgets = input.budgets ?? DEFAULT_LOOP_BUDGETS;
  const stored = loopSignals(ws, input.taskId);
  const extra: LoopSignal[] = (input.fingerprints ?? []).map((f, i) => ({
    workspaceId: ws.workspaceId,
    taskId: input.taskId,
    atMs: nowMs,
    kind: 'diagnostic' as const,
    hash: diagnosticFingerprint(f),
    family: errorFamily(f).family,
    environment: errorFamily(f).environment,
    label: safeText(f, 200),
  }));
  const all = [...stored, ...extra];
  const diagnostics = all.filter((s) => s.kind === 'diagnostic');
  const diffs = all.filter((s) => s.kind === 'diff').map((s) => s.hash);
  const commands = all.filter((s) => s.kind === 'command').map((s) => s.hash);
  const envFailures = diagnostics.filter((s) => s.environment).length;
  const maxRepeat = maxRepeatOf(diagnostics.map((s) => s.hash));
  const distinct = new Set(diagnostics.map((s) => s.hash)).size;
  const signals = { failures: diagnostics.length, distinctFingerprints: distinct, maxRepeat, environmentFailures: envFailures };
  const families = new Map<string, number>();
  for (const d of diagnostics) families.set(d.family ?? 'other', (families.get(d.family ?? 'other') ?? 0) + 1);
  const lastEvidence = Math.max(0, ...all.filter((s) => s.kind === 'evidence' || s.kind === 'diff').map((s) => s.atMs));
  const lastAny = Math.max(0, ...all.map((s) => s.atMs));
  // The stall clock starts at the last evidence or diff, or, with none at all, at the first signal seen.
  // It never starts at the epoch: a single fresh failure has not stalled anything (JEV-0027).
  const firstAny = all.length === 0 ? 0 : Math.min(...all.map((s) => s.atMs));
  const stallBaseline = all.some((s) => s.kind === 'evidence' || s.kind === 'diff') ? lastEvidence : firstAny;
  const alternating = alternatesFingerprints(diagnostics.map((s) => s.hash));

  // Deterministic rules first.
  let rules: LoopClass;
  let decisive = true;
  if (all.length === 0) rules = 'no-signal';
  else if (envFailures > 0 && envFailures * 2 >= diagnostics.length) rules = 'environment-failure';
  else if (oscillates(diffs) || alternating) rules = 'patch-oscillation';
  else if (maxRepeat >= 3) rules = 'repeated-failure';
  else if (maxRepeat === 2 && distinct >= 2) {
    rules = 'flaky-suspected';
    decisive = false;
  } else if (maxRepeatOf(commands) >= 3 && diffs.length === 0 && lastEvidence < lastAny - 1) rules = 'no-progress';
  else if (lastAny > 0 && nowMs - stallBaseline > budgets.stallMs && diagnostics.length > 0) {
    rules = 'no-progress';
    decisive = false;
  } else if (diagnostics.length === 0) rules = 'no-signal';
  else {
    rules = 'progress';
    decisive = diagnostics.length < 2;
  }

  let classification = rules;
  let source: 'rules' | 'jev' = 'rules';
  let decisionId: string | null = null;
  if (!decisive) {
    const options: { [k: string]: string } = {};
    for (const c of LOOP_CLASSES.filter((c) => c !== 'no-signal')) options[c.replace(/-/g, '_')] = ADVICE_OF[c];
    const consult = await consultChoice(input.engine, {
      capabilityId: 'C29',
      specVersion: '1',
      objective: 'Classify whether the agent is making progress or looping.',
      instructions: 'Classify the recent failure pattern of a coding agent. Choose the single best description.',
      options,
      evidence: diagnostics.slice(-12).map((d, i) => ({ id: `sig-${String(i)}`, text: `${d.family ?? 'other'}: ${d.label}`, sourceKind: 'tool' as const, priority: 'high' as const })),
      facts: { failures: signals.failures, distinct: distinct, maxRepeat, environmentFailures: envFailures, diffStates: diffs.length },
      workspaceId: ws.workspaceId,
      evidenceRevision: `loop-${String(all.length)}`,
      taskId: input.taskId,
      ...(input.remainingMs === undefined ? {} : { remainingMs: input.remainingMs }),
      rules: () => ({ choice: rules.replace(/-/g, '_'), reasonCode: 'RULES' }),
    });
    const answered = consult.value.replace(/_/g, '-') as LoopClass;
    // Jev's answer is advice about facts Jevris already counted. A class the counts do not support
    // (a repeat with no repeated failure, an oscillation with no alternation) is not accepted.
    const supported =
      (answered !== 'repeated-failure' || maxRepeat >= 2) &&
      (answered !== 'patch-oscillation' || oscillates(diffs) || alternating) &&
      (answered !== 'environment-failure' || envFailures > 0);
    classification = supported ? answered : rules;
    source = supported ? consult.source : 'rules';
    decisionId = consult.decisionId;
  }

  let action = ACTION_OF[classification];
  let advice = ADVICE_OF[classification];
  let budgetExhausted: LoopAssessment['budgetExhausted'] = null;
  if (diagnostics.length > budgets.perTask) budgetExhausted = 'task';
  else if ([...families.entries()].some(([fam, n]) => fam !== 'environment' && n > budgets.perFamily) && classification !== 'progress') budgetExhausted = 'family';
  if (budgetExhausted !== null && classification === 'patch-oscillation') {
    // Restoring a checkpoint is not another retry, and it acts only with a person's approval, so an
    // exhausted budget does not replace it with stop-and-report: no authority is widened. The advice
    // still says the budget is used up.
    advice = `${advice} The ${budgetExhausted === 'task' ? 'task repair' : 'error-family retry'} budget is used up, so after the restore stop and report rather than retry.`;
  } else if (budgetExhausted !== null && action !== 'ask-focused-question') {
    action = 'stop-and-report';
    advice = `The ${budgetExhausted === 'task' ? 'task repair' : 'error-family retry'} budget is used up. Stop and report what was tried; do not keep retrying.`;
  }

  if ((classification === 'repeated-failure' || classification === 'patch-oscillation') && input.record !== false) {
    // Only a failure with a label that names the approach is kept: a shape-only label would print as
    // noise, and it is the same for every call with those keys.
    const named = diagnostics.filter((d) => !isShapeOnlyLabel(d.label));
    const namedRepeat = maxRepeatOf(named.map((d) => d.hash));
    const top = namedRepeat < (classification === 'patch-oscillation' ? 1 : 2) ? undefined : [...named].reverse().find((d) => named.filter((x) => x.hash === d.hash).length === namedRepeat);
    if (top !== undefined) {
      const key = recordKey(ws.workspaceId, input.taskId ?? '-', top.hash);
      const lastDiff = diffs[diffs.length - 1];
      await ws.state.transact((tx) =>
        tx.put('rejected-approaches', key, {
          workspaceId: ws.workspaceId,
          taskId: input.taskId,
          fingerprint: top.hash,
          text: safeText(`${classification === 'patch-oscillation' ? 'Oscillating change' : 'Approach'} that ends in "${top.label}" failed ${String(namedRepeat)} times${lastDiff === undefined ? '' : ` (last diff ${lastDiff.slice(0, 8)})`}.`, 500),
          evidence: diagnostics.filter((d) => d.hash === top.hash).map((d) => `sig:${d.hash}`).slice(0, 8),
          atMs: nowMs,
        } satisfies RejectedApproach),
      );
    }
  }
  return {
    classification,
    action,
    advice,
    source,
    decisionId,
    signals,
    budgetExhausted,
    rejectedApproaches: rejectedApproaches(ws, input.taskId).map((r) => r.text).slice(-32),
  };
}

/** Records an approach the user or a report says was tried and rejected (kept in the capsule). */
export async function recordRejectedApproach(
  ws: WorkspaceServices,
  input: { readonly taskId: string | null; readonly text: string; readonly evidence: readonly string[]; readonly source: 'user' | 'worker'; readonly nowMs?: number },
): Promise<RejectedApproach> {
  const text = safeText(input.text, 500);
  const fingerprint = sha256(text.toLowerCase().replace(/\s+/g, ' ').trim()).slice(0, 24);
  const row: RejectedApproach = { workspaceId: ws.workspaceId, taskId: input.taskId, fingerprint, text, evidence: [...input.evidence].slice(0, 8), atMs: input.nowMs ?? Date.now() };
  await ws.state.transact((tx) => tx.put('rejected-approaches', recordKey(ws.workspaceId, input.taskId ?? '-', fingerprint), row));
  return row;
}
