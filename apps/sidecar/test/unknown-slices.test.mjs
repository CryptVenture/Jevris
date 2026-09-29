import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// RTE-10: status lists the task slices route requests named that no released calibration covers,
// as C's router recorded them in the sidecar; it is not a fixed empty list.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');

test('a route request for an uncalibrated slice shows up in status unknownSlices (RTE-10)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-slices-')));
  const root = join(home, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  const started = await startDaemon({ home, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const slice = `b-uncalibrated-${process.pid}`;
    const route = await sidecarRequest({
      home,
      op: 'route',
      scope: 'cli',
      workspace: root,
      timeoutMs: 20_000,
      body: { currentModel: 'claude-sonnet-4-5', modelPin: null, effortPin: null, taskId: null, sliceId: slice, sessionId: 'b-slices' },
    });
    assert.equal(route.ok, true, JSON.stringify(route));
    const status = await sidecarRequest({ home, op: 'status', scope: 'cli', workspace: root, body: {}, timeoutMs: 20_000 });
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.ok(status.result.unknownSlices.includes(slice), JSON.stringify(status.result.unknownSlices));
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
