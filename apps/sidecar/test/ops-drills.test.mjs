import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// OBS-05: every operations drill runs against the built product from this tree (A's
// pack-smoke runs the same functions against the installed tarball) and the payload is a valid
// operations-drills record.

const { DRILL_IDS, operationsPayload, runDrill } = await import('../scripts/ops-drills.mjs');
const contracts = await import('@jevris/contracts');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the drills are exactly the contract OPERATIONS_DRILLS and their payload is a valid record (OBS-05)', () => {
  assert.deepEqual([...DRILL_IDS].sort(), [...contracts.OPERATIONS_DRILLS].sort());
  const results = Object.fromEntries(DRILL_IDS.map((id) => [id, { passed: true, recordHash: contracts.contentHash({ id }) }]));
  const record = contracts.releaseEvidence({
    kind: 'operations-drills',
    id: 'operations-drills-test',
    producedAt: new Date().toISOString(),
    version: '1.2.0',
    tool: 'ops-drills',
    os: 'linux',
    payload: operationsPayload(results, { os: 'linux' }),
  });
  assert.deepEqual(contracts.ReleaseEvidenceContract.validate(record).ok, true);
  // A drill that did not run is reported failed, never passed.
  assert.equal(operationsPayload({}, { os: 'linux' }).drills.every((drill) => drill.passed === false && drill.recordHash === null), true);
});

test('every operations drill passes against the built product: crash, read-only and corrupt store, disk full, interrupted update, stale result, rollback, offline (OBS-05)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jod-')));
  try {
    const failed = [];
    for (const id of DRILL_IDS) {
      const result = await runDrill(id, { packageDir: repo, home, env: process.env, bin: join(repo, 'bin', 'jevris.mjs') });
      assert.match(result.recordHash ?? '', /^sha256:[0-9a-f]{64}$/);
      if (!result.passed) failed.push(`${id}: ${result.detail}`);
    }
    assert.deepEqual(failed, []);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('the stale-result drill runs at the product\'s own budgets in a run whose budget scale is the Windows runner\'s (OBS-05, windows-latest)', { skip: managedHostSkip() }, async () => {
  // The drill's subject is a deadline: the command answers from local rules before a Jev answer that arrives 20 s late. The Windows runner
  // lengthens every test budget six times (JEVRIS_TEST_BUDGET_SCALE=6), and the CLI then waited 30 s for the sidecar: 30433 ms, a failed
  // drill on all three windows-latest cells (CI run 37357475972). The scale is given here whatever the host's own, so a fast host fails
  // the same way. The drill drops it from its own environment.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jod-')));
  try {
    const env = { ...process.env, JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' };
    const result = await runDrill('stale-result', { packageDir: repo, home, env, bin: join(repo, 'bin', 'jevris.mjs') });
    assert.equal(result.passed, true, result.detail);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an unknown drill is a failure, not an exception', async () => {
  const result = await runDrill('not-a-drill', { packageDir: repo, home: tmpdir(), env: process.env, bin: join(repo, 'bin', 'jevris.mjs') });
  assert.equal(result.passed, false);
});
