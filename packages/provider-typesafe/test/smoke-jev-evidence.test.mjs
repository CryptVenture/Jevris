// JEV-0075: `npm run smoke:jev` (the live Jev API suite, here against the conformance mock) wrote its evidence with `durableWrite` and threw the refusal code away:
// it printed `evidence: null` in its summary and exited 0 when the run itself passed, so a record that was refused (a path reached through a link, a folder it may
// not write) was lost with nothing saying why. It now says so on stderr with the platform's code and a fixed sentence, adds `evidenceNotWritten` to the summary,
// and exits 1. Offline: no key, no network, a temporary folder only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/smoke-jev.mjs', import.meta.url));

function run(args) {
  const out = spawnSync(process.execPath, [script, '--mock', '--calls', '2', ...args], { encoding: 'utf8', env: { ...process.env, JEVRIS_LIVE_JEV: '' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const summary = (out.stdout ?? '').trim().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).at(-1);
  return { code: out.status, stderr: out.stderr ?? '', summary };
}

test('a record that is refused says why on stderr with the platform\'s code and a fixed sentence, and the run fails: the destination is a folder, on every platform', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-jev-evidence-')));
  try {
    const folder = join(dir, 'is-a-folder.json');
    mkdirSync(folder);
    const out = run(['--evidence', folder]);
    assert.equal(out.code, 1, out.stderr);
    assert.match(out.stderr, /smoke:jev: evidence NOT WRITTEN \(([A-Z][A-Z0-9_]+): [^)]+\)/);
    assert.equal(out.stderr.includes(dir), false, 'the path is in the line');
    assert.equal(out.summary.passed, true, 'the suite itself passed: only the record was lost');
    assert.equal(out.summary.evidence, null);
    assert.match(out.summary.evidenceNotWritten, /^[A-Z][A-Z0-9_]+: /);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a path reached through a symbolic link is refused as ESYMLINK with what to do, and the real path is written (macOS /tmp is such a link)', { skip: process.platform === 'win32' && 'a symbolic link needs a privilege there' }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-jev-link-')));
  try {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir');
    const refused = run(['--evidence', join(dir, 'link', 'x.json')]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /smoke:jev: evidence NOT WRITTEN \(ESYMLINK: the file, or the folder it is in, is a symbolic link \(on macOS \/tmp is one\); name the real path, such as \/private\/tmp\/\.\.\., or a path with no link\)/);
    assert.equal(refused.stderr.includes(dir), false, 'the path is in the line');
    assert.equal(refused.summary.evidence, null);
    assert.match(refused.summary.evidenceNotWritten, /^ESYMLINK: /);
    assert.equal(existsSync(join(dir, 'real', 'x.json')), false, 'nothing was written through the link');
    const real = join(dir, 'real', 'x.json');
    const written = run(['--evidence', real]);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.stderr.includes('NOT WRITTEN'), false);
    assert.equal(written.summary.evidence, real);
    assert.equal(Object.hasOwn(written.summary, 'evidenceNotWritten'), false);
    assert.equal(JSON.parse(readFileSync(real, 'utf8')).kind, 'api-live-suite');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
