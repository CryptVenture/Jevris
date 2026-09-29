// ORC-07, W04: `jevris integrate` runs D's integration ops from the CLI only. Approve needs a
// person (--yes or a terminal answer), every answer is checked against D's shape before it is
// shown, and no MCP tool reaches any of it. Pairs: unconfirmed and confirmed approve, ready and
// conflicting runs, a well-formed and a malformed answer; then the real sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox as acceptanceSandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runIntegrateCommand } = await import('../dist/integrate-command.js');

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const report = (over = {}) => ({
  schemaVersion: 'jevris-integration-1',
  id: 'int-0123456789ab',
  workspaceId: 'w-1',
  taskIds: ['T1', 'T2'],
  state: 'ready',
  reasonCode: 'READY',
  baseCommit: C1,
  branch: 'jevris/integration/int-0123456789ab',
  worktreeId: 'wt-1',
  worktreePath: '/tmp/wt-1',
  integrationCommit: C2,
  tasks: [
    { taskId: 'T1', outcome: 'applied', baseCommit: C1, paths: ['src/a.js'], conflictPaths: [] },
    { taskId: 'T2', outcome: 'applied', baseCommit: C1, paths: ['src/b.js'], conflictPaths: [] },
  ],
  checks: { verified: true, mandatoryCheckIds: ['unit'], failing: [], missingEvidence: [] },
  createdAtMs: 1,
  approvedBy: null,
  approvedAtMs: null,
  mergedCommit: null,
  ...over,
});

function box(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-integrate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answer) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function integrate(b, argv, answer, { confirm = null } = {}) {
  const fake = fakePorts(answer);
  let text = '';
  const code = await runIntegrateCommand(argv, (chunk) => (text += chunk), { ports: fake.ports, env: b.env, cwd: b.work, confirm });
  return { code, text, calls: fake.calls, json: argv.includes('--json') && text.startsWith('{') ? JSON.parse(text) : null };
}

test('integrate follows an integration the sidecar answered as running until it ends (W04); one that never ends in time is left to status', async (t) => {
  const b = box(t);
  let gets = 0;
  const followed = await integrate(b, ['T1', 'T2', '--json'], (input) => {
    if (input.op === 'integration.run') return { ok: true, result: report({ state: 'running', reasonCode: 'RUNNING', baseCommit: null, branch: null, worktreeId: null, worktreePath: null, integrationCommit: null, tasks: [], checks: null }) };
    assert.equal(input.op, 'integration.get');
    assert.deepEqual(input.body, { integrationId: 'int-0123456789ab' });
    gets += 1;
    return { ok: true, result: { found: true, reports: [gets < 2 ? report({ state: 'running', reasonCode: 'RUNNING', tasks: [], checks: null }) : report()] } };
  });
  assert.equal(followed.code, 0, followed.text);
  assert.equal(followed.json.report.state, 'ready');
  assert.equal(gets, 2);
  // The sidecar stopped answering: the running report is shown, not ready (exit 1).
  const lost = await integrate(b, ['T1'], (input) => (input.op === 'integration.run' ? { ok: true, result: report({ state: 'running', reasonCode: 'RUNNING', tasks: [], checks: null }) } : { ok: false, reason: 'unavailable' }));
  assert.equal(lost.code, 1, lost.text);
  assert.match(lost.text, /int-0123456789ab is still running; jevris integrate status int-0123456789ab shows how it ends/);
  // An answer for another integration is not shown as this one.
  const other = await integrate(b, ['T1'], (input) => (input.op === 'integration.run' ? { ok: true, result: report({ state: 'running', reasonCode: 'RUNNING' }) } : { ok: true, result: { found: true, reports: [report({ id: 'int-ffffffffffff' })] } }));
  assert.equal(other.code, 1);
  assert.match(other.text, /unexpected shape/);
});

test('integrate sends the task ids and reports a ready integration (exit 0) or conflicts (exit 1)', async (t) => {
  const b = box(t);
  const ready = await integrate(b, ['T1', 'T2'], { ok: true, result: report() });
  assert.equal(ready.code, 0, ready.text);
  assert.deepEqual([ready.calls[0].op, ready.calls[0].scope, ready.calls[0].body], ['integration.run', 'cli', { taskIds: ['T1', 'T2'] }]);
  assert.match(ready.text, /^Integration int-0123456789ab is ready: approve it with jevris integrate approve int-0123456789ab\.$/m);
  assert.match(ready.text, /^mandatory checks: unit$/m);
  const conflicts = await integrate(b, ['T1', 'T2', '--json'], {
    ok: true,
    result: report({ state: 'conflicts', reasonCode: 'CONFLICTS', integrationCommit: null, tasks: [{ taskId: 'T1', outcome: 'applied', baseCommit: C1, paths: ['src/a.js'], conflictPaths: [] }, { taskId: 'T2', outcome: 'conflict', baseCommit: C1, paths: ['src/a.js'], conflictPaths: ['src/a.js'] }], checks: null }),
  });
  assert.equal(conflicts.code, 1);
  assert.equal(conflicts.json.command, 'integrate');
  assert.equal(conflicts.json.report.state, 'conflicts');
  const human = await integrate(b, ['T1', 'T2'], { ok: true, result: report({ state: 'conflicts', reasonCode: 'CONFLICTS', tasks: [{ taskId: 'T2', outcome: 'conflict', baseCommit: C1, paths: [], conflictPaths: ['src/a.js'] }], checks: null }) });
  assert.match(human.text, /is conflicts \(CONFLICTS\); your checkout was not changed/);
  assert.match(human.text, /^ {2}conflict: src\/a\.js$/m);
});

test('a git failure is shown as blocked with git\'s own message; a malformed message is refused (ORC-07 git-error pair)', async (t) => {
  const b = box(t);
  const failed = (error) => ({
    ok: true,
    result: report({
      state: 'blocked',
      reasonCode: 'GIT_ERROR',
      integrationCommit: null,
      tasks: [
        { taskId: 'T1', outcome: 'applied', baseCommit: C1, paths: ['src/a.js'], conflictPaths: [] },
        { taskId: 'T2', outcome: 'git-error', baseCommit: C1, paths: ['src/b.js'], conflictPaths: [], error },
      ],
      checks: null,
    }),
  });
  const human = await integrate(b, ['T1', 'T2'], failed('Committer identity unknown | fatal: unable to auto-detect email address'));
  assert.equal(human.code, 1, human.text);
  assert.match(human.text, /is blocked \(GIT_ERROR\); your checkout was not changed/);
  assert.match(human.text, /^- T2: git-error/m);
  assert.match(human.text, /^ {2}git said: Committer identity unknown \| fatal: unable to auto-detect email address$/m);
  assert.doesNotMatch(human.text, /conflict:/);
  const json = await integrate(b, ['T1', 'T2', '--json'], failed('Committer identity unknown'));
  assert.equal(json.json.report.tasks[1].error, 'Committer identity unknown');

  for (const bad of [7, '', 'x'.repeat(1001), 'a\0b']) {
    const refused = await integrate(b, ['T1', 'T2', '--json'], failed(bad));
    assert.deepEqual([refused.code, refused.json.reasonCode], [1, 'SIDECAR_INVALID_RESULT'], JSON.stringify(bad));
  }
});

test('bad arguments are refused before any request', async (t) => {
  const b = box(t);
  for (const argv of [[], ['../T1'], ['T1', 'T1'], ['status', 'int-XYZ'], ['approve'], ['approve', 'nope'], ['T1', '--yes'], ['T1', '--force']]) {
    const out = await integrate(b, argv, { ok: true, result: report() });
    assert.equal(out.code, 2, `${argv.join(' ')}: ${out.text}`);
    assert.deepEqual(out.calls, [], `${argv.join(' ')} reached the sidecar`);
  }
});

test('approve needs a person: without --yes or a terminal answer nothing is sent; with it the merge is reported (pair)', async (t) => {
  const b = box(t);
  const merged = { ok: true, result: { merged: true, reasonCode: 'MERGED', report: report({ state: 'merged', reasonCode: 'MERGED', approvedBy: 'dev', approvedAtMs: 2, mergedCommit: C2 }) } };
  const unconfirmed = await integrate(b, ['approve', 'int-0123456789ab'], merged);
  assert.equal(unconfirmed.code, 2);
  assert.deepEqual(unconfirmed.calls, []);
  assert.match(unconfirmed.text, /Nothing was changed\. This moves your checkout to the integration commit/);
  const declined = await integrate(b, ['approve', 'int-0123456789ab'], merged, { confirm: async () => false });
  assert.equal(declined.code, 2);
  assert.deepEqual(declined.calls, []);
  const confirmed = await integrate(b, ['approve', 'int-0123456789ab'], merged, { confirm: async () => true });
  assert.equal(confirmed.code, 0, confirmed.text);
  assert.equal(confirmed.calls[0].op, 'integration.approve');
  assert.equal(confirmed.calls[0].body.integrationId, 'int-0123456789ab');
  assert.match(confirmed.text, /was merged into your checkout at bbbbbbbbbbbb \(approved by dev\); nothing was pushed/);
  const moved = await integrate(b, ['approve', 'int-0123456789ab', '--yes'], { ok: true, result: { merged: false, reasonCode: 'BASE_MOVED', report: report() } });
  assert.equal(moved.code, 1);
  assert.match(moved.text, /^Not merged: your checkout moved since the integration was prepared; run jevris integrate again \(BASE_MOVED\)\. Your checkout was not changed\.$/m);
});

test('a malformed answer is not shown as a result', async (t) => {
  const b = box(t);
  for (const result of [
    report({ integrationCommit: 'not-a-commit' }),
    report({ state: 'done' }),
    report({ tasks: [{ taskId: 'T1', outcome: 'maybe', paths: [], conflictPaths: [] }] }),
    { ...report(), id: '../x' },
  ]) {
    const out = await integrate(b, ['T1', '--json'], { ok: true, result });
    assert.equal(out.code, 1);
    assert.equal(out.json.reasonCode, 'SIDECAR_INVALID_RESULT');
  }
  const lying = await integrate(b, ['approve', 'int-0123456789ab', '--yes', '--json'], { ok: true, result: { merged: true, reasonCode: 'NOT_READY', report: null } });
  assert.equal(lying.json.reasonCode, 'SIDECAR_INVALID_RESULT');
  const down = await integrate(b, ['status', '--json'], { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'down' });
  assert.equal(down.code, 1);
  assert.equal(down.json.reasonCode, 'NOT_RUNNING');
});

test('against the real sidecar: nothing to integrate is reported, an unknown approval is refused, and no MCP tool integrates', { skip: managedHostSkip() }, async (t) => {
  const real = await acceptanceSandbox(t);
  real.gitInit();
  assert.equal(real.startSidecar().code, 0);
  const none = real.jevris(['integrate', 'status'], { json: true });
  assert.equal(none.code, 1, none.stdout + none.stderr);
  assert.deepEqual([none.json.found, none.json.reports], [false, []]);
  const blocked = real.jevris(['integrate', 'T-none'], { json: true });
  assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
  assert.notEqual(blocked.json.report?.state ?? blocked.json.reasonCode, 'ready');
  const unknown = real.jevris(['integrate', 'approve', 'int-0123456789ab', '--yes'], { json: true });
  assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr);
  assert.deepEqual([unknown.json.merged, unknown.json.reasonCode], [false, 'UNKNOWN_INTEGRATION']);
  const client = await real.mcp();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => /integrat|merge|approve/.test(name)), []);
});
