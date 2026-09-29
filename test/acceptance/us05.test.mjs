import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { load, story } from './lib.mjs';

/** A policy pack that needs the PreToolUse deny actuator, which no harness has certified here. */
function pack(id, fallbackCapabilities) {
  return {
    schemaVersion: '1.0',
    id,
    version: '1.0.0',
    maturity: 'experimental',
    description: 'Blocks destructive shell commands before they run.',
    requiresCapabilities: ['pretooluse-deny'],
    fallbackCapabilities,
    decisionSpecs: ['failureFamily'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'bounded-auto',
    conflicts: [],
    fixtures: ['destructive-shell'],
  };
}

story('US05', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { jevrisPaths, packsDir } = await load('platform');
  const packs = relative(box.dir, packsDir(jevrisPaths({ home: box.home })));
  // One pack declares an advice fallback, the other declares none.
  box.write(join(packs, 'guard.json'), pack('jevris.guard', ['advise']));
  box.write(join(packs, 'strict.json'), pack('jevris.strict', []));

  const doctor = box.jevris(['doctor', '--home', box.home], { json: true });
  assert.equal(doctor.code, 0, `doctor failed: ${doctor.stderr}`);
  const report = doctor.json?.report;
  assert.notEqual(report, undefined, 'doctor --json printed no report');
  evidence(report);
  const text = box.jevris(['doctor', '--home', box.home]);
  const byId = Object.fromEntries(report.packs.map((item) => [item.id, item]));

  await then('Doctor reports the missing capability, and the pack degrades to declared advice or is disabled rather than claiming enforcement', () => {
    const actuator = report.actuators.find((row) => row.id === 'pretooluse-deny');
    assert.equal(actuator?.status, 'unsupported');
    assert.equal(actuator.reason.length > 0, true, 'no reason is given for the missing actuator');
    assert.deepEqual(byId['jevris.guard']?.missingCapabilities, ['pretooluse-deny']);
    assert.match(text.stdout, /actuator pretooluse-deny: unsupported/);
    assert.match(text.stdout, /pack jevris\.guard: advice/);
    assert.equal(byId['jevris.guard'].disposition, 'advice', 'a pack with an advice fallback did not degrade to advice');
    assert.equal(byId['jevris.strict']?.disposition, 'disabled', 'a pack without a fallback was not disabled');
    assert.match(text.stdout, /pack jevris\.strict: disabled/);
    // No actuator or pack row claims enforcement, and the pack's bounded-auto default is not passed through.
    const rows = JSON.stringify({ actuators: report.actuators, packs: report.packs });
    assert.equal(/enforc/i.test(rows), false, 'doctor claims enforcement');
    assert.equal(report.actuators.some((row) => row.status !== 'unsupported' && row.status !== 'certified'), false);
    // (The settings line names the effective mode, bounded-auto by default; the pack rows never do.)
    assert.equal(rows.includes('bounded-auto'), false, 'doctor passes the pack default mode through');
    // The hook, with both packs present, still makes no permission decision on a destructive command.
    const hook = box.hook('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'us05',
      cwd: box.work,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    });
    evidence(hook.stdout);
    assert.equal(hook.code, 0, `hook exited ${hook.code}: ${hook.stderr}`);
    assert.equal(/permissionDecision|"decision"\s*:\s*"(block|deny)"/.test(hook.stdout), false, `the hook made a permission decision: ${hook.stdout}`);
  });
});
