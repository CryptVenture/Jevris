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

export type TriggerResult =
  | { readonly trigger: TriggerKind; readonly coalesceKey: string; readonly reasonCode: 'TRIGGERED' }
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

interface SessionState {
  families: Map<string, { count: number; fingerprint: string }>;
  writes: number;
  lines: number;
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
      state = { families: new Map(), writes: 0, lines: 0 };
      this.#sessions.set(key, state);
      if (this.#sessions.size > this.#max) {
        const first = this.#sessions.keys().next();
        if (first.done !== true) this.#sessions.delete(first.value);
      }
    }
    return state;
  }

  #fire(trigger: TriggerKind, envelope: EventEnvelope, extra = ''): TriggerResult {
    const scope = envelope.taskId ?? envelope.sessionId;
    const key = sha256Hex(`${envelope.workspaceId}\n${scope}\n${envelope.expectedRevision}\n${trigger}\n${extra}`);
    if (this.#coalesced.has(key)) return { trigger: null, reasonCode: 'COALESCED' };
    this.#coalesced.add(key);
    if (this.#coalesced.size > this.#max) {
      const first = this.#coalesced.values().next();
      if (first.done !== true) this.#coalesced.delete(first.value);
    }
    return { trigger, coalesceKey: key, reasonCode: 'TRIGGERED' };
  }

  /** Classifies one domain event. Pure apart from the filter's own counters. */
  classify(envelope: EventEnvelope): TriggerResult {
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
        const fingerprint = str(summary['fingerprint']) ?? family;
        const seen = session.families.get(family);
        if (seen === undefined) {
          session.families.set(family, { count: 1, fingerprint });
          return this.#fire('new-failure-family', envelope, family);
        }
        if (seen.fingerprint !== fingerprint) {
          seen.fingerprint = fingerprint;
          seen.count = 1;
          return { trigger: null, reasonCode: 'BELOW_THRESHOLD' };
        }
        seen.count += 1;
        if (seen.count % this.#repeat === 0) return this.#fire('repeated-failure', envelope, `${family}#${seen.count}`);
        return { trigger: null, reasonCode: 'BELOW_THRESHOLD' };
      }
      case 'tool.finished': {
        if (tool !== null && READ_TOOLS.has(tool)) return { trigger: null, reasonCode: 'READ_ONLY' };
        if (tool !== null && RETRIEVAL_TOOLS.has(tool) && (num(summary['candidates']) ?? 0) > 1) return this.#fire('candidate-retrieval', envelope);
        if (tool !== null && WRITE_TOOLS.has(tool)) {
          session.writes += 1;
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
