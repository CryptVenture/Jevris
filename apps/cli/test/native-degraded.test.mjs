import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
// --import takes a URL: a bare Windows path (D:\...) is read as a URL with the scheme d:.
const BLOCK_SQLITE = pathToFileURL(join(root, 'scripts', 'test-block-native.mjs')).href;
const BLOCK_KEYRING = pathToFileURL(join(root, 'scripts', 'test-preload.mjs')).href;
const BIN = join(root, 'bin', 'jevris.mjs');
const CANARY = 'CANARY_SECRET_do_not_print';
const DIAGNOSTIC = /^jevris: the native module better-sqlite3 could not be loaded \(MODULE_NOT_FOUND\)\. Jevris continues rules-only/;

const { main } = await import('../dist/cli.js');
const { KEYRING_UNAVAILABLE, KeyringUnavailableError } = await import('../dist/credential.js');
const { hostHealthLines, withHostLines } = await import('../dist/host-health.js');

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function noStack(text) {
  assert.equal(/\n\s+at /.test(text), false, 'no stack trace');
  assert.equal(text.includes('Error:'), false, 'no error dump');
}

function runBin(args, preload) {
  return spawnSync(process.execPath, ['--import', preload, BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, JEVRIS_SIDECAR_AUTOSTART: '0' },
  });
}

test('status with better-sqlite3 unavailable prints one plain diagnostic and exits 0 (BLD-13)', (t) => {
  const home = tempHome(t);
  const ran = runBin(['status', '--home', home], BLOCK_SQLITE);
  assert.equal(ran.status, 0, ran.stderr);
  const lines = ran.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^Jevris is in [\w-]+ mode/);
  assert.equal(lines.filter((line) => DIAGNOSTIC.test(line)).length, 1);
  assert.match(lines.at(-1), DIAGNOSTIC);
  assert.equal(ran.stderr, '');
  noStack(ran.stdout);
});

test('status with the store driver loaded prints no driver diagnostic', async (t) => {
  const home = tempHome(t);
  const saved = process.env.JEVRIS_SIDECAR_AUTOSTART;
  process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
  t.after(() => {
    if (saved === undefined) delete process.env.JEVRIS_SIDECAR_AUTOSTART;
    else process.env.JEVRIS_SIDECAR_AUTOSTART = saved;
  });
  let text = '';
  const code = await main(['status', '--home', home], (chunk) => {
    text += chunk;
  });
  assert.equal(code, 0);
  assert.match(text, /^Jevris is in [\w-]+ mode/);
  assert.equal(text.includes('better-sqlite3'), false);
});

test('doctor reports an unavailable store driver as a plain line (BLD-13)', (t) => {
  const home = tempHome(t);
  const ran = runBin(['doctor', '--home', home, '--harness-version', '2.1.280'], BLOCK_SQLITE);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^nativeAddon better-sqlite3: unavailable \(MODULE_NOT_FOUND\)$/m);
  // Under a test run the keyring binding is never probed.
  assert.match(ran.stdout, /^nativeAddon keyring: not-probed$/m);
  assert.match(ran.stdout, /^JEVRIS_REPORT /m);
  noStack(ran.stdout);
  assert.equal(ran.stderr, '');
});

test('credential set with no keyring binding prints one plain line and exits 2 (BLD-13)', async () => {
  let text = '';
  const code = await main(
    ['credential', 'set'],
    (chunk) => {
      text += chunk;
    },
    {
      openKeyring: async () => {
        throw new KeyringUnavailableError();
      },
      readStdin: () => new TextEncoder().encode(CANARY),
    },
  );
  assert.equal(code, 2);
  assert.equal(text, `${KEYRING_UNAVAILABLE}\n`);
  assert.equal(text.includes(CANARY), false);
  noStack(text);
});

test('the real keyring opener turns a missing binding into the plain line (BLD-13)', (t) => {
  // The child is not marked as a test run, so it takes the real opener. The keyring preload
  // blocks the binding; the child checks that before calling main and refuses otherwise,
  // so this can never reach the OS keychain.
  const cli = pathToFileURL(join(root, 'apps', 'cli', 'dist', 'cli.js')).href;
  const script = [
    `let blocked = false; try { await import('@napi-rs/keyring'); } catch { blocked = true; }`,
    `if (!blocked) { process.stdout.write('BINDING_NOT_BLOCKED'); process.exit(3); }`,
    `const { main } = await import(${JSON.stringify(cli)});`,
    `let text = '';`,
    `const code = await main(['credential', 'set'], (c) => { text += c; }, { readStdin: () => new TextEncoder().encode(${JSON.stringify(CANARY)}) });`,
    `process.stdout.write(JSON.stringify({ code, text }));`,
  ].join('\n');
  const env = { ...process.env };
  delete env.JEVRIS_TEST;
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(process.execPath, ['--import', BLOCK_KEYRING, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  if (ran.status === 3) {
    t.skip('the keyring preload did not block the binding in the child; not running the real opener');
    return;
  }
  assert.equal(ran.status, 0, ran.stderr);
  const parsed = JSON.parse(ran.stdout);
  assert.equal(parsed.code, 2);
  assert.equal(parsed.text, `${KEYRING_UNAVAILABLE}\n`);
  assert.equal(ran.stdout.includes(CANARY), false);
});

test('doctor host lines report wide private files and legacy leftovers (BLD-08)', async (t) => {
  const home = tempHome(t);
  const lines = await hostHealthLines({
    home,
    platform: 'linux',
    probeSqlite: () => ({ ok: true, name: 'better-sqlite3' }),
    probeKeyring: async () => 'loaded',
    ownerOnly: {
      lstat: async (path) => {
        if (path.endsWith('install-receipt.json')) {
          return { mode: 0o100644, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
        }
        if (path.endsWith('run')) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return { mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
      },
    },
    listDir: async (dir) => (dir.endsWith('share/jevris') ? ['install-receipt.json'] : []),
  });
  assert.equal(lines[0], 'nativeAddon better-sqlite3: loaded');
  assert.equal(lines[1], 'nativeAddon keyring: loaded');
  const wide = lines.filter((line) => line.startsWith('privateFiles: wide '));
  assert.equal(wide.length, 1);
  assert.match(wide[0], /install-receipt\.json mode 0644$/);
  assert.equal(lines.includes('privateFiles: ok'), false);
  assert.equal(lines.some((line) => line.startsWith('legacyLayout: ')), true);
});

test('doctor host lines say ok for an owner-only home on this OS (BLD-08)', { skip: process.platform === 'win32' ? 'POSIX modes; the Windows ACL path is unit-tested with a fake icacls in packages/platform' : false }, async (t) => {
  const home = tempHome(t);
  const lines = await hostHealthLines({ home, probeSqlite: () => ({ ok: true, name: 'better-sqlite3' }), probeKeyring: async () => 'not-probed' });
  assert.equal(lines.includes('privateFiles: ok'), true);
  // A wide file inside the data directory is named.
  const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
  const data = jevrisPaths({ home }).data;
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  writeFileSync(join(data, 'ledger.sqlite'), '');
  chmodSync(join(data, 'ledger.sqlite'), 0o644);
  const after = await hostHealthLines({ home, probeSqlite: () => ({ ok: true, name: 'better-sqlite3' }), probeKeyring: async () => 'not-probed' });
  assert.equal(after.includes(`privateFiles: wide ${join(data, 'ledger.sqlite')} mode 0644`), true);
});

test('host lines go before the JEVRIS_REPORT line', () => {
  const text = withHostLines('a\nb\nJEVRIS_REPORT {}\n', ['x', 'y']);
  assert.equal(text, 'a\nb\nx\ny\nJEVRIS_REPORT {}\n');
  assert.equal(withHostLines('no report\n', ['x']), 'no report\n');
});
