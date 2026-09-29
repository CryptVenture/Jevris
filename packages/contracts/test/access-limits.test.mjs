// Access limits contracts (design R59; decisions 1e88b2b and bdfb6e3a): the classes, the scope, the
// pinned text patterns and the one matcher. A match yields ids, booleans and numbers only; the
// patterns are frozen; bare "quota" or "rate limit" never matches; X2 never wins over X1.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const m = (text, port) => c.matchAccessText(text, port, NOW);

test('the vocabularies and the new kinds and statuses', () => {
  assert.deepEqual([...c.ACCESS_LIMIT_CLASSES], ['rate-limit', 'usage-window', 'credit-exhausted', 'account-blocked', 'overloaded']);
  assert.deepEqual([...c.ACCESS_PAUSE_CLASSES], ['rate-limit', 'usage-window', 'credit-exhausted', 'account-blocked']);
  assert.deepEqual([...c.ACCESS_AUTH_MODES].sort(), ['api-key', 'subscription', 'unknown']);
  assert.deepEqual([...c.ACCESS_SIGNAL_PORTS], ['claude', 'kilocode', 'codex', 'opencode', 'antigravity', 'claude-api']);
  assert.ok(c.DOMAIN_EVENT_KINDS.includes('turn.failed') && c.DOMAIN_EVENT_KINDS.includes('worker.failed'));
  assert.ok(c.PROVIDER_FAILURE_KINDS.includes('billing'));
  assert.ok(!c.TRANSIENT_FAILURE_KINDS.includes('billing'), 'billing is never retried');
  for (const s of ['access-limit', 'overloaded', 'usage-limit', 'model-unavailable']) assert.ok(c.WORKER_RUN_STATUSES.includes(s), s);
  for (const code of c.ACCESS_REASON_CODES) assert.match(code, new RegExp(c.REASON_CODE_PATTERN));
  assert.deepEqual([...c.ACCESS_CLEAR_CAUSES], ['EXPIRED', 'FINGERPRINT', 'SUCCESS', 'MANUAL', 'USAGE_READ']);
});

test('the patterns are pinned and frozen', () => {
  assert.deepEqual(c.ACCESS_TEXT_PATTERNS.map((r) => r.id), [...c.ACCESS_TEXT_PATTERN_IDS]);
  assert.ok(Object.isFrozen(c.ACCESS_TEXT_PATTERNS));
  for (const r of c.ACCESS_TEXT_PATTERNS) {
    assert.ok(Object.isFrozen(r), r.id);
    assert.ok(Object.isFrozen(r.ports), r.id);
    assert.ok(r.pattern.flags.includes('i'), r.id);
    assert.ok(!r.pattern.flags.includes('g'), `${r.id} is stateless`);
    for (const port of r.ports) assert.ok(c.ACCESS_SIGNAL_PORTS.includes(port), `${r.id} ${port}`);
  }
  assert.equal(c.ACCESS_TEXT_PATTERNS.find((r) => r.id === 'G3').class, null, 'G3 carries only a reset');
  assert.throws(() => c.ACCESS_TEXT_PATTERNS.push({}), TypeError);
});

test('Claude wording: windows, weekly and family limits, spend limits, credit, sign-in and load', () => {
  assert.deepEqual(m("You've hit your session limit", 'claude'), { pattern: 'C1', weekly: false, family: null, resetAtMs: null, resetForm: null });
  assert.deepEqual(m('You’ve hit your weekly limit · resets Oct 2', 'claude'), { pattern: 'C1', weekly: true, family: null, resetAtMs: null, resetForm: null });
  assert.deepEqual(m("You've hit your Opus limit", 'claude-api'), { pattern: 'C1', weekly: true, family: 'opus', resetAtMs: null, resetForm: null });
  assert.deepEqual(m('Claude AI usage limit reached|1759075200', 'claude'), { pattern: 'C1', weekly: false, family: null, resetAtMs: 1_759_075_200_000, resetForm: 'epoch' });
  assert.equal(m("You've hit your org's monthly spend limit", 'claude').pattern, 'C2');
  assert.equal(m('API Error: Server is temporarily limiting requests', 'claude').pattern, 'C3');
  assert.equal(m('Invalid authentication credentials', 'claude').pattern, 'C4');
  assert.equal(m('Your credit balance is too low to access the Anthropic API', 'claude-api').pattern, 'C5');
  assert.equal(m('Anthropic is experiencing high load', 'claude').pattern, 'C6');
});

test("Codex wording: X1's credits text is a window, not credit; quota, blocked, 429 and load", () => {
  const x1 = m("You've hit your usage limit. Upgrade to Pro, purchase more credits or try again at Feb 23rd, 2026 9:01 PM.", 'codex');
  assert.equal(x1.pattern, 'X1', 'X2 never wins over X1');
  assert.equal(x1.resetForm, 'zoneless-date');
  assert.equal(x1.resetAtMs, new Date(2026, 1, 23, 21, 1).getTime());
  assert.deepEqual(m("You've hit your usage limit. Try again in 3 hours.", 'codex'), { pattern: 'X1', weekly: false, family: null, resetAtMs: NOW + 3 * 3_600_000, resetForm: 'relative' });
  assert.equal(m("You've hit your weekly usage limit", 'codex'), null, 'X1 is the exact wording');
  assert.equal(m("You've hit your usage limit for the weekly window", 'codex').weekly, true);
  assert.equal(m('You exceeded your current quota, please check your plan and billing details.', 'codex').pattern, 'X2');
  // Codex 0.157.1's own text for an insufficient_quota 429 (CodexErr::QuotaExceeded), as `codex exec --json` prints it.
  assert.equal(m('Quota exceeded. Check your plan and billing details.', 'codex').pattern, 'X2');
  assert.equal(m('exceeded retry limit, last status: 429 Too Many Requests', 'codex').pattern, 'X4', "Codex's rate-limit 429 stays a rate limit");
  assert.equal(m('Quota exceeded', 'codex'), null, 'a bare "quota exceeded" is not a pattern');
  assert.equal(m('Your account has been deactivated', 'codex').pattern, 'X3');
  assert.equal(m('stream error: 429 Too Many Requests', 'codex').pattern, 'X4');
  assert.equal(m('server_is_overloaded', 'codex').pattern, 'X5');
});

test('Kilo and OpenCode take only X2, X3 and the Claude patterns; Antigravity takes G1 to G7', () => {
  assert.equal(m('insufficient balance', 'kilocode').pattern, 'X2');
  assert.equal(m('Invalid API key', 'opencode').pattern, 'X3');
  assert.equal(m('Too many requests', 'kilocode'), null, 'X4 is Codex only');
  assert.equal(m('Your credit balance is too low', 'opencode').pattern, 'C5');
  assert.deepEqual(m('Quota exceeded. Resets in 3h 20m.', 'antigravity'), { pattern: 'G1', weekly: false, family: null, resetAtMs: NOW + 3 * 3_600_000 + 20 * 60_000, resetForm: 'relative' });
  assert.equal(m('Weekly limit reached', 'antigravity').weekly, true);
  assert.deepEqual(m('resets in 2 days', 'antigravity'), { pattern: 'G3', weekly: false, family: null, resetAtMs: NOW + 2 * 86_400_000, resetForm: 'relative' });
  assert.equal(m("You've hit your session limit", 'antigravity'), null, 'a Claude pattern never runs on Antigravity');
});

test("Gemini's own error texts on Antigravity (G4 to G7, quoted from ai.google.dev): credit, a leaked key, the daily quota, the per-minute limit and overload", () => {
  const g = (text) => m(text, 'antigravity')?.pattern ?? null;
  assert.equal(g('402 Payment Required: Your Prepay credit balance is depleted.'), 'G4');
  assert.equal(g('Your API key was reported as leaked. Please use another API key.'), 'G5');
  assert.deepEqual(m('429 quota_exceeded: You have exceeded your daily quota. Resets in 5h', 'antigravity'), { pattern: 'G1', weekly: false, family: null, resetAtMs: NOW + 5 * 3_600_000, resetForm: 'relative' });
  assert.equal(g('429 rate_limit_exceeded: You have exceeded the per-minute or per-second request or token limit.'), 'G6');
  assert.equal(g('503: The service is temporarily overloaded or down.'), 'G7');
  // G8 (D's trace 3, G-11): 401 authentication, "The API key is missing, invalid, or expired."
  assert.equal(g('401 Unauthorized: The API key is missing, invalid, or expired.'), 'G8');
  assert.equal(m('authentication: The API key is missing, invalid or expired', 'antigravity')?.pattern, 'G8');
  assert.equal(m('The API key is missing, invalid, or expired.', 'codex'), null, 'Gemini wording runs on Antigravity only');
  for (const text of ['401', '401 Unauthorized', 'UNAUTHENTICATED', 'API key is missing', 'invalid or expired token', 'the session is expired']) assert.equal(g(text), null, text);
  // F's held fixture stays a usage window with its reset: G1 is checked before G6.
  assert.deepEqual(m('RESOURCE_EXHAUSTED: quota exceeded for this account; resets in 3h 10m', 'antigravity'), { pattern: 'G1', weekly: false, family: null, resetAtMs: NOW + 3 * 3_600_000 + 10 * 60_000, resetForm: 'relative' });
  // Credit and account win over a usage window in the same text.
  assert.equal(g('quota exceeded; Your Prepay credit balance is depleted.'), 'G4');
  // The Gemini texts run on Antigravity only.
  for (const port of ['claude', 'codex', 'kilocode', 'opencode']) assert.equal(m('Your API key was reported as leaked.', port), null, port);
  // Near-misses: none of these is an access limit.
  for (const text of ['disk quota exceeded', 'limited to 3 per minute', 'error at line 429', 'PERMISSION_DENIED: model not available for this key', '503', 'RESOURCE_EXHAUSTED', 'Your API key does not have permission for this resource.', 'the service is down for maintenance']) {
    assert.equal(g(text), null, text);
  }
});

test('G8 between the contract row and core\'s row (B): a G8 match classifies to nothing, or, once core has antigravity.text.g8, to account-blocked held timed; never another row, never a throw', async () => {
  const core = await import('../../core/dist/index.js');
  const T0 = Date.parse('2026-09-28T12:00:00Z');
  const text = c.matchAccessText('401 Unauthorized: The API key is missing, invalid, or expired.', 'antigravity', T0);
  assert.equal(text?.pattern, 'G8');
  const held = core.classifyAccessSignal({ port: 'antigravity', channel: 'error-text', certified: false, text }, 'api-key', T0);
  const proven = core.classifyAccessSignal({ port: 'antigravity', channel: 'error-text', certified: true, text }, 'api-key', T0);
  if (held === null) {
    assert.equal(proven, null, 'no core row yet: no pause either way');
  } else {
    assert.deepEqual([held.class, held.signal, held.heldAsTimed], ['usage-window', 'antigravity.text.g8', true], 'OP-4: uncertified text is held timed');
    assert.equal(proven?.class, 'account-blocked');
  }
});

test('negatives: bare quota and rate-limit words, disk quotas, and ordinary errors never match', () => {
  for (const [text, port] of [
    ['disk quota exceeded', 'antigravity'],
    ['write failed: storage quota exceeded', 'antigravity'],
    ['rate limit', 'codex'],
    ['rate limiting is configured in nginx.conf', 'codex'],
    ['resource exhausted', 'codex'],
    ['quota', 'kilocode'],
    ['TypeError: cannot read properties of undefined', 'claude'],
    ['', 'claude'],
  ]) assert.equal(m(text, port), null, `${port}: ${text}`);
  // Only the last 4 KiB is read: a match earlier in a long log is not seen.
  assert.equal(m(`You've hit your session limit${'x'.repeat(5000)}`, 'claude'), null);
});

test('a text match and a wire signal hold no text; a finding holds codes only', () => {
  const match = m("You've hit your Sonnet limit", 'claude');
  const wire = c.AccessSignalWireSchema;
  const ok = validate;
  assert.equal(ok(c.AccessTextMatchSchema, match), true);
  assert.equal(ok(wire, { port: 'claude', channel: 'error-text', text: match }), true);
  assert.equal(ok(wire, { port: 'kilocode', channel: 'structured', status: 402, errorType: 'billing_error' }), true);
  assert.equal(ok(wire, { port: 'kilocode', channel: 'structured', message: 'You have run out of credits' }), false, 'no message field');
  assert.equal(ok(wire, { port: 'kilocode', channel: 'structured', errorType: 'your key sk-ant-1234 is out of credit' }), false, 'a code is never free text');
  assert.equal(ok(wire, { port: 'kilocode', channel: 'structured', headers: { 'retry-after': '30' } }), false, 'headers never cross a boundary');
  // B's MEDIUM 22 (OP-4): certification is sidecar state, never asserted by the sender.
  assert.equal(ok(wire, { port: 'claude', channel: 'error-text', certified: true, text: match }), false, 'certified is not a wire field');
  const finding = c.AccessLimitFindingSchema;
  assert.equal(ok(finding, { class: 'usage-window', signal: 'claude.stream.rate-limit-event', weekly: true, resetBasis: 'reported', resetAtMs: NOW, family: 'opus' }), true);
  assert.equal(ok(finding, { class: 'usage-window', signal: 'Claude said: limit', weekly: true, resetBasis: 'reported' }), false);
  const scope = c.AccessScopeSchema;
  assert.equal(ok(scope, { harness: 'kilocode', authMode: 'api-key', servingHost: 'openrouter', modelId: null, family: null }), true);
  assert.equal(ok(scope, { harness: 'kilocode', authMode: 'api-key', servingHost: 'vercel', modelId: null, family: null }), false, 'an unpinned host has no scope');
});

test('OP-6 (E\'s additions, carried by C2): the usage bands, the usage-read source in status, the USAGE_READ cause', () => {
  assert.deepEqual([...c.ACCESS_USAGE_BANDS], ['under-50', '50-80', '80-100', 'exhausted']);
  assert.deepEqual([...c.ACCESS_LIMIT_SOURCES], ['owned-run', 'session', 'usage-read']);
  assert.ok(c.ACCESS_CLEAR_CAUSES.includes('USAGE_READ'));
  assert.ok(!c.ACCESS_CLEAR_CAUSES.includes('PROBE'), 'no cause for a probe: Jevris never spends one');
  const entry = (source) => ({ key: '0123456789abcdef', class: 'usage-window', weekly: false, scope: { harness: 'codex', authMode: 'subscription', servingHost: 'openai', modelId: null, family: null }, until: '2026-09-28T14:00:00.000Z', resetBasis: 'reported', source, since: '2026-09-28T12:00:00.000Z' });
  assert.equal(validate(c.AccessLimitStatusEntrySchema, entry('usage-read')), true);
  assert.equal(validate(c.AccessLimitStatusEntrySchema, entry('owned-run')), true);
  for (const bad of ['probe', 'hook', 'Usage-Read', '']) assert.equal(validate(c.AccessLimitStatusEntrySchema, entry(bad)), false, bad);
});

function validate(schema, value) {
  const contract = c.defineContract({ name: 'Probe', description: 'probe', schema });
  return contract.validate(value).ok;
}
