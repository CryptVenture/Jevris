/**
 * The persisted decision state machine (DEC-04, §7.1) and its journal.
 *
 * One file per decision (`<journalDir>/<decisionId>.json`), rewritten atomically on every
 * transition with the platform's durable write. Decision ids are random, so processes never
 * write the same file, and a crash leaves either the previous state or the next one.
 *
 * States: received, validated, evidence-ready, reserved, evaluating, evaluated, planned, then a
 * terminal applied/refused/stale/abstained/quarantined, then reconciled. A terminal record is
 * immutable except for later usage reconciliation. `planned` is where an advisory decision rests:
 * it reaches `applied` only with an adapter receipt.
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DecisionRecordContract, TERMINAL_DECISION_STATES, type DecisionRecord, type DecisionState } from '@jevris/contracts';
import { durableWrite } from '@jevris/platform';

export const JOURNAL_VERSION = 'jevris-decision-journal-1';

const TRANSITIONS: Readonly<Record<DecisionState, readonly DecisionState[]>> = {
  received: ['validated', 'refused', 'abstained'],
  validated: ['evidence-ready', 'planned', 'refused', 'abstained'],
  'evidence-ready': ['reserved', 'planned', 'refused', 'abstained'],
  reserved: ['evaluating', 'abstained', 'refused'],
  // refused: the host's egress guard refused the request locally, so nothing was sent.
  evaluating: ['evaluated', 'quarantined', 'abstained', 'stale', 'refused'],
  evaluated: ['planned', 'abstained', 'stale', 'quarantined'],
  planned: ['applied', 'refused', 'stale', 'reconciled'],
  applied: ['reconciled'],
  refused: ['reconciled'],
  stale: ['reconciled'],
  abstained: ['reconciled'],
  quarantined: ['reconciled'],
  reconciled: [],
};

/** States a crash can leave a decision in (work in flight). */
export const IN_FLIGHT_STATES: readonly DecisionState[] = Object.freeze(['received', 'validated', 'evidence-ready', 'reserved', 'evaluating', 'evaluated']);

export function canTransition(from: DecisionState, to: DecisionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: DecisionState): boolean {
  return TERMINAL_DECISION_STATES.includes(state);
}

const DECISION_ID = /^d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDecisionId(value: unknown): value is string {
  return typeof value === 'string' && DECISION_ID.test(value);
}

/** What is known before the record is final. Everything is content-free. */
export interface DecisionDraft {
  readonly specId: string;
  readonly specVersion: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  /** The harness session the decision came from, when known (US12). */
  readonly sessionId?: string | null;
  readonly evidenceRevision: string;
  readonly lane: 'interactive' | 'background';
  readonly mode: DecisionRecord['mode'];
  readonly receivedAt: string;
  readonly questionHash: string;
  readonly packetHash: string | null;
  readonly reservationId: string | null;
  readonly reservedMicroUsd: number;
  /** True once a request may have left the process (it may be billed). */
  readonly sent: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly modelResolved: string | null;
  /** The conservative input-token estimate of the request sent, with its encoder (P7); absent when nothing was answered. */
  readonly estimate?: { readonly inputTokens: number; readonly encoderId: string } | null;
}

export interface SchemaFailureNote {
  readonly kind: string;
  readonly questionId: string | null;
  readonly responseHash: string | null;
  readonly applied: false;
}

export interface JournalEntry {
  readonly schemaVersion: typeof JOURNAL_VERSION;
  readonly decisionId: string;
  readonly state: DecisionState;
  readonly history: readonly { readonly state: DecisionState; readonly atMs: number }[];
  readonly draft: DecisionDraft;
  /** The final §23.4 record, present from the first terminal (or resting `planned`) state. */
  readonly record: DecisionRecord | null;
  readonly schemaFailure: SchemaFailureNote | null;
}

export interface JournalPruneResult {
  readonly removed: number;
  /** Entries inside the window. */
  readonly kept: number;
  /** Entries past the window kept for an unknown effect (in flight after sending, or usage pending). */
  readonly keptForReconciliation: number;
  readonly unreadable: number;
  readonly failed: number;
}

/**
 * When an entry was received: its first transition, the store row's `created_at_ms`. The one time
 * both the journal prune and the store's archive watermark compare with the retention cutoff (K4).
 */
export function journalEntryCreatedAtMs(entry: Pick<JournalEntry, 'history'>): number {
  const first = entry.history[0]?.atMs;
  return typeof first === 'number' && Number.isFinite(first) ? first : 0;
}

/** An unknown effect: in flight after a request may have left, or at rest with usage pending reconciliation. */
function needsReconciliation(entry: JournalEntry): boolean {
  if (entry.record === null) return entry.draft.sent;
  return entry.record.billingBasis === 'estimate-pending-reconcile';
}

export type JournalResult = { readonly ok: true; readonly entry: JournalEntry } | { readonly ok: false; readonly reasonCode: string };

export class DecisionJournal {
  readonly #dir: string;
  readonly #now: () => number;
  #ready = false;

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.#dir = dir;
    this.#now = now;
  }

  get dir(): string {
    return this.#dir;
  }

  #path(decisionId: string): string {
    return join(this.#dir, `${decisionId}.json`);
  }

  async #save(entry: JournalEntry): Promise<boolean> {
    if (!this.#ready) {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
      this.#ready = true;
    }
    const written = await durableWrite(this.#path(entry.decisionId), `${JSON.stringify(entry)}\n`);
    return written.ok;
  }

  async create(decisionId: string, draft: DecisionDraft): Promise<JournalResult> {
    if (!isDecisionId(decisionId)) return { ok: false, reasonCode: 'INVALID_DECISION_ID' };
    const entry: JournalEntry = {
      schemaVersion: JOURNAL_VERSION,
      decisionId,
      state: 'received',
      history: [{ state: 'received', atMs: this.#now() }],
      draft,
      record: null,
      schemaFailure: null,
    };
    return (await this.#save(entry)) ? { ok: true, entry } : { ok: false, reasonCode: 'JOURNAL_WRITE' };
  }

  /**
   * Moves an entry to `to`. Illegal transitions are refused, and a terminal record is never
   * rewritten except by `reconciled` (which only adds usage and cost).
   */
  async transition(
    entry: JournalEntry,
    to: DecisionState,
    patch: { readonly draft?: Partial<DecisionDraft>; readonly record?: DecisionRecord; readonly schemaFailure?: SchemaFailureNote } = {},
  ): Promise<JournalResult> {
    if (!canTransition(entry.state, to)) return { ok: false, reasonCode: 'ILLEGAL_TRANSITION' };
    if (patch.record !== undefined) {
      const checked = DecisionRecordContract.validate(patch.record);
      if (!checked.ok) return { ok: false, reasonCode: 'INVALID_RECORD' };
      if (entry.record !== null && to !== 'reconciled' && to !== 'applied' && to !== 'stale' && to !== 'refused') return { ok: false, reasonCode: 'RECORD_IMMUTABLE' };
    }
    const next: JournalEntry = {
      ...entry,
      state: to,
      history: [...entry.history, { state: to, atMs: this.#now() }],
      draft: patch.draft === undefined ? entry.draft : { ...entry.draft, ...patch.draft },
      record: patch.record ?? entry.record,
      schemaFailure: patch.schemaFailure ?? entry.schemaFailure,
    };
    return (await this.#save(next)) ? { ok: true, entry: next } : { ok: false, reasonCode: 'JOURNAL_WRITE' };
  }

  async read(decisionId: string): Promise<JournalEntry | null> {
    if (!isDecisionId(decisionId)) return null;
    let text: string;
    try {
      text = await readFile(this.#path(decisionId), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as JournalEntry;
      if (parsed.schemaVersion !== JOURNAL_VERSION || parsed.decisionId !== decisionId) return null;
      if (parsed.record !== null && !DecisionRecordContract.validate(parsed.record).ok) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * K4 (sidecar concurrency audit; owner decisions DOMAINS ededdba): removes the entries the
   * retention sweep has already removed from the store, so the store's re-archive cannot bring
   * them back. An entry goes when it was received before `beforeMs` (`journalEntryCreatedAtMs`,
   * the store row's `created_at_ms`) and it is at rest. Kept past the window, because an unknown
   * effect is never dropped: an entry still in flight after a request may have left
   * (`draft.sent`), and a record whose usage waits for reconciliation. An unreadable file is left
   * alone and counted. `dryRun` counts without removing.
   */
  async prune(input: { readonly beforeMs: number; readonly dryRun?: boolean }): Promise<JournalPruneResult> {
    let removed = 0;
    let kept = 0;
    let keptForReconciliation = 0;
    let unreadable = 0;
    let failed = 0;
    if (!Number.isFinite(input.beforeMs)) return { removed, kept, keptForReconciliation, unreadable, failed };
    for (const decisionId of await this.list()) {
      const entry = await this.read(decisionId);
      if (entry === null) {
        unreadable += 1;
        continue;
      }
      if (journalEntryCreatedAtMs(entry) >= input.beforeMs) {
        kept += 1;
        continue;
      }
      if (needsReconciliation(entry)) {
        keptForReconciliation += 1;
        continue;
      }
      if (input.dryRun === true) {
        removed += 1;
        continue;
      }
      try {
        await unlink(this.#path(decisionId));
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, kept, keptForReconciliation, unreadable, failed };
  }

  /** Every decision id in the journal (newest files are not guaranteed first). */
  async list(): Promise<readonly string[]> {
    try {
      const names = await readdir(this.#dir);
      return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter(isDecisionId);
    } catch {
      return [];
    }
  }
}
