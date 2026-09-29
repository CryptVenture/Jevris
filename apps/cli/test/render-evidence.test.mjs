// US15, MEM-08, MEM-10: the CLI shows how an output was shown to the model (exit code, error
// state, where stderr starts, which spans of the original were kept) next to the original
// itself, and an import's negotiated mode and missing capabilities.
import test from 'node:test';
import assert from 'node:assert/strict';

const { renderHuman } = await import('../dist/public/render.js');

const result = (command, payload, summary = 'A summary.') => ({
  schemaVersion: '1.0',
  command,
  mode: 'full',
  sidecar: { state: 'running', reasonCode: null, message: null },
  workspace: { id: 'ws-0123456789abcdef', root: null },
  summary,
  result: payload,
});

test('evidence get prints the hash, the error state, the kept spans and the original', () => {
  const text = renderHuman(
    result('evidence.get', {
      handle: `ev:${'b'.repeat(64)}`,
      found: true,
      mediaType: 'text/plain',
      byteLength: 64,
      text: 'ok 1\nnot ok 2 - parser\n--- stderr ---\nboom\n',
      truncated: false,
      output: { exitCode: 1, errorState: 'failed', stderrOffset: 23, mode: 'distilled', passthroughReason: null, keptSpans: [{ startByte: 5, endByte: 23, startLine: 1, endLine: 2 }], omittedLines: 1, view: 'not ok 2 - parser' },
    }),
  );
  assert.match(text, new RegExp(`hash: sha256:${'b'.repeat(64)}`));
  assert.match(text, /exit code: 1/);
  assert.match(text, /error state: failed/);
  assert.match(text, /stderr starts at byte: 23/);
  assert.match(text, /kept bytes 5-23 \(lines 1-2\)/);
  assert.match(text, /--- original ---\nok 1\nnot ok 2 - parser/);
});

test('evidence get without an output record prints the original only; not found prints no body', () => {
  const plain = renderHuman(result('evidence.get', { handle: 'output:build-17', found: true, mediaType: 'text/plain', byteLength: 3, text: 'hi\n', truncated: false }));
  assert.doesNotMatch(plain, /exit code|error state/);
  assert.match(plain, /hash: none/);
  const missing = renderHuman(result('evidence.get', { handle: 'output:x', found: false, mediaType: null, byteLength: null, text: null, truncated: false }, 'No evidence output:x was found.'));
  assert.equal(missing.split('\n')[0], 'No evidence output:x was found.');
  assert.doesNotMatch(missing, /original/);
});

test('handoff import prints the negotiated mode and what the harness is missing', () => {
  const text = renderHuman(
    result('handoff.import', { accepted: true, reasonCode: 'IMPORTED_ADVICE_ONLY_CAPABILITY', capsuleId: 'cap-0123456789abcdef', facts: 2, unresolved: ['src/a.js changed since the handoff.'], authorityGranted: false, mode: 'advice-only', missingCapabilities: ['context-injection'] }),
  );
  assert.match(text, /mode: advice-only/);
  assert.match(text, /missing capabilities: context-injection/);
  assert.match(text, /authority granted: no/);
  assert.match(text, /unresolved: src\/a\.js changed/);
});

test('task get prints the worker run with requested and observed model apart and cost only when reported', () => {
  const task = { id: 'task-1', schemaVersion: '1.0', workspaceId: 'ws-0123456789abcdef', revision: 'r1', state: 'verified', requirementIds: [], dependencyIds: [], writeScopes: ['src'], acceptanceCheckIds: ['unit'], rootBudgetId: 'budget-1' };
  const base = { taskId: 'task-1', found: true, task, receipts: [{ receiptId: 'rcpt-1', checkId: 'unit', outcome: 'passed', fresh: true }] };
  const unknown = renderHuman(result('task.get', { ...base, worker: { requestedModel: 'claude-sonnet-5', actualModel: null, status: 'completed', costMicroUsd: null, costBasis: 'unknown', durationMs: 900 } }));
  assert.match(unknown, /requested model: claude-sonnet-5/);
  assert.match(unknown, /observed model: unknown \(nothing reported it\)/);
  assert.match(unknown, /cost: unknown/);
  assert.match(unknown, /check unit: passed receipt rcpt-1/);
  const reported = renderHuman(result('task.get', { ...base, worker: { requestedModel: 'claude-sonnet-5', actualModel: 'claude-haiku-4-5', status: 'completed', costMicroUsd: 1500, costBasis: 'reported', durationMs: 900 } }));
  assert.match(reported, /observed model: claude-haiku-4-5/);
  // No auth mode recorded: the basis is unknown and the figure is named as at API list price.
  assert.match(reported, /^cost: \$0\.0015, reported by the worker \(at API list price; the billing basis is unknown \(API key or subscription not detected\)\)$/m);
  assert.match(renderHuman(result('task.get', base)), /worker: none ran/);
  // W04: late results are history; the count shows only when there is one.
  assert.match(renderHuman(result('task.get', { ...base, lateResults: 2 })), /^late results kept: 2$/m);
  assert.doesNotMatch(renderHuman(result('task.get', { ...base, lateResults: 0 })), /late results/);
  assert.doesNotMatch(renderHuman(result('task.get', base)), /late results/);
});

test('cost wording follows the auth mode: an API key is a cost at list price, a subscription an API-equivalent estimate, unknown says so (owner 177c6fe, 8703ab6)', () => {
  const task = { id: 'task-1', schemaVersion: '1.0', workspaceId: 'ws-0123456789abcdef', revision: 'r1', state: 'verified', requirementIds: [], dependencyIds: [], writeScopes: ['src'], acceptanceCheckIds: ['unit'], rootBudgetId: 'budget-1' };
  const worker = (authMode) => ({ requestedModel: 'claude-sonnet-5', actualModel: 'claude-sonnet-5', status: 'completed', costMicroUsd: 1500, costBasis: 'reported', durationMs: 900, ...(authMode === undefined ? {} : { authMode }) });
  const taskText = (authMode) => renderHuman(result('task.get', { taskId: 'task-1', found: true, task, receipts: [], worker: worker(authMode) }));
  const key = taskText('api-key');
  assert.match(key, /^cost: \$0\.0015, reported by the worker \(cost \(API list price\)\)$/m);
  assert.doesNotMatch(key, /estimate/);
  const sub = taskText('subscription');
  assert.match(sub, /API-equivalent estimate; a subscription has no per-token charge, and this use counts against your plan's usage limits/);
  for (const text of [taskText('unknown'), taskText(undefined)]) {
    assert.match(text, /at API list price; the billing basis is unknown/);
    assert.doesNotMatch(text, /subscription has no per-token charge/, 'an unknown mode never asserts a subscription');
  }

  const main = (fields) => ({ currentModel: 'claude-opus-4-7', modelPin: null, pinState: 'unpinned', outcome: 'recommend', recommendedModel: 'claude-sonnet-4-6', reasonCode: 'CHEAPER_SUFFICIENT', costBasis: 'api-list-price', text: 'Switch.', adviceKey: null, ...fields });
  const routeText = (fields) => renderHuman(result('route', { main: main(fields), worker: { outcome: 'abstain', recommendedModel: null, reasonCode: 'NO_WORKER', text: 'No worker.' }, applied: false }));
  assert.match(routeText({ authMode: 'api-key' }), /^cost basis: cost \(API list price\)$/m);
  assert.match(routeText({ authMode: 'subscription' }), /^cost basis: API-equivalent estimate; a subscription has no per-token charge/m);
  assert.match(routeText({}), /^cost basis: at API list price; the billing basis is unknown/m);
  assert.match(routeText({ costBasis: 'subscription-quota' }), /^cost basis: API-equivalent estimate/m);
});
