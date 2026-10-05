import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, workflow } from './lib.mjs';

// W07: Jev answers 529 (overloaded), then its network policy prohibits it, then it comes back.
// Decisions meet their deadline with the error class recorded and fall back to local rules; the
// calls stay bounded and go nowhere else; status says decisions are degraded; the open breaker
// sends nothing; and when Jev returns, the bounded health probe restores observation first, not
// automation (SSOT §13 W07, PRV-08, C54).

const FAILURE = ['--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14'];
/** The shortest native budget Jevris answers inside: a Claude Code hook or an MCP tool call. */
const NATIVE_TIMEOUT_MS = 60_000;
/** Attempts per decision (BACKGROUND_RETRY_POLICY). */
const MAX_ATTEMPTS = 4;

function timed(fn) {
  const started = Date.now();
  const out = fn();
  return { out, elapsedMs: Date.now() - started };
}

workflow('W07', 'Jev unavailable or the developer goes offline', async ({ t, then, sandbox, evidence }) => {
  const down = await startJevStub(t, { scenario: 'http-529' });
  // The subject is the engine meeting its deadline, so the sidecar keeps the product's exact budgets whatever scale the runner sets (test/budget-scale.mjs).
  const box = await sandbox({ exactBudgets: true });
  const { jevrisPaths } = await load('platform');
  const paths = jevrisPaths({ home: box.home, env: box.env });
  const circuitFile = join(paths.state, 'jev-circuit.json');
  const circuit = () => {
    try {
      return Object.values(JSON.parse(readFileSync(circuitFile, 'utf8')).entries ?? {});
    } catch {
      return [];
    }
  };
  const run = (argv, env) => box.jevris(argv, { json: true, extraEnv: env });

  // Outage: 529 until the breaker opens.
  assert.equal(box.jevris(['sidecar', 'start', '--home', box.home], { extraEnv: down.env }).code, 0);
  const attempts = [];
  for (let i = 0; i < 4 && !circuit().some((entry) => entry.state === 'open'); i += 1) {
    const before = down.requests().length;
    const answer = timed(() => run(['recover', ...FAILURE], down.env));
    attempts.push({ ...answer, calls: down.requests().length - before });
  }
  const openState = circuit().map((entry) => entry.state);
  const callsWhenOpen = down.requests().length;
  const whileOpen = timed(() => run(['recover', ...FAILURE], down.env));
  const statusDown = run(['status'], down.env);
  const openDecisions = statusDown.json?.result?.recentDecisions ?? [];

  // Jev comes back: the cooldown has passed (the persisted open time is moved back past it).
  const up = await startJevStub(t, { scenario: 'valid' });
  box.jevris(['sidecar', 'stop', '--home', box.home]);
  const saved = JSON.parse(readFileSync(circuitFile, 'utf8'));
  for (const entry of Object.values(saved.entries)) if (entry.state === 'open') entry.openedAtMs = Date.now() - 120_000;
  writeFileSync(circuitFile, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  assert.equal(box.jevris(['sidecar', 'start', '--home', box.home], { extraEnv: up.env }).code, 0);
  const back = timed(() => run(['recover', ...FAILURE], up.env));
  const until = Date.now() + 60_000;
  while (!circuit().some((entry) => entry.state !== 'open' && entry.state !== 'half-open') && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  const restored = circuit().map((entry) => entry.state);
  const statusUp = run(['status'], up.env);
  const log = box.read(join(relative(box.dir, paths.state), 'logs', 'sidecar.log'));
  evidence({ attempts: attempts.map((a) => [a.elapsedMs, a.calls]), openState, restored, probeCalls: up.requests().length });

  await then('the decision engine meets its deadline, records the error class and uses the fallback', () => {
    assert.ok(attempts.length >= 1);
    for (const attempt of attempts) {
      assert.equal(attempt.out.code, 0, attempt.out.stderr);
      assert.ok(attempt.elapsedMs < NATIVE_TIMEOUT_MS / 2, `recover took ${attempt.elapsedMs} ms`);
      assert.equal(typeof attempt.out.json?.result?.action, 'string', 'the command answered from local rules');
    }
    assert.ok(openDecisions.length >= 1, 'the fallback decisions were not recorded');
    assert.ok(openDecisions.every((row) => row.outcome !== 'applied'), JSON.stringify(openDecisions));
    assert.ok(openDecisions.some((row) => /^(?:OVERLOADED|PROVIDER_[A-Z_]+|CIRCUIT_OPEN|RATE_LIMITED)$/.test(row.reasonCode)), JSON.stringify(openDecisions));
  });

  await then('calls stay bounded, the open breaker sends nothing and no source goes to another provider', () => {
    for (const attempt of attempts) assert.ok(attempt.calls <= MAX_ATTEMPTS, `${attempt.calls} calls for one decision`);
    assert.ok(openState.includes('open'), `the breaker never opened: ${openState}`);
    assert.equal(whileOpen.out.code, 0, whileOpen.out.stderr);
    assert.equal(down.requests().length, callsWhenOpen, 'a decision called Jev while the breaker was open');
    for (const request of [...down.requests(), ...up.requests()]) assert.equal(request.path, '/v1/systemone');
    assert.match(log, /not production/);
  });

  await then('status indicates rules-only or degraded advice', () => {
    assert.equal(statusDown.code, 0, statusDown.stderr);
    assert.equal(statusDown.json?.result?.decisionHealth, 'degraded', JSON.stringify(statusDown.json?.result));
    assert.match(statusDown.json?.result?.degradedReason ?? '', /Jev is unavailable|rules-only/);
  });

  await then('when connectivity returns, a bounded health probe restores observation first', () => {
    assert.equal(back.out.code, 0, back.out.stderr);
    assert.ok(up.requests().length >= 1, 'no health probe reached Jev after it came back');
    assert.ok(up.requests().length <= MAX_ATTEMPTS + 1, `${up.requests().length} calls after Jev came back`);
    // One success restores observation, not automation: automation needs repeated successes.
    assert.ok(restored.includes('observe-only'), `the breaker is ${restored}, not observe-only`);
    assert.ok(!restored.includes('closed'), 'one probe restored automation');
    assert.equal(statusUp.code, 0, statusUp.stderr);
  });
});
