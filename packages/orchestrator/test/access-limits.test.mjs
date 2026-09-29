// Access limits on owned runs (R70, design .planning/research/access-limits.md E9, 7.3, 7.4, 9.1)
// and remote text in task reasons (R80); the automatic resume (R76, design 9.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import {
  ACCESS_BLOCKED_COLLECTION,
  ACCESS_LIMIT_RESET,
  DEFAULT_CONFIG,
  OVERLOAD_RETRIES_MAX,
  accessPausedModels,
  accessReason,
  approveManifests,
  drainSessionAccess,
  noteSessionAccess,
  getTask,
  launchFingerprint,
  leaseAuthorityFor,
  manifestHash,
  openWorkspace,
  overloadRetryAt,
  parseManifest,
  resumeAccessBlocked,
  revokeApproval,
  runIncomplete,
  runLeasedTask,
  scheduleTasks,
  selfIdentity,
  setCertificationGate,
  submitPlan,
  wireSignalOf,
  workerRuns,
} from '../dist/index.js';
import { BUNDLED_MODEL_REGISTRY, accessLimitsPath, accessScopeOf, classifyAccessSignal, clearAccessLimits, credentialFingerprint, emptyLearningState, readAccessLimits, recordAccessLimit, saveLearningState, untimedClearText } from '@jevris/core';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const NOW = Date.parse('2026-09-28T10:00:00Z');
const CANARY = 'CANARY-9c1d upstream body: Insufficient balance for org acme';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture() {
  const dir = tempDir('jv-access-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, 'mod'), { recursive: true });
  writeFileSync(join(repo, 'mod', 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('mod/fixed.txt') ? 0 : 1)"], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
  await approveManifests(ws, [m], { fixed: manifestHash(m) }, 'test');
  await submitPlan(ws, {
    tasks: [{ id: 'T1', requirementIds: ['R1'], acceptanceCheckIds: ['fixed'], expectedOutputs: ['patch'], writeScopes: ['mod'], estimateMicroUsd: 500_000 }],
    ownerId: 'alice',
    rootBudget: { id: 'b1', limitMicroUsd: 5_000_000 },
  });
  const authority = leaseAuthorityFor(ws);
  const [grant] = (await scheduleTasks(ws, { authority, holder: selfIdentity() })).leased;
  return {
    ws,
    store,
    authority,
    grant,
    done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A port that runs `behaviour`; with `harness`, it also answers the launch check's harness and sign-in. */
const port = (behaviour, harness, mode = 'subscription') => {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    async run(input) {
      runs += 1;
      return behaviour(input);
    },
    ...(harness === undefined ? {} : { harnessFor: () => harness, authFor: async () => ({ mode, source: 'declared' }) }),
  };
};

const outcome = (input, extra = {}) => ({
  status: 'completed',
  reason: 'success',
  sessionId: 'sess-9',
  requestedModel: input.model,
  actualModel: null,
  costUsd: 0.25,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  turns: 2,
  durationMs: 5,
  ...extra,
});

const run = (f, p, model, extra = {}) => runLeasedTask(f.ws, f.grant, { authority: f.authority, port: p, model, allowedTools: ['Read'], prompt: 'fix it', decisionNow: () => NOW, env: {}, ...extra });
const blockedRow = (f) => f.ws.host.get(ACCESS_BLOCKED_COLLECTION, `${f.ws.workspaceId}/T1`) ?? f.ws.host.list(ACCESS_BLOCKED_COLLECTION).find((r) => r.taskId === 'T1');
const textMatch = (pattern, extra = {}) => ({ pattern, weekly: false, family: null, resetAtMs: null, resetForm: null, ...extra });

/** Puts one pause on the machine record the way a recording process does: core classifies, then records. */
async function seed(home, { harness, spelling, authMode, signal, fingerprint = null, nowMs = NOW }) {
  const scope = accessScopeOf(BUNDLED_MODEL_REGISTRY, harness, spelling, authMode);
  const classification = classifyAccessSignal({ certified: false, ...signal }, authMode, nowMs);
  const recorded = await recordAccessLimit({ home, scope, classification, source: 'owned-run', nowMs, fingerprint });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  return recorded.entry;
}

test('R80: a run\'s own reason never reaches the task\'s state reason; the task says only how the worker ended, and a reset time shows only as an ISO instant', async () => {
  const cases = [
    [{ status: 'failed', reason: CANARY }, 'failed', 'worker failed'],
    [{ status: 'timeout', reason: `timed out: ${CANARY}` }, 'failed', 'worker timeout'],
    [{ status: 'refused', reason: `401 ${CANARY}` }, 'failed', 'worker refused'],
    [{ status: 'usage-limit', reason: CANARY, resetAt: `soon ${CANARY}` }, 'blocked', 'harness usage limit reached'],
    [{ status: 'usage-limit', reason: CANARY, resetAt: '2026-09-28T09:00:00.000Z' }, 'blocked', 'harness usage limit reached; it resets at 2026-09-28T09:00:00.000Z'],
  ];
  for (const [extra, state, reason] of cases) {
    const f = await fixture();
    try {
      await run(f, port((input) => outcome(input, extra)), 'claude-sonnet-5');
      const task = getTask(f.ws, 'T1');
      assert.deepEqual([task.node.state, task.stateReason], [state, reason], JSON.stringify(extra));
      assert.doesNotMatch(JSON.stringify(task), /CANARY-9c1d|Insufficient balance/);
    } finally {
      f.done();
    }
  }
});

test('R70: a run that ends on an access limit goes on the machine record under its scope, and the task blocks with the fixed reason and an access-blocked row', async () => {
  const f = await fixture();
  try {
    const signal = { port: 'codex', channel: 'error-text', text: textMatch('X1') };
    const result = await run(f, port((input) => outcome(input, { status: 'access-limit', reason: CANARY, harness: 'codex', authMode: 'subscription', accessSignal: signal })), 'gpt-6-sol');
    assert.equal(result.reasonCode, 'ACCESS_LIMITED');
    const task = getTask(f.ws, 'T1');
    assert.equal(task.node.state, 'blocked');
    assert.equal(task.stateReason, 'ACCESS_LIMITED: usage-window on codex subscription openai paused until 2026-09-28T15:00Z (rule); resumed once then if owned workers run automatically and its checks are still approved, else start it again then');
    assert.doesNotMatch(JSON.stringify(task), /CANARY-9c1d/);
    const { entries } = await readAccessLimits(f.ws.home);
    assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.authMode, e.scope.servingHost, e.class, e.signal, e.source, e.untilMs]), [['codex', 'subscription', 'openai', 'usage-window', 'codex.text.x1', 'owned-run', NOW + 5 * 3_600_000]]);
    const [record] = workerRuns(f.ws, 'T1');
    assert.equal(record.status, 'access-limit');
    assert.deepEqual(record.accessLimit, { class: 'usage-window', signal: 'codex.text.x1', weekly: false, resetBasis: 'rule', resetAtMs: NOW + 5 * 3_600_000, recorded: 'RECORDED' });
    assert.equal(record.effectState, 'failed', 'the effect settles failed');
    const row = blockedRow(f);
    assert.deepEqual([row.class, row.untilMs, row.resumed, row.autoResume, row.scopeKey], ['usage-window', NOW + 5 * 3_600_000, false, true, entries[0].key]);
  } finally {
    f.done();
  }
});

test('R70: the runner classifies the signal again and ignores the worker\'s claim; a port\'s interim status (refused, failed) still blocks on its signal and never fails the task', async () => {
  // The worker claims credit is exhausted from Codex text; uncertified text is held as a timed window (OP-4).
  const f = await fixture();
  try {
    const claim = { class: 'credit-exhausted', signal: 'codex.text.x2', weekly: false, resetBasis: 'none' };
    await run(f, port((input) => outcome(input, { status: 'usage-limit', reason: 'x', harness: 'codex', authMode: 'api-key', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X2') }, accessLimit: claim })), 'gpt-6-sol');
    const { entries } = await readAccessLimits(f.ws.home);
    assert.deepEqual(entries.map((e) => [e.class, e.untilMs === null]), [['usage-window', false]], 'held as a timed pause, not untimed credit');
    assert.equal(workerRuns(f.ws, 'T1')[0].accessLimit.class, 'usage-window');
  } finally {
    f.done();
  }
  // Kilo's ProviderAuthError, reported as `refused` until F flips the status: an untimed block on the host that served it.
  const g = await fixture();
  try {
    const result = await run(g, port((input) => outcome(input, { status: 'refused', reason: CANARY, harness: 'kilo', authMode: 'api-key', accessSignal: { port: 'kilocode', channel: 'structured', errorType: 'ProviderAuthError' } })), 'kimi-k3');
    assert.equal(result.reasonCode, 'ACCESS_LIMITED');
    const task = getTask(g.ws, 'T1');
    assert.equal(task.node.state, 'blocked', 'never failed, so it never escalates on a blocked account');
    assert.match(task.stateReason, /^ACCESS_LIMITED: account-blocked on kilocode api-key moonshot since 2026-09-28; clears with jevris route limits clear; once cleared it is resumed if owned workers run automatically and its checks are still approved$/, 'no Kilo key was set, so no new-key clear is offered');
    const { entries } = await readAccessLimits(g.ws.home);
    assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.servingHost, e.class, e.untilMs]), [['kilocode', 'moonshot', 'account-blocked', null]]);
  } finally {
    g.done();
  }
  // A signal that is not a valid wire signal (it carries text) is ignored: the port's status decides.
  const h = await fixture();
  try {
    await run(h, port((input) => outcome(input, { status: 'failed', reason: 'x', harness: 'codex', accessSignal: { port: 'codex', channel: 'error-text', message: CANARY } })), 'gpt-6-sol');
    assert.equal(getTask(h.ws, 'T1').node.state, 'failed');
    assert.equal((await readAccessLimits(h.ws.home)).entries.length, 0);
    assert.equal(wireSignalOf({ port: 'codex', channel: 'error-text', message: CANARY }), null);
  } finally {
    h.done();
  }
});

test('R70: an overloaded provider records no pause; the task blocks for an automatic retry after 30 s x 2^n, at most 3 times, then waits for a person (design 7.4)', async () => {
  const f = await fixture();
  try {
    const result = await run(f, port((input) => outcome(input, { status: 'overloaded', reason: CANARY, harness: 'claude', authMode: 'api-key', accessSignal: { port: 'claude-api', channel: 'structured', status: 529 } })), 'claude-sonnet-5');
    assert.equal(result.reasonCode, 'PROVIDER_OVERLOADED');
    const task = getTask(f.ws, 'T1');
    assert.equal(task.node.state, 'blocked');
    assert.match(task.stateReason, /^PROVIDER_OVERLOADED: the provider was overloaded \(claude-api\.http\.overloaded\); retried automatically after \S+Z if owned workers run automatically and its checks are still approved, else start it again then$/);
    assert.equal((await readAccessLimits(f.ws.home)).entries.length, 0, 'an overload is never a pause');
    const row = blockedRow(f);
    assert.deepEqual([row.class, row.attempt, row.autoResume, row.scopeKey], ['overloaded', 0, true, null]);
    assert.equal(workerRuns(f.ws, 'T1')[0].accessLimit.recorded, 'NOT_A_PAUSE');
  } finally {
    f.done();
  }
  for (let n = 0; n < OVERLOAD_RETRIES_MAX; n += 1) {
    const at = overloadRetryAt(n, NOW, 0);
    assert.equal(at, NOW + 30_000 * 2 ** n);
    assert.ok(overloadRetryAt(n, NOW, 1) <= NOW + Math.ceil(30_000 * 2 ** n * 1.1), 'jitter is at most 10%');
  }
  assert.equal(overloadRetryAt(OVERLOAD_RETRIES_MAX, NOW), null, 'no retry is left');
});

test('R70: a paused scope launches nothing; the effect settles with nothing spent and the task blocks with the pause and an access-blocked row', async () => {
  const f = await fixture();
  try {
    const entry = await seed(f.ws.home, { harness: 'codex', spelling: 'gpt-6-sol', authMode: 'subscription', signal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } });
    const p = port((input) => outcome(input), 'codex', 'subscription');
    const result = await run(f, p, 'gpt-6-sol');
    assert.equal(p.runs, 0, 'nothing was launched');
    assert.deepEqual([result.finalState, result.reasonCode, result.run], ['blocked', 'ACCESS_LIMITED', null]);
    assert.match(getTask(f.ws, 'T1').stateReason, /^ACCESS_LIMITED: usage-window on codex subscription openai paused until 2026-09-28T15:00Z/);
    const row = blockedRow(f);
    assert.deepEqual([row.class, row.scopeKey, row.untilMs, row.autoResume], ['usage-window', entry.key, entry.untilMs, true]);
    const rsv = f.ws.host.list('reservations').find((r) => r.leaseId === f.grant.lease.id);
    assert.equal(rsv.reservation.actualMicroUsd, 0, 'nothing was spent');
  } finally {
    f.done();
  }
  // Another sign-in's pause does not cover this launch.
  const g = await fixture();
  try {
    await seed(g.ws.home, { harness: 'codex', spelling: 'gpt-6-sol', authMode: 'api-key', signal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } });
    const p = port((input) => outcome(input), 'codex', 'subscription');
    await run(g, p, 'gpt-6-sol');
    assert.equal(p.runs, 1);
  } finally {
    g.done();
  }
});

test('R70: an untimed pause recorded with another key clears when the launch uses a new key (FINGERPRINT); the key itself is never kept', async () => {
  const f = await fixture();
  try {
    const old = credentialFingerprint('dummy-key-one');
    await seed(f.ws.home, { harness: 'claude', spelling: 'claude-sonnet-5', authMode: 'api-key', signal: { port: 'claude-api', channel: 'structured', status: 402 }, fingerprint: old });
    // The same key: still paused.
    const same = port((input) => outcome(input), 'claude', 'api-key');
    await run(f, same, 'claude-sonnet-5', { env: { ANTHROPIC_API_KEY: 'dummy-key-one' } });
    assert.equal(same.runs, 0);
    assert.equal(launchFingerprint('claude', 'api-key', { ANTHROPIC_API_KEY: 'dummy-key-one' }), old);
    assert.equal(launchFingerprint('claude', 'subscription', { ANTHROPIC_API_KEY: 'dummy-key-one' }), null, 'a subscription has no fingerprint');
  } finally {
    f.done();
  }
  const g = await fixture();
  try {
    await seed(g.ws.home, { harness: 'claude', spelling: 'claude-sonnet-5', authMode: 'api-key', signal: { port: 'claude-api', channel: 'structured', status: 402 }, fingerprint: credentialFingerprint('dummy-key-one') });
    const fresh = port((input) => {
      writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
      return outcome(input, { harness: 'claude', authMode: 'api-key' });
    }, 'claude', 'api-key');
    await run(g, fresh, 'claude-sonnet-5', { env: { ANTHROPIC_API_KEY: 'dummy-key-two' } });
    assert.equal(fresh.runs, 1, 'a new key launches');
    assert.equal((await readAccessLimits(g.ws.home)).entries.length, 0, 'the old key\'s pause cleared');
    const text = JSON.stringify([...g.ws.host.list('worker-runs'), getTask(g.ws, 'T1')]);
    assert.doesNotMatch(text, /dummy-key/);
  } finally {
    g.done();
  }
});

test('R70: a run that completes clears its scope\'s pauses (an observed success) and its access-blocked row', async () => {
  const f = await fixture();
  try {
    await seed(f.ws.home, { harness: 'codex', spelling: 'gpt-6-sol', authMode: 'subscription', signal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } });
    await seed(f.ws.home, { harness: 'opencode', spelling: 'glm-5.3', authMode: 'api-key', signal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } });
    await f.ws.host.transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, `${f.ws.workspaceId}/T1`, { workspaceId: f.ws.workspaceId, taskId: 'T1', scopeKey: null, class: 'usage-window', untilMs: NOW, blockedAtMs: NOW, resumed: true, autoResume: true }));
    // A port with no launch check (a person resumed it); the run reports its harness.
    await run(f, port((input) => {
      writeFileSync(join(input.cwd, 'mod', 'fixed.txt'), 'ok\n');
      return outcome(input, { harness: 'codex', authMode: 'subscription' });
    }), 'gpt-6-sol');
    assert.equal(getTask(f.ws, 'T1').node.state, 'awaiting-evidence');
    const { entries } = await readAccessLimits(f.ws.home);
    assert.deepEqual(entries.map((e) => e.scope.harness), ['opencode'], 'only the scope that ran cleared');
    assert.equal(f.ws.host.list(ACCESS_BLOCKED_COLLECTION).some((r) => r.taskId === 'T1'), false);
  } finally {
    f.done();
  }
});

test('R70: a limit again after an automatic resume waits for a person (OP-5)', async () => {
  const f = await fixture();
  try {
    await f.ws.host.transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, `${f.ws.workspaceId}/T1`, { workspaceId: f.ws.workspaceId, taskId: 'T1', scopeKey: null, class: 'usage-window', untilMs: NOW - 1, blockedAtMs: NOW - 10, resumed: true, autoResume: true }));
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'codex', authMode: 'subscription', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } })), 'gpt-6-sol');
    const row = blockedRow(f);
    assert.deepEqual([row.resumed, row.autoResume], [false, false]);
    // The reason promises no second resume.
    assert.match(getTask(f.ws, 'T1').stateReason, /; it was already resumed once, so a person starts it again after that$/);
  } finally {
    f.done();
  }
});

test('R70: a port that reports another harness than the one launched cannot pause that harness: the limit goes under the launch\'s harness, and the run record shows the mismatch', async () => {
  const f = await fixture();
  try {
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } }), 'codex'), 'gpt-6-sol');
    const { entries } = await readAccessLimits(f.ws.home);
    assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.authMode, e.class]), [['codex', 'subscription', 'usage-window']]);
    const [record] = workerRuns(f.ws, 'T1');
    assert.deepEqual([record.harness, record.accessLimit.harnessMismatch], ['codex', true]);
  } finally {
    f.done();
  }
});

test('R70 (gap 4): an untimed pause\'s task reason names only the ways it can clear for its scope: a new key only for an API key Jevris passes (every harness but Antigravity), a finished session turn only for the unknown sign-in, and jevris route limits clear always', async () => {
  const CLEAR = 'jevris route limits clear';
  const fp = credentialFingerprint('dummy-key-one');
  // The last two are owned runs through a pinned host, whose own key counts (after C's LOW B).
  const hosts = [['claude', 'anthropic'], ['codex', 'openai'], ['kilocode', 'moonshot'], ['opencode', 'zai'], ['antigravity', 'google'], ['opencode', 'openrouter'], ['kilocode', 'openrouter']];
  for (const [harness, host] of hosts) {
    for (const authMode of ['api-key', 'subscription', 'unknown']) {
      for (const fingerprint of authMode === 'api-key' ? [fp, null] : [null]) {
        const entry = { key: '0123456789abcdef', scope: { harness, authMode, servingHost: host, modelId: null, family: null }, class: 'credit-exhausted', signal: 'x', source: 'owned-run', firstSeenMs: NOW, lastSeenMs: NOW, untilMs: null, step: 0, weekly: false, resetBasis: 'none', count: 1, fingerprint };
        const reason = accessReason({ pause: { class: 'credit-exhausted', untilMs: null, entry } });
        const label = `${harness} ${authMode} ${fingerprint === null ? 'no key held' : 'key held'}`;
        assert.ok(reason.startsWith(`ACCESS_LIMITED: credit-exhausted on ${harness} ${authMode} ${host} since 2026-09-28; `), label);
        assert.ok(reason.endsWith(`${CLEAR}; once cleared it is resumed if owned workers run automatically and its checks are still approved`), `${label}: a person can always clear it`);
        // G-9: every harness but Antigravity compares the key Jevris passes; OpenCode and Kilo name whose key it is.
        const newKey = harness !== 'antigravity' && authMode === 'api-key' && fingerprint !== null;
        assert.equal(/API key/.test(reason), newKey, `${label}: a new key is named only where launches compare keys`);
        const named = harness === 'opencode' || harness === 'kilocode' ? `${host} ` : '';
        assert.equal(reason.includes(`; clears when the ${named}API key Jevris passes changes, or with ${CLEAR}; `), newKey, `${label}: the key is named as its serving host's`);
        assert.equal(/session turn/.test(reason), authMode === 'unknown', `${label}: a finished session turn only for the unknown sign-in`);
        assert.doesNotMatch(reason, /successful run|new key,/, label);
        assert.equal(reason.endsWith(`${untimedClearText(entry)}; once cleared it is resumed if owned workers run automatically and its checks are still approved`), true);
      }
    }
  }
  // A timed pause keeps core's text, which names its reset.
  const timed = { key: '0123456789abcdef', scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null }, class: 'usage-window', signal: 'codex.text.x1', source: 'owned-run', firstSeenMs: NOW, lastSeenMs: NOW, untilMs: NOW + 3_600_000, step: 0, weekly: false, resetBasis: 'rule', count: 1, fingerprint: null };
  assert.match(accessReason({ pause: { class: 'usage-window', untilMs: timed.untilMs, entry: timed } }), /paused until 2026-09-28T11:00Z \(rule\); resumed once then if owned workers run automatically and its checks are still approved, else start it again then$/);
  // End to end: a Claude API-key launch whose key Jevris passes offers the new-key clear.
  const f = await fixture();
  try {
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'claude', authMode: 'api-key', accessSignal: { port: 'claude-api', channel: 'structured', status: 402 } }), 'claude', 'api-key'), 'claude-sonnet-5', { env: { ANTHROPIC_API_KEY: 'dummy-key-one' } });
    assert.match(getTask(f.ws, 'T1').stateReason, /^ACCESS_LIMITED: credit-exhausted on claude api-key anthropic since 2026-09-28; clears when the API key Jevris passes changes, or with jevris route limits clear; once cleared it is resumed if owned workers run automatically and its checks are still approved$/);
  } finally {
    f.done();
  }
});

test('R75: an access limit or an overload is never a failure label: access-limit and overloaded runs, and a run the runner found at a limit whatever its port\'s status, are not run-incomplete', () => {
  const run = (status, extra = {}) => ({ status, pathViolations: [], ...extra });
  for (const s of ['access-limit', 'overloaded', 'usage-limit']) assert.equal(runIncomplete(run(s)), false, s);
  const found = { class: 'account-blocked', signal: 'kilocode.error.provider-auth', weekly: false, resetBasis: 'none', recorded: 'RECORDED' };
  assert.equal(runIncomplete(run('refused', { accessLimit: found })), false, 'a blocked account is not the model\'s failure');
  assert.equal(runIncomplete(run('failed', { accessLimit: { ...found, class: 'overloaded', signal: 'claude-api.http.overloaded', recorded: 'NOT_A_PAUSE' } })), false);
  assert.equal(runIncomplete(run('refused')), true, 'a refusal with no access limit still counts');
});

test('R71: a session turn that fails on an access signal is recorded under the model that failed (source session, unknown sign-in); a finished turn clears it', async () => {
  const home = join(tempDir('jv-access-session-'), 'home');
  mkdirSync(home);
  const ev = (harness, kind, extra = {}) => ({ harness, kind, sessionId: 's-1', agentId: null, model: null, payload: {}, ...extra });
  let t = NOW;
  // OpenCode: the answering model comes on message.completed; the failed turn names none.
  assert.equal(noteSessionAccess(home, ev('opencode', 'message.completed', { model: 'zai/glm-5.3' }), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED');
  assert.equal(noteSessionAccess(home, ev('opencode', 'turn.failed', { payload: { accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } } }), (t += 60_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  let { entries } = await readAccessLimits(home);
  assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.authMode, e.scope.servingHost, e.class, e.source, e.untilMs]), [['opencode', 'unknown', 'zai', 'credit-exhausted', 'session', null]]);
  // A success of the failed turn itself clears nothing; the next turn's does (MEDIUM 25).
  assert.equal(noteSessionAccess(home, ev('opencode', 'message.completed', { model: 'zai/glm-5.3' }), (t += 60_000)), null);
  noteSessionAccess(home, ev('opencode', 'task.requested'), (t += 1_000));
  assert.equal(noteSessionAccess(home, ev('opencode', 'message.completed', { model: 'zai/glm-5.3' }), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED');
  await drainSessionAccess();
  assert.equal((await readAccessLimits(home)).entries.length, 0, 'a turn that finished clears the scope');
  // A success clears a scope at most once in 10 s.
  assert.equal(noteSessionAccess(home, ev('opencode', 'message.completed', { model: 'zai/glm-5.3' }), t + 1_000), null);
  // A payload that is not a wire signal (it carries text), or a failure with no known model, records nothing.
  assert.equal(noteSessionAccess(home, ev('opencode', 'turn.failed', { payload: { accessSignal: { port: 'opencode', channel: 'error-text', message: CANARY } } }), (t += 60_000)), null);
  assert.equal(noteSessionAccess(home, ev('opencode', 'turn.failed', { sessionId: 's-other', payload: { accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } } }), (t += 60_000)), null);
  // A Kilo child session's failure is recorded under its own model.
  noteSessionAccess(home, ev('kilocode', 'message.completed', { agentId: 'a-1', model: 'moonshotai/kimi-k3' }), (t += 60_000));
  assert.equal(noteSessionAccess(home, ev('kilocode', 'worker.failed', { agentId: 'a-1', payload: { accessSignal: { port: 'kilocode', channel: 'structured', errorType: 'ProviderAuthError' } } }), (t += 60_000)), 'ACCESS_QUEUED');
  // Claude Code: the session's model from SessionStart; StopFailure's billing_error; then a Stop clears it.
  noteSessionAccess(home, ev('claude', 'session.started', { model: 'claude-opus-5-5[1m]' }), (t += 60_000));
  assert.equal(noteSessionAccess(home, ev('claude', 'turn.failed', { payload: { accessSignal: { port: 'claude', channel: 'structured', errorType: 'billing_error' } } }), (t += 60_000)), 'ACCESS_QUEUED');
  await drainSessionAccess();
  ({ entries } = await readAccessLimits(home));
  assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.servingHost, e.class]).sort(), [['claude', 'anthropic', 'credit-exhausted'], ['kilocode', 'moonshot', 'account-blocked']]);
  assert.equal(noteSessionAccess(home, ev('claude', 'turn.stopped', { agentId: 'sub-1' }), (t += 60_000)), null, 'a subagent\'s stop is not the session\'s success');
  noteSessionAccess(home, ev('claude', 'task.requested'), (t += 1_000));
  assert.equal(noteSessionAccess(home, ev('claude', 'turn.stopped'), (t += 60_000)), 'ACCESS_SUCCESS_QUEUED');
  await drainSessionAccess();
  assert.deepEqual((await readAccessLimits(home)).entries.map((e) => e.scope.harness), ['kilocode']);
  assert.doesNotMatch(JSON.stringify(await readAccessLimits(home)), /CANARY-9c1d/);
});

test('OP-4: an owned run\'s text signal is trusted only when the harness\'s record certifies access.detect; uncertified, or certified for another feature, it is held as a timed window', async () => {
  const asked = [];
  const codexText = (f) => run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'codex', authMode: 'subscription', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X2') } }), 'codex'), 'gpt-6-sol');
  try {
    // Certified: the credit text is an untimed pause.
    setCertificationGate(async (q) => (asked.push([q.harness, q.featureId]), { certified: q.harness === 'codex' && q.featureId === 'access.detect', reasonCode: null }));
    const f = await fixture();
    try {
      await codexText(f);
      assert.deepEqual((await readAccessLimits(f.ws.home)).entries.map((e) => [e.class, e.untilMs]), [['credit-exhausted', null]]);
      assert.deepEqual(asked, [['codex', 'access.detect']], 'the owned channel asks for access.detect only, for the harness launched');
    } finally {
      f.done();
    }
    // Certified for the session channel only, or not certified at the installed version: held as timed.
    for (const answer of [(q) => ({ certified: q.featureId === 'access.session', reasonCode: null }), () => ({ certified: false, reasonCode: 'VERSION_OUT_OF_RANGE' })]) {
      setCertificationGate(async (q) => answer(q));
      const g = await fixture();
      try {
        await codexText(g);
        const [entry] = (await readAccessLimits(g.ws.home)).entries;
        assert.equal(entry.class, 'usage-window');
        assert.notEqual(entry.untilMs, null);
      } finally {
        g.done();
      }
    }
  } finally {
    setCertificationGate(null);
  }
});

test('OP-11: an owned run\'s usage window with no reported reset is timed from the workspace\'s limitCooldownHours; with no learning state it is 5 h', async () => {
  const x1 = (f) => run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'codex', authMode: 'subscription', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } }), 'codex'), 'gpt-6-sol');
  const f = await fixture();
  try {
    assert.equal((await saveLearningState(f.ws.home, emptyLearningState({ workspaceId: f.ws.workspaceId, now: new Date(NOW).toISOString(), settings: { limitCooldownHours: 2 } }))).ok, true);
    await x1(f);
    const [entry] = (await readAccessLimits(f.ws.home)).entries;
    assert.deepEqual([entry.class, entry.untilMs - NOW], ['usage-window', 2 * 3_600_000]);
    assert.equal(workerRuns(f.ws, 'T1')[0].accessLimit.resetAtMs - NOW, 2 * 3_600_000, 'the run record carries the same time');
  } finally {
    f.done();
  }
  const g = await fixture();
  try {
    await x1(g);
    assert.equal((await readAccessLimits(g.ws.home)).entries[0].untilMs - NOW, 5 * 3_600_000);
  } finally {
    g.done();
  }
});

test('R74: accessPausedModels names the models paused on the scope the port would run each on; a port that throws for a model leaves it unnamed, never failing the caller (B\'s LOW 38)', async () => {
  const dir = tempDir('jv-paused-');
  const home = join(dir, 'home');
  mkdirSync(home);
  await seed(home, { harness: 'codex', spelling: 'gpt-6-sol', authMode: 'subscription', signal: { port: 'codex', channel: 'error-text', text: textMatch('X1') }, nowMs: Date.now() });
  const port = {
    harnessFor: (model) => {
      if (model === 'odd-model') throw new Error('port bug');
      return model.startsWith('gpt-') ? 'codex' : 'claude';
    },
    authFor: async (model) => (model === 'claude-sonnet-5' ? Promise.reject(new Error('auth bug')) : { mode: 'subscription', source: 'environment' }),
  };
  const paused = await accessPausedModels({ home, registry: BUNDLED_MODEL_REGISTRY, port, models: ['gpt-6-sol', 'odd-model', 'claude-sonnet-5'], nowMs: Date.now() });
  assert.deepEqual([...paused], ['gpt-6-sol']);
  assert.deepEqual([...(await accessPausedModels({ home, registry: BUNDLED_MODEL_REGISTRY, port: {}, models: ['gpt-6-sol'], nowMs: Date.now() }))], [], 'a port that cannot say which harness runs a model names nothing');
});

/** Sets the managed-worker mode, with orchestration on; the resume tick requires bounded-auto. */
function boundedAuto(home, mode = 'bounded-auto') {
  const cfg = jevrisPaths({ home }).config;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, managedWorkers: mode }, orchestration: { ...DEFAULT_CONFIG.orchestration, enabled: true } }));
}

/** A sidecar op context for the tick, and a continueWork seam that counts its calls. */
function tick(killSwitchStopped = false) {
  const traces = [];
  let continued = 0;
  return {
    traces,
    get continued() {
      return continued;
    },
    ctx: { killSwitchStopped, trace: (event) => traces.push(event) },
    options: { continueWork: async () => (continued += 1), env: {} },
  };
}

const codexWindow = (f) => run(f, port((input) => outcome(input, { status: 'access-limit', reason: CANARY, harness: 'codex', authMode: 'subscription', accessSignal: { port: 'codex', channel: 'error-text', text: textMatch('X1') } })), 'gpt-6-sol');

test('R76: a task blocked on a timed access limit goes back to ready once, at its reset, and owned work continues; before the reset, or a second time, nothing moves', async () => {
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await codexWindow(f);
    const reset = NOW + 5 * 3_600_000;
    assert.deepEqual([blockedRow(f).harness, blockedRow(f).model, blockedRow(f).authMode], ['codex', 'gpt-6-sol', 'subscription'], 'the row keeps what the task ran on');
    const t = tick();
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, reset - 1, t.options), { resumed: [], reasonCode: 'OK' });
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, reset + 1, t.options), { resumed: ['T1'], reasonCode: 'OK' });
    const task = getTask(f.ws, 'T1');
    assert.deepEqual([task.node.state, task.stateReason], ['ready', ACCESS_LIMIT_RESET]);
    assert.deepEqual([blockedRow(f).resumed, blockedRow(f).resumedAtMs], [true, reset + 1]);
    assert.equal(t.continued, 1, 'owned work continues');
    assert.deepEqual(t.traces.map((e) => [e.event, e.reasonCode]), [['orchestrator.access-resumed', ACCESS_LIMIT_RESET]]);
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, reset + 60_000, t.options), { resumed: [], reasonCode: 'OK' }, 'once only');
    assert.equal(t.continued, 1);
  } finally {
    f.done();
  }
});

test('R76: nothing resumes with the kill switch on, without bounded-auto managed workers, or when the row waits for a person', async () => {
  const f = await fixture();
  try {
    await codexWindow(f);
    const later = NOW + 6 * 3_600_000;
    const t = tick();
    boundedAuto(f.ws.home, 'advise');
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, later, t.options), { resumed: [], reasonCode: 'NOT_BOUNDED_AUTO' }, 'advise never moves a task');
    boundedAuto(f.ws.home);
    const stopped = tick(true);
    assert.deepEqual(await resumeAccessBlocked(stopped.ctx, f.ws, later, stopped.options), { resumed: [], reasonCode: 'KILL_SWITCH' });
    const key = `${f.ws.workspaceId}/T1`;
    const row = blockedRow(f);
    await f.ws.host.transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, key, { ...row, autoResume: false }));
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, later, t.options), { resumed: [], reasonCode: 'OK' }, 'a repeat after a resume waits for a person');
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
    assert.equal(t.continued + stopped.continued, 0);
  } finally {
    f.done();
  }
});

test('R76: a revoked check approval, or a task blocked for another reason than its row stands for, stays blocked for a person', async () => {
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await codexWindow(f);
    const later = NOW + 6 * 3_600_000;
    const t = tick();
    const key = `${f.ws.workspaceId}/T1`;
    const row = blockedRow(f);
    await f.ws.host.transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, key, { ...row, class: 'overloaded', scopeKey: null }));
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, t.options)).resumed, [], 'an overload row never moves a task an access limit blocked');
    await f.ws.host.transact((tx) => tx.put(ACCESS_BLOCKED_COLLECTION, key, row));
    assert.equal(await revokeApproval(f.ws, ['fixed']), 1);
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, t.options)).resumed, [], 'the plan approval no longer stands');
    assert.equal(blockedRow(f).resumed, false, 'the row stays for a later tick');
    const m = parseManifest({ id: 'fixed', argv: [process.execPath, '-e', "process.exit(require('fs').existsSync('mod/fixed.txt') ? 0 : 1)"], resultFormat: 'exit-code', requirementIds: ['R1'] }).manifest;
    await approveManifests(f.ws, [m], { fixed: manifestHash(m) }, 'test');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later + 1, t.options)).resumed, ['T1'], 'approved again');
    assert.equal(t.continued, 1);
  } finally {
    f.done();
  }
});

test('R76: an overload retries at its time unless another pause now covers the model; an untimed pause resumes once a person clears it, or once a new key is set', async () => {
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await run(f, port((input) => outcome(input, { status: 'overloaded', reason: 'x', harness: 'claude', authMode: 'api-key', accessSignal: { port: 'claude-api', channel: 'structured', status: 529 } })), 'claude-sonnet-5');
    const retry = blockedRow(f).untilMs;
    assert.equal(typeof retry, 'number');
    await seed(f.ws.home, { harness: 'claude', spelling: 'claude-sonnet-5', authMode: 'api-key', signal: { port: 'claude-api', channel: 'structured', status: 402 } });
    const t = tick();
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, retry + 1, t.options)).resumed, [], 'a credit pause on the same model keeps it blocked');
    assert.equal(blockedRow(f).resumed, false, 'the row stays for a later tick');
    assert.equal((await clearAccessLimits(f.ws.home, { entries: 'all', nowMs: retry + 2 })).ok, true);
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, retry + 3, t.options)).resumed, ['T1']);
  } finally {
    f.done();
  }
  const g = await fixture();
  try {
    boundedAuto(g.ws.home);
    await run(g, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } })), 'glm-5.3');
    assert.equal(blockedRow(g).untilMs, null, 'a credit pause has no reset');
    const t = tick();
    assert.deepEqual((await resumeAccessBlocked(t.ctx, g.ws, NOW + 86_400_000, t.options)).resumed, [], 'an untimed pause waits');
    assert.equal((await clearAccessLimits(g.ws.home, { entries: 'all', nowMs: NOW + 86_400_001 })).ok, true);
    assert.deepEqual((await resumeAccessBlocked(t.ctx, g.ws, NOW + 86_400_002, t.options)).resumed, ['T1'], 'a person cleared it');
  } finally {
    g.done();
  }
  const h = await fixture();
  try {
    boundedAuto(h.ws.home);
    await seed(h.ws.home, { harness: 'claude', spelling: 'claude-sonnet-5', authMode: 'api-key', signal: { port: 'claude-api', channel: 'structured', status: 402 }, fingerprint: credentialFingerprint('dummy-key-one') });
    const same = port((input) => outcome(input), 'claude', 'api-key');
    await run(h, same, 'claude-sonnet-5', { env: { ANTHROPIC_API_KEY: 'dummy-key-one' } });
    assert.deepEqual([same.runs, blockedRow(h).untilMs, blockedRow(h).authMode], [0, null, 'api-key'], 'the launch check blocked it on the untimed pause');
    const t = tick();
    const later = NOW + 86_400_000;
    assert.deepEqual((await resumeAccessBlocked(t.ctx, h.ws, later, { ...t.options, env: { ANTHROPIC_API_KEY: 'dummy-key-one' } })).resumed, [], 'the same key still waits');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, h.ws, later, { ...t.options, env: { ANTHROPIC_API_KEY: 'dummy-key-two' } })).resumed, ['T1'], 'a new key resumes it; the launch clears the old key\'s pause');
    assert.doesNotMatch(JSON.stringify(h.ws.host.list(ACCESS_BLOCKED_COLLECTION)), /dummy-key/);
  } finally {
    h.done();
  }
});

test('R76: an access record that cannot be read resumes nothing, and says so with a code only (B\'s MEDIUM 40)', async () => {
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } })), 'glm-5.3');
    assert.equal(blockedRow(f).untilMs, null, 'an untimed credit pause');
    writeFileSync(accessLimitsPath(f.ws.home), '{not json');
    const t = tick();
    assert.deepEqual(await resumeAccessBlocked(t.ctx, f.ws, NOW + 86_400_000, t.options), { resumed: [], reasonCode: 'ACCESS_LIMITS_UNREADABLE' });
    assert.equal(getTask(f.ws, 'T1').node.state, 'blocked');
    assert.equal(blockedRow(f).resumed, false, 'the row stays for a later tick');
    assert.equal(t.continued, 0);
    assert.deepEqual(t.traces, [{ event: 'orchestrator.access-resume-skipped', reasonCode: 'ACCESS_LIMITS_UNREADABLE' }]);
  } finally {
    f.done();
  }
});

test('C\'s LOW B: an owned run through a pinned host records its limit on the host and is stopped by a host pause a session recorded, never by the maker\'s', async () => {
  const hostRun = { servingHost: 'openrouter' };
  const f = await fixture();
  try {
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } }), 'opencode', 'api-key'), 'kimi-k3', hostRun);
    const { entries } = await readAccessLimits(f.ws.home);
    assert.deepEqual(entries.map((e) => [e.scope.harness, e.scope.authMode, e.scope.servingHost, e.class]), [['opencode', 'api-key', 'openrouter', 'credit-exhausted']]);
    const row = blockedRow(f);
    assert.deepEqual([row.harness, row.model, row.authMode, row.servingHost], ['opencode', 'kimi-k3', 'api-key', 'openrouter']);
  } finally {
    f.done();
  }
  // A session through OpenRouter recorded a 402: the owned run through OpenRouter never launches.
  const g = await fixture();
  try {
    await seed(g.ws.home, { harness: 'opencode', spelling: 'openrouter/moonshotai/kimi-k3', authMode: 'api-key', signal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } });
    const p = port((input) => outcome(input), 'opencode', 'api-key');
    await run(g, p, 'kimi-k3', hostRun);
    assert.equal(p.runs, 0);
    assert.match(getTask(g.ws, 'T1').stateReason, /^ACCESS_LIMITED: credit-exhausted on opencode api-key openrouter since /);
    assert.equal(blockedRow(g).servingHost, 'openrouter');
  } finally {
    g.done();
  }
  // The maker's own pause does not stop the host route.
  const h = await fixture();
  try {
    await seed(h.ws.home, { harness: 'opencode', spelling: 'moonshot/kimi-k3', authMode: 'api-key', signal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } });
    const p = port((input) => outcome(input), 'opencode', 'api-key');
    await run(h, p, 'kimi-k3', hostRun);
    assert.equal(p.runs, 1, 'the host route launched');
  } finally {
    h.done();
  }
});

test('C\'s LOW B: a task blocked through a pinned host resumes once its host pause is cleared, and a pause on the maker\'s own route does not hold it', async () => {
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } }), 'opencode', 'api-key'), 'kimi-k3', { servingHost: 'openrouter' });
    const [hostEntry] = (await readAccessLimits(f.ws.home)).entries;
    await seed(f.ws.home, { harness: 'opencode', spelling: 'moonshot/kimi-k3', authMode: 'api-key', signal: { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 } });
    const t = tick();
    const later = NOW + 60_000;
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, t.options)).resumed, [], 'the host pause still stands');
    assert.equal((await clearAccessLimits(f.ws.home, { entries: [hostEntry.key], nowMs: later })).ok, true);
    assert.equal((await readAccessLimits(f.ws.home)).entries.length, 1, 'the maker pause is still recorded');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later + 1, t.options)).resumed, ['T1']);
  } finally {
    f.done();
  }
});

test('the coordinator\'s 1.2 decision after LOW B: a host run\'s untimed pause clears when the host key Jevris passes changes, never when the maker\'s key does, and its reason names the host key', async () => {
  const credit = { port: 'opencode', channel: 'structured', errorType: 'APIError', status: 402 };
  const hostOne = { OPENROUTER_API_KEY: 'dummy-host-one', MOONSHOT_API_KEY: 'dummy-maker-one' };
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'opencode', authMode: 'api-key', accessSignal: credit }), 'opencode', 'api-key'), 'kimi-k3', { servingHost: 'openrouter', env: hostOne });
    const [entry] = (await readAccessLimits(f.ws.home)).entries;
    assert.deepEqual([entry.scope.servingHost, entry.fingerprint], ['openrouter', credentialFingerprint('dummy-host-one')], 'the host key is recorded, never the maker\'s');
    assert.match(getTask(f.ws, 'T1').stateReason, /; clears when the openrouter API key Jevris passes changes, or with jevris route limits clear; once cleared/);
    const t = tick();
    const later = NOW + 60_000;
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: hostOne })).resumed, [], 'the same host key waits');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: { ...hostOne, MOONSHOT_API_KEY: 'dummy-maker-two' } })).resumed, [], 'a new maker key does not count on the host');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: { ...hostOne, OPENROUTER_API_KEY: 'dummy-host-two' } })).resumed, ['T1'], 'a new host key resumes it');
  } finally {
    f.done();
  }
  // At launch: the same host key, or only a new maker key, stays paused; a new host key clears the old key's pause and runs.
  for (const [env, runs, left] of [[hostOne, 0, 1], [{ ...hostOne, MOONSHOT_API_KEY: 'dummy-maker-two' }, 0, 1], [{ ...hostOne, OPENROUTER_API_KEY: 'dummy-host-two' }, 1, 0]]) {
    const g = await fixture();
    try {
      await seed(g.ws.home, { harness: 'opencode', spelling: 'openrouter/moonshotai/kimi-k3', authMode: 'api-key', signal: credit, fingerprint: credentialFingerprint('dummy-host-one') });
      const p = port((input) => outcome(input), 'opencode', 'api-key');
      await run(g, p, 'kimi-k3', { servingHost: 'openrouter', env });
      assert.equal(p.runs, runs, JSON.stringify(Object.keys(env)));
      assert.equal((await readAccessLimits(g.ws.home)).entries.length, left);
    } finally {
      g.done();
    }
  }
});

test('G-9 (D\'s trace 3): a direct Kilo or OpenCode run\'s untimed pause clears when the maker key Jevris passes changes, never on the same key or another host\'s key, and its reason names the maker', async () => {
  const credit = (p) => ({ port: p, channel: 'structured', errorType: 'APIError', status: 402 });
  const keyOne = { MOONSHOT_API_KEY: 'dummy-maker-one', OPENROUTER_API_KEY: 'dummy-host-one' };
  const f = await fixture();
  try {
    boundedAuto(f.ws.home);
    await run(f, port((input) => outcome(input, { status: 'access-limit', reason: 'x', harness: 'kilo', authMode: 'api-key', accessSignal: credit('kilocode') }), 'kilo', 'api-key'), 'kimi-k3', { env: keyOne });
    const [entry] = (await readAccessLimits(f.ws.home)).entries;
    assert.deepEqual([entry.scope.harness, entry.scope.servingHost, entry.fingerprint], ['kilocode', 'moonshot', credentialFingerprint('dummy-maker-one')]);
    assert.match(getTask(f.ws, 'T1').stateReason, /; clears when the moonshot API key Jevris passes changes, or with jevris route limits clear; once cleared/);
    const t = tick();
    const later = NOW + 60_000;
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: keyOne })).resumed, [], 'the same maker key waits');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: { ...keyOne, OPENROUTER_API_KEY: 'dummy-host-two' } })).resumed, [], 'a host key is not the maker key');
    assert.deepEqual((await resumeAccessBlocked(t.ctx, f.ws, later, { ...t.options, env: { ...keyOne, MOONSHOT_API_KEY: 'dummy-maker-two' } })).resumed, ['T1'], 'a new maker key resumes it');
  } finally {
    f.done();
  }
  for (const [env, runs, left] of [[keyOne, 0, 1], [{ ...keyOne, OPENROUTER_API_KEY: 'dummy-host-two' }, 0, 1], [{ ...keyOne, MOONSHOT_API_KEY: 'dummy-maker-two' }, 1, 0]]) {
    const g = await fixture();
    try {
      await seed(g.ws.home, { harness: 'opencode', spelling: 'moonshotai/kimi-k3', authMode: 'api-key', signal: credit('opencode'), fingerprint: credentialFingerprint('dummy-maker-one') });
      const p = port((input) => outcome(input), 'opencode', 'api-key');
      await run(g, p, 'kimi-k3', { env });
      assert.equal(p.runs, runs, JSON.stringify(Object.keys(env)));
      assert.equal((await readAccessLimits(g.ws.home)).entries.length, left);
    } finally {
      g.done();
    }
  }
});
