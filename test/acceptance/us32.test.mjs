import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, story } from './lib.mjs';

// Two decisions compete for the last of the decision budget; a third call's usage never comes
// back (the provider hangs past the deadline). The budget is the product's shared, file-locked
// DecisionBudget under the data folder (DATA-06, DATA-07, C53).

const FAILURE = (tag) => [`TypeError at app/parse.ts:14 (${tag})`, `TypeError at app/parse.ts:14 (${tag})`];

function recoverArgs(tag) {
  return ['recover', '--failure', FAILURE(tag)[0], '--failure', FAILURE(tag)[1], '--json'];
}

function exited(child) {
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function budgetFile(box) {
  const { jevrisPaths } = await load('platform');
  return join(jevrisPaths({ home: box.home }).data, 'decision-budget.json');
}

story('US32', async ({ t, then, sandbox, evidence }) => {
  const core = await load('core');
  const { DEFAULT_DECISION_BUDGET_MICRO_USD: LIMIT } = await load('provider-typesafe');

  // What one of these decisions reserves, measured on a fresh budget.
  const probeStub = await startJevStub(t);
  const probe = await sandbox({ env: probeStub.env });
  assert.equal(probe.startSidecar().code, 0);
  assert.equal(probe.jevris(recoverArgs('a1')).code, 0);
  probe.stopSidecar();
  const probeFile = JSON.parse(readFileSync(await budgetFile(probe), 'utf8'));
  const reservations = Array.isArray(probeFile) ? probeFile : probeFile.reservations;
  const perDecision = reservations[0].reservedMicroUsd;
  assert.ok(perDecision > 0, 'a decision reserved nothing');

  // Given: only one and a half decisions' worth of budget is left.
  const stub = await startJevStub(t, { scenario: 'late', lateMs: 1500 });
  const box = await sandbox({ env: stub.env });
  const file = await budgetFile(box);
  const seed = core.DecisionBudget.open(file, { limitMicroUsd: LIMIT });
  const spent = LIMIT - Math.floor(perDecision * 1.5);
  const seeded = await seed.reserve({ decisionId: 'd-earlier-spend', workspaceId: 'w-earlier', microUsd: spent });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  assert.equal((await seed.commit(seeded.reservation.id, { usage: { inputTokens: 1, outputTokens: 1 }, actualMicroUsd: spent })).ok, true);
  assert.equal(box.startSidecar().code, 0);
  // When: both jobs ask at once (each waits on Jev for 1.5 s, so their reservations overlap).
  const [first, second] = await Promise.all([exited(box.spawn(box.product.bin, recoverArgs('b1'))), exited(box.spawn(box.product.bin, recoverArgs('b2')))]);
  const afterRace = await seed.snapshot();
  const status = box.jevris(['status'], { json: true });
  box.stopSidecar();

  // A third decision whose usage never comes back: Jev hangs past the deadline.
  const hangStub = await startJevStub(t, { scenario: 'late', lateMs: 120_000 });
  const hung = await sandbox({ env: hangStub.env });
  assert.equal(hung.startSidecar().code, 0);
  const lost = hung.jevris(recoverArgs('c1'));
  hung.stopSidecar();
  const hungBudget = core.DecisionBudget.open(await budgetFile(hung), { limitMicroUsd: LIMIT });
  const afterHang = await hungBudget.snapshot();
  const hungRows = JSON.parse(readFileSync(await budgetFile(hung), 'utf8')).reservations;
  evidence({ perDecision, afterRace, afterHang, calls: stub.requests().length });

  await then('At most the affordable set is admitted transactionally', () => {
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(stub.requests().length, 1, `${stub.requests().length} decisions reached Jev with budget for one`);
    assert.ok(afterRace.committedMicroUsd + afterRace.reservedMicroUsd + afterRace.heldMicroUsd <= LIMIT, JSON.stringify(afterRace));
    const reasons = (status.json?.result?.recentDecisions ?? []).map((decision) => decision.reasonCode);
    assert.ok(reasons.includes('BUDGET'), `the refused job was not refused for budget: ${reasons.join(',')}`);
    // Both jobs still got an answer, from local rules for the refused one.
    for (const run of [first, second]) assert.equal(typeof JSON.parse(run.out).result.action, 'string');
  });

  await then('unknown vendor usage is conservatively reconciled', () => {
    assert.equal(lost.code, 0, lost.stderr);
    assert.ok(hangStub.requests().length >= 1, 'the hung call was never sent');
    // The call may have been billed, so its whole reservation stays held, not released.
    // The reservation is estimated from the request's text, which carries salted digests (random hex), so two runs of the same call can differ by a
    // micro-USD when the estimate sits on a rounding edge (67 against 68, seen when the question text moved the estimate onto one). What must hold is the
    // hung call's own reservation, whole, and that it is one decision's worth; not that it is at least what another run happened to reserve.
    assert.deepEqual(hungRows.map((row) => row.state), ['held'], JSON.stringify(hungRows));
    assert.equal(afterHang.heldMicroUsd, hungRows[0].reservedMicroUsd, `the whole reservation stays held: ${JSON.stringify(afterHang)}`);
    assert.ok(Math.abs(afterHang.heldMicroUsd - perDecision) <= 1, `one decision's worth (${perDecision}): ${JSON.stringify(afterHang)}`);
    assert.equal(afterHang.availableMicroUsd, LIMIT - afterHang.committedMicroUsd - afterHang.reservedMicroUsd - afterHang.heldMicroUsd);
  });
});
