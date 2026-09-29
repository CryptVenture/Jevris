/**
 * Acceptance helpers for owned work: the switches a person sets to let Jevris own bounded
 * workers, a TaskNode with the fields `plan --submit` takes, and a reader that polls a task
 * through the MCP task view. The workers themselves are D's scripted worker port
 * (`box.workerScript`, test mode plus the sandbox's test-home marker).
 */
import assert from 'node:assert/strict';
/**
 * Approves the workspace's checks and checks that owned workers are on. Orchestration and
 * bounded-auto managed workers are the defaults from install (docs/settings.md "Workers"), so a
 * person only approves the checks; `maxWorkers` sets `orchestration.maxConcurrentWorkers`.
 */
export async function ownedWorkers(box, { maxWorkers } = {}) {
  assert.equal((await box.approveChecks()).code, 0, 'verify approve failed');
  if (maxWorkers !== undefined) {
    assert.equal(box.jevris(['configure', 'set', 'orchestration.maxConcurrentWorkers', String(maxWorkers)]).code, 0, 'configure set failed');
  }
  const shown = box.jevris(['configure', 'show'], { json: true });
  const { managedWorkers, orchestrationEnabled } = shown.json?.result?.effective ?? {};
  assert.deepEqual([managedWorkers, orchestrationEnabled], ['bounded-auto', true], `owned workers are not on: ${shown.stdout} ${shown.stderr}`);
}

/** A task for `plan --submit`: a TaskNode plus the title, models and expected outputs. */
export function taskNode(id, fields = {}) {
  return {
    id,
    schemaVersion: '1.0',
    workspaceId: 'acceptance',
    revision: 'r1',
    state: 'proposed',
    title: `Task ${id}`,
    requirementIds: ['REQ-1'],
    dependencyIds: [],
    writeScopes: ['src'],
    acceptanceCheckIds: ['unit'],
    expectedOutputs: ['patch'],
    models: ['claude-sonnet-4-5'],
    rootBudgetId: 'acceptance',
    ...fields,
  };
}

/** Submits `tasks` under one root budget and asserts how many workers were leased. */
export function submit(box, tasks, { budget = tasks[0].rootBudgetId, leased = tasks.length } = {}) {
  const plan = box.write(`plan-${budget}.json`, { tasks });
  const submitted = box.jevris(['plan', '--submit', '--graph', plan, '--budget', budget, '--limit-micro-usd', '5000000', '--authorization', box.authorizeBudget(budget), '--yes'], { json: true });
  assert.equal(submitted.json?.leaseIds?.length, leased, `plan --submit leased ${String(submitted.json?.leaseIds?.length)}: ${submitted.stdout} ${submitted.stderr}`);
  return submitted.json;
}

/** Polls the MCP task view until the task reaches `until` (or once, without it). */
export function taskReader(client) {
  return async (taskId, until) => {
    let result;
    for (let i = 0; i < 150; i += 1) {
      result = (await client.callTool({ name: 'jevris_get_task', arguments: { taskId } })).structuredContent?.result;
      if (until === undefined || result?.task?.state === until) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return result;
  };
}
