// The opt-in Jev feature suite script (`npm run smoke:jev:features`), offline: the engine groups, the
// capability cases through a real sidecar, and the hot-path run, all against the conformance mock. Nothing
// here calls Jev for real, reads a key or touches the real home; the live run is never part of `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const script = fileURLToPath(new URL('../scripts/jev-features.mjs', import.meta.url));

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 280_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

test('without JEVRIS_LIVE_JEV or --mock the script does nothing and says how to run it; a live run inside a test process is refused', () => {
  const idle = run([], { JEVRIS_LIVE_JEV: '', JEVRIS_TEST: '' });
  assert.equal(idle.code, 0);
  assert.match(idle.stdout, /opt-in/);
  const refused = run([], { JEVRIS_LIVE_JEV: '1', JEVRIS_TEST: '1' });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /refusing a live run inside a test process/);
});

test('--mock runs every part against the conformance mock and writes an evidence record of numbers and codes', { skip: managedHostSkip() }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-script-')));
  try {
    const evidence = join(dir, 'evidence', 'features.json');
    // One capability part in one egress state keeps this to two sidecars (the parts have their own tests); the live run does all six passes.
    const out = run(['--mock', '--cold', '1', '--cached', '1', '--hot', '3', '--parts', 'a', '--egress', 'denied', '--evidence', evidence]);
    assert.equal(out.code, 0, `${out.stdout.slice(-1500)}\n${out.stderr.slice(-800)}`);
    const record = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(record.schemaVersion, 'jev-features-suite-1');
    assert.equal(record.mode, 'mock');
    assert.equal(record.passed, true, JSON.stringify(record.failures));
    assert.equal(record.applied, false);
    // The engine groups.
    assert.ok(record.engine.rows.length > 50);
    assert.equal(record.engine.rows.reduce((n, r) => n + r.leaks, 0), 0);
    // The circuit breaker's health probe (the one inventory entry only a half-open circuit asks) has its row: driven on an engine of its own, on the mock.
    assert.deepEqual(record.engine.rows.filter((r) => r.spec === 'health-probe').map((r) => [r.group, r.phase, r.got, r.detail.stateAfterCooldown, r.detail.stateAfterRestore]), [['health-probe', 'cold', 'PROBE_OK', 'half-open', 'closed']]);
    // The capability cases through the sidecar: each reached the call, and none that must reach Jev was refused before sending.
    assert.ok(record.capabilities.rows.length >= 8, `${String(record.capabilities.rows.length)} capability rows`);
    assert.deepEqual(record.capabilities.passes.map((p) => [p.part, p.egress]), [['a', 'denied']]);
    for (const r of record.capabilities.rows) assert.equal(r.ok, true, `${r.id}: ${String(r.failure)}`);
    // The hot path: route and plan, cold and cached, a burst and a repeat sequence, and the two engine-level deciders.
    assert.equal(record.hot.route.cold.n, 3);
    assert.equal(record.hot.route.cached.n, 3);
    assert.equal(record.hot.plan.cold.n, 3);
    assert.equal(record.hot.burst.size, 4);
    assert.ok(record.hot.sequence.cacheHitRate > 0.5, `cache hit rate ${String(record.hot.sequence.cacheHitRate)}`);
    assert.ok(record.hotEngine['check-ranking'].cold.n > 0 && record.hotEngine['repeated-failure'].cold.n > 0);
    // Spend is bounded and counted.
    assert.ok(record.spent.engineCalls > 0 && record.spent.halted === null);
    // Numbers and codes only: no key, no fake secret.
    const text = JSON.stringify(record);
    for (const forbidden of ['mock-key', 'jev-features-mock-key', 'Bearer', 'ghp_']) assert.equal(text.includes(forbidden), false, forbidden);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
