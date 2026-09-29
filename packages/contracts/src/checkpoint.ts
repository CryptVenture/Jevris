/**
 * Local capsule document. Not a decision ledger and not an observation file.
 * Authority literals are assigned by the writer. This file exports types only.
 */

export type ConstraintKind = 'compatibility' | 'security' | 'user';

export type OpenCheckState = 'open' | 'stale';

export type CheckpointReasonCode =
  | 'ACCEPTED'
  | 'CALLER_REJECTED'
  | 'INVALID_CAPSULE'
  | 'WRITE_FAILED'
  | 'OVERSIZE';

export interface CapsuleConstraint {
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly text: string;
}

export interface CapsuleApproval {
  readonly id: string;
  readonly scope: string;
  readonly expiresAtMs: number;
  readonly authorizesEffect: false;
}

export interface CapsuleHash {
  readonly path: string;
  readonly hash: string;
}

export interface CapsuleOpenCheck {
  readonly id: string;
  readonly state: OpenCheckState;
}

export interface CapsuleFile {
  readonly schemaVersion: '1.0';
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly policyVersion: string;
  readonly evidenceRevision: string;
  readonly userConstraints: readonly CapsuleConstraint[];
  readonly taskIds: readonly string[];
  readonly approvals: readonly CapsuleApproval[];
  readonly sourceHashes: readonly CapsuleHash[];
  readonly openChecks: readonly CapsuleOpenCheck[];
  readonly restoreQueued: boolean;
  readonly providerCalls: 0;
  readonly applied: false;
  readonly toolPermission: false;
}
