// W10 on windows-latest (CI run 37329307976): `jevris_handoff_import` came back as the local reduced import (reason code IMPORTED, not
// IMPORTED_ACTUATE) because the CLI behind the MCP tool waited 5 s for the sidecar while the runner's budget scale (6) had lengthened the
// sidecar's own background budget to 30 s: the sidecar was still answering when the client left. A surface call now waits what the sidecar's
// background budget is in that run, the 5 s times the test budget scale (JEVRIS_TEST=1 with JEVRIS_TEST_BUDGET_SCALE, which acts only in a
// test run), and 5 s outside one. What a request asks for is read from the fake sidecar port, not timed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { SURFACE_REQUEST_TIMEOUT_MS, createSurfaceContext, surfaceRequestTimeoutMs } = await import('../dist/public/context.js');
const { runOperation } = await import('../dist/public/operations.js');

test('a surface call waits the background budget: 5 s, times the budget scale only in a test run', () => {
  assert.equal(SURFACE_REQUEST_TIMEOUT_MS, 5000);
  assert.equal(surfaceRequestTimeoutMs({}), 5000);
  assert.equal(surfaceRequestTimeoutMs({ JEVRIS_TEST: '1' }), 5000);
  assert.equal(surfaceRequestTimeoutMs({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }), 30_000);
  assert.equal(surfaceRequestTimeoutMs({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '1' }), 5000);
  // The scale acts only under JEVRIS_TEST=1, and only as a number the product accepts.
  assert.equal(surfaceRequestTimeoutMs({ JEVRIS_TEST_BUDGET_SCALE: '6' }), 5000, 'a real run is never scaled');
  assert.equal(surfaceRequestTimeoutMs({ JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: 'many' }), 5000);
});

test('the surface asks the sidecar with that wait, for the handoff import as for every operation', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-surface-timeout-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const asked = [];
  const ports = {
    sidecar: {
      ensure: async () => ({ ok: true, endpoint: 'fake', started: false }),
      request: async (input) => {
        asked.push({ op: input.op, timeoutMs: input.timeoutMs, budget: input.budget });
        return { ok: false, reason: 'timeout', reasonCode: 'SIDECAR_TIMEOUT', message: 'The sidecar did not answer.' };
      },
    },
    engine: {},
    config: {},
  };
  const input = { capsule: { schemaVersion: 'jevris-capsule-1' } };
  for (const [env, expected] of [
    [{ JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' }, 5000],
    [{ JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_TEST: '1', JEVRIS_TEST_BUDGET_SCALE: '6' }, 30_000],
  ]) {
    asked.length = 0;
    const ctx = createSurfaceContext({ home, workspace, scope: 'mcp', env, ports });
    assert.equal(ctx.requestTimeoutMs, expected);
    await runOperation(ctx, 'status', {});
    await runOperation(ctx, 'handoff.import', input);
    assert.ok(asked.length >= 1, 'the sidecar was asked');
    assert.deepEqual([...new Set(asked.map((a) => a.timeoutMs))], [expected], JSON.stringify(asked));
    assert.ok(asked.every((a) => a.budget === 'background'), 'a surface call asks for the background budget');
  }
});
