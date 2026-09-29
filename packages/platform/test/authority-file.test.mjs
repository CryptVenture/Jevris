// SR-4: a Jevris-home file that grants authority (the egress approval in host.json) counts only
// when it is a regular file, not a link, owned by this user and writable by nobody else (macOS and
// Linux), and neither it nor the Jevris home is inside a git work tree. SR-16: readFileNoFollow
// never follows a link and never reads past its cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTHORITY_FILE_REFUSALS, authorityFileRefusal, insideGitWorkTree, readAuthorityFile, readFileNoFollow } from '../dist/index.js';

const posix = process.platform !== 'win32';

function place(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-authority-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const config = join(home, 'config');
  mkdirSync(config, { recursive: true });
  const file = join(config, 'host.json');
  return { dir, home, config, file };
}

const text = (read) => (read.kind === 'ok' ? new TextDecoder().decode(read.bytes) : read.kind);

test('a regular owner-only file outside any work tree is read, and a missing one grants nothing', (t) => {
  const p = place(t);
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home }, 1024), { kind: 'missing' });
  assert.equal(authorityFileRefusal(p.file, { home: p.home }), null, 'missing is not a refusal');
  writeFileSync(p.file, '{"egress":"approved-scoped"}', { mode: 0o600 });
  assert.equal(text(readAuthorityFile(p.file, { home: p.home }, 1024)), '{"egress":"approved-scoped"}');
  assert.equal(authorityFileRefusal(p.file, { home: p.home }), null);
  assert.equal(readAuthorityFile(p.file, { home: p.home }, 4).kind, 'invalid', 'larger than the cap');
  assert.equal(AUTHORITY_FILE_REFUSALS.length, 6);
});

test('a Jevris home or a file inside a git work tree grants nothing (a repository could have supplied it)', (t) => {
  const p = place(t);
  writeFileSync(p.file, '{}', { mode: 0o600 });
  mkdirSync(join(p.dir, '.git'));
  assert.equal(insideGitWorkTree(p.home), true);
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home }, 1024), { kind: 'refused', reasonCode: 'JEVRIS_HOME_IN_WORK_TREE' });
  rmSync(join(p.dir, '.git'), { recursive: true });
  // A linked worktree marks itself with a .git file, which counts the same.
  writeFileSync(join(p.config, '.git'), 'gitdir: /elsewhere\n');
  assert.equal(insideGitWorkTree(p.home), false);
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home }, 1024), { kind: 'refused', reasonCode: 'AUTHORITY_FILE_IN_WORK_TREE' });
  rmSync(join(p.config, '.git'));
  assert.equal(readAuthorityFile(p.file, { home: p.home }, 1024).kind, 'ok');
});

test('a home reached through a link into a repository counts as inside it', { skip: posix ? false : 'symlinks need privileges on Windows' }, (t) => {
  const p = place(t);
  const repo = join(p.dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'jevris-home'));
  const link = join(p.dir, 'home-link');
  symlinkSync(join(repo, 'jevris-home'), link);
  assert.equal(insideGitWorkTree(link), true);
});

test('a symbolic link, a folder, another owner or a group- or world-writable file grants nothing', { skip: posix ? false : 'owner and mode bits are POSIX' }, (t) => {
  const p = place(t);
  const real = join(p.dir, 'real.json');
  writeFileSync(real, '{}', { mode: 0o600 });
  symlinkSync(real, p.file);
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home }, 1024), { kind: 'refused', reasonCode: 'AUTHORITY_FILE_SYMLINK' });
  rmSync(p.file);
  mkdirSync(p.file);
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home }, 1024), { kind: 'refused', reasonCode: 'AUTHORITY_FILE_NOT_REGULAR' });
  rmSync(p.file, { recursive: true });
  writeFileSync(p.file, '{}', { mode: 0o600 });
  const uid = process.getuid();
  assert.deepEqual(readAuthorityFile(p.file, { home: p.home, uid: uid + 1 }, 1024), { kind: 'refused', reasonCode: 'AUTHORITY_FILE_NOT_OWNER' });
  for (const mode of [0o620, 0o602, 0o666]) {
    chmodSync(p.file, mode);
    assert.equal(authorityFileRefusal(p.file, { home: p.home }), 'AUTHORITY_FILE_SHARED_WRITE', mode.toString(8));
  }
  chmodSync(p.file, 0o644);
  assert.equal(authorityFileRefusal(p.file, { home: p.home }), null, 'others may read it; only writing is refused');
});

test('on Windows the owner and mode are not checked; the link, file and work-tree rules still are', (t) => {
  const p = place(t);
  writeFileSync(p.file, '{}');
  assert.equal(readAuthorityFile(p.file, { home: p.home, platform: 'win32', uid: 12345 }, 1024).kind, 'ok');
});

test('SR-16: readFileNoFollow reads a regular file up to its cap and never through a link', (t) => {
  const p = place(t);
  assert.deepEqual(readFileNoFollow(p.file, 16), { kind: 'missing' });
  writeFileSync(p.file, 'abc');
  assert.equal(text(readFileNoFollow(p.file, 16)), 'abc');
  assert.equal(readFileNoFollow(p.file, 2).kind, 'too-large');
  assert.equal(readFileNoFollow(p.config, 16).kind, 'not-regular');
  let accepted = null;
  assert.equal(readFileNoFollow(p.file, 16, (stats) => ((accepted = stats.size), false)).kind, 'unreadable', 'the caller may refuse the open file');
  assert.equal(accepted, 3);
  if (posix) {
    const link = join(p.dir, 'link.json');
    symlinkSync(p.file, link);
    assert.equal(readFileNoFollow(link, 16).kind, 'link');
  }
});
