/**
 * The sidecar op behind `jevris credential reenable` (coordinator decision ea2af91a on A's R77
 * finding; C2's core, E's CLI).
 *
 * - `jev.reenable` { channel: 'terminal', actor? }: admin scope (the CLI client only; no hook, no
 *   MCP tool). Re-enabling restarts billed Jev calls on an account the provider refused, so only a
 *   person at an interactive terminal may ask for it; any other channel is refused
 *   (CHANNEL_REFUSED).
 * - The body never names a circuit or a key: the op clears the engine's own circuit (its breaker
 *   key and credential fingerprint), through `engine.circuit.clearDisabled()`.
 * - Only a billing (402) or account (403) disable is cleared; the circuit moves to observe-only.
 *   A key refusal (401, AUTH) stays tied to the key: AUTH_NEEDS_NEW_KEY, fixed by
 *   `jevris credential set`. A circuit that is not disabled answers NOT_DISABLED, and so does an
 *   engine with no provider or breaker (there is nothing to re-enable).
 * - Nothing calls Jev here: the next call comes from ordinary use.
 * - The breaker's state file has a single writer, the sidecar's engine; the CLI never writes it.
 * - A successful clear is followed by the audit row `credential.reenable` { count, reasonClass }:
 *   no key, fingerprint or remote text. A file and a SQLite row cannot share one transaction, so
 *   the row follows the clear; if the store refuses it, the answer says `audited: false`.
 *   `persisted: false` means the clear holds in memory but the state file was not written, so a
 *   restart brings the disable back.
 */
import type { SidecarOpContext, SidecarOpDefinition } from '@jevris/contracts';
import type { OpenedStore } from '@jevris/store';
import { bodyRecord, ok, refuse } from './ops.js';

type StoreModule = typeof import('@jevris/store');

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
const CLEARED = new Set(['BILLING', 'ACCOUNT']);

export interface JevReenableOpsDeps {
  readonly store: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined;
  /** The engine the sidecar holds (its `circuit` handle, when it has a provider and breaker). */
  readonly engine: () => unknown;
  readonly nowMs?: () => number;
}

/** The answer of `engine.circuit.clearDisabled()`, read defensively. */
type ClearAnswer =
  | { readonly ok: true; readonly cleared: 'BILLING' | 'ACCOUNT'; readonly persisted: boolean }
  | { readonly ok: false; readonly reasonCode: 'NOT_DISABLED' | 'AUTH_NEEDS_NEW_KEY' };

function actorOf(ctx: SidecarOpContext): string {
  const actor = bodyRecord(ctx)['actor'];
  return typeof actor === 'string' && ACTOR.test(actor) ? actor : 'cli';
}

function clearOf(engine: unknown): (() => Promise<unknown>) | null {
  if (engine === null || typeof engine !== 'object') return null;
  const circuit = Reflect.get(engine, 'circuit') as unknown;
  if (circuit === null || typeof circuit !== 'object') return null;
  const clear = Reflect.get(circuit, 'clearDisabled') as unknown;
  return typeof clear === 'function' ? () => (clear as () => Promise<unknown>).call(circuit) : null;
}

function answerOf(value: unknown): ClearAnswer | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as { readonly [key: string]: unknown };
  if (record['ok'] === true) {
    const cleared = record['cleared'];
    if (typeof cleared !== 'string' || !CLEARED.has(cleared)) return null;
    return { ok: true, cleared: cleared as 'BILLING' | 'ACCOUNT', persisted: record['persisted'] === true };
  }
  if (record['ok'] === false && (record['reasonCode'] === 'NOT_DISABLED' || record['reasonCode'] === 'AUTH_NEEDS_NEW_KEY')) {
    return { ok: false, reasonCode: record['reasonCode'] };
  }
  return null;
}

export function jevReenableOps(deps: JevReenableOpsDeps): readonly SidecarOpDefinition[] {
  const nowMs = deps.nowMs ?? Date.now;
  return [
    {
      op: 'jev.reenable',
      scope: 'admin',
      budget: 'hot',
      // The circuit is the sidecar's own: the CLI may ask from any folder.
      workspace: 'optional',
      async handle(ctx) {
        if (bodyRecord(ctx)['channel'] !== 'terminal') return refuse('CHANNEL_REFUSED', 'Jev is re-enabled only by a person at an interactive terminal.');
        // GOV-02..04: re-enabling resumes semantic decisions; a stopped Jevris resumes nothing until the person clears the kill switch.
        if (ctx.killSwitchStopped) return refuse('KILL_SWITCH', 'The kill switch is on, so Jev is not re-enabled. Clear the kill switch first (jevris kill-switch clear), then re-enable Jev.');
        const clear = clearOf(deps.engine());
        if (clear === null) return refuse('NOT_DISABLED', 'Jev has no provider circuit here, so nothing is disabled.');
        let answer: ClearAnswer | null;
        try {
          answer = answerOf(await clear());
        } catch {
          answer = null;
        }
        if (answer === null) return refuse('WRITE_FAILED', 'The Jev circuit could not be changed; nothing was re-enabled.');
        if (!answer.ok) {
          return answer.reasonCode === 'AUTH_NEEDS_NEW_KEY'
            ? refuse('AUTH_NEEDS_NEW_KEY', 'The key itself was refused; store a new one with `jevris credential set`.')
            : refuse('NOT_DISABLED', 'Jev is not disabled, so there is nothing to re-enable.');
        }
        let audited = false;
        const held = deps.store();
        if (held !== undefined) {
          try {
            const row = held.api.appendAudit(held.store, { kind: 'credential.reenable', actor: actorOf(ctx), channel: 'terminal', detail: { count: 1, reasonClass: answer.cleared }, atMs: nowMs() });
            audited = row.ok;
          } catch {
            audited = false;
          }
        }
        return ok({ cleared: answer.cleared, persisted: answer.persisted, audited });
      },
    },
  ];
}
