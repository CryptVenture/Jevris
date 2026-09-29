/**
 * Event normalization and per-aggregate ordering (DEC-01, §6.3).
 *
 * An adapter turns a native hook payload into a `NormalizedHarnessEvent`. This module turns that
 * into a domain `EventEnvelope` and keeps three identifiers apart:
 *
 * - the transport event id deduplicates one delivery (`provenance.transportEventId`);
 * - the logical operation id names retries of one intended action (`causationId`);
 * - the tool-use id names one harness tool invocation (`provenance.toolUseId`).
 *
 * The dedup key is the adapter's sha256 over the identifying fields. When a harness gives no
 * stable id, the adapter's key already covers session, native invocation identity and payload
 * hash; this module adds the per-workspace sequence only to the event id, never to the key, so a
 * redelivery after a restart still deduplicates. Collisions need a sha256 collision.
 *
 * Ordering is only per owned aggregate (a task): transitions apply by compare-and-swap on the
 * task revision. A late result is kept for inspection but never overwrites a newer revision or
 * completes a cancelled task.
 */
import {
  EventEnvelopeContract,
  ID_PATTERN,
  contentHash,
  type EventEnvelope,
  type Json,
  type NormalizedHarnessEvent,
} from '@jevris/contracts';

const ID = new RegExp(ID_PATTERN);
const DEDUP = /^[0-9a-f]{64}$/;

export interface EnvelopeInput {
  readonly event: NormalizedHarnessEvent;
  readonly workspaceId: string;
  /** Per-workspace delivery sequence, assigned by the receiver. */
  readonly sequence: number;
  /** Receipt time, supplied by software (never taken from the event text). */
  readonly occurredAt: string;
  /** The task revision the event was produced against. */
  readonly expectedRevision: string;
  /** Absolute deadline for acting on this event. */
  readonly deadlineAt: string;
  readonly taskId?: string | null;
  /** The transport's own delivery id, when the harness gives one. */
  readonly transportEventId?: string | null;
  /** The logical operation this event retries, when known. */
  readonly operationId?: string | null;
}

export type EnvelopeResult =
  | { readonly ok: true; readonly envelope: EventEnvelope }
  | { readonly ok: false; readonly reasonCode: 'INVALID_EVENT' | 'INVALID_DEDUP_KEY' | 'INVALID_ENVELOPE'; readonly issues?: readonly string[] };

function safeId(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

/** Builds and validates the domain envelope for one normalized harness event. */
export function toEventEnvelope(input: EnvelopeInput): EnvelopeResult {
  const event = input.event;
  if (event === null || typeof event !== 'object' || event.schemaVersion !== '1.0') return { ok: false, reasonCode: 'INVALID_EVENT' };
  if (typeof event.dedupKey !== 'string' || !DEDUP.test(event.dedupKey)) return { ok: false, reasonCode: 'INVALID_DEDUP_KEY' };
  const dedupKey = `sha256:${event.dedupKey}`;
  const payload: { [key: string]: Json } = {
    toolName: event.toolName,
    model: event.model,
    trigger: event.trigger,
    blocking: event.blocking,
    permissionMode: event.permissionMode,
    summary: event.payload as Json,
  };
  const provenance: { harness: typeof event.harness; nativeEventName: string; transportEventId?: string; toolUseId?: string; dedupKey: string } = {
    harness: event.harness,
    nativeEventName: event.nativeEventName,
    dedupKey,
  };
  const transport = safeId(input.transportEventId);
  if (transport !== undefined) provenance.transportEventId = transport;
  const toolUse = safeId(event.toolUseId);
  if (toolUse !== undefined) provenance.toolUseId = toolUse;
  const candidate: Record<string, unknown> = {
    schemaVersion: '1.0',
    eventId: `ev-${event.dedupKey.slice(0, 40)}`,
    workspaceId: input.workspaceId,
    sessionId: safeId(event.sessionId) ?? 'unknown-session',
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    kind: event.kind,
    expectedRevision: input.expectedRevision,
    deadlineAt: input.deadlineAt,
    payload,
    evidence: [],
    provenance,
  };
  const agent = safeId(event.agentId);
  if (agent !== undefined) candidate['agentId'] = agent;
  const task = safeId(input.taskId);
  if (task !== undefined) candidate['taskId'] = task;
  const operation = safeId(input.operationId);
  if (operation !== undefined) candidate['causationId'] = operation;
  const checked = EventEnvelopeContract.validate(candidate);
  if (!checked.ok) return { ok: false, reasonCode: 'INVALID_ENVELOPE', issues: checked.issues.map((issue) => `${issue.path}:${issue.code}`) };
  return { ok: true, envelope: checked.value };
}

/** Bounded delivery deduplication by dedup key (per workspace). */
export class EventDeduper {
  readonly #seen = new Map<string, number>();
  readonly #capacity: number;
  constructor(capacity = 10_000) {
    this.#capacity = Math.max(16, capacity);
  }
  /** True the first time a (workspace, dedup key) pair is seen. */
  accept(envelope: Pick<EventEnvelope, 'workspaceId' | 'provenance' | 'eventId'>): boolean {
    const key = `${envelope.workspaceId}\0${envelope.provenance?.dedupKey ?? envelope.eventId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, this.#seen.size);
    if (this.#seen.size > this.#capacity) {
      const first = this.#seen.keys().next();
      if (first.done !== true) this.#seen.delete(first.value);
    }
    return true;
  }
  get size(): number {
    return this.#seen.size;
  }
}

export type AggregateStatus = 'open' | 'cancelled' | 'completed';

export interface AggregateState {
  readonly id: string;
  readonly revision: number;
  readonly status: AggregateStatus;
  /** The event that produced the current revision. */
  readonly lastEventId: string | null;
}

export type TransitionResult =
  | { readonly ok: true; readonly state: AggregateState }
  | { readonly ok: false; readonly reasonCode: 'STALE_REVISION' | 'TASK_CANCELLED' | 'TASK_COMPLETED'; readonly state: AggregateState; readonly late: boolean };

export interface LateResult {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly reasonCode: string;
}

/**
 * Per-aggregate compare-and-swap ordering. Each accepted transition bumps the revision by one.
 * A transition against an older revision is refused and kept as a late result for inspection.
 */
export class AggregateOrderer {
  readonly #states = new Map<string, AggregateState>();
  readonly #late: LateResult[] = [];
  readonly #lateCap: number;
  constructor(lateCap = 1000) {
    this.#lateCap = lateCap;
  }

  get(id: string): AggregateState {
    return this.#states.get(id) ?? { id, revision: 0, status: 'open', lastEventId: null };
  }

  /**
   * Applies one transition when `expectedRevision` equals the current revision. `to` is
   * `open` for progress, `cancelled` or `completed` for a terminal transition.
   */
  apply(id: string, expectedRevision: number, eventId: string, to: AggregateStatus = 'open'): TransitionResult {
    const current = this.get(id);
    const refuse = (reasonCode: 'STALE_REVISION' | 'TASK_CANCELLED' | 'TASK_COMPLETED'): TransitionResult => {
      const late = expectedRevision < current.revision;
      this.#late.push({ aggregateId: id, eventId, expectedRevision, currentRevision: current.revision, reasonCode });
      if (this.#late.length > this.#lateCap) this.#late.shift();
      return { ok: false, reasonCode, state: current, late };
    };
    if (current.status === 'cancelled') return refuse('TASK_CANCELLED');
    if (current.status === 'completed') return refuse('TASK_COMPLETED');
    if (expectedRevision !== current.revision) return refuse('STALE_REVISION');
    const next: AggregateState = { id, revision: current.revision + 1, status: to, lastEventId: eventId };
    this.#states.set(id, next);
    return { ok: true, state: next };
  }

  lateResults(): readonly LateResult[] {
    return [...this.#late];
  }

  /** A stable digest of every aggregate state, for replay and permutation checks. */
  digest(): string {
    const entries = [...this.#states.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return contentHash(entries.map((entry) => [entry.id, entry.revision, entry.status, entry.lastEventId]));
  }
}
