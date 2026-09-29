import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { load, story } from './lib.mjs';
import { startJevStub } from './jev-stub.mjs';
import { ownedWorkers, submit, taskNode, taskReader } from './owned.mjs';

// Two ready tasks touch disjoint packages but both update the shared lockfile. Jev is reachable
// and egress is approved, so a semantic answer could be asked for; the resource lock is still
// the scheduler's deterministic rule. The workers are D's scripted worker port.
const HOST = {
  schemaVersion: '1.0',
  mode: 'bounded-auto',
  egress: 'approved-scoped',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};
const bare = ({ title, models, expectedOutputs, ...rest }) => rest;

story('US19', async ({ t, then, sandbox, evidence }) => {
  const jev = await startJevStub(t);
  const box = await sandbox({ env: jev.env });
  const { jevrisPaths } = await load('platform');
  box.write(join(relative(box.dir, jevrisPaths({ home: box.home }).config), 'host.json'), HOST);
  box.write('work/packages/a/index.mjs', 'export const a = 1;\n');
  box.write('work/packages/b/index.mjs', 'export const b = 1;\n');
  box.write('work/package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['REQ-1'], description: 'the package tests' }],
  });
  box.gitInit();
  await box.workerScript([
    { taskId: 'A', writes: [{ path: 'package-lock.json', text: '{"lockfileVersion":3,"packages":{"a":{}}}\n' }], status: 'completed', costUsd: 0.01 },
    { taskId: 'B', writes: [{ path: 'package-lock.json', text: '{"lockfileVersion":3,"packages":{"a":{},"b":{}}}\n' }], status: 'completed', costUsd: 0.01 },
  ]);
  await ownedWorkers(box);
  const racing = [taskNode('A', { writeScopes: ['packages/a', 'package-lock.json'] }), taskNode('B', { writeScopes: ['packages/b', 'package-lock.json'] })];
  const client = await box.mcp();
  const task = taskReader(client);

  await then('The lockfile conflict is serialized or isolated by a certified strategy', async () => {
    // Launched together, both workers would write the lockfile: the scheduler refuses it.
    const refused = box.jevris(['plan', '--submit', '--graph', box.write('racing.json', { tasks: racing }), '--budget', 'racing', '--limit-micro-usd', '5000000', '--authorization', box.authorizeBudget('racing'), '--yes'], { json: true });
    evidence(refused.json);
    assert.equal(refused.code, 1);
    assert.deepEqual([refused.json.accepted, refused.json.reasonCode], [false, 'PLAN_INVALID']);
    assert.deepEqual(refused.json.issues.map((issue) => issue.code), ['WRITE_OVERLAP']);
    assert.deepEqual(refused.json.leaseIds, []);
    // Serialized: B after A. Only A runs; B is leased once A is verified.
    const serialized = submit(box, [racing[0], { ...racing[1], dependencyIds: ['A'] }], { leased: 1 });
    evidence(serialized);
    assert.deepEqual(serialized.waves, [['A'], ['B']]);
    assert.equal((await task('A', 'awaiting-evidence'))?.task?.state, 'awaiting-evidence');
    const waiting = await task('B');
    assert.equal(waiting.task.state, 'validated', 'B ran while A held the lockfile');
    assert.equal(waiting.worker, null);
    assert.equal(box.jevris(['verify', '--task', 'A'], { json: true }).code, 0, 'verify --task A failed');
    const b = await task('B', 'awaiting-evidence');
    evidence(b);
    assert.equal(b.task.state, 'awaiting-evidence', `B is ${b.task.state} after A was verified`);
  });

  await then('declared resource locks cannot be waived by Jev', async () => {
    // The model-facing plan tool gives the same deterministic answer and takes no waiver.
    const checked = await client.callTool({ name: 'jevris_plan', arguments: { tasks: racing.map(bare) } });
    evidence(checked.structuredContent);
    assert.equal(checked.structuredContent.result.valid, false);
    assert.deepEqual(checked.structuredContent.result.issues.map((issue) => issue.code), ['WRITE_OVERLAP', 'WRITE_OVERLAP']);
    const waiver = await client.callTool({ name: 'jevris_plan', arguments: { tasks: racing.map(bare), waive: ['WRITE_OVERLAP'] } });
    assert.equal(waiver.isError, true);
    assert.match(waiver.content[0].text, /Unknown argument "waive"/);
    // Jev was reachable throughout and was never asked about the lock.
    const asked = jev.requests().filter((request) => request.body.includes('package-lock.json'));
    assert.deepEqual(asked, [], 'the lockfile decision went to Jev');
  });
});
