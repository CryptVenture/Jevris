// Two subscribers can each have one line of advice for the same event (the decision engine's waiting
// repeated-failure line, the orchestrator's once-only loop advice, which it marks as shown the moment
// it proposes it). The hook shows both, in subscriber-name order, never one in place of the other, and
// still shows nothing stronger than advice: a context or a route still wins over explains, an
// uncertified one still counts for nothing, and one line from one subscriber renders as before.
import test from 'node:test';
import assert from 'node:assert/strict';

const { chooseOutcome, runLauncher } = await import('../dist/launcher.js');
const claude = await import('@jevris/adapter-claude-code');

const explain = (text) => ({ hookOutcome: { kind: 'explain', text }, certified: false });

test('explains of two subscribers are shown together, in name order, and the first one is not the only one', () => {
  const chosen = chooseOutcome({ results: { orchestrator: explain('Jevris: stop and report.'), 'decision-engine': explain('Jevris: obtain the stack trace.') } });
  assert.deepEqual(chosen.outcome, { kind: 'explain', text: 'Jevris: obtain the stack trace.\nJevris: stop and report.' });
  assert.equal(chosen.reason, 'PROPOSED_BY_DECISION_ENGINE', 'the reason still names the first subscriber');
});

test('the same line from two subscribers is shown once, and one line renders exactly as it did', () => {
  assert.deepEqual(chooseOutcome({ results: { a: explain('same'), b: explain('same') } }).outcome, { kind: 'explain', text: 'same' });
  assert.deepEqual(chooseOutcome({ results: { a: explain('only'), b: { queued: true }, c: { hookOutcome: { kind: 'observe' } } } }).outcome, { kind: 'explain', text: 'only' });
});

test('a stronger certified outcome still wins over explains, and an uncertified context is not shown at all', () => {
  const context = { hookOutcome: { kind: 'context', text: 'ctx' }, certified: true };
  assert.deepEqual(chooseOutcome({ results: { a: explain('one'), b: context, c: explain('two') } }).outcome, { kind: 'context', text: 'ctx' });
  const uncertified = { hookOutcome: { kind: 'context', text: 'ctx' }, certified: false };
  assert.deepEqual(chooseOutcome({ results: { a: explain('one'), b: uncertified, c: explain('two') } }).outcome, { kind: 'explain', text: 'one\ntwo' });
});

test('the joined text stays under the output cap', () => {
  const long = 'x'.repeat(7000);
  const chosen = chooseOutcome({ results: { a: explain(long), b: explain(`${long}y`) } });
  assert.equal(chosen.outcome.kind, 'explain');
  assert.equal(chosen.outcome.text.length, 8000);
});

test('through the launcher, a Claude Code failure event shows both lines in one message and nothing else', async () => {
  const fx = claude.FIXTURES.find((item) => {
    const normalized = claude.normalize(item.native, item.hookKey === undefined ? {} : { hookKey: item.hookKey });
    return normalized.ok && normalized.event.kind === 'tool.failed';
  });
  assert.ok(fx, 'a tool.failed fixture');
  const results = { 'decision-engine': explain('Jevris: this failure has come back 2 times.'), orchestrator: explain('Jevris: stop and report what was tried.') };
  const sidecar = {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request() {
      return { ok: true, result: { recorded: true, duplicate: false, results } };
    },
  };
  const out = await runLauncher({ harness: 'claude', event: fx.hookKey ?? null }, JSON.stringify(fx.native), { adapters: { claude }, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() }, Date.now());
  assert.equal(out.exitCode, 0);
  const parsed = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(parsed), ['systemMessage']);
  assert.equal(parsed.systemMessage, 'Jevris: this failure has come back 2 times.\nJevris: stop and report what was tried.');
});
