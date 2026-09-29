/** Pure planning guard. It never issues permission, reserves money, or executes an action. */
import type { Action, ActionIntent, Mode } from './contracts.js';
export interface GuardContext {
  readonly nowMs: number; readonly mode: Mode; readonly revision: string;
  readonly authorizedActionKinds: ReadonlySet<Action['kind']>;
  readonly ownedTaskIds: ReadonlySet<string>; readonly ownedLeaseIds: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<string>; readonly approvedModelIds: ReadonlySet<string>;
  readonly userPinnedModelId?: string | undefined;
  readonly calibrationApproved: boolean; readonly reservationValid: boolean;
}
export type GuardResult = { readonly allowed: boolean; readonly reason: string };
const kinds: ReadonlySet<string> = new Set(['advise', 'route-worker', 'request-checkpoint', 'select-evidence',
  'request-verification', 'cancel-owned-worker', 'abstain']);
export function checkIntent(intent: ActionIntent, context: GuardContext): GuardResult {
  const reject = (reason: string): GuardResult => ({ allowed: false, reason });
  if (!intent.action || !kinds.has(intent.action.kind)) return reject('ACTION_KIND');
  if (context.mode === 'off' || context.mode === 'observe') return reject('MODE');
  if (context.mode === 'advise' && !['advise', 'abstain'].includes(intent.action.kind)) return reject('MODE');
  const expiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(context.nowMs) || !Number.isFinite(expiry) || context.nowMs >= expiry) return reject('EXPIRED');
  if (intent.expectedRevision !== context.revision) return reject('STALE');
  if (!context.capabilities.has(intent.capabilityId)) return reject('CAPABILITY');
  if (!context.authorizedActionKinds.has(intent.action.kind)) return reject('AUTHORITY');
  if (intent.action.kind === 'route-worker') {
    if (!context.ownedTaskIds.has(intent.action.taskId)) return reject('OWNERSHIP');
    if (!context.approvedModelIds.has(intent.action.modelId)) return reject('MODEL');
    if (context.userPinnedModelId !== undefined && context.userPinnedModelId !== intent.action.modelId) return reject('USER_PIN');
    if (!context.calibrationApproved) return reject('CALIBRATION');
    if (!intent.reservationId || !context.reservationValid) return reject('BUDGET');
  }
  if (intent.action.kind === 'cancel-owned-worker' && !context.ownedLeaseIds.has(intent.action.leaseId)) return reject('OWNERSHIP');
  return { allowed: true, reason: 'ELIGIBLE_NOT_AUTHORIZATION' };
}
