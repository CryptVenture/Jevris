import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aclIsOwnerOnly,
  applyOwnerOnlyAcl,
  assertOwnerOnly,
  ensurePrivateDir,
  parseIcacls,
  parseWhoami,
  tightenPrivateFile,
  writePrivateFile,
} from '../dist/index.js';

const POSIX_ONLY = process.platform === 'win32' ? 'POSIX mode bits; the Windows ACL branch is tested with injected icacls output' : false;
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const WHOAMI = `"desktop-ada\\ada","${SID}"\r\n`;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake Windows: whoami and icacls with an in-memory ACL per path. */
function fakeWindows(initial = {}) {
  const acls = new Map(Object.entries(initial));
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'whoami.exe') return { status: 0, stdout: WHOAMI };
    if (file !== 'icacls.exe') return { status: 1, stdout: '' };
    const [path, ...rest] = args;
    if (rest.length === 0) {
      const aces = acls.get(path) ?? ['BUILTIN\\Administrators:(I)(F)', 'NT AUTHORITY\\SYSTEM:(I)(F)', 'DESKTOP-ADA\\ada:(I)(F)'];
      const [first, ...more] = aces;
      const pad = ' '.repeat(path.length + 1);
      const body = [`${path} ${first}`, ...more.map((ace) => `${pad}${ace}`)].join('\r\n');
      return { status: 0, stdout: `${body}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` };
    }
    if (rest[0] === '/inheritance:r' && rest[1] === '/grant:r') {
      // icacls lists the granted SID by account name, with each right in parentheses.
      const rights = rest[2].slice(rest[2].indexOf(':') + 1).replace(/F$/, '(F)');
      acls.set(path, [`DESKTOP-ADA\\ada:${rights}`]);
      return { status: 0, stdout: '' };
    }
    return { status: 87, stdout: '' };
  };
  return { exec, calls, acls };
}

function winStat(dir) {
  return async () => ({ mode: 0o666, isSymbolicLink: () => false, isDirectory: () => dir, isFile: () => !dir });
}

test('whoami and icacls output parse, including indented continuation ACEs (BLD-08)', () => {
  assert.deepEqual(parseWhoami(WHOAMI), { name: 'desktop-ada\\ada', sid: SID });
  assert.equal(parseWhoami('garbage'), null);
  const path = 'C:\\Users\\ada\\AppData\\Local\\Jevris';
  const out = `${path} DESKTOP-ADA\\ada:(OI)(CI)(F)\r\n${' '.repeat(path.length + 1)}NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  assert.deepEqual(parseIcacls(out, path), [
    { principal: 'DESKTOP-ADA\\ada', rights: '(OI)(CI)(F)' },
    { principal: 'NT AUTHORITY\\SYSTEM', rights: '(I)(OI)(CI)(F)' },
  ]);
  assert.equal(parseIcacls('C:\\other x:(F)', path), null);
  const user = parseWhoami(WHOAMI);
  assert.equal(aclIsOwnerOnly(parseIcacls(out, path), user), false);
  assert.equal(aclIsOwnerOnly([{ principal: `*${SID}`, rights: '(OI)(CI)(F)' }], user), true);
  assert.equal(aclIsOwnerOnly([{ principal: 'desktop-ada\\ADA', rights: '(F)' }], user), true);
  assert.equal(aclIsOwnerOnly([{ principal: 'desktop-ada\\ada', rights: '(RX)' }], user), false);
});

test('win32: a private directory gets a protected, inheritable owner-only ACL (BLD-08)', async () => {
  const win = fakeWindows();
  const dir = 'C:\\Users\\ada\\AppData\\Local\\Jevris';
  let exists = false;
  const result = await ensurePrivateDir(dir, {
    platform: 'win32',
    exec: win.exec,
    lstat: async () => {
      if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { mode: 0o666, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    },
    mkdir: async () => {
      exists = true;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(win.calls.find((call) => call[2] === '/inheritance:r'), ['icacls.exe', dir, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '/q']);
  assert.deepEqual(await assertOwnerOnly(dir, { platform: 'win32', exec: win.exec, lstat: winStat(true) }), { ok: true });
});

test('win32: assertOwnerOnly reports inherited broad ACEs and a symlink (BLD-08)', async () => {
  const win = fakeWindows();
  const check = await assertOwnerOnly('C:\\x\\host.json', { platform: 'win32', exec: win.exec, lstat: winStat(false) });
  assert.deepEqual(check, { ok: false, reason: 'acl', detail: 'acl grants BUILTIN\\Administrators, NT AUTHORITY\\SYSTEM' });
  const link = await assertOwnerOnly('C:\\x\\link', {
    platform: 'win32',
    exec: win.exec,
    lstat: async () => ({ mode: 0, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false }),
  });
  assert.deepEqual(link, { ok: false, reason: 'symlink', detail: 'symlink' });
});

test('win32: a private file write applies the file ACL to the temp before the rename (BLD-08)', async () => {
  const win = fakeWindows();
  const renamed = [];
  const file = 'C:\\Users\\ada\\AppData\\Roaming\\Jevris\\kill-switch.json';
  const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  const result = await writePrivateFile(file, '{"stopped":true}', {
    platform: 'win32',
    exec: win.exec,
    lstat: winStat(true),
    fs: {
      lstat: missing,
      readdir: async () => [],
      open: async () => ({ writeFile: async () => undefined, sync: async () => undefined, close: async () => undefined }),
      rename: async (from, to) => {
        renamed.push([from, to]);
      },
      rm: async () => undefined,
    },
  });
  assert.deepEqual(result, { ok: true });
  const grants = win.calls.filter((call) => call[2] === '/inheritance:r');
  assert.equal(grants.length, 1);
  assert.match(grants[0][1], /\\\.kill-switch\.json\.\d+\.[0-9a-f]+\.jtmp$/);
  assert.equal(grants[0][4], `*${SID}:F`);
  assert.deepEqual(renamed, [[grants[0][1], file]]);
});

test('POSIX: private directories are 0700 and files 0600, created, not chmodded after (BLD-08)', { skip: POSIX_ONLY }, async (t) => {
  const home = tempDir(t);
  const dir = join(home, '.local', 'share', 'jevris');
  assert.deepEqual(await ensurePrivateDir(dir), { ok: true });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.notEqual(statSync(join(home, '.local')).mode & 0o777, 0o700, 'parents keep default modes');
  const file = join(dir, 'host.json');
  assert.deepEqual(await writePrivateFile(file, '{}'), { ok: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await assertOwnerOnly(file), { ok: true });
  assert.deepEqual(await assertOwnerOnly(dir), { ok: true });
});

test('POSIX: a wider mode is reported and an existing private dir is tightened (BLD-08)', { skip: POSIX_ONLY }, async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.db');
  writeFileSync(file, 'x');
  chmodSync(file, 0o644);
  assert.deepEqual(await assertOwnerOnly(file), { ok: false, reason: 'mode', detail: 'mode 0644' });
  assert.deepEqual(await tightenPrivateFile(file), { ok: true });
  assert.deepEqual(await assertOwnerOnly(file), { ok: true });
  const wide = join(dir, 'wide');
  mkdirSync(wide, { mode: 0o755 });
  chmodSync(wide, 0o755);
  assert.deepEqual(await ensurePrivateDir(wide), { ok: true });
  assert.equal(statSync(wide).mode & 0o777, 0o700);
  assert.deepEqual(await assertOwnerOnly(join(dir, 'missing')), { ok: false, reason: 'missing', detail: 'not found' });
});

test('a symlinked private path is refused (BLD-08)', { skip: process.platform === 'win32' ? 'symlink creation needs privileges on Windows' : false }, async (t) => {
  const dir = tempDir(t);
  const real = join(dir, 'real');
  mkdirSync(real);
  symlinkSync(real, join(dir, 'link'));
  assert.deepEqual(await ensurePrivateDir(join(dir, 'link')), { ok: false, code: 'ESYMLINK' });
  writeFileSync(join(real, 'f'), 'keep');
  symlinkSync(join(real, 'f'), join(dir, 'f-link'));
  assert.deepEqual(await tightenPrivateFile(join(dir, 'f-link')), { ok: false, code: 'ESYMLINK' });
  assert.deepEqual(await writePrivateFile(join(dir, 'f-link'), 'x'), { ok: false, code: 'ESYMLINK' });
  assert.equal(readFileSync(join(real, 'f'), 'utf8'), 'keep');
  assert.deepEqual(await assertOwnerOnly(join(dir, 'f-link')), { ok: false, reason: 'symlink', detail: 'symlink' });
});

test('applyOwnerOnlyAcl fails closed when icacls or whoami fail', () => {
  const failing = () => ({ status: 5, stdout: '' });
  assert.equal(applyOwnerOnlyAcl('C:\\x', true, { platform: 'win32', exec: failing }), false);
});
