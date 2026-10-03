// Review of the privacy wording (item 4): with source egress not approved the evidence text never
// leaves, and each item goes as bounded structured features: a span id, the source kind, a category,
// a character count and a digest salted per engine. The span id was an unsalted hash prefix of the
// evidence id and text, so a common error line could be dictionary-matched from the span (the text
// itself was never sent). It is now salted with the engine's per-process salt, like the digest.
// With egress approved the span stays the stable id Jev chooses by (the text is sent anyway), and
// without a salt (a direct use of the builder) it is as it was. Mock fetch, temporary homes, no live call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { createSidecarEngine, createMockFetch, CONFORMANCE_REQUEST } = provider;

const COMMON_LINE = 'TypeError: Cannot read properties of undefined (reading \'map\')';
const LIMITS = core.DEFAULT_PACKET_LIMITS;

function input(text = COMMON_LINE) {
  return {
    objective: 'Classify the repeated failure.', trustedPolicy: { capability: 'recover' }, facts: { attempts: 3 },
    evidence: [{ id: 'failure', text, sourceKind: 'tool', priority: 'mandatory', category: 'failure-output' }],
  };
}

test('the packet builder: a withheld span depends on the engine salt; the digest still does; the span keeps its shape', () => {
  const span = (salt) => core.buildPacket(input(), LIMITS, { sourceEgress: 'denied', ...(salt === undefined ? {} : { salt }) }).state.withheldEvidence[0].span;
  assert.match(span('engine-salt-a'), /^s[0-9a-f]{12}$/, 'the same shape as before');
  assert.equal(span('engine-salt-a'), span('engine-salt-a'), 'stable inside one engine');
  assert.notEqual(span('engine-salt-a'), span('engine-salt-b'), 'another engine, another span');
  assert.notEqual(span('engine-salt-a'), core.spanId('failure', COMMON_LINE), 'it is not the unsalted hash of the id and the text: a dictionary of common error lines does not match it');
  assert.equal(span(undefined), core.spanId('failure', COMMON_LINE), 'a direct use of the builder with no salt is as it was');
});

test('the span map the builder returns agrees with what it sends, and the packet hash still tells equal evidence from different', () => {
  const salt = 'engine-salt-a';
  const a = core.buildPacket(input(), LIMITS, { sourceEgress: 'denied', salt });
  const b = core.buildPacket(input(), LIMITS, { sourceEgress: 'denied', salt });
  const other = core.buildPacket(input('a different line'), LIMITS, { sourceEgress: 'denied', salt });
  assert.equal(a.ok && b.ok && other.ok, true);
  assert.equal(a.spans.failure, a.state.withheldEvidence[0].span, 'the map names the span that is sent');
  assert.equal(a.packetHash, b.packetHash, 'equal evidence in one engine: equal packet, so the decision cache still answers');
  assert.notEqual(a.packetHash, other.packetHash);
});

test('with egress approved the span is the stable unsalted id Jev chooses by, whatever the salt', () => {
  const approved = (salt) => core.buildPacket(input(), LIMITS, { sourceEgress: 'approved', salt });
  assert.equal(approved('engine-salt-a').state.untrustedEvidence[0].span, core.spanId('failure', COMMON_LINE));
  assert.equal(approved('engine-salt-b').state.untrustedEvidence[0].span, core.spanId('failure', COMMON_LINE));
  assert.equal(approved('engine-salt-a').spans.failure, core.spanId('failure', COMMON_LINE));
});

// ---------------------------------------------------------------- through the engine

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-span-salt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(text) {
  const compiled = core.compileDecisionSpec({ id: 'recover-loop', version: 'v1', questions: CONFORMANCE_REQUEST.questions, evidenceRequirements: ['failure'], deadlineMs: 60_000, fallback: 'rules-only' });
  return { spec: compiled.spec, questions: CONFORMANCE_REQUEST.questions, workspaceId: 'w-span-salt', evidenceRevision: 'rev-1', packet: input(text) };
}

async function sentState(t, egress, text = COMMON_LINE) {
  const bodies = [];
  const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: createMockFetch({ onRequest: (body) => bodies.push(JSON.stringify(body)) }), env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress }) });
  const outcome = await core.decide(request(text), engine);
  assert.equal(outcome.abstained, false, JSON.stringify(outcome));
  return { state: JSON.parse(bodies[0]).state, body: bodies[0], engine };
}

test('through the engine, with egress denied, the request carries a salted span: no dictionary hash of an error line, and no text', async (t) => {
  const first = await sentState(t, 'deny-until-approved');
  const second = await sentState(t, 'deny-until-approved');
  const [span] = first.state.withheldEvidence.map((w) => w.span);
  assert.notEqual(span, core.spanId('failure', COMMON_LINE), 'the span is not the unsalted hash of a common error line');
  assert.equal(first.body.includes(core.spanId('failure', COMMON_LINE)), false, 'and that hash appears nowhere in the request');
  assert.equal(first.body.includes('TypeError'), false);
  assert.match(first.state.withheldEvidence[0].digest, /^h[0-9a-f]{16}$/);
  assert.notEqual(span, second.state.withheldEvidence[0].span, 'another engine process has another salt, so the span cannot be matched across processes either');
  assert.equal(first.state.withheldEvidence[0].characters, COMMON_LINE.length);
});

test('through the engine, with egress approved, the span is the stable one and the text is sent', async (t) => {
  const sent = await sentState(t, 'approved-scoped');
  assert.equal(sent.state.untrustedEvidence[0].span, core.spanId('failure', COMMON_LINE));
  assert.deepEqual(sent.state.withheldEvidence, []);
});

test('one engine, the same evidence twice: the same span, so a repeated question is answered from the decision cache', async (t) => {
  const bodies = [];
  const engine = await createSidecarEngine({ home: home(t), credential: 'test-key-not-a-secret', fetch: createMockFetch({ onRequest: (body) => bodies.push(JSON.stringify(body)) }), env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: 'deny-until-approved' }) });
  const one = await core.decide(request(COMMON_LINE), engine);
  const two = await core.decide(request(COMMON_LINE), engine);
  assert.deepEqual([one.abstained, two.abstained], [false, false]);
  assert.equal(bodies.length, 1, 'the second decision made no provider call');
  assert.ok((await engine.lookup(two.decisionId)).reasonCodes.includes('CACHE_HIT'));
});
