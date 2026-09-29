import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';


const { probeInstalledHarness, setDefaultHarnessProbeRunner } = await import('../dist/harness-probe.js');
const doctorModule = await import('../dist/doctor.js');
const { runDoctor, formatDoctor } = doctorModule;

const BINARY = 'claude';

function doctorInput(fields = {}) {
  return {
    platform: 'darwin',
    nodeVersion: '24.18.1',
    packs: [],
    certificationRecords: [],
    fixtureHashes: {},
    ...fields,
  };
}

function recordingRunner(steps) {
  const calls = [];
  const runner = async (file, args, options) => {
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    calls.push({ file, args: argv, shell: options.shell, timeout: options.timeout });
    const step = steps[calls.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected spawn ${argv.join(' ')}`);
    }
    if (step.failSpawn === true) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return {
      stdout: step.stdout,
      code: step.code,
      spawned: step.spawned,
      timedOut: step.timedOut === true,
    };
  };
  return { calls, runner };
}

function assertSpawnContract(calls, expectedArgv) {
  assert.equal(calls.length, expectedArgv.length);
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    assert.equal(call.file, BINARY);
    assert.equal(call.shell, false);
    assert.equal(call.timeout, 2000);
    assert.deepEqual(call.args, expectedArgv[index]);
    assert.equal(call.args.includes('hooks'), false);
    assert.equal(call.args.some((arg) => arg.includes('hooks')), false);
  }
}

function assertUncertified(probe) {
  assert.equal(probe.eventProbe, 'did-not-pass');
  assert.equal(probe.actuators, 'unsupported');
  assert.notEqual(probe.eventProbe, 'passed');
  assert.notEqual(probe.health, 'certified');
  assert.notEqual(probe.actuators, 'certified');
}

test('a doctor exit of 0 is installation-only and does not certify', async () => {
  const { calls, runner } = recordingRunner([
    { stdout: '2.1.280 (Claude Code)\n', code: 0, spawned: true },
    { stdout: '', code: 0, spawned: true },
  ]);
  const probe = await probeInstalledHarness({ harnessRunner: runner });
  assertSpawnContract(calls, [['--version'], ['doctor']]);
  assert.equal(probe.health, 'installation-only');
  assert.equal(probe.binaryPresent, true);
  assert.equal(probe.versionToken, '2.1.280');
  assertUncertified(probe);
});

test('a missing binary is unsupported and does not continue', async () => {
  const { calls, runner } = recordingRunner([{ failSpawn: true }]);
  const probe = await probeInstalledHarness({ harnessRunner: runner });
  assertSpawnContract(calls, [['--version']]);
  assert.equal(probe.health, 'unsupported');
  assert.equal(probe.binaryPresent, false);
  assert.equal(probe.versionToken, null);
  assertUncertified(probe);
});

test('a non-zero doctor exit, a timeout, or a non-dotted token stays unsupported', async () => {
  const nonzero = recordingRunner([
    { stdout: '2.1.280\n', code: 0, spawned: true },
    { stdout: '', code: 1, spawned: true },
  ]);
  const failedDoctor = await probeInstalledHarness({ harnessRunner: nonzero.runner });
  assert.equal(failedDoctor.health, 'unsupported');
  assert.equal(failedDoctor.binaryPresent, true);
  assertUncertified(failedDoctor);
  assertSpawnContract(nonzero.calls, [['--version'], ['doctor']]);

  const timedOut = recordingRunner([{ stdout: '', code: 124, spawned: true, timedOut: true }]);
  const timeoutProbe = await probeInstalledHarness({ harnessRunner: timedOut.runner });
  assert.equal(timeoutProbe.health, 'unsupported');
  assert.equal(timeoutProbe.binaryPresent, true);
  assertUncertified(timeoutProbe);
  assert.equal(timedOut.calls.length, 1);

  const undotted = recordingRunner([
    { stdout: 'Claude\n', code: 0, spawned: true },
    { stdout: '', code: 0, spawned: true },
  ]);
  const undottedProbe = await probeInstalledHarness({ harnessRunner: undotted.runner });
  assert.equal(undottedProbe.health, 'unsupported');
  assert.equal(undottedProbe.binaryPresent, true);
  assert.equal(undottedProbe.versionToken, null);
  assertUncertified(undottedProbe);
  assertSpawnContract(undotted.calls, [['--version'], ['doctor']]);
});

test('2.1.280 and 2.1.278 do not certify an actuator', async () => {
  for (const version of ['2.1.280', '2.1.278']) {
    const { calls, runner } = recordingRunner([
      { stdout: `${version}\n`, code: 0, spawned: true },
      { stdout: '', code: 0, spawned: true },
    ]);
    const report = await runDoctor(
      doctorInput({
        versionProbe: () => version,
        harnessRunner: runner,
        certificationRecords: [
          {
            actuatorId: 'pretooluse-deny',
            platform: 'darwin',
            harnessVersion: version,
          },
        ],
        fixtureHashes: {},
      }),
    );
    assert.equal(calls.length, 2);
    assert.equal(report.harnessVersion, version);
    assert.equal(report.harnessProbe.health, 'installation-only');
    assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
    assert.equal(report.harnessProbe.actuators, 'unsupported');
    assert.equal(report.harnessProbe.binaryPresent, true);
    for (const row of report.actuators) {
      assert.equal(row.status, 'unsupported');
      assert.notEqual(row.status, 'certified');
    }
    const text = formatDoctor(report);
    assert.equal(text.includes('installation-only'), true);
    assert.equal(text.includes('unsupported'), true);
    for (const line of text.split('\n')) {
      assert.equal(/^actuator .+: certified$/.test(line), false);
    }
    assert.equal(text.includes('\u001b'), false);
  }
});

test('runDoctor calls the harness runner even when versionProbe is set', async () => {
  const { calls, runner } = recordingRunner([
    { stdout: '2.1.280\n', code: 0, spawned: true },
    { stdout: '', code: 0, spawned: true },
  ]);
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      harnessRunner: runner,
    }),
  );
  assertSpawnContract(calls, [['--version'], ['doctor']]);
  assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  assert.notEqual(report.harnessProbe.actuators, 'certified');
});

test('an omitted harnessRunner uses setDefaultHarnessProbeRunner', async () => {
  const { calls, runner } = recordingRunner([
    { stdout: '2.1.280\n', code: 0, spawned: true },
    { stdout: '', code: 0, spawned: true },
  ]);
  setDefaultHarnessProbeRunner(runner);
  try {
    const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280' }));
    assertSpawnContract(calls, [['--version'], ['doctor']]);
    assert.equal(report.harnessProbe.health, 'installation-only');
    assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  } finally {
    setDefaultHarnessProbeRunner(undefined);
  }
});

test('there is no doctor export and the probe writes no hook manifest', async () => {
  assert.equal(Object.hasOwn(doctorModule, 'doctor'), false);
  assert.equal(typeof doctorModule.runDoctor, 'function');
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
});
