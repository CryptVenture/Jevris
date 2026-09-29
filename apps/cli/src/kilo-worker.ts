/**
 * The Kilo owned session (ORC-05; owner directive 2026-09-26): Kilo is a fork of OpenCode with
 * the same headless `kilo run --format json` (Kilo 7.7.9, from `kilo run --help` on this Mac
 * and the pinned sources), so opencode-worker.ts runs it. This module names Kilo's binary and
 * variables (`KILO_CONFIG_CONTENT`, `KILO_PERMISSION`, `KILO_AUTH_CONTENT`) and one difference:
 *
 * - `KILO_NO_DAEMON=1`. With a Kilo daemon running, `kilo run` would otherwise attach to it and
 *   run in the daemon's environment, not the one this port shaped for the decided auth mode.
 *
 * In a headless run Kilo auto-rejects a permission ask and fails the run, which this port
 * reports as `failed` with Kilo's own line.
 */
import { runOpencodeFamilyWorker, type OpencodeFlavor, type OpencodeWorkerInput, type OpencodeWorkerOutcome } from './opencode-worker.js';
import { withCertifiedSignals } from './model-signals.js';
import { portEvidence, withWorkerEvidence, type WorkerEvidenceOptions } from './worker-evidence.js';

export const KILO_FLAVOR: OpencodeFlavor = {
  harness: 'kilo',
  binary: 'kilo',
  prefix: 'KILO',
  missingMessage: 'unsupported: install Kilo (kilo) and run jevris install --harness kilocode',
  signIn: 'kilo auth login',
  extraEnv: { KILO_NO_DAEMON: '1' },
};

export type KiloWorkerInput = OpencodeWorkerInput;
export type KiloWorkerOutcome = OpencodeWorkerOutcome;

export function runKiloWorker(input: KiloWorkerInput): Promise<KiloWorkerOutcome> {
  return runOpencodeFamilyWorker(KILO_FLAVOR, input);
}

/** A WorkerPort for D's `runLeasedTask` (structurally `{ run(WorkerRunInput) }`). */
export function kiloWorkerPort(options: Pick<KiloWorkerInput, 'command' | 'env'> & { readonly evidence?: WorkerEvidenceOptions | false } = {}): { run(input: Omit<KiloWorkerInput, 'command' | 'env'>): Promise<KiloWorkerOutcome> } {
  const { evidence: _evidence, ...binary } = options;
  const evidence = portEvidence('kilocode', options);
  // A run on the harness's own binary adds its first-use check to the live evidence (worker.route),
  // and gets the found-gone signals its capture certified for that version.
  return { run: withWorkerEvidence('kilocode', withCertifiedSignals('kilocode', (input: Omit<KiloWorkerInput, 'command' | 'env'>) => runKiloWorker({ ...input, ...binary }), evidence), evidence) };
}
