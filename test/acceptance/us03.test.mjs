import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { calibratedRoute, SLICE } from './calibrated-route.mjs';
import { load, story } from './lib.mjs';
import { scanRead } from '../live-files.mjs';

// US03: observe mode with approved egress; `jevris route` evaluates a real route decision on a
// released calibration (synthetic, signed here and trusted only in this test home). Sonnet 5
// meets the floor at a lower cost than the Opus 5 session, so it is recommended, and the
// recommendation is recorded as a counterfactual with its policy version. Nothing changes: the
// session model, the harness settings, the workers and the budget stay as they were.

const HOST = {
  schemaVersion: '1.0',
  mode: 'observe',
  egress: 'approved-scoped',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

/** Every harness file under the home (settings, hooks, plugins), with its bytes. */
function harnessFiles(home) {
  const out = {};
  const walk = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(home, path)] = scanRead(path, 'utf8');
    }
  };
  for (const dir of ['.claude', '.codex', '.config/opencode', '.kilo', '.gemini']) walk(join(home, dir));
  return out;
}

story('US03', async ({ then, sandbox, evidence }) => {
  const { jevrisPaths } = await load('platform');
  const box = await sandbox();
  box.write(join(relative(box.dir, jevrisPaths({ home: box.home }).config), 'host.json'), HOST);
  const release = await calibratedRoute(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const before = box.jevris(['status'], { json: true });
  assert.equal(before.json.result.jevrisMode, 'observe');
  const harnessBefore = harnessFiles(box.home);

  // When: a route decision is evaluated, for a task on a calibrated slice, at a step boundary.
  const route = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, '--task', 'fix-parser', '--warm-prefix', '0'], { json: true });
  evidence(route.json);
  assert.equal(route.code, 0, `route failed: ${route.stdout} ${route.stderr}`);
  const advice = route.json.result;

  await then('The actual worker/model remains unchanged and the counterfactual recommendation is recorded with its policy version', () => {
    // The router's choice: Sonnet 5 for the session and for a new worker, on the released evidence.
    assert.deepEqual([advice.main.outcome, advice.main.recommendedModel, advice.main.reasonCode], ['recommend', 'claude-sonnet-5', 'LOWEST_UTILITY_WITHIN_FLOOR']);
    assert.deepEqual([advice.worker.outcome, advice.worker.recommendedModel], ['recommend', 'claude-sonnet-5']);
    assert.match(advice.worker.text, new RegExp(`release ${release.id}`));
    assert.match(advice.main.text, /Change the model yourself if you agree/);

    // Unchanged: nothing was applied, the session keeps its model, no worker started, no budget
    // was reserved, and no harness file was touched.
    assert.equal(advice.applied, false);
    assert.equal(advice.main.currentModel, 'claude-opus-5');
    const after = box.jevris(['status'], { json: true });
    evidence(after.json);
    assert.deepEqual(after.json.result.activeWorkers, []);
    assert.equal(after.json.result.budget.reservedMicroUsd, 0);
    assert.deepEqual(after.json.result.routing, before.json.result.routing);
    assert.deepEqual(harnessFiles(box.home), harnessBefore, 'a harness file changed');

    // Recorded: the counterfactual recommendation, with its policy version, explainable later.
    const recorded = after.json.result.recentDecisions.find((d) => d.reasonCode === 'LOWEST_UTILITY_WITHIN_FLOOR');
    assert.ok(recorded, `no recorded route decision: ${JSON.stringify(after.json.result.recentDecisions)}`);
    assert.equal(recorded.outcome, 'advisory');
    assert.equal(recorded.resolvedModel, null);
    const explained = box.jevris(['explain', recorded.decisionId], { json: true });
    evidence(explained.json);
    const trace = explained.json.result.trace;
    assert.equal(trace.applied, false);
    assert.ok(trace.reasonCodes.includes('COUNTERFACTUAL'), JSON.stringify(trace.reasonCodes));
    assert.match(trace.policyVersion, /\S/);
    assert.match(trace.rendered, /in observe mode: advice only; nothing was changed/);
    assert.match(trace.rendered, /Proposed action: route-worker \(model claude-sonnet-5 for task fix-parser\)/);
    assert.match(trace.rendered, new RegExp(`Policy version ${trace.policyVersion.replace(/[.]/g, '\\.')}`));
  });
});
