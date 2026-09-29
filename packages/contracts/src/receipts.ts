/** Chapter 6.2 VerificationReceipt and MemoryCapsule. */
import { defineContract } from './contract.js';
import { EvidenceRefSchema } from './domain.js';
import { Hash, Id, IdList, Timestamp, text } from './primitives.js';
import * as S from './schema.js';

export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'unknown', 'not-run'] as const;

export const VerificationReceiptSchema = S.object({
  id: Id,
  checkId: Id,
  workspaceId: Id,
  revision: Id,
  environmentHash: Hash,
  commandManifestId: Id,
  outcome: S.enumOf(VERIFICATION_OUTCOMES),
  rawOutputHash: Hash,
  executedAt: Timestamp,
  issuerId: Id,
  signatureRef: Id,
});
export type VerificationReceipt = S.Static<typeof VerificationReceiptSchema>;

export const VerificationReceiptContract = defineContract<VerificationReceipt>({
  name: 'VerificationReceipt',
  description: 'A runner-produced check result. Unknown and not-run are not passed (§6.2).',
  schema: VerificationReceiptSchema,
});

/** Only "passed" passes. "unknown" and "not-run" are never treated as passed. */
export function receiptPassed(receipt: VerificationReceipt): boolean {
  return receipt.outcome === 'passed';
}

export const MemoryCapsuleSchema = S.object({
  id: Id,
  schemaVersion: S.literal('1.0'),
  workspaceId: Id,
  revision: Id,
  objective: text(4000),
  pinnedEvidence: S.array(EvidenceRefSchema, { maxItems: 256 }),
  optionalEvidence: S.array(EvidenceRefSchema, { maxItems: 1024 }),
  taskIds: IdList(),
  unresolvedItems: S.array(text(1000), { maxItems: 256 }),
  hypotheses: S.array(text(1000), { maxItems: 256 }),
  authorizationHistoryRefs: IdList(),
  validUntil: Timestamp,
});
export type MemoryCapsule = S.Static<typeof MemoryCapsuleSchema>;

export const MemoryCapsuleContract = defineContract<MemoryCapsule>({
  name: 'MemoryCapsule',
  description: 'Pinned facts with provenance, task state, unresolved items and labelled hypotheses (§6.2).',
  schema: MemoryCapsuleSchema,
  refine: (value, issue) => {
    const seen = new Set<string>();
    const check = (list: 'pinnedEvidence' | 'optionalEvidence') =>
      value[list].forEach((ref, index) => {
        if (ref.workspaceId !== value.workspaceId) issue(`/${list}/${index}/workspaceId`, 'WORKSPACE_SCOPE');
        if (ref.span !== undefined && ref.span.start > ref.span.end) issue(`/${list}/${index}/span`, 'SPAN_ORDER');
        if (seen.has(ref.id)) issue(`/${list}/${index}/id`, 'DUPLICATE_EVIDENCE');
        seen.add(ref.id);
      });
    check('pinnedEvidence');
    check('optionalEvidence');
  },
});
