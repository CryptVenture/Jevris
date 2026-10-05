// JEV-0072: the Jev feature suite script (`npm run smoke:jev:features`) still writes its evidence record when a cap stops the run. A call cap and a spend cap
// halt the engine groups, the record then holds `spent.halted`, and that field was not on the allow-list the script checks the record against, so the script
// exited 1 with "not written" and the only evidence of the capped run was lost. Offline (the conformance mock), engine groups only: no sidecar, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { runSidecarHotPath } from '../scripts/jev-feature-hot.mjs';
import { CASES } from '../scripts/jev-feature-cases.mjs';

const { recordViolations } = await import('@jevris/provider-typesafe');
const script = fileURLToPath(new URL('../scripts/jev-features.mjs', import.meta.url));
const TITLES = CASES.map((c) => c.title);

function run(args) {
  const out = spawnSync(process.execPath, [script, '--mock', '--skip', 'caps,hot', '--cold', '1', '--cached', '1', ...args], { encoding: 'utf8', env: { ...process.env }, timeout: 280_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

test('a run stopped by its call cap writes its record: exit 1, HALTED_CALL_CAP, spent.halted CALL_CAP, the cap held exactly, and the record validates', { skip: managedHostSkip(), timeout: 300_000 }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-halts-')));
  try {
    const evidence = join(dir, 'cap-calls.json');
    const out = run(['--max-calls', '5', '--evidence', evidence]);
    assert.equal(out.code, 1, 'a run stopped at its call cap fails');
    assert.equal(out.stderr.includes('not written'), false, out.stderr.slice(-600));
    const record = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(record.passed, false);
    assert.deepEqual(record.failures, ['HALTED_CALL_CAP']);
    assert.equal(record.spent.halted, 'CALL_CAP');
    assert.equal(record.engine.halted, 'CALL_CAP');
    assert.equal(record.spent.engineCalls, 5, 'the cap holds exactly');
    assert.ok(record.engine.skipped.length > 0, 'the cases the stop left unrun are listed');
    assert.deepEqual(recordViolations(record, { titles: TITLES }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a run stopped by its spend cap writes its record: exit 1, HALTED_SPEND_CAP, spent.halted SPEND_CAP, one call past the cap at most, and the record validates', { skip: managedHostSkip(), timeout: 300_000 }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-halts-')));
  try {
    const evidence = join(dir, 'cap-spend.json');
    const out = run(['--max-uusd', '100', '--evidence', evidence]);
    assert.equal(out.code, 1);
    assert.equal(out.stderr.includes('not written'), false, out.stderr.slice(-600));
    const record = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.deepEqual(record.failures, ['HALTED_SPEND_CAP']);
    assert.equal(record.spent.halted, 'SPEND_CAP');
    assert.ok(record.spent.engineMicroUsd >= 100 && record.spent.engineMicroUsd < 300, `${String(record.spent.engineMicroUsd)} micro-USD`);
    assert.ok(Number.isSafeInteger(record.spent.engineMicroUsd));
    assert.deepEqual(recordViolations(record, { titles: TITLES }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a sidecar that fails an op in the hot path is a code in the record, never the message it answered with (a reason that is a sentence or a lower-case word)', async () => {
  const message = 'The Jevris sidecar could not be started at /home/me/.jevris. Run `jevris sidecar start` to see why.';
  const answers = [
    [{ ok: false, reason: 'unavailable', message }, 'UNAVAILABLE'],
    [{ ok: false, reason: 'refused', reasonCode: 'KILL_SWITCH_ACTIVE', message }, 'KILL_SWITCH_ACTIVE'],
    [{ ok: false, reason: `the sidecar at /home/me/.jevris is down`, message }, 'FAILED'],
    [{ ok: false, message }, 'FAILED'],
  ];
  for (const [answer, code] of answers) {
    const sidecar = { async sidecarRequest() { return answer; } };
    const hot = await runSidecarHotPath({ sidecar, home: 'unused', work: 'unused', cold: 2, burst: 1, sequence: 3 });
    const reasons = new Set([hot.firstRequest, ...hot.route.rowsCold, ...hot.route.rowsCached, ...hot.plan.rowsCold, ...hot.plan.rowsCached, ...hot.burst.rows].map((r) => r.reasonCode));
    assert.deepEqual([...reasons], [code], JSON.stringify(answer));
    assert.deepEqual(recordViolations({ hot }), [], JSON.stringify(answer));
    assert.equal(JSON.stringify(hot).includes('/home/me'), false, 'the message is in the record');
  }
});
