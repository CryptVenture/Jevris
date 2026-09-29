import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const c = await import('../dist/index.js');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const examplesDir = join(root, 'fixtures', 'ssot', 'examples');
const committedDir = join(here, '..', 'schemas');

/** Every SSOT example and the contract it round-trips through. */
const EXAMPLES = {
  'jevris.config.json': { contract: 'JevrisConfig', ssotSchema: 'jevris-config.schema.json' },
  'routing.pack.json': { contract: 'PackManifest', ssotSchema: 'pack-manifest.schema.json' },
  'jev-request.json': { contract: 'JevRequest', ssotSchema: null },
};

const bytes = (path) => new Uint8Array(readFileSync(path));
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

test('every fixtures/ssot/examples fixture has a contract (CTR-02)', () => {
  const files = readdirSync(examplesDir).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, Object.keys(EXAMPLES).sort());
});

test('every fixtures/ssot/examples fixture round-trips through its contract (CTR-02)', () => {
  for (const [file, { contract: name }] of Object.entries(EXAMPLES)) {
    const contract = c.CONTRACTS.get(name);
    const raw = bytes(join(examplesDir, file));
    const original = JSON.parse(new TextDecoder().decode(raw));
    const parsed = contract.parse(raw);
    assert.equal(parsed.ok, true, `${file}: ${JSON.stringify(parsed.issues)}`);
    assert.deepEqual(parsed.value, original, file);
    // parse -> validate -> canonical serialise -> parse -> validate gives the same value and bytes.
    const canonical = c.canonicalJson(parsed.value);
    const again = contract.parse(canonical);
    assert.equal(again.ok, true, file);
    assert.deepEqual(again.value, original, file);
    assert.equal(c.canonicalJson(again.value), canonical, file);
    assert.equal(c.contentHash(again.value), c.contentHash(original), file);
  }
});

test('the committed generated schema validates each example on its own (CTR-02)', () => {
  for (const [file, { contract: name }] of Object.entries(EXAMPLES)) {
    const schema = bytes(join(committedDir, `${c.schemaFileStem(name)}.schema.json`));
    assert.deepEqual(c.roundTripCheckedSchema(schema, bytes(join(examplesDir, file))), { valid: true }, file);
  }
});

function configMutations() {
  const base = () => JSON.parse(readFileSync(join(examplesDir, 'jevris.config.json'), 'utf8'));
  const out = [];
  const add = (label, mutate) => {
    const value = base();
    mutate(value);
    out.push([label, value]);
  };
  for (const key of Object.keys(base())) add(`drop ${key}`, (v) => delete v[key]);
  add('extra', (v) => (v.extra = true));
  add('schemaVersion', (v) => (v.schemaVersion = '2.0'));
  add('mode', (v) => (v.mode = 'auto'));
  add('provider kind', (v) => (v.provider.kind = 'gateway'));
  add('model latest', (v) => (v.provider.model = 'jev-latest'));
  add('raw credential', (v) => (v.provider.credentialRef = 'sk-live-abc'));
  add('provider extra', (v) => (v.provider.apiKey = 'x'));
  add('uncalibrated actuation', (v) => (v.decisions.allowUncalibratedActuation = true));
  add('hot path zero', (v) => (v.decisions.hotPathDeadlineMs = 0));
  add('max questions 13', (v) => (v.decisions.maxQuestions = 13));
  add('request bytes fraction', (v) => (v.decisions.maxRequestBytes = 2048.5));
  add('egress open', (v) => (v.privacy.sourceEgress = 'allow'));
  add('retention high', (v) => (v.privacy.rawArtifactRetentionDays = 366));
  add('ignore pins', (v) => (v.routing.respectHumanPins = false));
  add('calibration path', (v) => (v.routing.calibrationArtifact = 'calibration/task-profile.json'));
  add('calibration long', (v) => (v.routing.calibrationArtifact = 'x'.repeat(257)));
  add('workers 33', (v) => (v.orchestration.maxConcurrentWorkers = 33));
  add('continuations 2', (v) => (v.orchestration.maxStopContinuationsPerCondition = 2));
  add('transcript editing', (v) => (v.compaction.rawTranscriptEditing = true));
  add('duplicate packs', (v) => v.packs.push(v.packs[0]));
  add('empty pack', (v) => v.packs.push(''));
  add('no packs', (v) => (v.packs = []));
  add('enabled string', (v) => (v.orchestration.enabled = 'true'));
  return out;
}

function packMutations() {
  const base = () => JSON.parse(readFileSync(join(examplesDir, 'routing.pack.json'), 'utf8'));
  const out = [];
  const add = (label, mutate) => {
    const value = base();
    mutate(value);
    out.push([label, value]);
  };
  for (const key of Object.keys(base())) add(`drop ${key}`, (v) => delete v[key]);
  add('extra', (v) => (v.extra = true));
  add('id prefix', (v) => (v.id = 'routing'));
  add('id upper', (v) => (v.id = 'jevris.Routing'));
  add('version', (v) => (v.version = 'v1'));
  add('maturity', (v) => (v.maturity = 'beta'));
  add('description empty', (v) => (v.description = ''));
  add('unknown action', (v) => v.actions.push('run-shell'));
  add('duplicate action', (v) => v.actions.push('advise'));
  add('unknown scope', (v) => v.dataScopes.push('full-repository'));
  add('default mode', (v) => (v.defaultMode = 'auto'));
  add('fixture long', (v) => v.fixtures.push('x'.repeat(257)));
  add('all actions', (v) => (v.actions = [...c.ACTION_KINDS]));
  return out;
}

test('the contracts and the SSOT reference schemas agree on the examples and a mutation set (CTR-02)', () => {
  const cases = [
    ['JevrisConfig', 'jevris-config.schema.json', configMutations()],
    ['PackManifest', 'pack-manifest.schema.json', packMutations()],
  ];
  for (const [name, ssotSchema, mutations] of cases) {
    const schemaBytes = bytes(join(root, 'fixtures', 'ssot', 'schemas', ssotSchema));
    let rejected = 0;
    for (const [label, value] of mutations) {
      const ssot = c.roundTripCheckedSchema(schemaBytes, encode(value)).valid;
      const ours = c.CONTRACTS.get(name).validate(value).ok;
      assert.equal(ours, ssot, `${name} ${label}: contract ${ours}, SSOT ${ssot}`);
      if (!ssot) rejected += 1;
    }
    assert.ok(rejected >= mutations.length - 4, `${name}: most mutations must be rejections`);
  }
});

test('JevRequest agrees with the reference native client validator; secrets are refused in addition', async () => {
  const { validateRequest } = await import(pathToFileURL(join(root, 'fixtures', 'ssot', 'reference', 'dist', 'jev-client.js')).href);
  const reference = (value) => {
    try {
      validateRequest(value);
      return true;
    } catch {
      return false;
    }
  };
  const base = () => JSON.parse(readFileSync(join(examplesDir, 'jev-request.json'), 'utf8'));
  const cases = [];
  const add = (label, mutate) => {
    const value = base();
    mutate(value);
    cases.push([label, value]);
  };
  add('as is', () => {});
  add('extra', (v) => (v.extra = 1));
  add('model', (v) => (v.model = 'jev-latest'));
  add('state string', (v) => (v.state = 'A test failed.'));
  add('state array', (v) => (v.state = [1, 'two']));
  add('state number', (v) => (v.state = 7));
  add('state null', (v) => (v.state = null));
  add('no questions', (v) => (v.questions = {}));
  add('13 questions', (v) => {
    for (let i = 0; i < 12; i += 1) v.questions[`q${i}`] = { type: 'noul', instructions: 'Is it?' };
  });
  add('12 questions', (v) => {
    for (let i = 0; i < 10; i += 1) v.questions[`q${i}`] = { type: 'noul', instructions: 'Is it?' };
  });
  add('bad question id', (v) => (v.questions['1bad'] = { type: 'noul', instructions: 'Is it?' }));
  add('hyphen question id', (v) => (v.questions['has-hyphen'] = { type: 'noul', instructions: 'Is it?' }));
  add('unknown type', (v) => (v.questions.taskFamily.type = 'boolean'));
  add('blank instructions', (v) => (v.questions.taskFamily.instructions = '   '));
  add('one option', (v) => (v.questions.taskFamily.criteria = { only: 'x' }));
  add('bad option key', (v) => (v.questions.taskFamily.criteria['9lives'] = 'x'));
  add('question extra', (v) => (v.questions.taskFamily.extra = 1));
  add('score one level', (v) => (v.questions.s = { type: 'score', instructions: 'How?', criteria: ['a'] }));
  add('score eleven levels', (v) => (v.questions.s = { type: 'score', instructions: 'How?', criteria: Array(11).fill('a') }));
  add('score ok', (v) => (v.questions.s = { type: 'score', instructions: 'How?', criteria: ['a', 'b', 'c'] }));
  add('noul criteria', (v) => (v.questions.compatibilityEvidenceMissing.criteria = { true: 'Yes.', false: 'No.' }));
  add('noul criteria extra', (v) => (v.questions.compatibilityEvidenceMissing.criteria = { true: 'Y', false: 'N', maybe: 'M' }));
  add('long instructions', (v) => (v.questions.taskFamily.instructions = 'x'.repeat(8193)));
  for (const [label, value] of cases) {
    assert.equal(c.JevRequestContract.validate(value).ok, reference(value), label);
  }
  const key = ['sk', 'ant', 'api03', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'].join('-');
  const secret = base();
  secret.questions.taskFamily.instructions = `Use ${key} to decide.`;
  assert.equal(reference(secret), true, 'the reference client does not screen secrets');
  assert.equal(c.JevRequestContract.validate(secret).ok, false, 'the contract refuses a key in question text');
});
