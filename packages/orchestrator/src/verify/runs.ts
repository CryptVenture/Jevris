/**
 * Verification runs in the sidecar (VER-01, VER-05). A run outlives the request that started it:
 * a request answers within its deadline and says which checks are still RUNNING or QUEUED.
 */

/**
 * Why a check without a current receipt has not been answered yet: RUNNING, it is in the run
 * now under way and gets a receipt when that run ends; QUEUED, it waits for the run ahead of it.
 */
export type PendingCheckReason = 'RUNNING' | 'QUEUED';

/**
 * One verification run per workspace (or owned task) at a time; a run outlives the request that
 * started it. A request whose checks the run under way already covers joins it. Any other request
 * is queued behind it, merged with the requests queued before it, so a requested check is never
 * dropped silently by joining a run that does not include it. `ids` null means every approved check.
 */
interface VerificationRun {
  readonly ids: ReadonlySet<string> | null;
  readonly done: Promise<void>;
}

interface QueuedVerification {
  ids: Set<string> | null;
  readonly work: (checkIds: readonly string[]) => Promise<unknown>;
  readonly onStart: () => void;
  readonly done: Promise<void>;
  readonly resolve: () => void;
}

interface WorkspaceRuns {
  active: VerificationRun;
  queued: QueuedVerification | null;
}

const verificationRuns = new Map<string, WorkspaceRuns>();

function coversChecks(ids: ReadonlySet<string> | null, requested: readonly string[]): boolean {
  return ids === null || (requested.length > 0 && requested.every((id) => ids.has(id)));
}

function launchVerification(key: string, ids: ReadonlySet<string> | null, work: QueuedVerification['work'], onStart: () => void): Promise<void> {
  onStart();
  const done: Promise<void> = work(ids === null ? [] : [...ids]).then(
    () => undefined,
    () => undefined,
  ).then(() => {
    const entry = verificationRuns.get(key);
    if (entry === undefined || entry.active.done !== done) return;
    const next = entry.queued;
    if (next === null) {
      verificationRuns.delete(key);
      return;
    }
    entry.queued = null;
    entry.active = { ids: next.ids, done: launchVerification(key, next.ids, next.work, next.onStart) };
    void entry.active.done.then(next.resolve);
  });
  return done;
}

/** Starts, joins or queues a run for these checks; the promise settles when that run has ended. */
export function scheduleVerification(key: string, requested: readonly string[], work: QueuedVerification['work'], onStart: () => void): Promise<void> {
  const wanted = requested.length === 0 ? null : new Set(requested);
  const entry = verificationRuns.get(key);
  if (entry === undefined) {
    const fresh: WorkspaceRuns = { active: { ids: wanted, done: Promise.resolve() }, queued: null };
    verificationRuns.set(key, fresh);
    fresh.active = { ids: wanted, done: launchVerification(key, wanted, work, onStart) };
    return fresh.active.done;
  }
  if (coversChecks(entry.active.ids, requested)) return entry.active.done;
  if (entry.queued !== null) {
    const queued = entry.queued;
    if (wanted === null) queued.ids = null;
    else if (queued.ids !== null) for (const id of wanted) queued.ids.add(id);
    return queued.done;
  }
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  entry.queued = { ids: wanted === null ? null : new Set(wanted), work, onStart, done, resolve };
  return done;
}

/** For each check in a run under way or queued for this key: RUNNING or QUEUED. */
export function pendingChecks(key: string, approvedIds: readonly string[]): Map<string, PendingCheckReason> {
  const pending = new Map<string, PendingCheckReason>();
  const entry = verificationRuns.get(key);
  if (entry === undefined) return pending;
  for (const id of approvedIds) {
    if (coversChecks(entry.active.ids, [id])) pending.set(id, 'RUNNING');
    else if (entry.queued !== null && coversChecks(entry.queued.ids, [id])) pending.set(id, 'QUEUED');
  }
  return pending;
}

/** The number of verification runs under way or queued in this process (for the sidecar's idle check). */
export function activeVerificationRuns(): number {
  let n = 0;
  for (const entry of verificationRuns.values()) n += entry.queued === null ? 1 : 2;
  return n;
}


/** The run key: the workspace, or the workspace and the owned task being completed. */
export function verificationRunKey(workspaceId: string, taskId: string | null): string {
  return taskId === null ? workspaceId : `${workspaceId}\0${taskId}`;
}
