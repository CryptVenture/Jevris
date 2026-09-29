import * as claude from '@jevris/adapter-claude-code';
import * as codex from '@jevris/adapter-codex';
import * as kilo from '@jevris/adapter-kilocode';
import * as opencode from '@jevris/adapter-opencode';
import * as agy from '@jevris/adapter-antigravity';
import {
  CONFORMANCE_CASES,
  contentHash,
  sha256Hex,
  type AdapterFixture,
  type HookOutcome,
  type NormalizeResult,
  type NormalizedHarnessEvent,
} from '@jevris/contracts';
import { join } from 'node:path';
import type { GlobalHarness } from './global-harness.js';
import { childEnv, runNode, validHookOutput } from './install-smoke.js';

/**
 * The §15.4 conformance cases (HCF-01) run by `jevris certify` against the INSTALLED runtime:
 * the adapter the runtime ships, in process, plus the installed hook launcher as a child
 * process with the recorded fixtures on stdin. The test suite runs the same cases against
 * the source tree (packages/adapter-codex/test/conformance.test.mjs); this runner produces
 * the release evidence for one harness on this machine.
 */

export type ConformanceCaseId = (typeof CONFORMANCE_CASES)[number];

export interface ConformanceCase {
  readonly id: ConformanceCaseId;
  readonly passed: boolean;
  readonly reasonCode: string | null;
}

interface AdapterPort {
  readonly HARNESS_ID: string;
  readonly LAUNCHER_NAME: string;
  readonly FIXTURES: readonly AdapterFixture[];
  normalize(native: unknown, context?: { readonly hookKey?: string }): NormalizeResult;
  /** `native` is the fixture's hook input, which a `route` outcome is built from (E 7a6f7a5). */
  protocolResponse(event: NormalizedHarnessEvent | null, outcome: HookOutcome, native?: unknown): string;
  stopContinuationResponse?(event: NormalizedHarnessEvent | null, missingEvidence: readonly unknown[]): string;
  /** Kilo and OpenCode: the shim's own check of a route.turn answer (OD-8); the switch it writes, or null. */
  turnPayloadRoute?(harness: string, payload: unknown): { readonly providerID: string; readonly modelID: string; readonly variant: string | null } | null;
}

/**
 * Harnesses whose Stop hook documents an output that continues the turn (VER-05), with that
 * decision value and how a native Stop says it follows an earlier continue. Antigravity (G6,
 * owner decision DOMAINS 9d6a66d) has no stop_hook_active: a later execution attempt is one.
 */
const STOP_CONTINUE: Readonly<Partial<Record<GlobalHarness, { readonly decision: string; readonly continued: (active: boolean) => Record<string, unknown> }>>> = {
  claude: { decision: 'block', continued: (active) => ({ stop_hook_active: active }) },
  codex: { decision: 'block', continued: (active) => ({ stop_hook_active: active }) },
  antigravity: { decision: 'continue', continued: (active) => ({ executionNum: active ? 2 : 1 }) },
};
const STOP_BLOCK_HARNESSES: ReadonlySet<GlobalHarness> = new Set(Object.keys(STOP_CONTINUE) as GlobalHarness[]);

/**
 * VER-05 shape: for a first Stop, exactly `{decision, reason}` with the harness's continue
 * decision, whose reason names only the given evidence ids; for every other event, and for a
 * continued stop, nothing. Null when it holds.
 */
function stopContinuationShape(port: AdapterPort, all: ReadonlyArray<{ fixture: AdapterFixture; event: NormalizedHarnessEvent }>, harness: GlobalHarness): string | null {
  const shape = STOP_CONTINUE[harness];
  if (shape === undefined) return 'NO_STOP_CONTINUATION';
  const respond = port.stopContinuationResponse;
  if (respond === undefined) return 'NO_STOP_CONTINUATION';
  let stops = 0;
  for (const { fixture, event } of all) {
    if (event.nativeEventName !== 'Stop') {
      if (respond(event, ['unit']) !== '') return 'CONTINUATION_OUTSIDE_STOP';
      continue;
    }
    for (const active of [false, true]) {
      const native = { ...(fixture.native as Record<string, unknown>), ...shape.continued(active) };
      const result = normalizeFixture(port, { ...fixture, native });
      if (!result.ok) return 'STOP_VARIANT_REFUSED';
      const text = respond(result.event, ['unit', 'bad id!', 'lint']);
      if (active) {
        if (text !== '') return 'CONTINUED_WHILE_STOP_HOOK_ACTIVE';
        continue;
      }
      stops += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return 'STOP_BLOCK_NOT_JSON';
      }
      const doc = parsed as { decision?: unknown; reason?: unknown };
      if (Object.keys(doc).sort().join(',') !== 'decision,reason' || doc.decision !== shape.decision || typeof doc.reason !== 'string') return 'STOP_BLOCK_SHAPE';
      if (!doc.reason.includes('unit, lint') || doc.reason.includes('bad id')) return 'STOP_BLOCK_REASON';
      if (respond(result.event, []) !== '') return 'CONTINUED_WITHOUT_EVIDENCE';
    }
  }
  return stops > 0 ? null : 'NO_STOP_FIXTURE';
}

export const ADAPTER_PORTS: Readonly<Record<GlobalHarness, AdapterPort>> = {
  claude: claude as unknown as AdapterPort,
  codex: codex as unknown as AdapterPort,
  kilocode: kilo as unknown as AdapterPort,
  opencode: opencode as unknown as AdapterPort,
  antigravity: agy as unknown as AdapterPort,
};

/** The route names a registry model id on the wire; the adapter renders it as Claude Code's alias. */
export const CONFORMANCE_ROUTE_MODEL = 'claude-haiku-4-5';
/**
 * The route each harness is sent. Kilo and OpenCode name a model `provider/model` (C's spelling,
 * split on the first slash); the Kilo route also carries a variant, which Kilo's task tool takes.
 */
export function conformanceRoute(harness: GlobalHarness): HookOutcome {
  if (harness === 'kilocode') return { kind: 'route', model: `anthropic/${CONFORMANCE_ROUTE_MODEL}`, variant: 'low' };
  if (harness === 'opencode') return { kind: 'route', model: `anthropic/${CONFORMANCE_ROUTE_MODEL}` };
  return { kind: 'route', model: CONFORMANCE_ROUTE_MODEL };
}
const CONTEXT: HookOutcome = { kind: 'context', text: 'Jevris capsule: resume at step 3.' };
function outcomesFor(harness: GlobalHarness): readonly HookOutcome[] {
  return [{ kind: 'observe' }, CONTEXT, { kind: 'explain', text: 'Jevris: this switch is outside the calibrated range.' }, conformanceRoute(harness)];
}
const FORBIDDEN = /permissionDecision|"decision"\s*:\s*"(?:allow|deny|ask|block|approve)"|"continue"\s*:\s*false|"behavior"\s*:/;

/**
 * The fixture on which each routing adapter renders a route, and its pinned twin that must stay
 * unrouted. Claude Code: Agent's `updatedInput` (K1). Codex: spawn_agent's `allow` plus
 * `updatedInput` (OD-6, K2). Kilo and OpenCode: the shim's `{"route":...}` on the task tool's
 * tool.execute.before (R20, K3 and K4); a task call that names a model is the pin. `also` names
 * fixtures that route exactly as `routed` does: Codex's spawn_agent under its default MultiAgentV2
 * namespace name, `collaborationspawn_agent` (owner decision DOMAINS 0a9dc8c).
 */
const ROUTE_FIXTURES: Readonly<Partial<Record<GlobalHarness, { readonly routed: string; readonly pinned: string; readonly also?: readonly string[] }>>> = {
  claude: { routed: 'claude.pre-agent', pinned: 'claude.pre-agent-pinned' },
  codex: { routed: 'codex.pre-spawn-agent', pinned: 'codex.pre-spawn-agent-pinned', also: ['codex.pre-spawn-agent-namespaced'] },
  kilocode: { routed: 'kilocode.task-before', pinned: 'kilocode.task-before-pinned' },
  opencode: { routed: 'opencode.task-before', pinned: 'opencode.task-before-pinned' },
};

/** Whether a fixture is one on which the harness renders a route (ROUTE_FIXTURES `routed` or `also`). */
function routedFixture(harness: GlobalHarness, id: string): boolean {
  const routes = ROUTE_FIXTURES[harness];
  return routes !== undefined && (id === routes.routed || (routes.also ?? []).includes(id));
}

/**
 * OD-6's one permitted decision: Codex's routed spawn_agent (tool_name exactly `spawn_agent`, or
 * `collaborationspawn_agent`, its default-namespace name (owner decision 0a9dc8c); no
 * `model` or `reasoning_effort` in its input), exactly `allow` with the fixture's own tool input,
 * key for key, plus `model`, and nothing else. Any other permission decision fails the case.
 */
export function od6RouteShape(harness: GlobalHarness, native: unknown, text: string): boolean {
  if (harness !== 'codex' || !isObject(native) || !codex.isSpawnHookName(native['tool_name']) || !isObject(native['tool_input'])) return false;
  // A spawn that names its model or effort is a pin: no decision may be rendered for it at all.
  if (Object.hasOwn(native['tool_input'], 'model') || Object.hasOwn(native['tool_input'], 'reasoning_effort')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObject(parsed) || Object.keys(parsed).join() !== 'hookSpecificOutput') return false;
  const out = parsed['hookSpecificOutput'];
  if (!isObject(out) || Object.keys(out).sort().join() !== 'hookEventName,permissionDecision,updatedInput') return false;
  if (out['hookEventName'] !== 'PreToolUse' || out['permissionDecision'] !== 'allow' || !isObject(out['updatedInput'])) return false;
  const { model, ...rest } = out['updatedInput'];
  return typeof model === 'string' && model.length > 0 && JSON.stringify(rest) === JSON.stringify(native['tool_input']);
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const INVENTED = ['eventId', 'sequence', 'expectedRevision', 'deadlineAt', 'occurredAt'];

/** sha256 over the canonical JSON of the harness's recorded fixtures. */
export function fixtureSuiteHash(harness: GlobalHarness): string {
  try {
    return contentHash(ADAPTER_PORTS[harness].FIXTURES);
  } catch {
    return `sha256:${sha256Hex(JSON.stringify(ADAPTER_PORTS[harness].FIXTURES))}`;
  }
}

function normalizeFixture(port: AdapterPort, fixture: AdapterFixture): NormalizeResult {
  return port.normalize(fixture.native, fixture.hookKey === undefined ? {} : { hookKey: fixture.hookKey });
}

function events(port: AdapterPort): Array<{ fixture: AdapterFixture; event: NormalizedHarnessEvent }> {
  const out: Array<{ fixture: AdapterFixture; event: NormalizedHarnessEvent }> = [];
  for (const fixture of port.FIXTURES) {
    if (fixture.kind === null) continue;
    const result = normalizeFixture(port, fixture);
    if (result.ok) out.push({ fixture, event: result.event });
  }
  return out;
}

function oneObjectOrEmpty(text: string): boolean {
  if (text.length === 0) return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function check(id: ConformanceCaseId, failure: string | null): ConformanceCase {
  return { id, passed: failure === null, reasonCode: failure };
}

function safely(fn: () => string | null): string | null {
  try {
    return fn();
  } catch {
    return 'THREW';
  }
}

/** The in-process cases for one adapter. A failure carries an upper-case reason code. */
export function adapterCases(harness: GlobalHarness): Map<ConformanceCaseId, string | null> {
  const port = ADAPTER_PORTS[harness];
  const all = events(port);
  const ROUTE = conformanceRoute(harness);
  const OUTCOMES = outcomesFor(harness);
  const out = new Map<ConformanceCaseId, string | null>();
  out.set(
    'event-validation',
    safely(() => {
      for (const fixture of port.FIXTURES) {
        const result = normalizeFixture(port, fixture);
        if (fixture.kind === null) {
          if (result.ok || (fixture.refusal !== undefined && result.reasonCode !== fixture.refusal)) return 'FIXTURE_NOT_REFUSED';
        } else if (!result.ok || result.event.kind !== fixture.kind || result.event.harness !== port.HARNESS_ID) {
          return 'FIXTURE_KIND_MISMATCH';
        }
      }
      if (all.length === 0) return 'NO_FIXTURES';
      const big = { hook_event_name: 'x', pad: 'a'.repeat(140_000) };
      const polluted = JSON.parse('{"__proto__":{"x":1},"hook_event_name":"SessionStart"}') as unknown;
      if (port.normalize(big).ok || port.normalize(polluted).ok) return 'UNSAFE_INPUT_ACCEPTED';
      for (const value of [null, 'Stop', 3, [], undefined]) if (port.normalize(value).ok) return 'NON_OBJECT_ACCEPTED';
      return null;
    }),
  );
  out.set(
    'duplicate-delivery',
    safely(() => {
      for (const { fixture, event } of all) {
        const again = normalizeFixture(port, fixture);
        if (!again.ok || again.event.dedupKey !== event.dedupKey) return 'DEDUP_KEY_UNSTABLE';
        if (!/^[0-9a-f]{64}$/.test(event.dedupKey)) return 'DEDUP_KEY_SHAPE';
      }
      const keys = new Set(all.map(({ event }) => event.dedupKey));
      return keys.size === all.length ? null : 'DEDUP_KEY_COLLISION';
    }),
  );
  out.set(
    'stale-revision',
    safely(() => (all.some(({ event }) => INVENTED.some((key) => key in event)) ? 'INVENTED_ORDERING' : null)),
  );
  out.set(
    'output-shape',
    safely(() => {
      if (!oneObjectOrEmpty(port.protocolResponse(null, { kind: 'observe' }))) return 'NULL_EVENT_SHAPE';
      for (const { fixture, event } of all) for (const outcome of OUTCOMES) if (!oneObjectOrEmpty(port.protocolResponse(event, outcome, fixture.native))) return 'OUTPUT_NOT_ONE_OBJECT';
      return STOP_BLOCK_HARNESSES.has(harness) ? stopContinuationShape(port, all, harness) : null;
    }),
  );
  out.set(
    'permission-preservation',
    safely(() => {
      for (const { fixture, event } of all) {
        for (const outcome of OUTCOMES) {
          const text = port.protocolResponse(event, outcome, fixture.native);
          if (FORBIDDEN.test(text) && !(outcome.kind === 'route' && od6RouteShape(harness, fixture.native, text))) return 'PERMISSION_DECISION_RENDERED';
        }
      }
      return null;
    }),
  );
  out.set(
    'user-pin',
    safely(() => {
      const routes = ROUTE_FIXTURES[harness];
      for (const { fixture, event } of all) {
        const observed = port.protocolResponse(event, { kind: 'observe' });
        const routed = port.protocolResponse(event, ROUTE, fixture.native);
        if (routes === undefined && routed !== observed) return 'ROUTE_RENDERED';
        if (harness === 'claude' && event.model !== null && routed !== observed) return 'PIN_OVERRIDDEN';
        if (harness !== 'claude' && !routedFixture(harness, fixture.id) && routed !== observed) return 'ROUTE_RENDERED';
      }
      if (routes !== undefined) {
        const pinned = all.find(({ fixture }) => fixture.id === routes.pinned);
        if (pinned === undefined) return 'NO_PINNED_FIXTURE';
        if (port.protocolResponse(pinned.event, ROUTE, pinned.fixture.native) !== port.protocolResponse(pinned.event, { kind: 'observe' })) return 'PIN_OVERRIDDEN';
      }
      return null;
    }),
  );
  out.set(
    'unsupported-capability',
    safely(() => {
      for (const { fixture, event } of all) {
        const observed = port.protocolResponse(event, { kind: 'observe' });
        const routes = ROUTE_FIXTURES[harness];
        if (routes !== undefined && (routedFixture(harness, fixture.id) || fixture.id === routes.pinned)) continue;
        if (port.protocolResponse(event, ROUTE, fixture.native) !== observed) return 'UNSUPPORTED_ROUTE_RENDERED';
      }
      // A harness whose Stop cannot block never offers a stop continuation (VER-05).
      if (!STOP_BLOCK_HARNESSES.has(harness) && port.stopContinuationResponse !== undefined) return 'UNSUPPORTED_STOP_CONTINUATION';
      return null;
    }),
  );
  return out;
}

export interface LauncherRunInput {
  readonly harness: GlobalHarness;
  readonly node: string;
  readonly hook: string;
  /** A temp profile with no running sidecar. */
  readonly home: string;
  readonly timeoutMs?: number;
}

const HOOK_EVENT: Partial<Record<GlobalHarness, (fixture: AdapterFixture) => readonly string[]>> = {
  antigravity: (fixture) => (fixture.hookKey === undefined ? [] : ['--event', fixture.hookKey]),
};

/**
 * Runs every recorded fixture through the installed launcher with no sidecar available:
 * the launcher must exit 0 within its deadline with empty output or one JSON object and no
 * permission decision. Covers offline fallback, cancellation (the deadline) and the
 * process-level output shape and permission checks.
 */
export async function launcherCases(input: LauncherRunInput): Promise<Map<ConformanceCaseId, string | null>> {
  const port = ADAPTER_PORTS[input.harness];
  const timeoutMs = input.timeoutMs ?? 10000;
  const out = new Map<ConformanceCaseId, string | null>();
  // No observe-only switch: the launcher takes its real path and finds no sidecar. The entry
  // override points at a file that does not exist, so no daemon is left behind.
  const env = childEnv(input.home, { JEVRIS_HOOK_OBSERVE_ONLY: undefined, JEVRIS_SIDECAR_ENTRY: join(input.home, '.jevris-certify-no-sidecar.mjs'), JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_HOOK_DEADLINE_MS: '800' });
  let offline: string | null = null;
  let shape: string | null = null;
  let permission: string | null = null;
  let cancellation: string | null = null;
  const fixtures = port.FIXTURES.slice(0, 32);
  for (const fixture of fixtures) {
    const extra = HOOK_EVENT[input.harness]?.(fixture) ?? [];
    const started = Date.now();
    const ran = await runNode(input.node, [input.hook, '--harness', port.LAUNCHER_NAME, ...extra], JSON.stringify(fixture.native ?? null), env, timeoutMs);
    const took = Date.now() - started;
    if (ran.error !== null || ran.timedOut) cancellation ??= 'LAUNCHER_HUNG';
    else if (took > 5000) cancellation ??= 'LAUNCHER_OVER_DEADLINE';
    if (ran.code !== 0) offline ??= 'LAUNCHER_NONZERO_EXIT';
    if (!oneObjectOrEmpty(ran.stdout.trim())) shape ??= 'LAUNCHER_OUTPUT_NOT_ONE_OBJECT';
    if (!validHookOutput(ran.stdout) && FORBIDDEN.test(ran.stdout)) permission ??= 'LAUNCHER_PERMISSION_DECISION';
  }
  const garbage = await runNode(input.node, [input.hook, '--harness', port.LAUNCHER_NAME], '{not json', env, timeoutMs);
  if (garbage.code !== 0 || !oneObjectOrEmpty(garbage.stdout.trim())) offline ??= 'LAUNCHER_REJECTS_BADLY';
  out.set('offline-fallback', offline);
  out.set('cancellation', cancellation);
  out.set('output-shape', shape);
  out.set('permission-preservation', permission);
  return out;
}

/** Merges in-process and launcher results; a case passes only when every part passed. */
export function mergeCases(...parts: ReadonlyArray<Map<ConformanceCaseId, string | null>>): ConformanceCase[] {
  return CONFORMANCE_CASES.map((id) => {
    let failure: string | null = null;
    let seen = false;
    for (const part of parts) {
      if (!part.has(id)) continue;
      seen = true;
      failure ??= part.get(id) ?? null;
    }
    return check(id, seen ? failure : 'NOT_RUN');
  });
}

/** An actuating route.turn answer (E's RouteTurnPayloadContract) for the session capability. */
function turnSample(harness: GlobalHarness): Record<string, unknown> {
  return {
    harness,
    mainSession: { mode: 'plugin-bounded-auto', switched: true },
    outcome: 'switch',
    actuate: true,
    reasonCode: 'PROMOTED_SAVING',
    text: 'Jevris: this turn runs on a cheaper model.',
    model: { providerID: 'anthropic', modelID: CONFORMANCE_ROUTE_MODEL },
  };
}

/**
 * What the adapter can deliver at all: `context` when some recorded event renders a context
 * outcome differently from observation, `route` likewise for a routed input, and `session` when
 * the shim writes an actuating route.turn answer for a top-level turn (Kilo and OpenCode, OD-8).
 * A harness that cannot (Antigravity has no PreToolUse, AGY-03) leaves the feature out of its record.
 */
export function adapterCapabilities(harness: GlobalHarness): { readonly context: boolean; readonly route: boolean; readonly session: boolean } {
  const port = ADAPTER_PORTS[harness];
  let context = false;
  let route = false;
  let session = false;
  try {
    session = port.turnPayloadRoute?.(port.HARNESS_ID, turnSample(harness)) != null;
  } catch {
    session = false;
  }
  for (const { fixture, event } of events(port)) {
    const observed = port.protocolResponse(event, { kind: 'observe' });
    if (port.protocolResponse(event, CONTEXT) !== observed) context = true;
    if (fixture.id === ROUTE_FIXTURES[harness]?.routed) {
      if (port.protocolResponse(event, conformanceRoute(harness), fixture.native) !== observed) route = true;
    }
  }
  return { context, route, session };
}
