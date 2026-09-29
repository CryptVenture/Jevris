/**
 * A JSON-Schema-native contract builder. Each builder returns a plain JSON Schema 2020-12
 * object that also carries a phantom static type, so one definition yields the TypeScript
 * type (`Static<typeof S>`), the Ajv validator and the generated JSON Schema file.
 * The phantom property exists only in the type system; the runtime object is pure JSON.
 */

declare const STATIC: unique symbol;

export interface TSchema<T = unknown> {
  readonly [STATIC]: T;
}

export type Static<S> = S extends TSchema<infer T> ? T : never;

export type JsonSchemaObject = { readonly [key: string]: unknown };

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type SchemaMap = { readonly [key: string]: TSchema };

type ObjectStatic<R extends SchemaMap, O extends SchemaMap> = Simplify<
  { readonly [K in keyof R]: Static<R[K]> } & { readonly [K in keyof O]?: Static<O[K]> }
>;

function make<T>(schema: JsonSchemaObject): TSchema<T> {
  return deepFreeze(schema) as unknown as TSchema<T>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** The plain JSON Schema object behind a builder schema. */
export function jsonSchemaOf(schema: TSchema): JsonSchemaObject {
  return schema as unknown as JsonSchemaObject;
}

export interface StringOptions {
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly format?: 'date-time';
  /** Unanchored patterns the value must NOT match (secrets, URLs). */
  readonly notPatterns?: readonly string[];
  readonly description?: string;
}

export function string(options: StringOptions = {}): TSchema<string> {
  const schema: Record<string, unknown> = { type: 'string' };
  if (options.description !== undefined) schema['description'] = options.description;
  if (options.minLength !== undefined) schema['minLength'] = options.minLength;
  if (options.maxLength !== undefined) schema['maxLength'] = options.maxLength;
  if (options.pattern !== undefined) schema['pattern'] = options.pattern;
  if (options.format !== undefined) schema['format'] = options.format;
  const not = options.notPatterns ?? [];
  if (not.length === 1) schema['not'] = { pattern: not[0] };
  if (not.length > 1) schema['not'] = { anyOf: not.map((pattern) => ({ pattern })) };
  return make<string>(schema);
}

export interface NumberOptions {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly description?: string;
}

function numeric(type: 'number' | 'integer', options: NumberOptions): JsonSchemaObject {
  const schema: Record<string, unknown> = { type };
  if (options.description !== undefined) schema['description'] = options.description;
  if (options.minimum !== undefined) schema['minimum'] = options.minimum;
  if (options.exclusiveMinimum !== undefined) schema['exclusiveMinimum'] = options.exclusiveMinimum;
  if (options.maximum !== undefined) schema['maximum'] = options.maximum;
  return schema;
}

export function number(options: NumberOptions = {}): TSchema<number> {
  return make<number>(numeric('number', options));
}

export function integer(options: NumberOptions = {}): TSchema<number> {
  return make<number>(numeric('integer', options));
}

export function boolean(): TSchema<boolean> {
  return make<boolean>({ type: 'boolean' });
}

export function literal<const V extends string | number | boolean>(value: V): TSchema<V> {
  return make<V>({ const: value });
}

export function enumOf<const V extends readonly string[]>(values: V): TSchema<V[number]> {
  return make<V[number]>({ type: 'string', enum: [...values] });
}

export interface ArrayOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export function array<S extends TSchema>(items: S, options: ArrayOptions = {}): TSchema<readonly Static<S>[]> {
  const schema: Record<string, unknown> = { type: 'array', items };
  if (options.minItems !== undefined) schema['minItems'] = options.minItems;
  schema['maxItems'] = options.maxItems ?? 1024;
  if (options.uniqueItems === true) schema['uniqueItems'] = true;
  return make<readonly Static<S>[]>(schema);
}

export interface ObjectOptions {
  readonly description?: string;
  readonly title?: string;
}

export function object<R extends SchemaMap, O extends SchemaMap = {}>(
  required: R,
  optional?: O,
  options: ObjectOptions = {},
): TSchema<ObjectStatic<R, O>> {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(required)) properties[key] = required[key];
  if (optional !== undefined) {
    for (const key of Object.keys(optional)) {
      if (key in properties) throw new Error(`duplicate property ${key}`);
      properties[key] = optional[key];
    }
  }
  const schema: Record<string, unknown> = {};
  if (options.title !== undefined) schema['title'] = options.title;
  if (options.description !== undefined) schema['description'] = options.description;
  schema['type'] = 'object';
  schema['properties'] = properties;
  schema['required'] = Object.keys(required);
  schema['additionalProperties'] = false;
  return make<ObjectStatic<R, O>>(schema);
}

export interface RecordOptions {
  readonly keyPattern: string;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

export function record<S extends TSchema>(
  values: S,
  options: RecordOptions,
): TSchema<{ readonly [key: string]: Static<S> }> {
  const schema: Record<string, unknown> = {
    type: 'object',
    propertyNames: { pattern: options.keyPattern },
    additionalProperties: values,
  };
  if (options.minProperties !== undefined) schema['minProperties'] = options.minProperties;
  schema['maxProperties'] = options.maxProperties ?? 256;
  return make<{ readonly [key: string]: Static<S> }>(schema);
}

export function union<const S extends readonly TSchema[]>(schemas: S): TSchema<Static<S[number]>> {
  return make<Static<S[number]>>({ oneOf: [...schemas] });
}

/**
 * A union of closed object schemas discriminated by a `const` property. Encoded as an if/then
 * chain so a failure reports the matching branch's precise error rather than every branch's.
 */
export function discriminatedUnion<const S extends readonly TSchema[]>(key: string, schemas: S): TSchema<Static<S[number]>> {
  const values: string[] = [];
  const branches = schemas.map((schema) => {
    const plain = jsonSchemaOf(schema) as { properties?: Record<string, { const?: unknown }> };
    const tag = plain.properties?.[key]?.const;
    if (typeof tag !== 'string' || values.includes(tag)) throw new Error(`discriminatedUnion: bad or duplicate ${key}`);
    values.push(tag);
    return { if: { properties: { [key]: { const: tag } } }, then: schema };
  });
  return make<Static<S[number]>>({
    type: 'object',
    required: [key],
    properties: { [key]: { type: 'string', enum: values } },
    allOf: branches,
  });
}

export function nullable<S extends TSchema>(schema: S): TSchema<Static<S> | null> {
  return make<Static<S> | null>({ anyOf: [schema, { type: 'null' }] });
}

/** Any JSON value. The JSON-value gate in contract.ts enforces plain JSON. */
export function json<T>(description: string): TSchema<T> {
  return make<T>({ description });
}

/** A literal JSON Schema for a shape the builder does not model. The caller states its static type. */
export function custom<T>(schema: JsonSchemaObject): TSchema<T> {
  return make<T>(JSON.parse(JSON.stringify(schema)) as JsonSchemaObject);
}

/** Adds a JSON Schema if/then clause to an object schema (for example actuate requires certified). */
export function withCondition<S extends TSchema>(schema: S, condition: JsonSchemaObject): S {
  const base = jsonSchemaOf(schema);
  const existing = Array.isArray(base['allOf']) ? (base['allOf'] as unknown[]) : [];
  return make({ ...base, allOf: [...existing, condition] }) as unknown as S;
}
