// ORC-10 (W09) surfaces against a real sidecar: `jevris budget status` shows a root budget's use
// and its last exhaustion with the suggestion set; `jevris budget update` is a person's answer
// (CLI only, confirmed): resume a budget the pause-all policy paused, and a higher limit only
// with a terminal authorization. Pairs: before and after the budget runs out; unconfirmed and
// confirmed resume; a higher limit without and with a wrong authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedRepo, taskNode } from './owned-sandbox.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

test('budget status shows the exhaustion and its suggestions; budget update resumes only with a person, and a higher limit needs an authorization (ORC-10)', { skip: managedHostSkip() }, async (t) => {
  const box = await ownedRepo(t, 3, { maxWorkers: 3 });
  const unknown = box.jevris(['budget', 'status', 'b-none'], { json: true });
  assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr);
  assert.deepEqual([unknown.json.command, unknown.json.found, unknown.json.budget], ['budget status', false, null]);

  // Two tasks fit the owned envelope (limit minus the shutdown reserve); the third does not.
  const tasks = ['A', 'B', 'C'].map((id) => taskNode(id, { rootBudgetId: 'b1', writeScopes: [`src/${id}`], estimateMicroUsd: 10_000 }));
  const plan = box.write('plan-b1.json', { tasks });
  const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', 'b1', '--limit-micro-usd', '30000', '--reserve-micro-usd', '5000', '--budget-policy', 'pause-all', '--authorization', box.authorizeBudget('b1'), '--yes'], { json: true });
  assert.equal(submitted.json?.leaseIds?.length, 2, submitted.stdout + submitted.stderr);

  const status = box.jevris(['budget', 'status', 'b1'], { json: true });
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.deepEqual([status.json.command, status.json.found, status.json.budget.limitMicroUsd, status.json.budget.paused, status.json.use.heldMicroUsd], ['budget status', true, 30_000, true, 20_000]);
  const report = status.json.exhaustion;
  assert.deepEqual(report.refused.map((r) => r.taskId), ['C']);
  assert.equal(report.mandatoryChecksKept, true);
  assert.ok(report.suggestions.some((s) => s.kind === 'increase' && s.increaseToMicroUsd > 30_000), JSON.stringify(report.suggestions));
  const human = box.jevris(['budget', 'status', 'b1']);
  assert.match(human.stdout, /Budget b1 is paused/);
  assert.match(human.stdout, /refused C/);
  // D 2794ac4: budget.get carries the plan's estimates against what its tasks committed.
  assert.equal(typeof status.json.estimates?.tasks, 'number', JSON.stringify(status.json.estimates));
  assert.match(human.stdout, /^estimates: \d+ finished task\(s\)/m);
  assert.match(human.stdout, /jevris authorize budget\.increase --scope b1/);

  const unconfirmed = box.jevris(['budget', 'update', 'b1', '--resume'], { json: true });
  assert.equal(unconfirmed.code, 2);
  assert.equal(box.jevris(['budget', 'status', 'b1'], { json: true }).json.budget.paused, true, 'changed without confirmation');
  const resumed = box.jevris(['budget', 'update', 'b1', '--resume', '--yes'], { json: true });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual([resumed.json.command, resumed.json.updated, resumed.json.reasonCode, resumed.json.budget.paused], ['budget update', true, 'UPDATED', false]);

  const lower = box.jevris(['budget', 'update', 'b1', '--limit-micro-usd', '20000', '--authorization', 'auth-none', '--yes'], { json: true });
  assert.deepEqual([lower.code, lower.json.reasonCode], [1, 'LIMIT_NOT_HIGHER']);
  const forged = box.jevris(['budget', 'update', 'b1', '--limit-micro-usd', '40000', '--authorization', 'auth-forged', '--yes'], { json: true });
  assert.deepEqual([forged.code, forged.json.updated, forged.json.reasonCode, forged.json.budget.limitMicroUsd], [1, false, 'AUTHORIZATION_REFUSED', 30_000]);
  assert.equal(box.jevris(['budget', 'update', 'b1', '--limit-micro-usd', '40000', '--yes']).code, 2, 'a higher limit without an authorization is a usage error');

  // No model tool changes a budget.
  const client = await box.mcp();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => /budget/.test(name)), []);
});
