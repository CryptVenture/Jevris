import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { jevrisPaths } from '@jevris/platform';

// GOV-11 (SSOT §16.1 "Path escape"): output options write only inside the approved roots, never
// through a link below a root, never into Jevris's private directories or .git, and always by an
// atomic owner-only replace.

const { confineOutputPath, writeConfinedOutput } = await import('../dist/host-policy.js');

const POSIX = process.platform !== 'win32';

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-out-')));
}

/** A directory link: a symlink on POSIX, a junction on Windows (no privilege needed). */
function dirLink(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

test('an output inside the working directory is written owner-only, creating directories, and may replace a file (GOV-11)', async () => {
  const cwd = scratch();
  const jevrisHome = scratch();
  try {
    const first = await writeConfinedOutput(join('reports', 'nested', 'gates-report.json'), '{"a":1}\n', { cwd, roots: [cwd], jevrisHome });
    assert.deepEqual(first, { ok: true, path: join(cwd, 'reports', 'nested', 'gates-report.json') });
    assert.equal(readFileSync(first.path, 'utf8'), '{"a":1}\n');
    if (POSIX) {
      assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(cwd, 'reports')).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(cwd, 'reports', 'nested')).mode & 0o777, 0o700);
    }
    const again = await writeConfinedOutput(first.path, 'second\n', { cwd, roots: [cwd], jevrisHome });
    assert.equal(again.ok, true);
    assert.equal(readFileSync(first.path, 'utf8'), 'second\n');
    // An existing directory is used as it is: the working directory keeps its mode.
    const modeBefore = lstatSync(cwd).mode;
    assert.equal((await writeConfinedOutput('top.txt', 'x', { cwd, roots: [cwd], jevrisHome })).ok, true);
    assert.equal(lstatSync(cwd).mode, modeBefore);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(jevrisHome, { recursive: true, force: true });
  }
});

test('an output outside the approved roots, or through .. out of them, is refused and nothing is written (GOV-11)', async () => {
  const cwd = scratch();
  const elsewhere = scratch();
  const jevrisHome = scratch();
  try {
    const options = { cwd, roots: [cwd], jevrisHome };
    assert.deepEqual(await writeConfinedOutput(join(elsewhere, 'out.json'), 'x', options), { ok: false, reasonCode: 'OUTPUT_OUTSIDE_ROOTS' });
    assert.deepEqual(await writeConfinedOutput(join('..', parse(elsewhere).base, 'out.json'), 'x', options), { ok: false, reasonCode: 'OUTPUT_OUTSIDE_ROOTS' });
    assert.equal(existsSync(join(elsewhere, 'out.json')), false);
    // The root itself is not a file to write, and a filesystem root approves nothing.
    assert.equal((await confineOutputPath(cwd, options)).ok, false);
    const fsRoot = parse(cwd).root;
    assert.deepEqual(await confineOutputPath(join(cwd, 'x.json'), { cwd: fsRoot, roots: [fsRoot], jevrisHome }), { ok: false, reasonCode: 'OUTPUT_OUTSIDE_ROOTS' });
    for (const bad of ['', 'a\0b', 'x'.repeat(5000)]) {
      assert.deepEqual(await confineOutputPath(bad, options), { ok: false, reasonCode: 'OUTPUT_PATH_INVALID' });
    }
    // The defaults approve the working directory, the home and the temp directory.
    assert.equal((await confineOutputPath('default.json', { cwd, jevrisHome })).ok, true);
  } finally {
    for (const dir of [cwd, elsewhere, jevrisHome]) rmSync(dir, { recursive: true, force: true });
  }
});

test('a link below the root is refused and never written through; a root reached by a link is fine (GOV-11)', async () => {
  const cwd = scratch();
  const victim = scratch();
  const jevrisHome = scratch();
  try {
    const options = { cwd, roots: [cwd], jevrisHome };
    dirLink(victim, join(cwd, 'linked'));
    assert.deepEqual(await writeConfinedOutput(join('linked', 'out.json'), 'x', options), { ok: false, reasonCode: 'OUTPUT_SYMLINK' });
    assert.deepEqual(await writeConfinedOutput(join('linked', 'new', 'out.json'), 'x', options), { ok: false, reasonCode: 'OUTPUT_SYMLINK' });
    assert.equal(existsSync(join(victim, 'out.json')), false);
    assert.equal(existsSync(join(victim, 'new')), false);

    if (POSIX) {
      // A symlinked target file is refused; the file it points at is unchanged.
      writeFileSync(join(victim, 'secret'), 'keep');
      symlinkSync(join(victim, 'secret'), join(cwd, 'target.json'));
      assert.deepEqual(await writeConfinedOutput('target.json', 'x', options), { ok: false, reasonCode: 'OUTPUT_SYMLINK' });
      assert.equal(readFileSync(join(victim, 'secret'), 'utf8'), 'keep');
      // A hard link planted at the target is replaced, not written through.
      linkSync(join(victim, 'secret'), join(cwd, 'hard.json'));
      assert.equal((await writeConfinedOutput('hard.json', 'new', options)).ok, true);
      assert.equal(readFileSync(join(victim, 'secret'), 'utf8'), 'keep');
      assert.equal(readFileSync(join(cwd, 'hard.json'), 'utf8'), 'new');
    }

    // The root may be reached through a link (macOS /tmp, a linked checkout).
    const viaLink = join(victim, 'root-link');
    dirLink(cwd, viaLink);
    const written = await writeConfinedOutput(join(viaLink, 'ok.json'), 'fine', { cwd: viaLink, roots: [viaLink], jevrisHome });
    assert.equal(written.ok, true);
    assert.equal(readFileSync(join(cwd, 'ok.json'), 'utf8'), 'fine');
  } finally {
    for (const dir of [cwd, victim, jevrisHome]) rmSync(dir, { recursive: true, force: true });
  }
});

test('Jevris private directories, .git, .ssh, a directory target and a file on the way are refused (GOV-11)', async () => {
  const cwd = scratch();
  try {
    const paths = jevrisPaths({ home: cwd });
    const options = { cwd, roots: [cwd], jevrisHome: cwd };
    for (const dir of [paths.data, paths.state, paths.config, paths.runtime]) {
      assert.deepEqual(await confineOutputPath(join(dir, 'x.json'), options), { ok: false, reasonCode: 'OUTPUT_PRIVATE_DIR' }, dir);
    }
    assert.deepEqual(await confineOutputPath(join('.git', 'hooks', 'pre-commit'), options), { ok: false, reasonCode: 'OUTPUT_PRIVATE_DIR' });
    assert.deepEqual(await confineOutputPath(join('.ssh', 'authorized_keys'), options), { ok: false, reasonCode: 'OUTPUT_PRIVATE_DIR' });
    mkdirSync(join(cwd, 'dir'));
    assert.deepEqual(await confineOutputPath('dir', options), { ok: false, reasonCode: 'OUTPUT_NOT_FILE' });
    writeFileSync(join(cwd, 'file'), 'x');
    assert.deepEqual(await confineOutputPath(join('file', 'out.json'), options), { ok: false, reasonCode: 'OUTPUT_NOT_DIRECTORY' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
