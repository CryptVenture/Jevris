import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GOV-07: the explicit opt-in credential source for headless Linux, CI and WSL.
// No test opens the OS keystore: every keystore here is an injected port.
const {
  CREDENTIAL_FILE_ENV,
  CREDENTIAL_SYSTEMD_ENV,
  optInRefusalText,
  optInSourceOf,
  readOptInCredential,
  resolveProviderCredential,
} = await import('../dist/credential.js');

const CANARY = 'CANARY_OPTIN_do_not_print';
const posix = process.platform !== 'win32';

function keystore(value) {
  const opens = [];
  return {
    opens,
    open(service, account) {
      opens.push({ service, account });
      return { get: () => value, set() {}, delete() {} };
    },
  };
}

function unavailableKeystore() {
  return () => {
    throw new Error('no secret service on this host');
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'b-gov07-'));
  chmodSync(dir, 0o700);
  return dir;
}

function keyFile(dir, name = 'jev.key', mode = 0o600, body = `${CANARY}\n`) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

test('the opt-in is read from exactly two named variables and never searched for (GOV-07)', () => {
  assert.equal(optInSourceOf({}), undefined);
  assert.equal(optInSourceOf({ HOME: '/home/x', CREDENTIALS_DIRECTORY: '/run/credentials/jevris.service' }), undefined);
  // An absolute, normalized path on this OS (on Windows, /etc/... resolves onto the current drive).
  const absolute = process.platform === 'win32' ? 'C:\\ProgramData\\jevris\\key' : '/etc/jevris/key';
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_FILE_ENV]: absolute }), { kind: 'file', path: absolute });
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_FILE_ENV]: 'relative/key' }), { refused: 'not-absolute' });
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_FILE_ENV]: '/etc/../etc/jevris/key' }), { refused: 'not-absolute' });
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_FILE_ENV]: '/a', [CREDENTIAL_SYSTEMD_ENV]: 'b' }), { refused: 'both-set' });
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_SYSTEMD_ENV]: 'jev' }), { refused: 'no-credentials-directory' });
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_SYSTEMD_ENV]: '../jev', CREDENTIALS_DIRECTORY: '/run/c' }), { refused: 'bad-name' });
  // The credentials directory is resolved like the file path, so on Windows it names a drive.
  const credentials = process.platform === 'win32' ? 'C:\\run\\c' : '/run/c';
  assert.deepEqual(optInSourceOf({ [CREDENTIAL_SYSTEMD_ENV]: 'jev', CREDENTIALS_DIRECTORY: credentials }), {
    kind: 'systemd-creds',
    path: join(credentials, 'jev'),
  });
});

test('the keychain stays the default: with a key there, the opt-in file is never opened (GOV-07)', async () => {
  const store = keystore('KEYCHAIN_VALUE');
  const sources = [];
  const resolved = await resolveProviderCredential(store.open, {
    optInEnv: { [CREDENTIAL_FILE_ENV]: '/nonexistent/b-gov07/never-opened' },
    onSource: (source) => sources.push(source),
  });
  assert.equal(resolved.apiKey, 'KEYCHAIN_VALUE');
  assert.deepEqual(sources, ['keychain']);
  assert.equal(store.opens.length, 1);
});

test('without the opt-in, a host with no keystore stays rules-only (GOV-07)', async () => {
  const resolved = await resolveProviderCredential(unavailableKeystore(), { optInEnv: {} });
  assert.equal(resolved.mode, 'rules-only');
  assert.equal(resolved.refused, undefined);
});

test('an owner-only file outside any work tree supplies the key when the keystore has none (GOV-07)', { skip: !posix }, async () => {
  const dir = scratch();
  try {
    const path = keyFile(dir);
    for (const open of [unavailableKeystore(), keystore(undefined).open]) {
      const sources = [];
      const resolved = await resolveProviderCredential(open, {
        optInEnv: { [CREDENTIAL_FILE_ENV]: path },
        onSource: (source) => sources.push(source),
      });
      assert.equal(resolved.apiKey, CANARY);
      assert.deepEqual(sources, ['file']);
    }
    const systemd = await resolveProviderCredential(unavailableKeystore(), {
      optInEnv: { [CREDENTIAL_SYSTEMD_ENV]: 'jev.key', CREDENTIALS_DIRECTORY: dir },
    });
    assert.equal(systemd.apiKey, CANARY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a group- or world-readable file is refused, and the refusal never carries the contents (GOV-07)', { skip: !posix }, async () => {
  const dir = scratch();
  try {
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o606]) {
      const path = keyFile(dir, `jev-${mode.toString(8)}.key`, mode);
      const resolved = await resolveProviderCredential(unavailableKeystore(), { optInEnv: { [CREDENTIAL_FILE_ENV]: path } });
      assert.equal(resolved.mode, 'rules-only', `mode ${mode.toString(8)}`);
      assert.equal(resolved.refused, 'group-or-world-access');
      assert.equal(JSON.stringify(resolved).includes(CANARY), false);
      assert.equal(optInRefusalText(resolved.refused).includes(CANARY), false);
      assert.equal('apiKey' in resolved, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file inside a git work tree is refused, at any depth (GOV-07)', { skip: !posix }, async () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'deep', 'er'), { recursive: true, mode: 0o700 });
    chmodSync(join(dir, 'repo'), 0o700);
    chmodSync(join(dir, 'repo', 'deep'), 0o700);
    chmodSync(join(dir, 'repo', 'deep', 'er'), 0o700);
    for (const parent of [join(dir, 'repo'), join(dir, 'repo', 'deep', 'er')]) {
      const path = keyFile(parent);
      const read = await readOptInCredential({ kind: 'file', path });
      assert.deepEqual(read, { refused: 'inside-git-work-tree' });
    }
    // A worktree or submodule marks itself with a .git file, not a directory.
    mkdirSync(join(dir, 'wt'), { mode: 0o700 });
    writeFileSync(join(dir, 'wt', '.git'), 'gitdir: /elsewhere\n');
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: keyFile(join(dir, 'wt')) }), { refused: 'inside-git-work-tree' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinks, directories, other owners, unsafe directories, oversize and multi-line files are refused (GOV-07)', { skip: !posix }, async () => {
  const dir = scratch();
  try {
    const real = keyFile(dir);
    const link = join(dir, 'link.key');
    symlinkSync(real, link);
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: link }), { refused: 'symlink' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: dir }), { refused: 'not-a-file' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: join(dir, 'absent') }), { refused: 'unreadable' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: real }, { uid: 4242424 }), { refused: 'not-owner' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: real }, { platform: 'win32' }), { refused: 'unsupported-platform' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: keyFile(dir, 'big.key', 0o600, 'x'.repeat(5000)) }), { refused: 'too-large' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: keyFile(dir, 'two.key', 0o600, `${CANARY}\nsecond\n`) }), { refused: 'malformed' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: keyFile(dir, 'empty.key', 0o600, '') }), { refused: 'malformed' });
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: keyFile(shared) }), { refused: 'unsafe-directory' });
    assert.deepEqual(await readOptInCredential({ kind: 'file', path: real }), { secret: CANARY });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
