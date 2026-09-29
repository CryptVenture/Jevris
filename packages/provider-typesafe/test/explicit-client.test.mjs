import test from 'node:test';
import assert from 'node:assert/strict';

const { explicitClientConfig } = await import('../dist/index.js');

const FIELDS = {
  apiKey: 'fixture-key',
  baseURL: 'https://api.typesafe.ai',
  defaultModel: 'jev-1.13.0',
  logLevel: 'warn',
};

test('explicitClientConfig returns only the four client fields', () => {
  assert.equal(typeof explicitClientConfig, 'function');
  const fields = explicitClientConfig(FIELDS);
  assert.deepEqual(Object.keys(fields).sort(), ['apiKey', 'baseURL', 'defaultModel', 'logLevel']);
  assert.equal(fields.apiKey, 'fixture-key');
  assert.equal(fields.baseURL, 'https://api.typesafe.ai');
  assert.equal(fields.defaultModel, 'jev-1.13.0');
  assert.equal(fields.logLevel, 'warn');
});

test('omitting apiKey does not call fetch or read the ambient variable', () => {
  assert.equal(typeof explicitClientConfig, 'function');
  let fetches = 0;
  const ambient = 'TYPESAFE_API_KEY';
  const previous = process.env[ambient];
  process.env[ambient] = 'CANARY_AMBIENT_do_not_use';
  try {
    assert.throws(
      () =>
        explicitClientConfig({
          baseURL: FIELDS.baseURL,
          defaultModel: FIELDS.defaultModel,
          logLevel: FIELDS.logLevel,
          fetch() {
            fetches += 1;
          },
        }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal(String(error.message).includes('CANARY_AMBIENT_do_not_use'), false);
        assert.equal(String(error.message).includes(ambient), false);
        return true;
      },
    );
    assert.equal(fetches, 0);
  } finally {
    if (previous === undefined) delete process.env[ambient];
    else process.env[ambient] = previous;
  }
});

test('the production SDK transport never reads the ambient key and makes exactly one attempt per call', async () => {
  const { createSdkTransport, createMockFetch, CONFORMANCE_REQUEST } = await import('../dist/index.js');
  const ambient = 'TYPESAFE_API_KEY';
  const previous = process.env[ambient];
  process.env[ambient] = 'CANARY_AMBIENT_do_not_use';
  try {
    const fetch = createMockFetch({ scenario: 'http-500' });
    const seen = [];
    const transport = createSdkTransport({
      apiKey: 'fixture-key',
      fetch: async (url, init) => {
        seen.push(new Headers(init?.headers ?? {}).get('authorization'));
        return fetch(url, init);
      },
    });
    const result = await transport.call(CONFORMANCE_REQUEST, { timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'server');
    assert.equal(seen.length, 1, 'SDK retries are off; the engine owns retries');
    assert.equal(seen[0], 'Bearer fixture-key');
    assert.equal(seen.some((value) => String(value).includes('CANARY')), false);
  } finally {
    if (previous === undefined) delete process.env[ambient];
    else process.env[ambient] = previous;
  }
});
