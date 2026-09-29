// The route.turn answer (OD-8, f294e43; with C): a Kilo or OpenCode main-session turn is switched
// only under plugin-bounded-auto, `switched` equals `actuate`, and an actuated turn names its model.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');

const base = {
  harness: 'kilocode',
  mainSession: { mode: 'plugin-bounded-auto', switched: true },
  outcome: 'switch',
  actuate: true,
  reasonCode: 'ROUTE_SWITCH',
  model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
  variant: 'high',
  text: 'This turn runs on Sonnet 5: a bounded edit, and Opus 5.5 would cost more for the same result.',
};
const codes = (value) => {
  const r = c.RouteTurnPayloadContract.validate(value);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

test('a switched turn, an advised switch and an abstention are valid', () => {
  assert.deepEqual(codes(base), []);
  assert.deepEqual(codes({ ...base, harness: 'opencode', model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-5' }, variant: null }), []);
  assert.deepEqual(codes({ ...base, mainSession: { mode: 'advice-only', switched: false }, actuate: false }), [], 'advice names the model and changes nothing');
  const { model, variant, ...rest } = base;
  assert.deepEqual(codes({ ...rest, outcome: 'abstain', actuate: false, mainSession: { mode: 'plugin-bounded-auto', switched: false }, reasonCode: 'PIN_RESPECTED' }), []);
  assert.deepEqual([...c.MAIN_SESSION_MODES], ['advice-only', 'plugin-bounded-auto', 'owned-sdk-approved']);
});

test('only plugin-bounded-auto actuates, switched is actuate, and a switch names its model', () => {
  assert.ok(codes({ ...base, mainSession: { mode: 'advice-only', switched: true } }).includes('MODE_DOES_NOT_ACTUATE'));
  assert.ok(codes({ ...base, mainSession: { mode: 'owned-sdk-approved', switched: true } }).includes('MODE_DOES_NOT_ACTUATE'));
  assert.ok(codes({ ...base, mainSession: { mode: 'plugin-bounded-auto', switched: false } }).includes('SWITCHED_NOT_ACTUATE'));
  const { model, ...noModel } = base;
  assert.ok(codes(noModel).includes('SWITCH_WITHOUT_MODEL'));
  assert.ok(codes({ ...base, outcome: 'abstain' }).includes('ACTUATE_WITHOUT_SWITCH'));
  assert.ok(codes({ ...base, outcome: 'abstain', actuate: false, mainSession: { mode: 'plugin-bounded-auto', switched: false } }).includes('ABSTAIN_WITH_MODEL'));
  for (const bad of [{ harness: 'claude' }, { reasonCode: 'switch' }, { model: { providerID: 'Anthropic', modelID: 'x' } }, { model: { providerID: 'a', modelID: 'claude[1m]' } }, { text: 'see https://example.com' }]) {
    assert.equal(c.RouteTurnPayloadContract.validate({ ...base, ...bad }).ok, false, JSON.stringify(bad));
  }
});
