/**
 * The verification service: proposed manifests from the workspace, user approval through a
 * trusted channel, runs of approved manifests only, and the read-only verification status.
 *
 * A workspace proposes checks in `jevris.checks.json` or `.jevris/checks.json`. That file is
 * repository content, so it is untrusted until the user approves it (`jevris verify approve`,
 * CLI scope only). Approval pins each check's manifest hash: an edited check needs approval
 * again, and a revoke flips verification back to unsupported (VER-07).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceServices } from '../workspace.js';
import { parseManifestFile, type CheckManifest } from './manifest.js';
import { noteRestoreCheckStarted } from '../memory/restore-outcomes.js';
import { evaluateCompletion, lastStopReport, noteReminderCheckStarted, type CompletionReport, type StopReport } from './completion.js';
import { RUNNER_STDERR_SEPARATOR, runChecks, type CheckRun } from './runner.js';
import { distillStoredOutput, recordStoredView } from '../memory/distill.js';
import { receiptScopeOf } from './receipt-scope.js';
import type { StoredReceipt } from './receipts.js';
import type { GitPort } from './revision.js';

export const MANIFEST_FILES = ['jevris.checks.json', join('.jevris', 'checks.json')]; // path-hygiene: allow workspace-relative manifest location
const MAX_MANIFEST_BYTES = 512 * 1024;

export interface ApprovalRecord {
  readonly workspaceId: string;
  readonly hashes: { readonly [checkId: string]: string };
  readonly manifests: { readonly [checkId: string]: CheckManifest };
  readonly approvedAt: string;
  readonly channel: 'cli';
  readonly source: string;
}

export type ProposedResult =
  | { readonly ok: true; readonly file: string; readonly manifests: readonly CheckManifest[]; readonly hashes: { readonly [id: string]: string } }
  | { readonly ok: false; readonly reason: 'absent' | 'too-large' | 'invalid-json' | string };

export function readProposedManifests(workspaceRoot: string, platform: string = process.platform): ProposedResult {
  for (const rel of MANIFEST_FILES) {
    const file = join(workspaceRoot, rel);
    let text: string;
    try {
      if (statSync(file).size > MAX_MANIFEST_BYTES) return { ok: false, reason: 'too-large' };
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
    const set = parseManifestFile(parsed, platform);
    if (!set.ok) return { ok: false, reason: set.reason };
    return { ok: true, file: rel.split('\\').join('/'), manifests: set.set.checks, hashes: set.set.hashes };
  }
  return { ok: false, reason: 'absent' };
}

/** Approves checks through the CLI (a trusted channel). Other surfaces cannot call this path. */
export async function approveManifests(
  ws: WorkspaceServices,
  manifests: readonly CheckManifest[],
  hashes: { readonly [id: string]: string },
  source: string,
  nowMs: number = Date.now(),
): Promise<ApprovalRecord> {
  const record: ApprovalRecord = {
    workspaceId: ws.workspaceId,
    hashes: { ...hashes },
    manifests: Object.fromEntries(manifests.map((m) => [m.id, m])),
    approvedAt: new Date(nowMs).toISOString(),
    channel: 'cli',
    source: source.slice(0, 200),
  };
  await ws.host.transact((tx) => {
    // Replace, never merge: a check absent from this approval loses its approval, so approving
    // again cannot keep authority the person no longer sees in the manifest.
    tx.put('check-approvals', ws.workspaceId, record);
  });
  return record;
}

export async function revokeApproval(ws: WorkspaceServices, checkIds: readonly string[] = []): Promise<number> {
  let removed = 0;
  await ws.host.transact((tx) => {
    const prior = tx.get<ApprovalRecord>('check-approvals', ws.workspaceId);
    if (prior === undefined) return;
    if (checkIds.length === 0) {
      removed = Object.keys(prior.hashes).length;
      tx.delete('check-approvals', ws.workspaceId);
      return;
    }
    const hashes = { ...prior.hashes };
    const manifests = { ...prior.manifests };
    for (const id of checkIds) {
      if (hashes[id] !== undefined) removed += 1;
      delete hashes[id];
      delete manifests[id];
    }
    tx.put('check-approvals', ws.workspaceId, { ...prior, hashes, manifests });
  });
  return removed;
}

export function approvedManifests(ws: WorkspaceServices): readonly CheckManifest[] {
  const record = ws.host.get<ApprovalRecord>('check-approvals', ws.workspaceId);
  if (record === undefined) return [];
  return Object.keys(record.hashes)
    .sort()
    .map((id) => record.manifests[id])
    .filter((m): m is CheckManifest => m !== undefined);
}

/**
 * Approves an analyzer proposal (a `jevris-checks-1` object from the certified-analyzer
 * registry) through the CLI. It is parsed with the same rules as a workspace file.
 */
export async function approveProposal(ws: WorkspaceServices, proposal: unknown, source: string, platform: string = process.platform): Promise<ApprovalRecord | { readonly ok: false; readonly reason: string }> {
  const parsed = parseManifestFile(proposal, platform);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return approveManifests(ws, parsed.set.checks, parsed.set.hashes, source);
}

export interface HardwareRunnerRecord {
  readonly hardware: string;
  readonly attached: boolean;
  readonly at: string;
}

/** Declares (attached) or withdraws a hardware capability of this host's runner (CLI only). */
export async function setHardwareRunner(ws: WorkspaceServices, hardware: string, attached: boolean, nowMs: number = Date.now()): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hardware)) throw new Error('hardware: invalid name');
  await ws.host.transact((tx) => {
    if (attached) tx.put('hardware-runners', hardware, { hardware, attached, at: new Date(nowMs).toISOString() } satisfies HardwareRunnerRecord);
    else tx.delete('hardware-runners', hardware);
  });
}

export function attachedHardware(ws: WorkspaceServices): readonly string[] {
  return ws.host
    .list<HardwareRunnerRecord>('hardware-runners')
    .filter((r) => r.attached)
    .map((r) => r.hardware)
    .sort();
}

export interface VerificationSupport {
  readonly state: 'supported' | 'unsupported';
  readonly reason: string;
  readonly approvedCheckIds: readonly string[];
  /** Proposed checks whose current manifest differs from the approved hash. */
  readonly pendingApproval: readonly string[];
}

/**
 * Why verification is unsupported, with its fix (doctor, `jevris verify`). One source:
 * the CLI doctor imports these rather than copying them.
 */
export const VERIFICATION_NO_MANIFEST_REASON =
  'verification remains unsupported until an approved runner manifest exists; fix: run `jevris verify profile` to see proposed checks, then `jevris verify approve --proposal` (or write jevris.checks.json and run `jevris verify approve`).';
/** jevris.checks.json is there but not approved: plain `verify approve` approves that file (`--proposal` would approve the profile instead). */
export const VERIFICATION_PENDING_REASON = 'verification is unsupported until you approve the checks in jevris.checks.json; fix: run `jevris verify approve`.';

export function verificationSupport(ws: WorkspaceServices, platform: string = process.platform): VerificationSupport {
  const record = ws.host.get<ApprovalRecord>('check-approvals', ws.workspaceId);
  const approved = record === undefined ? [] : Object.keys(record.hashes).sort();
  const proposed = readProposedManifests(ws.workspaceRoot, platform);
  const pending: string[] = [];
  if (proposed.ok) {
    for (const [id, hash] of Object.entries(proposed.hashes)) if (record?.hashes[id] !== hash) pending.push(id);
  }
  if (approved.length === 0) {
    return {
      state: 'unsupported',
      reason: proposed.ok ? VERIFICATION_PENDING_REASON : VERIFICATION_NO_MANIFEST_REASON,
      approvedCheckIds: [],
      pendingApproval: pending.sort(),
    };
  }
  return { state: 'supported', reason: 'approved runner manifest present.', approvedCheckIds: approved, pendingApproval: pending.sort() };
}

export interface VerifyRequest {
  readonly taskId: string | null;
  readonly checkIds: readonly string[];
  readonly acceptanceCheckIds?: readonly string[];
  readonly requirementIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly hardware?: readonly string[];
  readonly git?: GitPort;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly store?: import('@jevris/store').OpenStoreResult;
  /**
   * A run the sidecar queued itself at a Stop (`verification.backgroundAtStop`) is not what a
   * Stop reminder or a restore asked for, so it is not counted as a check that followed one.
   */
  readonly origin?: 'stop-background';
}

export interface VerifyOutcome {
  readonly ran: readonly CheckRun[];
  readonly completion: CompletionReport;
  readonly support: VerificationSupport;
}

export async function runVerification(ws: WorkspaceServices, request: VerifyRequest): Promise<VerifyOutcome> {
  const manifests = approvedManifests(ws);
  const support = verificationSupport(ws);
  const unknown = request.checkIds.filter((id) => !manifests.some((m) => m.id === id));
  // A check run after a Stop reminder is what the reminder asked for (P6); it is never evidence.
  const attributable = manifests.length > 0 && unknown.length === 0 && request.origin !== 'stop-background';
  if (attributable) await noteReminderCheckStarted(ws.hook, ws.workspaceId, request.taskId, Date.now()).catch(() => undefined);
  if (attributable) await noteRestoreCheckStarted(ws, Date.now()).catch(() => undefined);
  const ran =
    manifests.length === 0 || unknown.length > 0
      ? []
      : await runChecks(
          manifests,
          {
            workspaceRoot: ws.workspaceRoot,
            workspaceId: ws.workspaceId,
            taskId: request.taskId,
            evidence: ws.evidence,
            receipts: ws.receipts,
            ...(request.env === undefined ? {} : { env: request.env }),
            ...(request.git === undefined ? {} : { git: request.git }),
            hardware: request.hardware ?? attachedHardware(ws),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          request.checkIds,
        );
  // Log reduction (MEM-08, US15): each check's stored output gets a distilled view record
  // (error state, stderr offset, kept spans) against its handle; the original is unchanged. The
  // runner built the view (in the output worker for a large output, P6); a run without one gets
  // it built here.
  const sepBytes = new TextEncoder().encode(RUNNER_STDERR_SEPARATOR).length;
  for (const run of ran) {
    const handle = run.receipt.rawOutputHandle;
    if (run.exec === null || handle === null) continue;
    try {
      const stored = { handle, command: `check ${run.receipt.checkId}`, exitCode: run.exec.exitCode, stdout: run.exec.stdout, stderr: run.exec.stderr, stderrOffset: run.exec.stdout.length + sepBytes };
      if (run.view === undefined || run.view === null) await distillStoredOutput(ws, stored);
      else await recordStoredView(ws, stored, run.view);
    } catch {
      // A view record is an aid; the receipt and the stored original already stand.
    }
  }
  const completion = await verificationStatus(ws, request);
  return { ran, completion, support };
}

/** Read-only: the latest receipts and the completion verdict, running nothing. */
export async function verificationStatus(ws: WorkspaceServices, request: Omit<VerifyRequest, 'signal' | 'hardware'>): Promise<CompletionReport> {
  return evaluateCompletion({
    workspaceRoot: ws.workspaceRoot,
    workspaceId: ws.workspaceId,
    taskId: request.taskId,
    manifests: approvedManifests(ws),
    ...(request.acceptanceCheckIds === undefined ? {} : { acceptanceCheckIds: request.acceptanceCheckIds }),
    ...(request.requirementIds === undefined ? {} : { requirementIds: request.requirementIds }),
    receipts: ws.receipts,
    state: ws.state,
    ...(request.git === undefined ? {} : { git: request.git }),
    ...(request.store === undefined ? {} : { store: request.store }),
    scope: receiptScopeOf(ws),
  });
}

export function receiptsFor(ws: WorkspaceServices, taskId: string | null): readonly StoredReceipt[] {
  return ws.receipts.list(ws.workspaceId, taskId === null ? {} : { taskId });
}

export function stopReportFor(ws: WorkspaceServices, taskId: string | null): StopReport | undefined {
  return lastStopReport(ws.state, ws.workspaceId, taskId);
}
