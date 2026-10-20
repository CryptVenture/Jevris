/**
 * Keeps the host ledger's installed harness versions current. The ledger (`harness-versions`, D's recordHarnessVersion) is what the
 * certification gate, the subagent alias rule and `jevris status` read when a hook payload carries no version, and Claude Code's does
 * not. It was written only by install, doctor and certify, so a harness that updates itself (Claude Code does, weekly) was judged
 * on the version it had when Jevris was installed: status showed it, a record's range and the `haiku` alias rule were checked against
 * it, and the background re-check never noticed an upgrade past a record's range.
 *
 * The sidecar calls this in the background, at its start and at a harness's SessionStart: `<binary> --version` for each harness Jevris
 * already knows, at most once an hour per harness, never in a test run and never under a home that is not the account's own (the
 * guard of the certification re-check). The hook launcher never spawns a harness. A failed probe keeps the ledger as it was.
 */
import { defaultHarnessCli, type GlobalHarness, type HarnessCli } from './global-harness.js';
import { refreshHarnessVersions } from './harness-versions.js';
import { foreignHomeRefusal, liveHarnessAllowed } from './live-harness.js';

type Env = { readonly [key: string]: string | undefined };

/** A harness is probed again no sooner than this. */
export const VERSION_REFRESH_MS = 60 * 60 * 1000;

const probedAt = new Map<string, number>();

/** Forgets what was probed (tests). */
export function resetVersionRefresh(): void {
  probedAt.clear();
}

function defaultGuard(env: Env, home: string): string | null {
  if (!liveHarnessAllowed(env)) return 'not probed: test run';
  return foreignHomeRefusal(env, home);
}

export interface VersionRefreshOptions {
  readonly home: string;
  readonly harnesses: readonly GlobalHarness[];
  readonly env?: Env;
  readonly nowMs?: number;
  /** Tests: the harness binaries; default the real ones on PATH. */
  readonly cli?: HarnessCli;
  /** Why a probe may not run here, or null (default: a test run, a foreign HOME). */
  readonly guard?: (env: Env, home: string) => string | null;
}

/** The versions it read and wrote to the ledger; nothing for a harness not due, not on PATH or not allowed here. Never throws. */
export async function refreshInstalledVersions(options: VersionRefreshOptions): Promise<Partial<Record<GlobalHarness, string>>> {
  try {
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now();
    if ((options.guard ?? defaultGuard)(env, options.home) !== null) return {};
    const due = options.harnesses.filter((harness) => nowMs - (probedAt.get(`${options.home}\0${harness}`) ?? Number.NEGATIVE_INFINITY) >= VERSION_REFRESH_MS);
    // Marked before the probe, so callers that ask at the same moment (sidecar start and a SessionStart) probe once.
    for (const harness of due) probedAt.set(`${options.home}\0${harness}`, nowMs);
    if (due.length === 0) return {};
    return await refreshHarnessVersions(options.home, due, options.cli ?? defaultHarnessCli, env);
  } catch {
    return {};
  }
}
