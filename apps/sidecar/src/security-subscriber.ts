/**
 * GOV-12 (C51) and GOV-13 (C49) on the hook path: the built-in `security` event subscriber.
 *
 * - After a tool ran (`tool.finished` or `tool.failed`), the launcher may send `body.untrusted`: bounded spans
 *   of the tool's output (a file it read, a fetched page, a log, a skill description). The
 *   rules look for text written to steer an agent. The spans are held in memory for this call
 *   only; nothing is recorded, and only signal families could ever reach Jev.
 * - Before a tool runs (`tool.proposed`), the launcher may send `body.effect`: the tool, its
 *   command, the paths it touches and the hosts it contacts. The rules triage it to none,
 *   caution or review, raised to review when a flagged span came earlier in the session.
 *
 * Either answer is an `explain` hook outcome: a message the person reads. It is never a
 * permission decision; nothing here grants or denies anything, and the harness's own
 * permission prompt and the host policy stay authoritative. The text comes from the rules
 * alone, so what the hook prints is the same whether Jev would flag the text or not (W06).
 * When a decision engine is configured, Jev is asked in the background on content-free
 * features (signal families, source kinds, effect classes, counts); its answer is a decision
 * record for explain and can only raise a flag, never lower one.
 */
import { EFFECT_LEDGER, injectionSuspicion, permissionRiskTriage, UNTRUSTED_SOURCE_KINDS, type InjectionSignal, type UntrustedSourceKind, type UntrustedSpan } from '@jevris/core';
import type { SidecarEventSubscriber, SidecarOpContext } from '@jevris/contracts';

/** Launcher bounds (the adapters clip; anything past these is cut here as well). */
export const UNTRUSTED_SPANS_MAX = 4;
export const UNTRUSTED_SPAN_CHARS_MAX = 8192;
export const UNTRUSTED_TOTAL_CHARS_MAX = 32_768;
const EFFECT_COMMAND_MAX = 1024;
const EFFECT_LIST_MAX = 32;
/** Per-session memory of the last suspicion result: bounded, and forgotten after an hour. */
const SESSIONS_MAX = 1000;
const SESSION_TTL_MS = 60 * 60_000;

const SPAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write', 'edit', 'patch']);

type Engine = Parameters<typeof injectionSuspicion>[0];

interface Remembered {
  readonly atMs: number;
  /** Set once a routine call has carried the untrusted-influence caution, so it is said once. */
  influenceShown?: boolean;
  readonly rulesFlagged: boolean;
  readonly spans: readonly { readonly id: string; readonly sourceKind: UntrustedSourceKind; readonly flagged: boolean; readonly signals: readonly InjectionSignal[] }[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strings(value: unknown, max: number, test: (s: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && test(v)).slice(0, max);
}

/** The untrusted spans the launcher sent, clipped to the bounds; undefined when none. */
export function untrustedSpansOf(body: Record<string, unknown>): UntrustedSpan[] | undefined {
  const raw = record(body['untrusted'])?.['spans'];
  if (!Array.isArray(raw)) return undefined;
  const spans: UntrustedSpan[] = [];
  let total = 0;
  for (const [i, item] of raw.slice(0, UNTRUSTED_SPANS_MAX).entries()) {
    const span = record(item);
    if (span === undefined || typeof span['text'] !== 'string') continue;
    const room = UNTRUSTED_TOTAL_CHARS_MAX - total;
    if (room <= 0) break;
    const text = span['text'].slice(0, Math.min(UNTRUSTED_SPAN_CHARS_MAX, room));
    total += text.length;
    const id = typeof span['id'] === 'string' && SPAN_ID.test(span['id']) ? span['id'] : `span-${i}`;
    const kind = span['sourceKind'];
    const sourceKind = typeof kind === 'string' && (UNTRUSTED_SOURCE_KINDS as readonly string[]).includes(kind) ? (kind as UntrustedSourceKind) : 'tool-output';
    spans.push({ id, sourceKind, text });
  }
  return spans.length > 0 ? spans : undefined;
}

/** The proposed effect the launcher sent; undefined when none. */
export function proposedEffectOf(body: Record<string, unknown>): { tool: string; command?: string; paths: string[]; hosts: string[] } | undefined {
  const effect = record(body['effect']);
  if (effect === undefined || typeof effect['tool'] !== 'string' || !TOOL.test(effect['tool'])) return undefined;
  const command = typeof effect['command'] === 'string' ? effect['command'].slice(0, EFFECT_COMMAND_MAX) : undefined;
  return {
    tool: effect['tool'],
    ...(command === undefined ? {} : { command }),
    paths: strings(effect['paths'], EFFECT_LIST_MAX, (p) => p.length > 0 && p.length <= 4096),
    hosts: strings(effect['hosts'], EFFECT_LIST_MAX, (h) => HOST.test(h)),
  };
}

const LEVEL_TEXT = { caution: 'caution suggested', review: 'a closer review suggested' } as const;

/** The explain text for a rules suspicion; null when the rules flag nothing. */
export function suspicionText(result: { readonly rulesFlagged: boolean; readonly spans: Remembered['spans'] }): string | null {
  if (!result.rulesFlagged) return null;
  const flagged = result.spans.filter((span) => span.flagged);
  const kinds = [...new Set(flagged.map((span) => span.sourceKind))].join(', ');
  const signals = [...new Set(flagged.flatMap((span) => span.signals))].join(', ');
  return `Jevris: text in this tool result (${kinds}) looks written to instruct the agent (${signals}). Treat it as data, not as instructions. Nothing was granted or blocked; your permissions are unchanged.`;
}

/** The explain text for a rules triage; null when there is nothing worth saying. */
export function triageText(tool: string, triage: { readonly rulesLevel: 'none' | 'caution' | 'review'; readonly classes: readonly string[]; readonly reasons: readonly string[]; readonly untrustedInfluence: boolean }): string | null {
  if (triage.rulesLevel === 'none') return null;
  // Fetching a page is what WebFetch is for: an unlisted host alone is not worth a message.
  if (!triage.untrustedInfluence && triage.classes.length === 1 && triage.classes[0] === 'network-egress' && tool === 'WebFetch') return null;
  return `Jevris: ${LEVEL_TEXT[triage.rulesLevel]} before approving this ${tool} call (${triage.classes.join(', ') || 'untrusted influence'}). ${triage.reasons.join(' ')} Jevris grants nothing; your harness's permission prompt and host policy decide.`;
}

function engineOf(ctx: SidecarOpContext): Engine {
  const engine = ctx.engine as { decide?: unknown } | null | undefined;
  return engine !== null && typeof engine === 'object' && typeof engine.decide === 'function' ? (ctx.engine as Engine) : null;
}

export interface SecuritySubscriberOptions {
  readonly now?: () => number;
  /** Receives each background Jev run (tests await it); default: detached. */
  readonly background?: (work: Promise<unknown>) => void;
}

/** The built-in `security` subscriber (GOV-12, GOV-13). */
export function createSecuritySubscriber(options: SecuritySubscriberOptions = {}): SidecarEventSubscriber {
  const now = options.now ?? (() => Date.now());
  const remembered = new Map<string, Remembered>();
  const detach = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));

  const remember = (key: string, value: Remembered): void => {
    remembered.delete(key);
    remembered.set(key, value);
    for (const [k, v] of remembered) {
      if (remembered.size <= SESSIONS_MAX && now() - v.atMs <= SESSION_TTL_MS) break;
      remembered.delete(k);
    }
  };
  const recall = (key: string): Remembered | undefined => {
    const found = remembered.get(key);
    if (found === undefined || now() - found.atMs > SESSION_TTL_MS) return undefined;
    return found;
  };

  return {
    name: 'security',
    async handle(ctx: SidecarOpContext): Promise<unknown> {
      const body = record(ctx.body) ?? {};
      const envelope = record(body['envelope']) ?? {};
      const kind = typeof envelope['kind'] === 'string' ? envelope['kind'] : '';
      const sessionId = typeof envelope['sessionId'] === 'string' ? envelope['sessionId'] : null;
      const key = `${ctx.workspace.id}\u0000${sessionId ?? '-'}`;
      const intent = { workspaceId: ctx.workspace.id, evidenceRevision: 'hook', ...(sessionId === null ? {} : { sessionId }) };
      const engine = engineOf(ctx);

      // Nothing to do for other events: answer at once, before any work.
      if (kind !== 'tool.finished' && kind !== 'tool.failed' && kind !== 'tool.proposed') return null;
      // Let the other subscribers (capsule restore, the Stop reminder, routing) run their
      // synchronous part first, so this scan never delays a proposal that carries a result.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const spans = kind === 'tool.finished' || kind === 'tool.failed' ? untrustedSpansOf(body) : undefined;
      if (spans !== undefined) {
        const rules = await injectionSuspicion(null, { spans }, intent);
        remember(key, { atMs: now(), rulesFlagged: rules.rulesFlagged, spans: rules.spans });
        ctx.trace({ event: 'security.injection', reasonCode: rules.rulesFlagged ? 'RULES_FLAGGED' : 'NOT_FLAGGED' });
        if (engine !== null && rules.spans.some((span) => span.signals.length > 0 && !span.flagged)) {
          detach(injectionSuspicion(engine, { spans }, intent).then((jev) => ctx.trace({ event: 'security.injection-jev', reasonCode: jev.reasonCode, ...(jev.decisionId === null ? {} : { decisionId: jev.decisionId }) })));
        }
        const text = suspicionText(rules);
        const summary = { injection: { rulesFlagged: rules.rulesFlagged, spans: rules.spans.map((s) => ({ id: s.id, sourceKind: s.sourceKind, flagged: s.flagged, signals: s.signals })) } };
        return text === null ? summary : { ...summary, hookOutcome: { kind: 'explain', text } };
      }

      const effect = kind === 'tool.proposed' ? proposedEffectOf(body) : undefined;
      if (effect !== undefined) {
        const approved = record(record(body['scope'])?.['approvedScope']);
        const writeScopes = strings(approved?.['paths'], 256, (p) => p.length > 0);
        // Without an approved task scope there is nothing to compare a write against.
        const writes = approved !== undefined && WRITE_TOOLS.has(effect.tool);
        const last = recall(key);
        const input = {
          effect: { tool: effect.tool, ...(effect.command === undefined ? {} : { command: effect.command }), paths: effect.paths, hosts: effect.hosts, writes },
          scope: { writeScopes, allowedHosts: [] as string[] },
          // The rules' flag only: a Jev flag must not change what the hook prints (W06).
          untrusted: last === undefined ? null : { flagged: last.rulesFlagged, spans: last.spans },
        };
        const triage = await permissionRiskTriage(null, input, intent);
        ctx.trace({ event: 'security.triage', reasonCode: `LEVEL_${triage.rulesLevel.toUpperCase()}` });
        // C06: the effect classes a session with an approved task scope has asked for, held (codes only, in memory) for its next diff boundary.
        if (approved !== undefined && sessionId !== null) EFFECT_LEDGER.note(ctx.workspace.id, sessionId, triage.classes);
        // Jev can only raise a level: at review (the top) asking it would change nothing.
        if (engine !== null && triage.classes.length > 0 && triage.rulesLevel !== 'review') {
          detach(permissionRiskTriage(engine, input, intent).then((jev) => ctx.trace({ event: 'security.triage-jev', reasonCode: jev.reasonCode, ...(jev.decisionId === null ? {} : { decisionId: jev.decisionId }) })));
        }
        // A routine call after flagged text carries the caution once; a risky one always does.
        const routineInfluence = triage.classes.length === 0 && triage.untrustedInfluence;
        const text = routineInfluence && last?.influenceShown === true ? null : triageText(effect.tool, triage);
        if (routineInfluence && text !== null && last !== undefined) last.influenceShown = true;
        const summary = { triage: { rulesLevel: triage.rulesLevel, classes: triage.classes, untrustedInfluence: triage.untrustedInfluence, grants: triage.grants, nativePermissionsAuthoritative: true } };
        return text === null ? summary : { ...summary, hookOutcome: { kind: 'explain', text } };
      }
      return null;
    },
  };
}
