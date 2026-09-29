// Harness parity audit G11: the capability inventory reads Codex skills under CODEX_HOME, and
// Antigravity plugin skills where the installer puts them (~/.gemini/config/plugins and the
// CLI's ~/.gemini/antigravity-cli/plugins). A temp home only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRoots } from '../dist/index.js';

function box(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-skill-roots-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home, make: (...parts) => mkdirSync(join(...parts), { recursive: true }) };
}

const paths = (roots, harness) => roots.filter((r) => r.harness === harness).map((r) => r.path).sort();

test('Codex skill roots follow CODEX_HOME when it is set', (t) => {
  const b = box(t);
  const codexHome = join(b.dir, 'codex-home');
  b.make(codexHome, 'skills');
  b.make(codexHome, 'plugins', 'cache', 'jevris', 'skills');
  b.make(b.home, '.codex', 'skills');
  assert.deepEqual(paths(skillRoots(b.home, { HOME: b.home, CODEX_HOME: codexHome }, []), 'codex'), [join(codexHome, 'plugins', 'cache', 'jevris', 'skills'), join(codexHome, 'skills')]);
  assert.deepEqual(paths(skillRoots(b.home, { HOME: b.home }, []), 'codex'), [join(b.home, '.codex', 'skills')], 'unset: ~/.codex');
  assert.deepEqual(paths(skillRoots(b.home, { HOME: b.home, CODEX_HOME: 'relative/codex' }, []), 'codex'), [join(b.home, '.codex', 'skills')], 'a relative CODEX_HOME is ignored');
});

test('Antigravity plugin skills are found where Jevris installs them', (t) => {
  const b = box(t);
  b.make(b.home, '.gemini', 'config', 'plugins', 'jevris', 'skills');
  b.make(b.home, '.gemini', 'antigravity-cli', 'plugins', 'jevris', 'skills');
  assert.deepEqual(paths(skillRoots(b.home, { HOME: b.home }, []), 'antigravity'), [
    join(b.home, '.gemini', 'antigravity-cli', 'plugins', 'jevris', 'skills'),
    join(b.home, '.gemini', 'config', 'plugins', 'jevris', 'skills'),
  ]);
});
