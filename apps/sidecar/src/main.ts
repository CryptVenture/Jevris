import { enableGitWorkers, isOutputWorker, recordLaunchUmask, runOutputWorker, setOutputWorkerScript, warmGitWorkers } from '@jevris/orchestrator';
import { runSidecarMain } from './daemon.js';
import { isMaintenanceWorker, runMaintenanceWorker } from './maintenance.js';

/**
 * Process entry of the detached sidecar (bundled as dist/sidecar.mjs).
 *   node sidecar.mjs [--home <dir>] [--idle-ms <n>] [--supervised]
 * Files it creates start owner-only on POSIX (umask 077).
 */

/** How long after it starts the sidecar starts its git worker threads. */
export const GIT_WORKER_WARM_DELAY_MS = 300;

export interface MainArgs {
  readonly home?: string;
  readonly idleMs?: number;
  readonly supervised: boolean;
}

export function parseMainArgs(argv: readonly string[]): MainArgs | undefined {
  let home: string | undefined;
  let idleMs: number | undefined;
  let supervised = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'run' && i === 0) continue;
    if (arg === '--supervised') {
      supervised = true;
      continue;
    }
    if (arg === '--home' || arg === '--idle-ms') {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0) return undefined;
      i += 1;
      if (arg === '--home') home = value;
      else {
        if (!/^\d{1,10}$/.test(value)) return undefined;
        idleMs = Number(value);
      }
      continue;
    }
    return undefined;
  }
  return { ...(home !== undefined ? { home } : {}), ...(idleMs !== undefined ? { idleMs } : {}), supervised };
}

export async function sidecarMain(argv: readonly string[]): Promise<number> {
  const args = parseMainArgs(argv);
  if (args === undefined) {
    process.stderr.write('usage: jevris sidecar run [--home <dir>] [--idle-ms <n>] [--supervised]\n');
    return 2;
  }
  applyPrivateUmask();
  // P10: this entry file is also the store-maintenance worker's script.
  return runSidecarMain({ ...args, maintenanceWorker: new URL(import.meta.url) });
}

/**
 * POSIX: the sidecar's own files start owner-only (umask 077), and the launching shell's mask
 * it replaced goes to the orchestrator explicitly, so verification checks run under the user's
 * mask as they do in a shell, not the sidecar's 077 (D's recordLaunchUmask, 21e3481). Returns
 * the replaced mask, or null on Windows.
 */
export function applyPrivateUmask(ports: { readonly platform?: string; readonly umask?: (mask: number) => number; readonly record?: (mask: number) => void } = {}): number | null {
  if ((ports.platform ?? process.platform) === 'win32') return null;
  const previous = (ports.umask ?? ((mask: number) => process.umask(mask)))(0o077);
  (ports.record ?? recordLaunchUmask)(previous);
  return previous;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string') return false;
  return /(?:^|[\\/])(?:main\.js|sidecar\.mjs)$/.test(entry);
}

if (isMaintenanceWorker()) {
  // Started by sweepInWorker: sweep on a second connection, answer, and end this thread only.
  await runMaintenanceWorker();
} else if (isOutputWorker()) {
  // Started by the verify runner (D's P6, 3cd3667): answer check-output jobs until the sidecar ends this thread.
  runOutputWorker();
} else if (invokedDirectly()) {
  setOutputWorkerScript(new URL(import.meta.url));
  // git starts its processes from worker threads, so creating one (a blocking call, seconds on a loaded Windows runner) never stands
  // the event loop still. The pool starts once the sidecar is up, so it does not compete with it for the CPU; a git call before a
  // worker is ready runs on the main thread, as it always did.
  enableGitWorkers(true);
  setTimeout(warmGitWorkers, GIT_WORKER_WARM_DELAY_MS).unref();
  const code = await sidecarMain(process.argv.slice(2));
  process.exit(code);
}
