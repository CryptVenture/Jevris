/**
 * `capability.advise` (advice scope): D's capabilities through the sidecar (SSOT §12).
 *
 * Body: `{ capabilityId: 'C33' | 'CAP-33', input?: object, taskId?: string | null }`. The
 * answer is the advice envelope (`CapabilityAdvice`), a local payload built from sanitised
 * values only. While the kill switch is stopped no engine is consulted (rules only). Advice
 * grants nothing: every guard flag in the envelope is false.
 */
import { ID_PATTERN, type SidecarOpContext, type SidecarOpOutcome } from '@jevris/contracts';
import type { WorkspaceServices } from '../workspace.js';
import { readEffectiveConfig } from '../settings/config.js';
import { isPlain, own } from '../util.js';
import { adviseCapability } from '../capabilities/registry.js';

const CONTRACT_ID = new RegExp(ID_PATTERN);
const MAX_INPUT_BYTES = 256 * 1024;

export type WorkspaceOf = (ctx: SidecarOpContext) => WorkspaceServices | undefined;

export function capabilityOps(workspaceOf: WorkspaceOf) {
  return [
    {
      op: 'capability.advise',
      scope: 'advice' as const,
      budget: 'background' as const,
      async handle(ctx: SidecarOpContext): Promise<SidecarOpOutcome> {
        if (!isPlain(ctx.body)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const capabilityId = own(ctx.body, 'capabilityId');
        const input = own(ctx.body, 'input');
        const taskRaw = own(ctx.body, 'taskId');
        if (input !== undefined && !isPlain(input)) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        if (taskRaw !== undefined && taskRaw !== null && (typeof taskRaw !== 'string' || !CONTRACT_ID.test(taskRaw))) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        let size = 0;
        try {
          size = JSON.stringify(input ?? {}).length;
        } catch {
          return { ok: false, reasonCode: 'INVALID_REQUEST' };
        }
        if (size > MAX_INPUT_BYTES) return { ok: false, reasonCode: 'INVALID_REQUEST' };
        const ws = workspaceOf(ctx);
        if (ws === undefined) return { ok: false, reasonCode: 'WORKSPACE_ROOT_UNKNOWN' };
        const config = readEffectiveConfig({ home: ctx.home, workspaceRoot: ws.workspaceRoot }).config;
        const result = await adviseCapability(ws, {
          capabilityId,
          input: input ?? {},
          taskId: typeof taskRaw === 'string' ? taskRaw : null,
          engine: ctx.killSwitchStopped ? undefined : ctx.engine,
          egressApproved: config.privacy.sourceEgress === 'approved-scoped',
          remainingMs: ctx.deadline.remainingMs() - 250,
          home: ctx.home,
        });
        if (!result.ok) {
          ctx.trace({ event: 'orchestrator.capability-refused', reasonCode: result.reasonCode });
          return result.op === undefined ? { ok: false, reasonCode: result.reasonCode } : { ok: false, reasonCode: result.reasonCode, message: `use the ${result.op} op` };
        }
        ctx.trace({ event: 'orchestrator.capability-advice', reasonCode: result.advice.reasonCode, ...(result.advice.decisionId === null ? {} : { decisionId: result.advice.decisionId }) });
        return { ok: true, body: result.advice };
      },
    },
  ];
}
