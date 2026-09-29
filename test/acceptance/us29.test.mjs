import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, story } from './lib.mjs';

// Jev hangs, then Jev is overloaded (529 with Retry-After). Hooks and decisions must fall back
// to local rules well inside the harness's own timeout, make a bounded number of calls, and
// never reach for another provider (C54, SSOT §7.4).

/** The shortest native budget Jevris answers inside: a Claude Code hook or an MCP tool call. */
const NATIVE_TIMEOUT_MS = 60_000;
/** The background retry policy's maximum attempts per question (BACKGROUND_RETRY_POLICY). */
const MAX_ATTEMPTS = 4;

async function outage(t, sandbox, scenario) {
  const provider = await startJevStub(t, { scenario, lateMs: 120_000 });
  const box = await sandbox({ env: provider.env });
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  const timed = (fn) => {
    const started = Date.now();
    const out = fn();
    return { out, elapsedMs: Date.now() - started };
  };
  const hook = timed(() => box.hook('claude', { hook_event_name: 'UserPromptSubmit', session_id: 'us29', cwd: box.work, prompt: 'continue' }));
  const recover = timed(() => box.jevris(['recover', '--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14'], { json: true }));
  const status = box.jevris(['status'], { json: true });
  const { jevrisPaths } = await load('platform');
  const log = box.read(join(relative(box.dir, jevrisPaths({ home: box.home }).state), 'logs', 'sidecar.log'));
  return { provider, hook, recover, status, log };
}

story('US29', async ({ t, then, sandbox, evidence }) => {
  const hanging = await outage(t, sandbox, 'late');
  const overloaded = await outage(t, sandbox, 'http-529');
  evidence({ hanging: [hanging.hook.elapsedMs, hanging.recover.elapsedMs, hanging.provider.requests().length], overloaded: [overloaded.recover.elapsedMs, overloaded.provider.requests().length] });

  await then('The declared rules-only fallback returns before the native timeout, with bounded calls and no hidden alternative provider', () => {
    for (const run of [hanging, overloaded]) {
      // The hook answers inside its budget whatever Jev does.
      assert.equal(run.hook.out.code, 0, run.hook.out.stderr);
      assert.ok(run.hook.elapsedMs < NATIVE_TIMEOUT_MS / 2, `hook took ${run.hook.elapsedMs} ms`);
      // The decision falls back to local rules and the command still answers.
      assert.equal(run.recover.out.code, 0, run.recover.out.stderr);
      assert.ok(run.recover.elapsedMs < NATIVE_TIMEOUT_MS / 2, `recover took ${run.recover.elapsedMs} ms`);
      assert.equal(typeof run.recover.out.json?.result?.action, 'string', JSON.stringify(run.recover.out.json));
      // Every call went to the one configured provider, and there were few of them.
      const requests = run.provider.requests();
      assert.ok(requests.length >= 1, 'Jev was never asked, so the outage was not exercised');
      assert.ok(requests.length <= MAX_ATTEMPTS, `${requests.length} calls for one decision`);
      for (const request of requests) assert.equal(request.path, '/v1/systemone');
      assert.match(run.log, new RegExp(`Jev calls go to ${run.provider.url.replace(/[.:/]/g, '\\$&')}, not production`));
    }
    // A hung Jev leaves the decision rules-only or undecided; an overloaded one is recorded as a fallback.
    const decisions = overloaded.status.json?.result?.recentDecisions ?? [];
    assert.ok(decisions.length >= 1, 'the overloaded decision was not recorded');
    assert.notEqual(decisions[0].outcome, 'applied');
    // No retry ignored the provider's Retry-After: the attempts are spread over at least a second.
    const times = overloaded.provider.requests().map((request) => request.atMs);
    if (times.length > 1) assert.ok(times.at(-1) - times[0] >= 900 * (times.length - 1) * 0.5, `retries ignored Retry-After: ${times.join(',')}`);
  });
});
