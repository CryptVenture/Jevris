import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


// C33 / SKIL-01: the skill-advice pack is data. Ranking does not execute a skill.
// R07: no unknown skill is executed. This test does not spawn a process.
const { runDoctor } = await import('../dist/doctor.js');

const PACK_KEYS = [
  'schemaVersion',
  'id',
  'version',
  'maturity',
  'description',
  'requiresCapabilities',
  'fallbackCapabilities',
  'decisionSpecs',
  'actions',
  'dataScopes',
  'defaultMode',
  'conflicts',
  'fixtures',
];

test('jevris.skill-advice is advice data and is not executed', async () => {
  const packPath = join(import.meta.dirname, '../../../packs/skill-advice/pack.json');
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const before = JSON.stringify(pack);
  assert.deepEqual(Object.keys(pack), PACK_KEYS);
  assert.equal(pack.schemaVersion, '1.0');
  assert.equal(pack.id, 'jevris.skill-advice');
  assert.equal(pack.version, '0.1.0');
  assert.equal(pack.maturity, 'experimental');
  assert.equal(pack.defaultMode, 'advise');
  assert.equal(
    pack.description,
    'Ranking does not execute a skill and does not upload a repository.',
  );
  assert.deepEqual(pack.requiresCapabilities, []);
  assert.deepEqual(pack.fallbackCapabilities, []);
  assert.deepEqual(pack.decisionSpecs, []);
  assert.deepEqual(pack.actions, ['advise', 'abstain']);
  assert.deepEqual(pack.dataScopes, ['task-metadata', 'approved-source-spans']);
  assert.deepEqual(pack.conflicts, []);
  assert.deepEqual(pack.fixtures, []);
  assert.equal(Object.hasOwn(pack, 'executor'), false);
  assert.equal(Object.hasOwn(pack, 'scripts'), false);
  assert.equal(Object.hasOwn(pack, 'command'), false);

  const report = await runDoctor({
    platform: 'darwin',
    nodeVersion: '24.18.1',
    versionProbe: () => '2.1.280',
    packs: [pack],
    certificationRecords: [],
    fixtureHashes: {},
  });
  assert.equal(JSON.stringify(pack), before);
  assert.equal(report.packs.length, 1);
  assert.equal(report.packs[0].id, 'jevris.skill-advice');
  assert.equal(report.packs[0].disposition, 'advice');
  assert.deepEqual(report.packs[0].missingCapabilities, []);
  assert.equal(JSON.stringify(report).includes('enforced'), false);
  assert.equal(JSON.stringify(report).includes('executor'), false);
});
