import test from 'node:test';
import assert from 'node:assert/strict';


const { main } = await import('../dist/cli.js');
const {
  assertNoProviderKey,
  credentialStatus,
  emitCredentialStatus,
  readCappedStdin,
  readHiddenLine,
  resolveProviderCredential,
  setHostSecret,
  toHarnessView,
} = await import('../dist/credential.js');

const CANARY = 'CANARY_SECRET_do_not_print';

const MISSING_LINE = 'API credential is missing. Coding continues without a remote call.';

function memoryKeyring() {
  const state = {
    value: undefined,
    sets: [],
    deletes: 0,
    opens: [],
  };
  function openKeyring(service, account) {
    state.opens.push({ service, account });
    return {
      set(value) {
        state.sets.push(value);
        state.value = value;
      },
      get() {
        return state.value;
      },
      delete() {
        state.deletes += 1;
        state.value = undefined;
      },
    };
  }
  return { state, openKeyring };
}

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

test('credential set stores stdin only and status does not echo the value', async () => {
  const { state, openKeyring } = memoryKeyring();
  const set = await run(['credential', 'set'], {
    openKeyring,
    readStdin: () => encode(CANARY),
  });
  assert.equal(set.code, 0);
  assert.equal(set.text, 'present\n');
  assert.equal(set.text.includes(CANARY), false);
  assert.equal(state.sets.length, 1);
  assert.equal(state.sets[0], CANARY);
  assert.equal(state.opens[0].service, 'jevris');
  assert.equal(state.opens[0].account, 'typesafe-primary');

  const status = await run(['credential', 'status'], { openKeyring });
  assert.equal(status.code, 0);
  assert.equal(status.text, 'present\n');
  assert.equal(status.text.includes(CANARY), false);
});

test('a secret positional is refused and does not write the keyring', async () => {
  const { state, openKeyring } = memoryKeyring();
  const refused = await run(['credential', 'set', CANARY], {
    openKeyring,
    readStdin: () => encode(CANARY),
  });
  assert.equal(refused.code, 2);
  assert.equal(refused.text, 'refused\n');
  assert.equal(refused.text.includes(CANARY), false);
  assert.equal(state.sets.length, 0);
  assert.equal(state.opens.length, 0);
});

test('harness view built from status has no secret field', async () => {
  const { openKeyring } = memoryKeyring();
  await setHostSecret(encode(CANARY), openKeyring);
  const status = await credentialStatus(openKeyring);
  const view = toHarnessView(status);
  assert.equal(status.presence, 'present');
  assert.equal(status.diagnostic, null);
  for (const name of ['apiKey', 'token', 'secret', 'secretText', 'password']) {
    assert.equal(Object.hasOwn(status, name), false);
    assert.equal(Object.hasOwn(view, name), false);
  }
  assert.equal(assertNoProviderKey(view), true);
  assert.equal(assertNoProviderKey({ apiKey: CANARY }), false);
  let printed = '';
  const code = emitCredentialStatus({ presence: 'present', diagnostic: null, apiKey: CANARY }, (chunk) => {
    printed += chunk;
  });
  assert.equal(code, 2);
  assert.equal(printed, 'refused\n');
  assert.equal(printed.includes(CANARY), false);
});

test('resolveProviderCredential returns the four client fields and does not fetch', async () => {
  const { openKeyring } = memoryKeyring();
  const stored = await setHostSecret(encode(`${CANARY}\n`), openKeyring);
  assert.equal(stored, 'present');
  let fetches = 0;
  const resolved = await resolveProviderCredential(openKeyring, {
    fetch() {
      fetches += 1;
      return Promise.reject(new Error('fetch'));
    },
  });
  assert.equal(fetches, 0);
  assert.equal(resolved.apiKey, CANARY);
  assert.equal(resolved.baseURL, 'https://api.typesafe.ai');
  assert.equal(resolved.defaultModel, 'jev-1.13.0');
  assert.equal(resolved.logLevel, 'warn');
  assert.deepEqual(Object.keys(resolved).sort(), ['apiKey', 'baseURL', 'defaultModel', 'logLevel']);
});

test('empty, embedded carriage return, NUL, and over-cap stdin are not stored', async () => {
  const { state, openKeyring } = memoryKeyring();
  assert.equal(await setHostSecret(encode(''), openKeyring), 'refused');
  assert.equal(await setHostSecret(encode(`CA\rNARY`), openKeyring), 'refused');
  assert.equal(await setHostSecret(encode(`${CANARY}\u0000`), openKeyring), 'refused');
  assert.equal(state.sets.length, 0);

  const over = await readCappedStdin(
    (async function* overCap() {
      yield new Uint8Array(4097);
    })(),
  );
  assert.deepEqual(over, { over: true });
  assert.equal(Object.hasOwn(over, 'bytes'), false);

  const exact = await readCappedStdin(
    (async function* atCap() {
      yield encode('a'.repeat(4096));
    })(),
  );
  assert.equal(exact instanceof Uint8Array, true);
  assert.equal(exact.byteLength, 4096);
});

test('a trailing carriage return or CRLF is not part of the secret', async () => {
  const { state, openKeyring } = memoryKeyring();
  assert.equal(await setHostSecret(encode(`${CANARY}\r`), openKeyring), 'present');
  assert.equal(await setHostSecret(encode(`${CANARY}\r\n`), openKeyring), 'present');
  assert.equal(state.sets[0], CANARY);
  assert.equal(state.sets[1], CANARY);
});

test('hidden line reads until enter and does not echo the secret', async () => {
  const listeners = [];
  let raw = true;
  let prompted = '';
  const input = {
    setRawMode(mode) {
      raw = mode;
    },
    resume() {
      const chunk = encode(`${CANARY}\r`);
      for (const listener of listeners) listener(chunk);
    },
    pause() {},
    on(_event, listener) {
      listeners.push(listener);
    },
    off(_event, listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const bytes = await readHiddenLine(input, (text) => {
    prompted += text;
  });
  assert.equal(Buffer.from(bytes).toString('utf8'), CANARY);
  assert.equal(prompted.includes(CANARY), false);
  assert.equal(prompted, 'API key: \n');
  assert.equal(raw, false);
});

test('credential clear deletes the entry and prints the missing diagnostic', async () => {
  const { state, openKeyring } = memoryKeyring();
  await run(['credential', 'set'], {
    openKeyring,
    readStdin: () => encode(CANARY),
  });
  const cleared = await run(['credential', 'clear'], { openKeyring });
  assert.equal(cleared.code, 0);
  assert.equal(cleared.text, `missing\n${MISSING_LINE}\n`);
  assert.equal(cleared.text.includes(CANARY), false);
  assert.equal(state.deletes, 1);
  assert.equal(state.value, undefined);
  assert.equal(state.opens.at(-1).service, 'jevris');
  assert.equal(state.opens.at(-1).account, 'typesafe-primary');
});

test('a thrown keyring get or loader stays rules-only and does not fetch', async () => {
  let fetches = 0;
  const trackingFetch = () => {
    fetches += 1;
  };
  const thrownGet = await resolveProviderCredential(
    () => ({
      get() {
        throw new Error(`locked ${CANARY}`);
      },
      set() {},
      delete() {},
    }),
    { fetch: trackingFetch },
  );
  assert.equal(fetches, 0);
  assert.equal(thrownGet.mode, 'rules-only');
  assert.equal(thrownGet.diagnostic, MISSING_LINE);
  assert.equal(Object.hasOwn(thrownGet, 'apiKey'), false);
  assert.equal(JSON.stringify(thrownGet).includes(CANARY), false);

  const thrownLoad = await resolveProviderCredential(
    () => {
      throw new Error(`binding ${CANARY}`);
    },
    { fetch: trackingFetch },
  );
  assert.equal(fetches, 0);
  assert.equal(thrownLoad.mode, 'rules-only');
  assert.equal(thrownLoad.diagnostic, MISSING_LINE);
  assert.equal(JSON.stringify(thrownLoad).includes(CANARY), false);
});

test('an absent entry can use the installer name and cannot use the ambient name', async () => {
  const { openKeyring } = memoryKeyring();
  const reads = [];
  const installed = await resolveProviderCredential(openKeyring, {
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    readEnv(name) {
      reads.push(name);
      return 'installer-secret-value';
    },
    fetch() {
      throw new Error('fetch');
    },
  });
  assert.deepEqual(reads, ['JEVRIS_INSTALLER_KEY']);
  assert.equal(installed.apiKey, 'installer-secret-value');
  assert.equal(installed.baseURL, 'https://api.typesafe.ai');
  assert.equal(installed.defaultModel, 'jev-1.13.0');
  assert.equal(installed.logLevel, 'warn');

  await setHostSecret(encode(CANARY), openKeyring);
  const presentReads = [];
  const present = await resolveProviderCredential(openKeyring, {
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    readEnv(name) {
      presentReads.push(name);
      return 'installer-secret-value';
    },
  });
  assert.deepEqual(presentReads, []);
  assert.equal(present.apiKey, CANARY);

  const ambientReads = [];
  const absent = memoryKeyring();
  const denied = await resolveProviderCredential(absent.openKeyring, {
    installerEnvName: 'TYPESAFE_API_KEY',
    readEnv(name) {
      ambientReads.push(name);
      return 'CANARY_AMBIENT_do_not_use';
    },
  });
  assert.deepEqual(ambientReads, []);
  assert.equal(denied.mode, 'rules-only');
  assert.equal(denied.diagnostic, MISSING_LINE);
  assert.equal(JSON.stringify(denied).includes('CANARY_AMBIENT_do_not_use'), false);
  assert.equal(denied.diagnostic.includes('TYPESAFE_API_KEY'), false);
});

test('hook and mcp carry objects have only the credential ref and presence', async () => {
  const contracts = await import('@jevris/contracts');
  const hook = contracts.hookCredentialCarry('present');
  const mcp = contracts.mcpCredentialArguments('missing');
  assert.deepEqual(Object.keys(hook).sort(), ['credentialRef', 'presence']);
  assert.deepEqual(Object.keys(mcp).sort(), ['credentialRef', 'presence']);
  assert.equal(hook.credentialRef, 'host-secret:typesafe-primary');
  assert.equal(mcp.credentialRef, 'host-secret:typesafe-primary');
  assert.equal(Object.hasOwn(hook, 'apiKey'), false);
  assert.equal(Object.hasOwn(mcp, 'apiKey'), false);
  assert.equal(assertNoProviderKey(hook), true);
  assert.equal(assertNoProviderKey(mcp), true);
  const status = toHarnessView({ presence: 'missing', diagnostic: MISSING_LINE });
  assert.equal(Object.hasOwn(status, 'apiKey'), false);
});
