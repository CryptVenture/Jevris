import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSignalOf, runOwnedWorker, sdkAccessSignal, sdkFailureText, validateWorkerInput, SDK_MISSING_MESSAGE, SDK_NEEDS_API_KEY } from '../dist/index.js';

const base = { prompt: 'fix the bug', model: 'claude-sonnet-4-5', cwd: '/tmp/wt', allowedTools: ['Read', 'Edit'], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 60_000, env: { ANTHROPIC_API_KEY: 'test-key-not-real', PATH: '/usr/bin' } };

// beforeYield(index, args) runs as the stub is about to yield each message, so a test acts on
// the running session itself, never on a timer racing setup. hangAt: the stub waits there until
// the session is aborted (it never completes on its own).
function fakeQuery(messages, { onArgs, beforeYield, hangAt = -1 } = {}) {
  return (args) => {
    onArgs?.(args);
    let interrupted = 0;
    const handle = {
      interrupted: () => interrupted,
      async interrupt() {
        interrupted += 1;
      },
      close() {},
      async *[Symbol.asyncIterator]() {
        const signal = args.options.abortController.signal;
        for (const [index, m] of messages.entries()) {
          if (signal.aborted) throw new Error('aborted');
          beforeYield?.(index, args);
          if (index === hangAt && !signal.aborted) await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
          if (args.options.abortController.signal.aborted) throw new Error('aborted');
          yield m;
        }
      },
    };
    return handle;
  };
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-5-20260101', cwd: '/tmp/wt', tools: ['Read'], apiKeySource: 'ANTHROPIC_API_KEY' };
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'sess-1',
  num_turns: 3,
  result: 'done',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
  modelUsage: { 'claude-sonnet-4-5-20260101': { inputTokens: 1000, outputTokens: 200, costUSD: 0.0123 } },
};

test('the worker consumes the whole query() stream and reports actual model, usage and cost (ORC-05)', async () => {
  let seen;
  const events = [];
  const out = await runOwnedWorker({
    ...base,
    query: fakeQuery([INIT, { type: 'assistant', session_id: 'sess-1' }, RESULT], { onArgs: (a) => (seen = a) }),
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(out.status, 'completed');
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.actualModel, 'claude-sonnet-4-5-20260101');
  assert.equal(out.costUsd, 0.0123);
  assert.deepEqual(out.usage, { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 });
  assert.equal(out.turns, 3);
  assert.equal(out.messages, 3);
  assert.deepEqual(events, ['system', 'assistant', 'result']);
  assert.equal(seen.options.permissionMode, 'default');
  assert.equal(seen.options.cwd, '/tmp/wt');
  assert.equal(seen.options.model, 'claude-sonnet-4-5');
  assert.equal(seen.options.maxTurns, 5);
  assert.equal(seen.options.maxBudgetUsd, 1);
  assert.deepEqual(seen.options.allowedTools, ['Read', 'Edit']);
  assert.deepEqual(seen.options.disallowedTools, ['EnterWorktree', 'ExitWorktree']);
});

test('SDK error results map to max-turns, budget-exceeded and failed (ORC-05)', async () => {
  const run = (subtype) => runOwnedWorker({ ...base, query: fakeQuery([INIT, { ...RESULT, subtype, is_error: true }]) });
  assert.equal((await run('error_max_turns')).status, 'max-turns');
  assert.equal((await run('error_max_budget_usd')).status, 'budget-exceeded');
  assert.equal((await run('error_during_execution')).status, 'failed');
  assert.equal((await runOwnedWorker({ ...base, query: fakeQuery([INIT]) })).status, 'failed');
});

test('abort, timeout and interrupt are honoured (ORC-05)', async () => {
  // The caller aborts once the session is running (its second message is next), however long
  // setup took; the stub would otherwise go on to a completed result.
  const controller = new AbortController();
  let yielded = 0;
  const running = fakeQuery([INIT, { type: 'assistant' }, { type: 'assistant' }, RESULT], {
    beforeYield: (index) => {
      yielded = index;
      if (index === 1) controller.abort();
    },
  });
  assert.equal((await runOwnedWorker({ ...base, query: running, signal: controller.signal })).status, 'aborted');
  assert.equal(yielded, 1, 'aborted mid-session, before the result');
  // A session that never answers ends by the worker's own timeout, not by the stub finishing.
  assert.equal((await runOwnedWorker({ ...base, timeoutMs: 1_000, query: fakeQuery([INIT, RESULT], { hangAt: 1 }) })).status, 'timeout');
  let control;
  const handleQuery = fakeQuery([INIT, RESULT]);
  const out = await runOwnedWorker({ ...base, query: handleQuery, onStart: (c) => (control = c) });
  control.interrupt();
  assert.equal(out.status, 'completed');
  // Owner decision 29423b6: the first session id is reported once, while the session runs; a
  // throwing callback does not fail the run.
  const reported = [];
  const linked = await runOwnedWorker({ ...base, query: fakeQuery([INIT, { type: 'assistant', session_id: 'sess-2' }, RESULT]), onSessionId: (id) => reported.push(id) });
  assert.deepEqual([reported, linked.sessionId], [['sess-1'], 'sess-1']);
  const thrown = await runOwnedWorker({ ...base, query: fakeQuery([INIT, RESULT]), onSessionId: () => { throw new Error('bookkeeping'); } });
  assert.equal(thrown.status, 'completed');
});

test('grants are least-privilege and inputs are validated before any session starts (ORC-05)', async () => {
  let called = false;
  const q = () => {
    called = true;
    throw new Error('should not start');
  };
  for (const bad of [{ allowedTools: ['WebFetch'] }, { maxTurns: 0 }, { maxBudgetUsd: 0 }, { model: 'x y' }, { prompt: '' }]) {
    const out = await runOwnedWorker({ ...base, ...bad, query: q });
    assert.equal(out.status, 'refused', JSON.stringify(bad));
  }
  assert.equal(called, false);
  assert.equal(validateWorkerInput(base), null);
  assert.equal(SDK_MISSING_MESSAGE, 'unsupported: install @anthropic-ai/claude-agent-sdk');
});

test('the SDK worker runs only on ANTHROPIC_API_KEY: no key refuses, a login token never reaches the session, any other key source is aborted (ORC-05, owner decision)', async () => {
  let started = 0;
  const noKey = await runOwnedWorker({ ...base, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-not-real' }, query: fakeQuery([INIT, RESULT], { onArgs: () => (started += 1) }) });
  assert.deepEqual([noKey.status, noKey.reason, started], ['refused', SDK_NEEDS_API_KEY, 0]);
  let seen;
  const ok = await runOwnedWorker({ ...base, env: { ...base.env, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-not-real' }, query: fakeQuery([INIT, RESULT], { onArgs: (a) => (seen = a) }) });
  assert.equal(ok.status, 'completed');
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, 'test-key-not-real');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in seen.options.env, false);
  for (const source of ['oauth', '/login managed key', 'none']) {
    const init = { ...INIT, apiKeySource: source };
    const run = await runOwnedWorker({ ...base, query: fakeQuery([init, { type: 'assistant', session_id: 'sess-1' }, RESULT]) });
    assert.equal(run.status, 'refused', String(source));
    assert.match(run.reason, /not ANTHROPIC_API_KEY/);
  }
});

/** A stub session that starts, then fails with `error` (the SDK's API error shape). */
function failingQuery(error) {
  return () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield INIT;
      throw error;
    },
  });
}

/** An error shaped as the Anthropic SDK's APIError: status, and the body under `error`. */
function apiError(status, type, message = 'model: claude-sonnet-4-5 secret-looking body text') {
  return Object.assign(new Error(`${String(status)} ${message}`), { status, error: { type: 'error', error: { type, message } } });
}

test('a Claude API 404 not_found_error for the requested model ends as the found-gone signal, with no error text (C f5b19ab; pair: other errors stay ordinary failures)', async () => {
  const gone = await runOwnedWorker({ ...base, query: failingQuery(apiError(404, 'not_found_error')) });
  assert.equal(gone.status, 'failed');
  assert.deepEqual(gone.modelSignal, { port: 'claude-api', signal: 'http-404-not-found-error' });
  assert.equal(gone.reason, 'the requested model was not found (HTTP 404 not_found_error)');
  assert.doesNotMatch(JSON.stringify(gone), /secret-looking body text/, 'no error text is kept for a gone model');
  for (const [status, type] of [[404, 'invalid_request_error'], [400, 'not_found_error'], [400, 'invalid_request_error'], [403, 'permission_error']]) {
    const other = await runOwnedWorker({ ...base, query: failingQuery(apiError(status, type)) });
    assert.equal(other.status, 'failed');
    assert.equal(other.modelSignal, undefined, `${String(status)} ${type}`);
  }
  assert.equal((await runOwnedWorker({ ...base, query: failingQuery(new Error('network down')) })).modelSignal, undefined);
  // The same structured fields when the type is on the body itself or the error.
  assert.deepEqual(modelSignalOf({ status: 404, error: { type: 'not_found_error' } }), { port: 'claude-api', signal: 'http-404-not-found-error' });
  assert.deepEqual(modelSignalOf({ status: 404, type: 'not_found_error' }), { port: 'claude-api', signal: 'http-404-not-found-error' });
  assert.equal(modelSignalOf(null), null);
});

test('R80: a failed Agent SDK call keeps only its HTTP status and the API error type, never the message or the body; a result subtype that is not an enum word is not kept either', async () => {
  const CANARY = 'CANARY-7f3e body: a note for org acme sk-ant-not-a-key';
  for (const [status, type, expected] of [
    [403, 'permission_error', 'the Agent SDK call failed (HTTP 403 permission_error)'],
    [400, 'invalid_request_error', 'the Agent SDK call failed (HTTP 400 invalid_request_error)'],
    [413, 'request_too_large', 'the Agent SDK call failed (HTTP 413 request_too_large)'],
  ]) {
    const run = await runOwnedWorker({ ...base, query: failingQuery(apiError(status, type, CANARY)) });
    assert.deepEqual([run.status, run.reason], ['failed', expected]);
    assert.doesNotMatch(JSON.stringify(run), /CANARY-7f3e|acme|sk-ant/);
  }
  const plain = await runOwnedWorker({ ...base, query: failingQuery(new Error(CANARY)) });
  assert.equal(plain.reason, 'the Agent SDK call failed');
  assert.doesNotMatch(JSON.stringify(plain), /CANARY-7f3e/);
  // A type that is not an API enum word, or a status out of range, is dropped rather than shown.
  assert.equal(sdkFailureText({ status: 700, error: { type: 'error', error: { type: 'Your credit balance is too low' } } }), 'the Agent SDK call failed');
  assert.equal(sdkFailureText({ status: 429 }), 'the Agent SDK call failed (HTTP 429)');
  const odd = await runOwnedWorker({ ...base, query: fakeQuery([INIT, { ...RESULT, subtype: 'Credit balance is too low', is_error: true }]) });
  assert.deepEqual([odd.status, odd.reason], ['failed', 'error']);
});

test('R64: a failed call or a stream that ends on an access limit gives the access-limit or overloaded status, fixed text, and the wire signal: codes, a reset and a pattern id, never the message, the body or a header value', async () => {
  const CANARY = 'CANARY-5b2a body: Your credit balance is too low for org acme';
  const t0 = Date.now();
  const withHeaders = (error, headers) => Object.assign(error, { headers });
  const cases = [
    [apiError(402, 'billing_error', CANARY), 'access-limit', 'the run hit an access limit: credit-exhausted (claude-api.http.402)', { status: 402, errorType: 'billing_error' }],
    [apiError(401, 'authentication_error', CANARY), 'access-limit', 'the run hit an access limit: account-blocked (claude-api.http.401)', { status: 401, errorType: 'authentication_error' }],
    [apiError(529, 'overloaded_error', CANARY), 'overloaded', 'the provider was overloaded (claude-api.http.overloaded)', { status: 529, errorType: 'overloaded_error' }],
    [apiError(500, 'api_error', CANARY), 'overloaded', 'the provider was overloaded (claude-api.http.overloaded)', { status: 500, errorType: 'api_error' }],
    [
      Object.assign(new Error(CANARY), { status: 429, error: { type: 'error', error: { type: 'rate_limit_error', message: CANARY, details: { error_code: 'enforced_spend_limit_reached' } } } }),
      'access-limit',
      'the run hit an access limit: credit-exhausted (claude-api.http.429-spend-limit)',
      { status: 429, errorType: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached' },
    ],
    [apiError(400, 'invalid_request_error', CANARY), 'access-limit', 'the run hit an access limit: credit-exhausted (claude-api.http.400-credit-balance)', { status: 400, errorType: 'invalid_request_error' }],
  ];
  for (const [error, status, reason, wire] of cases) {
    const run = await runOwnedWorker({ ...base, query: failingQuery(error) });
    assert.deepEqual([run.status, run.reason], [status, reason], JSON.stringify(wire));
    const { text, ...fields } = run.accessSignal;
    assert.deepEqual(fields, { port: 'claude-api', channel: 'structured', ...wire });
    if (wire.status === 400) assert.equal(text.pattern, 'C5', 'only the pinned pattern id is kept');
    else assert.equal(text, undefined);
    assert.equal(run.accessLimit.signal, reason.match(/\((claude-api\.[a-z0-9.-]+)\)/)[1]);
    assert.doesNotMatch(JSON.stringify(run), /CANARY-5b2a|credit balance|acme/);
  }
  // A 429 rate limit: the reset comes from the headers (fetch Headers or a record); no header value is kept.
  const headers = new Headers({ 'retry-after': '120', 'x-request-id': 'req-CANARY-5b2a' });
  const limited = await runOwnedWorker({ ...base, query: failingQuery(withHeaders(apiError(429, 'rate_limit_error', CANARY), headers)) });
  assert.equal(limited.status, 'access-limit');
  assert.equal(limited.accessLimit.class, 'rate-limit');
  assert.ok(limited.accessSignal.resetAtMs >= t0 + 120_000 && limited.accessSignal.resetAtMs <= Date.now() + 120_000, 'retry-after: 120 s');
  assert.doesNotMatch(JSON.stringify(limited), /req-CANARY|x-request-id/);
  assert.ok(sdkAccessSignal(withHeaders(apiError(429, 'rate_limit_error'), { 'Retry-After': '30' }), t0).resetAtMs >= t0 + 30_000);
  assert.equal(sdkAccessSignal(new Error('network down'), t0), null, 'no HTTP status, no signal');
  // The stream: a rejected rate-limit event names the window and its reset; it wins over a later error.
  const resetsAt = Math.floor(t0 / 1000) + 3_600;
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt }, session_id: 'sess-1' };
  const windowed = await runOwnedWorker({ ...base, query: fakeQuery([INIT, event, { ...RESULT, subtype: 'error_during_execution', is_error: true, result: CANARY }]) });
  assert.deepEqual(windowed.accessSignal, { port: 'claude-api', channel: 'structured', errorType: 'rate_limit_event', rateLimitType: 'seven_day_opus', resetAtMs: resetsAt * 1000 });
  assert.deepEqual([windowed.status, windowed.accessLimit.class, windowed.accessLimit.weekly, windowed.accessLimit.family], ['access-limit', 'usage-window', true, 'opus']);
  // An allowed event, or a warning, is not a limit.
  const allowed = await runOwnedWorker({ ...base, query: fakeQuery([INIT, { ...event, rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt } }, { ...RESULT, subtype: 'error_during_execution', is_error: true }]) });
  assert.deepEqual([allowed.status, allowed.accessSignal], ['failed', undefined]);
  // The last api_retry or assistant error enum, when nothing else was said.
  const retry = await runOwnedWorker({ ...base, query: fakeQuery([INIT, { type: 'system', subtype: 'api_retry', error: 'rate_limit', session_id: 'sess-1' }, { type: 'assistant', error: 'billing_error', message: { content: [] }, session_id: 'sess-1' }, { ...RESULT, subtype: 'error_during_execution', is_error: true }]) });
  assert.deepEqual([retry.status, retry.accessSignal.errorType, retry.accessLimit.class], ['access-limit', 'billing_error', 'credit-exhausted']);
  // Success wins: a run with a successful result records nothing, whatever the stream said.
  const ok = await runOwnedWorker({ ...base, query: fakeQuery([INIT, event, { type: 'system', subtype: 'api_retry', error: 'rate_limit' }, RESULT]) });
  assert.deepEqual([ok.status, ok.accessSignal, ok.accessLimit], ['completed', undefined, undefined]);
  // A model_not_found error is model availability, not an access limit.
  const gone = await runOwnedWorker({ ...base, query: fakeQuery([INIT, { type: 'assistant', error: 'model_not_found', session_id: 'sess-1' }, { ...RESULT, subtype: 'error_during_execution', is_error: true }]) });
  assert.deepEqual([gone.status, gone.accessSignal], ['failed', undefined]);
});

test('G21: the routed effort reaches the SDK session as its effort option; a Haiku model and no effort get none; an unknown level is refused before a session starts', async () => {
  const run = async (extra) => {
    let seen;
    const out = await runOwnedWorker({ ...base, ...extra, query: fakeQuery([INIT, RESULT], { onArgs: (a) => (seen = a) }) });
    return { out, seen };
  };
  const high = await run({ effort: 'high' });
  assert.deepEqual([high.out.status, high.out.effort, high.seen.options.effort], ['completed', 'high', 'high']);
  const xhigh = await run({ effort: 'xhigh' });
  assert.deepEqual([xhigh.out.effort, xhigh.seen.options.effort], ['xhigh', 'xhigh']);
  const none = await run({});
  assert.deepEqual([none.out.effort, Object.hasOwn(none.seen.options, 'effort')], [null, false]);
  const haiku = await run({ model: 'claude-haiku-4-5-20251001', effort: 'high' });
  assert.deepEqual([haiku.out.effort, Object.hasOwn(haiku.seen.options, 'effort')], [null, false]);
  const haiku55 = await run({ model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual([haiku55.out.effort, haiku55.seen.options.effort], ['low', 'low'], 'Haiku 5.5 takes effort');
  const alias = await run({ model: 'haiku', effort: 'low' });
  assert.deepEqual([alias.out.effort, Object.hasOwn(alias.seen.options, 'effort')], [null, false], 'the bare alias may still mean Haiku 4.5');
  assert.equal(validateWorkerInput({ ...base, effort: 'turbo' }), 'effort');
  let started = false;
  const refused = await runOwnedWorker({ ...base, effort: 'turbo', query: fakeQuery([INIT, RESULT], { onArgs: () => (started = true) }) });
  assert.deepEqual([refused.status, refused.reason, started], ['refused', 'invalid effort', false]);
});
