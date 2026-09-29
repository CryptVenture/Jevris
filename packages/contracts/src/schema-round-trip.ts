import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

const BYTE_CAP = 131_072;

export interface SchemaRoundTrip {
  readonly valid: boolean;
}

interface Utf8Decoder {
  decode(input?: Uint8Array): string;
}

function decodeUtf8(bytes: Uint8Array): string {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (label: string, options: { fatal: boolean }) => Utf8Decoder;
  }).TextDecoder;
  if (Ctor === undefined) throw new Error('BYTE_CAP');
  return new Ctor('utf-8', { fatal: true }).decode(bytes);
}

function isSchema(value: unknown): value is AnySchema {
  return value !== null && typeof value === 'object';
}

export function roundTripCheckedSchema(schemaBytes: Uint8Array, instanceBytes: Uint8Array): SchemaRoundTrip {
  if (schemaBytes.byteLength >= BYTE_CAP || instanceBytes.byteLength >= BYTE_CAP) {
    throw new Error('BYTE_CAP');
  }
  const schema: unknown = JSON.parse(decodeUtf8(schemaBytes));
  const instance: unknown = JSON.parse(decodeUtf8(instanceBytes));
  if (!isSchema(schema)) return { valid: false };
  const ajv = new Ajv2020({
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  const validate = ajv.compile(schema);
  return { valid: validate(instance) === true };
}
