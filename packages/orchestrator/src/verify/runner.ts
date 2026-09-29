/**
 * The verification runner (VER-01, VER-02, US17, US24, E21). It executes approved check
 * manifests and writes one receipt per check, passed or not. A check whose declared inputs
 * changed while it ran is recorded as `unknown`, never as passed.
 */
import { realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInsideOrSame } from '@jevris/platform';
import type { EvidenceStore } from '../evidence-store.js';
import { checkUmask, runProcess, type ExecResult } from './exec.js';
import { fingerprint, runnerEnvironment, type EnvMap } from './environment.js';
import type { CheckManifest } from './manifest.js';
import { manifestHash } from './manifest.js';
import { parseResults, type StructuredResults } from './results.js';
import { checkOutputView, joinOutput, processOutputOffLoop, type OutputJob } from './output-work.js';
import type { BuiltView } from '../memory/distill.js';
import { recordRunnerReceipt, type ReceiptOutcome, type RunnerReceipt, type WritableReceiptLedger } from './receipts.js';
import { nodeGit, scopedRevision, snapshotRevision, type GitPort, type RevisionSnapshot } from './revision.js';
import { iso, utf8 } from '../util.js';

const MAX_RESULT_FILE = 16 * 1024 * 1024;

export { RUNNER_STDERR_SEPARATOR } from './output-work.js';

export interface RunnerContext {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly taskId?: string | null;
  readonly evidence: EvidenceStore;
  readonly receipts: WritableReceiptLedger;
  readonly env?: EnvMap;
  readonly platform?: string;
  readonly arch?: string;
  readonly nodeVersion?: string;
  readonly git?: GitPort;
  /** Hardware tags this runner declares (C72); a check needing another tag is not run. */
  readonly hardware?: readonly string[];
  readonly toolchains?: { readonly [name: string]: string };
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly captureBytes?: number;
  /** POSIX file-mode mask for the check; default `checkUmask()`, never the sidecar's private 077. */
  readonly umask?: number;
}

export interface CheckRun {
  readonly receipt: RunnerReceipt;
  readonly exec: ExecResult | null;
  /** The rules view of the stored output (MEM-08), against `receipt.rawOutputHandle`; null when none was stored. */
  readonly view?: BuiltView | null;
}

function outcomeOf(exec: ExecResult, results: StructuredResults | null, format: CheckManifest['resultFormat']): { readonly outcome: ReceiptOutcome; readonly reason: string } {
  if (!exec.spawned) return { outcome: 'not-run', reason: exec.reason };
  if (exec.timedOut) return { outcome: 'failed', reason: 'timeout' };
  if (exec.reason === 'aborted') return { outcome: 'unknown', reason: 'aborted' };
  if (exec.signal !== null) return { outcome: 'failed', reason: `signal:${exec.signal}` };
  if (results !== null && results.failed > 0) return { outcome: 'failed', reason: 'structured-failures' };
  if (exec.exitCode !== 0) return { outcome: 'failed', reason: `exit:${String(exec.exitCode)}` };
  if (format !== 'exit-code' && format !== 'auto' && results === null) return { outcome: 'unknown', reason: 'results-unparsed' };
  if (results !== null && results.total === 0) return { outcome: 'unknown', reason: 'no-tests' };
  return { outcome: 'passed', reason: 'exit:0' };
}

function newReceiptId(): string {
  return `rcpt-${randomBytes(10).toString('hex')}`;
}

function resolveCwd(root: string, rel: string): string | null {
  try {
    const realRoot = realpathSync.native(root);
    const target = realpathSync.native(join(realRoot, rel));
    if (!isInsideOrSame(realRoot, target)) return null;
    if (!statSync(target).isDirectory()) return null;
    return target;
  } catch {
    return null;
  }
}

/** The check's result file, read off the event loop (P6); null when absent, outside cwd or too large. */
async function readResultFile(cwd: string, rel: string | null): Promise<string | null> {
  if (rel === null) return null;
  const path = join(cwd, rel);
  try {
    if (!isInsideOrSame(cwd, await realpath(path))) return null;
    if ((await stat(path)).size > MAX_RESULT_FILE) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function runCheck(manifest: CheckManifest, ctx: RunnerContext, snapshot?: RevisionSnapshot): Promise<CheckRun> {
  const platform = ctx.platform ?? process.platform;
  const now = ctx.now ?? (() => Date.now());
  const git = ctx.git ?? nodeGit();
  const before = snapshot ?? await snapshotRevision(ctx.workspaceRoot, git);
  const scopeBefore = await scopedRevision(ctx.workspaceRoot, before, manifest.inputScopes, git);
  const environment = runnerEnvironment(ctx.env ?? process.env, manifest.env, platform);
  const fp = fingerprint(environment.env, {
    platform,
    arch: ctx.arch ?? process.arch,
    node: ctx.nodeVersion ?? process.version,
    ...(ctx.toolchains === undefined ? {} : { toolchains: ctx.toolchains }),
  });
  const base = {
    schemaVersion: 'jevris-receipt-1' as const,
    id: newReceiptId(),
    checkId: manifest.id,
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId ?? null,
    manifestHash: manifestHash(manifest),
    runnerId: manifest.runnerId,
    issuer: 'local-runner' as const,
    argv: [...manifest.argv],
    cwd: manifest.cwd,
    inputRevision: {
      head: before.head,
      dirtyHash: before.dirtyHash,
      revision: before.revision,
      scopeRevision: scopeBefore,
      branch: before.branch,
      lockfileHash: before.lockfileHash,
    },
    environmentHash: fp.hash,
    environment: fp.fingerprint,
    mandatory: manifest.mandatory,
    requirementIds: [...manifest.requirementIds],
    inputScopes: [...manifest.inputScopes],
    ci: null,
  };
  const notRun = async (reason: string): Promise<CheckRun> => {
    const at = now();
    const receipt: RunnerReceipt = {
      ...base,
      startedAt: iso(at),
      endedAt: iso(at),
      durationMs: 0,
      executable: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      outcome: 'not-run',
      outcomeReason: reason,
      results: null,
      rawOutputHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      rawOutputHandle: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
    };
    await recordRunnerReceipt(ctx.receipts, receipt, at);
    return { receipt, exec: null };
  };
  if (manifest.hardware !== null && !(ctx.hardware ?? []).includes(manifest.hardware)) return notRun(`hardware-unavailable:${manifest.hardware}`);
  const cwd = resolveCwd(ctx.workspaceRoot, manifest.cwd);
  if (cwd === null) return notRun('cwd-outside-workspace');
  const [command, ...args] = manifest.argv;
  const exec = await runProcess({
    command,
    args,
    cwd,
    env: environment.env,
    timeoutMs: manifest.timeoutMs,
    platform,
    umask: ctx.umask ?? checkUmask(),
    ...(ctx.captureBytes === undefined ? {} : { captureBytes: ctx.captureBytes }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  const resultFileText = await readResultFile(cwd, manifest.resultFile);
  const job: OutputJob = { stdout: exec.stdout, stderr: exec.stderr, resultFormat: manifest.resultFormat, resultFileText, command: `check ${manifest.id}`, exitCode: exec.exitCode };
  // P6: a large output is joined, hashed, parsed and viewed in the worker thread; otherwise inline.
  const off = exec.spawned ? await processOutputOffLoop(job) : null;
  const results = off !== null ? off.results : parseResults(manifest.resultFormat, utf8(exec.stdout), resultFileText);
  let { outcome, reason } = outcomeOf(exec, results, manifest.resultFormat);
  if (exec.spawned) {
    const after = await snapshotRevision(ctx.workspaceRoot, git);
    const scopeAfter = await scopedRevision(ctx.workspaceRoot, after, manifest.inputScopes, git);
    if (scopeAfter !== scopeBefore && outcome === 'passed') {
      outcome = 'unknown';
      reason = 'inputs-changed-during-run';
    }
  }
  let handle: string | null = null;
  let view: BuiltView | null = null;
  if (exec.spawned) {
    const raw = off !== null ? off.raw : joinOutput(exec.stdout, exec.stderr);
    const meta = await ctx.evidence.put({
      workspaceId: ctx.workspaceId,
      kind: 'runner-output',
      bytes: raw,
      truncated: exec.truncated,
      nowMs: now(),
      ...(off !== null ? { sha256: off.sha256 } : {}),
    });
    handle = meta.handle;
    view = off !== null && `ev:${off.sha256}` === handle ? off.view : checkOutputView(handle, job, raw.length);
  }
  const receipt: RunnerReceipt = {
    ...base,
    startedAt: iso(exec.startedAtMs),
    endedAt: iso(exec.endedAtMs),
    durationMs: Math.max(0, exec.endedAtMs - exec.startedAtMs),
    executable: exec.resolved,
    exitCode: exec.exitCode,
    signal: exec.signal,
    timedOut: exec.timedOut,
    outcome,
    outcomeReason: reason,
    results,
    rawOutputHash: exec.combinedHash,
    rawOutputHandle: handle,
    stdoutBytes: exec.stdoutBytes,
    stderrBytes: exec.stderrBytes,
    truncated: exec.truncated,
  };
  await recordRunnerReceipt(ctx.receipts, receipt, now());
  return { receipt, exec, view };
}

/** Runs the selected checks in manifest order against one starting snapshot. */
export async function runChecks(manifests: readonly CheckManifest[], ctx: RunnerContext, only?: readonly string[]): Promise<readonly CheckRun[]> {
  const git = ctx.git ?? nodeGit();
  const selected = only === undefined || only.length === 0 ? manifests : manifests.filter((m) => only.includes(m.id));
  const runs: CheckRun[] = [];
  for (const manifest of selected) {
    if (ctx.signal?.aborted === true) break;
    runs.push(await runCheck(manifest, { ...ctx, git }));
  }
  return runs;
}
