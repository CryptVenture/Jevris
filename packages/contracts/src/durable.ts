/**
 * Durable envelope (§6.1, CTR-03): every durable object carries a schema version, an id, a
 * workspace scope, a revision and a canonical content hash of its body.
 */
import { ContractError, defineContract, type Contract, type ContractIssue, type ValidationResult } from './contract.js';
import { contentHash } from './hash.js';
import type { Json } from './json.js';
import { Hash, Id } from './primitives.js';
import * as S from './schema.js';

export const CONTRACT_NAME_PATTERN = '^[A-Z][A-Za-z0-9]{0,63}$';

export const DurableEnvelopeSchema = S.object({
  schemaVersion: S.literal('1.0'),
  contract: S.string({ pattern: CONTRACT_NAME_PATTERN }),
  id: Id,
  workspaceId: Id,
  revision: Id,
  contentHash: Hash,
  body: S.json<Json>('The contract body. contentHash is sha256 over its RFC 8785 canonical JSON.'),
});
type DurableEnvelopeStatic = S.Static<typeof DurableEnvelopeSchema>;

export type Durable<T> = Omit<DurableEnvelopeStatic, 'body'> & { readonly body: T };

export const DurableEnvelopeContract = defineContract<DurableEnvelopeStatic>({
  name: 'DurableEnvelope',
  description: 'Schema version, id, workspace scope, revision and canonical content hash around a contract body (§6.1).',
  schema: DurableEnvelopeSchema,
});

export interface DurableIdentity {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: string;
}

function identityIssues(body: unknown, identity: DurableIdentity): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return issues;
  const record = body as Record<string, unknown>;
  for (const key of ['id', 'workspaceId', 'revision'] as const) {
    if (key in record && record[key] !== identity[key]) issues.push({ path: `/body/${key}`, code: 'IDENTITY_MISMATCH' });
  }
  return issues;
}

/** Validates the body with its contract, then seals it with the canonical hash. Throws ContractError. */
export function sealDurable<T>(contract: Contract<T>, identity: DurableIdentity, body: unknown): Durable<T> {
  const checked = contract.assert(body);
  const mismatch = identityIssues(checked, identity);
  if (mismatch.length > 0) throw new ContractError(contract.name, mismatch);
  const envelope = DurableEnvelopeContract.assert({
    schemaVersion: '1.0',
    contract: contract.name,
    id: identity.id,
    workspaceId: identity.workspaceId,
    revision: identity.revision,
    contentHash: contentHash(checked),
    body: checked,
  });
  return envelope as unknown as Durable<T>;
}

export type ContractLookup = (name: string) => Contract<unknown> | undefined;

/**
 * Validates an envelope, resolves its contract by name, validates the body, recomputes the
 * canonical hash and checks the body's own id, workspaceId and revision against the envelope.
 */
export function openDurable(value: unknown, lookup: ContractLookup): ValidationResult<Durable<unknown>> {
  const envelope = DurableEnvelopeContract.validate(value);
  if (!envelope.ok) return envelope;
  const contract = lookup(envelope.value.contract);
  if (contract === undefined) return { ok: false, issues: [{ path: '/contract', code: 'UNKNOWN_CONTRACT' }] };
  const body = contract.validate(envelope.value.body);
  if (!body.ok) return { ok: false, issues: body.issues.map((issue) => ({ path: `/body${issue.path}`, code: issue.code })) };
  if (contentHash(body.value) !== envelope.value.contentHash) {
    return { ok: false, issues: [{ path: '/contentHash', code: 'HASH_MISMATCH' }] };
  }
  const mismatch = identityIssues(body.value, envelope.value);
  if (mismatch.length > 0) return { ok: false, issues: mismatch };
  return { ok: true, value: envelope.value as Durable<unknown> };
}
