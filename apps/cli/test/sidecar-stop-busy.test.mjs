// `jevris sidecar stop` and the commands that need the sidecar gone first (uninstall, data delete,
// store restore) against a real sidecar process that is finishing a verification run (review of
// wave 1, M1). The sidecar refuses the stop and keeps running; each command says why and names the
// two ways on; only `--force` ends it. The sidecar is the product daemon with its run count
// replaced by a file (apps/sidecar/test/fixtures/busy-daemon.mjs). Temporary homes; no service
// manager, no harness, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { main } = await import('../dist/cli.js');
const { stopSidecarForRemoval, purgeStoreCapsules } = await import('../dist/runtime-commands.js');
const sidecar = await import('@jevris/sidecar');

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', '..', 'sidecar', 'test', 'fixtures', 'busy-daemon.mjs');
const posix = process.platform !== 'win32';

const children = new Set();
after(async () => {
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

function exitOf(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

async function busySidecar() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvb-')));
  const flag = join(home, 'run.flag');
  writeFileSync(flag, '');
  const child = spawn(process.execPath, [FIXTURE, home, flag], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await sidecar.probeSidecar(home, 200)).running) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await sidecar.probeSidecar(home, 500)).running, true, 'the sidecar child came up');
  return { home, flag, child };
}

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk), { isTTY: false });
  return { code, text };
}

test('jevris sidecar stop and restart refuse while a run is under way and leave the sidecar serving; --force stops it', { skip: managedHostSkip() || !posix }, async () => {
  const s = await busySidecar();
  try {
    for (const sub of ['stop', 'restart']) {
      const refused = await run(['sidecar', sub, '--home', s.home]);
      assert.equal(refused.code, 1, `${sub}: ${refused.text}`);
      assert.equal(
        refused.text,
        `sidecar ${sub}: refused (VERIFICATION_RUNNING). The sidecar is finishing a verification run and was left running. Run \`jevris sidecar ${sub}\` again once they end, or \`jevris sidecar ${sub} --force\` to end them now.\n`,
      );
      assert.equal(s.child.exitCode, null, `${sub}: the sidecar is alive`);
      assert.equal(s.child.signalCode, null, `${sub}: and was not signalled`);
      assert.equal((await sidecar.sidecarRequest({ home: s.home, op: 'ping', scope: 'cli' })).ok, true, `${sub}: and still serves`);
    }
    const forced = await run(['sidecar', 'stop', '--force', '--home', s.home]);
    assert.equal(forced.code, 0, forced.text);
    assert.match(forced.text, /^sidecar: stopped \(pid \d+\)$/m);
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null]);
  } finally {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGTERM');
    await exitOf(s.child, 10_000);
    rmSync(s.home, { recursive: true, force: true });
  }
});

test('removal and capsule deletion do not stop a sidecar that is finishing a run, and say why; once it is done they stop it', { skip: managedHostSkip() || !posix }, async () => {
  const s = await busySidecar();
  try {
    const removal = await stopSidecarForRemoval(s.home);
    assert.equal(removal.stopped, false);
    assert.match(removal.message, /^The Jevris sidecar did not stop\. The sidecar is finishing a verification run and was left running \(VERIFICATION_RUNNING\)\. Wait for the runs to end, or run `jevris sidecar stop --force` to end them, then retry\.$/);
    const capsules = await purgeStoreCapsules(s.home);
    assert.equal(capsules.ok, false);
    assert.equal(capsules.reasonCode, 'SIDECAR_RUNNING');
    assert.match(capsules.message, /VERIFICATION_RUNNING.*jevris sidecar stop --force/);
    // The store commands that need the single writer say the same.
    const migrate = await run(['store', 'migrate', '--home', s.home]);
    assert.equal(migrate.code, 1, migrate.text);
    assert.match(migrate.text, /^store migrate: the sidecar \(pid \d+\) did not stop\. The sidecar is finishing a verification run and was left running \(VERIFICATION_RUNNING\)\. Wait for the runs to end, or run `jevris sidecar stop --force` to end them, then retry\.$/m);
    assert.equal(s.child.exitCode, null, 'none of them stopped it');
    // The run ends: the same removal now stops it.
    rmSync(s.flag, { force: true });
    const after = await stopSidecarForRemoval(s.home);
    assert.deepEqual([after.stopped, after.method], [true, 'shutdown-frame']);
    assert.deepEqual(await exitOf(s.child, 10_000), [0, null]);
    assert.equal(existsSync(s.flag), false);
  } finally {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGTERM');
    await exitOf(s.child, 10_000);
    rmSync(s.home, { recursive: true, force: true });
  }
});
