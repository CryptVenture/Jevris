/**
 * Chapter 6.1 Action union and the receipts around it (§6.2), with the ADR-06 restrictions.
 *
 * Deliberately absent: any field that could carry arbitrary shell text, an API key, a permission
 * grant, a raw user-consent assertion or an unrestricted URL. Every object is closed and every
 * string is an identifier, a model id or an upper-case reason code, and none may contain a
 * credential shape. Recommendations are rendered only from trusted templates.
 */
import { defineContract, timestampMs } from './contract.js';
import { AuthoritySchema, type EvidenceRef } from './domain.js';
import {
  Hash,
  Id,
  IdList,
  ModelId,
  ReasonCode,
  SECRET_PATTERNS,
  SemVer,
  Timestamp,
  URL_PATTERNS,
  containsSecret,
} from './primitives.js';
import * as S from './schema.js';

export const ACTION_KINDS = [
  'advise',
  'route-worker',
  'request-checkpoint',
  'select-evidence',
  'request-verification',
  'cancel-owned-worker',
  'abstain',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ActionKindSchema = S.enumOf(ACTION_KINDS);

const EvidenceIds = (minItems: number) => S.array(Id, { minItems, maxItems: 64, uniqueItems: true });

export const AdviseActionSchema = S.object({ kind: S.literal('advise'), templateId: Id, evidenceIds: EvidenceIds(0) });
export const RouteWorkerActionSchema = S.object({
  kind: S.literal('route-worker'),
  taskId: Id,
  modelId: ModelId,
  profileId: Id,
});
export const RequestCheckpointActionSchema = S.object({ kind: S.literal('request-checkpoint'), capsuleId: Id });
export const SelectEvidenceActionSchema = S.object({ kind: S.literal('select-evidence'), evidenceIds: EvidenceIds(1) });
export const RequestVerificationActionSchema = S.object({
  kind: S.literal('request-verification'),
  checkIds: S.array(Id, { minItems: 1, maxItems: 64, uniqueItems: true }),
});
export const CancelOwnedWorkerActionSchema = S.object({ kind: S.literal('cancel-owned-worker'), leaseId: Id });
export const AbstainActionSchema = S.object({ kind: S.literal('abstain'), reasonCode: ReasonCode });

export const ActionSchema = S.discriminatedUnion('kind', [
  AdviseActionSchema,
  RouteWorkerActionSchema,
  RequestCheckpointActionSchema,
  SelectEvidenceActionSchema,
  RequestVerificationActionSchema,
  CancelOwnedWorkerActionSchema,
  AbstainActionSchema,
]);
export type Action = S.Static<typeof ActionSchema>;

/** Defence in depth: no string anywhere in an action may hold a credential shape. */
function refineNoSecrets(value: unknown, issue: (path: string, code: string) => void, base: string): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (containsSecret(node)) issue(path, 'SECRET');
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}/${key}`);
    }
  };
  walk(value, base);
}

export const ActionContract = defineContract<Action>({
  name: 'Action',
  description: 'The closed set of actions Jevris may plan (§6.1, ADR-06). No shell, key, grant, consent or URL.',
  schema: ActionSchema,
  refine: (value, issue) => refineNoSecrets(value, issue, ''),
});

export const ActionIntentSchema = S.object(
  {
    id: Id,
    decisionId: Id,
    expectedRevision: Id,
    expiresAt: Timestamp,
    capabilityId: Id,
    action: ActionSchema,
  },
  { reservationId: Id },
);
export type ActionIntent = S.Static<typeof ActionIntentSchema>;

export const ActionIntentContract = defineContract<ActionIntent>({
  name: 'ActionIntent',
  description: 'A planned action bound to a decision, a revision, an expiry and a capability (§6.1).',
  schema: ActionIntentSchema,
  refine: (value, issue) => {
    refineNoSecrets(value.action, issue, '/action');
    if (value.action.kind === 'route-worker' && value.reservationId === undefined) {
      issue('/reservationId', 'RESERVATION_REQUIRED');
    }
  },
});

export const CAPABILITY_STATUSES = ['certified', 'experimental', 'unsupported'] as const;

export const CapabilitySchema = S.withCondition(
  S.object({
    id: Id,
    adapterId: Id,
    adapterVersion: SemVer,
    actionKind: ActionKindSchema,
    authority: AuthoritySchema,
    status: S.enumOf(CAPABILITY_STATUSES),
    constraints: IdList({ maxItems: 64 }),
    fixtureSuiteHash: Hash,
  }),
  {
    if: { properties: { authority: { const: 'actuate' } }, required: ['authority'] },
    then: { properties: { status: { const: 'certified' } } },
  },
);
export type Capability = S.Static<typeof CapabilitySchema>;

export const CapabilityContract = defineContract<Capability>({
  name: 'Capability',
  description: 'What an adapter can do for one action kind. No actuate without a certified implementation (§6.2).',
  schema: CapabilitySchema,
});

export const ACTION_RECEIPT_STATUSES = ['applied', 'refused', 'stale', 'advisory'] as const;

export const ActionReceiptSchema = S.object({
  id: Id,
  intentId: Id,
  status: S.enumOf(ACTION_RECEIPT_STATUSES),
  resultingRevision: Id,
  observedModelId: S.nullable(ModelId),
  reasonCode: ReasonCode,
  occurredAt: Timestamp,
});
export type ActionReceipt = S.Static<typeof ActionReceiptSchema>;

export const ActionReceiptContract = defineContract<ActionReceipt>({
  name: 'ActionReceipt',
  description: 'What happened to an intent. Planning an action is not evidence it happened (§6.2).',
  schema: ActionReceiptSchema,
});

/** Only an adapter-issued receipt with status "applied" is evidence that an action took effect. */
export function actionApplied(receipt: ActionReceipt): boolean {
  return receipt.status === 'applied';
}

export const AUTHORIZATION_ISSUER_PATTERN = '^(?:host-policy|managed-policy)(?:\\.[A-Za-z0-9_-]{1,64})?$';

export const AuthorizationReceiptSchema = S.object({
  id: Id,
  principalId: Id,
  workspaceId: Id,
  actionKinds: S.array(ActionKindSchema, { minItems: 1, maxItems: ACTION_KINDS.length, uniqueItems: true }),
  resourceIds: IdList(),
  issuedBy: S.string({ pattern: AUTHORIZATION_ISSUER_PATTERN }),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  signatureRef: Id,
});
export type AuthorizationReceipt = S.Static<typeof AuthorizationReceiptSchema>;

export const AuthorizationReceiptContract = defineContract<AuthorizationReceipt>({
  name: 'AuthorizationReceipt',
  description: 'A scoped, expiring authorization. Only trusted host or managed policy may issue it (§6.2).',
  schema: AuthorizationReceiptSchema,
  refine: (value, issue) => {
    if (timestampMs(value.expiresAt) <= timestampMs(value.issuedAt)) issue('/expiresAt', 'EXPIRY_NOT_AFTER_ISSUE');
  },
});

// ---------------------------------------------------------------------------------------------
// Recommendation templates (CTR-04): a recommendation is template text with typed slots only.

export const TEMPLATE_SLOTS = ['evidenceCount', 'evidenceIds'] as const;
export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

export const RecommendationTemplateSchema = S.object({
  id: Id,
  version: SemVer,
  text: S.string({
    minLength: 1,
    maxLength: 500,
    // Only the two typed slots may appear; any other brace is refused.
    pattern: '^(?:[^{}]|\\{evidenceCount\\}|\\{evidenceIds\\})+$',
    notPatterns: [...SECRET_PATTERNS, ...URL_PATTERNS],
  }),
});
export type RecommendationTemplate = S.Static<typeof RecommendationTemplateSchema>;

export const RecommendationTemplateContract = defineContract<RecommendationTemplate>({
  name: 'RecommendationTemplate',
  description: 'Trusted recommendation text with typed slots. Model output is never interpolated (§6.1).',
  schema: RecommendationTemplateSchema,
});

export interface RenderedRecommendation {
  readonly source: 'template';
  readonly templateId: string;
  readonly templateVersion: string;
  readonly text: string;
}

export type RenderResult =
  | { readonly ok: true; readonly recommendation: RenderedRecommendation }
  | { readonly ok: false; readonly reasonCode: 'INVALID_ACTION' | 'UNKNOWN_TEMPLATE' | 'INVALID_TEMPLATE' | 'EVIDENCE_NOT_SUPPLIED' };

/**
 * Renders an `advise` action from a trusted template registry. The only values substituted are
 * the number of evidence references and their validated identifiers. No other text from the
 * action or from a model can reach the output.
 */
export function renderRecommendation(
  action: unknown,
  templates: ReadonlyMap<string, RecommendationTemplate>,
  evidence: readonly EvidenceRef[],
): RenderResult {
  const checked = ActionContract.validate(action);
  if (!checked.ok || checked.value.kind !== 'advise') return { ok: false, reasonCode: 'INVALID_ACTION' };
  const advise = checked.value;
  const raw = templates.get(advise.templateId);
  if (raw === undefined) return { ok: false, reasonCode: 'UNKNOWN_TEMPLATE' };
  const template = RecommendationTemplateContract.validate(raw);
  if (!template.ok || template.value.id !== advise.templateId) return { ok: false, reasonCode: 'INVALID_TEMPLATE' };
  const supplied = new Set(evidence.map((ref) => ref.id));
  if (advise.evidenceIds.some((id) => !supplied.has(id))) return { ok: false, reasonCode: 'EVIDENCE_NOT_SUPPLIED' };
  const text = template.value.text
    .split('{evidenceCount}')
    .join(String(advise.evidenceIds.length))
    .split('{evidenceIds}')
    .join(advise.evidenceIds.join(', '));
  return {
    ok: true,
    recommendation: Object.freeze({
      source: 'template',
      templateId: template.value.id,
      templateVersion: template.value.version,
      text,
    }),
  };
}
