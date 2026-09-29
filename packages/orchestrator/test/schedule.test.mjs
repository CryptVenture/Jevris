import test from 'node:test';
import assert from 'node:assert/strict';


const { scheduleReady } = await import('../dist/index.js');

function ready(taskId, resourceKey, dependsOn = []) {
  return {
    taskId,
    state: 'ready',
    resourceKey,
    dependsOn,
    ownerId: 'ownerA',
  };
}

function leasedIds(result) {
  return result.leased.map((row) => row.taskId);
}

test('a shared lockfile is not co-leased, disjoint tasks both lease, and the cap stays 2', () => {
  const shared = scheduleReady({
    tasks: [ready('taskA', 'lockfile'), ready('taskB', 'lockfile')],
    schedulingStopped: false,
    killSwitchStopped: false,
  });
  assert.equal(shared.ok, true);
  assert.equal(shared.refused, false);
  assert.equal(shared.leased.length, 1);
  assert.equal(shared.leased.filter((row) => row.resourceKey === 'lockfile').length, 1);
  assert.equal(new Set(leasedIds(shared)).size, shared.leased.length);

  const disjoint = scheduleReady({
    tasks: [ready('taskC', 'pkgC'), ready('taskD', 'pkgD')],
    schedulingStopped: false,
    killSwitchStopped: false,
  });
  assert.equal(disjoint.ok, true);
  assert.deepEqual(leasedIds(disjoint), ['taskC', 'taskD']);

  const capped = scheduleReady({
    tasks: [ready('taskE', 'pkgE'), ready('taskF', 'pkgF'), ready('taskG', 'pkgG')],
    schedulingStopped: false,
    killSwitchStopped: false,
  });
  assert.equal(capped.leased.length, 2);
  assert.equal(leasedIds(capped).includes('taskG'), false);
});

test('a cycle leases nothing', () => {
  const cycle = scheduleReady({
    tasks: [
      ready('taskA', 'pkgA', ['taskB']),
      ready('taskB', 'pkgB', ['taskA']),
    ],
    schedulingStopped: false,
    killSwitchStopped: false,
  });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.refused, true);
  assert.equal(cycle.reason, 'cycle');
  assert.equal(cycle.leased.length, 0);
});

test('waiver ops are refused even when a field claims Jev approved them', () => {
  for (const op of ['waive-lock', 'waive-budget', 'launch-conflicting']) {
    const result = scheduleReady({
      tasks: [ready('taskA', 'pkgA'), ready('taskB', 'pkgB')],
      op,
      jevApproved: true,
      schedulingStopped: false,
      killSwitchStopped: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.equal(result.leased.length, 0);
  }
});

test('schedulingStopped or killSwitchStopped leases nothing', () => {
  const scheduling = scheduleReady({
    tasks: [ready('taskA', 'pkgA'), ready('taskB', 'pkgB')],
    schedulingStopped: true,
    killSwitchStopped: false,
  });
  assert.equal(scheduling.ok, false);
  assert.equal(scheduling.reason, 'stopped');
  assert.equal(scheduling.leased.length, 0);

  const killed = scheduleReady({
    tasks: [ready('taskA', 'lockfile')],
    schedulingStopped: false,
    killSwitchStopped: true,
  });
  assert.equal(killed.ok, false);
  assert.equal(killed.reason, 'stopped');
  assert.equal(killed.leased.length, 0);
});
