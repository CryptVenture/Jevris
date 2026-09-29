/**
 * worker.route evidence from real use (owner approval 2026-09-26, "certified pending first
 * use"). Certify proves a worker port with no-cost probes. Each real owned run then adds its
 * first-use check to the live evidence:
 *
 * - a passed check counts as one conforming run (doctor: "verified in use (N runs)");
 * - a failed check (the run was already stopped by its port) demotes worker.route for that
 *   harness version and starts the background re-check (reverify.ts), once.
 *
 * Only a run on the harness's own binary counts. A port given an injected binary (a test
 * stub) records nothing unless the caller passes evidence options itself.
 */
import { jevrisPaths, packageRoot } from '@jevris/platform';
import { defaultHarnessCli, type GlobalHarness } from './global-harness.js';
import { probeHarnessVersion } from './harness-versions.js';
import { recordLiveEvent } from './live-evidence.js';
import { maybeReverify } from './reverify.js';
import type { InitCheck } from './owned-session.js';

export interface WorkerEvidenceOptions {
  /** The Jevris home the evidence goes to. */
  readonly home: string;
  /** The package root the background re-check starts `jevris certify` from. */
  readonly root: string;
  /** The harness version the run used. */
  readonly version: () => Promise<string | null>;
  /** Default maybeReverify (tests inject a seam). */
  readonly reverify?: (options: Parameters<typeof maybeReverify>[0]) => Promise<unknown>;
}

/** Records one run's first-use check. Returns what was recorded. Never throws. */
export async function recordWorkerRun(harness: GlobalHarness, initCheck: InitCheck | null, options: WorkerEvidenceOptions): Promise<'conforming' | 'malformed' | 'none'> {
  if (initCheck === null) return 'none';
  try {
    const version = await options.version();
    if (version === null) return 'none';
    const recorded = await recordLiveEvent(options.home, {
      harness,
      version,
      featureId: 'worker.route',
      conforming: initCheck.ok,
      ...(initCheck.ok || initCheck.reasonCode === null ? {} : { reasonCode: initCheck.reasonCode }),
    });
    if (!recorded) return 'none';
    if (!initCheck.ok) await (options.reverify ?? maybeReverify)({ home: options.home, root: options.root, installed: [harness], versions: { [harness]: version } });
    return initCheck.ok ? 'conforming' : 'malformed';
  } catch {
    return 'none';
  }
}

/** Evidence for a port on the harness's own binary: this user's Jevris home, and its version probed once. */
export function defaultWorkerEvidence(harness: GlobalHarness): WorkerEvidenceOptions | null {
  let root: string;
  try {
    root = packageRoot();
  } catch {
    return null;
  }
  let cached: Promise<string | null> | null = null;
  return {
    home: jevrisPaths({}).home,
    root,
    version: () => (cached ??= probeHarnessVersion(harness, defaultHarnessCli).catch(() => null)),
  };
}

/** The evidence options a port factory uses: none for an injected binary unless given explicitly. */
export function portEvidence(harness: GlobalHarness, options: { readonly command?: unknown; readonly evidence?: WorkerEvidenceOptions | false }): WorkerEvidenceOptions | null {
  if (options.evidence === false) return null;
  if (options.evidence !== undefined) return options.evidence;
  return options.command === undefined ? defaultWorkerEvidence(harness) : null;
}

/** Wraps a port's run so each outcome's first-use check is recorded. */
export function withWorkerEvidence<I, O extends { readonly initCheck: InitCheck | null }>(harness: GlobalHarness, run: (input: I) => Promise<O>, evidence: WorkerEvidenceOptions | null): (input: I) => Promise<O> {
  if (evidence === null) return run;
  return async (input) => {
    const outcome = await run(input);
    await recordWorkerRun(harness, outcome.initCheck, evidence);
    return outcome;
  };
}
