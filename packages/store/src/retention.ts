/**
 * Retention (DATA-11, SSOT §16.3). Defaults: 7 days for raw tool artifacts and 30 days for
 * redacted local decision records, configurable within organization limits.
 * Pinned memory (capsules with the `pinned` class) is kept until it is unpinned or deleted.
 *
 * The sweep runs at sidecar start and daily, and on `jevris data purge`. Rows are removed
 * with `secure_delete` on, which overwrites their content, and the WAL is truncated, so deleted
 * content does not linger in free pages. `jevris data purge` then compacts the file (VACUUM); the
 * sidecar's own sweep (P10) runs in a maintenance worker, deletes in chunks and returns free
 * pages in small steps instead, so it never holds the write lock for long. Raw tool artifacts live as files under the evidence
 * directory (the store holds only their hashes); files older than the raw window are
 * removed unless a pinned capsule references them.
 */
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenStoreResult, StoreRefusal } from './open.js';
import { driverFor } from './open.js';
import { field, num, refuse, str, write } from './access.js';
import { appendAuditRow } from './governance.js';

export const DAY_MS = 86_400_000;

/**
 * The route-learning retention class (owner 2026-09-26; B with C). Route learning needs weeks
 * to months of outcomes, so its per-workspace aggregate is not a decision record: C's file
 * `<data>/route-learning/<workspaceId>.json` holds policy versions and per-slice, per-model
 * outcome counts and resource sums, plus a window of at most 30 days of outcome ids for
 * reconciliation; ids, counts, costs and times, no text. Like pinned memory, it is outside
 * the 7 and 30 day sweep. `jevris route learning reset --clear-evidence` and
 * `jevris data delete` remove it. C owns the file and its format; B owns this class.
 */
export const ROUTE_LEARNING_RETENTION = Object.freeze({
  retentionClass: 'route-learning',
  directory: 'route-learning',
  /**
   * Everything under the directory is in the class, including C's machine-wide prior
   * (`<data>/route-learning/machine/`, owner 2026-09-26, SSOT §18.5): a text-free aggregate
   * per slice and arm pooled across this user's workspaces. `jevris data delete --scope
   * learning` removes the whole directory, the prior with it.
   */
  subdirectories: Object.freeze(['machine', 'calibration-cases']),
  /*
   * `calibration-cases/` (C 01c1e29, audit P4) is in the folder, so `jevris data delete` removes it
   * with the rest, but it is not kept like the rest: its cases are built from the store's
   * `decision_outcome` rows, so it follows their window (CALIBRATION_CASES_RETENTION).
   */
  /**
   * C's `model-availability.json` (f5b19ab): models found gone on this machine, model ids,
   * reason classes, harness, auth mode, times and counts only, at most 64 entries and 64 KB,
   * mode 0600. It is in this class, and the age sweep leaves it to C's rule: an entry counts
   * only under the registry snapshot it was recorded in, and a registry refresh clears it.
   * `jevris route learning reset --machine` deletes it with the machine-wide prior (C 1547c8b).
   */
  /*
   * `model-offer.json` (owner 2026-09-27, DOMAINS 3f090fa; C's file, B's schedule): the models each
   * installed harness says it offers, model ids and reason codes only. Each idle refresh replaces
   * a harness's entry, so the age sweep leaves it; reset --machine and data delete remove it.
   */
  /*
   * `access-limits.json` (C2's R60, access limits design 4.3; B's R62): the machine's access pauses
   * per harness, sign-in and serving host; classes, ids, times and counts, and for an API-key run
   * where Jevris holds the key its 16-hex credential fingerprint (never the key; never sent to
   * status), never text. At most 128 entries and 64 KiB, mode 0600. It prunes itself (an
   * entry goes 7 days after its expiry), so the age sweep leaves it. `jevris data delete` and
   * `uninstall --delete-data` remove the file, and so does `jevris route learning reset --machine`
   * (C2's resetMachineLearning, R73); R78's clear removes single entries.
   */
  /*
   * `usage-readings.json` (C2's OP-6 core, dc4808b5; owner decision DOMAINS 9deb30c8): the last
   * read-only Codex usage reading per sign-in; per window only a percentage band, a weekly flag and
   * a validated reset (at most 8 days ahead), whether usage was allowed, and whether the read was
   * certified; never the raw payload, text, an account id or a key. At most 4 readings and 4 KiB,
   * mode 0600, fail-open. Each reading replaces its sign-in's, so the age sweep leaves it;
   * `jevris route learning reset --machine`, `jevris data delete` and `uninstall --delete-data`
   * remove the file.
   */
  /*
   * `access-limits.json.damaged-<ms>` (C2's 644d08b7, B's MEDIUM 41): an access-limit record that
   * could not be parsed, set aside before a new one is written, byte for byte as it was; mode 0600,
   * at most 3 (the oldest goes first). They are kept for a person to look at and are not swept by
   * age; `jevris route limits clear --all`, `jevris route learning reset --machine`,
   * `jevris data delete` and `uninstall --delete-data` remove them. Named by pattern, not listed here.
   */
  files: Object.freeze(['model-availability.json', 'model-offer.json', 'access-limits.json', 'usage-readings.json']),
  swept: false,
  removedBy: Object.freeze(['jevris route learning reset --clear-evidence', 'jevris route learning reset --machine', 'jevris data delete']),
});

/**
 * C's local calibration cases (`<data>/route-learning/calibration-cases/<workspaceId>.json`,
 * 01c1e29, audit P4): a provider probability beside a verified task outcome; ids, codes and
 * numbers, no text or decision id. The cases come from the `decision_outcome` rows, which follow
 * `decisionRetentionDays`, and learning never lengthens retention (owner; coordinator 2026-09-27),
 * so a file is removed once its last write (each export replaces the file) is older than that
 * window, even though it sits in the route-learning folder, which is otherwise kept.
 */
export const CALIBRATION_CASES_RETENTION = Object.freeze({
  retentionClass: 'calibration-cases',
  directory: 'route-learning/calibration-cases',
  window: 'decisionRetentionDays',
  swept: true,
  removedBy: Object.freeze(['the retention sweep (by the file\'s last export)', 'jevris route learning reset --clear-evidence (this workspace\'s)', 'jevris data delete', 'jevris uninstall --delete-data']),
});

/**
 * Learning records in the store (owner 2026-09-27, learning-coverage audit P4, P5, P8, P12; B
 * with C, D and E): decision-to-outcome labels (`decision_outcome`), session model changes and
 * advice adherence (`session_model_change`, `advice_adherence`), daily latency counters
 * (`latency_counter`), and a person's accept or reject of a decision (`decision_feedback`). Ids, codes, counts, milliseconds and micro-USD only. They follow
 * `decisionRetentionDays` like decision records, so learning never lengthens retention; a case
 * worth keeping goes into a reviewed calibration release. `jevris data delete --scope learning`
 * (with the route-learning folder), `jevris route learning reset --clear-evidence`, the ledger
 * and data scopes and `uninstall --delete-data` remove them.
 */
export const LEARNING_RECORDS_RETENTION = Object.freeze({
  retentionClass: 'learning-records',
  tables: Object.freeze(['decision_outcome', 'session_model_change', 'advice_adherence', 'latency_counter', 'decision_feedback']),
  window: 'decisionRetentionDays',
  swept: true,
  removedBy: Object.freeze(['the retention sweep', 'jevris data delete --scope learning', 'jevris route learning reset --clear-evidence', 'jevris data delete', 'jevris uninstall --delete-data']),
});

/**
 * The orchestration ledger (`<data>/orchestration/<workspaceId>/state/` and
 * `<data>/orchestration/host/`, D's file ledger: one JSON file per record, ids, codes, counts,
 * times and paths, no source text). B's classes for its collections (2026-09-26):
 *
 * - `historyCollections`: redacted history (delivery dedupe, loop signals, stop reminders and
 *   reports, compaction deferrals, rehydration notes). Swept when the record file is older than
 *   `decisionRetentionDays` (30 by default).
 * - `worker-runs`: redacted run records (status, reason code, model, cost, usage, changed paths).
 *   Swept when `endedAtMs` is older than `decisionRetentionDays`, except a run whose owned
 *   effect is still `held` for reconciliation, which is kept until it is settled.
 * - Every other collection is live state (leases, reservations, budgets, worktrees, fences,
 *   plans, approvals, escalations, memory, probes): it is kept while the workspace exists and
 *   removed with it by `jevris data delete`. An age sweep there would change behaviour.
 *
 * The sweep deletes through D's ledger transaction and lock, so a concurrent writer is never torn.
 */
export const ORCHESTRATION_RETENTION = Object.freeze({
  retentionClass: 'orchestration',
  directory: 'orchestration',
  // evidence-selections and evidence-reads (P10, D 2026-09-27): selection ids, ranked handle ids
  // and reads; ids, ranks and times only. task-estimates (P11, D bcf6b0d): one row per task, its
  // estimate against the committed actual, runs, wall time and tokens; ages out by its last write.
  // restore-outcomes (P9, D 3611bee): how each capsule restore went and what followed, ids and
  // counts. integration-reverts (P2, D 9b082b1): a task id and two commit ids, written once, so
  // its last write is its atMs. revert-scan: the per-workspace scan cursor (head, candidate count);
  // aging it out only makes the next scan run again (D). subagent-runs (P13, D 30798cc): each
  // subagent's type, slice, times and stop count; ids and times only, aged by its last write.
  historyCollections: Object.freeze(['hook-deliveries', 'loop-signals', 'loop-explained', 'stop-reminders', 'stop-reports', 'compaction-deferrals', 'rehydrations', 'evidence-selections', 'evidence-reads', 'task-estimates', 'restore-outcomes', 'integration-reverts', 'revert-scan', 'subagent-runs']),
  workerRunsCollection: 'worker-runs',
  window: 'decisionRetentionDays',
  removedBy: Object.freeze(['the retention sweep (history and worker runs)', 'jevris data delete']),
});

/**
 * D's hook-path records in the store (`hook_records`, v8; sidecar concurrency audit P2): the
 * collections D moved off the file ledger, with ids, codes, counts, times and paths only. Each row
 * ages out by its last write under `decisionRetentionDays`, like the file ledger's history.
 */
export const HOOK_RECORDS_RETENTION = Object.freeze({
  retentionClass: 'hook-records',
  table: 'hook_records',
  window: 'decisionRetentionDays',
  swept: true,
  removedBy: Object.freeze(['the retention sweep (by last write)', 'jevris data delete (the ledger scope, with the store)', 'jevris uninstall --delete-data']),
});

/**
 * Per-provider egress consent (`provider_consent`, v9; owner 7be3c43, OD-4): provider id, consent
 * text version, grant time, and revocation time and kind. One row per provider: a granted row is
 * live consent, and a revoked row is the person's standing refusal, which blocks the provider even
 * while they are signed in to it. Neither ages out: sweeping a revoke would silently re-allow a
 * signed-in provider (B's routing review). Only `jevris data delete` removes them, with the store.
 */
export const PROVIDER_CONSENT_RETENTION = Object.freeze({
  retentionClass: 'provider-consent',
  table: 'provider_consent',
  swept: false,
  keeps: 'granted consent until revoked, and a revoke until consent is given again',
  removedBy: Object.freeze(['a grant from the CLI (replaces a revoke)', 'a revoke from the CLI (replaces a grant)', 'jevris data delete (the ledger scope, with the store)', 'jevris uninstall --delete-data']),
});

/**
 * F's live certification evidence (`<data>/live-evidence/events.jsonl`): harness, version,
 * feature, conforming or a reason code, and a time; never event content. Conforming lines
 * (single or compacted counts) follow `decisionRetentionDays`. A malformed line is a demotion,
 * a safety control that keeps a feature observe-only until a newer certification lifts it, so
 * it is kept; the 1 MiB compaction bounds the file.
 */
export const LIVE_EVIDENCE_RETENTION = Object.freeze({
  retentionClass: 'live-evidence',
  directory: 'live-evidence',
  window: 'decisionRetentionDays',
  keeps: 'demotions',
  removedBy: Object.freeze(['the retention sweep (conforming lines)', 'jevris data delete']),
});

/**
 * Retention in days, named as in the SSOT settings (`privacy.rawArtifactRetentionDays`,
 * `privacy.decisionRetentionDays`) and the host policy (`retention.*`). Decision records and
 * the other redacted local records follow `decisionRetentionDays`.
 */
export interface RetentionPolicy {
  readonly rawArtifactRetentionDays: number;
  readonly decisionRetentionDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = Object.freeze({ rawArtifactRetentionDays: 7, decisionRetentionDays: 30 });
/** The host policy contract's bounds (packages/contracts host-policy.ts). */
export const RETENTION_BOUNDS = Object.freeze({
  rawArtifactRetentionDays: { min: 0, max: 365 },
  decisionRetentionDays: { min: 0, max: 3650 },
});

function days(value: unknown, fallback: number, bounds: { readonly min: number; readonly max: number }): number {
  const base = typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
  return Math.min(Math.max(base, bounds.min), bounds.max);
}

/**
 * The effective policy: the user's choice within the contract bounds, then capped by every
 * narrowing layer (the organization policy and the host policy are maximums; the SSOT sets no
 * minimum). A cap can only shorten retention.
 */
export function effectiveRetention(user: Partial<RetentionPolicy> | undefined, ...caps: readonly (Partial<RetentionPolicy> | undefined)[]): RetentionPolicy {
  let raw = days(user?.rawArtifactRetentionDays, DEFAULT_RETENTION.rawArtifactRetentionDays, RETENTION_BOUNDS.rawArtifactRetentionDays);
  let decision = days(user?.decisionRetentionDays, DEFAULT_RETENTION.decisionRetentionDays, RETENTION_BOUNDS.decisionRetentionDays);
  for (const cap of caps) {
    if (cap === undefined) continue;
    if (typeof cap.rawArtifactRetentionDays === 'number' && Number.isSafeInteger(cap.rawArtifactRetentionDays)) raw = Math.max(0, Math.min(raw, cap.rawArtifactRetentionDays));
    if (typeof cap.decisionRetentionDays === 'number' && Number.isSafeInteger(cap.decisionRetentionDays)) decision = Math.max(0, Math.min(decision, cap.decisionRetentionDays));
  }
  return { rawArtifactRetentionDays: raw, decisionRetentionDays: decision };
}

export interface SweepResult {
  readonly ok: true;
  readonly dryRun: boolean;
  readonly removed: { readonly [table: string]: number };
  readonly rawFiles: number;
  readonly keptPinned: number;
  readonly vacuumed: boolean;
  /**
   * P10, chunked sweep only: the longest time one maintenance write held the write lock (from
   * inside its transaction to its commit, or one free-page step), in ms. Another connection's
   * write waits about this long plus one busy-handler retry step at worst.
   */
  readonly longestWriteMs?: number;
  /**
   * P10, chunked sweep only: each delete chunk that removed rows, with its rows and the time it
   * held the write lock, in order (at most SWEEP_CHUNK_LOG entries). The longest write alone is
   * one sample, which a stalled host decides; these show the chunking itself.
   */
  readonly chunks?: readonly { readonly rows: number; readonly ms: number }[];
}

/** Most chunks a sweep lists in its result. */
export const SWEEP_CHUNK_LOG = 4096;

/**
 * What the sweep removes, in order. `key` names the columns that identify a row, for the chunked
 * sweep on a table without a rowid.
 */
const REDACTED_SQL: readonly { readonly table: string; readonly where: string; readonly key?: string }[] = [
  { table: 'decision_record', where: 'created_at_ms < @redacted' },
  { table: 'event', where: 'received_at_ms < @redacted' },
  { table: 'session', where: "state = 'ended' AND ended_at_ms IS NOT NULL AND ended_at_ms < @redacted" },
  { table: 'verification_receipt', where: 'recorded_at_ms < @redacted' },
  { table: 'capsule_index', where: "retention_class = 'standard' AND created_at_ms < @redacted" },
  // Learning records (owner 2026-09-27): the same window as decision records; learning never
  // relaxes retention.
  { table: 'decision_outcome', where: 'labelled_at_ms < @redacted' },
  { table: 'session_model_change', where: 'at_ms < @redacted' },
  { table: 'advice_adherence', where: 'advised_at_ms < @redacted' },
  { table: 'latency_counter', where: 'day_start_ms < @redacted' },
  { table: 'decision_feedback', where: 'at_ms < @redacted' },
  // D's hook-path records (P2): aged by their last write, like the file ledger's history.
  { table: 'hook_records', where: 'at_ms < @redacted', key: 'workspace_id, collection, key' },
  { table: 'task_transition', where: 'at_ms < @redacted AND EXISTS (SELECT 1 FROM task AS t WHERE t.workspace_id = task_transition.workspace_id AND t.task_id = task_transition.task_id AND t.state IN (\'verified\', \'cancelled\', \'failed\') AND t.updated_at_ms < @redacted)' },
];

function checkpointPassive(driver: NonNullable<ReturnType<typeof driverFor>>): void {
  try {
    driver.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // a busy checkpoint is retried after the next chunk
  }
}

function changes(result: unknown): number {
  return num(field(result, 'changes')) ?? 0;
}

/** One chunk: at most `limit` rows of `table` matching `where`, by rowid or by the named key. */
function chunkSql(table: string, where: string, key: string | undefined, limit: number): string {
  const id = key ?? 'rowid';
  return `DELETE FROM ${table} WHERE (${id}) IN (SELECT ${id} FROM ${table} WHERE ${where} LIMIT ${String(limit)})`;
}

/** Target time of one maintenance write transaction (P10). */
export const SWEEP_CHUNK_TARGET_MS = 8;
/** The fewest rows (or pages) a sweep step shrinks to: a step's fixed cost does not shrink with it. */
export const SWEEP_MIN_STEP = 16;

/**
 * The chunked sweep (P10). Each chunk is its own transaction that sets and clears the maintenance
 * flag inside it, so the flag that lets a sweep delete immutable rows is never committed where
 * another connection could see it. The audit row follows in one more short transaction.
 *
 * Every write here is bounded in time, not only in rows: a chunk that took longer than `chunkMs`
 * halves the next one, a fast one doubles it (up to `chunkRows`), and free pages go back in steps
 * sized the same way. `pause` runs between writes (the worker sleeps there), so the sidecar's own
 * connection, waiting on its busy handler, finds the write lock free within about one chunk.
 * The WAL is checkpointed passively first (no lock on writers), then truncated, which then has
 * almost nothing left to copy.
 */
function sweepChunked(
  store: OpenStoreResult,
  driver: NonNullable<ReturnType<typeof driverFor>>,
  input: {
    readonly nowMs: number;
    readonly rawDir?: string;
    readonly actor?: string;
    readonly channel?: 'system' | 'terminal' | 'cli';
    readonly chunkRows?: number;
    readonly chunkMs?: number;
    readonly pause?: () => void;
    readonly clock?: () => number;
    readonly vacuum?: 'full' | 'incremental';
  },
  policy: RetentionPolicy,
  params: { readonly redacted: number },
  raw: number,
  pinnedHashes: ReadonlySet<string>,
  keptPinned: number,
): SweepResult | StoreRefusal {
  const maxRows = Math.max(1, Math.min(Math.trunc(input.chunkRows ?? 500), 10_000));
  const targetMs = Math.max(1, Math.min(Math.trunc(input.chunkMs ?? SWEEP_CHUNK_TARGET_MS), 1000));
  const clock = input.clock ?? Date.now;
  const pause = input.pause ?? ((): void => undefined);
  /**
   * Next size for a step that handled `size` in `ms`: halve when slow, double when fast, never
   * below SWEEP_MIN_STEP. Part of a write's time is fixed (the commit and its sync, which on a
   * loaded Windows runner took 60 ms or more whatever the rows): without the floor every write
   * looked slow, the size halved to one row, and a 1500-row sweep took more than 120 s.
   */
  const resize = (size: number, ms: number, max: number): number =>
    ms > targetMs ? Math.max(Math.min(SWEEP_MIN_STEP, max), Math.floor(size / 2)) : ms * 4 < targetMs ? Math.min(max, size * 2) : size;
  let limit = Math.min(maxRows, 100);
  let writes = 0;
  let longest = 0;
  const chunks: { rows: number; ms: number }[] = [];
  const removed: Record<string, number> = {};
  for (const { table, where, key } of REDACTED_SQL) {
    removed[table] = 0;
    for (;;) {
      if (writes > 0) pause();
      writes += 1;
      const sql = chunkSql(table, where, key, limit);
      let started = 0;
      const gone = write(
        store,
        ({ driver: d }) => {
          // Timed from inside the transaction: the lock is held from here to the commit.
          started = clock();
          d.prepare("INSERT OR IGNORE INTO maintenance_flag (name) VALUES ('retention')").run();
          const n = changes(d.prepare(sql).run(params));
          d.prepare("DELETE FROM maintenance_flag WHERE name = 'retention'").run();
          return n;
        },
        { ignoreAutomationRefusal: true },
      );
      if (typeof gone !== 'number') return gone;
      removed[table] += gone;
      const took = clock() - started;
      longest = Math.max(longest, took);
      if (gone > 0 && chunks.length < SWEEP_CHUNK_LOG) chunks.push({ rows: gone, ms: took });
      // Copy this chunk's WAL frames into the database here (no lock on writers), so the other
      // connection's commit never runs a large auto-checkpoint of the sweep's frames itself.
      if (gone > 0) checkpointPassive(driver);
      if (gone < limit) break;
      limit = resize(limit, took, maxRows);
    }
  }
  if (writes > 0) pause();
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  const audited = write(
    store,
    ({ driver: d }) =>
      appendAuditRow(
        d,
        { kind: 'retention.sweep', actor: input.actor ?? 'sidecar', channel: input.channel ?? 'system', atMs: input.nowMs },
        { rawArtifactRetentionDays: policy.rawArtifactRetentionDays, decisionRetentionDays: policy.decisionRetentionDays, removed: total },
      ),
    { ignoreAutomationRefusal: true },
  );
  if (Object.hasOwn(audited, 'ok')) return audited as StoreRefusal;
  const rawFiles = sweepRawFiles(input.rawDir, raw, pinnedHashes, false);
  let vacuumed = false;
  if (total > 0) {
    try {
      if (input.vacuum === 'incremental') {
        // Free pages go back to the disk in short steps, each its own write, sized like the chunks.
        if (num(driver.pragma('auto_vacuum', { simple: true })) === 2) {
          let pages = 64;
          for (let step = 0; step < 100_000 && (num(driver.pragma('freelist_count', { simple: true })) ?? 0) > 0; step += 1) {
            if (step > 0) pause();
            const started = clock();
            driver.pragma(`incremental_vacuum(${String(pages)})`);
            const took = clock() - started;
            longest = Math.max(longest, took);
            pages = resize(pages, took, 1024);
            checkpointPassive(driver);
          }
          pause();
        }
        driver.pragma('wal_checkpoint(PASSIVE)');
        pause();
        driver.pragma('wal_checkpoint(TRUNCATE)');
      } else {
        driver.exec('VACUUM');
        driver.pragma('wal_checkpoint(TRUNCATE)');
      }
      vacuumed = true;
    } catch {
      vacuumed = false;
    }
  }
  return { ok: true, dryRun: false, removed, rawFiles, keptPinned, vacuumed, longestWriteMs: longest, chunks };
}

function count(driver: ReturnType<typeof driverFor>, table: string, where: string, params: Record<string, number>): number {
  if (driver === undefined) return 0;
  return num(field(driver.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(params), 'n')) ?? 0;
}

function sweepRawFiles(dir: string | undefined, olderThanMs: number, pinned: ReadonlySet<string>, dryRun: boolean): number {
  if (dir === undefined) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (st === undefined || !st.isFile() || st.mtimeMs >= olderThanMs) continue;
      if (pinned.has(name.replace(/\.[a-z]+$/, ''))) continue;
      if (!dryRun) unlinkSync(full);
      removed += 1;
    } catch {
      // a file removed meanwhile, or not ours to remove
    }
  }
  return removed;
}

/**
 * Applies the retention policy now. `dryRun` counts what would go and changes nothing.
 * `rawDir` is the raw artifact directory (`<data>/evidence`).
 */
export function sweepRetention(
  store: OpenStoreResult,
  input: {
    readonly policy: RetentionPolicy;
    readonly nowMs: number;
    readonly rawDir?: string;
    readonly dryRun?: boolean;
    readonly actor?: string;
    readonly channel?: 'system' | 'terminal' | 'cli';
    /**
     * P10: delete in transactions of at most this many rows (the maintenance worker), so another
     * connection waits at most one chunk for the write lock. Absent: one transaction.
     */
    readonly chunkRows?: number;
    /** P10: target time of one chunk; slower chunks shrink, faster ones grow up to `chunkRows`. */
    readonly chunkMs?: number;
    /** P10: runs between chunked writes (the worker sleeps there to leave the write lock free). */
    readonly pause?: () => void;
    /** Test seam for chunk timing. */
    readonly clock?: () => number;
    /**
     * P10: 'incremental' truncates the WAL and returns free pages in small steps (a store in
     * incremental auto-vacuum mode) instead of a whole-file VACUUM. Default 'full'.
     */
    readonly vacuum?: 'full' | 'incremental';
  },
): SweepResult | StoreRefusal {
  const policy = effectiveRetention(input.policy);
  const redacted = input.nowMs - policy.decisionRetentionDays * DAY_MS;
  const raw = input.nowMs - policy.rawArtifactRetentionDays * DAY_MS;
  const params = { redacted };
  const dryRun = input.dryRun === true;
  if (!store.ok) return refuse(store.reason);
  const driver = driverFor(store);
  if (driver === undefined) return refuse('store-unavailable');
  const pinnedHashes = new Set(
    driver
      .prepare("SELECT content_hash FROM capsule_index WHERE retention_class = 'pinned'")
      .all()
      .map((row) => (str(field(row, 'content_hash')) ?? '').replace(/^sha256:/, '')),
  );
  const keptPinned = num(field(driver.prepare("SELECT COUNT(*) AS n FROM capsule_index WHERE retention_class = 'pinned' AND created_at_ms < ?").get(redacted), 'n')) ?? 0;
  if (dryRun) {
    const removed: Record<string, number> = {};
    for (const { table, where } of REDACTED_SQL) removed[table] = count(driver, table, where, params);
    return { ok: true, dryRun, removed, rawFiles: sweepRawFiles(input.rawDir, raw, pinnedHashes, true), keptPinned, vacuumed: false };
  }
  driver.pragma('secure_delete = ON');
  if (input.chunkRows !== undefined) return sweepChunked(store, driver, input, policy, params, raw, pinnedHashes, keptPinned);
  const result = write(
    store,
    ({ driver: d }) => {
      d.prepare("INSERT OR IGNORE INTO maintenance_flag (name) VALUES ('retention')").run();
      const removed: Record<string, number> = {};
      for (const { table, where } of REDACTED_SQL) removed[table] = num(field(d.prepare(`DELETE FROM ${table} WHERE ${where}`).run(params), 'changes')) ?? 0;
      d.prepare("DELETE FROM maintenance_flag WHERE name = 'retention'").run();
      appendAuditRow(
        d,
        { kind: 'retention.sweep', actor: input.actor ?? 'sidecar', channel: input.channel ?? 'system', atMs: input.nowMs },
        { rawArtifactRetentionDays: policy.rawArtifactRetentionDays, decisionRetentionDays: policy.decisionRetentionDays, removed: Object.values(removed).reduce((a, b) => a + b, 0) },
      );
      return removed;
    },
    { ignoreAutomationRefusal: true },
  );
  if (Object.hasOwn(result, 'ok')) return result as StoreRefusal;
  const removed = result as Record<string, number>;
  const rawFiles = sweepRawFiles(input.rawDir, raw, pinnedHashes, false);
  let vacuumed = false;
  if (Object.values(removed).some((n) => n > 0)) {
    try {
      driver.exec('VACUUM');
      driver.pragma('wal_checkpoint(TRUNCATE)');
      vacuumed = true;
    } catch {
      vacuumed = false;
    }
  }
  return { ok: true, dryRun, removed, rawFiles, keptPinned, vacuumed };
}
