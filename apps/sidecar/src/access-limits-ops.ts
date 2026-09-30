/**
 * Access limits R78 (design access-limits.md 9.2; agreed with E): the sidecar op behind
 * `jevris route limits clear`.
 *
 * - `access-limits.clear` { entries: 'all' | keys[], channel: 'terminal' }: admin scope (the CLI
 *   client only; no hook, no MCP tool). A clear lets routes use a paused scope again, so it is
 *   treated like a consent grant: only a person at an interactive terminal may ask for it, and any
 *   other channel is refused (CHANNEL_REFUSED).
 * - A key is the 16-hex key the person saw in `jevris route limits`; an unknown key clears nothing.
 *   At most 128 keys, none repeated.
 * - It calls core's `clearAccessLimits` (the record's own lock), then appends the audit row
 *   `access-limit.clear` { count, classes }. A file and a SQLite row cannot share one transaction,
 *   so the row follows a successful clear; if the store refuses it, the answer says `audited: false`.
 * - Listing needs no op: the CLI and status read the record with `readAccessLimits`.
 */
import { clearAccessLimits } from '@jevris/core';
import type { SidecarOpContext, SidecarOpDefinition } from '@jevris/contracts';
import type { OpenedStore } from '@jevris/store';
import { bodyRecord, ok, refuse } from './ops.js';

type StoreModule = typeof import('@jevris/store');

const KEY = /^[0-9a-f]{16}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;
export const ACCESS_LIMITS_CLEAR_MAX_KEYS = 128;

export interface AccessLimitsOpsDeps {
  readonly store: () => { readonly store: OpenedStore; readonly api: StoreModule } | undefined;
  readonly nowMs?: () => number;
  /** Tests only: the clear (default: core's clearAccessLimits). */
  readonly clear?: typeof clearAccessLimits;
}

function entriesOf(ctx: SidecarOpContext): 'all' | readonly string[] | undefined {
  const value = bodyRecord(ctx)['entries'];
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length === 0 || value.length > ACCESS_LIMITS_CLEAR_MAX_KEYS) return undefined;
  if (!value.every((k): k is string => typeof k === 'string' && KEY.test(k))) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

function actorOf(ctx: SidecarOpContext): string {
  const actor = bodyRecord(ctx)['actor'];
  return typeof actor === 'string' && ACTOR.test(actor) ? actor : 'cli';
}

export function accessLimitsOps(deps: AccessLimitsOpsDeps): readonly SidecarOpDefinition[] {
  const nowMs = deps.nowMs ?? Date.now;
  const clear = deps.clear ?? clearAccessLimits;
  return [
    {
      op: 'access-limits.clear',
      scope: 'admin',
      budget: 'hot',
      // The record is machine-wide: the CLI may ask from any folder.
      workspace: 'optional',
      async handle(ctx) {
        if (bodyRecord(ctx)['channel'] !== 'terminal') return refuse('CHANNEL_REFUSED', 'Access limits are cleared only by a person at an interactive terminal.');
        // GOV-02..04: clearing a limit resumes held work; a stopped Jevris resumes nothing until the person clears the kill switch.
        if (ctx.killSwitchStopped) return refuse('KILL_SWITCH', 'The kill switch is on, so access limits are not cleared. Clear the kill switch first (jevris kill-switch clear), then clear the limits.');
        const entries = entriesOf(ctx);
        if (entries === undefined) return refuse('INVALID_INPUT', "Name the limits to clear by their 16-character keys (at most 128), or 'all'.");
        let result: Awaited<ReturnType<typeof clearAccessLimits>>;
        try {
          result = await clear(ctx.home, { entries, nowMs: nowMs() });
        } catch {
          return refuse('WRITE_FAILED', 'The access-limit record could not be changed; nothing was cleared.');
        }
        if (!result.ok) return refuse('WRITE_FAILED', 'The access-limit record could not be changed; nothing was cleared.');
        const cleared = result.cleared.map((c) => ({ key: c.key, class: c.class, scope: c.scope }));
        let audited = false;
        const held = deps.store();
        if (held !== undefined) {
          try {
            const classes = [...new Set(cleared.map((c) => c.class))].sort();
            const row = held.api.appendAudit(held.store, { kind: 'access-limit.clear', actor: actorOf(ctx), channel: 'terminal', detail: { count: cleared.length, classes }, atMs: nowMs() });
            audited = row.ok;
          } catch {
            audited = false;
          }
        }
        return ok({ cleared, audited });
      },
    },
  ];
}
