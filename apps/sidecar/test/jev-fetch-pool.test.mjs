// The sidecar's Jev requests go over the provider's keep-alive pool (`nodeFetch`: node:https, a socket per request),
// not the global fetch. Measured live (2026-10-03, 2026-10-04): the global fetch negotiates HTTP/2 with api.typesafe.ai
// and then sends concurrent requests to it one at a time, so four sessions routing together took 201, 389, 573 and
// 776 ms where four sockets took 240 ms each, and a quarter to half of them passed the 700 ms wait and lost their Jev
// answer to the rules. The provider's transport used the pool when it was left to choose its fetch, but the sidecar
// handed it the global fetch wrapped in the egress guard, so the pool never carried a sidecar request.
// The HTTP/2 queueing cannot be reproduced on a loopback http server, so this pins what the sidecar sends: a request
// that arrives with none of the headers the global fetch adds (`sec-fetch-mode`, `accept-language`) and several at once
// on their own sockets. The egress guard stays in front of the pool (egress-guard.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackEngine } from '../../../packages/provider-typesafe/test/engine-settle.mjs';

const { openRuntimeState } = await import('../dist/state.js');
const { jevrisPaths } = await import('@jevris/platform');
const provider = await import('@jevris/provider-typesafe');
const core = await import('@jevris/core');

const TEST_KEY = 'mock-provider-test-key';

/** A loopback Jev: answers with the conformance mock once `barrier` requests are open at once, and records what arrived. */
async function loopbackJev(t, barrier) {
  const mock = provider.createMockFetch({ scenario: 'valid' });
  const seen = { headers: [], bodies: 0, inFlight: 0, peak: 0 };
  const waiting = [];
  const server = createServer((req, res) => {
    seen.inFlight += 1;
    seen.peak = Math.max(seen.peak, seen.inFlight);
    res.on('close', () => {
      seen.inFlight -= 1;
    });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.headers.push(req.headers);
      seen.bodies += 1;
      waiting.push({ req, res, body: Buffer.concat(chunks).toString('utf8') });
      const release = async () => {
        for (const w of waiting.splice(0)) {
          const headers = {};
          for (const [name, value] of Object.entries(w.req.headers)) if (typeof value === 'string') headers[name] = value;
          const answer = await mock(`https://api.typesafe.ai${w.req.url}`, { method: w.req.method, headers, body: w.body });
          const sent = {};
          answer.headers.forEach((value, name) => (sent[name] = value));
          w.res.writeHead(answer.status, sent);
          w.res.end(Buffer.from(await answer.arrayBuffer()));
        }
      };
      if (seen.inFlight >= barrier) void release();
      else setTimeout(() => void release(), 20_000).unref();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function request(n) {
  const compiled = core.compileDecisionSpec({ id: 'task-profile', version: 'v1', questions: provider.CONFORMANCE_REQUEST.questions, evidenceRequirements: ['e1'], deadlineMs: 60_000, fallback: 'rules-only' });
  return {
    spec: compiled.spec,
    questions: provider.CONFORMANCE_REQUEST.questions,
    workspaceId: 'w-pool',
    evidenceRevision: 'rev-1',
    packet: {
      objective: 'Add an optional display label to an existing response',
      trustedPolicy: { compatibilityRequired: true },
      facts: { publicApiChanged: n % 2 === 0, migrationPresent: n >= 2 },
      evidence: [{ id: 'e1', text: 'Existing consumers deserialize this response.', sourceKind: 'file', priority: 'mandatory' }],
      missingEvidence: [],
    },
  };
}

test('the sidecar sends Jev requests through the provider pool, not the global fetch, and several at once on their own sockets', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-fetch-pool-')));
  const { url, seen } = await loopbackJev(t, 3);
  const before = { url: process.env.JEVRIS_TEST_PROVIDER_URL, key: process.env.JEVRIS_TEST_PROVIDER_KEY };
  process.env.JEVRIS_TEST_PROVIDER_URL = url;
  process.env.JEVRIS_TEST_PROVIDER_KEY = TEST_KEY;
  const state = await openRuntimeState({ home, paths: jevrisPaths({ home }), log: () => undefined, openStore: false, modelOffer: false, liveCertification: false, accessResumeMs: 0, jevConnection: false });
  const tracker = trackEngine(state.engine);
  t.after(async () => {
    if (before.url === undefined) delete process.env.JEVRIS_TEST_PROVIDER_URL;
    else process.env.JEVRIS_TEST_PROVIDER_URL = before.url;
    if (before.key === undefined) delete process.env.JEVRIS_TEST_PROVIDER_KEY;
    else process.env.JEVRIS_TEST_PROVIDER_KEY = before.key;
    await tracker.settled();
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(state.engine.providerConfigured, true, 'the test provider stands in for the key');
  // Three requests whose packets differ (so the decision cache cannot answer them), all open at once.
  const outcomes = await Promise.all([0, 1, 2].map((n) => state.engine.decide(request(n))));
  assert.deepEqual(outcomes.map((o) => o.abstained), [false, false, false], JSON.stringify(outcomes));
  assert.equal(seen.peak, 3, `the loopback Jev saw ${seen.peak} requests open at once`);
  assert.equal(seen.headers.length, 3);
  for (const headers of seen.headers) {
    assert.equal(headers['sec-fetch-mode'], undefined, 'the global fetch (undici) adds this header; the pool does not');
    assert.equal(headers['accept-language'], undefined);
    assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  }
});
