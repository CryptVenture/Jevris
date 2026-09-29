// A verify request answers within its deadline while its run goes on in the background. Each
// requested check that has not answered yet says why (RUNNING or QUEUED), a request never joins
// a run that leaves its checks out, and a check never inherits the sidecar's private umask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { surfacePayloadContract } from '@jevris/contracts';
import {
  approveManifests,
  checkUmask,
  decideStop,
  failureOf,
  manifestHash,
  openWorkspace,
  parseManifest,
  runCheck,
  runVerification,
  sidecarOps,
  SURFACE_OP_OF,
  verificationStatus,
  VERIFY_FAILED_TESTS_MAX,
  verifyAnswer,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const NODE = process.execPath;
const POSIX_ONLY = process.platform === 'win32' ? 'file-mode masks are POSIX' : false;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function fixture() {
  const dir = tempDir('jv-vbg-');
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
  // A short request deadline: the answer is due long before a gated check can end.
  const ctx = (op, body, remainingMs = 200) => ({
    op,
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: remainingMs, remainingMs: () => remainingMs, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: (e) => traces.push(e),
  });
  return {
    dir,
    repo,
    ws,
    ctx,
    traces,
    done: () => {
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function manifest(id, argv, extra = {}) {
  const parsed = parseManifest({ id, argv, resultFormat: 'exit-code', timeoutMs: 120_000, ...extra });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.manifest;
}

async function approve(ws, manifests) {
  const hashes = {};
  for (const m of manifests) hashes[m.id] = manifestHash(m);
  await approveManifests(ws, manifests, hashes, 'test');
}

const op = (name) => sidecarOps.find((o) => o.op === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function valid(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const checked = surfacePayloadContract(SURFACE_OP_OF.verify).validate(outcome.body);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return outcome.body;
}

const reasons = (body) => Object.fromEntries(body.checks.map((c) => [c.checkId, [c.outcome, c.reasonCode]]));

/** Polls verify.status until every check has a current pass (bounded by count, not by a clock window). */
async function untilVerified(f) {
  for (let i = 0; i < 2400; i += 1) {
    const body = valid(await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] })));
    if (body.readiness === 'verified') return body;
    await sleep(25);
  }
  assert.fail('the background runs did not finish');
}

// A check that waits until the test creates its gate file, then exits 0.
const gated = (gate) => [NODE, '-e', 'const fs = require("node:fs"); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(t); }, 20)', gate];

test('verify answers before a deadline too short for the status after the run: the accepted checks read RUNNING, never "nothing ran" (owner symptom, A\'s verify8 repro)', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    await approve(f.ws, [manifest('slow', gated(gate)), manifest('fast', [NODE, '-e', '0'])]);
    // 160 ms: no time for the run window, and at most 10 ms for the status that follows.
    const answer = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['slow'] }, 160)));
    assert.equal(answer.ran, false);
    assert.deepEqual(reasons(answer), { slow: ['not-run', 'RUNNING'], fast: ['not-run', 'NO_RECEIPT'] });
    writeFileSync(gate, 'go');
    // The run went on after the answer and its receipts arrive.
    for (let i = 0; i < 2400; i += 1) {
      const body = valid(await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] })));
      if (reasons(body).slow[0] === 'passed') break;
      await sleep(25);
    }
    assert.equal(reasons(valid(await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] }, 30_000)))).slow[0], 'passed');
  } finally {
    f.done();
  }
});

test('with the CLI\'s 5 s deadline, verify answers within its share of it (2 s), listing a check still running as RUNNING (A\'s verify8 after P5)', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    await approve(f.ws, [manifest('slow', gated(gate))]);
    const started = Date.now();
    const answer = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['slow'] }, 5_000)));
    const took = Date.now() - started;
    assert.equal(answer.ran, false);
    assert.deepEqual(reasons(answer), { slow: ['not-run', 'RUNNING'] });
    // Before, the op held the answer until 150 ms before the 5 s deadline.
    assert.ok(took < 4_000, `answered after ${String(took)} ms`);
  } finally {
    writeFileSync(gate, 'go');
    await untilVerified(f);
    f.done();
  }
});

test('verify answers within its deadline: a check still running is RUNNING, one waiting behind it is QUEUED, one not asked for is NO_RECEIPT (pair)', async () => {
  const f = fixture();
  const gate = join(f.dir, 'gate');
  try {
    await approve(f.ws, [manifest('slow', gated(gate)), manifest('fast', [NODE, '-e', '0']), manifest('never', [NODE, '-e', '0'])]);
    const first = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['slow'] })));
    assert.equal(first.ran, false, 'the run outlives the request');
    assert.equal(first.readiness, 'not-verified');
    assert.deepEqual(reasons(first), { slow: ['not-run', 'RUNNING'], fast: ['not-run', 'NO_RECEIPT'], never: ['not-run', 'NO_RECEIPT'] });

    // The bug: a request for other checks joined the run under way and ran nothing, silently.
    // Now it is queued behind that run, and says so.
    const second = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['fast'] })));
    assert.equal(second.ran, false);
    assert.deepEqual(reasons(second), { slow: ['not-run', 'RUNNING'], fast: ['not-run', 'QUEUED'], never: ['not-run', 'NO_RECEIPT'] });
    // A later request merges into the queued run instead of starting a third.
    const third = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['never'] })));
    assert.deepEqual(reasons(third), { slow: ['not-run', 'RUNNING'], fast: ['not-run', 'QUEUED'], never: ['not-run', 'QUEUED'] });
    // A request the run under way covers joins it.
    const joined = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['slow'] })));
    assert.deepEqual(reasons(joined).slow, ['not-run', 'RUNNING']);
    // verify.status runs nothing and reports the same.
    const status = valid(await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] })));
    assert.deepEqual(reasons(status), reasons(third));
    assert.equal(f.traces.filter((t) => t.event === 'orchestrator.verify-started').length, 1, 'only the first run has started');

    writeFileSync(gate, 'go');
    const done = await untilVerified(f);
    assert.deepEqual(reasons(done), { slow: ['passed', null], fast: ['passed', null], never: ['passed', null] });
    assert.equal(f.traces.filter((t) => t.event === 'orchestrator.verify-started').length, 2, 'the queued requests ran as one run');
    // With nothing in flight and time to finish, the run answers ran: true and no reason is pending.
    const again = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['fast'] }, 30_000)));
    assert.equal(again.ran, true);
    assert.equal(reasons(again).fast[1], null);
  } finally {
    writeFileSync(gate, 'go');
    f.done();
  }
});

test('verify refuses a check id that is not approved by name, and runs nothing (UNKNOWN_CHECK; pair: a known id runs)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', [NODE, '-e', '0'])]);
    const refused = await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['unit', 'nope'] }, 30_000));
    assert.equal(refused.ok, false);
    assert.equal(refused.reasonCode, 'UNKNOWN_CHECK');
    assert.match(refused.message, /no approved check is named nope/);
    assert.equal(f.ws.receipts.list(f.ws.workspaceId).length, 0, 'nothing ran');
    const known = valid(await op('verify').handle(f.ctx('verify', { taskId: null, checkIds: ['unit'] }, 30_000)));
    assert.equal(known.ran, true);
    assert.equal(known.readiness, 'verified');
  } finally {
    f.done();
  }
});

test('a check runs under the launching mask, never the sidecar private 077 it would inherit (pair: an explicit 077 is honoured)', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  // The sidecar sets 077 for itself; this test stands in for it.
  const previous = process.umask(0o077);
  try {
    assert.notEqual(checkUmask(), 0o077);
    const make = (name) => manifest(`mk-${name}`, [NODE, '-e', 'require("node:fs").mkdirSync(process.argv[1])', join(f.dir, name)]);
    const ctx = { workspaceRoot: f.repo, workspaceId: f.ws.workspaceId, evidence: f.ws.evidence, receipts: f.ws.receipts };
    const shell = await runCheck(make('shell'), ctx);
    assert.equal(shell.receipt.outcome, 'passed');
    assert.equal(statSync(join(f.dir, 'shell')).mode & 0o777, 0o777 & ~checkUmask(), 'the check sees the launching mask');
    const strict = await runCheck(make('strict'), { ...ctx, umask: 0o077 });
    assert.equal(strict.receipt.outcome, 'passed');
    assert.equal(statSync(join(f.dir, 'strict')).mode & 0o777, 0o700);
    assert.equal(process.umask(0o077), 0o077, 'this process keeps its own mask after each spawn');
  } finally {
    process.umask(previous);
    f.done();
  }
});

test('a stop while every missing check is still running is labelled unverified and keeps its one reminder; a moved revision alone is not a new condition (VER-05, US23)', async () => {
  const f = fixture();
  try {
    await approve(f.ws, [manifest('unit', [NODE, '-e', 'process.exit(1)'], { inputScopes: ['lib'] })]);
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    const failed = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    const waiting = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: failed, stopHookActive: false, state: f.ws.state, pending: new Map([['unit', 'RUNNING']]) });
    assert.equal(waiting.outcome, 'unverified');
    assert.equal(waiting.continuationScheduled, false, 'no reminder while the evidence is being produced');
    assert.match(waiting.text, /Still running in the background: unit \(running\)/);
    const first = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: failed, stopHookActive: false, state: f.ws.state });
    assert.equal(first.outcome, 'remind', 'the reminder was kept for when the run ends');
    // Other work lands outside the check's inputs: the revision moves, the condition does not.
    writeFileSync(join(f.repo, 'docs', 'readme.md'), '# other work\n');
    git(f.repo, 'commit', '-q', '-am', 'other work');
    const moved = await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] });
    assert.notEqual(moved.revision, failed.revision);
    assert.deepEqual(moved.missingEvidence, failed.missingEvidence);
    const second = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: moved, stopHookActive: false, state: f.ws.state });
    assert.equal(second.outcome, 'unverified', 'the same missing evidence is not asked for twice');
    // Pair: once the work is verified, the same condition later may remind once more.
    await approve(f.ws, [manifest('unit', [NODE, '-e', '0'], { inputScopes: ['lib'] })]);
    await runVerification(f.ws, { taskId: 'T1', checkIds: [] });
    const verified = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: await verificationStatus(f.ws, { taskId: 'T1', checkIds: [] }), stopHookActive: false, state: f.ws.state });
    assert.equal(verified.outcome, 'verified');
    const after = await decideStop({ workspaceId: f.ws.workspaceId, taskId: 'T1', completion: failed, stopHookActive: false, state: f.ws.state });
    assert.equal(after.outcome, 'remind');
  } finally {
    f.done();
  }
});

test('a failed check names its failing tests (bounded, redacted, no message text) and the evidence handle; a passed check names none (pair)', async () => {
  const f = fixture();
  try {
    // node-spec output: 25 failing tests, one with a credential-shaped name.
    const script = [
      "const lines = [];",
      "for (let i = 0; i < 25; i += 1) lines.push('\u2716 case ' + i + (i === 3 ? ' sk-ant-api03-abcdefghijklmnop' : '') + ' (1.5ms)');",
      "lines.push('\u2139 tests 30', '\u2139 pass 5', '\u2139 fail 25');",
      "console.log(lines.join('\\n'));",
      "process.exit(1);",
    ].join(' ');
    await approve(f.ws, [manifest('suite', [NODE, '-e', script], { resultFormat: 'node-spec' }), manifest('ok', [NODE, '-e', '0'])]);
    await runVerification(f.ws, { taskId: null, checkIds: [] });
    const [suite] = f.ws.receipts.list(f.ws.workspaceId).map((r) => r.receipt).filter((r) => r.checkId === 'suite');
    assert.equal(suite.outcome, 'failed');
    const { failure } = failureOf(suite);
    assert.equal(failure.failedTestCount, 25);
    assert.equal(failure.failedTests.length, VERIFY_FAILED_TESTS_MAX);
    assert.deepEqual(failure.failedTests[0], { id: 'case-0', name: 'case 0' });
    assert.doesNotMatch(JSON.stringify(failure), /sk-ant-api03-abcdefghijklmnop/, 'a secret-shaped name is redacted');
    assert.equal(failure.evidenceHandle, suite.rawOutputHandle);
    assert.match(failure.evidenceHandle, /^ev:[0-9a-f]{64}$/);
    const [ok] = f.ws.receipts.list(f.ws.workspaceId).map((r) => r.receipt).filter((r) => r.checkId === 'ok');
    assert.deepEqual(failureOf(ok), {}, 'a passed receipt carries no failure detail');
    // The verify answer always meets its contract: the detail is carried once the contract names it.
    const body = valid(await op('verify.status').handle(f.ctx('verify.status', { taskId: null, checkIds: [] })));
    assert.deepEqual(reasons(body).suite, ['failed', 'STRUCTURED_FAILURES']);
    const accepted = surfacePayloadContract(SURFACE_OP_OF.verify).validate(body).ok;
    assert.equal(accepted, true);
    const stripped = verifyAnswer({ ran: false, readiness: 'not-verified', checks: [{ checkId: 'x', mandatory: true, outcome: 'failed', receiptId: null, fresh: true, reasonCode: null, environment: null, failure }], missing: ['x'] });
    assert.equal(surfacePayloadContract(SURFACE_OP_OF.verify).validate(stripped).ok, true);
  } finally {
    f.done();
  }
});
