import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jevrisPaths } from '../../../packages/platform/dist/index.js';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';


const { runDoctor, formatDoctor } = await import('../dist/doctor.js');
const { classifyEnvironment } = await import('../dist/platform.js');
const { installPlugin } = await import('../dist/install.js');
const { harnessProbeForCli, readInstalledHarnessVersion, setDefaultHarnessExecFile } = await import(
  '../dist/harness-version.js'
);
const { setDefaultHarnessProbeRunner } = await import('../dist/harness-probe.js');

const cleanFixture = join(import.meta.dirname, '../../../fixtures/install/with spaces/jevris');
const US36_THEN_CLAIMS = [
  'passes arguments correctly',
  'passed arguments',
  'private IPC',
  'produces valid protocol JSON',
  'produced protocol JSON',
  'protocol JSON',
];

const SOURCE_CANARY = 'SOURCE_CANARY';
const SECRET_CANARY = 'SECRET_CANARY';
const SAME_USER =
  'A fully compromised OS account is outside what a same-user sidecar can reliably contain; stronger enforcement needs separate principals and operating-system isolation.';
const PRETOOL_REASON = 'A timed-out command PreToolUse can let the tool proceed.';
// windows-launcher is a row only on Windows; these tests run doctor as darwin or linux.
const ACTUATOR_IDS = [
  'pretooluse-deny',
  'worker.route',
  'verification',
  'claude.adapter',
  'codex.adapter',
  'antigravity.adapter',
  'opencode.adapter',
  'kilocode.adapter',
];
const ACTUATOR_REASONS = {
  'pretooluse-deny': PRETOOL_REASON,
  'worker.route':
    'worker.route is not certified: no signed record covers an owned worker here; fix: jevris certify --harness all (no model call)',
  verification: 'verification remains unsupported until an approved runner manifest exists.',
  'windows-launcher': 'The certified Windows launcher is not present.',
  'claude.adapter': 'Claude Code stays unsupported until its own conformance record exists; its certification is on the harness claude line.',
  'codex.adapter': 'Codex stays unsupported until its own conformance record exists.',
  'antigravity.adapter': 'Antigravity stays unsupported until its own conformance record exists; its certification is on the harness antigravity line.',
  'opencode.adapter': 'OpenCode stays unsupported until its own conformance record exists.',
  'kilocode.adapter':
    'Kilocode plugin is the supported observe adapter. Tool block, model switch, and compaction replacement are not certified.',
};
const REPORT_KEYS = [
  'actuators',
  'egressDecision',
  'egressReasonCode',
  'environmentStatus',
  'harnessProbe',
  'harnessVersion',
  'installStatus',
  'packs',
  'sameUserLimit',
  'schemaVersion',
  'verification',
  'verificationReason',
];

function quietHarnessRunner() {
  return async (file, args, options) => {
    assert.equal(file, 'claude');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    assert.equal(argv.includes('hooks'), false);
    if (argv[0] === '--version') {
      return { stdout: '2.1.280\n', code: 0, spawned: true };
    }
    assert.deepEqual(argv, ['doctor']);
    return { stdout: '', code: 0, spawned: true };
  };
}

function doctorInput(fields = {}) {
  return {
    platform: 'darwin',
    nodeVersion: '24.18.1',
    packs: [],
    certificationRecords: [],
    fixtureHashes: {},
    harnessRunner: quietHarnessRunner(),
    ...fields,
  };
}

function validPack(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'jevris.route',
    version: '1.0.0',
    maturity: 'experimental',
    description: 'PACK_BODY_CANARY',
    requiresCapabilities: ['worker.route'],
    fallbackCapabilities: ['advise'],
    decisionSpecs: ['failureFamily'],
    actions: ['advise'],
    dataScopes: ['task-metadata'],
    defaultMode: 'bounded-auto',
    conflicts: ['jevris.other'],
    fixtures: ['fixture-a'],
    ...overrides,
  };
}

function assertUnsupportedActuators(report) {
  assert.deepEqual(
    report.actuators.map((row) => row.id),
    ACTUATOR_IDS,
  );
  for (const row of report.actuators) {
    assert.equal(row.status, 'unsupported');
    assert.equal(row.fixtureHash, null);
    assert.equal(row.reason, ACTUATOR_REASONS[row.id]);
    assert.deepEqual(Object.keys(row).sort(), ['fixtureHash', 'id', 'reason', 'status']);
  }
}

function assertReportShape(report) {
  assert.equal(report.schemaVersion, '1.0');
  assert.equal(report.verification, 'unsupported');
  assert.equal(report.sameUserLimit, SAME_USER);
  assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  assert.equal(report.harnessProbe.actuators, 'unsupported');
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
  assert.equal(JSON.stringify(report).includes('enforced'), false);
  assert.equal(JSON.stringify(report).includes(SOURCE_CANARY), false);
  assert.equal(JSON.stringify(report).includes(SECRET_CANARY), false);
}

test('an injected version does not certify actuators', async () => {
  let probeCalls = 0;
  const harnessRunner = async (file, args, options) => {
    probeCalls += 1;
    assert.equal(file, 'claude');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    assert.equal(argv.includes('hooks'), false);
    if (argv[0] === '--version') {
      return { stdout: '2.1.280\n', code: 0, spawned: true };
    }
    assert.deepEqual(argv, ['doctor']);
    return { stdout: '', code: 0, spawned: true };
  };
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      platform: 'darwin',
      nodeVersion: '24.18.1',
      harnessRunner,
    }),
  );
  assert.equal(probeCalls, 2);
  assert.equal(report.harnessProbe.eventProbe, 'did-not-pass');
  assert.equal(report.harnessProbe.actuators, 'unsupported');
  assert.equal(report.harnessVersion, '2.1.280');
  assert.equal(report.environmentStatus, 'local');
  assert.equal(report.installStatus, 'reduced');
  assert.notEqual(report.installStatus, 'enforced');
  assertReportShape(report);
  assertUnsupportedActuators(report);
});

test('changelog baseline 2.1.278 does not certify an actuator', async () => {
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.278',
      platform: 'linux',
      nodeVersion: '22.13.1',
    }),
  );
  assert.equal(report.harnessVersion, '2.1.278');
  assert.equal(report.environmentStatus, 'local');
  assert.equal(report.installStatus, 'reduced');
  assertUnsupportedActuators(report);
});

test('win32 and another Node major can run and do not certify an actuator', async () => {
  const win = await runDoctor(doctorInput({ versionProbe: () => '2.1.280', platform: 'win32' }));
  assert.equal(win.environmentStatus, 'local');
  assert.equal(win.installStatus, 'reduced');
  assert.notEqual(win.installStatus, 'refused');
  const node26 = await runDoctor(doctorInput({ versionProbe: () => '2.1.280', nodeVersion: '26.5.0' }));
  assert.equal(node26.environmentStatus, 'local');
  assert.equal(node26.installStatus, 'reduced');
});

test('readInstalledHarnessVersion returns the first dotted token', async () => {
  const seen = [];
  const version = await readInstalledHarnessVersion({
    execFile: async (file, args, options) => {
      seen.push({ file, args: [...args], shell: options.shell, timeout: options.timeout });
      return { stdout: '2.1.280 (Claude Code)', stderr: SECRET_CANARY, code: 0 };
    },
  });
  assert.equal(version, '2.1.280');
  assert.equal(JSON.stringify(version).includes(SECRET_CANARY), false);
  assert.deepEqual(seen, [{ file: 'claude', args: ['--version'], shell: false, timeout: 2000 }]);
});

test('readInstalledHarnessVersion returns null on reject, non-zero, empty, or non-dotted stdout', async () => {
  assert.equal(
    await readInstalledHarnessVersion({
      execFile: async () => {
        throw new Error(`ENOENT ${SECRET_CANARY}`);
      },
    }),
    null,
  );
  assert.equal(
    await readInstalledHarnessVersion({
      execFile: async () => ({ stdout: '2.1.280 (Claude Code)', stderr: 'nope', code: 1 }),
    }),
    null,
  );
  assert.equal(
    await readInstalledHarnessVersion({
      execFile: async () => ({ stdout: '', stderr: '', code: 0 }),
    }),
    null,
  );
  assert.equal(
    await readInstalledHarnessVersion({
      execFile: async () => ({ stdout: 'Claude', stderr: '', code: 0 }),
    }),
    null,
  );
});

test('runDoctor with no versionProbe calls readInstalledHarnessVersion', async () => {
  let calls = 0;
  let probeCalls = 0;
  const harnessRunner = async (file, args, options) => {
    probeCalls += 1;
    assert.equal(file, 'claude');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    assert.equal(argv.includes('hooks'), false);
    if (argv[0] === '--version') {
      return { stdout: '2.1.280\n', code: 0, spawned: true };
    }
    assert.deepEqual(argv, ['doctor']);
    return { stdout: '', code: 0, spawned: true };
  };
  setDefaultHarnessExecFile(async (file, args, options) => {
    calls += 1;
    assert.equal(file, 'claude');
    assert.deepEqual([...args], ['--version']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    return { stdout: '2.1.280 (Claude Code)\n', stderr: SECRET_CANARY, code: 0 };
  });
  try {
    const report = await runDoctor(doctorInput({ harnessRunner }));
    assert.equal(calls, 1);
    assert.equal(probeCalls, 2);
    assert.equal(report.harnessVersion, '2.1.280');
    assert.notEqual(report.harnessVersion, 'unknown');
    assert.equal(report.environmentStatus, 'local');
    assert.equal(report.installStatus, 'reduced');
    assertUnsupportedActuators(report);
    setDefaultHarnessExecFile(async () => {
      throw new Error(SECRET_CANARY);
    });
    const failed = await runDoctor(doctorInput({ harnessRunner }));
    assert.equal(failed.harnessVersion, 'unknown');
    assert.equal(failed.environmentStatus, 'unsupported');
    assert.equal(failed.installStatus, 'unsupported');
    assert.equal(JSON.stringify(failed).includes(SECRET_CANARY), false);
    assert.equal(JSON.stringify(failed).includes('enforced'), false);
    assertUnsupportedActuators(failed);
  } finally {
    setDefaultHarnessExecFile(undefined);
  }
});

test('a null, empty, or thrown probe is unknown and unsupported', async () => {
  for (const versionProbe of [() => null, () => '', () => {
    throw new Error(SECRET_CANARY);
  }]) {
    const report = await runDoctor(
      doctorInput({
        versionProbe,
        certificationRecords: [
          {
            actuatorId: 'pretooluse-deny',
            platform: 'darwin',
            harnessVersion: 'unknown',
            fixtureHash: 'abc',
          },
        ],
        fixtureHashes: { 'pretooluse-deny': 'abc' },
      }),
    );
    assert.equal(report.harnessVersion, 'unknown');
    assert.equal(report.environmentStatus, 'unsupported');
    assert.equal(report.installStatus, 'unsupported');
    assert.equal(JSON.stringify(report).includes(SECRET_CANARY), false);
    assert.equal(JSON.stringify(report).includes('enforced'), false);
    assertUnsupportedActuators(report);
  }
});

test('harnessProbeForCli uses the reader unless a non-empty flag is set', async () => {
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return '9.9.9';
  };
  const omitted = harnessProbeForCli(undefined, fake);
  assert.equal(omitted, fake);
  assert.equal(await omitted(), '9.9.9');
  assert.equal(calls, 1);
  assert.equal(harnessProbeForCli('', fake), fake);
  const flagged = harnessProbeForCli('2.1.280', fake);
  assert.notEqual(flagged, fake);
  assert.equal(await flagged(), '2.1.280');
  assert.equal(calls, 1);
  assert.equal(harnessProbeForCli(), readInstalledHarnessVersion);
});

test('omitted setting denies and an approved setting allows without copying canaries', async () => {
  const denied = await runDoctor(doctorInput({ versionProbe: () => '2.1.280' }));
  assert.equal(denied.egressDecision, 'deny');
  assert.equal(denied.egressReasonCode, 'EGRESS_NOT_APPROVED');
  assert.equal(Object.hasOwn(denied, 'sent'), false);
  assert.equal(Object.hasOwn(denied, 'toolPermission'), false);

  const allowed = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      setting: {
        provenance: 'administrator',
        sourceEgress: 'approved-scoped',
        sourceText: SOURCE_CANARY,
        secretText: SECRET_CANARY,
      },
      sourceText: SOURCE_CANARY,
      secretText: SECRET_CANARY,
    }),
  );
  assert.equal(allowed.egressDecision, 'allow');
  assert.equal(allowed.egressReasonCode, null);
  assertReportShape(allowed);
  const text = formatDoctor(allowed);
  assert.equal(text.includes(SOURCE_CANARY), false);
  assert.equal(text.includes(SECRET_CANARY), false);
});

test('a matching certification record certifies only that actuator', async () => {
  const hash = 'fixture-hash-pretool';
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      certificationRecords: [
        {
          actuatorId: 'pretooluse-deny',
          platform: 'darwin',
          harnessVersion: '2.1.280',
          fixtureHash: hash,
        },
        {
          actuatorId: 'worker.route',
          platform: 'linux',
          harnessVersion: '2.1.280',
          fixtureHash: 'route-hash',
        },
        {
          actuatorId: 'verification',
          platform: 'darwin',
          harnessVersion: '2.1.278',
          fixtureHash: 'verify-hash',
        },
      ],
      fixtureHashes: {
        'pretooluse-deny': hash,
        'worker.route': 'route-hash',
        verification: 'verify-hash',
      },
    }),
  );
  const byId = Object.fromEntries(report.actuators.map((row) => [row.id, row]));
  assert.equal(byId['pretooluse-deny'].status, 'certified');
  assert.equal(byId['pretooluse-deny'].fixtureHash, hash);
  assert.equal(byId['worker.route'].status, 'unsupported');
  assert.equal(byId['worker.route'].fixtureHash, null);
  assert.equal(byId.verification.status, 'unsupported');
  assert.equal(byId.verification.fixtureHash, null);
  assert.equal(byId['windows-launcher'], undefined, 'the Windows launcher row is shown only on Windows');
});

test('a record whose hash differs does not certify', async () => {
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      certificationRecords: [
        {
          actuatorId: 'worker.route',
          platform: 'darwin',
          harnessVersion: '2.1.280',
          fixtureHash: 'claimed',
        },
      ],
      fixtureHashes: { 'worker.route': 'expected' },
    }),
  );
  assertUnsupportedActuators(report);
});

test('a runner manifest in the doctor input is neither echoed nor enough for verification', async () => {
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      runnerManifest: { id: 'runner', approved: true, body: SECRET_CANARY },
    }),
  );
  assert.equal(report.verification, 'unsupported');
  // Owner question: the fix names the command that proposes checks, then the approval.
  assert.equal(
    report.verificationReason,
    'verification remains unsupported until an approved runner manifest exists; fix: run `jevris verify profile` to see proposed checks, then `jevris verify approve --proposal` (or write jevris.checks.json and run `jevris verify approve`).',
  );
  assert.equal(JSON.stringify(report).includes(SECRET_CANARY), false);
  assert.equal(Object.hasOwn(report, 'runnerManifest'), false);
});

test('verification is unsupported until the proposed checks are approved, then supported (VER-07 pair)', async () => {
  const { openWorkspace, readProposedManifests, approveManifests } = await import('../../../packages/orchestrator/dist/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'jevris-doctor-verify-'));
  try {
    const home = join(dir, 'home');
    const root = join(dir, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'jevris.checks.json'),
      JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'] }] }),
    );
    const input = doctorInput({ platform: process.platform, versionProbe: () => '2.1.280', workspace: { home, root } });

    const before = await runDoctor(input);
    assert.equal(before.verification, 'unsupported');
    // jevris.checks.json is there: plain `verify approve` approves that file.
    assert.equal(before.verificationReason, 'verification is unsupported until you approve the checks in jevris.checks.json; fix: run `jevris verify approve`.');
    assert.match(formatDoctor(before), /verification: unsupported\n/);
    assert.match(formatDoctor(before), /^actuator verification: unsupported$/m);

    const proposed = readProposedManifests(root, process.platform);
    assert.equal(proposed.ok, true);
    await approveManifests(openWorkspace({ home, workspaceRoot: root }), proposed.manifests, proposed.hashes, 'cli');

    const after = await runDoctor(input);
    assert.equal(after.verification, 'supported');

    // A simulated win32 report on this machine reads the same store and creates no
    // win32-shaped folders under the working directory.
    const strayBefore = readdirSync(process.cwd()).filter((name) => name.startsWith('\\'));
    const win = await runDoctor({ ...input, platform: 'win32' });
    assert.equal(win.verification, 'supported');
    assert.deepEqual(readdirSync(process.cwd()).filter((name) => name.startsWith('\\')), strayBefore);
    assert.match(formatDoctor(after), /verification: supported\n/);
    // The actuator row gives the same answer as the verification line (W12).
    assert.match(formatDoctor(after), /^actuator verification: certified$/m);
    assert.deepEqual(after.actuators.find((row) => row.id === 'verification'), { id: 'verification', status: 'certified', fixtureHash: null, reason: after.verificationReason });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatDoctor names the limit and the PreToolUse reason without ANSI', async () => {
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280' }));
  const text = formatDoctor(report);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.includes(SAME_USER), true);
  assert.equal(text.includes(PRETOOL_REASON), true);
  assert.equal(text.includes('2.1.280'), true);
  assert.equal(text.includes('deny'), true);
  assert.equal(text.includes('EGRESS_NOT_APPROVED'), true);
  assert.equal(text.includes('verification'), true);
  assert.equal(text.includes('unsupported'), true);
  for (const id of ACTUATOR_IDS) {
    assert.equal(text.includes(id), true);
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  assert.equal(last.startsWith('JEVRIS_REPORT '), true);
  const parsed = JSON.parse(last.slice('JEVRIS_REPORT '.length));
  assert.equal(parsed.harnessVersion, '2.1.280');
  assert.equal(parsed.egressReasonCode, 'EGRESS_NOT_APPROVED');
  assert.equal(text.includes(SOURCE_CANARY), false);
});

test('a pack that requires worker.route with a fallback is advice', async () => {
  const pack = validPack();
  const before = JSON.stringify(pack);
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280', packs: [pack] }));
  assert.equal(JSON.stringify(pack), before);
  assert.equal(report.packs.length, 1);
  assert.equal(report.packs[0].id, 'jevris.route');
  assert.equal(report.packs[0].disposition, 'advice');
  assert.deepEqual(report.packs[0].missingCapabilities, ['worker.route']);
  assert.deepEqual(Object.keys(report.packs[0]).sort(), ['disposition', 'id', 'missingCapabilities']);
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes('enforced'), false);
  assert.equal(encoded.includes('bounded-auto'), false);
  assert.equal(encoded.includes('PACK_BODY_CANARY'), false);
  assert.equal(Object.hasOwn(report, 'activeMode'), false);
});

test('the same pack with an empty fallback is disabled', async () => {
  const pack = validPack({ fallbackCapabilities: [] });
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280', packs: [pack] }));
  assert.equal(report.packs[0].disposition, 'disabled');
  assert.deepEqual(report.packs[0].missingCapabilities, ['worker.route']);
  assert.equal(JSON.stringify(report).includes('enforced'), false);
});

test('an extra key, a wrong schemaVersion, or an oversized pack is disabled and not rewritten', async () => {
  const extra = validPack({ extra: true });
  const extraBefore = JSON.stringify(extra);
  const wrong = validPack({ id: 'jevris.wrong', schemaVersion: '2.0' });
  const wrongBefore = JSON.stringify(wrong);
  const huge = `h${'x'.repeat(131072)}`;
  const fat = validPack({ id: 'jevris.fat', description: 'y'.repeat(131073) });
  const fatBefore = fat.description;
  const report = await runDoctor(
    doctorInput({ versionProbe: () => '2.1.280', packs: [extra, wrong, huge, fat] }),
  );
  assert.equal(JSON.stringify(extra), extraBefore);
  assert.equal(JSON.stringify(wrong), wrongBefore);
  assert.equal(huge.length, 131073);
  assert.equal(fat.description, fatBefore);
  assert.equal(report.packs.length, 4);
  for (const row of report.packs) {
    assert.equal(row.disposition, 'disabled');
  }
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(huge), false);
  assert.equal(encoded.includes('y'.repeat(1000)), false);
  assert.equal(encoded.includes('enforced'), false);
});

test('an actions value outside the pack schema enum disables the pack', async () => {
  const pack = validPack({ actions: ['execute'] });
  const before = JSON.stringify(pack);
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280', packs: [pack] }));
  assert.equal(JSON.stringify(pack), before);
  assert.equal(report.packs[0].disposition, 'disabled');
  assert.equal(JSON.stringify(report).includes('enforced'), false);
  assert.equal(JSON.stringify(report).includes('bounded-auto'), false);
});

test('a certified required capability is still not enforced', async () => {
  const hash = 'route-hash';
  const pack = validPack({ requiresCapabilities: ['worker.route'], fallbackCapabilities: ['advise'] });
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      packs: [pack],
      certificationRecords: [
        {
          actuatorId: 'worker.route',
          platform: 'darwin',
          harnessVersion: '2.1.280',
          fixtureHash: hash,
        },
      ],
      fixtureHashes: { 'worker.route': hash },
    }),
  );
  assert.equal(report.actuators.find((row) => row.id === 'worker.route').status, 'certified');
  assert.equal(report.packs[0].disposition, 'advice');
  assert.deepEqual(report.packs[0].missingCapabilities, []);
  assert.equal(JSON.stringify(report).includes('enforced'), false);
  assert.equal(JSON.stringify(report).includes('bounded-auto'), false);
});

async function withDoctorHome(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-doctor-'));
  const home = join(parent, 'with spaces');
  await mkdir(home, { recursive: true });
  try {
    await fn(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('classifyEnvironment accepts any platform and any Node unless the process is remote', () => {
  assert.equal(classifyEnvironment({ platform: 'win32', nodeVersion: '24.18.1', env: {} }), 'local');
  assert.equal(classifyEnvironment({ platform: 'darwin', nodeVersion: '26.5.0', env: {} }), 'local');
  assert.equal(classifyEnvironment({ platform: 'linux', nodeVersion: 'v22.13.1', env: {} }), 'local');
  assert.equal(classifyEnvironment({ platform: '', nodeVersion: '26.5.0', env: {} }), 'unsupported');
});

test('a win32 doctor report does not claim the Windows launcher outcome', async () => {
  const report = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      platform: 'win32',
      nodeVersion: '24.18.1',
      certificationRecords: [],
    }),
  );
  assert.equal(report.environmentStatus, 'local');
  assert.equal(report.installStatus, 'reduced');
  assert.equal(report.verification, 'unsupported');
  const launcher = report.actuators.find((row) => row.id === 'windows-launcher');
  assert.equal(launcher.status, 'unsupported');
  assert.equal(launcher.reason, 'The certified Windows launcher is not present.');
  const text = formatDoctor(report);
  assert.equal(text.includes('The certified Windows launcher is not present.'), true);
  for (const claim of US36_THEN_CLAIMS) {
    assert.equal(text.includes(claim), false, claim);
  }
  assert.equal(text.includes('\u001b'), false);
  assert.equal(JSON.stringify(report).includes('enforced'), false);
});

const UI_LOCALHOST = 'UI localhost is not the worker.';

test('remote, SSH, and container markers are reduced and do not treat UI localhost as the worker', async () => {
  const cases = [
    { env: { CLAUDE_CODE_REMOTE: 'true' } },
    { env: { SSH_CONNECTION: '203.0.113.4 51324 198.51.100.8 22' } },
    { env: { SSH_CLIENT: '203.0.113.4 51324 22' } },
    { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } },
    { env: {}, inContainer: true },
  ];
  for (const fields of cases) {
    assert.equal(
      classifyEnvironment({ platform: 'darwin', nodeVersion: '24.18.1', ...fields }),
      'reduced',
    );
    const report = await runDoctor(
      doctorInput({
        versionProbe: () => '2.1.280',
        platform: 'darwin',
        nodeVersion: '24.18.1',
        ...fields,
      }),
    );
    assert.equal(report.harnessVersion, '2.1.280');
    assert.equal(report.environmentStatus, 'reduced');
    assert.equal(report.installStatus, 'reduced');
    assert.equal(report.verification, 'unsupported');
    const text = formatDoctor(report);
    assert.equal(text.includes(UI_LOCALHOST), true);
    assert.equal(text.includes('\u001b'), false);
    assert.equal(text.includes('127.0.0.1'), false);
  }
});

test('win32 outranks a remote marker and a failed read stays unsupported', async () => {
  assert.equal(
    classifyEnvironment({
      platform: 'win32',
      nodeVersion: '24.18.1',
      env: { CLAUDE_CODE_REMOTE: 'true' },
    }),
    'reduced',
  );
  const win = await runDoctor(
    doctorInput({
      versionProbe: () => '2.1.280',
      platform: 'win32',
      nodeVersion: '24.18.1',
      env: { CLAUDE_CODE_REMOTE: 'true' },
    }),
  );
  assert.equal(win.environmentStatus, 'reduced');
  assert.equal(win.installStatus, 'reduced');
  assert.equal(formatDoctor(win).includes(UI_LOCALHOST), true);

  const failed = await runDoctor(
    doctorInput({
      versionProbe: () => null,
      platform: 'darwin',
      nodeVersion: '24.18.1',
      env: { SSH_CONNECTION: '203.0.113.4 1 198.51.100.8 22' },
    }),
  );
  assert.equal(failed.harnessVersion, 'unknown');
  assert.equal(failed.environmentStatus, 'unsupported');
  assert.equal(failed.installStatus, 'unsupported');

  let calls = 0;
  let probeCalls = 0;
  const harnessRunner = async (file, args, options) => {
    probeCalls += 1;
    assert.equal(file, 'claude');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(Array.isArray(args), true);
    const argv = [...args];
    assert.equal(argv.includes('hooks'), false);
    if (argv[0] === '--version') {
      return { stdout: '2.1.280\n', code: 0, spawned: true };
    }
    assert.deepEqual(argv, ['doctor']);
    return { stdout: '', code: 0, spawned: true };
  };
  setDefaultHarnessExecFile(async (file, args, options) => {
    calls += 1;
    assert.equal(file, 'claude');
    assert.deepEqual([...args], ['--version']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    return { stdout: '2.1.280\n', code: 0 };
  });
  try {
    const omitted = await runDoctor(
      doctorInput({
        platform: 'darwin',
        nodeVersion: '24.18.1',
        env: { CLAUDE_CODE_REMOTE: 'true' },
        harnessRunner,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(probeCalls, 2);
    assert.equal(omitted.harnessVersion, '2.1.280');
    assert.notEqual(omitted.harnessVersion, 'unknown');
    assert.equal(omitted.environmentStatus, 'reduced');
  } finally {
    setDefaultHarnessExecFile(undefined);
  }
});

test('an empty remote marker and a false container stay local', () => {
  assert.equal(
    classifyEnvironment({ platform: 'darwin', nodeVersion: '24.18.1', env: { CLAUDE_CODE_REMOTE: 'false' } }),
    'local',
  );
  assert.equal(
    classifyEnvironment({ platform: 'linux', nodeVersion: '22.13.1', env: { SSH_CONNECTION: '', SSH_CLIENT: '' } }),
    'local',
  );
  assert.equal(
    classifyEnvironment({ platform: 'darwin', nodeVersion: '24.18.1', env: {}, inContainer: false }),
    'local',
  );
  assert.equal(classifyEnvironment({ platform: 'darwin', nodeVersion: '26.5.0', env: { CLAUDE_CODE_REMOTE: 'true' } }), 'reduced');
});

test('installPlugin on win32 copies only the jevris skill folder and an omitted platform stays reduced', async () => {
  await withDoctorHome(async (home) => {
    const sibling = join(home, '.claude', 'skills', 'other-plugin', 'keep.txt');
    await mkdir(join(home, '.claude', 'skills', 'other-plugin'), { recursive: true });
    const siblingBytes = new TextEncoder().encode('other-plugin-bytes\n');
    const settingsBytes = new TextEncoder().encode('{"unrelated":true}\n');
    await writeFile(sibling, siblingBytes);
    await writeFile(resolve(home, '.claude', 'settings.json'), settingsBytes);
    const result = await installPlugin({ home, source: cleanFixture, platform: 'win32' });
    const destination = resolve(home, '.claude', 'skills', 'jevris');
    assert.equal(result.ok, true);
    assert.equal(result.installStatus, 'reduced');
    assert.notEqual(result.installStatus, 'unsupported');
    assert.notEqual(result.installStatus, 'enforced');
    assert.equal(await pathExists(destination), true);
    assert.equal(await pathExists(join(destination, '.claude-plugin', 'plugin.json')), true);
    assert.equal(Buffer.from(await readFile(sibling)).equals(Buffer.from(siblingBytes)), true);
    assert.equal(
      Buffer.from(await readFile(resolve(home, '.claude', 'settings.json'))).equals(Buffer.from(settingsBytes)),
      true,
    );
    assert.equal(result.changedPaths.includes(join(home, '.claude', 'skills', 'other-plugin')), false);
    assert.equal(result.changedPaths.some((path) => path.endsWith('settings.json')), false);
  });
  await withDoctorHome(async (home) => {
    const omitted = await installPlugin({ home, source: cleanFixture });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.installStatus, 'reduced');
    assert.equal(Object.hasOwn(omitted, 'platform'), false);
  });
});

const hostileFixture = join(import.meta.dirname, '../../../fixtures/install/hostile/jevris');

function reportFrom(text) {
  const lines = text.split('\n').filter((line) => line.startsWith('JEVRIS_REPORT '));
  assert.equal(lines.length, 1);
  const line = lines[0];
  return JSON.parse(line.slice('JEVRIS_REPORT '.length));
}

async function runDoctorMain(args) {
  const { main } = await import('../dist/cli.js');
  let text = '';
  const code = await main(args, (chunk) => {
    text += chunk;
  });
  return { code, text };
}

describe('doctor subcommand', { concurrency: false }, () => {
  beforeEach(() => {
    setDefaultHarnessProbeRunner(quietHarnessRunner());
  });

  afterEach(() => {
    setDefaultHarnessProbeRunner(undefined);
  });

  test('main doctor prints one plain report and does not certify an actuator', async () => {
    await withDoctorHome(async (home) => {
      const { code, text } = await runDoctorMain([
        'doctor',
        '--home',
        home,
        '--platform',
        'darwin',
        '--harness-version',
        '2.1.280',
        '--node-version',
        '24.18.1',
      ]);
      assert.equal(code, 0);
      assert.equal(text.includes('\u001b'), false);
      const parsed = reportFrom(text);
      assert.equal(parsed.harnessVersion, '2.1.280');
      assert.equal(parsed.verification, 'unsupported');
      for (const row of parsed.actuators) {
        assert.notEqual(row.status, 'certified');
      }
      assert.equal(text.includes('certified'), true);
      assert.equal(text.includes('refused'), false);
    });
  });

  test('main install and doctor on win32 exit 0 and refused stays exit 2', async () => {
    await withDoctorHome(async (home) => {
      const installed = await runDoctorMain(['install', '--yes', '--home', home, '--harness', 'claude', '--platform', 'win32']);
      assert.equal(installed.code, 0);
      assert.equal(installed.text.includes('installed'), true);
      assert.equal(installed.text.includes('unsupported'), false);
      assert.equal(installed.text.includes('refused'), false);
      const doctor = await runDoctorMain([
        'doctor',
        '--home',
        home,
        '--platform',
        'win32',
        '--harness-version',
        '2.1.280',
        '--node-version',
        '24.18.1',
      ]);
      assert.equal(doctor.code, 0);
      assert.equal(doctor.text.includes('unsupported'), true);
      assert.equal(doctor.text.includes('The certified Windows launcher is not present.'), true);
      for (const claim of US36_THEN_CLAIMS) {
        assert.equal(doctor.text.includes(claim), false, claim);
      }
      const refused = await runDoctorMain(['install', '--yes', '--home', home, '--harness', 'gemini', '--platform', 'win32']);
      assert.equal(refused.code, 2);
      assert.equal(refused.text.includes('unknown harness'), true);
    });
  });

  test('omitted --platform resolves to process.platform and an explicit flag is forwarded', async () => {
    const cli = await import('../dist/cli.js');
    assert.equal(typeof cli.platformArg, 'function');
    assert.equal(cli.platformArg(undefined), process.platform);
    assert.equal(cli.platformArg('win32'), 'win32');
    assert.equal(cli.platformArg(''), '');
    assert.equal(cli.nodeVersionArg(undefined), process.version);
    assert.equal(cli.nodeVersionArg('26.5.0'), '26.5.0');
  });

  test('an omitted harness-version flag reads the installed version and a flag does not', async () => {
    let calls = 0;
    let probeCalls = 0;
    setDefaultHarnessExecFile(async (file, args, options) => {
      calls += 1;
      assert.equal(file, 'claude');
      assert.deepEqual([...args], ['--version']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 2000);
      return { stdout: '2.1.280 (Claude Code)\n', stderr: SECRET_CANARY, code: 0 };
    });
    setDefaultHarnessProbeRunner(async (file, args, options) => {
      probeCalls += 1;
      assert.equal(file, 'claude');
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 2000);
      assert.equal(Array.isArray(args), true);
      const argv = [...args];
      assert.equal(argv.includes('hooks'), false);
      if (argv[0] === '--version') {
        return { stdout: '2.1.280\n', code: 0, spawned: true };
      }
      assert.deepEqual(argv, ['doctor']);
      return { stdout: '', code: 0, spawned: true };
    });
    try {
      await withDoctorHome(async (home) => {
        const omitted = await runDoctorMain([
          'doctor',
          '--home',
          home,
          '--platform',
          'darwin',
          '--node-version',
          '24.18.1',
        ]);
        assert.equal(calls, 1);
        assert.equal(probeCalls, 2);
        assert.equal(omitted.code, 0);
        assert.equal(reportFrom(omitted.text).harnessVersion, '2.1.280');
        assert.equal(reportFrom(omitted.text).harnessProbe.eventProbe, 'did-not-pass');
        assert.equal(omitted.text.includes(SECRET_CANARY), false);
        const flagged = await runDoctorMain([
          'doctor',
          '--home',
          home,
          '--platform',
          'darwin',
          '--harness-version',
          '2.1.278',
          '--node-version',
          '24.18.1',
        ]);
        assert.equal(calls, 1);
        assert.equal(probeCalls, 4);
        assert.equal(flagged.code, 0);
        assert.equal(reportFrom(flagged.text).harnessVersion, '2.1.278');
        setDefaultHarnessExecFile(async () => {
          throw new Error(SECRET_CANARY);
        });
        const failed = await runDoctorMain(['doctor', '--home', home, '--platform', 'darwin', '--node-version', '24.18.1']);
        assert.equal(failed.code, 0);
        const parsed = reportFrom(failed.text);
        assert.equal(parsed.harnessVersion, 'unknown');
        assert.equal(parsed.environmentStatus, 'unsupported');
        assert.equal(parsed.installStatus, 'unsupported');
        for (const row of parsed.actuators) {
          assert.notEqual(row.status, 'certified');
        }
        assert.equal(failed.text.includes(SECRET_CANARY), false);
      });
    } finally {
      setDefaultHarnessExecFile(undefined);
      setDefaultHarnessProbeRunner(undefined);
    }
  });

  test('main doctor with CLAUDE_CODE_REMOTE true is reduced', async () => {
    const previous = process.env.CLAUDE_CODE_REMOTE;
    process.env.CLAUDE_CODE_REMOTE = 'true';
    try {
      await withDoctorHome(async (home) => {
        const { code, text } = await runDoctorMain([
          'doctor',
          '--home',
          home,
          '--platform',
          'darwin',
          '--harness-version',
          '2.1.280',
          '--node-version',
          '24.18.1',
        ]);
        assert.equal(code, 0);
        assert.equal(reportFrom(text).environmentStatus, 'reduced');
        assert.equal(text.includes(UI_LOCALHOST), true);
        assert.equal(text.includes('\u001b'), false);
      });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_REMOTE;
      else process.env.CLAUDE_CODE_REMOTE = previous;
    }
  });

  test('a runner manifest and a certification file are not approvals', async () => {
    await withDoctorHome(async (home) => {
      await mkdir(join(dataDir(home), 'packs'), { recursive: true });
      await writeFile(join(dataDir(home), 'packs', 'route.json'), JSON.stringify(validPack()));
      await writeFile(
        join(dataDir(home), 'packs', 'empty-fallback.json'),
        JSON.stringify(validPack({ id: 'jevris.empty', fallbackCapabilities: [] })),
      );
      const huge = `h${'x'.repeat(131072)}`;
      await writeFile(join(dataDir(home), 'packs', 'huge.json'), huge);
      await writeFile(
        join(dataDir(home), 'certification-records.json'),
        JSON.stringify([
          {
            actuatorId: 'pretooluse-deny',
            platform: 'darwin',
            harnessVersion: '2.1.280',
            fixtureHash: 'abc',
          },
        ]),
      );
      await writeFile(
        join(dataDir(home), 'runner-manifest.json'),
        JSON.stringify({ approved: true, body: 'RUNNER_CANARY' }),
      );
      const { code, text } = await runDoctorMain([
        'doctor',
        '--home',
        home,
        '--platform',
        'darwin',
        '--harness-version',
        '2.1.280',
        '--node-version',
        '24.18.1',
      ]);
      assert.equal(code, 0);
      const parsed = reportFrom(text);
      assert.equal(parsed.verification, 'unsupported');
      assert.equal(text.includes('RUNNER_CANARY'), false);
      assert.equal(text.includes(huge), false);
      const byId = Object.fromEntries(parsed.packs.map((row) => [row.id, row]));
      assert.equal(byId['jevris.route'].disposition, 'advice');
      assert.equal(byId['jevris.empty'].disposition, 'disabled');
      assert.equal(byId.invalid.disposition, 'disabled');
      for (const row of parsed.actuators) {
        assert.equal(row.status, 'unsupported');
      }
      assert.equal(JSON.stringify(parsed).includes('enforced'), false);
    });
  });

  test('a certified actuator status exits 2 and an absence sentence does not', async () => {
    const cli = await import('../dist/cli.js');
    assert.equal(typeof cli.doctorReportStatus, 'function');
    const absence = formatDoctor(
      await runDoctor(doctorInput({ versionProbe: () => '2.1.280', platform: 'win32', nodeVersion: '24.18.1' })),
    );
    assert.equal(absence.includes('certified'), true);
    assert.equal(cli.doctorReportStatus(absence), 'reduced');
    const certified = `JEVRIS_REPORT ${JSON.stringify({
      installStatus: 'reduced',
      actuators: [{ id: 'worker.route', status: 'certified' }],
    })}\n`;
    assert.equal(cli.doctorReportStatus(certified), 'refused');
    let written = '';
    const code = cli.finishDoctor(certified, (chunk) => {
      written += chunk;
    });
    assert.equal(code, 2);
    assert.equal(written, 'refused\n');
  });

  test('install, uninstall, and data delete still work', { skip: managedHostSkip() }, async () => {
    await withDoctorHome(async (home) => {
      await mkdir(join(home, '.claude'));
      const installed = await runDoctorMain(['install', '--yes', '--home', home, '--harness', 'claude', '--platform', 'darwin']);
      assert.equal(installed.code, 0);
      assert.equal(installed.text.includes('installed'), true);
      const removed = await runDoctorMain(['uninstall', '--home', home]);
      assert.equal(removed.code, 0);
      assert.equal(removed.text.includes('removed'), true);
      const deleted = await runDoctorMain(['data', 'delete', '--home', home]);
      assert.equal(deleted.code, 0);
      assert.equal(deleted.text.includes('removed'), true);
      // A pre-existing ~/.claude stays; only folders the install created are removed.
      assert.equal(await pathExists(join(home, '.claude')), true);
      assert.equal(await pathExists(join(home, '.claude', 'skills')), false);
    });
  });
});

/** Jevris data dir for this OS (BLD-09). */
function dataDir(home) {
  return jevrisPaths({ home }).data;
}

test('formatDoctor names the scripted test worker port while it is active or refused, and says nothing otherwise', async () => {
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280' }));
  const home = await mkdtemp(join(tmpdir(), 'jevris-doctor-tw-'));
  try {
    assert.equal(formatDoctor(report, {}, home).includes('test worker port'), false, 'no line when nothing asks for it');
    assert.equal(formatDoctor(report).includes('test worker port'), false);
    const script = join(home, 'worker.json');
    await writeFile(script, JSON.stringify({ schemaVersion: 'jevris-test-worker-1', runs: [{ writes: [], status: 'completed' }] }));
    assert.match(formatDoctor(report, { JEVRIS_TEST_WORKER_SCRIPT: script }, home), /^test worker port refused \(NOT_TEST_MODE\): owned workers use the Agent SDK$/m);
    const env = { JEVRIS_TEST: '1', JEVRIS_TEST_WORKER_SCRIPT: script };
    assert.match(formatDoctor(report, env, home), /^test worker port refused \(NO_TEST_HOME_MARKER\)/m);
    const state = jevrisPaths({ home }).state;
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'test-home.json'), JSON.stringify({ schemaVersion: 'jevris-test-home-1' }), { mode: 0o600 });
    const text = formatDoctor(report, env, home);
    assert.match(text, /^test worker port ACTIVE: owned workers replay a test script, not a model session \(JEVRIS_TEST\)$/m);
    assert.equal(text.split('\n').filter((line) => line.startsWith('test worker port')).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('formatDoctor names an active test provider override and says nothing without one', async () => {
  const report = await runDoctor(doctorInput({ versionProbe: () => '2.1.280' }));
  assert.equal(formatDoctor(report, {}).includes('test provider override'), false);
  const text = formatDoctor(report, { JEVRIS_TEST_PROVIDER_URL: 'http://127.0.0.1:4010', JEVRIS_TEST_PROVIDER_KEY: 'k' });
  assert.match(text, /test provider override active: Jev calls go to http:\/\/127\.0\.0\.1:4010, not production/);
  assert.match(formatDoctor(report, { JEVRIS_TEST_PROVIDER_URL: 'https://example.com' }), /test provider override refused/);
});
