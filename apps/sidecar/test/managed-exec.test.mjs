// P8 (sidecar concurrency audit; owner ededdba): on Windows the enterprise kill switch and managed
// policy registry reads are cached for about a second and refreshed without blocking the loop, and
// the named pipe's ACL is hardened by an asynchronous PowerShell run.
import test from 'node:test';
import assert from 'node:assert/strict';

const { cachedExec, execStatus, sidecarManagedOptions, MANAGED_READ_TTL_MS, MANAGED_READ_MAX_STALE_MS } = await import('../dist/managed-exec.js');
const { hardenPipeAclAsync } = await import('../dist/daemon.js');
const ep = await import('@jevris/cli/enterprise-policy');

const winEnv = { ProgramData: 'Q:\\NoSuchProgramData', SystemRoot: 'C:\\Windows' };
const regOut = (name, value) => ({ status: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\Software\\Policies\\Jevris\r\n    ${name}    ${value}\r\n` });

function fakes(initial) {
  let value = initial;
  const calls = { sync: 0, async: 0 };
  const pending = [];
  return {
    set: (v) => {
      value = v;
    },
    calls,
    settle: () => {
      for (const done of pending.splice(0)) done(value === null ? { status: null, stdout: '' } : regOut('KillSwitch', value));
    },
    runSync: () => {
      calls.sync += 1;
      return regOut('KillSwitch', value);
    },
    runAsync: (_command, _args, done) => {
      calls.async += 1;
      pending.push(done);
    },
  };
}

test('a fresh answer is served from the cache; an older one is served while one refresh runs', () => {
  let now = 0;
  const f = fakes('REG_DWORD    0x0');
  const exec = cachedExec({ now: () => now, runSync: f.runSync, runAsync: f.runAsync });
  const read = () => ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec }).stopped;
  assert.equal(read(), false);
  assert.deepEqual(f.calls, { sync: 1, async: 0 }, 'the first read runs reg.exe once');
  now = MANAGED_READ_TTL_MS - 1;
  f.set('REG_DWORD    0x1');
  assert.equal(read(), false, 'within the ttl the cache answers');
  assert.deepEqual(f.calls, { sync: 1, async: 0 });
  now = MANAGED_READ_TTL_MS + 1;
  assert.equal(read(), false, 'past the ttl the last answer is served...');
  assert.equal(read(), false);
  assert.deepEqual(f.calls, { sync: 1, async: 1 }, '...and exactly one refresh starts');
  f.settle();
  assert.equal(read(), true, 'the refreshed answer lands: the enterprise switch stops Jevris');
});

test('a refresh that cannot run keeps the last answer; after an idle spell the read is synchronous', () => {
  let now = 0;
  const f = fakes('REG_DWORD    0x1');
  const exec = cachedExec({ now: () => now, runSync: f.runSync, runAsync: f.runAsync });
  const read = () => ep.readManagedKillSwitch({ platform: 'win32', env: winEnv, exec }).stopped;
  assert.equal(read(), true);
  now = MANAGED_READ_TTL_MS + 1;
  assert.equal(read(), true);
  f.set(null);
  f.settle();
  assert.equal(read(), true, 'a failed refresh never turns the switch off');
  f.set('REG_DWORD    0x0');
  now += MANAGED_READ_MAX_STALE_MS + 1;
  assert.equal(read(), false, 'older than the stale bound: read again at once, never an old answer');
  assert.equal(f.calls.sync, 2);
});

test('the sidecar passes the cached reader on Windows only; exit statuses map as execFile reports them', () => {
  assert.deepEqual(sidecarManagedOptions('linux'), {});
  assert.deepEqual(sidecarManagedOptions('darwin'), {});
  const win = sidecarManagedOptions('win32');
  assert.equal(typeof win.exec, 'function');
  assert.equal(sidecarManagedOptions('win32'), win, 'one shared cache');
  assert.equal(execStatus(null), 0);
  assert.equal(execStatus(Object.assign(new Error('exit'), { code: 1 })), 1);
  assert.equal(execStatus(Object.assign(new Error('spawn'), { code: 'ENOENT' })), null, 'a command that did not run has no status');
});

test('the pipe ACL is hardened asynchronously and read back', async () => {
  let seen;
  const owner = await hardenPipeAclAsync('\\\\.\\pipe\\jevris-test', async (file, args) => {
    seen = { file, encoded: args.includes('-EncodedCommand') };
    return { status: 0, stdout: 'ME=S-1-5-21-1\r\nACE=S-1-5-21-1\r\nACE=S-1-5-18\r\n' };
  });
  assert.equal(owner, true);
  assert.deepEqual(seen, { file: 'WindowsPowerShell\\v1.0\\powershell.exe', encoded: true });
  assert.equal(await hardenPipeAclAsync('\\\\.\\pipe\\jevris-test', async () => ({ status: 0, stdout: 'ME=S-1-5-21-1\r\nACE=S-1-1-0\r\n' })), false, 'Everyone left in the DACL');
  assert.equal(await hardenPipeAclAsync('\\\\.\\pipe\\jevris-test', async () => ({ status: null, stdout: '' })), false);
});
