/**
 * Owned mode per workspace (TOOL-10, IPC-10).
 *
 * When owned mode is on for a workspace, MCP clients bound to that workspace get exactly one
 * extra capability: the `task.submit` op (MCP tool `jevris_submit_task`). The setting is
 * durable (host orchestration ledger, collection `owned-mode`, keyed by the sidecar's
 * workspace id) and changes only through the CLI at admin scope. An environment variable
 * alone never enables it. The sidecar reads it per request with `ownedModeEnabled`.
 */
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { openLedger, type RecordLedger } from '../ledger.js';
import { isId } from '../util.js';

export const OWNED_MODE_OP = 'task.submit';

export interface OwnedModeRecord {
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly changedAt: string;
  readonly changedBy: string;
}

function hostLedger(home: string): RecordLedger {
  return openLedger(join(jevrisPaths({ home }).data, 'orchestration', 'host'));
}

/** Sets owned mode. Only the CLI (the trusted terminal channel) may call this. */
export async function setOwnedMode(input: {
  readonly home: string;
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly channel: 'cli';
  readonly actor?: string;
  readonly nowMs?: number;
}): Promise<{ readonly ok: true; readonly record: OwnedModeRecord } | { readonly ok: false; readonly reasonCode: 'CHANNEL_REFUSED' | 'INVALID_WORKSPACE' }> {
  if (input.channel !== 'cli') return { ok: false, reasonCode: 'CHANNEL_REFUSED' };
  if (!isId(input.workspaceId)) return { ok: false, reasonCode: 'INVALID_WORKSPACE' };
  const record: OwnedModeRecord = {
    workspaceId: input.workspaceId,
    enabled: input.enabled === true,
    changedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    changedBy: (input.actor ?? 'cli').slice(0, 64),
  };
  await hostLedger(input.home).transact((tx) => tx.put('owned-mode', input.workspaceId, record));
  return { ok: true, record };
}

/** Whether owned mode is on for the workspace. Absent or unreadable means off. */
export function ownedModeEnabled(home: string, workspaceId: string): boolean {
  if (!isId(workspaceId)) return false;
  try {
    return hostLedger(home).get<OwnedModeRecord>('owned-mode', workspaceId)?.enabled === true;
  } catch {
    return false;
  }
}

export function ownedModeRecord(home: string, workspaceId: string): OwnedModeRecord | undefined {
  if (!isId(workspaceId)) return undefined;
  return hostLedger(home).get<OwnedModeRecord>('owned-mode', workspaceId);
}
