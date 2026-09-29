import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// IPC-09: one canonical workspace id. The CLI and MCP public context, the orchestrator and the
// sidecar all name a checkout by its root identity (device, inode, birth time), so a decision
// recorded under the id a surface prints is found by explain and status through the sidecar.

const { startDaemon, sidecarRequest, workspaceIdentity } = await import('../dist/index.js');
const { workspaceIdFor: orchestratorId } = await import('@jevris/orchestrator');
const { createSurfaceContext, workspaceIdFor: surfaceId } = await import('../../cli/dist/public/context.js');

test('the surface, orchestrator and sidecar give a checkout one workspace id (IPC-09)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-wsid-')));
  const root = join(home, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  try {
    const context = createSurfaceContext({ home, cwd: join(root), env: { JEVRIS_HOME: home }, ports: {} });
    assert.equal(context.workspaceRoot, realpathSync(root));
    assert.match(context.workspaceId, /^w[0-9a-f]{24}$/);
    assert.equal(context.workspaceId, surfaceId(root));
    assert.equal(context.workspaceId, orchestratorId(root));
    assert.equal(context.workspaceId, workspaceIdentity(root).id);
    const started = await startDaemon({ home, packageOps: false, idleMs: 0, store: false, log: () => undefined });
    assert.equal(started.ok, true);
    try {
      const registered = await sidecarRequest({ home, op: 'workspace.register', scope: 'cli', workspace: root });
      assert.equal(registered.ok, true, JSON.stringify(registered));
      assert.equal(registered.result.id, context.workspaceId, 'the id the CLI prints is the id the sidecar filters by');
      // The id itself also resolves to the checkout.
      const byId = await sidecarRequest({ home, op: 'workspace.register', scope: 'cli', workspace: context.workspaceId });
      assert.equal(byId.result.root, realpathSync(root));
    } finally {
      await started.daemon.stop('test');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
