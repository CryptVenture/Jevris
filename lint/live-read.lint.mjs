import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * A test that walks a folder a running daemon, sidecar, worker or hook writes into (the data,
 * state, runtime or log folders, a home tree) and reads each file it finds must read through
 * test/live-files.mjs (scanRead, readLive, waitForText), not a bare readFileSync: on Windows a
 * read of a file that is being written, or scanned, fails with EBUSY, EPERM or EACCES
 * (windows-latest, 84ccf26: `EBUSY: resource busy or locked, read` in security-hook-e2e).
 *
 * The finding: a readFileSync of the walk's loop variable (`full`, `file`, `path`, `entry`) within
 * 8 lines after a readdirSync( in the same test file.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

/** `file` entries with the reason a bare read of a walked file is safe there. */
export const ALLOW = new Map([
  ['apps/cli/test/shared-config-safety.test.mjs', 'hashes the user config files of an installer home; no daemon writes there'],
]);

const READ = /readFileSync\(\s*(?:full|file|path|entry)\s*[,)]/;

/** Line numbers of a bare read of a walked file. */
export function bareWalkReads(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, index) => {
    if (!/readdirSync\(/.test(line)) return;
    for (let j = index; j < Math.min(lines.length, index + 9); j += 1) {
      if (READ.test(lines[j] ?? '') && !out.includes(j + 1)) out.push(j + 1);
    }
  });
  return out;
}

function findings() {
  const out = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === 'test/live-files.test.mjs' || ALLOW.has(rel)) continue;
    for (const line of bareWalkReads(readFileSync(file, 'utf8'))) out.push(`${rel}:${line}`);
  }
  return out.sort();
}

test('no test reads a file it walked in a daemon-written folder with a bare readFileSync (use test/live-files.mjs)', () => {
  assert.deepEqual(findings(), []);
});

test('every allowlist entry still has a bare read', () => {
  const stale = [...ALLOW.keys()].filter((rel) => bareWalkReads(readFileSync(`${root}${rel}`, 'utf8')).length === 0);
  assert.deepEqual(stale, []);
});

test('the detector flags a bare read after a directory listing and passes the helper', () => {
  assert.deepEqual(bareWalkReads("for (const name of readdirSync(dir)) {\n  const full = join(dir, name);\n  out += readFileSync(full, 'utf8');\n}"), [3]);
  assert.deepEqual(bareWalkReads("for (const name of readdirSync(dir)) {\n  out += scanRead(full, 'utf8');\n}"), []);
  assert.deepEqual(bareWalkReads("const a = readFileSync(file, 'utf8');"), []);
});
