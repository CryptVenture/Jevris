import { PROBABILITY_EPSILON, type ChoiceSpec } from '@jevris/contracts';
import { validateChoiceBody } from './validate-choice.js';

export type SchemaFailureName = 'unknown-candidate' | 'non-normalized-distribution';

export interface SchemaFailureRecord {
  readonly failure: SchemaFailureName;
  readonly applied: false;
}

interface Utf8Decoder {
  decode(input?: Uint8Array): string;
}

function decodeUtf8(bytes: Uint8Array): string {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => Utf8Decoder;
  }).TextDecoder;
  if (Ctor === undefined) throw new Error('INVALID_RESPONSE');
  return new Ctor('utf-8', { fatal: true }).decode(bytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function classifySchemaFailure(bytes: Uint8Array, spec: ChoiceSpec): SchemaFailureName {
  const parsed: unknown = JSON.parse(decodeUtf8(bytes));
  if (!isPlainObject(parsed)) return 'unknown-candidate';
  const answers = parsed.answers;
  if (!isPlainObject(answers)) return 'unknown-candidate';
  const answer = answers[spec.id];
  if (!isPlainObject(answer) || typeof answer.choice !== 'string') return 'unknown-candidate';
  if (!Object.hasOwn(spec.criteria, answer.choice)) return 'unknown-candidate';
  const probabilities = answer.probabilities;
  if (!isPlainObject(probabilities)) return 'non-normalized-distribution';
  let sum = 0;
  for (const key of Object.keys(spec.criteria)) {
    const raw = probabilities[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'non-normalized-distribution';
    sum += raw;
  }
  if (Math.abs(sum - 1) > PROBABILITY_EPSILON) return 'non-normalized-distribution';
  throw new Error('NOT_A_SCHEMA_FAILURE');
}

export function recordSchemaFailure(bytes: Uint8Array | string, spec: ChoiceSpec): SchemaFailureRecord {
  if (typeof bytes === 'string' || !(bytes instanceof Uint8Array)) {
    throw new Error('KIND_NOT_ACCEPTED');
  }
  const validated = validateChoiceBody(bytes, spec);
  if (validated.ok) throw new Error('NOT_A_SCHEMA_FAILURE');
  const failure = classifySchemaFailure(bytes, spec);
  return { failure, applied: false };
}
