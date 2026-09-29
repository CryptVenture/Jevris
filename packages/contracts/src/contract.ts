import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { frozenCopy, jsonIssue, parseJson, DEFAULT_MAX_JSON_BYTES } from './json.js';
import { jsonSchemaOf, type TSchema } from './schema.js';

export const CONTRACT_SCHEMA_VERSION = '1.0' as const;

export interface ContractIssue {
  /** JSON pointer into the validated value. Never contains input values. */
  readonly path: string;
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

export type Refinement<T> = (value: T, issue: (path: string, code: string) => void) => void;

export interface Contract<T> {
  readonly name: string;
  readonly version: typeof CONTRACT_SCHEMA_VERSION;
  readonly description: string;
  readonly schema: TSchema<T>;
  /** Validates a value; on success returns a deep-frozen copy. */
  validate(value: unknown): ValidationResult<T>;
  is(value: unknown): value is T;
  /** Returns the validated deep-frozen copy or throws ContractError. */
  assert(value: unknown): T;
  /** Parses bounded UTF-8 JSON, then validates. */
  parse(input: Uint8Array | string, maxBytes?: number): ValidationResult<T>;
}

export class ContractError extends Error {
  readonly contract: string;
  readonly issues: readonly ContractIssue[];
  constructor(contract: string, issues: readonly ContractIssue[]) {
    super(`${contract} is invalid: ${issues.map((issue) => `${issue.path || '/'} ${issue.code}`).join('; ')}`);
    this.name = 'ContractError';
    this.contract = contract;
    this.issues = issues;
  }
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** RFC 3339 date-time with an explicit offset. Calendar fields are range checked. */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[9] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Milliseconds since the epoch for a validated timestamp. */
export function timestampMs(value: string): number {
  return Date.parse(value);
}

let sharedAjv: Ajv2020 | undefined;

/** The one Ajv instance: strict, no coercion, no defaults, no stripping, Jevris date-time format. */
export function contractAjv(): Ajv2020 {
  if (sharedAjv === undefined) {
    sharedAjv = new Ajv2020({
      strict: true,
      allErrors: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
      validateFormats: true,
    });
    sharedAjv.addFormat('date-time', { type: 'string', validate: (value: string) => isTimestamp(value) });
  }
  return sharedAjv;
}

interface AjvErrorLike {
  readonly instancePath: string;
  readonly keyword: string;
  readonly params: { readonly missingProperty?: string };
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function toIssues(errors: readonly AjvErrorLike[] | null | undefined): ContractIssue[] {
  if (errors === null || errors === undefined || errors.length === 0) return [{ path: '', code: 'SCHEMA' }];
  return errors.map((error) => {
    // A missing property name comes from the schema, not the input, so it is safe to report.
    if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
      return { path: `${error.instancePath}/${escapePointer(error.params.missingProperty)}`, code: 'required' };
    }
    return { path: error.instancePath, code: error.keyword };
  });
}

export interface ContractDefinition<T> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema<T>;
  readonly refine?: Refinement<T>;
}

export function defineContract<T>(definition: ContractDefinition<T>): Contract<T> {
  let compiled: ValidateFunction | undefined;
  const compile = (): ValidateFunction => {
    if (compiled === undefined) compiled = contractAjv().compile(jsonSchemaOf(definition.schema));
    return compiled;
  };
  const validate = (value: unknown): ValidationResult<T> => {
    const jsonProblem = jsonIssue(value);
    if (jsonProblem !== null) return { ok: false, issues: [jsonProblem] };
    const check = compile();
    if (check(value) !== true) return { ok: false, issues: toIssues(check.errors as readonly AjvErrorLike[] | null) };
    const issues: ContractIssue[] = [];
    definition.refine?.(value as T, (path, code) => issues.push({ path, code }));
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: frozenCopy(value as T) };
  };
  return Object.freeze({
    name: definition.name,
    version: CONTRACT_SCHEMA_VERSION,
    description: definition.description,
    schema: definition.schema,
    validate,
    is: (value: unknown): value is T => validate(value).ok,
    assert: (value: unknown): T => {
      const result = validate(value);
      if (!result.ok) throw new ContractError(definition.name, result.issues);
      return result.value;
    },
    parse: (input: Uint8Array | string, maxBytes = DEFAULT_MAX_JSON_BYTES): ValidationResult<T> => {
      const parsed = parseJson(input, maxBytes);
      if (!parsed.ok) return parsed;
      return validate(parsed.value);
    },
  });
}
