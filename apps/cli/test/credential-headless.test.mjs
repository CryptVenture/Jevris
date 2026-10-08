import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A machine with no OS keyring (a Linux server without a Secret Service): `credential set` says
// why and what to do, `credential status` and the sidecar's advice agree with the opt-in key
// file, and doctor says whether that file is usable. No test opens the real keystore: every
// keystore here is an injected port, and every platform is injected, so each scene runs the
// same on every OS the suite runs on.
const { main } = await import('../dist/cli.js');
const {
  CREDENTIAL_FILE_ENV,
  CREDENTIAL_INPUT_REFUSED,
  CREDENTIAL_SYSTEMD_ENV,
  KeyringBlockedError,
  KeyringUnavailableError,
  credentialReport,
  credentialSetRefusalLines,
  credentialStatusLines,
  inspectOptInSource,
  keystoreFailureClause,
  keystoreFailureOf,
  noCredentialAdvice,
  optInEnvOf,
  optInSourceOf,
  resolveProviderCredential,
} = await import('../dist/credential.js');
const { credentialSourceDoctorLines } = await import('../dist/credential-doctor.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');

const CANARY = 'CANARY_HEADLESS_do_not_print';
const MISSING_LINE = 'API credential is missing. Coding continues without a remote call.';
const posix = process.platform !== 'win32';
// What the binding throws on the server this was reported from.
const NO_SERVICE_MESSAGE = 'DBus error: The name org.freedesktop.secrets was not provided by any .service files';

function encode(text) {
  return new TextEncoder().encode(text);
}

async function run(args, hooks) {
  let text = '';
  const code = await main(args, (chunk) => {
    text += chunk;
  }, hooks);
  return { code, text };
}

/** A keystore whose every call throws `message`, and a count of how often it was opened. */
function brokenKeystore(message = NO_SERVICE_MESSAGE) {
  const state = { opens: 0 };
  return {
    state,
    openKeyring() {
      state.opens += 1;
      return {
        get() {
          throw new Error(message);
        },
        set() {
          throw new Error(message);
        },
        delete() {
          throw new Error(message);
        },
      };
    },
  };
}

function memoryKeystore(initial) {
  const state = { value: initial, opens: 0 };
  return {
    state,
    openKeyring() {
      state.opens += 1;
      return {
        get: () => state.value,
        set(value) {
          state.value = value;
        },
        delete() {
          state.value = undefined;
        },
      };
    },
  };
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-headless-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function keyFile(dir, { name = 'jev.key', mode = 0o600, body = `${CANARY}\n` } = {}) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

function noStack(text) {
  assert.equal(/\n\s+at /.test(text), false, 'no stack trace');
  assert.equal(text.includes('Error:'), false, 'no error dump');
}

function neverEchoes(text) {
  assert.equal(text.includes(CANARY), false, 'the key is never printed');
  assert.equal(text.includes('org.freedesktop'), false, "the binding's own message is never printed");
  assert.equal(text.includes('DBus error'), false, "the binding's own message is never printed");
  noStack(text);
}

test('the keystore failure code comes from the binding message and the message is dropped', () => {
  const cases = [
    [NO_SERVICE_MESSAGE, 'linux', 'KEYSTORE_NO_SERVICE'],
    ['Failed to connect to socket /run/user/0/bus: No such file or directory (dbus)', 'linux', 'KEYSTORE_NO_SERVICE'],
    ['Cannot autolaunch D-Bus without X11 $DISPLAY', 'linux', 'KEYSTORE_NO_SERVICE'],
    ['The Secret Service is locked', 'linux', 'KEYSTORE_LOCKED'],
    ['org.freedesktop.DBus.Error.AccessDenied: denied', 'linux', 'KEYSTORE_LOCKED'],
    ['User interaction is not allowed', 'darwin', 'KEYSTORE_LOCKED'],
    ['something else broke', 'linux', 'KEYSTORE_FAILED'],
    ['something else broke', 'darwin', 'KEYSTORE_FAILED'],
    ['something else broke', 'win32', 'KEYSTORE_FAILED'],
    // Bus words mean nothing off Linux.
    [NO_SERVICE_MESSAGE, 'darwin', 'KEYSTORE_FAILED'],
    [NO_SERVICE_MESSAGE, 'win32', 'KEYSTORE_FAILED'],
  ];
  for (const [message, platform, expected] of cases) {
    assert.equal(keystoreFailureOf(new Error(message), platform), expected, `${platform}: ${message}`);
  }
  assert.equal(keystoreFailureOf('not an error', 'linux'), 'KEYSTORE_FAILED');
  assert.equal(keystoreFailureOf(undefined, 'linux'), 'KEYSTORE_FAILED');
  assert.equal(keystoreFailureOf(new KeyringUnavailableError(), 'linux'), 'KEYSTORE_BINDING');
  // A test run blocks the keystore on purpose: not a failure of the machine.
  assert.equal(keystoreFailureOf(new KeyringBlockedError(), 'linux'), null);
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
    for (const code of ['KEYSTORE_BINDING', 'KEYSTORE_NO_SERVICE', 'KEYSTORE_LOCKED', 'KEYSTORE_FAILED']) {
      const clause = keystoreFailureClause(code, platform);
      assert.match(clause, /^[a-zA-Z]/);
      neverEchoes(clause);
    }
  }
});

test('credential set on a Linux server with no Secret Service says why and what to do (the reported scene)', async () => {
  const { state, openKeyring } = brokenKeystore();
  const set = await run(['credential', 'set'], { openKeyring, readStdin: () => encode(CANARY), optInEnv: {}, optInHost: { platform: 'linux' } });
  assert.equal(set.code, 2);
  const lines = set.text.split('\n');
  assert.equal(lines[0], 'refused', 'the word a script matches comes first');
  assert.match(set.text, /KEYSTORE_NO_SERVICE/);
  assert.match(set.text, /no Secret Service/);
  assert.match(set.text, /JEVRIS_CREDENTIAL_FILE/);
  assert.match(set.text, /JEVRIS_CREDENTIAL_SYSTEMD/);
  assert.match(set.text, /jevris sidecar restart/);
  assert.match(set.text, /jevris credential status/);
  assert.match(set.text, /mode 600/);
  neverEchoes(set.text);
  assert.equal(state.opens, 1);
  assert.equal(set.text.endsWith('\n'), true);
});

test('credential set names the failure for each platform and kind, from fixed text', async () => {
  const scenes = [
    ['linux', 'The Secret Service is locked', 'KEYSTORE_LOCKED', /Unlock the keyring/],
    ['linux', 'boom', 'KEYSTORE_FAILED', /JEVRIS_CREDENTIAL_FILE/],
    ['darwin', 'User interaction is not allowed', 'KEYSTORE_LOCKED', /login keychain is locked.*choose Allow/s],
    ['darwin', 'boom', 'KEYSTORE_FAILED', /macOS Keychain did not accept/],
    ['win32', 'boom', 'KEYSTORE_FAILED', /Credential Manager is per user/],
  ];
  for (const [platform, message, code, remedy] of scenes) {
    const { openKeyring } = brokenKeystore(`${message} ${CANARY}`);
    const set = await run(['credential', 'set'], { openKeyring, readStdin: () => encode(CANARY), optInEnv: {}, optInHost: { platform } });
    assert.equal(set.code, 2, platform);
    assert.equal(set.text.split('\n')[0], 'refused', platform);
    assert.match(set.text, new RegExp(code), `${platform} ${code}`);
    assert.match(set.text, remedy, `${platform} remedy`);
    if (platform !== 'linux') assert.doesNotMatch(set.text, /JEVRIS_CREDENTIAL_FILE/, `${platform} has no opt-in source`);
    neverEchoes(set.text);
  }
});

test('credential set with a key source already named points at status, not at the setup steps', async () => {
  const { openKeyring } = brokenKeystore();
  const set = await run(['credential', 'set'], {
    openKeyring,
    readStdin: () => encode(CANARY),
    optInEnv: { [CREDENTIAL_FILE_ENV]: '/somewhere/jev.key' },
    optInHost: { platform: 'linux' },
  });
  assert.equal(set.code, 2);
  assert.match(set.text, /KEYSTORE_NO_SERVICE/);
  assert.match(set.text, /already named by JEVRIS_CREDENTIAL_FILE or JEVRIS_CREDENTIAL_SYSTEMD/);
  assert.match(set.text, /jevris credential status/);
  assert.doesNotMatch(set.text, /mode 600/);
  neverEchoes(set.text);
});

test('credential set with an unusable key says so, and never opens the keystore', async () => {
  const inputs = [
    new Uint8Array(),
    encode('\n'),
    encode('two\nlines'),
    encode(`has${String.fromCharCode(0)}nul`),
    new Uint8Array(4097).fill(0x61),
    { over: true },
  ];
  for (const input of inputs) {
    const { state, openKeyring } = memoryKeystore();
    const set = await run(['credential', 'set'], { openKeyring, readStdin: () => input, optInEnv: {} });
    assert.equal(set.code, 2);
    assert.equal(set.text, `refused\n${CREDENTIAL_INPUT_REFUSED}\n`);
    assert.equal(state.opens, 0, 'nothing is asked of the keystore for a key that cannot be stored');
    assert.equal(state.value, undefined);
  }
  // A usage error stays the bare word: there is no reason to give.
  const usage = await run(['credential', 'set', CANARY], { openKeyring: memoryKeystore().openKeyring, readStdin: () => encode(CANARY), optInEnv: {} });
  assert.equal(usage.text, 'refused\n');
  assert.equal(usage.code, 2);
});

test('credential set keeps its one-line answers for a missing binding and for a good key', async () => {
  const missing = await run(['credential', 'set'], {
    openKeyring() {
      throw new KeyringUnavailableError();
    },
    readStdin: () => encode(CANARY),
    optInEnv: {},
    optInHost: { platform: 'linux' },
  });
  assert.equal(missing.code, 2);
  assert.match(missing.text, /^jevris: the OS keyring binding could not be loaded\./);
  assert.equal(missing.text.split('\n').length, 2, 'one plain line, as before');
  const { state, openKeyring } = memoryKeystore();
  const stored = await run(['credential', 'set'], { openKeyring, readStdin: () => encode(`${CANARY}\n`), optInEnv: {} });
  assert.equal(stored.code, 0);
  assert.equal(stored.text, 'present\n');
  assert.equal(state.value, CANARY);
});

test('credential set under a test-run keystore block stays the bare word', async () => {
  const set = await run(['credential', 'set'], {
    openKeyring() {
      throw new KeyringBlockedError();
    },
    readStdin: () => encode(CANARY),
    optInEnv: {},
  });
  assert.equal(set.code, 2);
  assert.equal(set.text, 'refused\n');
});

test('credential status on a working keystore prints exactly what it printed before', async () => {
  const present = await run(['credential', 'status'], { openKeyring: memoryKeystore(CANARY).openKeyring, optInEnv: {} });
  assert.deepEqual(present, { code: 0, text: 'present\n' });
  const missing = await run(['credential', 'status'], { openKeyring: memoryKeystore(undefined).openKeyring, optInEnv: {} });
  assert.deepEqual(missing, { code: 0, text: `missing\n${MISSING_LINE}\n` });
  const blocked = await run(['credential', 'status'], {
    openKeyring() {
      throw new KeyringBlockedError();
    },
    optInEnv: {},
  });
  assert.deepEqual(blocked, { code: 0, text: `missing\n${MISSING_LINE}\n` });
});

test('credential status on a server with no Secret Service says why the key is missing and what to do', async () => {
  const { openKeyring } = brokenKeystore();
  const status = await run(['credential', 'status'], { openKeyring, optInEnv: {}, optInHost: { platform: 'linux' } });
  assert.equal(status.code, 0);
  const lines = status.text.split('\n');
  assert.equal(lines[0], 'missing');
  assert.equal(lines[1], MISSING_LINE);
  assert.match(status.text, /KEYSTORE_NO_SERVICE/);
  assert.match(status.text, /JEVRIS_CREDENTIAL_FILE=\/absolute\/path\/to\/the\/file/);
  neverEchoes(status.text);
});

test('credential status reads the key file the way the sidecar does, and says which source it is', { skip: !posix }, async (t) => {
  const dir = scratch(t);
  const path = keyFile(dir);
  const { openKeyring } = brokenKeystore();
  const status = await run(['credential', 'status'], { openKeyring, optInEnv: { [CREDENTIAL_FILE_ENV]: path }, optInHost: { platform: 'linux' } });
  assert.equal(status.code, 0);
  assert.equal(status.text.split('\n')[0], 'present');
  assert.match(status.text, /^source: JEVRIS_CREDENTIAL_FILE /m);
  neverEchoes(status.text);
  assert.equal(status.text.includes(path), false, 'the path is not printed either');

  const systemd = await run(['credential', 'status'], {
    openKeyring,
    optInEnv: { [CREDENTIAL_SYSTEMD_ENV]: 'jev.key', CREDENTIALS_DIRECTORY: dir },
    optInHost: { platform: 'linux' },
  });
  assert.equal(systemd.text.split('\n')[0], 'present');
  assert.match(systemd.text, /^source: JEVRIS_CREDENTIAL_SYSTEMD /m);
  neverEchoes(systemd.text);

  // Where the keystore has a key, it wins and the file is not even named.
  const both = await run(['credential', 'status'], { openKeyring: memoryKeystore(CANARY).openKeyring, optInEnv: { [CREDENTIAL_FILE_ENV]: path }, optInHost: { platform: 'linux' } });
  assert.deepEqual(both, { code: 0, text: 'present\n' });
});

test('credential status says why a key file was refused, with its reason code and no remedy steps', { skip: !posix }, async (t) => {
  const dir = scratch(t);
  const loose = keyFile(dir, { name: 'loose.key', mode: 0o644 });
  const { openKeyring } = brokenKeystore();
  const status = await run(['credential', 'status'], { openKeyring, optInEnv: { [CREDENTIAL_FILE_ENV]: loose }, optInHost: { platform: 'linux' } });
  assert.equal(status.code, 0);
  assert.equal(status.text.split('\n')[0], 'missing');
  assert.match(status.text, /opt-in credential source was refused: the file is readable or writable by group or others \(chmod 600\)/);
  assert.match(status.text, /KEYSTORE_NO_SERVICE/);
  assert.doesNotMatch(status.text, /mode 600, in a folder/);
  neverEchoes(status.text);

  const multi = keyFile(dir, { name: 'multi.key', body: `${CANARY}\nsecond line\n` });
  const malformed = await run(['credential', 'status'], { openKeyring, optInEnv: { [CREDENTIAL_FILE_ENV]: multi }, optInHost: { platform: 'linux' } });
  assert.match(malformed.text, /the file must hold one key on one line/);
  neverEchoes(malformed.text);

  const relative = await run(['credential', 'status'], { openKeyring, optInEnv: { [CREDENTIAL_FILE_ENV]: 'jev.key' }, optInHost: { platform: 'linux' } });
  assert.match(relative.text, /the path must be absolute and normalized/);

  const both = await run(['credential', 'status'], {
    openKeyring,
    optInEnv: { [CREDENTIAL_FILE_ENV]: loose, [CREDENTIAL_SYSTEMD_ENV]: 'jev.key' },
    optInHost: { platform: 'linux' },
  });
  assert.match(both.text, /set only one of JEVRIS_CREDENTIAL_FILE and JEVRIS_CREDENTIAL_SYSTEMD/);
});

test('credential status on Windows refuses the opt-in source and keeps the Credential Manager remedy', async () => {
  const { openKeyring } = brokenKeystore('boom');
  const status = await run(['credential', 'status'], {
    openKeyring,
    optInEnv: { [CREDENTIAL_FILE_ENV]: '/somewhere/jev.key' },
    optInHost: { platform: 'win32' },
  });
  assert.equal(status.code, 0);
  // Which rule refuses it depends on the host's path rules (a POSIX path is not absolute on a Windows host); that it is refused does not.
  assert.match(status.text, /opt-in credential source was refused: (the opt-in source is for Linux|the path must be absolute)/);
  assert.match(status.text, /Windows Credential Manager did not accept/);
  assert.doesNotMatch(status.text, /JEVRIS_CREDENTIAL_FILE=/);
  neverEchoes(status.text);
});

test('credential clear says when nothing could be removed, and that a key file is the user to remove', async (t) => {
  const { openKeyring } = brokenKeystore();
  const failed = await run(['credential', 'clear'], { openKeyring, optInEnv: {}, optInHost: { platform: 'linux' } });
  assert.equal(failed.code, 0);
  assert.equal(failed.text.split('\n')[0], 'missing');
  assert.match(failed.text, /nothing was removed: no Secret Service/);
  neverEchoes(failed.text);

  const blocked = await run(['credential', 'clear'], {
    openKeyring() {
      throw new KeyringBlockedError();
    },
    optInEnv: {},
  });
  assert.deepEqual(blocked, { code: 0, text: `missing\n${MISSING_LINE}\n` });

  if (!posix) return;
  const dir = scratch(t);
  const path = keyFile(dir);
  const { state, openKeyring: memory } = memoryKeystore(CANARY);
  const cleared = await run(['credential', 'clear'], { openKeyring: memory, optInEnv: { [CREDENTIAL_FILE_ENV]: path }, optInHost: { platform: 'linux' } });
  assert.equal(state.value, undefined);
  // The file still supplies the key, and clear says Jevris does not own it.
  assert.equal(cleared.text.split('\n')[0], 'present');
  assert.match(cleared.text, /source: JEVRIS_CREDENTIAL_FILE/);
  assert.match(cleared.text, /Jevris never deletes that file/);
  neverEchoes(cleared.text);
  assert.equal(readFileSync(path, 'utf8'), `${CANARY}\n`, 'the file is untouched');
});

test('the resolver carries a closed failure code and no message', async () => {
  const thrown = await resolveProviderCredential(brokenKeystore(`${NO_SERVICE_MESSAGE} ${CANARY}`).openKeyring, { optInHost: { platform: 'linux' } });
  assert.equal(thrown.mode, 'rules-only');
  assert.equal(thrown.keystoreFailure, 'KEYSTORE_NO_SERVICE');
  assert.equal(thrown.diagnostic, MISSING_LINE);
  assert.equal(JSON.stringify(thrown).includes(CANARY), false);
  assert.equal(JSON.stringify(thrown).includes('org.freedesktop'), false);

  const healthy = await resolveProviderCredential(memoryKeystore(undefined).openKeyring, {});
  assert.equal(healthy.mode, 'rules-only');
  assert.equal('keystoreFailure' in healthy, false, 'an empty working keystore is not a failure');

  const blocked = await resolveProviderCredential(
    () => {
      throw new KeyringBlockedError();
    },
    {},
  );
  assert.equal('keystoreFailure' in blocked, false, 'a test-run block is not a failure');

  // The installer name is still not consulted after a keystore failure.
  const withInstaller = await resolveProviderCredential(brokenKeystore().openKeyring, {
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    readEnv: () => CANARY,
  });
  assert.equal(withInstaller.mode, 'rules-only');
  assert.equal('apiKey' in withInstaller, false);
});

test('the report matches what the resolver finds, for every source', { skip: !posix }, async (t) => {
  const dir = scratch(t);
  const path = keyFile(dir);
  const host = { platform: 'linux' };
  const cases = [
    [memoryKeystore(CANARY).openKeyring, {}, { presence: 'present', source: 'keychain' }],
    [memoryKeystore(undefined).openKeyring, {}, { presence: 'missing', source: null }],
    [memoryKeystore(undefined).openKeyring, { [CREDENTIAL_FILE_ENV]: path }, { presence: 'present', source: 'file' }],
    [brokenKeystore().openKeyring, { [CREDENTIAL_FILE_ENV]: path }, { presence: 'present', source: 'file' }],
    [brokenKeystore().openKeyring, {}, { presence: 'missing', source: null, keystoreFailure: 'KEYSTORE_NO_SERVICE' }],
  ];
  for (const [open, env, expected] of cases) {
    const report = await credentialReport(open, { optInEnv: env, optInHost: host });
    for (const [key, value] of Object.entries(expected)) assert.equal(report[key], value, `${JSON.stringify(env)} ${key}`);
    assert.equal(JSON.stringify(report).includes(CANARY), false);
  }
});

test('the opt-in variables come from the environment, and none under a test run', () => {
  const env = {
    [CREDENTIAL_FILE_ENV]: '/a/b',
    [CREDENTIAL_SYSTEMD_ENV]: 'jev',
    CREDENTIALS_DIRECTORY: '/c',
    TYPESAFE_API_KEY: CANARY,
    PATH: '/usr/bin',
  };
  assert.deepEqual(optInEnvOf({ ...env, JEVRIS_TEST: '1' }), {});
  assert.deepEqual(optInEnvOf({ ...env, NODE_TEST_CONTEXT: 'child-v8' }), {});
  const read = optInEnvOf(env);
  assert.deepEqual(Object.keys(read).sort(), ['CREDENTIALS_DIRECTORY', CREDENTIAL_FILE_ENV, CREDENTIAL_SYSTEMD_ENV].sort());
  assert.equal(JSON.stringify(read).includes(CANARY), false, 'no key variable is read');
});

test('the sidecar status advice keeps its plain text and says more only where that text would be a dead end', () => {
  assert.equal(noCredentialAdvice({}), 'No Jev credential is configured; decisions run rules-only. Run `jevris credential set`.');
  const linux = noCredentialAdvice({ keystoreFailure: 'KEYSTORE_NO_SERVICE', platform: 'linux' });
  assert.match(linux, /KEYSTORE_NO_SERVICE/);
  assert.match(linux, /JEVRIS_CREDENTIAL_FILE/);
  assert.match(linux, /jevris sidecar restart/);
  assert.doesNotMatch(linux, /Run `jevris credential set`\.$/, 'a machine with no keyring is not told to run the command that cannot work');
  const mac = noCredentialAdvice({ keystoreFailure: 'KEYSTORE_LOCKED', platform: 'darwin' });
  assert.match(mac, /login keychain is locked/);
  assert.match(mac, /jevris credential set/);
  assert.doesNotMatch(mac, /JEVRIS_CREDENTIAL_FILE/);
  const refused = noCredentialAdvice({ optInRefused: 'group-or-world-access', keystoreFailure: 'KEYSTORE_NO_SERVICE', platform: 'linux' });
  assert.match(refused, /group-or-world-access/);
  assert.match(refused, /chmod 600/);
  assert.match(refused, /jevris sidecar restart/);
  for (const text of [linux, mac, refused]) {
    assert.ok(text.length < 400, 'one status line');
    assert.equal(text.includes('\n'), false);
  }
});

test('the status lines are empty where the keystore works, and the set lines name the code', () => {
  const working = { presence: 'missing', source: null, keystoreFailure: null, optInConfigured: false, optInRefused: null };
  assert.deepEqual(credentialStatusLines(working, 'linux'), []);
  assert.deepEqual(credentialStatusLines({ ...working, presence: 'present', source: 'keychain' }, 'linux'), []);
  for (const code of ['KEYSTORE_BINDING', 'KEYSTORE_NO_SERVICE', 'KEYSTORE_LOCKED', 'KEYSTORE_FAILED']) {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const lines = credentialSetRefusalLines(code, platform);
      assert.match(lines[0], new RegExp(`\\(${code}\\)\\.$`));
      assert.ok(lines.length >= 2, 'a reason and a way out');
    }
  }
});

test('doctor says nothing without an opt-in source, and never reads the key', { skip: !posix }, async (t) => {
  assert.deepEqual(await credentialSourceDoctorLines({}), []);
  assert.deepEqual(await credentialSourceDoctorLines(optInEnvOf({ [CREDENTIAL_FILE_ENV]: '/x', JEVRIS_TEST: '1' })), [], 'none under a test run');
  const dir = scratch(t);
  const good = keyFile(dir);
  const ok = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: good });
  assert.equal(ok.length, 1);
  assert.match(ok[0], /^credentialSource: JEVRIS_CREDENTIAL_FILE passes the owner-only checks/);
  assert.equal(doctorLineSeverity(ok[0]), 'ok');
  assert.equal(ok[0].includes(good), false, 'the path is not printed');

  // A body doctor would reject if it read it: the checks that need no contents still pass.
  const unread = keyFile(dir, { name: 'unread.key', body: 'one\ntwo\n' });
  const passes = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: unread });
  assert.match(passes[0], /passes the owner-only checks/);
  assert.deepEqual(await inspectOptInSource(optInSourceOf({ [CREDENTIAL_FILE_ENV]: unread })), { ok: true });

  const loose = keyFile(dir, { name: 'loose.key', mode: 0o644 });
  const refused = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: loose });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^credentialSource: refused \(group-or-world-access\): .*chmod 600/);
  assert.match(refused[0], /jevris sidecar restart/);
  assert.equal(doctorLineSeverity(refused[0]), 'action');
  assert.equal(refused[0].includes(CANARY), false);

  const both = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: good, [CREDENTIAL_SYSTEMD_ENV]: 'jev' });
  assert.match(both[0], /refused \(both-set\)/);
  const relative = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: 'jev.key' });
  assert.match(relative[0], /refused \(not-absolute\)/);
  const missing = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: join(dir, 'absent.key') });
  assert.match(missing[0], /refused \(unreadable\)/);
});

test('doctor refuses the opt-in source on Windows', async () => {
  const lines = await credentialSourceDoctorLines({ [CREDENTIAL_FILE_ENV]: 'C:\\keys\\jev.key' }, { platform: 'win32' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^credentialSource: refused \(unsupported-platform\)|^credentialSource: refused \(not-absolute\)/);
  assert.equal(doctorLineSeverity(lines[0]), 'action');
});

test('the docs the messages lean on exist, and say the same steps', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const security = readFileSync(join(root, 'docs', 'security.md'), 'utf8');
  assert.match(security, /^### Headless machines: the opt-in key file$/m);
  const troubleshooting = readFileSync(join(root, 'docs', 'troubleshooting.md'), 'utf8');
  assert.match(troubleshooting, /^## The keychain is unavailable$/m);
  for (const name of ['KEYSTORE_NO_SERVICE', 'KEYSTORE_LOCKED', 'KEYSTORE_FAILED', 'KEYSTORE_BINDING']) {
    assert.ok(troubleshooting.includes(name), `troubleshooting.md explains ${name}`);
  }
});
