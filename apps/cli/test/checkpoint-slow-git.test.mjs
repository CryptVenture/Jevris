// A slow git (a loaded Windows CI runner answers in seconds) must not drop the checkpoint's
// changed-file list: the local checkpoint path waits for git up to GIT_READ_TIMEOUT_MS. The git is a
// stub first on PATH for this test only (restored after), a node script behind a shell script, or
// behind a .cmd shim on Windows. No real git and no harness runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };
const STATUS_DELAY_MS = 4000;

function stubGit(dir) {
  const script = join(dir, 'git-stub.mjs');
  writeFileSync(script, [
    "const args = process.argv.slice(2);",
    "if (args.includes('status')) {",
    `  await new Promise((resolve) => setTimeout(resolve, ${STATUS_DELAY_MS}));`,
    "  process.stdout.write(' M changed.txt\\0');",
    "} else if (args.includes('rev-parse')) {",
    "  process.stdout.write('0123456789ab\\n');",
    '}',
    '',
  ].join('\n'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'git.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = join(bin, 'git');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return bin;
}

function capsuleTexts(home) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) found.push(readFileSync(full, 'utf8'));
    }
  };
  walk(home);
  return found;
}

test('a checkpoint lists the changed file when git takes several seconds to answer', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-slowgit-')));
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(workspace, 'changed.txt'), 'edited\n');
  process.env.PATH = `${stubGit(dir)}${delimiter}${savedPath ?? ''}`;
  const ports = { sidecar: { async ensure() { return { ok: true, endpoint: 'fake', started: false }; }, async request() { return NOT_RUNNING; } }, engine: {}, config: {} };
  let text = '';
  const code = await runPublicCommand('checkpoint', ['--objective', 'Ship the parser'], (chunk) => (text += chunk), { ports, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' }, cwd: workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  assert.equal(code, 0, text);
  const capsules = capsuleTexts(home).filter((body) => body.includes('changed-file') || body.includes('changed.txt'));
  assert.equal(capsules.length >= 1, true, 'the capsule lists the file git reported after its delay');
  assert.match(capsules.join('\n'), /changed\.txt/);
});
