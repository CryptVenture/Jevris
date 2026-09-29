/**
 * Compile-time checks that the inferred contract types equal the SSOT chapter 6 shapes.
 * Compiled with `tsc -p typecheck` by the contracts test; never emitted or shipped.
 */
import type {
  Action,
  ActionIntent,
  EvidenceRef,
  EventEnvelope,
  HookOutcome,
  Json,
  Mode,
  SessionSnapshot,
  TaskNode,
  VerificationReceipt,
} from '../dist/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type SsotAction =
  | { readonly kind: 'advise'; readonly templateId: string; readonly evidenceIds: readonly string[] }
  | { readonly kind: 'route-worker'; readonly taskId: string; readonly modelId: string; readonly profileId: string }
  | { readonly kind: 'request-checkpoint'; readonly capsuleId: string }
  | { readonly kind: 'select-evidence'; readonly evidenceIds: readonly string[] }
  | { readonly kind: 'request-verification'; readonly checkIds: readonly string[] }
  | { readonly kind: 'cancel-owned-worker'; readonly leaseId: string }
  | { readonly kind: 'abstain'; readonly reasonCode: string };

type SsotEvidenceRef = {
  readonly id: string;
  readonly workspaceId: string;
  readonly contentHash: string;
  readonly sourceKind: 'user' | 'file' | 'tool' | 'policy' | 'receipt';
  readonly trust: 'verified-policy' | 'human-input' | 'untrusted-content';
  readonly observedAt: string;
  readonly revision: string;
  readonly span?: { readonly start: number; readonly end: number };
};

type SsotSnapshot = {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly revision: string;
  readonly mode: Mode;
  readonly requestedModelId: string | null;
  readonly actualModelId: string | null;
  readonly contextTokensEstimate: number | null;
  readonly activeTaskIds: readonly string[];
  readonly observedAt: string;
};

export type Checks = [
  Expect<Equal<Mode, 'off' | 'observe' | 'advise' | 'bounded-auto'>>,
  Expect<Equal<Action, SsotAction>>,
  Expect<Equal<EvidenceRef, SsotEvidenceRef>>,
  Expect<Equal<SessionSnapshot, SsotSnapshot>>,
  Expect<Equal<ActionIntent['action'], SsotAction>>,
  Expect<Equal<ActionIntent['reservationId'], string | undefined>>,
  Expect<Equal<EventEnvelope<{ readonly n: number }>['payload'], { readonly n: number }>>,
  Expect<Equal<EventEnvelope['payload'], Json>>,
  Expect<Equal<TaskNode['schemaVersion'], '1.0'>>,
  Expect<Equal<VerificationReceipt['outcome'], 'passed' | 'failed' | 'unknown' | 'not-run'>>,
  Expect<Equal<Extract<HookOutcome, { kind: 'route' }>, { readonly kind: 'route'; readonly model: string; readonly variant?: string | null }>>,
  Expect<Equal<HookOutcome['kind'], 'observe' | 'context' | 'route' | 'explain'>>,
];
