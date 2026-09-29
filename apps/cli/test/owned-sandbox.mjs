/**
 * Product-test helpers for owned work: a sandbox repository with an approved check, owned
 * workers on (bounded-auto) and D's scripted workers, a TaskNode for `plan --submit`, and a
 * submit that asserts each task got a leased worker.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { ownedWorkers } from '../../../test/acceptance/owned.mjs';

export { ownedWorkers };

/** A task for `plan --submit`. */
export function taskNode(id, fields = {}) {
  return {
    id, schemaVersion: '1.0', workspaceId: 'acceptance', revision: 'r1', state: 'proposed', title: `Task ${id}`,
    requirementIds: ['REQ-1'], dependencyIds: [], writeScopes: ['src'], acceptanceCheckIds: ['unit'],
    expectedOutputs: ['patch'], models: ['claude-sonnet-4-5'], rootBudgetId: 'acceptance', ...fields,
  };
}

/** Submits `tasks` under one root budget; each gets a leased worker. */
export function submit(box, tasks, budget = tasks[0].rootBudgetId) {
  const plan = box.write(`plan-${budget}.json`, { tasks });
  const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', budget, '--limit-micro-usd', '5000000', '--authorization', box.authorizeBudget(budget), '--yes'], { json: true });
  assert.equal(submitted.json?.leaseIds?.length, tasks.length, `plan --submit: ${submitted.stdout} ${submitted.stderr}`);
}

/** A repository with an approved check, owned workers on, and scripted workers that wait. */
export async function ownedRepo(t, runs, options = {}) {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.write('work/jevris.checks.json', { schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code' }] });
  box.gitInit();
  const go = join(box.dir, 'workers-may-finish');
  await box.workerScript(Array.from({ length: runs }, (_, i) => ({ writes: [{ path: `src/w${i}.js`, text: `export const w = ${i};\n` }], status: 'completed', costUsd: 0.01, reason: 'done', waitForFile: go })));
  await ownedWorkers(box, options);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  return box;
}
