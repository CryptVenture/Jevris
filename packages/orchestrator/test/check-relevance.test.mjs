// Owner decision 2026-10-01 (Jev as an active decision aid): the Stop reminder names the missing
// checks in relevance order, and `jevris verify` (and a background run at Stop) runs the approved
// checks in that order. Order only: every approved check is still named, still runs and still needs
// its own receipt. Stub engines (no live Jev), temporary homes, stub checks, no wall-clock window
// under 2 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import { jevrisPaths } from '@jevris/platform';
import {
  DEFAULT_CONFIG,
  approveManifests,
  handleHookEvent,
  manifestHash,
  openWorkspace,
  parseManifest,
  runVerification,
  setSubscriberGit,
  sidecarOps,
  SURFACE_OP_OF,
  verificationStatus,
} from '../dist/index.js';
import { pendingChecks } from '../dist/verify/runs.js';
import { nodeGit } from '../dist/verify/revision.js';
import { resetStopAutoVerifyState } from '../dist/hooks/stop-autoverify.js';
import { changedPathsOf, lastStateOf, orderIsInformed, orderMissingEvidence, rankApprovedChecks } from '../dist/verify/relevance.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';
import { removeTree } from '../../../scripts/remove-tree.mjs';

const NODE = process.execPath;
const PASS = [NODE, '-e', '0'];
const FAIL = [NODE, '-e', 'process.exit(1)'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture() {
  resetStopAutoVerifyState();
  const dir = tempDir('jv-relevance-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'docs', 'readme.md'), '# doc\n');
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
    deadline: { budgetMs: 30_000, remainingMs: () => 30_000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: (e) => traces.push(e),
    ...extra,
  });
  const ranked = () => traces.filter((t) => t.event === 'orchestrator.checks-ranked');
  return {
    dir,
    home,
    repo,
    ws,
    ctx,
    traces,
    ranked,
    log: join(dir, 'ran.log'),
    editSource: () => writeFileSync(join(repo, 'lib', 'a.js'), 'export const a = 2;\n'),
    editDocs: () => writeFileSync(join(repo, 'docs', 'readme.md'), '# doc, changed\n'),
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
const stop = (f, env) => handleHookEvent(stopEvent(f, {}, env));

/**
 * A Stop whose changed-files read is already in memory. The ranking waits for that read only for
 * the time the request has left less its margin (150 ms, or 50 ms, in the tests below), so with a
 * real git a loaded host that starts git slowly answers GIT_DEADLINE where the test is about Jev's
 * deadline or the lack of time. The read is made here once, with no deadline, and the Stop then
 * gets the same answer at once. Which git calls the Stop makes is unchanged.
 */
async function stopWithWarmGit(f, env) {
  const real = nodeGit();
  const seen = new Map();
  const git = {
    // By the arguments alone: the Stop names the workspace by its real path, the fixture by the path it made, and it is one repository.
    run: (args, cwd) => {
      const key = JSON.stringify(args);
      if (!seen.has(key)) seen.set(key, real.run(args, cwd));
      return seen.get(key);
    },
  };
  await changedPathsOf(f.repo, git);
  setSubscriberGit(git);
  try {
    return await stop(f, env);
  } finally {
    setSubscriberGit(undefined);
  }
}

/** A check that appends its own id to the run log, then passes. */
const logging = (f, id) => [NODE, '-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")', f.log, id];
const ran = (f) => {
  try {
    return readFileSync(f.log, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
};

async function approve(f, specs) {
  const manifests = specs.map(([id, argv]) => {
    const parsed = parseManifest({ id, argv, resultFormat: 'exit-code', timeoutMs: 120_000 });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return parsed.manifest;
  });
  await approveManifests(f.ws, manifests, Object.fromEntries(manifests.map((m) => [m.id, manifestHash(m)])), 'test');
}

function userConfig(f, patch) {
  const dir = jevrisPaths({ home: f.home }).config;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...patch }));
}

const statuses = async (f) => Object.fromEntries((await verificationStatus(f.ws, { taskId: null, checkIds: [] })).checks.map((c) => [c.checkId, c.status]));
const SOURCE_STOP_NOTE = 'Order is advice (rules): unit-test first, most relevant to this change: source edits. No check is skipped or waived.';

/** A stub Jev: scores by check kind, or never answers. Every request is recorded. */
function jevEngine(scoreByKind, { hang = false } = {}) {
  const calls = [];
  return {
    calls,
    async decide(request) {
      calls.push(request);
      if (hang) return new Promise(() => undefined);
      const answers = {};
      for (const id of Object.keys(request.questions)) {
        const [kind] = String(request.packet.facts[id]).split('|');
        const level = scoreByKind[kind] ?? 2;
        answers[id] = { type: 'score', score: level, probabilities: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i), i === level ? 1 : 0])), legend: {}, confidence: 1 };
      }
      return { abstained: false, decisionId: 'd-00000000-0000-4000-8000-0000000000aa', result: { answers }, automation: true, rulesOnly: false };
    },
  };
}

const THREE = [['docs-check', PASS], ['lint', PASS], ['unit-test', PASS]];

// ------------------------------------------------------------------ the Stop reminder

test('Stop names the missing checks in relevance order with one clause on why the first is first; every check is still named', async () => {
  const f = fixture();
  try {
    await approve(f, THREE);
    f.editSource();
    const first = await stop(f);
    assert.equal(first.reasonCode, 'STOP_REMINDER', JSON.stringify(first));
    assert.deepEqual(first.stopContinuation.missingEvidence, ['unit-test', 'lint', 'docs-check'], 'a source change needs the tests first, the docs check last');
    assert.ok(first.stopContinuation.text.includes(SOURCE_STOP_NOTE), first.stopContinuation.text);
    assert.ok(first.stopContinuation.text.startsWith('Missing verification evidence: unit-test:missing, lint:missing, docs-check:missing.'), 'the reminder text lists them in the same order');
    // The reminder is spent for the same condition whatever the order: the next Stop reports unverified, with the note.
    f.editDocs();
    const second = await stop(f);
    assert.equal(second.reasonCode, 'STOP_UNVERIFIED', 'a different order is not a new condition');
    assert.match(second.hookOutcome.text, /^Unverified: the work ends without current passing receipts for /);
    assert.match(second.hookOutcome.text, /Order is advice \(rules\): /);
    assert.deepEqual(f.ranked().map((t) => [t.source, t.checks]), [['rules', 3], ['rules', 3]]);
    assert.deepEqual(await statuses(f), { 'docs-check': 'missing', lint: 'missing', 'unit-test': 'missing' }, 'nothing was run, waived or marked passed');
  } finally {
    f.done();
  }
});

test('Stop with no change known keeps the usual order and adds no line; a failing check is first whatever the change', async () => {
  const f = fixture();
  try {
    await approve(f, [['aaa-unit', PASS], ['zzz-lint', FAIL]]);
    const first = await stop(f);
    assert.deepEqual(first.stopContinuation.missingEvidence, ['aaa-unit', 'zzz-lint']);
    assert.ok(!first.stopContinuation.text.includes('Order is advice'), 'the usual order needs no line');
    // A failing receipt: it is first, with the reason.
    await runVerification(f.ws, { taskId: null, checkIds: ['zzz-lint'], store: f.ws.store });
    assert.equal((await statuses(f))['zzz-lint'], 'failed');
    const second = await stop(f);
    assert.equal(second.reasonCode, 'STOP_REMINDER', 'a failing receipt is a new condition');
    assert.deepEqual(second.stopContinuation.missingEvidence, ['zzz-lint', 'aaa-unit'], 'the failing check is first');
    assert.match(second.stopContinuation.text, /evidence: zzz-lint:failed, aaa-unit:missing\./);
    assert.match(second.stopContinuation.text, /Order is advice \(rules\): zzz-lint first, its last run failed\. No check is skipped or waived\./);
  } finally {
    f.done();
  }
});

test('Stop asks Jev for a change the rules are not sure of, from features only, and names the order Jev gave', async () => {
  const f = fixture();
  try {
    await approve(f, THREE);
    f.editSource();
    f.editDocs();
    const engine = jevEngine({ docs: 4, lint: 3, test: 1 });
    const first = await stop(f, { engine });
    assert.deepEqual(first.stopContinuation.missingEvidence, ['docs-check', 'lint', 'unit-test'], "Jev's scores put the docs check first");
    assert.match(first.stopContinuation.text, /Order is advice \(Jev\): docs-check first, Jev rated it most relevant to this change \(source edits\)\. No check is skipped or waived\./);
    assert.equal(engine.calls.length, 1, 'one request');
    const wire = JSON.stringify(engine.calls);
    for (const leak of ['readme', 'lib/a.js', 'a.js', 'docs-check', 'unit-test']) assert.equal(wire.includes(leak), false, `${leak} must not be in the request`);
    assert.deepEqual(Object.keys(engine.calls[0].questions), ['c1', 'c2', 'c3']);
    assert.equal(f.ranked()[0].source, 'jev');
    assert.deepEqual(await statuses(f), { 'docs-check': 'missing', lint: 'missing', 'unit-test': 'missing' });
  } finally {
    f.done();
  }
});

test('Jev never blocks Stop: a call that never answers is abandoned at the deadline and the rules order answers', async () => {
  const f = fixture();
  try {
    await approve(f, THREE);
    f.editSource();
    f.editDocs();
    const engine = jevEngine({}, { hang: true });
    // 600 ms left leaves 150 ms for Jev after the margin kept for the rest of the answer.
    const answer = await stopWithWarmGit(f, { engine, deadline: { budgetMs: 600, remainingMs: () => 600, expired: () => false } });
    assert.equal(answer.reasonCode, 'STOP_REMINDER', JSON.stringify(answer));
    assert.equal(engine.calls.length, 1, 'Jev was asked');
    assert.deepEqual(answer.stopContinuation.missingEvidence, ['unit-test', 'lint', 'docs-check'], 'the rules order');
    assert.equal(f.ranked()[0].reasonCode, 'CHECK_RELEVANCE_DEADLINE');
    assert.match(answer.stopContinuation.text, /Order is advice \(rules\)/);
  } finally {
    f.done();
  }
});

test('jev.assist off, the kill switch, mode off and too little time ask Jev nothing; the rules order stands with a reason', async () => {
  const cases = [
    [{ jevAssist: 'off' }, 'CHECK_RELEVANCE_ASSIST_OFF'],
    [{ killSwitchStopped: true }, 'CHECK_RELEVANCE_KILL_SWITCH'],
    [{ mode: 'off' }, 'CHECK_RELEVANCE_MODE_OFF'],
    [{ deadline: { budgetMs: 500, remainingMs: () => 500, expired: () => false } }, 'CHECK_RELEVANCE_NO_TIME'],
  ];
  for (const [extra, reasonCode] of cases) {
    const f = fixture();
    try {
      await approve(f, THREE);
      f.editSource();
      f.editDocs();
      const engine = jevEngine({ docs: 4 });
      await stopWithWarmGit(f, { engine, ...extra });
      assert.equal(engine.calls.length, 0, reasonCode);
      assert.equal(f.ranked().at(-1)?.reasonCode, reasonCode, JSON.stringify(f.traces));
    } finally {
      f.done();
    }
  }
});

test('a Stop with one missing check, or a verified one, ranks nothing', async () => {
  const f = fixture();
  try {
    await approve(f, [['lint', PASS], ['unit-test', PASS]]);
    f.editSource();
    await runVerification(f.ws, { taskId: null, checkIds: ['lint'], store: f.ws.store });
    const one = await stop(f);
    assert.deepEqual(one.stopContinuation.missingEvidence, ['unit-test']);
    assert.equal(f.ranked().length, 0, 'one check has no order');
    await runVerification(f.ws, { taskId: null, checkIds: [], store: f.ws.store });
    assert.equal((await stop(f)).reasonCode, 'VERIFIED');
    assert.equal(f.ranked().length, 0);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------ jevris verify

const op = (name) => sidecarOps.find((o) => o.op === name);

async function verify(f, body, extra = {}) {
  const out = await op('verify').handle(f.ctx('verify', body, extra));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(surfacePayloadContract(SURFACE_OP_OF.verify).validate(out.body).ok, true, JSON.stringify(out.body));
  return out.body;
}

test('verify runs every approved check, most relevant first, and says the order is advice and where it came from', async () => {
  const f = fixture();
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    f.editSource();
    const body = await verify(f, { taskId: null, checkIds: [] });
    assert.deepEqual(ran(f), ['unit-test', 'lint', 'docs-check'], 'the checks ran in relevance order');
    assert.deepEqual([...ran(f)].sort(), ['docs-check', 'lint', 'unit-test'], 'every approved check ran: the order drops none');
    assert.equal(body.ran, true);
    assert.equal(body.readiness, 'verified', 'receipts decide done, as always');
    assert.deepEqual(body.checks.map((c) => c.outcome), ['passed', 'passed', 'passed']);
    assert.equal(body.checkOrder.source, 'rules');
    assert.deepEqual(body.checkOrder.ids, ['unit-test', 'lint', 'docs-check']);
    assert.equal(body.checkOrder.reasonCode, 'CHECK_RELEVANCE_NO_PROVIDER', 'no Jev is configured in this fixture: rules-only');
    assert.equal(body.checkOrder.text, SOURCE_STOP_NOTE);
  } finally {
    f.done();
  }
});

test('verify with named checks runs only those, in relevance order; a docs change puts the docs check first', async () => {
  const f = fixture();
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    f.editDocs();
    const body = await verify(f, { taskId: null, checkIds: ['unit-test', 'docs-check'] });
    assert.deepEqual(ran(f), ['docs-check', 'unit-test'], 'only the named checks ran, the docs check first');
    assert.deepEqual(body.checkOrder.ids, ['docs-check', 'unit-test']);
    assert.equal((await statuses(f)).lint, 'missing', 'a check that was not asked for did not run');
  } finally {
    f.done();
  }
});

test('verify asks Jev for a mixed change and runs in the order Jev gave; a failed Jev call runs the rules order', async () => {
  const f = fixture();
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    f.editSource();
    f.editDocs();
    const body = await verify(f, { taskId: null, checkIds: [] }, { engine: jevEngine({ docs: 4, lint: 3, test: 1 }) });
    assert.deepEqual(ran(f), ['docs-check', 'lint', 'unit-test']);
    assert.equal(body.checkOrder.source, 'jev');
    assert.equal(body.checkOrder.asked, 3);
    assert.match(body.checkOrder.text, /^Order is advice \(Jev\): docs-check first/);
  } finally {
    f.done();
  }
  const g = fixture();
  try {
    await approve(g, THREE.map(([id]) => [id, logging(g, id)]));
    g.editSource();
    g.editDocs();
    const failing = { async decide() { throw new Error('provider down'); } };
    const body = await verify(g, { taskId: null, checkIds: [] }, { engine: failing });
    assert.deepEqual(ran(g), ['unit-test', 'lint', 'docs-check'], 'the rules order, and every check still ran');
    assert.equal(body.checkOrder.source, 'rules');
    assert.equal(body.checkOrder.reasonCode, 'CHECK_RELEVANCE_ERROR');
  } finally {
    g.done();
  }
});

test('verify with no change known runs the usual order and adds no order line', async () => {
  const f = fixture();
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    const body = await verify(f, { taskId: null, checkIds: [] });
    assert.deepEqual(ran(f), ['docs-check', 'lint', 'unit-test']);
    assert.equal(body.checkOrder, undefined);
  } finally {
    f.done();
  }
});

test('the background run queued at Stop runs the queued checks in relevance order', async () => {
  const f = fixture();
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    userConfig(f, { verification: { backgroundAtStop: 'on' } });
    f.editSource();
    await stop(f);
    for (let i = 0; i < 2400 && pendingChecks(f.ws.workspaceId, THREE.map(([id]) => id)).size > 0; i += 1) await sleep(25);
    assert.deepEqual(ran(f), ['unit-test', 'lint', 'docs-check']);
    assert.deepEqual(await statuses(f), { 'docs-check': 'passed', lint: 'passed', 'unit-test': 'passed' });
  } finally {
    f.done();
  }
});

test('runVerification order: named ids first, the rest after in the usual order, none dropped', async () => {
  const f = fixture();
  try {
    await approve(f, ['a', 'b', 'c', 'd'].map((id) => [id, logging(f, id)]));
    await runVerification(f.ws, { taskId: null, checkIds: [], order: ['c', 'a', 'unknown'], store: f.ws.store });
    assert.deepEqual(ran(f), ['c', 'a', 'b', 'd']);
  } finally {
    f.done();
  }
});

// ------------------------------------------------------------------ the helpers

test('lastStateOf, orderMissingEvidence and orderIsInformed', () => {
  assert.deepEqual(['passed', 'failed', 'missing', 'stale', 'not-run', 'unknown'].map(lastStateOf), ['passing', 'failing', 'missing', 'stale', 'missing', 'stale']);
  assert.deepEqual(orderMissingEvidence(['a:missing', 'b:failed', 'c:stale'], ['c', 'a']), ['c:stale', 'a:missing', 'b:failed'], 'entries the ranking does not name keep their place after');
  assert.deepEqual(orderMissingEvidence(['a:missing', 'b:missing'], []), ['a:missing', 'b:missing']);
  assert.equal(orderIsInformed({ shape: 'none', firstWhy: 'unknown' }), false);
  assert.equal(orderIsInformed({ shape: 'none', firstWhy: 'failed' }), true);
  assert.equal(orderIsInformed({ shape: 'docs', firstWhy: 'shape' }), true);
});

test('rankApprovedChecks never throws: a throwing engine, an unreadable change and a bad deadline are the rules order', async () => {
  const ctx = (extra = {}) => ({ engine: { async decide() { throw new Error('x'); } }, mode: 'advise', jevAssist: 'classify', killSwitchStopped: false, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, ...extra });
  const checks = [{ id: 'unit-test', state: 'missing' }, { id: 'docs-check', state: 'missing' }];
  const thrown = await rankApprovedChecks({ ctx: ctx(), workspaceId: 'w', checks, paths: ['lib/a.js', 'docs/a.md'] });
  assert.deepEqual([thrown.source, thrown.reasonCode], ['rules', 'CHECK_RELEVANCE_ERROR']);
  const noGit = await rankApprovedChecks({ ctx: ctx({ engine: undefined }), workspaceId: 'w', checks, paths: Promise.reject(new Error('git')) });
  assert.deepEqual([noGit.source, noGit.reasonCode, noGit.order], ['rules', 'CHECK_RELEVANCE_NO_PROVIDER', ['unit-test', 'docs-check']]);
  const late = await rankApprovedChecks({ ctx: ctx({ deadline: { budgetMs: 1, remainingMs: () => -50, expired: () => true } }), workspaceId: 'w', checks, paths: ['lib/a.js', 'docs/a.md'] });
  assert.equal(late.reasonCode, 'CHECK_RELEVANCE_NO_TIME');
});

// ------------------------------------------------------------------ the Stop answer never waits for git (review of wave 1, M2)

/** Fails fast (20 s, a guard and not an assertion on speed) if `promise` never settles. */
const settles = (promise) => Promise.race([promise, sleep(20_000).then(() => assert.fail('the call did not settle: it is waiting for git'))]);

test('rankApprovedChecks does not wait past its deadline for the changed-files read: rules order with a reason code, no Jev call (M2)', async () => {
  const engine = jevEngine({ docs: 4 });
  const ctx = { engine, mode: 'advise', jevAssist: 'classify', killSwitchStopped: false, deadline: { budgetMs: 600, remainingMs: () => 600, expired: () => false } };
  const checks = [{ id: 'unit-test', state: 'missing' }, { id: 'docs-check', state: 'missing' }, { id: 'lint', state: 'missing' }];
  // A read that never resolves (a locked or very slow git).
  const never = await settles(rankApprovedChecks({ ctx, workspaceId: 'w', checks, paths: new Promise(() => undefined), marginMs: 550 }));
  assert.deepEqual([never.source, never.reasonCode, never.order, never.shape, never.asked], ['rules', 'CHECK_RELEVANCE_GIT_DEADLINE', ['unit-test', 'docs-check', 'lint'], 'none', false]);
  // A read that finishes after the deadline is just as late: the order does not use it.
  const late = await settles(rankApprovedChecks({ ctx, workspaceId: 'w', checks, paths: sleep(400).then(() => ['lib/a.js', 'docs/b.md']), marginMs: 550 }));
  assert.deepEqual([late.source, late.reasonCode, late.order, late.shape], ['rules', 'CHECK_RELEVANCE_GIT_DEADLINE', ['unit-test', 'docs-check', 'lint'], 'none']);
  assert.equal(engine.calls.length, 0, 'Jev is not asked about a change that is not known');
  // No time left at all: a read that is not already in is not waited for.
  const spent = await settles(rankApprovedChecks({ ctx: { ...ctx, deadline: { budgetMs: 1, remainingMs: () => -50, expired: () => true } }, workspaceId: 'w', checks, paths: new Promise(() => undefined) }));
  assert.equal(spent.reasonCode, 'CHECK_RELEVANCE_GIT_DEADLINE');
  // A read that is already in (started earlier) is used, even with no time left.
  const ready = await settles(rankApprovedChecks({ ctx: { ...ctx, deadline: { budgetMs: 1, remainingMs: () => -50, expired: () => true } }, workspaceId: 'w', checks, paths: Promise.resolve(['docs/b.md']) }));
  assert.notEqual(ready.reasonCode, 'CHECK_RELEVANCE_GIT_DEADLINE');
  assert.equal(ready.shape, 'docs');
});

test('a Stop with a git that never answers the changed-files read still answers, with the rules order and a reason, and the rest of the Stop path runs (M2)', async () => {
  const f = fixture();
  const real = nodeGit();
  // Only the changed-files read hangs; every other git call is the real one.
  const stub = { run: (args, cwd) => (args[0] === 'diff' && args.includes('--name-only') ? new Promise(() => undefined) : real.run(args, cwd)) };
  try {
    await approve(f, THREE.map(([id]) => [id, logging(f, id)]));
    userConfig(f, { verification: { backgroundAtStop: 'on' } });
    f.editSource();
    setSubscriberGit(stub);
    // 600 ms left leaves 150 ms for the changed-files read after the margin kept for the rest of the answer.
    const answer = await settles(stop(f, { deadline: { budgetMs: 600, remainingMs: () => 600, expired: () => false } }));
    // The remaining steps ran: the background run of the missing checks was queued (the answer says they are
    // running) and the Stop was decided, with the usual order because the change was not read in time.
    assert.equal(answer.reasonCode, 'STOP_UNVERIFIED', JSON.stringify(answer));
    assert.match(answer.hookOutcome.text, /receipts for docs-check:missing, lint:missing, unit-test:missing\./);
    assert.match(answer.hookOutcome.text, /Still running in the background: docs-check \(running\), lint \(running\), unit-test \(running\);/);
    assert.deepEqual(f.ranked().map((t) => [t.source, t.reasonCode, t.checks]), [['rules', 'CHECK_RELEVANCE_GIT_DEADLINE', 3]]);
    // The background run finishes: every check ran, in the usual order.
    for (let i = 0; i < 2400 && pendingChecks(f.ws.workspaceId, THREE.map(([id]) => id)).size > 0; i += 1) await sleep(25);
    assert.deepEqual(ran(f), ['docs-check', 'lint', 'unit-test'], 'every check ran, in the usual order');
    assert.deepEqual(await statuses(f), { 'docs-check': 'passed', lint: 'passed', 'unit-test': 'passed' });
  } finally {
    setSubscriberGit(undefined);
    f.done();
  }
});
