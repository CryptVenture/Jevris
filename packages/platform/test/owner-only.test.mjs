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
    const current = acls.get(path) ?? ['BUILTIN\\Administrators:(I)(F)', 'NT AUTHORITY\\SYSTEM:(I)(F)', 'DESKTOP-ADA\\ada:(I)(F)'];
    const principal = (ace) => ace.slice(0, ace.lastIndexOf(':')).toLowerCase();
    if (rest[0] === '/inheritance:r' && rest[1] === '/grant:r') {
      // As icacls does: /inheritance:r drops the inherited ACEs only, /grant:r replaces this
      // user's explicit ones, and the granted SID is listed by account name, each right in parentheses.
      const rights = rest[2].slice(rest[2].indexOf(':') + 1).replace(/F$/, '(F)');
      const kept = current.filter((ace) => !ace.includes('(I)') && principal(ace) !== 'desktop-ada\\ada');
      acls.set(path, [...kept, `DESKTOP-ADA\\ada:${rights}`]);
      return { status: 0, stdout: '' };
    }
    if (rest[0] === '/remove:g') {
      const names = new Set(rest.slice(1).filter((arg) => arg !== '/q').map((name) => name.replace(/^\*/, '').toLowerCase()));
      acls.set(path, current.filter((ace) => !names.has(principal(ace))));
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
  // icacls echoes the path in the OEM code page: a home such as "Ann Lée home" comes back with
  // U+FFFD (the byte read as UTF-8), another character or "?" where the é was (windows-latest).
  const home = 'C:\\Users\\x\\Ann Lée home\\AppData\\Local\\Jevris';
  for (const echo of ['C:\\Users\\x\\Ann L\uFFFDe home\\AppData\\Local\\Jevris', 'C:\\Users\\x\\Ann L?e home\\AppData\\Local\\Jevris', 'C:\\Users\\x\\Ann L\u201Ae home\\AppData\\Local\\Jevris']) {
    assert.deepEqual(parseIcacls(`${echo} DESKTOP-ADA\\ada:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, home), [{ principal: 'DESKTOP-ADA\\ada', rights: '(OI)(CI)(F)' }], echo);
  }
  assert.equal(parseIcacls('C:\\Users\\x\\Ann Lxe home\\AppData\\Local\\Jevris DESKTOP-ADA\\ada:(F)\r\n', home), null, 'an ASCII letter never stands for the é');
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

// windows-latest, 2026-09-29: a new directory in the runner's temp folder listed explicit
// SYSTEM and Administrators ACEs after /inheritance:r /grant:r, and every private write failed.
test('win32: explicit ACEs for others that survive /inheritance:r are removed, then read back (BLD-08)', async () => {
  const dir = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\private dir';
  const win = fakeWindows({ [dir]: ['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'BUILTIN\\Administrators:(OI)(CI)(F)', 'DESKTOP-ADA\\ada:(OI)(CI)(F)', 'S-1-5-21-9-9-9-1234:(RX)'] });
  assert.equal(applyOwnerOnlyAcl(dir, true, { platform: 'win32', exec: win.exec }), true);
  assert.deepEqual(win.acls.get(dir), ['DESKTOP-ADA\\ada:(OI)(CI)(F)']);
  assert.deepEqual(win.calls.find((call) => call[2] === '/remove:g'), ['icacls.exe', dir, '/remove:g', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', '*S-1-5-21-9-9-9-1234', '/q']);
  assert.deepEqual(await assertOwnerOnly(dir, { platform: 'win32', exec: win.exec, lstat: winStat(true) }), { ok: true });
  // A removal icacls refuses fails closed.
  const refusing = fakeWindows({ [dir]: ['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)'] });
  const exec = (file, args) => (args[1] === '/remove:g' ? { status: 5, stdout: '' } : refusing.exec(file, args));
  assert.equal(applyOwnerOnlyAcl(dir, true, { platform: 'win32', exec }), false);
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

// The fakes above are the icacls output as documented; this is the real icacls and whoami on a
// Windows host (CI's windows-latest), in the run's temp folder. A miss names both outputs.
test('win32, real icacls: a private directory and a private file get owner-only ACLs (BLD-08)', { skip: process.platform === 'win32' ? false : 'needs Windows icacls and whoami' }, async (t) => {
  const { spawnSync } = await import('node:child_process');
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const raw = (file, args) => {
    const result = spawnSync(join(system, file), args, { windowsHide: true });
    // As JSON, so an encoding the parser does not expect (UTF-16, a code page) shows as it is.
    return `${file} ${args.join(' ')} -> ${result.status}: ${JSON.stringify(String(result.stdout))} ${JSON.stringify(String(result.stderr))}`;
  };
  const parent = tempDir(t);
  const plain = join(parent, 'plain dir');
  mkdirSync(plain);
  t.diagnostic(`a plain new folder: ${raw('icacls.exe', [plain])}`);
  const dir = join(parent, 'private dir');
  const made = await ensurePrivateDir(dir);
  const seen = () => `${raw('whoami.exe', ['/user', '/fo', 'csv', '/nh'])}\n${raw('icacls.exe', [dir])}`;
  assert.deepEqual(made, { ok: true }, seen());
  assert.deepEqual(await assertOwnerOnly(dir), { ok: true }, seen());
  const file = join(dir, 'state.json');
  const written = await writePrivateFile(file, '{}\n');
  assert.equal(written.ok, true, `${JSON.stringify(written)}\n${raw('icacls.exe', [file])}`);
  assert.deepEqual(await assertOwnerOnly(file), { ok: true }, raw('icacls.exe', [file]));
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
