import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as F from './fixtures.mjs';

const c = await import('../dist/index.js');
const script = await import('../scripts/generate-schemas.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'scripts', 'generate-schemas.mjs');
const committedDir = join(here, '..', 'schemas');

const REQUIRED = [
  'Mode',
  'Authority',
  'Risk',
  'Json',
  'EvidenceRef',
  'EventEnvelope',
  'Action',
  'ActionIntent',
  'Capability',
  'SessionSnapshot',
  'DecisionSpec',
  'DecisionResult',
  'ModelRegistryEntry',
  'TaskNode',
  'AgentLease',
  'BudgetReservation',
  'VerificationReceipt',
  'MemoryCapsule',
  'AuthorizationReceipt',
  'ActionReceipt',
  'CalibrationArtifact',
  'CertificationRecord',
  'JevrisConfig',
  'PackManifest',
  'JevRequest',
];

function freshAjv() {
  const ajv = new Ajv2020({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
  ajv.addFormat('date-time', { type: 'string', validate: (value) => c.isTimestamp(value) });
  return ajv;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jevris-schemas-'));
}

test('every chapter 6, calibration, certification and SSOT boundary contract has a committed schema (CTR-02)', () => {
  const files = readdirSync(committedDir).filter((name) => name.endsWith('.schema.json'));
  for (const name of REQUIRED) {
    assert.ok(c.CONTRACTS.has(name), name);
    assert.ok(files.includes(`${c.schemaFileStem(name)}.schema.json`), name);
  }
  assert.equal(files.length, c.CONTRACTS.size);
  assert.equal(c.schemaFileStem('EventEnvelope'), 'event-envelope');
  assert.equal(c.schemaFileStem('JevRequest'), 'jev-request');
});

test('the committed schemas equal the schemas generated from the contracts: drift check (CTR-02)', async () => {
  const result = await script.checkSchemas(committedDir);
  assert.deepEqual(result, { ok: true, changed: [], missing: [], extra: [] });
  const run = spawnSync(process.execPath, [scriptPath, '--check'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
});

test('generation is deterministic and each document is standalone JSON Schema 2020-12', () => {
  const first = c.schemaDocuments();
  const second = c.schemaDocuments();
  assert.deepEqual([...first.entries()], [...second.entries()]);
  for (const [file, text] of first) {
    assert.equal(text.endsWith('}\n'), true, file);
    assert.equal(text.includes('\r'), false, file);
    const document = JSON.parse(text);
    assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(document.$id, /^urn:jevris:contract:[a-z-]+:1\.0$/);
    assert.equal(typeof document.title, 'string');
    assert.equal(typeof document.description, 'string');
  }
});

test('the drift check fails on an edited, a missing and an extra schema file, and names it (CTR-02)', async () => {
  const dir = tempDir();
  try {
    await script.writeSchemas(dir);
    assert.equal((await script.checkSchemas(dir)).ok, true);

    const edited = join(dir, 'action.schema.json');
    const original = readFileSync(edited, 'utf8');
    writeFileSync(edited, original.replace('"advise"', '"advise-anything"'));
    assert.deepEqual((await script.checkSchemas(dir)).changed, ['action.schema.json']);
    const run = spawnSync(process.execPath, [scriptPath, '--check', '--dir', dir], { encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /schema drift: action\.schema\.json differs/);

    // CRLF checkouts are not drift.
    writeFileSync(edited, original.replace(/\n/g, '\r\n'));
    assert.equal((await script.checkSchemas(dir)).ok, true);

    unlinkSync(join(dir, 'task-node.schema.json'));
    writeFileSync(join(dir, 'stale.schema.json'), '{}\n');
    const drift = await script.checkSchemas(dir);
    assert.deepEqual(drift.missing, ['task-node.schema.json']);
    assert.deepEqual(drift.extra, ['stale.schema.json']);
    const missingRun = spawnSync(process.execPath, [scriptPath, '--check', '--dir', dir], { encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(missingRun.status, 1);
    assert.match(missingRun.stderr, /task-node\.schema\.json is missing/);
    assert.match(missingRun.stderr, /stale\.schema\.json has no contract/);

    const regenerate = spawnSync(process.execPath, [scriptPath, '--dir', dir], { encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(regenerate.status, 0, regenerate.stderr);
    assert.equal((await script.checkSchemas(dir)).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each committed schema compiles in strict Ajv2020 on its own and agrees with its contract on fixtures', () => {
  const ajv = freshAjv();
  for (const [name, contract] of c.CONTRACTS) {
    const document = JSON.parse(readFileSync(join(committedDir, `${c.schemaFileStem(name)}.schema.json`), 'utf8'));
    const validate = ajv.compile(document);
    const make = F.VALID[name];
    if (make === undefined) continue;
    const value = make();
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(contract.validate(value).ok, true, name);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && name !== 'Json') {
      assert.equal(validate({ ...value, hostileExtra: true }), false, `${name} extra`);
    }
  }
});

test('the committed Action schema alone rejects shell text, URLs and keys (CTR-02, CTR-04)', () => {
  const validate = freshAjv().compile(JSON.parse(readFileSync(join(committedDir, 'action.schema.json'), 'utf8')));
  const key = ['sk', 'ant', 'api03', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'].join('-');
  for (const bad of ['rm -rf /', 'https://evil.example', key, 'AKIAIOSFODNN7EXAMPLE']) {
    assert.equal(validate({ kind: 'select-evidence', evidenceIds: [bad] }), false, bad);
  }
  assert.equal(validate({ kind: 'abstain', reasonCode: 'AKIAIOSFODNN7EXAMPLE' }), false);
  assert.equal(validate({ kind: 'advise', templateId: 't', evidenceIds: [], permissionDecision: 'allow' }), false);
});
