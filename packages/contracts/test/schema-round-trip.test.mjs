import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


const { roundTripCheckedSchema } = await import('../dist/schema-round-trip.js');
const barrel = await import('../dist/index.js');

const BYTE_CAP = 131072;

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

function existsRoot(dir) {
  try {
    readFileSync(join(dir, 'fixtures', 'ssot', 'examples', 'jevris.config.json'));
    return true;
  } catch {
    return false;
  }
}

const root = repoRoot();

function bytesOf(relativePath) {
  return new Uint8Array(readFileSync(join(root, relativePath)));
}

function encode(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

const pairs = [
  {
    name: 'jevris-config',
    schema: 'fixtures/ssot/schemas/jevris-config.schema.json',
    example: 'fixtures/ssot/examples/jevris.config.json',
  },
  {
    name: 'pack-manifest',
    schema: 'fixtures/ssot/schemas/pack-manifest.schema.json',
    example: 'fixtures/ssot/examples/routing.pack.json',
  },
];

test('roundTripCheckedSchema is exported from the module and the barrel', () => {
  assert.equal(typeof roundTripCheckedSchema, 'function');
  assert.equal(barrel.roundTripCheckedSchema, roundTripCheckedSchema);
});

test('checked-in examples validate with Ajv2020 after the byte cap', () => {
  for (const pair of pairs) {
    const result = roundTripCheckedSchema(bytesOf(pair.schema), bytesOf(pair.example));
    assert.equal(result.valid, true, pair.name);
    assert.deepEqual(Object.keys(result).sort(), ['valid']);
  }
});

test('a wrong schemaVersion and an extra property fail without coercion or stripping', () => {
  for (const pair of pairs) {
    const schema = bytesOf(pair.schema);
    const example = JSON.parse(readFileSync(join(root, pair.example), 'utf8'));
    const wrong = structuredClone(example);
    wrong.schemaVersion = 'not-the-const';
    const wrongBytes = encode(wrong);
    const wrongBefore = new Uint8Array(wrongBytes);
    const wrongResult = roundTripCheckedSchema(schema, wrongBytes);
    assert.equal(wrongResult.valid, false, `${pair.name} schemaVersion`);
    assert.deepEqual(wrongBytes, wrongBefore);
    assert.equal(JSON.parse(new TextDecoder().decode(wrongBytes)).schemaVersion, 'not-the-const');

    const extra = structuredClone(example);
    extra.hostileExtra = 'CANARY_EXTRA_property';
    const extraBytes = encode(extra);
    const extraBefore = new Uint8Array(extraBytes);
    const extraResult = roundTripCheckedSchema(schema, extraBytes);
    assert.equal(extraResult.valid, false, `${pair.name} extra property`);
    assert.deepEqual(extraBytes, extraBefore);
    assert.equal(JSON.parse(new TextDecoder().decode(extraBytes)).hostileExtra, 'CANARY_EXTRA_property');
    assert.equal(JSON.stringify(extraResult).includes('CANARY_EXTRA_property'), false);
  }
});

test('either buffer at or above 131072 bytes is refused before JSON.parse', () => {
  const over = new Uint8Array(BYTE_CAP);
  over[0] = 0x7b;
  const tiny = encode({ schemaVersion: '1.0' });
  assert.throws(
    () => roundTripCheckedSchema(over, tiny),
    (error) => {
      assert.equal(error instanceof SyntaxError, false);
      assert.equal(String(error.message), 'BYTE_CAP');
      return true;
    },
  );
  assert.throws(
    () => roundTripCheckedSchema(tiny, over),
    (error) => {
      assert.equal(error instanceof SyntaxError, false);
      assert.equal(String(error.message), 'BYTE_CAP');
      return true;
    },
  );
  const under = new Uint8Array(BYTE_CAP - 1);
  under.fill(0x7b);
  assert.throws(
    () => roundTripCheckedSchema(under, tiny),
    (error) => error instanceof SyntaxError,
  );
});

test('the production module does not construct the default Ajv class', async () => {
  const source = readFileSync(new URL('../dist/schema-round-trip.js', import.meta.url), 'utf8');
  assert.equal(source.includes('ajv/dist/2020.js'), true);
  assert.equal(source.includes("from 'ajv'"), false);
  assert.equal(source.includes('from "ajv"'), false);
  assert.equal(source.includes('ssot_docs/reference'), false);
  const { default: Ajv } = await import('ajv');
  const schema = JSON.parse(readFileSync(join(root, pairs[0].schema), 'utf8'));
  assert.throws(() => new Ajv({ coerceTypes: false, removeAdditional: false, useDefaults: false }).compile(schema));
});
