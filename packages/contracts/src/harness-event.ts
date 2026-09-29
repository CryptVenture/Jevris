/**
 * Harness adapter port (§15.1, §6.3, HKR-02): the shape every `@jevris/adapter-*` package
 * produces from a native hook or plugin event, and the outcome the hook launcher asks it to
 * render back into that harness's protocol.
 *
 * A NormalizedHarnessEvent is "EventEnvelope-like": it carries what the native event says.
 * The launcher adds what only the sidecar knows (event id, sequence, expected revision,
 * deadline) before it becomes an EventEnvelope. Unknown values are null, never defaulted.
 *
 * Adapters render only these outcomes. None of them is a permission decision: Jevris never
 * allows, denies or asks on a tool call (native permissions stay authoritative, §16.2).
 */
import { defineContract } from './contract.js';
import { HARNESS_MODEL_ID_PATTERN, SECRET_PATTERNS, type HarnessId } from './primitives.js';
import * as S from './schema.js';

/** The `--harness` names the hook launcher accepts, one per harness. */
export const LAUNCHER_NAMES = ['claude', 'kilo', 'codex', 'opencode', 'agy'] as const;
export type LauncherName = (typeof LAUNCHER_NAMES)[number];

export const LAUNCHER_HARNESS: Readonly<Record<LauncherName, HarnessId>> = {
  claude: 'claude',
  kilo: 'kilocode',
  codex: 'codex',
  opencode: 'opencode',
  agy: 'antigravity',
};

/** Bound on the normalized payload summary (UTF-8 bytes of its JSON). */
export const HARNESS_PAYLOAD_CAP = 4096;
/** Bound on the native input an adapter will look at (UTF-8 bytes of its JSON). */
export const HARNESS_INPUT_CAP = 131_072;
/** Bound on context text an adapter renders into a harness (characters). */
export const HARNESS_CONTEXT_CAP = 8000;

export type HarnessJson = null | boolean | number | string | readonly HarnessJson[] | { readonly [key: string]: HarnessJson };

export interface NormalizedHarnessEvent {
  readonly schemaVersion: '1.0';
  readonly harness: HarnessId;
  /** The native event or hook name, exactly as the harness named it. */
  readonly nativeEventName: string;
  /** Dotted domain kind (§6.3), for example `tool.proposed` or `context.compacting`. */
  readonly kind: string;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  /** The subagent's id on a subagent's event (see `parentSessionId`); otherwise what the harness names, or null. */
  readonly agentId: string | null;
  /**
   * Present only on a subagent's event: the parent session, repeated from `sessionId`. Every
   * adapter reports a subagent the same way: `sessionId` is the parent session, `agentId` names
   * the subagent, and session-level kinds become worker kinds (`worker.started`,
   * `worker.prompted`, `worker.finished`, `worker.ended`), so a subagent's prompt, stop or end is
   * never read as the parent's.
   */
  readonly parentSessionId?: string;
  /** The model the harness reports as active. */
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly cwd: string | null;
  /** Session source, compaction trigger or stop reason, when the harness gives one. */
  readonly trigger: string | null;
  /** True when the harness waits for this hook before it continues. */
  readonly blocking: boolean;
  /** True when the harness requires a JSON body on a zero exit (for example Codex Stop). */
  readonly responseRequired: boolean;
  /** Bounded summary: never raw prompt text, tool output or file content. */
  readonly payload: { readonly [key: string]: HarnessJson };
  /** sha256 hex over the identifying fields, for duplicate-delivery detection. */
  readonly dedupKey: string;
}

export const NORMALIZE_REFUSALS = [
  'NOT_OBJECT',
  'OVER_CAP',
  'UNSAFE_KEY',
  'UNKNOWN_EVENT',
  'FOREIGN_PROTOCOL',
  'MISSING_FIELD',
] as const;
export type NormalizeRefusal = (typeof NORMALIZE_REFUSALS)[number];

/** Bound on `task.objective` (characters), as C's trigger handlers clip it. */
export const HARNESS_OBJECTIVE_CAP = 4000;

/** INT-01..03: the user's request text, verbatim and clipped. Only the event body carries it. */
export interface HarnessTaskIntent {
  readonly objective: string;
}

/**
 * INT-05: the paths this tool call wrote (relative to the session cwd when inside it). The
 * approved scope is not the harness's to say: the sidecar adds it from the task's plan.
 */
export interface HarnessScopeIntent {
  readonly diff: readonly { readonly path: string }[];
  readonly requestedEffects: readonly string[];
}

/** INT-04: what the failure left behind. Diagnostic text is the error's first line, clipped. */
export interface HarnessEvidenceIntent {
  readonly required: readonly {
    readonly id: string;
    readonly description: string;
    readonly available: boolean;
    readonly fresh: boolean | null;
  }[];
  readonly diagnostics?: readonly { readonly id: string; readonly text: string }[];
}

/**
 * Structured decision inputs the launcher sends next to the envelope (`body.task`,
 * `body.scope`, `body.evidence`), never inside `envelope.payload`. A harness that does not
 * provide a field leaves it out (see the parity matrix).
 */
/**
 * GOV-12 (C51): text a tool brought in from outside the conversation (a file it read, a fetched
 * page, a log, a skill description), clipped by the adapter: at most 4 spans of 8 KiB and 32 KiB
 * in all. The sidecar reads it for injection signals in memory only and records none of it.
 */
export interface HarnessUntrustedIntent {
  readonly spans: readonly {
    readonly id: string;
    readonly sourceKind: 'file' | 'log' | 'dependency-metadata' | 'fetched-doc' | 'skill-description' | 'tool-output' | 'issue';
    readonly text: string;
  }[];
}

/**
 * GOV-13 (C49): the effect a tool call proposes, for permission-risk triage (advice only; the
 * harness's permission prompt decides). Command at most 1 KiB; at most 32 paths and 32 hosts.
 */
export interface HarnessEffectIntent {
  readonly tool: string;
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly hosts?: readonly string[];
}

export interface HarnessIntent {
  readonly task?: HarnessTaskIntent;
  readonly scope?: HarnessScopeIntent;
  readonly evidence?: HarnessEvidenceIntent;
  /** On a finished or failed tool call (GOV-12). */
  readonly untrusted?: HarnessUntrustedIntent;
  /** On a proposed tool call (GOV-13). */
  readonly effect?: HarnessEffectIntent;
}

export type NormalizeResult =
  | { readonly ok: true; readonly event: NormalizedHarnessEvent; readonly intent?: HarnessIntent }
  | { readonly ok: false; readonly reasonCode: NormalizeRefusal; readonly nativeEventName: string | null };

export interface NormalizeContext {
  /** Only a Kilo or OpenCode shim knows which hook key delivered the input. */
  readonly hookKey?: string;
  /**
   * The session transcript's size in bytes when the hook ran (the launcher stats the native
   * `transcript_path`; it never reads it). It is the delivery's position in the session: a
   * second compaction, stop or identical prompt later in the same session gets its own dedup
   * key, while a redelivery of the same hook (same position) still dedups.
   */
  readonly transcriptBytes?: number | null;
}

/** The longest model id a route may carry on the wire. */
export const ROUTE_MODEL_MAX_LENGTH = 128;

/** A route's variant: a Kilo or OpenCode `--variant` name or a Codex effort level (routing design R20). */
export const ROUTE_VARIANT_PATTERN = '^[a-z][a-z0-9-]{0,31}$';

/**
 * What a sidecar subscriber proposes and the launcher renders. `observe` is the default and
 * renders the harness's "no decision" form. `context` adds model-visible context where the
 * event supports it. `route` names the model a subagent should run on (Claude Code: PreToolUse
 * on Agent or Task; Codex: PreToolUse on spawn_agent, which the Codex adapter renders as allow
 * plus updatedInput, owner decision OD-6; certified only): a registry id, or a harness's own `provider/model` spelling
 * for Kilo or OpenCode (routing design R20), with an optional variant (a Kilo or OpenCode
 * variant, or a Codex effort level). The route carries only the model and variant: the
 * launcher, which holds the native event, builds the rewritten tool input, so no prompt or
 * tool-input value crosses the sidecar boundary. An adapter that cannot name the model renders
 * no route. `explain` shows a message without changing anything.
 */
export const HookOutcomeSchema = S.discriminatedUnion('kind', [
  S.object({ kind: S.literal('observe') }),
  S.object({ kind: S.literal('context'), text: S.string({ minLength: 1, maxLength: 65_536 }) }),
  S.object(
    {
      kind: S.literal('route'),
      model: S.string({ minLength: 1, maxLength: ROUTE_MODEL_MAX_LENGTH, pattern: HARNESS_MODEL_ID_PATTERN, notPatterns: SECRET_PATTERNS }),
    },
    { variant: S.nullable(S.string({ minLength: 1, maxLength: 32, pattern: ROUTE_VARIANT_PATTERN })) },
  ),
  S.object({ kind: S.literal('explain'), text: S.string({ minLength: 1, maxLength: 65_536 }) }),
]);
export type HookOutcome = S.Static<typeof HookOutcomeSchema>;

export const HookOutcomeContract = defineContract<HookOutcome>({
  name: 'HookOutcome',
  description:
    'What a sidecar subscriber proposes for one hook event: observe, context, explain, or a route naming a model (a registry id or a harness provider/model id) and an optional variant. The wire value is never a permission decision and never a rewritten tool input; the Codex adapter renders a certified route as allow plus the call\'s own input with the model.',
  schema: HookOutcomeSchema,
});

/**
 * Launcher-local, never on the sidecar wire: a route whose native tool input has already been
 * rewritten from a wire route's `model`. Only an adapter renders it.
 */
export interface RenderedRoute {
  readonly kind: 'route';
  readonly updatedInput: { readonly [key: string]: HarnessJson };
}

/** A conformance fixture: a native input and what its adapter must produce. */
export interface AdapterFixture {
  readonly id: string;
  readonly native: unknown;
  readonly hookKey?: string;
  /** Expected domain kind, or null when the adapter must refuse the input. */
  readonly kind: string | null;
  readonly refusal?: NormalizeRefusal;
}

/** A check a verification run is producing now (RUNNING) or will produce next (QUEUED). */
export type PendingCheckState = 'RUNNING' | 'QUEUED';

/**
 * VER-05, US23: the words for checks a background verification run is still producing, built
 * from check ids and states only. The stop decision (the orchestrator's decideStop) and each
 * harness's Stop block reason both use it, so the two say it the same way. Empty when nothing
 * is pending.
 */
export function stillRunningText(pending: readonly (readonly [checkId: string, state: PendingCheckState])[]): string {
  if (pending.length === 0) return '';
  return `Still running in the background: ${pending.map(([id, state]) => `${id} (${state === 'QUEUED' ? 'queued' : 'running'})`).join(', ')}; each receipt is recorded when its run ends.`;
}
