import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKFLOW_IDS, readRecords, storyIds, storyPayload, workflowPayload } from '../scripts/acceptance-report.mjs';
import { thenClauses } from './acceptance/lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const libUrl = pathToFileURL(join(root, 'test', 'acceptance', 'lib.mjs')).href;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-accept-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function runFile(file, out) {
  // A child `node --test` that inherits NODE_TEST_CONTEXT reports to this runner instead of
  // exiting with its own status.
  const env = { ...process.env, JEVRIS_ACCEPTANCE_OUT: out };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', file], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
}

test('Then clauses come from fixtures/ssot/user-stories.json, split at semicolons (RLS-02)', () => {
  assert.equal(storyIds().length, 40);
  assert.deepEqual(thenClauses('US01'), ['Only Jevris-owned entries change', 'a concurrent user edit is preserved and data deletion is a separate choice']);
  assert.equal(thenClauses('US40').length, 1);
  assert.throws(() => thenClauses('US41'), /unknown story/);
});

test('a story passes only when every clause is asserted and holds; the record says which failed (RLS-02)', (t) => {
  const dir = scratch(t);
  const out = join(dir, 'records');
  const file = join(dir, 'us01.test.mjs');
  writeFileSync(
    file,
    [
      `import assert from 'node:assert/strict';`,
      `import { story } from ${JSON.stringify(libUrl)};`,
      `story('US01', async ({ then }) => {`,
      `  await then('Only Jevris-owned entries change', () => assert.equal(1, 1));`,
      `  await then('a concurrent user edit is preserved and data deletion is a separate choice', () => assert.equal(1, 2));`,
      `});`,
    ].join('\n'),
  );
  const run = runFile(file, out);
  assert.notEqual(run.status, 0, 'a failed clause fails the test');
  const record = readRecords(out).get('US01');
  assert.equal(record.passed, false);
  assert.equal(record.thenClauses, 2);
  assert.match(record.failures[0], /^a concurrent user edit is preserved/);

  writeFileSync(file, [`import { story } from ${JSON.stringify(libUrl)};`, `story('US01', async ({ then }) => {`, `  await then('Only Jevris-owned entries change', () => {});`, `});`].join('\n'));
  assert.notEqual(runFile(file, out).status, 0, 'an unasserted clause fails the test');
  assert.deepEqual(readRecords(out).get('US01').failures, ['a concurrent user edit is preserved and data deletion is a separate choice: not asserted']);
});

test('pending entries and missing files are failed rows; the payloads are valid release evidence (RLS-02, RLS-03)', async (t) => {
  const dir = scratch(t);
  const out = join(dir, 'records');
  const file = join(dir, 'us02.test.mjs');
  writeFileSync(file, `import { pending } from ${JSON.stringify(libUrl)};\npending('US02', 'domain B: egress story');\npending('W03', 'domain D: compaction workflow');\n`);
  const run = runFile(file, out);
  assert.equal(run.status, 0, 'a pending entry is not a failing or skipped test');
  assert.doesNotMatch(run.stdout, /# skipped [1-9]/);
  const records = readRecords(out);
  const stories = storyPayload(records, storyIds());
  assert.equal(stories.stories.length, 40);
  assert.deepEqual(stories.stories.find((row) => row.id === 'US02'), { id: 'US02', passed: false, thenClauses: 2, failures: ['pending: blocked on domain B: egress story'] });
  assert.deepEqual(stories.stories.find((row) => row.id === 'US03'), { id: 'US03', passed: false, thenClauses: 0, failures: ['no acceptance test'] });
  const flows = workflowPayload(new Map([['W01', { passed: true, evidence: [`sha256:${'a'.repeat(64)}`, 'not-a-hash'] }], ...records]));
  assert.equal(flows.workflows.length, WORKFLOW_IDS.length);
  assert.deepEqual(flows.workflows[0], { id: 'W01', passed: true, evidence: [`sha256:${'a'.repeat(64)}`] });
  assert.equal(flows.workflows.find((row) => row.id === 'W03').passed, false);

  const contracts = await import(pathToFileURL(join(root, 'packages', 'contracts', 'dist', 'index.js')).href);
  for (const [kind, payload] of [['story-report', stories], ['workflow-report', flows]]) {
    const record = contracts.releaseEvidence({ kind, id: `${kind}-test`, producedAt: '2026-09-25T00:00:00Z', version: '1.2.0', commit: 'a'.repeat(40), tool: 'test', os: 'linux', payload });
    assert.equal(contracts.ReleaseEvidenceContract.validate(record).ok, true, kind);
  }
});

test('the runtime-gate report records each named test as this run reported it; a failed, skipped, todo or missing one is not a pass (RLS-08, RLS-09)', async (t) => {
  const dir = scratch(t);
  const { eventArgs, EVENTS_REPORTER_URL } = await import('../scripts/test.mjs');
  const { runtimeGatePayload } = await import('../scripts/acceptance-report.mjs');
  const events = join(dir, 'events.jsonl');
  assert.deepEqual(eventArgs({}), []);
  assert.deepEqual(eventArgs({ JEVRIS_TEST_EVENTS: events }), ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${EVENTS_REPORTER_URL}`, `--test-reporter-destination=${events}`]);
  // With coverage on, spec is already on stdout once.
  assert.deepEqual(eventArgs({ JEVRIS_TEST_EVENTS: events }, ['--test-reporter=spec', '--test-reporter-destination=stdout']), [`--test-reporter=${EVENTS_REPORTER_URL}`, `--test-reporter-destination=${events}`]);

  const file = join(dir, 'gate.test.mjs');
  writeFileSync(file, [
    "import test from 'node:test';",
    "test('passes', () => {});",
    "test('fails', () => { throw new Error('no'); });",
    "test('skipped', { skip: 'not here' }, () => {});",
    "test('todo', { todo: true }, () => {});",
    "test('parent', async (t) => { await t.test('child passes', () => {}); });",
    '',
  ].join('\n'));
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  spawnSync(process.execPath, ['--test', ...eventArgs({ JEVRIS_TEST_EVENTS: events }), file], { encoding: 'utf8', env });
  const rows = (await import('node:fs')).readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(byName).sort(), ['child passes', 'fails', 'parent', 'passes', 'skipped', 'todo']);
  assert.deepEqual([byName.passes.passed, byName.fails.passed, byName.skipped.passed, byName.todo.passed, byName['child passes'].passed], [true, false, false, false, true]);
  assert.equal(byName.skipped.skipped, true);

  const rel = (name) => ({ gate: 'quality', check: 'quality.learning-gate', file: `x/${name}.test.mjs`, name });
  const required = [
    { ...rel('passes'), file: 'fixture/gate.test.mjs' },
    { ...rel('fails'), file: 'fixture/gate.test.mjs' },
    { ...rel('skipped'), file: 'fixture/gate.test.mjs' },
    { ...rel('never ran'), file: 'fixture/gate.test.mjs' },
    { ...rel('passes'), file: 'fixture/other.test.mjs' },
  ];
  const payload = runtimeGatePayload(rows.map((row) => ({ ...row, file: pathToFileURL(join(dir, 'fixture', 'gate.test.mjs')).href })), required, dir);
  assert.deepEqual(payload.tests.map((row) => [row.file, row.name, row.passed]), [
    ['fixture/gate.test.mjs', 'passes', true],
    ['fixture/gate.test.mjs', 'fails', false],
    ['fixture/gate.test.mjs', 'skipped', false],
    ['fixture/gate.test.mjs', 'never ran', false],
    ['fixture/other.test.mjs', 'passes', false],
  ]);
  assert.deepEqual(Object.keys(payload.tests[0]).sort(), ['file', 'gate', 'name', 'passed']);
});
