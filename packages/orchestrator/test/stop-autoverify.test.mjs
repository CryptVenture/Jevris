// Owner decision 2026-09-30: `verification.backgroundAtStop` (off by default). When a person turned
// it on, a main-session Stop that finds approved checks missing or stale queues them in the
// background through the same scheduler as `jevris verify`, and answers at once. Temporary homes,
// stub checks and no wall-clock windows: every wait counts polls, never milliseconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stillRunningText } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import {
  BACKGROUND_AT_STOP_DEFAULT,
  DEFAULT_CONFIG,
  approveManifests,
  handleHookEvent,
  manifestHash,
  openWorkspace,
  parseManifest,
  raiseRefusal,
  readEffectiveConfig,
  reminderSummary,
  setConfigValue,
  verificationStatus,
} from '../dist/index.js';
import { pendingChecks, scheduleVerification } from '../dist/verify/runs.js';
import { resetStopAutoVerifyState } from '../dist/hooks/stop-autoverify.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';
import { removeTree } from '../../../scripts/remove-tree.mjs';

const NODE = process.execPath;
const PASS = [NODE, '-e', '0'];
const FAIL = [NODE, '-e', 'process.exit(1)'];
// A check that waits until the test creates its gate file, then exits 0.
const gated = (gate) => [NODE, '-e', 'const fs = require("node:fs"); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(t); }, 20)', gate];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture() {
  resetStopAutoVerifyState();
  const dir = tempDir('jv-stopav-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const traces = [];
  const ctx = (op, body, extra = {}) => ({
    op,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: (e) => traces.push(e),
    ...extra,
  });
  const queuedTraces = () => traces.filter((t) => t.event === 'orchestrator.verify-queued-at-stop');
  return {
    dir,
    home,
    repo,
    ws,
    ctx,
    traces,
    queuedTraces,
    done: () => {
      closeTestStore(store);
      removeTree(dir);
    },
  };
}

function stopEvent(f, extra = {}, env = {}) {
  return f.ctx(
    'event',
    {
      envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'Stop', kind: 'turn.stopped', sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: null, blocking: false, responseRequired: false, payload: { stopHookActive: false }, dedupKey: 'd', ...extra },
      deliveryKey: `stop-${Math.random()}`,
    },
    env,
  );
}

const stop = (f, extra, env) => handleHookEvent(stopEvent(f, extra, env));

function userConfig(f, patch) {
  const dir = jevrisPaths({ home: f.home }).config;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...patch }));
}
const on = (f, more = {}) => userConfig(f, { verification: { backgroundAtStop: 'on' }, ...more });

async function approve(f, specs) {
  const manifests = specs.map(([id, argv]) => {
    const parsed = parseManifest({ id, argv, resultFormat: 'exit-code', timeoutMs: 120_000 });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return parsed.manifest;
  });
  await approveManifests(f.ws, manifests, Object.fromEntries(manifests.map((m) => [m.id, manifestHash(m)])), 'test');
}

const ids = (specs) => specs.map(([id]) => id);

/** Waits (by poll count) until no approved check of the workspace is running or queued. */
async function idle(f, checkIds) {
  for (let i = 0; i < 2400; i += 1) {
    if (pendingChecks(f.ws.workspaceId, checkIds).size === 0) return;
    await sleep(25);
  }
  assert.fail('the background run did not finish');
}

const statuses = async (f) => Object.fromEntries((await verificationStatus(f.ws, { taskId: null, checkIds: [] })).checks.map((c) => [c.checkId, c.status]));

test('the setting is off by default, is a plain enum, and the workspace file can only turn it off', async () => {
  assert.equal(BACKGROUND_AT_STOP_DEFAULT, 'off');
  const f = fixture();
  try {
    assert.equal(readEffectiveConfig({ home: f.home }).config.verification.backgroundAtStop, 'off');
    assert.equal(DEFAULT_CONFIG.verification.backgroundAtStop, 'off');
    // A file from before the setting existed (no verification group) reads as off.
    const { verification: _dropped, ...older } = DEFAULT_CONFIG;
    const dir = jevrisPaths({ home: f.home }).config;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'jevris.config.json'), JSON.stringify(older));
    const eff = readEffectiveConfig({ home: f.home });
    assert.equal(eff.valid, true, JSON.stringify(eff.issues));
    assert.equal(eff.config.verification.backgroundAtStop, 'off');
    // A repository file is not consent: it cannot turn the setting on, whatever the user file says.
    mkdirSync(join(f.repo, '.jevris'), { recursive: true });
    writeFileSync(join(f.repo, '.jevris', 'config.json'), JSON.stringify({ verification: { backgroundAtStop: 'on' } }));
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.verification.backgroundAtStop, 'off', 'a repo-scope enable is refused');
    on(f);
    assert.equal(readEffectiveConfig({ home: f.home, workspaceRoot: f.repo }).config.verification.backgroundAtStop, 'on', 'the person\'s own file turns it on');
    writeFileSync(join(f.repo, '.jevris', 'config.json'), JSON.stringify({ verification: { backgroundAtStop: 'off' } }));
    const lowered = readEffectiveConfig({ home: f.home, workspaceRoot: f.repo });
    assert.equal(lowered.config.verification.backgroundAtStop, 'off', 'the workspace file may turn it off');
    assert.ok(lowered.narrowed.some((n) => n.layer === 'workspace' && n.key === 'verification.backgroundAtStop'));
  } finally {
    f.done();
  }
});

test('configure set: turning it on needs a person at a terminal (channel refused otherwise); turning it off never asks', async () => {
  const f = fixture();
  try {
    const key = 'verification.backgroundAtStop';
    const noEgress = async () => 'not-approved';
    for (const confirmed of [undefined, false]) {
      const refused = await setConfigValue({ home: f.home, key, value: 'on', dryRun: false, sourceEgress: noEgress, ...(confirmed === undefined ? {} : { confirmed }) });
      assert.deepEqual([refused.ok, refused.reasonCode, refused.message], [false, 'CHANNEL_REFUSED', raiseRefusal(key, 'on')]);
    }
    assert.equal(readEffectiveConfig({ home: f.home }).config.verification.backgroundAtStop, 'off', 'nothing was written');
    const bad = await setConfigValue({ home: f.home, key, value: 'sometimes', dryRun: false, sourceEgress: noEgress, confirmed: true });
    assert.equal(bad.ok, false);
    const done = await setConfigValue({ home: f.home, key, value: 'on', dryRun: false, sourceEgress: noEgress, confirmed: true });
    assert.deepEqual(done.changed, [{ key, from: 'off', to: 'on' }], JSON.stringify(done));
    assert.equal(readEffectiveConfig({ home: f.home }).config.verification.backgroundAtStop, 'on');
    const lower = await setConfigValue({ home: f.home, key, value: 'off', dryRun: false, sourceEgress: noEgress });
    assert.deepEqual(lower.changed, [{ key, from: 'on', to: 'off' }], JSON.stringify(lower));
    assert.equal(readEffectiveConfig({ home: f.home }).config.verification.backgroundAtStop, 'off');
  } finally {
    f.done();
  }
});

test('off: a Stop with missing approved checks queues nothing and answers as before', async () => {
  // Both spellings of off: the key absent from the file's group, and set explicitly.
  for (const config of [undefined, { verification: { backgroundAtStop: 'off' } }]) {
    const f = fixture();
    try {
      const specs = [['lint', FAIL], ['unit', PASS]];
      await approve(f, specs);
      if (config !== undefined) userConfig(f, config);
      const first = await stop(f);
      assert.equal(first.reasonCode, 'STOP_REMINDER', JSON.stringify(first));
      assert.deepEqual(first.stopContinuation.missingEvidence, ['lint', 'unit']);
      assert.equal(first.stopContinuation.pending, undefined, 'nothing is running');
      assert.ok(!first.stopContinuation.text.includes('Still running'), first.stopContinuation.text);
      // The reminder is spent; the next Stop reports the work unverified, still with nothing running.
      const second = await stop(f);
      assert.equal(second.reasonCode, 'STOP_UNVERIFIED');
      assert.ok(!second.hookOutcome.text.includes('Still running'), second.hookOutcome.text);
      assert.equal(f.queuedTraces().length, 0);
      assert.equal(pendingChecks(f.ws.workspaceId, ids(specs)).size, 0);
      assert.deepEqual(await statuses(f), { lint: 'missing', unit: 'missing' }, 'no receipt was written');
    } finally {
      f.done();
    }
  }
});

test('on: the missing approved checks queue at Stop, show RUNNING or QUEUED, and their receipts arrive; the Stop answer does not wait', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    const specs = [['slow', gated(gate)], ['unit', PASS]];
    await approve(f, specs);
    on(f);
    const answer = await stop(f);
    // The gate is still shut, so the answer came back while the run had not ended.
    assert.equal(answer.reasonCode, 'STOP_UNVERIFIED', JSON.stringify(answer));
    const running = pendingChecks(f.ws.workspaceId, ids(specs));
    assert.deepEqual([...running.keys()].sort(), ['slow', 'unit']);
    for (const state of running.values()) assert.ok(state === 'RUNNING' || state === 'QUEUED', state);
    assert.ok(answer.hookOutcome.text.includes(stillRunningText([...running].sort(([a], [b]) => a.localeCompare(b)))) || answer.hookOutcome.text.includes('Still running in the background'), answer.hookOutcome.text);
    assert.equal(f.queuedTraces().length, 1);
    assert.equal(f.queuedTraces()[0].checks, 2);
    assert.equal((await statuses(f)).slow, 'missing', 'no receipt while the run is under way');
    writeFileSync(gate, 'go');
    await idle(f, ids(specs));
    assert.deepEqual(await statuses(f), { slow: 'passed', unit: 'passed' });
    // The next Stop finds current receipts.
    assert.equal((await stop(f)).reasonCode, 'VERIFIED');
    assert.equal(f.queuedTraces().length, 1, 'nothing was queued: nothing was missing');
  } finally {
    writeFileSync(gate, 'go');
    f.done();
  }
});

test('on: only the missing checks queue; a current receipt is not run again', async () => {
  const f = fixture();
  try {
    const specs = [['unit', PASS], ['lint', PASS]];
    await approve(f, specs);
    on(f);
    await stop(f);
    await idle(f, ids(specs));
    assert.deepEqual(await statuses(f), { lint: 'passed', unit: 'passed' });
    // Change the inputs: both go stale, so both queue again (a new revision may queue).
    writeFileSync(join(f.repo, 'a.txt'), 'changed\n');
    assert.deepEqual(await statuses(f), { lint: 'stale', unit: 'stale' });
    await stop(f);
    await idle(f, ids(specs));
    assert.equal(f.queuedTraces().length, 2);
    assert.deepEqual(f.queuedTraces().map((t) => t.checks), [2, 2]);
    assert.deepEqual(await statuses(f), { lint: 'passed', unit: 'passed' });
  } finally {
    f.done();
  }
});

test('on: a subagent Stop never queues; neither does a task-scoped or non-main event', async () => {
  const f = fixture();
  try {
    await approve(f, [['unit', PASS]]);
    on(f);
    // Every adapter maps a subagent's Stop to worker.finished; a turn.stopped with an agent id is refused too.
    const finished = await handleHookEvent(stopEvent(f, { kind: 'worker.finished', agentId: 'sub-1', parentSessionId: 's1', payload: { agentType: 'general' } }));
    assert.equal(finished.reasonCode, 'SUBAGENT_RECORDED');
    await stop(f, { agentId: 'sub-1' });
    assert.equal(f.queuedTraces().length, 0);
    assert.equal(pendingChecks(f.ws.workspaceId, ['unit']).size, 0);
    assert.deepEqual(await statuses(f), { unit: 'missing' });
  } finally {
    f.done();
  }
});

test('on, but nothing to queue: no approval record, the kill switch, or Jevris off', async () => {
  // No approval record: no checks, no queue.
  const none = fixture();
  try {
    on(none);
    assert.equal((await stop(none)).reasonCode, 'NO_CHECKS');
    assert.equal(none.queuedTraces().length, 0);
  } finally {
    none.done();
  }
  // The kill switch, read live or from the start of the request.
  for (const extra of [{ killSwitchStopped: true }, { killSwitchNow: async () => true }]) {
    const f = fixture();
    try {
      await approve(f, [['unit', PASS]]);
      on(f);
      await stop(f, {}, extra);
      assert.equal(f.queuedTraces().length, 0, JSON.stringify(Object.keys(extra)));
      assert.equal(pendingChecks(f.ws.workspaceId, ['unit']).size, 0);
    } finally {
      f.done();
    }
  }
  // Jevris off (and below bounded-auto, where nothing may act): the setting alone does not queue.
  for (const mode of ['off', 'observe', 'advise']) {
    const f = fixture();
    try {
      await approve(f, [['unit', PASS]]);
      on(f, { mode });
      await stop(f);
      assert.equal(f.queuedTraces().length, 0, mode);
      assert.equal(pendingChecks(f.ws.workspaceId, ['unit']).size, 0, mode);
    } finally {
      f.done();
    }
  }
});

test('on: a second Stop while the run is queued or running does not queue a duplicate', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    const specs = [['slow', gated(gate)]];
    await approve(f, specs);
    on(f);
    await stop(f);
    const again = await stop(f);
    assert.equal(f.queuedTraces().length, 1, 'one queued run');
    assert.ok(again.hookOutcome.text.includes('Still running in the background'), again.hookOutcome.text);
    writeFileSync(gate, 'go');
    await idle(f, ids(specs));
    assert.equal((await statuses(f)).slow, 'passed');
  } finally {
    writeFileSync(gate, 'go');
    f.done();
  }
});

test('on: a run that joins an existing verify run is queued behind it, not run beside it', async () => {
  const f = fixture();
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  try {
    const specs = [['unit', PASS], ['lint', PASS]];
    await approve(f, specs);
    on(f);
    // `jevris verify` for unit is running (a held run under the workspace's key).
    const { verificationRunKey } = await import('../dist/verify/runs.js');
    const run = scheduleVerification(verificationRunKey(f.ws.workspaceId, null), ['unit'], () => held, () => {});
    await stop(f);
    const states = pendingChecks(f.ws.workspaceId, ids(specs));
    assert.equal(states.get('unit'), 'RUNNING', 'the running check is not started twice');
    assert.ok(states.has('lint'), 'the other missing check is queued behind it');
    assert.equal(states.get('lint'), 'QUEUED');
    release();
    await run;
    await idle(f, ids(specs));
    assert.deepEqual(await statuses(f), { lint: 'passed', unit: 'missing' }, 'the held stub wrote no receipt for unit; lint ran once it was its turn');
  } finally {
    release();
    f.done();
  }
});

test('on: a failing receipt at the same revision is not queued again; a new input revision queues again', async () => {
  const f = fixture();
  try {
    const specs = [['lint', FAIL]];
    await approve(f, specs);
    on(f);
    await stop(f);
    await idle(f, ids(specs));
    assert.deepEqual(await statuses(f), { lint: 'failed' });
    assert.equal(f.queuedTraces().length, 1);
    // Same inputs, another Stop, and another: no run.
    await stop(f);
    await stop(f);
    assert.equal(f.queuedTraces().length, 1, 'a failing receipt is not retried at the same revision');
    assert.equal(pendingChecks(f.ws.workspaceId, ids(specs)).size, 0);
    // The inputs changed: the receipt is stale, so it may queue once more.
    writeFileSync(join(f.repo, 'a.txt'), 'changed again\n');
    await stop(f);
    await idle(f, ids(specs));
    assert.equal(f.queuedTraces().length, 2);
    assert.deepEqual(await statuses(f), { lint: 'failed' });
  } finally {
    f.done();
  }
});

test('on: a run that leaves no receipt is not queued again at the same revision', async () => {
  const f = fixture();
  try {
    // Not runnable: the argv names a program that does not exist, so the run ends without a passing receipt.
    const specs = [['lint', ['jevris-no-such-program-xyz']]];
    await approve(f, specs);
    on(f);
    await stop(f);
    await idle(f, ids(specs));
    const queued = f.queuedTraces().length;
    assert.equal(queued, 1);
    await stop(f);
    await stop(f);
    await idle(f, ids(specs));
    assert.equal(f.queuedTraces().length, 1, 'no loop of runs at one revision');
  } finally {
    f.done();
  }
});

test('on: a background run does not count as a reminder that led to a check, and a later verified Stop counts once', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    const specs = [['slow', gated(gate)]];
    await approve(f, specs);
    // Off first: the reminder fires (fired 1).
    assert.equal((await stop(f)).reasonCode, 'STOP_REMINDER');
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 0, ledToVerification: 0, endedUnverified: 0 });
    on(f);
    await stop(f);
    assert.equal(f.queuedTraces().length, 1);
    writeFileSync(gate, 'go');
    await idle(f, ids(specs));
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 0, ledToVerification: 0, endedUnverified: 0 }, 'the queued run is Jevris\'s, not the agent\'s answer to the reminder');
    assert.equal((await stop(f)).reasonCode, 'VERIFIED');
    assert.deepEqual(reminderSummary(f.ws.state, f.ws.workspaceId), { fired: 1, ledToCheck: 0, ledToVerification: 1, endedUnverified: 0 });
  } finally {
    writeFileSync(gate, 'go');
    f.done();
  }
});
