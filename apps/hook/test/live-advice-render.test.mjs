// Live advice (repeated failure, new task) reaches a harness as an ordinary `explain` outcome: the
// decision subscriber hands a waiting line to the next prompt or tool event of the session. Whatever
// harness it is, the hook output stays valid and stays advice: one message, never a block, a deny,
// a continue or a changed input. Where the harness cannot show an explain on an event, the request
// says so (`showsExplain: false`) and the rendered output shows nothing, so a line is never spent on
// an event that cannot show it. Stub sidecar and fixtures only; no real harness runs here.
import test from 'node:test';
import assert from 'node:assert/strict';

const { runLauncher } = await import('../dist/launcher.js');
const adapters = {
  claude: await import('@jevris/adapter-claude-code'),
  kilo: await import('@jevris/adapter-kilocode'),
  codex: await import('@jevris/adapter-codex'),
  opencode: await import('@jevris/adapter-opencode'),
  agy: await import('@jevris/adapter-antigravity'),
};

// The kinds the decision subscriber hands a waiting line to: a prompt, the tool events and, for Antigravity, an invocation's start.
const DELIVERY_KINDS = new Set(['task.requested', 'tool.proposed', 'tool.finished', 'tool.failed', 'invocation.started']);
const LINE = 'Jevris: this failure has come back 2 times; the next most useful evidence is the failing test output.';
const FORBIDDEN = ['"decision"', 'permissionDecision', '"continue":false', 'stopReason', 'updatedInput', 'updatedMCPToolOutput', 'deny', 'block'];

function sidecarAnswering(results) {
  const calls = [];
  return {
    calls,
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request(input) {
        calls.push(input);
        return { ok: true, result: { recorded: true, duplicate: false, results } };
      },
    },
  };
}

test('a delivered advice line renders as one valid message on every prompt, tool and invocation-start event of every harness, and only where the harness shows an explain', async () => {
  const outcome = { kind: 'explain', text: LINE };
  const seen = { shown: 0, silent: 0 };
  for (const [name, adapter] of Object.entries(adapters)) {
    let events = 0;
    for (const fx of adapter.FIXTURES) {
      const context = fx.hookKey === undefined ? {} : { hookKey: fx.hookKey };
      const normalized = adapter.normalize(fx.native, context);
      if (!normalized.ok || !DELIVERY_KINDS.has(normalized.event.kind)) continue;
      events += 1;
      const fake = sidecarAnswering({ 'decision-engine': { hookOutcome: outcome, certified: false, reasonCode: 'PENDING_ADVICE_DELIVERED', trigger: null, decisionIds: [] } });
      const result = await runLauncher({ harness: name, event: fx.hookKey ?? null }, JSON.stringify(fx.native), { adapters, sidecar: fake.sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() }, Date.now());
      assert.equal(result.exitCode, 0, fx.id);
      const request = fake.calls.find((call) => call.op === 'event' || call.body?.envelope !== undefined);
      assert.ok(request, `${fx.id}: one event request`);
      const shows = request.body.showsExplain;
      assert.equal(typeof shows, 'boolean', `${fx.id}: the request says whether the event can show an explain`);
      // The rendering is the adapter's own, byte for byte.
      assert.equal(result.stdout, adapter.protocolResponse(normalized.event, outcome), fx.id);
      // The line is on the output exactly where the request said an explain can be shown.
      assert.equal(String(result.stdout ?? '').includes(LINE), shows, `${fx.id}: shown only where showsExplain is true`);
      if (String(result.stdout ?? '').length > 0) {
        const parsed = JSON.parse(result.stdout);
        assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `${fx.id}: one JSON object`);
        const wire = JSON.stringify(parsed);
        for (const word of FORBIDDEN) assert.equal(wire.includes(word), false, `${fx.id}: advice is never ${word}`);
        assert.ok(Object.keys(parsed).every((key) => ['systemMessage', 'system', 'injectSteps'].includes(key)), `${fx.id}: only a message key: ${Object.keys(parsed).join(',')}`);
      }
      seen[shows ? 'shown' : 'silent'] += 1;
    }
    assert.ok(events > 0, `${name} has fixtures on the delivery events`);
  }
  assert.ok(seen.shown > 0 && seen.silent > 0, 'both kinds of event are exercised');
});

test('the failure features ride only on a failed call, so a harness without a failure event sends none', async () => {
  // Which harnesses have a failure event is a property of their adapters: Claude Code (PostToolUseFailure),
  // Kilo and OpenCode (a bash call with a non-zero exit, an errored tool part), Codex (an MCP result with
  // isError only) and Antigravity (a PostToolUse with an error). Every fixture that is not a failure sends no `failure`.
  for (const [name, adapter] of Object.entries(adapters)) {
    for (const fx of adapter.FIXTURES) {
      const context = fx.hookKey === undefined ? {} : { hookKey: fx.hookKey };
      const normalized = adapter.normalize(fx.native, context);
      if (!normalized.ok) continue;
      const fake = sidecarAnswering({});
      await runLauncher({ harness: name, event: fx.hookKey ?? null }, JSON.stringify(fx.native), { adapters, sidecar: fake.sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() }, Date.now());
      const body = fake.calls.find((call) => call.body?.envelope !== undefined)?.body;
      if (body === undefined) continue;
      assert.equal(Object.hasOwn(body, 'failure'), normalized.event.kind === 'tool.failed', `${name} ${fx.id}: the features go with a failure event only`);
    }
  }
});
