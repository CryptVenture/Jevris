// A printed, copy-and-run command must survive a folder name with a space in it. `jevris pack list`
// prints `install with: jevris pack install <folder>` for each built-in pack; under a runtime folder
// such as `/Volumes/WOB Ext Drive/...` an unquoted folder splits in the shell. Uses a temporary
// home; no keychain and no harness binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { runAdminCommand } = await import('../dist/admin-cli.js');
const { shellQuote } = await import('../../../packages/platform/dist/index.js');

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const bin = join(repo, 'bin', 'jevris.mjs');

function box(t, folder) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-pack-quote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(dir, 'home');
  mkdirSync(home);
  const runtime = join(dir, folder);
  mkdirSync(runtime);
  cpSync(join(repo, 'packs'), join(runtime, 'packs'), { recursive: true });
  return { dir, home, runtime };
}

async function list(paths) {
  let text = '';
  const code = await runAdminCommand(['pack', 'list', '--home', paths.home], (chunk) => (text += chunk), { packageRoot: paths.runtime, isTTY: false });
  assert.equal(code, 0, text);
  return text.split('\n').filter((line) => line.startsWith('built-in: '));
}

function childEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(JEVRIS_|XDG_|CLAUDE_)/.test(key)) env[key] = value;
  return { ...env, HOME: home, USERPROFILE: home, JEVRIS_TEST: '1', JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_NO_LIVE_HARNESS: '1' };
}

test('pack list: a runtime folder with plain characters prints its bundled-pack folders unquoted, as before', async (t) => {
  const paths = box(t, 'runtime');
  const lines = await list(paths);
  assert.equal(lines.length, 3);
  // An absolute folder, printed bare: /… on POSIX, C:\… on Windows.
  for (const line of lines) assert.match(line, /^built-in: jevris\.\S+ \S+ \(advise-only\); install with: jevris pack install (?:\/|[A-Za-z]:\\)[^\s'"]+$/);
});

test('pack list: a runtime folder with a space prints a quoted install folder', async (t) => {
  const paths = box(t, 'My Runtime Dir');
  const lines = await list(paths);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const folder = line.match(/install with: jevris pack install (.+)$/)?.[1] ?? '';
    // POSIX shells take single quotes; Windows (cmd and PowerShell) take double quotes.
    const q = process.platform === 'win32' ? '"' : "'";
    assert.ok(folder.startsWith(q) && folder.endsWith(q), `folder not quoted: ${line}`);
    assert.ok(folder.includes('My Runtime Dir'), line);
  }
});

test('pack list: the printed command works when pasted into a shell (and the unquoted form would not)', { skip: process.platform === 'win32' }, async (t) => {
  const paths = box(t, "Runtime Dir with 'quote' and space");
  const lines = await list(paths);
  assert.equal(lines.length, 3);
  const shell = (rest) => spawnSync('/bin/sh', ['-c', `${shellQuote(process.execPath, 'linux')} ${shellQuote(bin, 'linux')} pack inspect ${rest} --home ${shellQuote(paths.home, 'linux')}`], { env: childEnv(paths.home), encoding: 'utf8', cwd: paths.dir });
  for (const line of lines) {
    const quoted = line.match(/install with: jevris pack install (.+)$/)?.[1] ?? '';
    const ran = shell(quoted);
    assert.equal(ran.status, 0, `${quoted}\n${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /manifest: valid/);
    const raw = join(paths.runtime, 'packs', line.match(/built-in: jevris\.(\S+)/)[1]);
    const unquoted = shell(raw);
    assert.notEqual(unquoted.status, 0, 'the unquoted folder must be split by the shell');
  }
});
