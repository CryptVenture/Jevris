import assert from 'node:assert/strict';
import { workflow } from './lib.mjs';
import { renderVerify, verifySettled } from './verify-run.mjs';

// W12: a legacy embedded project (C sources and a Keil uVision project) with no certified
// analyzer. Jevris names the metadata it found, says build and test semantics are unverified,
// keeps generic planning and checkpointing, runs the developer's approved manifest, and keeps a
// hardware-bound check waiting for the runner that has the hardware.
workflow('W12', 'An unknown toolchain or constrained platform', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  box.write('work/src/main.c', 'int main(void) { return 0; }\n');
  box.write('work/firmware.uvprojx', '<?xml version="1.0"?>\n<Project><Targets><Target><TargetName>board</TargetName></Target></Targets></Project>\n');

  await then('available metadata is identified and build and test semantics are reported as unverified', () => {
    const profile = box.jevris(['verify', 'profile'], { json: true });
    evidence(profile.json);
    // Exit 1: nothing certified to propose. The result still names what was found.
    assert.equal(profile.code, 1, `verify profile: ${profile.stdout} ${profile.stderr}`);
    assert.deepEqual(profile.json.proposal.checks, [], 'an uncertified toolchain got proposed checks');
    const { proposal } = profile.json;
    assert.equal(proposal.semantics, 'unverified', `semantics: ${JSON.stringify(proposal).slice(0, 400)}`);
    const found = [...(proposal.detected ?? []), ...(proposal.unverified ?? [])].map((item) => item.id);
    assert.equal(found.includes('keil-uvision'), true, `the uVision project was not identified: ${found.join(', ')}`);
    assert.equal(found.includes('c'), true, `the C sources were not identified: ${found.join(', ')}`);
    const unverified = (proposal.unverified ?? []).map((item) => item.id);
    assert.equal(unverified.includes('keil-uvision'), true, 'the uVision project is not marked unverified');
    const text = box.jevris(['verify', 'profile']);
    assert.match(text.stdout, /Keil .*Vision project \(firmware\.uvprojx\), C \(1 file\)/);
    assert.match(text.stdout, /build and test semantics are unverified/);
  });

  await then('generic task triage and checkpointing remain available', () => {
    const node = (id, dependencyIds, writeScopes, acceptanceCheckIds, requirementIds) => ({ id, schemaVersion: '1.0', workspaceId: 'firmware', revision: 'r1', state: 'proposed', requirementIds, dependencyIds, writeScopes, acceptanceCheckIds, rootBudgetId: 'budget-1' });
    const graph = box.write('work/tasks.json', [
      node('port-uart', [], ['src/uart.c'], ['build'], ['FW-1']),
      node('bench-test', ['port-uart'], ['test/loopback.c'], ['device'], ['FW-2']),
    ]);
    const plan = box.jevris(['plan', '--graph', graph], { json: true });
    evidence(plan.json);
    assert.equal(plan.code, 0, `plan failed on an unprofiled project: ${plan.stdout} ${plan.stderr}`);
    assert.equal(JSON.stringify(plan.json).includes('port-uart'), true, 'the plan does not list the ready task');
    const capsule = box.jevris(['checkpoint', '--objective', 'Port the UART driver', '--constraint', 'No vendor HAL changes'], { json: true });
    evidence(capsule.json);
    assert.equal(capsule.code, 0, `checkpoint failed on an unprofiled project: ${capsule.stdout} ${capsule.stderr}`);
    assert.equal(JSON.stringify(capsule.json).includes('No vendor HAL changes'), true, 'the capsule lost the constraint');
  });

  // The developer supplies an approved command manifest; the device test needs bench hardware.
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [
      { id: 'build', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', description: 'cross-compile the firmware' },
      { id: 'device', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', hardware: 'bench-1', description: 'loopback test on the bench board' },
    ],
  });
  // The developer approves it at a terminal (SR-1); the sandbox records it as the CLI does.
  const approve = await box.approveChecks();

  await then('an approved command manifest supplied by the developer runs through the verification runner', async () => {
    assert.equal(approve.code, 0, `verify approve failed: ${approve.reason}`);
    const run = await verifySettled(box, ['--check', 'build'], { checks: ['build'] });
    evidence(run.json);
    const build = run.json.result.checks.find((check) => check.checkId === 'build');
    assert.equal(build.outcome, 'passed', `build: ${JSON.stringify(build)}`);
    assert.equal(typeof build.receiptId, 'string', 'the build pass has no receipt');
    assert.equal(build.fresh, true, 'the build receipt is not current');
  });

  await then('a hardware-dependent check runs only on the runner that has the hardware and is never passed by judgment', async () => {
    const run = await verifySettled(box, ['--check', 'build', '--check', 'device'], { checks: ['build', 'device'] });
    evidence(run.json);
    const device = run.json.result.checks.find((check) => check.checkId === 'device');
    assert.equal(device.outcome, 'not-run', `the device check ran without the hardware: ${JSON.stringify(device)}`);
    assert.equal(device.reasonCode, 'HARDWARE_UNAVAILABLE');
    assert.equal(device.environment, 'bench-1');
    assert.equal(run.json.result.missing.includes('device'), true, 'a check waiting for hardware is not counted as missing');
    assert.equal(run.code, 1, 'a check waiting for hardware must not verify the change');
    // The required-checks report does not count a not-run receipt as a pass.
    const required = box.jevris(['verify', 'required', 'build', 'device'], { json: true });
    const byId = Object.fromEntries((required.json.checks ?? required.json.result?.checks ?? []).map((line) => [line.checkId, line.status]));
    assert.equal(byId.build, 'passed');
    assert.equal(byId.device, 'missing', `device: ${byId.device}`);
  });

  await then('the final report distinguishes verified software changes from checks that require another environment', async () => {
    const run = await verifySettled(box, ['--check', 'build', '--check', 'device'], { checks: ['build', 'device'] });
    evidence(run.json);
    assert.equal(run.json.result.readiness, 'needs-environment', `readiness: ${run.json.result.readiness}`);
    assert.deepEqual(run.json.result.needsEnvironment, ['device']);
    // The summary and the plain text are the CLI's own rendering of the settled payload. A second `jevris verify`
    // for the text would start a second run, and on a slow host its answer comes before that run ends.
    const report = await renderVerify(run);
    assert.equal(report.summary, 'Software checks verified; needs another environment: device (bench-1).');
    if (run.settled) assert.equal(run.json.summary, report.summary, 'the command printed what the renderer gives for its payload');
    assert.match(report.text, /^check build: passed mandatory receipt rcpt-\S+$/m);
    assert.match(report.text, /^check device: not-run mandatory .*reason HARDWARE_UNAVAILABLE needs bench-1$/m);
    assert.match(report.text, /^needs another environment: device$/m);
  });
});
