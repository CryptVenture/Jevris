/** Chapter 6.1 core domain contracts: Mode, Authority, Risk, Json, EvidenceRef, EventEnvelope, SessionSnapshot. */
import { defineContract, timestampMs } from './contract.js';
import type { Json } from './json.js';
import {
  Hash,
  HarnessIdSchema,
  Id,
  IdList,
  ModelId,
  NonNegativeInteger,
  SECRET_PATTERNS,
  Timestamp,
} from './primitives.js';
import * as S from './schema.js';

export const MODES = ['off', 'observe', 'advise', 'bounded-auto'] as const;
/**
 * Where the effective mode comes from: the defaults, the user's jevris.config.json, or the ceiling
 * that lowered it (the workspace's .jevris/config.json, organization.json, host.json or the
 * managed policy). Configure and status show it.
 */
export const MODE_SOURCES = ['defaults', 'user', 'workspace', 'organization', 'host', 'managed'] as const;
export type ModeSource = (typeof MODE_SOURCES)[number];
export const AUTHORITIES = ['observe', 'advise', 'actuate'] as const;
export const RISKS = ['routine', 'material', 'sensitive'] as const;

export const ModeSchema = S.enumOf(MODES);
export const AuthoritySchema = S.enumOf(AUTHORITIES);
export const RiskSchema = S.enumOf(RISKS);

export type Mode = S.Static<typeof ModeSchema>;
export type Authority = S.Static<typeof AuthoritySchema>;
export type Risk = S.Static<typeof RiskSchema>;

export const ModeContract = defineContract<Mode>({ name: 'Mode', description: 'Operating mode (§4.2).', schema: ModeSchema });

/**
 * What a mode lets Jevris do (§4.2, owner decision 0eb319de). Each mode adds one action to the one
 * below it:
 * - off: nothing. Hooks are a no-op, nothing is recorded and Jev is never asked.
 * - observe: record facts, and ask Jev for a counterfactual that is recorded but never shown.
 * - advise: also show advice (hook context, route advice, the Stop continuation).
 * - bounded-auto: also actuate on certified capabilities (model switches, owned workers).
 * mainSession, managedWorkers and orchestration may only narrow this. Every gate asks this one
 * function; nothing else reads the mode to decide.
 */
export const MODE_ACTIONS = ['record', 'counterfactual', 'show-advice', 'actuate'] as const;
export type ModeAction = (typeof MODE_ACTIONS)[number];
const MODE_RANK: Readonly<Record<Mode, number>> = { off: 0, observe: 1, advise: 2, 'bounded-auto': 3 };
const ACTION_RANK: Readonly<Record<ModeAction, number>> = { record: 1, counterfactual: 1, 'show-advice': 2, actuate: 3 };

export function modeAllows(mode: Mode, action: ModeAction): boolean {
  const rank = MODE_RANK[mode] as number | undefined;
  const needed = ACTION_RANK[action] as number | undefined;
  return rank !== undefined && needed !== undefined && rank >= needed;
}

/**
 * SSOT §4.2 "Off: no Jev calls, no optimization actuation, and no invisible background network
 * activity". The explicit asks that exist to consult Jev are refused in off with MODE_OFF (the CLI,
 * the MCP tools and the sidecar all ask this list); read-only commands keep working, and every other
 * op sees an engine that never calls Jev.
 */
export const MODE_OFF_REFUSED_OPS: readonly string[] = Object.freeze(['route', 'plan', 'recover', 'capability.advise', 'jev.reenable']);
export const MODE_OFF_REASON = 'MODE_OFF';

/** The refusal text for an op in MODE_OFF_REFUSED_OPS under off: what happened and the command that raises the mode. */
export function modeOffMessage(op: string): string {
  return `Jevris is off, so ${op} was not run: in off mode Jevris makes no Jev call. Run \`jevris configure set mode advise\` to turn advice back on.`;
}

/** The lower of two modes. */
export function lowerMode(a: Mode, b: Mode): Mode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}
export const AuthorityContract = defineContract<Authority>({
  name: 'Authority',
  description: 'Authority class of a capability (§3.1).',
  schema: AuthoritySchema,
});
export const RiskContract = defineContract<Risk>({ name: 'Risk', description: 'Risk class.', schema: RiskSchema });

export const JsonSchema = S.json<Json>('Any plain JSON value. undefined, non-finite numbers and prototype keys are refused.');
export const JsonContract = defineContract<Json>({ name: 'Json', description: 'A plain JSON value.', schema: JsonSchema });

export const EVIDENCE_SOURCE_KINDS = ['user', 'file', 'tool', 'policy', 'receipt'] as const;
export const EVIDENCE_TRUST = ['verified-policy', 'human-input', 'untrusted-content'] as const;

export const EvidenceRefSchema = S.object(
  {
    id: Id,
    workspaceId: Id,
    contentHash: Hash,
    sourceKind: S.enumOf(EVIDENCE_SOURCE_KINDS),
    trust: S.enumOf(EVIDENCE_TRUST),
    observedAt: Timestamp,
    revision: Id,
  },
  { span: S.object({ start: NonNegativeInteger, end: NonNegativeInteger }) },
);
export type EvidenceRef = S.Static<typeof EvidenceRefSchema>;

function refineSpan(value: EvidenceRef, issue: (path: string, code: string) => void, base = ''): void {
  if (value.span !== undefined && value.span.start > value.span.end) issue(`${base}/span`, 'SPAN_ORDER');
}

export const EvidenceRefContract = defineContract<EvidenceRef>({
  name: 'EvidenceRef',
  description: 'A hashed, workspace-scoped reference to one piece of evidence (§6.1).',
  schema: EvidenceRefSchema,
  refine: (value, issue) => refineSpan(value, issue),
});

/** Normalized domain event kinds (§6.3). The envelope accepts any dotted lower-case kind. */
export const DOMAIN_EVENT_KINDS = [
  'task.requested',
  'tool.proposed',
  'tool.finished',
  'tool.failed',
  'context.compacting',
  'context.compacted',
  'model.change.requested',
  'model.changed',
  'worker.started',
  'worker.finished',
  'verification.finished',
  'session.ended',
  // Access limits (R59): a harness turn or a worker that failed, carrying an AccessSignalWire.
  'turn.failed',
  'worker.failed',
] as const;
export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];

export const EVENT_KIND_PATTERN = '^[a-z][a-z0-9-]{0,31}(?:\\.[a-z][a-z0-9-]{0,31}){1,3}$';

export const EventProvenanceSchema = S.object(
  {
    harness: HarnessIdSchema,
    nativeEventName: S.string({ pattern: '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$', notPatterns: SECRET_PATTERNS }),
  },
  {
    transportEventId: Id,
    toolUseId: Id,
    dedupKey: Hash,
  },
  { description: 'Native origin. Transport event id, tool-use id and dedup key are distinct identifiers (§6.3).' },
);
export type EventProvenance = S.Static<typeof EventProvenanceSchema>;

export const EventEnvelopeSchema = S.object(
  {
    schemaVersion: S.literal('1.0'),
    eventId: Id,
    workspaceId: Id,
    sessionId: Id,
    sequence: NonNegativeInteger,
    occurredAt: Timestamp,
    kind: S.string({ pattern: EVENT_KIND_PATTERN }),
    expectedRevision: Id,
    deadlineAt: Timestamp,
    payload: JsonSchema,
    evidence: S.array(EvidenceRefSchema, { maxItems: 256 }),
  },
  {
    agentId: Id,
    taskId: Id,
    causationId: Id,
    provenance: EventProvenanceSchema,
  },
);
type EventEnvelopeStatic = S.Static<typeof EventEnvelopeSchema>;
export type EventEnvelope<T extends Json = Json> = Omit<EventEnvelopeStatic, 'payload'> & { readonly payload: T };

export const EventEnvelopeContract = defineContract<EventEnvelope>({
  name: 'EventEnvelope',
  description: 'A versioned, workspace-scoped domain event (§6.1, §6.3).',
  schema: EventEnvelopeSchema as S.TSchema<EventEnvelope>,
  refine: (value, issue) => {
    value.evidence.forEach((ref, index) => {
      if (ref.workspaceId !== value.workspaceId) issue(`/evidence/${index}/workspaceId`, 'WORKSPACE_SCOPE');
      refineSpan(ref, issue, `/evidence/${index}`);
    });
    if (timestampMs(value.deadlineAt) < timestampMs(value.occurredAt)) issue('/deadlineAt', 'DEADLINE_BEFORE_OCCURRED');
  },
});

export const SessionSnapshotSchema = S.object(
  {
    sessionId: Id,
    workspaceId: Id,
    revision: Id,
    mode: ModeSchema,
    requestedModelId: S.nullable(ModelId),
    actualModelId: S.nullable(ModelId),
    contextTokensEstimate: S.nullable(NonNegativeInteger),
    activeTaskIds: IdList(),
    observedAt: Timestamp,
  },
  {},
  { description: 'Unknown values are null, never 0 or an empty string (§6.2).' },
);
export type SessionSnapshot = S.Static<typeof SessionSnapshotSchema>;

export const SessionSnapshotContract = defineContract<SessionSnapshot>({
  name: 'SessionSnapshot',
  description: 'What an adapter observed about one session. Unknown stays unknown (§6.2).',
  schema: SessionSnapshotSchema,
});

export interface SessionObservation {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly revision: string;
  readonly mode: Mode;
  readonly observedAt: string;
  readonly requestedModelId?: string | null | undefined;
  readonly actualModelId?: string | null | undefined;
  readonly contextTokensEstimate?: number | null | undefined;
  readonly activeTaskIds?: readonly string[] | undefined;
}

/**
 * Builds a validated snapshot from a partial observation. Anything the adapter did not observe
 * becomes null. It is never defaulted to 0 or to an empty model id.
 */
export function snapshotFromObservation(observation: SessionObservation): SessionSnapshot {
  return SessionSnapshotContract.assert({
    sessionId: observation.sessionId,
    workspaceId: observation.workspaceId,
    revision: observation.revision,
    mode: observation.mode,
    requestedModelId: observation.requestedModelId ?? null,
    actualModelId: observation.actualModelId ?? null,
    contextTokensEstimate: observation.contextTokensEstimate ?? null,
    activeTaskIds: [...(observation.activeTaskIds ?? [])],
    observedAt: observation.observedAt,
  });
}
