/**
 * Integration ops (ORC-07, W04), all local payloads:
 *
 * - `integration.run` (submit scope, CLI only; stopped by the kill switch):
 *   `{ taskIds: string[] }` prepares the integration of verified owned tasks and answers with
 *   the readiness report.
 * - `integration.get` (status scope): `{ integrationId }` gives one report, and `{}` gives the
 *   workspace's recent reports.
 * - `integration.approve` (submit scope, CLI only; stopped by the kill switch):
 *   `{ integrationId, actor? }` is the user's explicit approval. It fast-forwards the main
 *   checkout to a `ready` integration commit and never pushes.
 */
import { ID_PATTERN, type SidecarOpContext, type SidecarOpOutcome } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { isPlain, own } from '../util.js';
import { readEffectiveConfig } from '../settings/config.js';
import { INTEGRATION_MAX_TASKS, approveIntegration, getIntegration, listIntegrations, runIntegration } from '../orchestration/integration.js';
import { detectIntegrationRevertsInBackground } from '../orchestration/integration-reverts.js';

type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

const CONTRACT_ID = new RegExp(ID_PATTERN);
const INTEGRATION_ID = /^int-[0-9a-f]{12}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/;

function integrationIdOf(body: unknown): string | undefined {
  const raw = isPlain(body) ? own(body, 'integrationId') : undefined;
  return typeof raw === 'string' && INTEGRATION_ID.test(raw) ? raw : undefined;
}

export function integrationOps(workspaceOf: WorkspaceOf) {
  const needWs = (ctx: SidecarOpContext) => {
    const ws = workspaceOf(ctx);
    return ws === undefined || ws.workspaceRoot === '' ? undefined : ws;
  };
  return [
    {
      op: 'integration.run',
      scope: 'submit' as const,
      budget: 'background' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const raw = isPlain(ctx.body) ? own(ctx.body, 'taskIds') : undefined;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > INTEGRATION_MAX_TASKS) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (!raw.every((t): t is string => typeof t === 'string' && CONTRACT_ID.test(t))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const egressApproved = readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config.privacy.sourceEgress === 'approved-scoped';
        const report = await runIntegration(ws, raw, { signal: ctx.signal, ...(ctx.killSwitchStopped ? {} : { engine: ctx.engine }), egressApproved });
        ctx.trace({ event: 'orchestrator.integration-run', reasonCode: report.reasonCode.slice(0, 64) });
        return { ok: true, body: report };
      },
    },
    {
      op: 'integration.get',
      scope: 'status' as const,
      budget: 'hot' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const asked = isPlain(ctx.body) ? own(ctx.body, 'integrationId') : undefined;
        if (asked === undefined) {
          const reports = [...listIntegrations(ws)].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 20);
          return { ok: true, body: { found: reports.length > 0, reports } };
        }
        const id = integrationIdOf(ctx.body);
        if (id === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        // P2: looking at an integration also looks for a later revert of what it merged (in the background).
        detectIntegrationRevertsInBackground(ws);
        const report = getIntegration(ws, id);
        return { ok: true, body: { found: report !== undefined, reports: report === undefined ? [] : [report] } };
      },
    },
    {
      op: 'integration.approve',
      scope: 'submit' as const,
      budget: 'background' as const,
      stoppedByKillSwitch: true,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        const id = integrationIdOf(ctx.body);
        const actorRaw = isPlain(ctx.body) ? own(ctx.body, 'actor') : undefined;
        if (id === undefined) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (actorRaw !== undefined && (typeof actorRaw !== 'string' || !ACTOR.test(actorRaw))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        // Approval is a person's act at the CLI: MCP and hooks never hold the submit scope.
        if (ctx.client !== 'cli') return { ok: false, reasonCode: 'CLI_ONLY' };
        const ws = needWs(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const result = await approveIntegration(ws, id, typeof actorRaw === 'string' ? actorRaw : 'local-user');
        ctx.trace({ event: 'orchestrator.integration-approve', reasonCode: result.ok ? 'MERGED' : result.reasonCode });
        return { ok: true, body: result.ok ? { merged: true, reasonCode: 'MERGED', report: result.report } : { merged: false, reasonCode: result.reasonCode, report: getIntegration(ws, id) ?? null } };
      },
    },
  ];
}
