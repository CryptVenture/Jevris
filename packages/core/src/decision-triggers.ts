/**
 * Deterministic trigger filters and coalescing (DEC-08, §7.2, §12.10, E13).
 *
 * A decision is considered only at a trigger: a new task, a new failure family, a repeated
 * unchanged failure, a meaningful diff boundary, worker creation, a context checkpoint
 * boundary, candidate retrieval or a model-change request. Keystrokes, reads, status renders
 * and other events never trigger a call. Repeated triggers for the same task, evidence revision
 * and trigger kind are coalesced into one.
 */
import { sha256Hex, type EventEnvelope } from '@jevris/contracts';

export const TRIGGER_KINDS = [
  'new-task',
  'new-failure-family',
  'repeated-failure',
  'diff-boundary',
  'worker-creation',
  'context-checkpoint',
  'candidate-retrieval',
  'model-change-request',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * The closed, content-free shape of one failed call, as the adapter reported it (the contracts'
 * `HarnessFailureIntent` without its digests). The filter keeps the last one per failure family so
 * the next failure can be compared with it.
 */
export interface FailureShape {
  readonly exitClass: string;
  readonly environmental: boolean;
  readonly elapsed: string;
  readonly present: readonly string[];
}

/** What the adapter's failure features give the filter to tell failures apart. All optional. */
export interface FailureHints {
  /** A one-way digest of the normalized error text; two failures with the same one are the same failure. */
  readonly signature?: string | null;
  /** A one-way digest of the failed call's input; the same one is the same call run again. */
  readonly commandDigest?: string | null;
  readonly shape?: FailureShape | null;
}

/**
 * What the filter knows about one failure when it triggers: how many times this failure was seen in
 * the session and how it compares with the previous failure of the same family. Counts and flags only.
 */
export interface FailureObservation {
  /** Attempts of this failure in the session, this one included (1 for the first). */
  readonly attempts: number;
  /** The signature equals the previous one's. Without signatures the family stands in, so it is true. */
  readonly sameSignature: boolean;
  /** The failed call's input digest equals the previous one's; null when either is unknown. */
  readonly sameCommand: boolean | null;
  /** Write-tool completions since the previous failure of the family. */
  readonly editsSince: number;
  /** Milliseconds since the previous failure of the family; null for the first or when a time is unreadable. */
  readonly gapMs: number | null;
  /**
   * The signature differs but the same call ran again with nothing edited between: the rules cannot
   * say whether this is the same failure, so it counts as a possible repeat and Jev may be asked.
   */
  readonly unsure: boolean;
  /** The previous failure of the family, when there was one. */
  readonly previous: FailureShape | null;
}

export type TriggerResult =
  | { readonly trigger: TriggerKind; readonly coalesceKey: string; readonly reasonCode: 'TRIGGERED'; readonly failure?: FailureObservation }
  | { readonly trigger: null; readonly reasonCode: 'NO_TRIGGER' | 'COALESCED' | 'READ_ONLY' | 'NOT_A_DECISION_POINT' | 'BELOW_THRESHOLD' };

export interface TriggerOptions {
  /** Unchanged failures of one family before a repeat triggers. */
  readonly repeatThreshold?: number;
  /** Write-tool completions that make a diff boundary. */
  readonly writesPerBoundary?: number;
  /** Changed lines that make a diff boundary on their own. */
  readonly diffLinesPerBoundary?: number;
  readonly maxTracked?: number;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoRead', 'read', 'glob', 'grep', 'list', 'view']);
/** Write tools across the five harnesses (Claude, Codex, Kilo and OpenCode, Antigravity). */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'apply_patch',
  'edit', 'write', 'patch', 'multiedit',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content',
]);
const WRITE_TOOLS = WRITE_TOOL_NAMES;
const WORKER_TOOLS = new Set(['Agent', 'Task', 'spawn_agent', 'task']);
const RETRIEVAL_TOOLS = new Set(['Skill', 'skill', 'ToolSearch']);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The failure family: an explicit family from the adapter summary, else the tool name and its
 * exit-status class. Never raw output.
 */
export function failureFamily(envelope: Pick<EventEnvelope, 'payload'>): string {
  const payload = record(envelope.payload);
  const summary = record(payload['summary']);
  const explicit = str(summary['failureFamily']);
  if (explicit !== null) return explicit.slice(0, 64);
  const tool = str(payload['toolName']) ?? 'unknown-tool';
  const exit = num(summary['exitCode']);
  const klass = exit === null ? 'error' : exit === 0 ? 'ok' : exit >= 128 ? 'signal' : 'nonzero';
  return `${tool}:${klass}`;
}

interface FamilyState {
  count: number;
  fingerprint: string;
  command: string | null;
  shape: FailureShape | null;
  atMs: number | null;
  /** The session's write count (never reset) when this family last failed. */
  editsAt: number;
  /** Which run of the same failure this is; a different failure in between starts a new one. */
  episode: number;
}

interface SessionState {
  families: Map<string, FamilyState>;
  writes: number;
  lines: number;
  /** Write-tool completions in the session, never reset: failures compare against it. */
  totalWrites: number;
}

export class TriggerFilter {
  readonly #sessions = new Map<string, SessionState>();
  readonly #coalesced = new Set<string>();
  readonly #repeat: number;
  readonly #writes: number;
  readonly #lines: number;
  readonly #max: number;

  constructor(options: TriggerOptions = {}) {
    this.#repeat = Math.max(2, options.repeatThreshold ?? 2);
    this.#writes = Math.max(1, options.writesPerBoundary ?? 5);
    this.#lines = Math.max(1, options.diffLinesPerBoundary ?? 80);
    this.#max = Math.max(64, options.maxTracked ?? 5000);
  }

  #session(key: string): SessionState {
    let state = this.#sessions.get(key);
    if (state === undefined) {
      state = { families: new Map(), writes: 0, lines: 0, totalWrites: 0 };
      this.#sessions.set(key, state);
      if (this.#sessions.size > this.#max) {
        const first = this.#sessions.keys().next();
        if (first.done !== true) this.#sessions.delete(first.value);
      }
    }
    return state;
  }

  #fire(trigger: TriggerKind, envelope: EventEnvelope, extra = '', failure?: FailureObservation): TriggerResult {
    const scope = envelope.taskId ?? envelope.sessionId;
    const key = sha256Hex(`${envelope.workspaceId}\n${scope}\n${envelope.expectedRevision}\n${trigger}\n${extra}`);
    if (this.#coalesced.has(key)) return { trigger: null, reasonCode: 'COALESCED' };
    this.#coalesced.add(key);
    if (this.#coalesced.size > this.#max) {
      const first = this.#coalesced.values().next();
      if (first.done !== true) this.#coalesced.delete(first.value);
    }
    return { trigger, coalesceKey: key, reasonCode: 'TRIGGERED', ...(failure === undefined ? {} : { failure }) };
  }

  /**
   * Classifies one domain event. Pure apart from the filter's own counters. `hints` are the
   * content-free features of a failed call (an adapter's `body.failure`); without them a failure is
   * told apart by its family alone, as before.
   */
  classify(envelope: EventEnvelope, hints: FailureHints = {}): TriggerResult {
    const payload = record(envelope.payload);
    const summary = record(payload['summary']);
    const tool = str(payload['toolName']);
    const session = this.#session(`${envelope.workspaceId}\n${envelope.sessionId}`);
    switch (envelope.kind) {
      case 'task.requested':
        return this.#fire('new-task', envelope);
      case 'model.change.requested':
        return this.#fire('model-change-request', envelope, str(payload['model']) ?? '');
      case 'worker.started':
        return this.#fire('worker-creation', envelope, str(record(envelope.provenance)['toolUseId']) ?? '');
      case 'context.compacting':
        return this.#fire('context-checkpoint', envelope);
      case 'tool.proposed': {
        if (tool !== null && WORKER_TOOLS.has(tool)) return this.#fire('worker-creation', envelope, str(record(envelope.provenance)['toolUseId']) ?? '');
        if (tool !== null && READ_TOOLS.has(tool)) return { trigger: null, reasonCode: 'READ_ONLY' };
        return { trigger: null, reasonCode: 'NOT_A_DECISION_POINT' };
      }
      case 'tool.failed': {
        const family = failureFamily(envelope);
        const signature = str(hints.signature);
        const fingerprint = str(summary['fingerprint']) ?? signature ?? family;
        const command = str(hints.commandDigest);
        const shape = hints.shape ?? null;
        const parsedAt = Date.parse(envelope.occurredAt);
        const atMs = Number.isFinite(parsedAt) ? parsedAt : null;
        const seen = session.families.get(family);
        if (seen === undefined) {
          session.families.set(family, { count: 1, fingerprint, command, shape, atMs, editsAt: session.totalWrites, episode: 1 });
          return this.#fire('new-failure-family', envelope, family, { attempts: 1, sameSignature: true, sameCommand: null, editsSince: 0, gapMs: null, unsure: false, previous: null });
        }
        const editsSince = Math.max(0, session.totalWrites - seen.editsAt);
        const sameCommand = command !== null && seen.command !== null ? command === seen.command : null;
        const gapMs = atMs !== null && seen.atMs !== null ? Math.max(0, atMs - seen.atMs) : null;
        const previous = seen.shape;
        const sameSignature = seen.fingerprint === fingerprint;
        // The same call, run again with nothing edited, whose error text differs: possibly the same
        // failure with a detail that moved (a timestamp, a port). Counted as a possible repeat.
        const unsure = !sameSignature && signature !== null && sameCommand === true && editsSince === 0;
        seen.fingerprint = fingerprint;
        seen.command = command;
        seen.shape = shape;
        seen.atMs = atMs;
        seen.editsAt = session.totalWrites;
        if (!sameSignature && !unsure) {
          seen.count = 1;
          seen.episode += 1;
          return { trigger: null, reasonCode: 'BELOW_THRESHOLD' };
        }
        seen.count += 1;
        if (seen.count % this.#repeat === 0) return this.#fire('repeated-failure', envelope, `${family}#${seen.episode}#${seen.count}#${fingerprint}`, { attempts: seen.count, sameSignature, sameCommand, editsSince, gapMs, unsure, previous });
        return { trigger: null, reasonCode: 'BELOW_THRESHOLD' };
      }
      case 'tool.finished': {
        if (tool !== null && READ_TOOLS.has(tool)) return { trigger: null, reasonCode: 'READ_ONLY' };
        if (tool !== null && RETRIEVAL_TOOLS.has(tool) && (num(summary['candidates']) ?? 0) > 1) return this.#fire('candidate-retrieval', envelope);
        if (tool !== null && WRITE_TOOLS.has(tool)) {
          session.writes += 1;
          session.totalWrites += 1;
          session.lines += Math.max(0, num(summary['changedLines']) ?? 0);
          if (session.writes >= this.#writes || session.lines >= this.#lines) {
            session.writes = 0;
            session.lines = 0;
            return this.#fire('diff-boundary', envelope);
          }
          return { trigger: null, reasonCode: 'BELOW_THRESHOLD' };
        }
        return { trigger: null, reasonCode: 'NOT_A_DECISION_POINT' };
      }
      default:
        return { trigger: null, reasonCode: 'NO_TRIGGER' };
    }
  }
}
