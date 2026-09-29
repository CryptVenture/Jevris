// CLI UX paths that need a real child process (ADM-01): piped, non-TTY standard input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'cli.js')).href;
const CANARY = 'CANARY_piped_jev_key_do_not_print';

// The child uses an in-memory keyring (never the OS keychain) and reads the key from its real,
// piped process.stdin: the path CI uses when no TTY is present.
const CHILD = `
import { createHash } from 'node:crypto';
const { main } = await import(${JSON.stringify(CLI)});
let stored;
const openKeyring = () => ({ set(v) { stored = v; }, get() { return stored; }, delete() { stored = undefined; } });
const code = await main(['credential', 'set'], (t) => process.stdout.write(t), { openKeyring });
process.stderr.write(JSON.stringify({ code, digest: stored === undefined ? null : createHash('sha256').update(stored).digest('hex') }));
process.exit(code);
`;

test('credential set reads a piped key from non-TTY stdin, stores it and echoes nothing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-ux-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    input: `${CANARY}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, 'present\n');
  assert.equal(ran.stdout.includes(CANARY), false);
  const report = JSON.parse(ran.stderr);
  assert.equal(report.code, 0);
  assert.equal(report.digest, createHash('sha256').update(CANARY).digest('hex'));
});
