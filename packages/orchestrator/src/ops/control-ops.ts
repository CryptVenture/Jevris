/**
 * Multi-host control service ops (ORC-12), local payloads:
 *
 * - `control.status` (status scope): whether this host leases through a control service, the
 *   service URL (never the token), whether the workspace was migrated, and whether the service
 *   answers with this host's token. Unusable settings are named, not hidden.
 * - `control.migrate` (admin scope, CLI only; stopped by the kill switch): `{ actor }` moves
 *   this workspace's single-host lease state to the configured service once. Afterwards the
 *   host-local authority grants no new lease for the workspace.
 */
import type { SidecarOpContext, SidecarOpOutcome } from '@jevris/contracts';
import { readFileSync } from 'node:fs';
import type { WorkspaceServices } from '../workspace.js';
import { isPlain, own } from '../util.js';
import { CONTROL_MIGRATIONS, controlClient, migrateToControlService, readControlSettings, readTokenFile, type ControlMigration, type ControlClient } from '../control/client.js';

type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

function clientFor(ws: WorkspaceServices): ControlClient | string | undefined {
  const read = readControlSettings(ws.configDir);
  if (!read.configured) return undefined;
  if ('problem' in read) return read.problem;
  const { settings } = read;
  try {
    return controlClient({
      url: settings.url,
      token: () => readTokenFile(settings.tokenFile),
      ...(settings.caFile === undefined ? {} : { ca: readFileSync(settings.caFile) }),
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'control: unusable settings';
  }
}

export function controlOps(workspaceOf: WorkspaceOf) {
  return [
    {
      op: 'control.status',
      scope: 'status' as const,
      budget: 'hot' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const migration = ws.host.get<ControlMigration>(CONTROL_MIGRATIONS, ws.workspaceId) ?? null;
        const client = clientFor(ws);
        if (client === undefined) {
          return { ok: true, body: { configured: false, url: null, problem: null, reachable: null, migrated: migration !== null, reasonCode: migration === null ? 'SINGLE_HOST' : 'CONTROL_SERVICE_REQUIRED' } };
        }
        if (typeof client === 'string') return { ok: true, body: { configured: true, url: null, problem: client, reachable: null, migrated: migration !== null, reasonCode: 'CONTROL_SETTINGS_UNUSABLE' } };
        const probe = await client.call('leases', { workspaceId: ws.workspaceId });
        const active = probe.ok && Array.isArray(own(probe.result, 'active')) ? (own(probe.result, 'active') as unknown[]).length : null;
        const reasonCode = probe.ok ? 'CONTROL_SERVICE' : probe.reason === 'unauthorized' ? 'CONTROL_UNAUTHORIZED' : probe.reason === 'token' ? 'CONTROL_TOKEN_UNUSABLE' : 'CONTROL_UNAVAILABLE';
        return { ok: true, body: { configured: true, url: client.url, problem: null, reachable: probe.ok, activeLeases: active, migrated: migration !== null, reasonCode } };
      },
    },
    {
      op: 'control.migrate',
      scope: 'admin' as const,
      budget: 'hot' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        if (ctx.client !== 'cli') return { ok: false, reasonCode: 'CLI_ONLY' };
        const actor = isPlain(ctx.body) ? own(ctx.body, 'actor') : undefined;
        if (typeof actor !== 'string' || !ACTOR.test(actor)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const client = clientFor(ws);
        if (client === undefined) return { ok: true, body: { migrated: false, reasonCode: 'CONTROL_NOT_CONFIGURED', imported: null } };
        if (typeof client === 'string') return { ok: true, body: { migrated: false, reasonCode: 'CONTROL_SETTINGS_UNUSABLE', problem: client, imported: null } };
        const result = await migrateToControlService(ws, client);
        ctx.trace({ event: 'orchestrator.control-migrate', reasonCode: result.ok ? 'MIGRATED' : result.reasonCode });
        return { ok: true, body: result.ok ? { migrated: true, reasonCode: 'MIGRATED', imported: result.imported, by: actor } : { migrated: false, reasonCode: result.reasonCode, imported: null } };
      },
    },
  ];
}
