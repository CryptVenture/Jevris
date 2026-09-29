import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';
const RECORDED = 'Counterfactual recorded. The worker and model were not changed.';
const OBSERVATION_KEYS = [
  'schemaVersion',
  'mode',
  'policyVersion',
  'recommendedModel',
  'actualModel',
  'actualWorker',
  'requestedModel',
  'applied',
  'appliedAction',
  'toolPermission',
  'sent',
  'explanation',
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jevris-observe-'));
}

async function issuedCaller() {
  const { createAntiReplayStore, issueLocalCallerToken } = await import('../dist/runtime.js');
  const issued = issueLocalCallerToken({
    user: 'dev-one',
    pid: 4242,
    nowMs: 1000,
    expiresAtMs: 5000,
  });
  assert.equal(issued.ok, true);
  const credential = {
    user: 'dev-one',
    pid: 4242,
    expiresAtMs: 5000,
    token: issued.token,
  };
  const presented = {
    host: 'localhost',
    user: 'dev-one',
    pid: 4242,
    token: issued.token,
  };
  return { credential, presented, replay: createAntiReplayStore() };
}

function spies() {
  const calls = { evaluate: 0, actuate: 0, launch: 0 };
  return {
    calls,
    evaluate() {
      calls.evaluate += 1;
    },
    actuate() {
      calls.actuate += 1;
    },
    launch() {
      calls.launch += 1;
    },
  };
}

test('accepted observe record keeps the pin and writes the policy version', async () => {
  const { decideEgress } = await import('../dist/egress.js');
  const { readObservationFile, recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  const setting = { provenance: 'administrator', sourceEgress: 'approved-scoped' };
  const egress = decideEgress({ setting });
  assert.equal(egress.decision, 'allow');
  assert.equal(egress.sent, false);

  try {
    const result = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      destination,
      setting,
      evaluate: seen.evaluate,
      actuate: seen.actuate,
      launch: seen.launch,
      port: { evaluate: seen.evaluate },
      actuator: { actuate: seen.actuate },
      workLauncher: { launch: seen.launch },
      sourceText: SOURCE_CANARY,
      secretText: SOURCE_CANARY,
      message: SOURCE_CANARY,
      body: SOURCE_CANARY,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.reasonCode, null);
    assert.equal(result.fileWritten, true);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.sent, false);
    assert.equal(Object.hasOwn(result, 'message'), false);
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);

    const bytes = readFileSync(destination);
    const text = bytes.toString('utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(existsSync(`${destination}.observe.tmp`), false);
    // 0600 is a POSIX mode; on Windows the file inherits its directory's ACL (BLD-09).
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), OBSERVATION_KEYS);
    assert.equal(parsed.schemaVersion, '1.0');
    assert.equal(parsed.mode, 'observe');
    assert.equal(parsed.policyVersion, 'policy-observe-1');
    assert.equal(parsed.recommendedModel, 'claude-haiku-counterfactual');
    assert.equal(parsed.actualModel, 'pinned-main');
    assert.equal(parsed.actualWorker, null);
    assert.equal(parsed.requestedModel, null);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.appliedAction, null);
    assert.equal(parsed.toolPermission, false);
    assert.equal(parsed.sent, false);
    assert.equal(parsed.explanation, RECORDED);

    const read = await readObservationFile(destination);
    assert.equal(read.ok, true);
    assert.deepEqual(read.file, parsed);

    const replayed = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      destination,
      setting,
      evaluate: seen.evaluate,
      actuate: seen.actuate,
      launch: seen.launch,
      sourceText: SOURCE_CANARY,
    });
    assert.equal(replayed.accepted, false);
    assert.equal(replayed.reasonCode, 'REPLAYED_TOKEN');
    assert.equal(replayed.fileWritten, false);
    assert.equal(Object.hasOwn(replayed, 'file'), false);
    assert.equal(readFileSync(destination, 'utf8'), text);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.observe.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty destination returns the record and does not invent a path', async () => {
  const { readObservationFile, recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const { credential, presented, replay } = await issuedCaller();
  try {
    const omitted = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
      sourceText: SOURCE_CANARY,
    });
    assert.equal(omitted.accepted, true);
    assert.equal(omitted.fileWritten, false);
    assert.equal(omitted.file.policyVersion, 'policy-observe-1');
    assert.equal(omitted.file.actualModel, 'pinned-main');
    assert.equal(omitted.file.recommendedModel, 'claude-haiku-counterfactual');
    assert.equal(omitted.file.sent, false);
    assert.equal(JSON.stringify(omitted).includes(SOURCE_CANARY), false);
    assert.equal(readdirSync(dir).length, 0);

    const empty = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1001,
      replay,
      destination: '',
      setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
    });
    assert.equal(empty.reasonCode, 'REPLAYED_TOKEN');
    assert.equal(empty.fileWritten, false);
    const unread = await readObservationFile('');
    assert.equal(unread.ok, false);
    assert.equal(unread.reasonCode, 'SCHEMA_FAILURE');
    assert.equal(Object.hasOwn(unread, 'message'), false);
    assert.equal(Object.hasOwn(unread, 'file'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const APPROVED = { provenance: 'administrator', sourceEgress: 'approved-scoped' };

function deniedArgs(parts, seen) {
  return {
    mode: 'observe',
    policyVersion: 'policy-observe-1',
    recommendedModel: SOURCE_CANARY,
    actualModel: 'pinned-main',
    requestedModel: null,
    evaluate: seen.evaluate,
    actuate: seen.actuate,
    launch: seen.launch,
    port: { evaluate: seen.evaluate },
    sourceText: SOURCE_CANARY,
    secretText: SOURCE_CANARY,
    ...parts,
  };
}

test('missing consent records a null recommendation and no source', async () => {
  const { decideEgress } = await import('../dist/egress.js');
  const { readObservationFile, recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  const egress = decideEgress({});
  assert.equal(egress.decision, 'deny');
  assert.equal(egress.sent, false);

  try {
    const result = await recordObservation(
      deniedArgs(
        {
          presented,
          expectedUser: 'dev-one',
          expectedPid: 4242,
          credential,
          nowMs: 1000,
          replay,
          destination,
        },
        seen,
      ),
    );
    assert.equal(result.accepted, true);
    assert.equal(result.fileWritten, true);
    assert.equal(result.sent, false);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.policyVersion, 'policy-observe-1');
    assert.equal(parsed.recommendedModel, null);
    assert.equal(parsed.actualModel, 'pinned-main');
    assert.equal(parsed.sent, false);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.explanation, egress.explanation);
    assert.equal(parsed.explanation, 'Egress denied: missing consent.');
    const read = await readObservationFile(destination);
    assert.equal(read.ok, true);
    assert.equal(read.file.recommendedModel, null);
    assert.equal(JSON.stringify(read).includes(SOURCE_CANARY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('untrusted claims deny the recommendation and call no provider', async () => {
  const { decideEgress } = await import('../dist/egress.js');
  const { recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  const untrustedClaims = [SOURCE_CANARY];
  const egress = decideEgress({ setting: APPROVED, untrustedClaims });
  assert.equal(egress.decision, 'deny');

  try {
    const result = await recordObservation(
      deniedArgs(
        {
          presented,
          expectedUser: 'dev-one',
          expectedPid: 4242,
          credential,
          nowMs: 1000,
          replay,
          destination,
          setting: APPROVED,
          untrustedClaims,
        },
        seen,
      ),
    );
    assert.equal(result.fileWritten, true);
    assert.equal(result.sent, false);
    assert.equal(seen.calls.evaluate, 0);
    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.recommendedModel, null);
    assert.equal(parsed.sent, false);
    assert.equal(parsed.explanation, egress.explanation);
    assert.equal(parsed.explanation, 'Egress denied: untrusted text is not approval.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approved egress still leaves sent false and calls no provider', async () => {
  const { decideEgress } = await import('../dist/egress.js');
  const { recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  const egress = decideEgress({ setting: APPROVED });
  assert.equal(egress.decision, 'allow');
  assert.equal(egress.sent, false);

  try {
    const result = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      destination,
      setting: APPROVED,
      evaluate: seen.evaluate,
      actuate: seen.actuate,
      launch: seen.launch,
      sourceText: SOURCE_CANARY,
    });
    assert.equal(result.sent, false);
    assert.equal(result.file.sent, false);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);
    assert.equal(readFileSync(destination, 'utf8').includes(SOURCE_CANARY), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dangerous own key writes nothing', async () => {
  const { recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  const args = deniedArgs(
    {
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      destination,
      setting: APPROVED,
    },
    seen,
  );
  Object.defineProperty(args, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });

  try {
    const result = await recordObservation(args);
    assert.equal(result.reasonCode, 'MALFORMED');
    assert.equal(result.accepted, false);
    assert.equal(result.fileWritten, false);
    assert.equal(Object.hasOwn(result, 'message'), false);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(`${destination}.observe.tmp`), false);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readObservationFile rejects an extra key or applied true without echoing file text', async () => {
  const { readObservationFile } = await import('../dist/observe.js');
  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const marker = 'FILETEXT_do_not_echo';
  const base = {
    schemaVersion: '1.0',
    mode: 'observe',
    policyVersion: 'policy-observe-1',
    recommendedModel: null,
    actualModel: 'pinned-main',
    actualWorker: null,
    requestedModel: null,
    applied: false,
    appliedAction: null,
    toolPermission: false,
    sent: false,
    explanation: 'Egress denied: missing consent.',
  };
  const cases = [
    { ...base, extra: marker },
    { ...base, applied: true, explanation: marker },
    { ...base, sent: true, explanation: marker },
    { ...base, toolPermission: true, explanation: marker },
    { ...base, schemaVersion: '9.0', explanation: marker },
    JSON.parse(
      '{"schemaVersion":"1.0","mode":"observe","policyVersion":"policy-observe-1","recommendedModel":null,"actualModel":"pinned-main","actualWorker":null,"requestedModel":null,"applied":false,"appliedAction":null,"toolPermission":false,"sent":false,"explanation":"Egress denied: missing consent.","__proto__":{"note":"FILETEXT_do_not_echo"}}',
    ),
  ];

  try {
    for (const candidate of cases) {
      writeFileSync(destination, JSON.stringify(candidate));
      const read = await readObservationFile(destination);
      assert.equal(read.ok, false);
      assert.equal(read.reasonCode, 'SCHEMA_FAILURE');
      assert.deepEqual(Object.keys(read), ['ok', 'reasonCode']);
      assert.equal(JSON.stringify(read).includes(marker), false);
      assert.equal(Object.hasOwn(read, 'message'), false);
      assert.equal(Object.hasOwn(read, 'file'), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function hookFixture(name) {
  return new URL(`../../../fixtures/hooks/${name}`, import.meta.url);
}

function noDecisionDump(result) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'stdout']);
  return JSON.stringify(result);
}

test('PreModelSwitch records advice and emits no decision', async () => {
  const { handleHookEvent } = await import('../dist/hook-adapter.js');
  const { readObservationFile } = await import('../dist/observe.js');
  const fixtureUrl = hookFixture('pre-model-switch.json');
  const stdin = readFileSync(fixtureUrl, 'utf8');
  const parsedFixture = JSON.parse(stdin);
  assert.equal(parsedFixture.hook_event_name, 'PreModelSwitch');
  assert.equal(parsedFixture.from_model, 'pinned-main');
  assert.equal(parsedFixture.to_model, 'requested-other');

  const dir = tempDir();
  const destination = join(dir, 'observation.json');
  const { credential, presented, replay } = await issuedCaller();
  const seen = spies();
  let entryCalls = 0;

  try {
    const result = await handleHookEvent({
      stdin,
      nowMs: 1000,
      startedAtMs: 1000,
      pin: 'pinned-main',
      recommendedModel: 'claude-haiku-counterfactual',
      policyVersion: 'policy-observe-1',
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      replay,
      launcher: 'present',
      destination,
      setting: APPROVED,
      evaluate: seen.evaluate,
      actuate: seen.actuate,
      launch: seen.launch,
      runLocalRuntime() {
        entryCalls += 1;
      },
      sourceText: SOURCE_CANARY,
    });

    const dumped = noDecisionDump(result);
    assert.equal(dumped.includes('permission'), false);
    assert.equal(dumped.includes('block'), false);
    assert.equal(dumped.includes('system'), false);
    assert.equal(dumped.includes('pinned-main'), false);
    assert.equal(dumped.includes('requested-other'), false);
    assert.equal(dumped.includes('claude-haiku-counterfactual'), false);
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);
    assert.equal(entryCalls, 0);

    const text = readFileSync(destination, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.actualModel, 'pinned-main');
    assert.equal(parsed.requestedModel, 'requested-other');
    assert.equal(parsed.recommendedModel, 'claude-haiku-counterfactual');
    assert.notEqual(parsed.recommendedModel, 'requested-other');
    assert.equal(parsed.applied, false);
    assert.equal(parsed.sent, false);
    assert.equal(parsed.toolPermission, false);

    const read = await readObservationFile(destination);
    assert.equal(read.ok, true);
    assert.equal(read.file.actualModel, 'pinned-main');
    assert.equal(read.file.requestedModel, 'requested-other');
    assert.equal(read.file.recommendedModel, 'claude-haiku-counterfactual');

    const second = await issuedCaller();
    const secondDestination = join(dir, 'second.json');
    const altered = JSON.stringify({
      hook_event_name: 'PreModelSwitch',
      from_model: 'other-model',
      to_model: 'requested-other',
    });
    const again = await handleHookEvent({
      stdin: new TextEncoder().encode(altered),
      nowMs: 1000,
      startedAtMs: 1000,
      pin: 'pinned-main',
      recommendedModel: 'claude-haiku-counterfactual',
      policyVersion: 'policy-observe-1',
      presented: second.presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential: second.credential,
      replay: second.replay,
      launcher: 'present',
      destination: secondDestination,
      setting: APPROVED,
      evaluate: seen.evaluate,
      actuate: seen.actuate,
      launch: seen.launch,
      sourceText: SOURCE_CANARY,
    });
    assert.equal(again.exitCode, 0);
    assert.equal(again.stdout, '');
    const secondText = readFileSync(secondDestination, 'utf8');
    assert.equal(secondText.includes(SOURCE_CANARY), false);
    const secondParsed = JSON.parse(secondText);
    assert.equal(secondParsed.actualModel, 'pinned-main');
    assert.equal(secondParsed.requestedModel, 'requested-other');
    assert.equal(secondParsed.recommendedModel, 'claude-haiku-counterfactual');
    assert.equal(seen.calls.evaluate, 0);
    assert.equal(seen.calls.actuate, 0);
    assert.equal(seen.calls.launch, 0);
    assert.equal(entryCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STALE_MARKER = 'STALE_OBSERVATION_do_not_replay';

function plantedObservation(dir) {
  const destination = join(dir, 'observation.json');
  const planted = JSON.stringify({
    schemaVersion: '1.0',
    mode: 'observe',
    policyVersion: 'policy-observe-1',
    recommendedModel: STALE_MARKER,
    actualModel: 'pinned-main',
    actualWorker: null,
    requestedModel: null,
    applied: false,
    appliedAction: null,
    toolPermission: false,
    sent: false,
    explanation: STALE_MARKER,
  });
  writeFileSync(destination, planted);
  return { destination, planted };
}

async function expectNoReplay(overrides) {
  const { handleHookEvent } = await import('../dist/hook-adapter.js');
  const { recordObservation } = await import('../dist/observe.js');
  const dir = tempDir();
  const { destination, planted } = plantedObservation(dir);
  const { credential, presented, replay } = await issuedCaller();
  try {
    const result = await handleHookEvent({
      stdin: overrides.stdin,
      nowMs: overrides.nowMs ?? 1000,
      startedAtMs: overrides.startedAtMs ?? 1000,
      pin: 'pinned-main',
      recommendedModel: 'claude-haiku-counterfactual',
      policyVersion: 'policy-observe-1',
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      replay,
      launcher: overrides.launcher ?? 'present',
      destination,
      setting: APPROVED,
      sourceText: SOURCE_CANARY,
    });
    const dumped = noDecisionDump(result);
    assert.notEqual(result.exitCode, 2);
    assert.equal(dumped.includes('permission'), false);
    assert.equal(dumped.includes(STALE_MARKER), false);
    assert.equal(dumped.includes('pinned-main'), false);
    assert.equal(dumped.includes('requested-other'), false);
    assert.equal(readFileSync(destination, 'utf8'), planted);
    assert.equal(existsSync(`${destination}.observe.tmp`), false);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.observe.tmp')).length, 0);

    const probe = await recordObservation({
      mode: 'observe',
      policyVersion: 'policy-observe-1',
      recommendedModel: 'claude-haiku-counterfactual',
      actualModel: 'pinned-main',
      requestedModel: null,
      presented,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      destination: join(dir, 'probe.json'),
      setting: APPROVED,
    });
    assert.equal(probe.accepted, true);
    assert.equal(probe.reasonCode, null);
    assert.equal(readFileSync(destination, 'utf8'), planted);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('invalid JSON, oversize stdin, an unknown event, and a deadline miss do not replay a record', async () => {
  const { MAX_REQUEST_BYTES } = await import('../../contracts/dist/index.js');
  const valid = JSON.stringify({
    hook_event_name: 'PreModelSwitch',
    from_model: 'pinned-main',
    to_model: 'requested-other',
  });
  const pad = 'x'.repeat(MAX_REQUEST_BYTES);
  const oversize = `{"hook_event_name":"PreModelSwitch","from_model":"pinned-main","to_model":"${pad}"}`;
  assert.equal(Buffer.byteLength(oversize) > MAX_REQUEST_BYTES, true);

  await expectNoReplay({ stdin: '{not-json' });
  await expectNoReplay({ stdin: oversize });
  await expectNoReplay({
    stdin: JSON.stringify({
      hook_event_name: 'PreToolUse',
      from_model: 'pinned-main',
      to_model: 'requested-other',
    }),
  });
  await expectNoReplay({ stdin: valid, nowMs: 1900, startedAtMs: 1000 });
  await expectNoReplay({ stdin: valid, nowMs: 1000, startedAtMs: 1001 });
});

test('a missing launcher does not read or write an observation', async () => {
  const stdin = readFileSync(hookFixture('pre-model-switch.json'), 'utf8');
  await expectNoReplay({ stdin, launcher: 'missing' });
});

test('command hook descriptor is uninstalled and the adapter has no decision surface', async () => {
  const hookUrl = hookFixture('command-hook.json');
  const text = readFileSync(hookUrl, 'utf8');
  const hook = JSON.parse(text);
  assert.equal(hook.type, 'command');
  assert.equal(hook.timeout, 2);
  assert.equal(Number.isInteger(hook.timeout), true);
  assert.equal(text.includes('npx'), false);
  assert.equal(Object.hasOwn(hook, 'hooks'), false);
  assert.equal(hookUrl.pathname.includes('/fixtures/hooks/'), true);
  assert.equal(hookUrl.pathname.includes('/plugins/'), false);
  const { assertProductHooksAbsentOrCertified } = await import(new URL('../../../apps/cli/test/product-hooks.mjs', import.meta.url));
  await assertProductHooksAbsentOrCertified();
});
