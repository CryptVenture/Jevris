// B's private-file rule (2026-09-26), F's part: `jevris install` makes every entry under the
// Jevris folders owner-only (dirs 0700, files 0600), and doctor names what is still loose. The
// walk only removes group and other bits, only touches this uid's entries, never follows a
// symlink, and stays inside the Jevris folders. Temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const { walkPrivate, privateFileLines, doctorPrivateLines, privateRoots } = await import('../dist/private-tighten.js');
const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');

const POSIX = process.platform !== 'win32';
const skip = POSIX ? false : 'POSIX modes; the Windows owner-only ACL is unit-tested with a fake icacls in packages/platform';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-private-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

/** A home laid out the way an older Jevris left it: ~/.jevris 0755, evidence 0755, receipts 0644. */
function olderLayout(home) {
  const data = jevrisPaths({ home }).data;
  mkdirSync(join(data, 'evidence'), { recursive: true });
  chmodSync(data, 0o755);
  chmodSync(join(data, 'evidence'), 0o755);
  writeFileSync(join(data, 'notes.json'), '{}');
  chmodSync(join(data, 'notes.json'), 0o644);
  writeFileSync(join(data, 'evidence', 'record.json'), '{}');
  chmodSync(join(data, 'evidence', 'record.json'), 0o640);
  return data;
}

test('the walk covers data, state, runtime and config once each, outermost folder first', () => {
  const roots = privateRoots('/h', 'darwin');
  const paths = jevrisPaths({ home: '/h', platform: 'darwin' });
  assert.deepEqual([...roots].sort(), [...new Set([paths.data, paths.config])].sort(), 'state and runtime sit inside data on macOS');
});

test('repair tightens a 0755 folder and a 0644 file to 0700 and 0600, and never widens a mode', { skip }, async (t) => {
  const home = tempHome(t);
  const data = olderLayout(home);
  writeFileSync(join(data, 'narrow.json'), '{}');
  chmodSync(join(data, 'narrow.json'), 0o400);
  const out = await walkPrivate({ home, repair: true });
  assert.equal(mode(data), 0o700);
  assert.equal(mode(join(data, 'evidence')), 0o700);
  assert.equal(mode(join(data, 'notes.json')), 0o600);
  assert.equal(mode(join(data, 'evidence', 'record.json')), 0o600);
  assert.equal(mode(join(data, 'narrow.json')), 0o400, 'an owner-only mode is left as it is');
  assert.equal(out.every((entry) => entry.outcome === 'tightened'), true);
  assert.deepEqual(out.map((entry) => entry.mode).sort(), ['0640', '0644', '0755', '0755']);
});

test('repair keeps the owner execute bit on the runtime copy', { skip }, async (t) => {
  const home = tempHome(t);
  const data = jevrisPaths({ home }).data;
  mkdirSync(join(data, 'runtime', 'bin'), { recursive: true, mode: 0o755 });
  writeFileSync(join(data, 'runtime', 'bin', 'jevris'), '#!/bin/sh\n');
  chmodSync(join(data, 'runtime', 'bin', 'jevris'), 0o755);
  await walkPrivate({ home, repair: true });
  assert.equal(mode(join(data, 'runtime', 'bin', 'jevris')), 0o700);
});

test('a symlink is reported and never followed: its target keeps its mode', { skip }, async (t) => {
  const home = tempHome(t);
  const data = olderLayout(home);
  const outside = join(home, 'outside.txt');
  writeFileSync(outside, 'not Jevris');
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(data, 'link.txt'));
  const out = await walkPrivate({ home, repair: true });
  assert.equal(statSync(outside).mode & 0o777, 0o644, 'the link target is untouched');
  const link = out.find((entry) => entry.path === join(data, 'link.txt'));
  assert.equal(link?.outcome, 'symlink');
  const lines = privateFileLines(home, out.filter((entry) => entry.outcome === 'symlink'));
  // The data folder is ~/.jevris on macOS and Windows, ~/.local/share/jevris on Linux.
  const rel = relative(home, data);
  assert.match(lines[0], new RegExp(`^privateFiles: 1 symlink inside the Jevris folders, not followed \\(${escape(join(rel, 'link.txt'))}\\)`));
});

test('an entry another user owns is left alone (uid seam)', { skip }, async (t) => {
  const home = tempHome(t);
  const data = olderLayout(home);
  const chmods = [];
  const out = await walkPrivate({ home, repair: true, uid: 999_999_999, chmod: async (path, next) => chmods.push([path, next]) });
  assert.deepEqual(chmods, [], 'nothing is changed on an entry this uid does not own');
  assert.equal(mode(join(data, 'notes.json')), 0o644);
  assert.equal(out.every((entry) => entry.outcome === 'left'), true);
});

test('the check mode changes nothing; doctor names loose entries before install and none after', { skip }, async (t) => {
  const home = tempHome(t);
  const data = olderLayout(home);
  const hostLines = ['nativeAddon keyring: loaded', 'privateFiles: wide /somewhere mode 0755', 'legacyLayout: none'];
  const before = await doctorPrivateLines(home, hostLines);
  assert.equal(mode(join(data, 'notes.json')), 0o644, 'doctor changes nothing');
  assert.equal(before[0], 'nativeAddon keyring: loaded');
  assert.equal(before[2], 'legacyLayout: none');
  const rel = relative(home, data);
  const named = [`${rel} 0755`, `${join(rel, 'evidence')} 0755`, `${join(rel, 'evidence', 'record.json')} 0640`, `${join(rel, 'notes.json')} 0644`].join(', ');
  assert.equal(before[1], `privateFiles: 4 Jevris entries are readable by other users (${named}); fix: jevris install (it makes them owner-only)`);
  assert.equal(before.filter((line) => line.startsWith('privateFiles: ')).length, 1, 'the host-health top-level lines are replaced');
  await walkPrivate({ home, repair: true });
  const after = await doctorPrivateLines(home, hostLines);
  assert.deepEqual(after, ['nativeAddon keyring: loaded', 'privateFiles: ok', 'legacyLayout: none']);
});

test('on Windows the host-health ACL lines stay, each with the fix', async () => {
  const lines = await doctorPrivateLines('C:\\Users\\me', ['privateFiles: wide C:\\Users\\me\\.jevris acl grants Everyone'], { platform: 'win32' });
  assert.deepEqual(lines, ['privateFiles: wide C:\\Users\\me\\.jevris acl grants Everyone; fix: jevris install (it makes the Jevris folders owner-only)']);
});

test('jevris install tightens an older home in place', { skip }, async (t) => {
  const home = tempHome(t);
  const data = olderLayout(home);
  const { installGlobal } = await import('../dist/global-harness.js');
  const root = join(import.meta.dirname, '..', '..', '..');
  const cli = { available: () => false, run: async () => ({ spawned: false, code: 1, stdout: '' }) };
  const result = await installGlobal({ home, root, harness: 'claude', cli, env: { HOME: home, PATH: '' }, smoke: false });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(mode(data), 0o700);
  assert.equal(mode(join(data, 'evidence')), 0o700);
  assert.equal(mode(join(data, 'notes.json')), 0o600);
  const after = await doctorPrivateLines(home, ['privateFiles: ok']);
  assert.deepEqual(after, ['privateFiles: ok']);
});
