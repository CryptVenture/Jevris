// The host ledger's harness versions stay current (they were only written by install, doctor and certify, while Claude Code and the others
// update themselves): the sidecar re-reads each known harness in the background, at most once an hour, never in a test run or under a foreign
// HOME. Stub binaries and temp homes only; no harness is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { VERSION_REFRESH_MS, refreshInstalledVersions, resetVersionRefresh } = await import('../dist/version-refresh.js');
const { harnessVersionOf, recordHarnessVersion } = await import('@jevris/orchestrator');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-version-refresh-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  resetVersionRefresh();
  return home;
}

/** Stand-in binaries: `versions` names what each answers to --version; a missing one is not on PATH; `calls` counts the probes. */
function stub(versions) {
  const calls = [];
  return {
    calls,
    available: (file) => Object.hasOwn(versions, file),
    run: async (file, args) => {
      calls.push([file, args.join(' ')]);
      const v = versions[file];
      return v === 'fail' ? { spawned: true, code: 1, stdout: '' } : { spawned: true, code: 0, stdout: `${v} (stub)\n` };
    },
  };
}
const allow = () => null;

test('a known harness that updated itself is re-read into the ledger; one that is not on PATH or fails keeps what the ledger had', async (t) => {
  const home = tempHome(t);
  await recordHarnessVersion(home, 'claude', '2.1.295');
  await recordHarnessVersion(home, 'codex', '0.160.0');
  await recordHarnessVersion(home, 'kilocode', '7.8.1');
  const cli = stub({ claude: '2.1.304', codex: 'fail' });
  const found = await refreshInstalledVersions({ home, harnesses: ['claude', 'codex', 'kilocode'], cli, guard: allow, nowMs: 1_000 });
  assert.deepEqual(found, { claude: '2.1.304' });
  assert.equal(harnessVersionOf(home, 'claude'), '2.1.304', 'the ledger now says what runs');
  assert.equal(harnessVersionOf(home, 'codex'), '0.160.0', 'a failed probe keeps the old value');
  assert.equal(harnessVersionOf(home, 'kilocode'), '7.8.1', 'a binary that is not on PATH keeps it too');
  assert.deepEqual(cli.calls.map(([file]) => file).sort(), ['claude', 'codex'], 'only --version, and only for the launchers on PATH');
  assert.ok(cli.calls.every(([, args]) => args === '--version'));
});

test('a harness is probed at most once an hour, however many callers ask at the same moment', async (t) => {
  const home = tempHome(t);
  await recordHarnessVersion(home, 'claude', '2.1.295');
  const cli = stub({ claude: '2.1.304' });
  const ask = (nowMs) => refreshInstalledVersions({ home, harnesses: ['claude'], cli, guard: allow, nowMs });
  await Promise.all([ask(10), ask(10), ask(10)]);
  assert.equal(cli.calls.length, 1, 'sidecar start and a SessionStart probe once');
  assert.deepEqual(await ask(10 + VERSION_REFRESH_MS - 1), {}, 'not due yet');
  assert.equal(cli.calls.length, 1);
  assert.deepEqual(await ask(10 + VERSION_REFRESH_MS), { claude: '2.1.304' });
  assert.equal(cli.calls.length, 2);
  // A different home has its own clock.
  const other = tempHome(t);
  resetVersionRefresh();
  await refreshInstalledVersions({ home, harnesses: ['claude'], cli, guard: allow, nowMs: 5 });
  await refreshInstalledVersions({ home: other, harnesses: ['claude'], cli, guard: allow, nowMs: 5 });
  assert.equal(cli.calls.length, 4);
});

test('never in a test run or under a foreign HOME: the default guard refuses, nothing is spawned and the ledger is untouched', async (t) => {
  const home = tempHome(t);
  await recordHarnessVersion(home, 'claude', '2.1.295');
  const cli = stub({ claude: '2.1.304' });
  assert.deepEqual(await refreshInstalledVersions({ home, harnesses: ['claude'], cli, nowMs: 1 }), {});
  assert.equal(cli.calls.length, 0);
  assert.equal(harnessVersionOf(home, 'claude'), '2.1.295');
  // A guard that says no, whatever the reason, spawns nothing either; one that throws is no refresh and no error.
  assert.deepEqual(await refreshInstalledVersions({ home, harnesses: ['claude'], cli, guard: () => 'not here', nowMs: 1 }), {});
  assert.deepEqual(await refreshInstalledVersions({ home, harnesses: ['claude'], cli, guard: () => { throw new Error('boom'); }, nowMs: 1 }), {});
  assert.equal(cli.calls.length, 0);
});
