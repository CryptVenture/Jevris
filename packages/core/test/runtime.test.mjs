import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every scratch directory is removed, even when a test fails before its own cleanup runs; set
// JEVRIS_KEEP_TEST_DIRS=1 to keep them for debugging.
const scratchDirs = new Set();
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.add(dir);
  return dir;
}
function removeScratch(dir) {
  if (process.env.JEVRIS_KEEP_TEST_DIRS === '1') return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  scratchDirs.delete(dir);
}
after(() => {
  for (const dir of [...scratchDirs]) removeScratch(dir);
});

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/runtime/off-fallback.json', import.meta.url), 'utf8'),
);

const SOURCE_CANARY = 'SOURCE_CANARY_do_not_store';

function counters() {
  const port = { calls: 0 };
  port.evaluate = () => {
    port.calls += 1;
    return { receivedAtMs: 0, body: null };
  };
  const alternatePort = { calls: 0 };
  alternatePort.evaluate = () => {
    alternatePort.calls += 1;
  };
  const sourceOpener = { calls: 0 };
  sourceOpener.open = () => {
    sourceOpener.calls += 1;
  };
  const workLauncher = { calls: 0 };
  workLauncher.launch = () => {
    workLauncher.calls += 1;
  };
  const actuator = { calls: 0 };
  actuator.actuate = () => {
    actuator.calls += 1;
  };
  const probe = { calls: 0 };
  const callProbe = () => {
    probe.calls += 1;
  };
  return { port, alternatePort, sourceOpener, workLauncher, actuator, probe, callProbe };
}

test('off fallback writes the fixture and a replayed token writes nothing', async () => {
  const {
    authorizeLocalCaller,
    createAntiReplayStore,
    issueLocalCallerToken,
    readFallbackFile,
    runLocalRuntime,
  } = await import('../dist/runtime.js');

  const issued = issueLocalCallerToken({
    user: 'dev-one',
    pid: 4242,
    nowMs: 1000,
    expiresAtMs: 5000,
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.token.byteLength, 32);

  const dir = scratchDir('jevris-off-');
  const destination = join(dir, 'fallback.json');
  const seen = counters();
  const replay = createAntiReplayStore();
  const credential = {
    user: 'dev-one',
    pid: 4242,
    expiresAtMs: 5000,
    token: issued.token,
  };
  const caller = {
    host: 'localhost',
    user: 'dev-one',
    pid: 4242,
    token: issued.token,
  };

  const accepted = authorizeLocalCaller(caller, 'dev-one', 4242, credential, 1000, false);
  assert.equal(accepted.decision, 'accept');
  assert.equal(accepted.consume, true);
  assert.equal(Object.hasOwn(accepted, 'token'), false);

  try {
    const result = await runLocalRuntime({
      mode: 'off',
      caller,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      approvedModel: 'jev-1.13.0',
      providerRoute: 'providerDirect',
      policyVersion: 'policyV1',
      networkPolicy: 'allowed',
      availability: 'available',
      outages: {
        seen() {
          return false;
        },
        mark() {},
      },
      probes: {
        probed() {
          return false;
        },
        mark() {},
      },
      destination,
      port: seen.port,
      alternatePort: seen.alternatePort,
      sourceOpener: seen.sourceOpener,
      workLauncher: seen.workLauncher,
      actuator: seen.actuator,
      probe: seen.callProbe,
      sourceText: SOURCE_CANARY,
    });

    assert.equal(result.reasonCode, null);
    assert.equal(result.interrupt, false);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.workLauncher.calls, 0);
    assert.equal(seen.actuator.calls, 0);
    assert.equal(seen.probe.calls, 0);
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.equal(Object.hasOwn(result, 'sourceText'), false);
    assert.equal(Object.hasOwn(result, 'message'), false);

    const bytes = readFileSync(destination);
    const text = new TextDecoder().decode(bytes);
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes(Buffer.from(issued.token).toString('hex')), false);
    assert.equal(text.includes(Buffer.from(issued.token).toString('utf8')), false);
    assert.deepEqual(JSON.parse(text), fixture);

    const read = await readFallbackFile(destination);
    assert.equal(read.ok, true);
    assert.equal(Object.hasOwn(read, 'message'), false);
    assert.deepEqual(read.file, fixture);

    const before = readFileSync(destination);
    const again = await runLocalRuntime({
      mode: 'off',
      caller,
      expectedUser: 'dev-one',
      expectedPid: 4242,
      credential,
      nowMs: 1000,
      replay,
      approvedModel: 'jev-1.13.0',
      providerRoute: 'providerDirect',
      policyVersion: 'policyV1',
      networkPolicy: 'allowed',
      availability: 'available',
      outages: {
        seen() {
          return false;
        },
        mark() {},
      },
      probes: {
        probed() {
          return false;
        },
        mark() {},
      },
      destination,
      port: seen.port,
      alternatePort: seen.alternatePort,
      sourceOpener: seen.sourceOpener,
      workLauncher: seen.workLauncher,
      actuator: seen.actuator,
      probe: seen.callProbe,
      sourceText: SOURCE_CANARY,
    });

    assert.equal(again.reasonCode, 'REPLAYED_TOKEN');
    assert.equal(again.decision, 'reject');
    assert.equal(Object.hasOwn(again, 'token'), false);
    assert.equal(Object.hasOwn(again, 'sourceText'), false);
    assert.equal(Object.hasOwn(again, 'message'), false);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.port.calls, 0);
    assert.deepEqual(readFileSync(destination), before);
    assert.deepEqual(readdirSync(dir), ['fallback.json']);
  } finally {
    removeScratch(dir);
  }
});

const NOT_READY_EXPLANATION = 'Rules-only fallback: mode is not ready. No provider call was made.';

async function freshRuntime(mode, destination, callerExtra) {
  const runtime = await import('../dist/runtime.js');
  const issued = runtime.issueLocalCallerToken({
    user: 'dev-one',
    pid: 4242,
    nowMs: 1000,
    expiresAtMs: 5000,
  });
  assert.equal(issued.ok, true);
  const seen = counters();
  let recorded = 0;
  const caller = {
    host: 'localhost',
    user: 'dev-one',
    pid: 4242,
    token: issued.token,
  };
  if (callerExtra !== undefined) callerExtra(caller);
  const args = {
    mode,
    caller,
    expectedUser: 'dev-one',
    expectedPid: 4242,
    credential: {
      user: 'dev-one',
      pid: 4242,
      expiresAtMs: 5000,
      token: issued.token,
    },
    nowMs: 1000,
    replay: runtime.createAntiReplayStore(),
    approvedModel: 'jev-1.13.0',
    providerRoute: 'providerDirect',
    policyVersion: 'policyV1',
    networkPolicy: 'allowed',
    availability: 'available',
    outages: {
      seen() {
        return false;
      },
      mark() {},
    },
    probes: {
      probed() {
        return false;
      },
      mark() {},
    },
    destination,
    port: seen.port,
    alternatePort: seen.alternatePort,
    sourceOpener: seen.sourceOpener,
    workLauncher: seen.workLauncher,
    actuator: seen.actuator,
    probe: seen.callProbe,
    ledger: {
      recordDecision() {
        recorded += 1;
      },
    },
    sourceText: SOURCE_CANARY,
  };
  return { runtime, issued, seen, args, recorded: () => recorded };
}

test('a mode other than ready makes no provider call and writes no observe recommendation', async () => {
  const dir = scratchDir('jevris-mode-');
  try {
    for (const mode of ['observe', 'OFF', '']) {
      const destination = join(dir, `fallback-${mode.length}.json`);
      const { runtime, seen, args } = await freshRuntime(mode, destination);
      const result = await runtime.runLocalRuntime(args);
      assert.equal(result.explanation, NOT_READY_EXPLANATION);
      assert.equal(result.explanation.includes(mode), mode === '');
      assert.equal(result.applied, false);
      assert.equal(result.toolPermission, false);
      assert.equal(result.interrupt, false);
      assert.equal(result.fileWritten, false);
      assert.equal(seen.port.calls, 0);
      assert.equal(seen.alternatePort.calls, 0);
      assert.equal(seen.actuator.calls, 0);
      assert.equal(seen.probe.calls, 0);
      assert.equal(existsSync(destination), false);
      assert.equal(JSON.stringify(result).includes('observe'), false);
    }
  } finally {
    removeScratch(dir);
  }
});

test('mode ready is withheld and does not call recordDecision', async () => {
  const dir = scratchDir('jevris-ready-');
  const destination = join(dir, 'fallback.json');
  try {
    const { runtime, seen, args, recorded } = await freshRuntime('ready', destination);
    const result = await runtime.runLocalRuntime(args);
    assert.equal(result.accepted, true);
    assert.equal(result.reasonCode, null);
    assert.equal(result.fileWritten, false);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.sent, false);
    assert.equal(result.interrupt, false);
    assert.equal(seen.port.calls, 0);
    assert.equal(recorded(), 0);
    assert.equal(existsSync(destination), false);
  } finally {
    removeScratch(dir);
  }
});

test('a presented dangerous key is malformed and writes nothing', async () => {
  const dir = scratchDir('jevris-danger-');
  const destination = join(dir, 'fallback.json');
  try {
    const { runtime, seen, args } = await freshRuntime('off', destination, (caller) => {
      Object.defineProperty(caller, '__proto__', {
        value: { polluted: true },
        enumerable: true,
      });
    });
    const result = await runtime.runLocalRuntime(args);
    assert.equal(result.reasonCode, 'MALFORMED');
    assert.equal(result.decision, 'reject');
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.equal(Object.hasOwn(result, 'message'), false);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.port.calls, 0);
    assert.equal(existsSync(destination), false);

    const top = await freshRuntime('off', destination);
    Object.defineProperty(top.args, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    const topResult = await top.runtime.runLocalRuntime(top.args);
    assert.equal(topResult.reasonCode, 'MALFORMED');
    assert.equal(existsSync(destination), false);
  } finally {
    removeScratch(dir);
  }
});

function runtimeArgs(seen, destination, caller, credential, replay, nowMs) {
  return {
    mode: 'off',
    caller,
    expectedUser: 'dev-one',
    expectedPid: 4242,
    credential,
    nowMs,
    replay,
    approvedModel: 'jev-1.13.0',
    providerRoute: 'providerDirect',
    policyVersion: 'policyV1',
    networkPolicy: 'allowed',
    availability: 'available',
    outages: {
      seen() {
        return false;
      },
      mark() {},
    },
    probes: {
      probed() {
        return false;
      },
      mark() {},
    },
    destination,
    port: seen.port,
    alternatePort: seen.alternatePort,
    sourceOpener: seen.sourceOpener,
    workLauncher: seen.workLauncher,
    actuator: seen.actuator,
    probe: seen.callProbe,
    sourceText: SOURCE_CANARY,
  };
}

function assertRejected(result, seen, destination, reasonCode, token) {
  assert.equal(result.decision, 'reject');
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(result.accepted, false);
  assert.equal(result.fileWritten, false);
  assert.equal(seen.sourceOpener.calls, 0);
  assert.equal(seen.workLauncher.calls, 0);
  assert.equal(seen.port.calls, 0);
  assert.equal(seen.alternatePort.calls, 0);
  assert.equal(seen.actuator.calls, 0);
  assert.equal(seen.probe.calls, 0);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(`${destination}.tmp`), false);
  assert.equal(Object.hasOwn(result, 'token'), false);
  assert.equal(Object.hasOwn(result, 'source'), false);
  assert.equal(Object.hasOwn(result, 'message'), false);
  assert.equal(Object.hasOwn(result, 'host'), false);
  const text = JSON.stringify(result);
  assert.equal(text.includes(SOURCE_CANARY), false);
  if (token instanceof Uint8Array && token.byteLength > 0) {
    assert.equal(text.includes(Buffer.from(token).toString('hex')), false);
  }
}

test('localhost without user, pid, and token is rejected before any source read', async () => {
  const { authorizeLocalCaller, createAntiReplayStore, issueLocalCallerToken, runLocalRuntime } =
    await import('../dist/runtime.js');
  assert.equal(authorizeLocalCaller.length, 6);

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
  const dir = scratchDir('jevris-scope-');
  const destination = join(dir, 'fallback.json');
  const sourcePath = join(dir, 'source.txt');
  writeFileSync(sourcePath, SOURCE_CANARY);
  const seen = counters();
  const replay = createAntiReplayStore();

  try {
    const cases = [
      {
        name: 'localhost',
        caller: { host: 'localhost', source: sourcePath },
        reason: 'LOCALHOST_ONLY',
      },
      {
        name: 'ipv4',
        caller: { host: '127.0.0.1', source: sourcePath },
        reason: 'LOCALHOST_ONLY',
      },
      {
        name: 'ipv6',
        caller: { host: '::1', source: sourcePath },
        reason: 'LOCALHOST_ONLY',
      },
      {
        name: 'routable',
        caller: { host: '192.0.2.1', source: sourcePath },
        reason: 'MISSING_USER',
      },
      {
        name: 'user',
        caller: {
          host: 'localhost',
          user: 'other-dev',
          pid: 4242,
          token: issued.token,
          source: sourcePath,
        },
        reason: 'USER_MISMATCH',
      },
      {
        name: 'pid-missing',
        caller: { host: 'localhost', user: 'dev-one', source: sourcePath },
        reason: 'MISSING_PID',
      },
      {
        name: 'pid',
        caller: {
          host: 'localhost',
          user: 'dev-one',
          pid: 9999,
          token: issued.token,
          source: sourcePath,
        },
        reason: 'PID_MISMATCH',
      },
    ];

    for (const item of cases) {
      const auth = authorizeLocalCaller(item.caller, 'dev-one', 4242, credential, 1000, false);
      assert.equal(auth.decision, 'reject', item.name);
      assert.equal(auth.reasonCode, item.reason, item.name);
      assert.equal(Object.hasOwn(auth, 'host'), false, item.name);
      assert.equal(Object.hasOwn(auth, 'token'), false, item.name);
      const result = await runLocalRuntime(
        runtimeArgs(seen, destination, item.caller, credential, replay, 1000),
      );
      assertRejected(result, seen, destination, item.reason, issued.token);
      assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY, item.name);
    }

    const credentialUserCaller = {
      host: 'localhost',
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
      source: sourcePath,
    };
    const credentialUser = {
      user: 'other-dev',
      pid: 4242,
      expiresAtMs: 5000,
      token: issued.token,
    };
    const userAuth = authorizeLocalCaller(
      credentialUserCaller,
      'dev-one',
      4242,
      credentialUser,
      1000,
      false,
    );
    assert.equal(userAuth.reasonCode, 'USER_MISMATCH');
    const userResult = await runLocalRuntime(
      runtimeArgs(seen, destination, credentialUserCaller, credentialUser, replay, 1000),
    );
    assertRejected(userResult, seen, destination, 'USER_MISMATCH', issued.token);

    const credentialPid = {
      user: 'dev-one',
      pid: 1111,
      expiresAtMs: 5000,
      token: issued.token,
    };
    const pidAuth = authorizeLocalCaller(
      credentialUserCaller,
      'dev-one',
      4242,
      credentialPid,
      1000,
      false,
    );
    assert.equal(pidAuth.reasonCode, 'PID_MISMATCH');
    const pidResult = await runLocalRuntime(
      runtimeArgs(seen, destination, credentialUserCaller, credentialPid, replay, 1000),
    );
    assertRejected(pidResult, seen, destination, 'PID_MISMATCH', issued.token);
    assert.deepEqual(readdirSync(dir).sort(), ['source.txt']);

    const matching = {
      host: 'localhost',
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
      source: sourcePath,
    };
    const accepted = authorizeLocalCaller(matching, 'dev-one', 4242, credential, 1000, false);
    assert.equal(accepted.decision, 'accept');
    assert.equal(accepted.consume, true);
    assert.equal(Object.hasOwn(accepted, 'host'), false);
    assert.equal(Object.hasOwn(accepted, 'reasonCode'), false);

    const off = await runLocalRuntime(runtimeArgs(seen, destination, matching, credential, replay, 1000));
    assert.equal(off.decision, 'fallback');
    assert.equal(off.reasonCode, null);
    assert.equal(off.fileWritten, true);
    assert.equal(Object.hasOwn(off, 'host'), false);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.workLauncher.calls, 0);
    assert.equal(seen.port.calls, 0);
    assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY);
    assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), fixture);
    assert.equal(readFileSync(destination, 'utf8').includes(SOURCE_CANARY), false);
  } finally {
    removeScratch(dir);
  }
});

test('a missing, short, or mismatched token is rejected without a throw', async () => {
  const { authorizeLocalCaller, createAntiReplayStore, issueLocalCallerToken, runLocalRuntime } =
    await import('../dist/runtime.js');
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
  const mismatched = new Uint8Array(issued.token);
  mismatched[0] = mismatched[0] ^ 0xff;
  const dir = scratchDir('jevris-token-');
  const destination = join(dir, 'fallback.json');
  const sourcePath = join(dir, 'source.txt');
  writeFileSync(sourcePath, SOURCE_CANARY);
  const seen = counters();
  const replay = createAntiReplayStore();
  const scope = { host: 'localhost', user: 'dev-one', pid: 4242, source: sourcePath };

  try {
    const cases = [
      { name: 'missing', token: undefined, reason: 'MISSING_TOKEN' },
      { name: 'empty', token: new Uint8Array(0), reason: 'TOKEN_MISMATCH' },
      { name: 'short', token: new Uint8Array(16), reason: 'TOKEN_MISMATCH' },
      { name: 'long', token: new Uint8Array(33), reason: 'TOKEN_MISMATCH' },
      { name: 'empty-string', token: '', reason: 'TOKEN_MISMATCH' },
      { name: 'non-byte', token: 'not-bytes', reason: 'TOKEN_MISMATCH' },
      { name: 'mismatch', token: mismatched, reason: 'TOKEN_MISMATCH' },
    ];

    for (const item of cases) {
      const caller = { ...scope };
      if (item.token !== undefined) caller.token = item.token;
      assert.doesNotThrow(() => {
        const auth = authorizeLocalCaller(caller, 'dev-one', 4242, credential, 1000, false);
        assert.equal(auth.decision, 'reject', item.name);
        assert.equal(auth.reasonCode, item.reason, item.name);
        assert.equal(Object.hasOwn(auth, 'token'), false, item.name);
      }, item.name);
      const result = await runLocalRuntime(
        runtimeArgs(seen, destination, caller, credential, replay, 1000),
      );
      assertRejected(result, seen, destination, item.reason, issued.token);
      assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY, item.name);
    }

    const nullCredential = authorizeLocalCaller(
      { ...scope, token: issued.token },
      'dev-one',
      4242,
      null,
      1000,
      false,
    );
    assert.equal(nullCredential.reasonCode, 'MISSING_TOKEN');
    const nullResult = await runLocalRuntime(
      runtimeArgs(seen, destination, { ...scope, token: issued.token }, null, replay, 1000),
    );
    assertRejected(nullResult, seen, destination, 'MISSING_TOKEN', issued.token);
    assert.equal(existsSync(destination), false);
  } finally {
    removeScratch(dir);
  }
});

test('a stale or replayed token is rejected and does not open source', async () => {
  const { authorizeLocalCaller, createAntiReplayStore, issueLocalCallerToken, runLocalRuntime } =
    await import('../dist/runtime.js');
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
  const caller = {
    host: 'localhost',
    user: 'dev-one',
    pid: 4242,
    token: issued.token,
  };
  const dir = scratchDir('jevris-stale-');
  const destination = join(dir, 'fallback.json');
  const sourcePath = join(dir, 'source.txt');
  writeFileSync(sourcePath, SOURCE_CANARY);
  caller.source = sourcePath;
  const seen = counters();
  const replay = createAntiReplayStore();

  try {
    for (const nowMs of [5000, 5001]) {
      const auth = authorizeLocalCaller(caller, 'dev-one', 4242, credential, nowMs, false);
      assert.equal(auth.reasonCode, 'STALE_TOKEN');
      const result = await runLocalRuntime(
        runtimeArgs(seen, destination, caller, credential, replay, nowMs),
      );
      assertRejected(result, seen, destination, 'STALE_TOKEN', issued.token);
    }

    const undated = {
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
    };
    const undatedAuth = authorizeLocalCaller(caller, 'dev-one', 4242, undated, 1000, false);
    assert.equal(undatedAuth.reasonCode, 'STALE_TOKEN');
    const undatedResult = await runLocalRuntime(
      runtimeArgs(seen, destination, caller, undated, replay, 1000),
    );
    assertRejected(undatedResult, seen, destination, 'STALE_TOKEN', issued.token);
    assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY);

    const fresh = createAntiReplayStore();
    const written = await runLocalRuntime(
      runtimeArgs(seen, destination, caller, credential, fresh, 1000),
    );
    assert.equal(written.decision, 'fallback');
    assert.equal(written.fileWritten, true);
    const before = readFileSync(destination);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(before)), fixture);
    const again = await runLocalRuntime(
      runtimeArgs(seen, destination, caller, credential, fresh, 1000),
    );
    assert.equal(again.reasonCode, 'REPLAYED_TOKEN');
    assert.equal(again.decision, 'reject');
    assert.equal(Object.hasOwn(again, 'token'), false);
    assert.equal(Object.hasOwn(again, 'source'), false);
    assert.equal(Object.hasOwn(again, 'message'), false);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.workLauncher.calls, 0);
    assert.equal(seen.port.calls, 0);
    assert.deepEqual(readFileSync(destination), before);
    assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY);
    assert.deepEqual(readdirSync(dir).sort(), ['fallback.json', 'source.txt']);
  } finally {
    removeScratch(dir);
  }
});

test('a rejected call does not consume a different fresh token', async () => {
  const { createAntiReplayStore, issueLocalCallerToken, runLocalRuntime } = await import('../dist/runtime.js');
  const kept = issueLocalCallerToken({
    user: 'dev-one',
    pid: 4242,
    nowMs: 1000,
    expiresAtMs: 5000,
  });
  assert.equal(kept.ok, true);
  const credential = {
    user: 'dev-one',
    pid: 4242,
    expiresAtMs: 5000,
    token: kept.token,
  };
  const other = new Uint8Array(32);
  other[0] = kept.token[0] ^ 0xff;
  const dir = scratchDir('jevris-keep-');
  const destination = join(dir, 'fallback.json');
  const sourcePath = join(dir, 'source.txt');
  writeFileSync(sourcePath, SOURCE_CANARY);
  const seen = counters();
  const replay = createAntiReplayStore();

  try {
    const presented = [
      { host: 'localhost', user: 'dev-one', pid: 4242, token: new Uint8Array(8), source: sourcePath },
      { host: 'localhost', user: 'dev-one', pid: 4242, token: other, source: sourcePath },
      { host: 'localhost', source: sourcePath },
    ];
    for (const caller of presented) {
      const result = await runLocalRuntime(
        runtimeArgs(seen, destination, caller, credential, replay, 1000),
      );
      assert.equal(result.decision, 'reject');
      assert.equal(result.fileWritten, false);
      assert.equal(seen.sourceOpener.calls, 0);
      assert.equal(seen.workLauncher.calls, 0);
      assert.equal(existsSync(destination), false);
      assert.equal(Object.hasOwn(result, 'token'), false);
      assert.equal(Object.hasOwn(result, 'source'), false);
      assert.equal(Object.hasOwn(result, 'message'), false);
    }

    const accepted = await runLocalRuntime(
      runtimeArgs(
        seen,
        destination,
        {
          host: 'localhost',
          user: 'dev-one',
          pid: 4242,
          token: kept.token,
          source: sourcePath,
        },
        credential,
        replay,
        1000,
      ),
    );
    assert.equal(accepted.decision, 'fallback');
    assert.equal(accepted.reasonCode, null);
    assert.equal(accepted.fileWritten, true);
    assert.equal(seen.sourceOpener.calls, 0);
    assert.equal(seen.workLauncher.calls, 0);
    assert.equal(readFileSync(sourcePath, 'utf8'), SOURCE_CANARY);
    assert.equal(JSON.stringify(accepted).includes(Buffer.from(kept.token).toString('hex')), false);
  } finally {
    removeScratch(dir);
  }
});

const BODY_CANARY = 'BODY_CANARY_do_not_store';
const TIMEOUT_EXPLANATION =
  'Rules-only fallback: provider timeout. Coding continues on the approved model.';
const OVERLOAD_EXPLANATION =
  'Rules-only fallback: provider overload. Coding continues on the approved model.';
const PROHIBITED_EXPLANATION =
  'Rules-only fallback: network policy prohibits the provider. Coding continues on the approved model.';
const UNAVAILABLE_EXPLANATIONS = [TIMEOUT_EXPLANATION, OVERLOAD_EXPLANATION, PROHIBITED_EXPLANATION];

function assertNoHiddenProvider(seen, recorded) {
  assert.equal(seen.port.calls, 0);
  assert.equal(seen.alternatePort.calls, 0);
  assert.equal(seen.actuator.calls, 0);
  assert.equal(seen.probe.calls, 0);
  assert.equal(seen.sourceOpener.calls, 0);
  assert.equal(seen.workLauncher.calls, 0);
  assert.equal(recorded(), 0);
}

function assertClosedFile(text, file, errorClass, explanation, approvedModel) {
  assert.equal(text.includes(BODY_CANARY), false);
  assert.equal(text.includes(SOURCE_CANARY), false);
  assert.equal(file.schemaVersion, fixture.schemaVersion);
  assert.equal(file.mode, 'unavailable');
  assert.equal(file.errorClass, errorClass);
  assert.equal(file.explanation, explanation);
  assert.equal(file.applied, false);
  assert.equal(file.toolPermission, false);
  assert.equal(file.approvedModel, approvedModel);
  assert.equal(file.providerRoute, 'providerDirect');
  assert.equal(file.policyVersion, 'policyV1');
  assert.equal(file.cacheReused, false);
  assert.equal(file.actuationResumed, false);
  assert.equal(file.restore, 'none');
  assert.equal(file.cachedChoice, null);
  assert.equal(typeof file.interrupt, 'boolean');
  assert.deepEqual(Object.keys(file), Object.keys(fixture));
  assert.equal(Object.hasOwn(file, 'body'), false);
  assert.equal(Object.hasOwn(file, 'token'), false);
  assert.equal(Object.hasOwn(file, 'message'), false);
  assert.equal(Object.hasOwn(file, 'sourceText'), false);
}

test('timeout, overload, and prohibited record a rules-only class and call no provider', async () => {
  const dir = scratchDir('jevris-unavailable-');
  try {
    const cases = [
      {
        name: 'timeout',
        errorClass: 'timeout',
        explanation: TIMEOUT_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'timeout', networkPolicy: 'allowed' },
      },
      {
        name: 'injected-model',
        errorClass: 'timeout',
        explanation: TIMEOUT_EXPLANATION,
        approvedModel: 'jev-keep-injected',
        patch: {
          availability: 'timeout',
          networkPolicy: 'allowed',
          approvedModel: 'jev-keep-injected',
        },
      },
      {
        name: 'overload',
        errorClass: 'overload',
        explanation: OVERLOAD_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'available', networkPolicy: 'allowed', status: 529 },
      },
      {
        name: 'prohibited',
        errorClass: 'prohibited',
        explanation: PROHIBITED_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'available', networkPolicy: 'prohibited' },
      },
      {
        name: 'prohibited-over-529',
        errorClass: 'prohibited',
        explanation: PROHIBITED_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'available', networkPolicy: 'prohibited', status: 529 },
      },
      {
        name: 'timeout-over-529',
        errorClass: 'timeout',
        explanation: TIMEOUT_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'timeout', networkPolicy: 'allowed', status: 529 },
      },
      {
        name: 'prohibited-over-timeout',
        errorClass: 'prohibited',
        explanation: PROHIBITED_EXPLANATION,
        approvedModel: 'jev-1.13.0',
        patch: { availability: 'timeout', networkPolicy: 'prohibited', status: 529 },
      },
    ];

    for (const item of cases) {
      const destination = join(dir, `${item.name}.json`);
      const { runtime, seen, args, recorded } = await freshRuntime('ready', destination, (caller) => {
        caller.body = BODY_CANARY;
      });
      args.body = BODY_CANARY;
      Object.assign(args, item.patch);
      const result = await runtime.runLocalRuntime(args);
      assert.equal(result.decision, 'fallback', item.name);
      assert.equal(result.applied, false, item.name);
      assert.equal(result.toolPermission, false, item.name);
      assert.equal(result.sent, false, item.name);
      assert.equal(result.explanation, item.explanation, item.name);
      assert.equal(result.errorClass, item.errorClass, item.name);
      assert.equal(existsSync(destination), true, item.name);
      assertNoHiddenProvider(seen, recorded);
      const text = readFileSync(destination, 'utf8');
      const file = JSON.parse(text);
      assertClosedFile(text, file, item.errorClass, item.explanation, item.approvedModel);
      const read = await runtime.readFallbackFile(destination);
      assert.equal(read.ok, true, item.name);
      assert.equal(read.file.errorClass, item.errorClass, item.name);
      assert.equal(read.file.explanation, item.explanation, item.name);
      assert.equal(text.includes(item.approvedModel), true, item.name);
    }

    const offDestination = join(dir, 'off.json');
    const off = await freshRuntime('off', offDestination, (caller) => {
      caller.body = BODY_CANARY;
    });
    off.args.body = BODY_CANARY;
    off.args.availability = 'timeout';
    off.args.networkPolicy = 'prohibited';
    off.args.status = 529;
    const offResult = await off.runtime.runLocalRuntime(off.args);
    assert.equal(offResult.interrupt, false);
    assert.equal(offResult.explanation, fixture.explanation);
    assert.equal(existsSync(offDestination), true);
    const offText = readFileSync(offDestination, 'utf8');
    assert.deepEqual(JSON.parse(offText), fixture);
    for (const explanation of UNAVAILABLE_EXPLANATIONS) {
      assert.equal(offText.includes(explanation), false);
    }
    assert.equal(offText.includes(BODY_CANARY), false);
    assertNoHiddenProvider(off.seen, off.recorded);
  } finally {
    removeScratch(dir);
  }
});

const THROWN_ALTERNATE = 'THROWN_ALTERNATE_do_not_store';

function outageMemory() {
  const triples = [];
  return {
    triples,
    seen(errorClass, providerRoute, policyVersion) {
      return triples.some(
        (item) =>
          item.errorClass === errorClass &&
          item.providerRoute === providerRoute &&
          item.policyVersion === policyVersion,
      );
    },
    mark(errorClass, providerRoute, policyVersion) {
      triples.push({ errorClass, providerRoute, policyVersion });
    },
  };
}

function shareCounters(args, seen) {
  args.port = seen.port;
  args.alternatePort = seen.alternatePort;
  args.sourceOpener = seen.sourceOpener;
  args.workLauncher = seen.workLauncher;
  args.actuator = seen.actuator;
  args.probe = seen.callProbe;
}

test('the same outage interrupts once and does not call a provider again', async () => {
  const dir = scratchDir('jevris-once-');
  const firstDest = join(dir, 'first.json');
  const secondDest = join(dir, 'second.json');
  const memory = outageMemory();
  const seen = counters();
  seen.alternatePort.evaluate = () => {
    seen.alternatePort.calls += 1;
    throw new Error(THROWN_ALTERNATE);
  };
  try {
    const first = await freshRuntime('ready', firstDest, (caller) => {
      caller.body = BODY_CANARY;
    });
    shareCounters(first.args, seen);
    first.args.outages = memory;
    first.args.availability = 'timeout';
    first.args.sourceText = SOURCE_CANARY;
    const firstResult = await first.runtime.runLocalRuntime(first.args);
    assert.equal(firstResult.interrupt, true);
    assert.equal(firstResult.errorClass, 'timeout');
    assert.equal(firstResult.fileWritten, true);
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);
    assert.equal(first.recorded(), 0);
    const firstText = readFileSync(firstDest, 'utf8');
    const firstFile = JSON.parse(firstText);
    assert.equal(firstFile.interrupt, true);
    assert.equal(firstFile.errorClass, 'timeout');
    assert.equal(firstText.includes(THROWN_ALTERNATE), false);
    assert.equal(firstText.includes(BODY_CANARY), false);
    assert.equal(firstText.includes(SOURCE_CANARY), false);
    assert.deepEqual(memory.triples, [
      { errorClass: 'timeout', providerRoute: 'providerDirect', policyVersion: 'policyV1' },
    ]);

    const second = await freshRuntime('ready', secondDest, (caller) => {
      caller.body = BODY_CANARY;
    });
    shareCounters(second.args, seen);
    second.args.outages = memory;
    second.args.availability = 'timeout';
    second.args.sourceText = 'OTHER_SOURCE_do_not_store';
    const secondResult = await second.runtime.runLocalRuntime(second.args);
    assert.equal(secondResult.interrupt, false);
    assert.equal(secondResult.errorClass, 'timeout');
    assert.equal(secondResult.fileWritten, true);
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);
    assert.equal(second.recorded(), 0);
    const secondText = readFileSync(secondDest, 'utf8');
    const secondFile = JSON.parse(secondText);
    assert.equal(secondFile.interrupt, false);
    assert.equal(secondFile.errorClass, 'timeout');
    assert.equal(secondFile.mode, 'unavailable');
    assert.equal(secondText.includes(THROWN_ALTERNATE), false);
    assert.equal(secondText.includes('OTHER_SOURCE_do_not_store'), false);
    assert.equal(memory.triples.length, 1);
  } finally {
    removeScratch(dir);
  }
});

test('a different error class interrupts once and off does not consume the triple', async () => {
  const dir = scratchDir('jevris-triple-');
  const memory = outageMemory();
  const seen = counters();
  try {
    const timeoutDest = join(dir, 'timeout.json');
    const timeout = await freshRuntime('ready', timeoutDest);
    shareCounters(timeout.args, seen);
    timeout.args.outages = memory;
    timeout.args.availability = 'timeout';
    const timeoutResult = await timeout.runtime.runLocalRuntime(timeout.args);
    assert.equal(timeoutResult.interrupt, true);
    assert.equal(timeoutResult.errorClass, 'timeout');

    const overloadDest = join(dir, 'overload.json');
    const overload = await freshRuntime('ready', overloadDest);
    shareCounters(overload.args, seen);
    overload.args.outages = memory;
    overload.args.availability = 'available';
    overload.args.status = 529;
    const overloadResult = await overload.runtime.runLocalRuntime(overload.args);
    assert.equal(overloadResult.interrupt, true);
    assert.equal(overloadResult.errorClass, 'overload');
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);

    const timeoutAgain = await freshRuntime('ready', join(dir, 'timeout-again.json'));
    shareCounters(timeoutAgain.args, seen);
    timeoutAgain.args.outages = memory;
    timeoutAgain.args.availability = 'timeout';
    const timeoutAgainResult = await timeoutAgain.runtime.runLocalRuntime(timeoutAgain.args);
    assert.equal(timeoutAgainResult.interrupt, false);

    const overloadAgain = await freshRuntime('ready', join(dir, 'overload-again.json'));
    shareCounters(overloadAgain.args, seen);
    overloadAgain.args.outages = memory;
    overloadAgain.args.availability = 'available';
    overloadAgain.args.status = 529;
    const overloadAgainResult = await overloadAgain.runtime.runLocalRuntime(overloadAgain.args);
    assert.equal(overloadAgainResult.interrupt, false);
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);

    const otherRoute = await freshRuntime('ready', join(dir, 'other-route.json'));
    shareCounters(otherRoute.args, seen);
    otherRoute.args.outages = memory;
    otherRoute.args.availability = 'timeout';
    otherRoute.args.providerRoute = 'otherRoute';
    const otherRouteResult = await otherRoute.runtime.runLocalRuntime(otherRoute.args);
    assert.equal(otherRouteResult.interrupt, true);
    assert.equal(JSON.parse(readFileSync(otherRoute.args.destination, 'utf8')).interrupt, true);

    const otherPolicy = await freshRuntime('ready', join(dir, 'other-policy.json'));
    shareCounters(otherPolicy.args, seen);
    otherPolicy.args.outages = memory;
    otherPolicy.args.availability = 'timeout';
    otherPolicy.args.policyVersion = 'policyV2';
    const otherPolicyResult = await otherPolicy.runtime.runLocalRuntime(otherPolicy.args);
    assert.equal(otherPolicyResult.interrupt, true);

    const joined = outageMemory();
    const left = await freshRuntime('ready', join(dir, 'joined-left.json'));
    shareCounters(left.args, seen);
    left.args.outages = joined;
    left.args.availability = 'timeout';
    left.args.providerRoute = 'a|b';
    left.args.policyVersion = 'c';
    const leftResult = await left.runtime.runLocalRuntime(left.args);
    assert.equal(leftResult.interrupt, true);
    assert.deepEqual(joined.triples[0], { errorClass: 'timeout', providerRoute: 'a|b', policyVersion: 'c' });

    const right = await freshRuntime('ready', join(dir, 'joined-right.json'));
    shareCounters(right.args, seen);
    right.args.outages = joined;
    right.args.availability = 'timeout';
    right.args.providerRoute = 'a';
    right.args.policyVersion = 'b|c';
    const rightResult = await right.runtime.runLocalRuntime(right.args);
    assert.equal(rightResult.interrupt, true);
    assert.equal(rightResult.errorClass, 'timeout');
    assert.deepEqual(joined.triples[1], {
      errorClass: 'timeout',
      providerRoute: 'a',
      policyVersion: 'b|c',
    });

    const offDest = join(dir, 'off.json');
    const offMemory = outageMemory();
    const off = await freshRuntime('off', offDest);
    shareCounters(off.args, seen);
    off.args.outages = offMemory;
    off.args.availability = 'timeout';
    off.args.providerRoute = 'providerDirect';
    off.args.policyVersion = 'policyV1';
    const offResult = await off.runtime.runLocalRuntime(off.args);
    assert.equal(offResult.interrupt, false);
    assert.equal(offMemory.triples.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(offDest, 'utf8')), fixture);

    const afterOff = await freshRuntime('ready', join(dir, 'after-off.json'));
    shareCounters(afterOff.args, seen);
    afterOff.args.outages = offMemory;
    afterOff.args.availability = 'timeout';
    const afterOffResult = await afterOff.runtime.runLocalRuntime(afterOff.args);
    assert.equal(afterOffResult.interrupt, true);
    assert.equal(seen.port.calls, 0);
    assert.equal(seen.alternatePort.calls, 0);
  } finally {
    removeScratch(dir);
  }
});

function validityKeys(patch) {
  const keys = {
    workspaceIsolation: 'ws-a',
    evidenceHashes: 'eh-a',
    questionSetVersion: 'qs-1',
    criteriaOrdering: 'co-1',
    stateEncoder: 'se-1',
    providerRoute: 'route-a',
    resolvedModel: 'model-pin',
    policyVersion: 'pol-1',
    calibrationVersion: 'cal-1',
  };
  if (patch !== undefined) Object.assign(keys, patch);
  return keys;
}

function matchingCache(patch, fields) {
  return {
    ...validityKeys(patch),
    security: false,
    choice: 'cachedChoiceOk',
    ...fields,
  };
}

test('a full nine-key match reuses the safe choice and off does not', async () => {
  const dir = scratchDir('jevris-cache-match-');
  try {
    const destination = join(dir, 'timeout.json');
    const { runtime, seen, args, recorded } = await freshRuntime('ready', destination, (caller) => {
      caller.body = BODY_CANARY;
    });
    args.body = BODY_CANARY;
    args.availability = 'timeout';
    args.approvedModel = 'jev-keep-injected';
    args.sourceText = SOURCE_CANARY;
    args.validity = validityKeys();
    args.cached = matchingCache();
    const result = await runtime.runLocalRuntime(args);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.cacheReused, true);
    assert.equal(result.explanation, TIMEOUT_EXPLANATION);
    assert.equal(result.errorClass, 'timeout');
    assert.equal(seen.port.calls, 0);
    assertNoHiddenProvider(seen, recorded);
    const text = readFileSync(destination, 'utf8');
    const file = JSON.parse(text);
    assert.equal(file.cacheReused, true);
    assert.equal(file.cachedChoice, 'cachedChoiceOk');
    assert.equal(file.applied, false);
    assert.equal(file.toolPermission, false);
    assert.equal(file.approvedModel, 'jev-keep-injected');
    assert.equal(file.errorClass, 'timeout');
    assert.equal(file.explanation, TIMEOUT_EXPLANATION);
    assert.equal(file.mode, 'unavailable');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes(BODY_CANARY), false);
    assert.equal(text.includes('workspaceIsolation'), false);
    assert.equal(text.includes('model-pin'), false);
    assert.deepEqual(Object.keys(file), Object.keys(fixture));

    const offDest = join(dir, 'off.json');
    const off = await freshRuntime('off', offDest);
    off.args.availability = 'timeout';
    off.args.validity = validityKeys();
    off.args.cached = matchingCache();
    off.args.sourceText = SOURCE_CANARY;
    const offResult = await off.runtime.runLocalRuntime(off.args);
    assert.equal(offResult.cacheReused, false);
    assert.equal(off.seen.port.calls, 0);
    const offText = readFileSync(offDest, 'utf8');
    const offFile = JSON.parse(offText);
    assert.equal(offFile.cacheReused, false);
    assert.equal(offFile.cachedChoice, null);
    assert.equal(offText.includes('cachedChoiceOk'), false);
    assert.equal(offText.includes(SOURCE_CANARY), false);
    assert.deepEqual(offFile, fixture);
  } finally {
    removeScratch(dir);
  }
});

async function unavailableCache(dir, name, mutate) {
  const destination = join(dir, name);
  const ctx = await freshRuntime('ready', destination, (caller) => {
    caller.body = BODY_CANARY;
  });
  ctx.args.body = BODY_CANARY;
  ctx.args.availability = 'timeout';
  ctx.args.approvedModel = 'jev-keep-injected';
  ctx.args.sourceText = SOURCE_CANARY;
  ctx.args.validity = validityKeys();
  ctx.args.cached = matchingCache();
  if (mutate !== undefined) mutate(ctx.args);
  const result = await ctx.runtime.runLocalRuntime(ctx.args);
  const text = readFileSync(destination, 'utf8');
  return { ...ctx, result, text, file: JSON.parse(text) };
}

function assertNotReused(label, got, absent) {
  assert.equal(got.result.cacheReused, false, label);
  assert.equal(got.result.applied, false, label);
  assert.equal(got.result.toolPermission, false, label);
  assert.equal(got.result.errorClass, 'timeout', label);
  assert.equal(got.result.explanation, TIMEOUT_EXPLANATION, label);
  assert.equal(got.file.cacheReused, false, label);
  assert.equal(got.file.cachedChoice, null, label);
  assert.equal(got.file.approvedModel, 'jev-keep-injected', label);
  assert.equal(got.file.toolPermission, false, label);
  assert.equal(got.file.applied, false, label);
  assert.equal(got.file.errorClass, 'timeout', label);
  assert.equal(got.seen.port.calls, 0, label);
  assert.equal(got.text.includes(SOURCE_CANARY), false, label);
  assert.equal(got.text.includes(BODY_CANARY), false, label);
  assert.equal(got.text.includes('cachedChoiceOk'), false, label);
  if (absent !== undefined) assert.equal(got.text.includes(absent), false, label);
  assertNoHiddenProvider(got.seen, got.recorded);
}

test('a partial key match or a security decision is not reused', async () => {
  const dir = scratchDir('jevris-cache-miss-');
  const longChoice = `A${'b'.repeat(64)}`;
  try {
    const changed = [
      ['evidenceHashes', { evidenceHashes: 'eh-b' }],
      ['policyVersion', { policyVersion: 'pol-2' }],
      ['calibrationVersion', { calibrationVersion: 'cal-2' }],
    ];
    for (const [label, patch] of changed) {
      const got = await unavailableCache(dir, `${label}.json`, (args) => {
        args.cached = matchingCache(patch);
      });
      assertNotReused(label, got);
    }

    const missingCached = await unavailableCache(dir, 'missing-cached.json', (args) => {
      const cached = matchingCache();
      delete cached.calibrationVersion;
      args.cached = cached;
    });
    assertNotReused('missing-cached', missingCached);

    const missingValidity = await unavailableCache(dir, 'missing-validity.json', (args) => {
      const validity = validityKeys();
      delete validity.calibrationVersion;
      args.validity = validity;
    });
    assertNotReused('missing-validity', missingValidity);

    const nonString = await unavailableCache(dir, 'non-string.json', (args) => {
      args.cached = matchingCache({ evidenceHashes: 12 });
    });
    assertNotReused('non-string', nonString);

    const security = await unavailableCache(dir, 'security.json', (args) => {
      args.cached = matchingCache(undefined, { security: true });
    });
    assertNotReused('security', security);

    const unsafe = await unavailableCache(dir, 'unsafe-choice.json', (args) => {
      args.cached = matchingCache(undefined, { choice: 'not safe' });
    });
    assertNotReused('unsafe-choice', unsafe, 'not safe');

    const constructorChoice = await unavailableCache(dir, 'constructor-choice.json', (args) => {
      args.cached = matchingCache(undefined, { choice: 'constructor' });
    });
    assertNotReused('constructor-choice', constructorChoice, 'constructor');

    const long = await unavailableCache(dir, 'long-choice.json', (args) => {
      args.cached = matchingCache(undefined, { choice: longChoice });
    });
    assertNotReused('long-choice', long, longChoice);

    const extra = await unavailableCache(dir, 'extra-key.json', (args) => {
      args.cached = matchingCache(undefined, { leaked: 'EXTRA_KEY_do_not_store' });
    });
    assertNotReused('extra-key', extra, 'EXTRA_KEY_do_not_store');

    const hidden = await unavailableCache(dir, 'hidden-key.json', (args) => {
      const cached = matchingCache();
      Object.defineProperty(cached, 'hidden', {
        value: 'HIDDEN_KEY_do_not_store',
        enumerable: false,
      });
      args.cached = cached;
    });
    assertNotReused('hidden-key', hidden, 'HIDDEN_KEY_do_not_store');

    const validityExtra = await unavailableCache(dir, 'validity-extra.json', (args) => {
      args.validity = validityKeys({ leaked: 'VALIDITY_EXTRA_do_not_store' });
    });
    assertNotReused('validity-extra', validityExtra, 'VALIDITY_EXTRA_do_not_store');

    const dangerous = await unavailableCache(dir, 'dangerous.json', (args) => {
      const cached = matchingCache();
      Object.defineProperty(cached, '__proto__', {
        value: { polluted: true },
        enumerable: true,
      });
      args.cached = cached;
    });
    assertNotReused('dangerous', dangerous);

    const symbolKey = await unavailableCache(dir, 'symbol-key.json', (args) => {
      const cached = matchingCache();
      Object.defineProperty(cached, Symbol('extra'), { value: 'SYMBOL_KEY_do_not_store' });
      args.cached = cached;
    });
    assertNotReused('symbol-key', symbolKey, 'SYMBOL_KEY_do_not_store');
  } finally {
    removeScratch(dir);
  }
});

function probeMemory() {
  let marked = false;
  return {
    probed() {
      return marked;
    },
    mark() {
      marked = true;
    },
  };
}

function recordProbe(seen, impl) {
  const calls = [];
  const probe = (argument) => {
    seen.probe.calls += 1;
    calls.push(argument);
    if (impl !== undefined) return impl(argument);
  };
  return { probe, calls };
}

function assertHealthArgument(argument) {
  assert.deepEqual(Reflect.ownKeys(argument), ['kind']);
  assert.equal(argument.kind, 'health');
  assert.equal(Object.hasOwn(argument, 'source'), false);
  assert.equal(Object.hasOwn(argument, 'sourceText'), false);
  assert.equal(Object.hasOwn(argument, 'body'), false);
  assert.equal(Object.hasOwn(argument, SOURCE_CANARY), false);
  const text = JSON.stringify(argument);
  assert.equal(text.includes(SOURCE_CANARY), false);
  assert.equal(text.includes(BODY_CANARY), false);
}

test('a returning connection probes once and the argument has no source', async () => {
  const dir = scratchDir('jevris-probe-once-');
  try {
    const destination = join(dir, 'ready.json');
    const ctx = await freshRuntime('ready', destination, (caller) => {
      caller.body = BODY_CANARY;
      caller.source = SOURCE_CANARY;
    });
    const recorded = recordProbe(ctx.seen);
    ctx.args.body = BODY_CANARY;
    ctx.args.sourceText = SOURCE_CANARY;
    ctx.args.connectivity = 'returned';
    ctx.args.circuit = 'open';
    ctx.args.probes = probeMemory();
    ctx.args.probe = recorded.probe;
    const result = await ctx.runtime.runLocalRuntime(ctx.args);
    assert.equal(recorded.calls.length, 1);
    assert.notStrictEqual(recorded.calls[0], ctx.args.caller);
    assertHealthArgument(recorded.calls[0]);
    assert.equal(result.actuationResumed, false);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(ctx.seen.actuator.calls, 0);
    assert.equal(ctx.seen.port.calls, 0);
    assert.equal(ctx.seen.alternatePort.calls, 0);
    assert.equal(ctx.seen.sourceOpener.calls, 0);
    assert.equal(ctx.seen.workLauncher.calls, 0);
    assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);
    assert.equal(existsSync(destination), false);

    const issued = ctx.runtime.issueLocalCallerToken({
      user: 'dev-one',
      pid: 4242,
      nowMs: 2000,
      expiresAtMs: 9000,
    });
    assert.equal(issued.ok, true);
    const second = await freshRuntime('ready', join(dir, 'second.json'));
    second.args.nowMs = 2000;
    second.args.caller = {
      host: 'localhost',
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
      body: BODY_CANARY,
    };
    second.args.credential = {
      user: 'dev-one',
      pid: 4242,
      expiresAtMs: 9000,
      token: issued.token,
    };
    second.args.replay = second.runtime.createAntiReplayStore();
    second.args.connectivity = 'returned';
    second.args.circuit = 'open';
    second.args.sourceText = SOURCE_CANARY;
    second.args.probes = ctx.args.probes;
    second.args.probe = recorded.probe;
    second.args.port = ctx.seen.port;
    second.args.alternatePort = ctx.seen.alternatePort;
    second.args.actuator = ctx.seen.actuator;
    const secondResult = await second.runtime.runLocalRuntime(second.args);
    assert.equal(secondResult.accepted, true);
    assert.equal(recorded.calls.length, 1);
    assert.equal(ctx.seen.port.calls, 0);
    assert.equal(ctx.seen.alternatePort.calls, 0);
    assert.equal(ctx.seen.actuator.calls, 0);

    const off = await freshRuntime('off', join(dir, 'off.json'));
    off.args.connectivity = 'returned';
    off.args.circuit = 'open';
    off.args.sourceText = SOURCE_CANARY;
    const offResult = await off.runtime.runLocalRuntime(off.args);
    assert.equal(off.seen.probe.calls, 0);
    assert.equal(off.seen.actuator.calls, 0);
    assert.equal(offResult.applied, false);
    const offFile = JSON.parse(readFileSync(off.args.destination, 'utf8'));
    assert.equal(offFile.actuationResumed, false);

    const timeout = await freshRuntime('ready', join(dir, 'timeout.json'));
    timeout.args.availability = 'timeout';
    timeout.args.connectivity = 'returned';
    timeout.args.circuit = 'open';
    timeout.args.sourceText = SOURCE_CANARY;
    const timeoutResult = await timeout.runtime.runLocalRuntime(timeout.args);
    assert.equal(timeout.seen.probe.calls, 0);
    assert.equal(timeout.seen.actuator.calls, 0);
    assert.equal(timeoutResult.errorClass, 'timeout');
    const timeoutFile = JSON.parse(readFileSync(timeout.args.destination, 'utf8'));
    assert.equal(timeoutFile.actuationResumed, false);

    const prohibited = await freshRuntime('ready', join(dir, 'prohibited.json'));
    prohibited.args.networkPolicy = 'prohibited';
    prohibited.args.connectivity = 'returned';
    prohibited.args.circuit = 'open';
    const prohibitedResult = await prohibited.runtime.runLocalRuntime(prohibited.args);
    assert.equal(prohibited.seen.probe.calls, 0);
    assert.equal(prohibited.seen.actuator.calls, 0);
    assert.equal(prohibitedResult.errorClass, 'prohibited');

    const overload = await freshRuntime('ready', join(dir, 'overload.json'));
    overload.args.status = 529;
    overload.args.connectivity = 'returned';
    overload.args.circuit = 'open';
    const overloadResult = await overload.runtime.runLocalRuntime(overload.args);
    assert.equal(overload.seen.probe.calls, 0);
    assert.equal(overloadResult.errorClass, 'overload');

    const closed = await freshRuntime('ready', join(dir, 'closed.json'));
    closed.args.connectivity = 'returned';
    closed.args.circuit = 'closed';
    await closed.runtime.runLocalRuntime(closed.args);
    assert.equal(closed.seen.probe.calls, 0);

    const quiet = await freshRuntime('ready', join(dir, 'quiet.json'));
    await quiet.runtime.runLocalRuntime(quiet.args);
    assert.equal(quiet.seen.probe.calls, 0);
  } finally {
    removeScratch(dir);
  }
});

async function probeCase(dir, name, impl, patch) {
  const destination = join(dir, name);
  const ctx = await freshRuntime('ready', destination, (caller) => {
    caller.body = BODY_CANARY;
    caller.source = SOURCE_CANARY;
  });
  ctx.args.body = BODY_CANARY;
  ctx.args.sourceText = SOURCE_CANARY;
  ctx.args.connectivity = 'returned';
  ctx.args.circuit = 'open';
  ctx.args.probes = probeMemory();
  if (patch !== undefined) patch(ctx);
  const recorded = recordProbe(ctx.seen, impl);
  ctx.args.probe = recorded.probe;
  const result = await ctx.runtime.runLocalRuntime(ctx.args);
  return { ...ctx, recorded, result };
}

test('a probe does not resume actuation when identity or policy differs', async () => {
  const dir = scratchDir('jevris-probe-identity-');
  try {
    const model = await probeCase(dir, 'model.json', () => ({
      model: 'jev-other',
      policyVersion: 'policyV1',
    }));
    assert.equal(model.result.restore, 'observation');
    assert.equal(model.result.actuationResumed, false);
    assert.equal(model.seen.actuator.calls, 0);
    assert.equal(model.seen.port.calls, 0);
    assert.equal(model.recorded.calls.length, 1);
    assertHealthArgument(model.recorded.calls[0]);
    assert.equal(JSON.stringify(model.result).includes(SOURCE_CANARY), false);

    const policy = await probeCase(dir, 'policy.json', () => ({
      model: 'jev-1.13.0',
      policyVersion: 'policy-other',
    }));
    assert.equal(policy.result.restore, 'observation');
    assert.equal(policy.result.actuationResumed, false);
    assert.equal(policy.seen.actuator.calls, 0);
    assert.equal(policy.seen.port.calls, 0);

    const match = await probeCase(
      dir,
      'match.json',
      () => ({ model: 'jev-1.13.0', policyVersion: 'policyCustom' }),
      (ctx) => {
        ctx.args.policyVersion = 'policyCustom';
      },
    );
    assert.equal(match.result.restore, 'none');
    assert.equal(match.result.actuationResumed, false);
    assert.equal(match.seen.actuator.calls, 0);
    assert.equal(match.seen.port.calls, 0);
    assert.equal(existsSync(match.args.destination), false);
  } finally {
    removeScratch(dir);
  }
});

test('a probe throw is not stored and is not called again', async () => {
  const dir = scratchDir('jevris-probe-throw-');
  const message = 'PROBE_MESSAGE_do_not_store';
  try {
    const destination = join(dir, 'throw.json');
    const ctx = await freshRuntime('ready', destination, (caller) => {
      caller.body = BODY_CANARY;
    });
    ctx.args.body = BODY_CANARY;
    ctx.args.sourceText = SOURCE_CANARY;
    ctx.args.connectivity = 'returned';
    ctx.args.circuit = 'open';
    const memory = probeMemory();
    ctx.args.probes = memory;
    let calls = 0;
    ctx.args.probe = () => {
      calls += 1;
      throw new Error(message);
    };
    const result = await ctx.runtime.runLocalRuntime(ctx.args);
    assert.equal(calls, 1);
    assert.equal(result.restore, 'none');
    assert.equal(result.actuationResumed, false);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(ctx.seen.actuator.calls, 0);
    assert.equal(ctx.seen.port.calls, 0);
    assert.equal(JSON.stringify(result).includes(message), false);
    assert.equal(existsSync(destination), false);
    for (const name of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, name), 'utf8').includes(message), false, name);
    }

    const issued = ctx.runtime.issueLocalCallerToken({
      user: 'dev-one',
      pid: 4242,
      nowMs: 2000,
      expiresAtMs: 9000,
    });
    assert.equal(issued.ok, true);
    const second = await freshRuntime('ready', join(dir, 'second.json'));
    second.args.nowMs = 2000;
    second.args.caller = {
      host: 'localhost',
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
    };
    second.args.credential = {
      user: 'dev-one',
      pid: 4242,
      expiresAtMs: 9000,
      token: issued.token,
    };
    second.args.replay = second.runtime.createAntiReplayStore();
    second.args.connectivity = 'returned';
    second.args.circuit = 'open';
    second.args.probes = memory;
    let secondCalls = 0;
    second.args.probe = () => {
      secondCalls += 1;
      throw new Error(message);
    };
    const secondResult = await second.runtime.runLocalRuntime(second.args);
    assert.equal(secondResult.accepted, true);
    assert.equal(calls, 1);
    assert.equal(secondCalls, 0);
    assert.equal(JSON.stringify(secondResult).includes(message), false);
  } finally {
    removeScratch(dir);
  }
});

const failureSpec = JSON.parse(
  readFileSync(new URL('../../../fixtures/choice/failure-family.json', import.meta.url), 'utf8'),
);

const ALLOWED_EGRESS = { provenance: 'administrator', sourceEgress: 'approved-scoped' };

function readyLedger(destination, port, alternatePort, input) {
  let revisionReads = 0;
  return {
    reads: () => revisionReads,
    ledger: {
      destination,
      decisionId: 'decisionReady',
      policyVersion: 'policyV1',
      evidenceRevision: 'revisionA',
      revision: {
        expected: 'revisionA',
        read() {
          revisionReads += 1;
          return 'revisionA';
        },
      },
      clock: {
        read() {
          return 400;
        },
      },
      deadlineAtMs: 1000,
      remainingMicroUsd: '2000000',
      reservationMicroUsd: '1000000',
      attempts: 1,
      questions: 1,
      stillUseful: true,
      spec: failureSpec,
      input: input === undefined ? { kind: 'known-failure', family: 'type_error' } : input,
      port,
      signal: { aborted: false },
      sourceText: SOURCE_CANARY,
      alternatePort,
    },
  };
}

test('a ready allowed call records a decision that is not applied', async () => {
  const dir = scratchDir('jevris-ready-ledger-');
  const fallback = join(dir, 'fallback.json');
  const ledgerPath = join(dir, 'ledger.json');
  try {
    const { readDecisionFile } = await import('../dist/ledger.js');
    const ctx = await freshRuntime('ready', fallback, (caller) => {
      caller.source = SOURCE_CANARY;
      caller.body = BODY_CANARY;
    });
    const prepared = readyLedger(ledgerPath, ctx.seen.port, ctx.seen.alternatePort);
    ctx.args.sourceText = SOURCE_CANARY;
    ctx.args.body = BODY_CANARY;
    ctx.args.approvedModel = 'jev-keep-injected';
    ctx.args.egressSetting = ALLOWED_EGRESS;
    ctx.args.ledger = prepared.ledger;
    ctx.args.connectivity = 'returned';
    ctx.args.circuit = 'open';
    ctx.args.probes = probeMemory();
    ctx.args.probe = () => ({ model: 'jev-1.13.0', policyVersion: 'policyV1' });
    const result = await ctx.runtime.runLocalRuntime(ctx.args);

    assert.equal(prepared.reads(), 2);
    assert.equal(ctx.recorded(), 0);
    assert.equal(result.applied, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.sent, false);
    assert.equal(result.actuationResumed, false);
    assert.equal(result.restore, 'none');
    assert.equal(ctx.args.approvedModel, 'jev-keep-injected');
    assert.equal(ctx.seen.port.calls, 0);
    assert.equal(ctx.seen.alternatePort.calls, 0);
    assert.equal(ctx.seen.actuator.calls, 0);
    assert.equal(ctx.seen.sourceOpener.calls, 0);
    assert.equal(existsSync(fallback), false);
    assert.equal(JSON.stringify(result).includes(SOURCE_CANARY), false);

    const text = readFileSync(ledgerPath, 'utf8');
    assert.equal(text.includes(SOURCE_CANARY), false);
    assert.equal(text.includes(BODY_CANARY), false);
    const read = await readDecisionFile(ledgerPath);
    assert.equal(read.ok, true);
    assert.equal(read.file.records.length, 1);
    assert.equal(read.file.records[0].reasonCode, 'KNOWN_FAILURE');
    assert.equal(read.file.records[0].applied, false);
  } finally {
    removeScratch(dir);
  }
});

const AMBIGUOUS = { kind: 'ambiguous-failure' };

async function deniedReady(dir, name) {
  const fallback = join(dir, name);
  const ledgerPath = join(dir, `${name}.ledger.json`);
  const ctx = await freshRuntime('ready', fallback, (caller) => {
    caller.source = SOURCE_CANARY;
  });
  const prepared = readyLedger(ledgerPath, ctx.seen.port, ctx.seen.alternatePort, AMBIGUOUS);
  ctx.args.sourceText = SOURCE_CANARY;
  ctx.args.ledger = prepared.ledger;
  return { ctx, prepared, ledgerPath, fallback };
}

test('egress deny and a missing ledger do not call the provider', async () => {
  const dir = scratchDir('jevris-ready-deny-');
  try {
    const missing = await deniedReady(dir, 'missing-setting.json');
    const missingResult = await missing.ctx.runtime.runLocalRuntime(missing.ctx.args);
    assert.equal(missing.prepared.reads(), 0);
    assert.equal(existsSync(missing.ledgerPath), false);
    assert.equal(missing.ctx.seen.port.calls, 0);
    assert.equal(missing.ctx.seen.alternatePort.calls, 0);
    assert.equal(missingResult.toolPermission, false);
    assert.equal(missingResult.applied, false);
    assert.equal(missingResult.sent, false);

    const claims = await deniedReady(dir, 'claims.json');
    claims.ctx.args.egressSetting = ALLOWED_EGRESS;
    claims.ctx.args.untrustedClaims = ['UNTRUSTED_CLAIM_do_not_store'];
    const claimsResult = await claims.ctx.runtime.runLocalRuntime(claims.ctx.args);
    assert.equal(claims.prepared.reads(), 0);
    assert.equal(existsSync(claims.ledgerPath), false);
    assert.equal(claims.ctx.seen.port.calls, 0);
    assert.equal(claims.ctx.seen.alternatePort.calls, 0);
    assert.equal(claimsResult.toolPermission, false);
    assert.equal(JSON.stringify(claimsResult).includes('UNTRUSTED_CLAIM_do_not_store'), false);

    const absent = await deniedReady(dir, 'absent-ledger.json');
    delete absent.ctx.args.ledger;
    absent.ctx.args.egressSetting = ALLOWED_EGRESS;
    const absentResult = await absent.ctx.runtime.runLocalRuntime(absent.ctx.args);
    assert.equal(absent.ctx.seen.port.calls, 0);
    assert.equal(absent.ctx.seen.alternatePort.calls, 0);
    assert.equal(absentResult.toolPermission, false);
    assert.equal(existsSync(absent.fallback), false);
    assert.equal(existsSync(absent.ledgerPath), false);

    const off = await deniedReady(dir, 'off.json');
    off.ctx.args.mode = 'off';
    off.ctx.args.egressSetting = ALLOWED_EGRESS;
    const offResult = await off.ctx.runtime.runLocalRuntime(off.ctx.args);
    assert.equal(off.prepared.reads(), 0);
    assert.equal(off.ctx.seen.port.calls, 0);
    assert.equal(off.ctx.seen.alternatePort.calls, 0);
    assert.equal(offResult.applied, false);
    assert.equal(existsSync(off.ledgerPath), false);

    const timeout = await deniedReady(dir, 'timeout.json');
    timeout.ctx.args.availability = 'timeout';
    timeout.ctx.args.egressSetting = ALLOWED_EGRESS;
    const timeoutResult = await timeout.ctx.runtime.runLocalRuntime(timeout.ctx.args);
    assert.equal(timeout.prepared.reads(), 0);
    assert.equal(timeout.ctx.seen.port.calls, 0);
    assert.equal(timeout.ctx.seen.alternatePort.calls, 0);
    assert.equal(timeoutResult.errorClass, 'timeout');
    assert.equal(existsSync(timeout.ledgerPath), false);

    const local = await deniedReady(dir, 'local.json');
    local.ctx.args.caller = { host: 'localhost' };
    local.ctx.args.egressSetting = ALLOWED_EGRESS;
    const localResult = await local.ctx.runtime.runLocalRuntime(local.ctx.args);
    assert.equal(localResult.reasonCode, 'LOCALHOST_ONLY');
    assert.equal(local.prepared.reads(), 0);
    assert.equal(local.ctx.seen.port.calls, 0);
    assert.equal(local.ctx.seen.alternatePort.calls, 0);
    assert.equal(existsSync(local.ledgerPath), false);

    const replay = await deniedReady(dir, 'replay.json');
    replay.ctx.args.mode = 'off';
    await replay.ctx.runtime.runLocalRuntime(replay.ctx.args);
    replay.ctx.args.mode = 'ready';
    replay.ctx.args.egressSetting = ALLOWED_EGRESS;
    const replayed = await replay.ctx.runtime.runLocalRuntime(replay.ctx.args);
    assert.equal(replayed.reasonCode, 'REPLAYED_TOKEN');
    assert.equal(replay.prepared.reads(), 0);
    assert.equal(replay.ctx.seen.port.calls, 0);
    assert.equal(replay.ctx.seen.alternatePort.calls, 0);
  } finally {
    removeScratch(dir);
  }
});

test('a ledger throw is not stored and does not call the provider again', async () => {
  const dir = scratchDir('jevris-ready-throw-');
  const message = 'LEDGER_THROW_do_not_store';
  try {
    const fallback = join(dir, 'throw.json');
    const ledgerPath = join(dir, 'ledger.json');
    const ctx = await freshRuntime('ready', fallback);
    const throwingPort = { calls: 0 };
    Object.defineProperty(throwingPort, 'evaluate', {
      enumerable: true,
      get() {
        throwingPort.calls += 1;
        throw new Error(message);
      },
    });
    const prepared = readyLedger(ledgerPath, throwingPort, ctx.seen.alternatePort, AMBIGUOUS);
    ctx.args.egressSetting = ALLOWED_EGRESS;
    ctx.args.sourceText = SOURCE_CANARY;
    ctx.args.ledger = prepared.ledger;
    let threw = false;
    let result;
    try {
      result = await ctx.runtime.runLocalRuntime(ctx.args);
    } catch (error) {
      threw = true;
      assert.equal(error instanceof Error && error.message === message, true);
    }
    assert.equal(threw, false);
    assert.equal(result.applied, false);
    assert.equal(result.fileWritten, false);
    assert.equal(result.toolPermission, false);
    assert.equal(result.sent, false);
    assert.equal(JSON.stringify(result).includes(message), false);
    assert.equal(ctx.seen.port.calls, 0);
    assert.equal(ctx.seen.alternatePort.calls, 0);
    assert.equal(throwingPort.calls, 1);
    assert.equal(existsSync(fallback), false);
    for (const name of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, name), 'utf8').includes(message), false, name);
    }

    const issued = ctx.runtime.issueLocalCallerToken({
      user: 'dev-one',
      pid: 4242,
      nowMs: 2000,
      expiresAtMs: 9000,
    });
    assert.equal(issued.ok, true);
    const second = await freshRuntime('ready', join(dir, 'second.json'));
    second.args.nowMs = 2000;
    second.args.caller = {
      host: 'localhost',
      user: 'dev-one',
      pid: 4242,
      token: issued.token,
    };
    second.args.credential = {
      user: 'dev-one',
      pid: 4242,
      expiresAtMs: 9000,
      token: issued.token,
    };
    second.args.replay = second.runtime.createAntiReplayStore();
    second.args.egressSetting = ALLOWED_EGRESS;
    second.args.ledger = prepared.ledger;
    second.args.alternatePort = ctx.seen.alternatePort;
    const again = await second.runtime.runLocalRuntime(second.args);
    assert.equal(again.applied, false);
    assert.equal(again.fileWritten, false);
    assert.equal(again.toolPermission, false);
    assert.equal(JSON.stringify(again).includes(message), false);
    assert.equal(throwingPort.calls, 2);
    assert.equal(second.seen.port.calls, 0);
    assert.equal(ctx.seen.alternatePort.calls, 0);
  } finally {
    removeScratch(dir);
  }
});
