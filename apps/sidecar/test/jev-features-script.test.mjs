// The opt-in Jev feature suite script (`npm run smoke:jev:features`), offline: the engine groups, the
// capability cases through a real sidecar, and the hot-path run, all against the conformance mock. Nothing
// here calls Jev for real, reads a key or touches the real home; the live run is never part of `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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

test('--mock runs every part against the conformance mock and writes an evidence record of numbers and codes', { skip: managedHostSkip() }, async () => {
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
    // Numbers and codes only: every string is a code or a fixed label at a field that is listed for it (JEV-0049), and there is no key and no fake secret.
    const { recordViolations } = await import('@jevris/provider-typesafe');
    const { CASES } = await import('../scripts/jev-feature-cases.mjs');
    assert.deepEqual(recordViolations(record, { titles: CASES.map((c) => c.title) }), []);
    const text = JSON.stringify(record);
    for (const forbidden of ['mock-key', 'jev-features-mock-key', 'Bearer', 'ghp_']) assert.equal(text.includes(forbidden), false, forbidden);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// The smallest run (no capability cases, no hot path, a call cap that halts it): these tests are about the record, not the suite.
const QUICK = ['--mock', '--skip', 'caps,hot', '--max-calls', '5', '--cold', '1', '--cached', '1'];

test('a record the platform refuses says why and what to do, after the run\'s own result line, and the run exits 1: the destination is a folder, on every platform (JEV-0075)', { skip: managedHostSkip() }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-refused-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'is-a-folder.json'));
  const out = run([...QUICK, '--evidence', join(dir, 'is-a-folder.json')]);
  assert.match(out.stdout, /evidence NOT WRITTEN \(([A-Z][A-Z0-9_]+): [^)]+\)\s*$/, `${out.stdout.slice(-600)}\n${out.stderr.slice(-300)}`);
  assert.match(out.stdout, /passed false failures HALTED_CALL_CAP; engine calls 5 /, 'the run\'s own result is still printed');
  assert.equal(out.stdout.includes(dir), false, 'the path is in the line');
  assert.equal(out.code, 1);
});

test('a path reached through a symbolic link (macOS /tmp is one) is refused as ESYMLINK with what to do, nothing is written through it, and the real path is written (JEV-0075)', { skip: managedHostSkip() || (process.platform === 'win32' && 'a symbolic link needs a privilege there; the text itself is tested in packages/platform/test/durable-write-refusal.test.mjs') }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-link-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir');
  const refused = run([...QUICK, '--evidence', join(dir, 'link', 'x.json')]);
  assert.match(refused.stdout, /evidence NOT WRITTEN \(ESYMLINK: the file, or the folder it is in, is a symbolic link \(on macOS \/tmp is one\); name the real path, such as \/private\/tmp\/\.\.\., or a path with no link\)\s*$/, `${refused.stdout.slice(-600)}\n${refused.stderr.slice(-300)}`);
  assert.equal(refused.stdout.includes(dir), false, 'the path is in the line');
  assert.equal(refused.code, 1);
  assert.equal(existsSync(join(dir, 'real', 'x.json')), false, 'nothing was written through the link');
  const real = join(dir, 'real', 'x.json');
  const written = run([...QUICK, '--evidence', real]);
  assert.doesNotMatch(written.stdout, /NOT WRITTEN/, written.stdout.slice(-600));
  assert.ok(existsSync(real), 'the real path is written');
});
