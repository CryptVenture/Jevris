import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// IPC-06, GOV-14: a caller running as another OS user. Opt-in, so npm test never loads it: CI's
// Linux and macOS cells create a second local user, name it in JEVRIS_TEST_OTHER_USER
// (passwordless sudo) and run this file; apps/sidecar/scripts/threat-model-suite.mjs runs it too.
// Run by hand: JEVRIS_TEST_OTHER_USER=<user> node scripts/test.mjs --no-build apps/sidecar/test/opt-in/cross-user.test.mjs

const { startDaemon } = await import('../../dist/index.js');
const { runtimeFiles } = await import('../../dist/protocol.js');

const posix = process.platform !== 'win32';
const otherUser = process.env.JEVRIS_TEST_OTHER_USER ?? '';

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'jvx-')));
}

test('a caller running as another OS user can neither connect to the sidecar nor read its keys or endpoint (IPC-06, GOV-14)', async () => {
  assert.ok(posix, 'the cross-user case is POSIX; Windows is the SID case (IPC-07)');
  assert.ok(otherUser.length > 0, 'set JEVRIS_TEST_OTHER_USER to a second local user this user can sudo to without a password');
  const { spawnSync } = await import('node:child_process');
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, store: false, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const files = runtimeFiles({ home });
    const endpoint = JSON.parse(readFileSync(files.endpoint, 'utf8')).endpoint;
    const probe = `
      const fs = require('node:fs');
      const net = require('node:net');
      const out = {};
      for (const [name, path] of Object.entries(${JSON.stringify({ key: files.key('cli'), hook: files.key('hook'), endpoint: files.endpoint })})) {
        try { fs.readFileSync(path); out[name] = 'read'; } catch (e) { out[name] = e.code; }
      }
      const socket = net.connect(${JSON.stringify(endpoint)});
      socket.on('connect', () => { out.connect = 'connected'; socket.destroy(); console.log(JSON.stringify(out)); });
      socket.on('error', (e) => { out.connect = e.code; console.log(JSON.stringify(out)); });
    `;
    const ran = spawnSync('sudo', ['-n', '-u', otherUser, process.execPath, '-e', probe], { encoding: 'utf8', timeout: 30_000, cwd: '/' });
    assert.equal(ran.status, 0, ran.stderr);
    const seen = JSON.parse(ran.stdout.trim());
    for (const name of ['key', 'hook', 'endpoint']) assert.notEqual(seen[name], 'read', `another user read the ${name} file`);
    assert.notEqual(seen.connect, 'connected', 'another user connected to the sidecar socket');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
