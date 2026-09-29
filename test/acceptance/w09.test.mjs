import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot, workflow } from './lib.mjs';
import { ownedWorkers } from './owned.mjs';

// W09: budget exhaustion midway through work (SSOT §13 W09, ORC-10, US32). Two owned workers
// (D's scripted worker port) hold reservations; a third ready task is refused by the owned
// envelope (the limit minus the shutdown reserve). Jevris suggests a narrower task, a cheaper
// qualified profile, a pause or an increase, never skipping mandatory verification. Running work
// follows the budget's predeclared cancellation policy. Only the person's terminal authorization
// raises the limit, and then the third task is admitted. Unknown vendor usage stays held in full,
// and native sessions outside Jevris ownership are reported as advisory estimates only.

const ESTIMATE = 10_000;
const LIMIT = 30_000;
const RESERVE = 5_000;
/** The actor `jevris budget update` sends: the OS user, cleaned as the CLI cleans it. */
function actorOf(env) {
  const cleaned = (env.USER ?? env.USERNAME ?? 'cli').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 63);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `u${cleaned}`.slice(0, 64);
}

const task = (id, scope) => ({
  id,
  requirementIds: ['BUD-1'],
  acceptanceCheckIds: ['fixed'],
  expectedOutputs: ['patch'],
  writeScopes: [scope],
  models: ['claude-opus-5', 'claude-sonnet-5'],
  estimateMicroUsd: ESTIMATE,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

workflow('W09', 'Budget exhaustion midway through work', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  for (const dir of ['a', 'b', 'c']) box.write(`work/${dir}/index.mjs`, `export const ${dir} = 1;\n`);
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'fixed', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['BUD-1'], description: 'the mandatory check' }],
  });
  box.gitInit();
  const go = join(box.dir, 'go');
  // A reports its spend; B and C report none, so their usage is unknown.
  await box.workerScript([
    { taskId: 'A', writes: [{ path: 'a/index.mjs', text: 'export const a = 2;\n' }], status: 'completed', costUsd: 0.004, waitForFile: go, reason: 'changed a' },
    { taskId: 'B', writes: [{ path: 'b/index.mjs', text: 'export const b = 2;\n' }], status: 'completed', waitForFile: go, reason: 'changed b' },
    { taskId: 'C', writes: [{ path: 'c/index.mjs', text: 'export const c = 2;\n' }], status: 'completed', waitForFile: go, reason: 'changed c' },
  ]);
  await ownedWorkers(box, { maxWorkers: 3 });
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');

  // A direct CLI-key request, as the CLI sends it, run with the sandbox environment.
  const client = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href;
  const side = (op, body) => {
    const script = `const { sidecarRequest } = await import(${JSON.stringify(client)}); const r = await sidecarRequest({ home: process.env.JEVRIS_HOME, op: ${JSON.stringify(op)}, scope: 'cli', workspace: ${JSON.stringify(box.work)}, body: ${JSON.stringify(body)}, timeoutMs: 30000 }); process.stdout.write(JSON.stringify(r));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: box.env, cwd: box.work, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const ACTOR = actorOf(box.env);
  const budget = () => {
    const got = box.jevris(['budget', 'status', 'b1'], { json: true });
    assert.equal(got.code, 0, `budget status: ${got.stdout} ${got.stderr}`);
    return got.json;
  };
  const update = (args) => box.jevris(['budget', 'update', 'b1', ...args, '--yes'], { json: true });
  const taskState = (id) => side('task.get', { taskId: id }).result?.task?.state ?? null;
  const waitFor = async (check, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (check()) return;
      await sleep(100);
    }
    assert.fail(`timed out: ${label}`);
  };

  let submitted;
  await then('two workers reserve and a third ready task is refused by the owned envelope', () => {
    const plan = box.write('plan.json', { tasks: [task('A', 'a'), task('B', 'b'), task('C', 'c')] });
    submitted = box.jevris(['plan', '--submit', '--graph', plan, '--owner', ACTOR, '--budget', 'b1', '--limit-micro-usd', String(LIMIT), '--reserve-micro-usd', String(RESERVE), '--budget-policy', 'finish-running', '--authorization', box.authorizeBudget('b1'), '--yes'], { json: true });
    evidence(submitted.json);
    assert.equal(submitted.code, 0, `plan --submit: ${submitted.stdout} ${submitted.stderr}`);
    assert.equal(submitted.json.leaseIds.length, 2, 'two workers were not leased');
    const got = budget();
    evidence(got);
    assert.deepEqual([got.budget.limitMicroUsd, got.budget.shutdownReserveMicroUsd, got.use.heldMicroUsd, got.use.availableMicroUsd], [LIMIT, RESERVE, 2 * ESTIMATE, LIMIT - RESERVE - 2 * ESTIMATE]);
    assert.deepEqual(got.exhaustion.refused.map((r) => [r.taskId, r.reasonCode]), [['C', 'OVER_BUDGET']]);
    assert.equal(taskState('C'), 'ready', 'the refused task waits; it is not started or failed');
  });

  await then('the shutdown reserve is never admitted to new work', () => {
    const got = budget();
    // What is left (5,000) plus the reserve (5,000) would cover C (10,000); it was still refused.
    assert.equal(got.use.availableMicroUsd + got.budget.shutdownReserveMicroUsd >= ESTIMATE, true);
    assert.equal(got.exhaustion.reserveMicroUsd, RESERVE);
    assert.equal(got.exhaustion.refused.length, 1);
  });

  await then('Jevris suggests a narrower task, a cheaper qualified profile, a pause or a user-approved increase', () => {
    const report = budget().exhaustion;
    evidence(report);
    assert.deepEqual(report.suggestions.map((s) => s.kind), ['narrow', 'cheaper-profile', 'pause', 'increase']);
    assert.equal(report.suggestions.find((s) => s.kind === 'cheaper-profile').model, 'claude-sonnet-5', 'an approved model with a lower registry price');
    assert.equal(report.suggestions.find((s) => s.kind === 'increase').increaseToMicroUsd, LIMIT + ESTIMATE - (LIMIT - RESERVE - 2 * ESTIMATE));
    assert.equal(report.increaseNeedsAuthorization, true);
    // Content-free: ids and numbers only, never a path or a file's text.
    const text = JSON.stringify(report);
    assert.equal(text.includes(box.dir), false, 'the report names a sandbox path');
    assert.equal(text.includes('export const'), false, 'the report carries file content');
  });

  await then('mandatory verification cannot be skipped to fit the budget', () => {
    const report = budget().exhaustion;
    assert.equal(report.mandatoryChecksKept, true);
    assert.equal(report.suggestions.some((s) => /skip/i.test(s.text)), false, 'a suggestion offers to skip verification');
    for (const id of ['A', 'B', 'C']) assert.notEqual(taskState(id), 'verified', `${id} is verified without a receipt`);
  });

  await then('already-running work follows its predeclared cancellation policy', () => {
    const report = budget().exhaustion;
    assert.equal(report.policy, 'finish-running');
    assert.deepEqual(report.actions.map((a) => [a.taskId, a.action]).sort(), [['A', 'continue'], ['B', 'continue']]);
    for (const id of ['A', 'B']) assert.notEqual(taskState(id), 'cancelled');
  });

  await then('a budget increase needs the person\'s terminal authorization, and then the third task is admitted', async () => {
    // A model's shell (no terminal) cannot mint the authorization.
    const shell = box.jevris(['authorize', 'budget.increase', '--scope', 'b1']);
    assert.equal(shell.code, 2, `a non-interactive authorize was not refused: ${shell.stdout}`);
    const unapproved = box.jevris(['budget', 'update', 'b1', '--limit-micro-usd', String(LIMIT + ESTIMATE), '--yes'], { json: true });
    assert.equal(unapproved.code, 2, 'an increase without an authorization is a usage error');
    const forged = update(['--limit-micro-usd', String(LIMIT + ESTIMATE), '--authorization', 'aforged0000000000000000000']);
    evidence(forged.json);
    assert.equal(forged.code, 1);
    assert.deepEqual([forged.json.updated, forged.json.reasonCode, forged.json.budget.limitMicroUsd], [false, 'AUTHORIZATION_REFUSED', LIMIT]);
    // The request the interactive `jevris authorize budget.increase --scope b1` sends.
    const minted = side('authorization.mint', { actionClass: 'budget.increase', scope: 'b1', ttlMs: 300_000, actor: ACTOR, channel: 'terminal' });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    const authorizationId = minted.result.authorizationId;
    const other = side('budget.update', { budgetId: 'b1', limitMicroUsd: LIMIT + ESTIMATE, actor: `${ACTOR}x`, authorizationId });
    assert.equal(other.result.reasonCode, 'AUTHORIZATION_REFUSED', 'another principal used the authorization');
    const raised = update(['--limit-micro-usd', String(LIMIT + ESTIMATE), '--authorization', authorizationId]);
    evidence(raised.json);
    assert.equal(raised.code, 0, `budget update: ${raised.stdout} ${raised.stderr}`);
    assert.deepEqual([raised.json.updated, raised.json.reasonCode, raised.json.budget.limitMicroUsd], [true, 'UPDATED', LIMIT + ESTIMATE]);
    await waitFor(() => taskState('C') !== 'ready', 'C admitted');
    assert.notEqual(taskState('C'), 'ready', 'the third task was not admitted after the increase');
    const again = update(['--limit-micro-usd', String(LIMIT + 2 * ESTIMATE), '--authorization', authorizationId]);
    assert.equal(again.json.reasonCode, 'AUTHORIZATION_REFUSED', 'the authorization was used twice');
  });

  await then('unknown vendor billing is reconciled conservatively', async () => {
    writeFileSync(go, '');
    await waitFor(() => ['A', 'B', 'C'].every((id) => ['awaiting-evidence', 'verified', 'completed'].includes(taskState(id) ?? '')), 'the runs end');
    const got = budget();
    evidence(got.use);
    // B and C reported no usage: each stays held at its full reservation.
    assert.equal(got.use.heldMicroUsd >= 2 * ESTIMATE, true, JSON.stringify(got.use));
  });

  await then('native sessions outside Jevris ownership are reported as advisory spend estimates, not a hard cap', () => {
    const started = box.hook('claude', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'native-w09', transcript_path: join(box.dir, 't.jsonl'), cwd: box.work });
    assert.equal(started.code, 0, started.stderr);
    const status = side('status', {});
    evidence(status.result?.nativeSpend);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.result.nativeSpend.coverage, 'advisory-estimate');
    assert.equal(status.result.nativeSpend.sessions >= 1, true, JSON.stringify(status.result.nativeSpend));
    assert.equal(status.result.nativeSpend.estimateMicroUsd, null, 'hooks report no usage, so no spend is claimed');
  });
});
