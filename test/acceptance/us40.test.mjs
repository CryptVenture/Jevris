import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load, story } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';

const HOST = {
  schemaVersion: '1.0',
  mode: 'observe',
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

story('US40', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths } = await load('platform');
  const config = relative(box.dir, jevrisPaths({ home: box.home }).config);
  // Release N-1 ran with mode "observe"; release N moved to "bounded-auto". Each accepted load of
  // host.json is snapshotted by the product (policy check), so the previous one is kept.
  const policyCheck = () => box.jevris(['policy', 'check', '--would-send-source', '--home', box.home, '--workspace', box.work]);
  box.write(join(config, 'host.json'), HOST);
  policyCheck();
  const released = { ...HOST, mode: 'bounded-auto' };
  box.write(join(config, 'host.json'), released);
  policyCheck();
  const previous = box.read(join(config, 'policy-previous.json'));
  assert.equal(JSON.parse(previous).mode, 'observe', 'policy check did not keep the previous policy snapshot');
  assert.equal(JSON.parse(box.read(join(config, 'policy-active.json'))).mode, 'bounded-auto');

  // Release N runs owned workers: a real repository, an approved check, owned workers turned on
  // (bounded-auto is written into jevris.config.json, as docs/settings.md says) and a scripted
  // worker (the test worker port) that is still running when the canary fires.
  box.write('work/src/answer.js', 'export const answer = 41;\n');
  box.write('work/jevris.checks.json', { schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', description: 'unit tests' }] });
  box.gitInit();
  const go = join(box.dir, 'worker-may-finish');
  await box.workerScript([{ writes: [{ path: 'src/answer.js', text: 'export const answer = 42;\n' }], status: 'completed', costUsd: 0.02, reason: 'fixed the answer', waitForFile: go }]);
  await ownedWorkers(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');

  const before = box.jevris(['route'], { json: true });
  assert.equal(before.code, 0, `route failed before activation: ${before.stderr}`);
  assert.notEqual(before.json?.result?.worker?.reasonCode, 'KILL_SWITCH');
  const graph = box.write('work/plan.json', { tasks: [{ id: 'T1', schemaVersion: '1.0', workspaceId: 'w', revision: 'r1', state: 'proposed', title: 'Fix the answer', requirementIds: ['R1'], dependencyIds: [], writeScopes: ['src'], acceptanceCheckIds: ['unit'], expectedOutputs: ['patch'], models: ['claude-sonnet-4-5'], rootBudgetId: 'b1' }] });
  const submitted = box.jevris(['plan', '--submit', '--graph', graph, '--budget', 'b1', '--limit-micro-usd', '5000000', '--authorization', box.authorizeBudget('b1'), '--yes'], { json: true });
  assert.equal(submitted.code, 0, `plan --submit failed: ${submitted.stdout} ${submitted.stderr}`);
  assert.equal(submitted.json.leaseIds.length, 1, `no owned worker started: ${submitted.stdout}`);
  const [leaseId] = submitted.json.leaseIds;

  // A canary found a regression: the maintainer stops everything.
  const activate = box.jevris(['kill-switch', 'activate', '--reason', 'canary quality regression'], { json: true });
  assert.equal(activate.code, 0, `activate failed: ${activate.stdout} ${activate.stderr}`);
  evidence(activate.json);

  const client = await box.mcp();
  await then('New optimization actions stop, the previous compatible policy is restored, owned work is reconciled and an audit report is produced', async () => {
    const body = activate.json;
    assert.equal(body.stopped, true);
    assert.deepEqual(body.steps.map((step) => step.step), ['flag', 'policy', 'log', 'store']);
    for (const step of body.steps) assert.equal(step.ok, true, `step ${step.step} failed: ${step.detail ?? ''}`);
    const status = box.jevris(['kill-switch', 'status'], { json: true });
    assert.equal(status.json?.state, 'stopped');
    assert.equal(status.json.reason, 'canary quality regression');

    // New optimization actions stop: no managed-worker advice, and verification is refused.
    const route = box.jevris(['route'], { json: true });
    evidence(route.json);
    assert.equal(route.json?.result?.worker?.outcome, 'abstain');
    assert.equal(route.json.result.worker.reasonCode, 'KILL_SWITCH');
    assert.equal(route.json.result.applied, false);
    const verify = box.jevris(['verify'], { json: true });
    assert.equal(verify.json?.sidecar?.reasonCode, 'KILL_SWITCH', `verify was not stopped: ${verify.stdout.slice(0, 300)}`);

    // The previous compatible policy is restored byte for byte; host.json is untouched.
    assert.match(body.policyRestored, /^sha256:[a-f0-9]{16}$/);
    assert.match(body.steps[1].detail, /restored previous policy/);
    assert.equal(box.read(join(config, 'policy-active.json')), previous);
    assert.deepEqual(JSON.parse(box.read(join(config, 'host.json'))), released);

    // Owned work in flight is held for reconciliation, never repeated: the running worker's effect
    // is held, the worker's finished result leaves the task blocked, not done, and nothing reaches
    // the workspace. Reconciling it is a person's decision, refused while the switch is stopped.
    assert.match(body.steps[3].detail, /^1 pending effect\(s\) held for reconciliation; audit row \d+/);
    writeFileSync(go, '');
    let task;
    for (let i = 0; i < 100; i += 1) {
      const got = await client.callTool({ name: 'jevris_get_task', arguments: { taskId: 'T1' } });
      task = got.structuredContent?.result?.task;
      if (task?.state === 'blocked') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    evidence(task);
    assert.equal(task?.state, 'blocked', `the held worker's task is ${task?.state}`);
    assert.equal(box.read('work/src/answer.js'), 'export const answer = 41;\n', 'a held effect reached the workspace');
    const reconcile = box.jevris(['task', 'reconcile', 'T1', '--applied', '--yes'], { json: true });
    assert.equal(reconcile.code, 1);
    assert.equal(reconcile.json?.reasonCode, 'KILL_SWITCH', `reconcile while stopped: ${reconcile.stdout}`);

    // The audit report: an exported, verifiable row naming who, how, why, the restored policy and the held ids.
    const out = join(box.home, 'audit.jsonl');
    const exported = box.jevris(['audit', 'export', out]);
    assert.equal(exported.code, 0, `audit export failed: ${exported.stdout} ${exported.stderr}`);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    evidence(rows);
    const row = rows.find((item) => item.kind === 'kill-switch.activate');
    assert.notEqual(row, undefined, 'the audit log has no kill-switch.activate row');
    assert.equal(typeof row.actor, 'string');
    assert.equal(row.channel, 'cli');
    assert.equal(row.detail.reason, 'canary quality regression');
    assert.equal(row.detail.policyRestored, body.policyRestored);
    assert.deepEqual(row.detail.heldIds, [`op-${leaseId}`], 'the audit row does not name the held worker effect');
    assert.equal(row.detail.held, 1);
    assert.equal(box.jevris(['audit', 'verify']).code, 0, 'the audit chain does not verify');
  });
});
