// Access limits R79 (design 11): status carries the machine's access pauses in force (B's view of
// core's record) as an optional `accessLimits`, never the fingerprint, count, step or any text, and
// the human status shows a count line and one line per pause in the words of `jevris route limits`.
// Contract and render only: no sidecar, no home.
import test from 'node:test';
import assert from 'node:assert/strict';

const { accessLimitsStatusLines, mainSessionsLines } = await import('../dist/public/render.js');
const { AccessLimitsStatusSchema, MainSessionStatusSchema, StatusPayloadSchema, ACCESS_STATUS_MAX_ENTRIES, defineContract, jsonSchemaOf } = await import('../../../packages/contracts/dist/index.js');

const View = defineContract({ name: 'AccessLimitsStatusTest', description: 'test', schema: AccessLimitsStatusSchema });

const windowEntry = {
  key: '0123456789abcdef',
  class: 'usage-window',
  weekly: false,
  scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null },
  until: '2026-09-28T19:10:00.000Z',
  resetBasis: 'rule',
  source: 'owned-run',
  since: '2026-09-28T14:10:00.000Z',
};
const creditEntry = {
  key: 'fedcba9876543210',
  class: 'credit-exhausted',
  weekly: false,
  scope: { harness: 'kilocode', authMode: 'api-key', servingHost: 'openrouter', modelId: null, family: null },
  until: null,
  resetBasis: 'none',
  source: 'session',
  since: '2026-09-28T12:00:00.000Z',
};

test('the status contract takes an optional, nullable accessLimits and refuses anything beyond the view', () => {
  const status = jsonSchemaOf(StatusPayloadSchema);
  assert.ok('accessLimits' in status.properties, 'status has the field');
  assert.equal(status.required.includes('accessLimits'), false, 'it is optional');
  const view = { readable: true, full: false, active: 2, entries: [creditEntry, windowEntry] };
  assert.equal(View.validate(view).ok, true);
  assert.equal(View.validate({ readable: false, full: false, active: 0, entries: [] }).ok, true);
  const refused = [
    { ...view, entries: [{ ...creditEntry, fingerprint: 'abcdef0123456789' }] },
    { ...view, entries: [{ ...creditEntry, count: 3 }] },
    { ...view, entries: [{ ...creditEntry, text: 'Your credit balance is too low' }] },
    { ...view, entries: [{ ...creditEntry, class: 'overloaded' }] },
    { ...view, entries: [{ ...creditEntry, key: 'NOT-A-KEY' }] },
    { ...view, entries: [{ ...creditEntry, source: 'hook' }] },
    { ...view, active: -1 },
    { ...view, entries: Array.from({ length: ACCESS_STATUS_MAX_ENTRIES + 1 }, () => creditEntry) },
  ];
  for (const r of refused) assert.equal(View.validate(r).ok, false, JSON.stringify(r).slice(0, 120));
});

test('newKeyClears: an optional boolean on a status entry; a new key is named only where it is true', () => {
  const claudeKey = { ...creditEntry, scope: { ...creditEntry.scope, harness: 'claude', servingHost: 'anthropic' }, newKeyClears: true };
  const view = (entries) => ({ readable: true, full: false, active: entries.length, entries });
  assert.equal(View.validate(view([claudeKey])).ok, true);
  assert.equal(View.validate(view([{ ...creditEntry, newKeyClears: false }])).ok, true);
  for (const bad of ['yes', 1, null, 'abcdef0123456789']) assert.equal(View.validate(view([{ ...creditEntry, newKeyClears: bad }])).ok, false, String(bad));
  assert.deepEqual(accessLimitsStatusLines(view([claudeKey, { ...creditEntry, newKeyClears: false }, { ...creditEntry, scope: { ...creditEntry.scope, authMode: 'unknown' } }])), [
    'access limits: 3 active (see jevris route limits)',
    '  claude api-key anthropic: credit-exhausted since 2026-09-28T12:00Z; clears when the API key Jevris passes changes, or with jevris route limits clear (session)',
    '  kilocode api-key openrouter: credit-exhausted since 2026-09-28T12:00Z; clears with jevris route limits clear (session)',
    '  kilocode unknown openrouter: credit-exhausted since 2026-09-28T12:00Z; clears when a session turn on it finishes, or with jevris route limits clear (session)',
  ]);
});

test('the status lines: a count, one line per pause, "and N more", the unreadable and full notes, and nothing when none is in force', () => {
  assert.deepEqual(accessLimitsStatusLines({ readable: true, full: false, active: 2, entries: [creditEntry, { ...windowEntry, scope: { ...windowEntry.scope, modelId: 'gpt-5.5' }, weekly: true }] }), [
    'access limits: 2 active (see jevris route limits)',
    '  kilocode api-key openrouter: credit-exhausted since 2026-09-28T12:00Z; clears with jevris route limits clear (session)',
    '  codex subscription openai (gpt-5.5): usage-window (weekly) until 2026-09-28T19:10Z (rule) (owned-run)',
  ]);
  assert.deepEqual(accessLimitsStatusLines({ readable: true, full: true, active: 20, entries: [windowEntry] }), [
    'access limits: 20 active (see jevris route limits)',
    '  codex subscription openai: usage-window until 2026-09-28T19:10Z (rule) (owned-run)',
    '  … and 19 more',
    'access limits: the record is full (ACCESS_LIMITS_FULL); a new pause replaces the oldest expired or timed one',
  ]);
  assert.deepEqual(accessLimitsStatusLines({ readable: false, full: false, active: 0, entries: [] }), ['access limits: the record could not be read (ACCESS_LIMITS_UNREADABLE), so it pauses nothing; jevris doctor says more']);
  assert.deepEqual(accessLimitsStatusLines({ readable: true, full: false, active: 0, entries: [] }), []);
});

test('serving hosts R54: a main session line names its session host and whether the tariff is known; without one it is unchanged', () => {
  const Main = defineContract({ name: 'MainSessionStatusTest', description: 'test', schema: MainSessionStatusSchema });
  const base = { harness: 'kilocode', mode: 'plugin-bounded-auto', turnSwitching: 'possible', reasonCode: null };
  const gateway = { ...base, sessionHost: { id: 'openrouter', kind: 'gateway' }, tariff: 'known' };
  const nvidia = { ...base, harness: 'opencode', turnSwitching: 'advice-only', reasonCode: 'HOST_TARIFF_UNKNOWN', sessionHost: { id: 'nvidia', kind: 'inference-host' }, tariff: 'unknown' };
  for (const v of [base, gateway, nvidia, { ...base, sessionHost: null, tariff: null }, { ...base, sessionHost: { id: 'anthropic', kind: 'maker' }, tariff: 'known' }]) assert.equal(Main.validate(v).ok, true, JSON.stringify(v));
  for (const v of [{ ...base, sessionHost: { id: 'acme', kind: 'gateway' } }, { ...base, sessionHost: { id: 'openrouter', kind: 'proxy' } }, { ...base, tariff: 'maybe' }, { ...base, sessionHost: { id: 'openrouter', kind: 'gateway', url: 'x' } }]) assert.equal(Main.validate(v).ok, false, JSON.stringify(v));
  const [plain, viaGateway, viaNvidia] = mainSessionsLines([base, gateway, nvidia]);
  assert.equal(plain, 'main session kilocode: plugin-bounded-auto, turns may be switched (each turn still needs a linked session, low risk and budget)');
  assert.equal(viaGateway, 'main session kilocode: plugin-bounded-auto, session host openrouter (gateway), tariff known, turns may be switched (each turn still needs a linked session, low risk and budget)');
  assert.match(viaNvidia, /^main session opencode: plugin-bounded-auto, session host nvidia \(inference-host\), tariff unknown \(routes through it are advice only\), advice only: /);
});
