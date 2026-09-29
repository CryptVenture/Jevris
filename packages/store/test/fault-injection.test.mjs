import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// The operations drill's disk-full injection (OBS-05, DATA-08): JEVRIS_TEST_STORE_FREE_PAGES
// caps store growth only in test mode; outside it the variable changes nothing.

const INDEX = new URL('../dist/index.js', import.meta.url).href;

function fill(env) {
  const dir = makeTempDir('jevris-store-fault-');
  const script = `
    const s = await import(${JSON.stringify(INDEX)});
    const store = s.openStore({ path: ${JSON.stringify(join(dir, 'jevris.db'))}, role: 'in-process-test', workspaceId: 'host', hostScope: 'hostA' });
    if (!store.ok) { console.log(JSON.stringify({ open: store.reason })); process.exit(0); }
    const ws = s.workspaceView(store, 'wAbc');
    let refused = null;
    for (let i = 0; i < 3000 && refused === null; i += 1) {
      const r = s.appendEvent(ws, { deliveryKey: 'k' + i, nativeKind: 'PostToolUse', payloadHash: 'c'.repeat(64), payloadBytes: 100, receivedAtMs: 10 + i });
      if (!r.ok) refused = r.reason;
    }
    console.log(JSON.stringify({ refused, fault: s.storeFault(store)?.code ?? null }));
    s.closeStore(store);
  `;
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim());
  } finally {
    removeTempDir(dir);
  }
}

test('in test mode a zero free-page limit makes the next growth fail as a full disk and stops owned automation (OBS-05, DATA-08)', () => {
  const result = fill({ ...process.env, JEVRIS_TEST: '1', JEVRIS_TEST_STORE_FREE_PAGES: '0' });
  assert.deepEqual(result, { refused: 'store-full', fault: 'store-full' });
});

test('outside test mode the free-page variable is ignored', () => {
  const env = { ...process.env, JEVRIS_TEST_STORE_FREE_PAGES: '0' };
  delete env.JEVRIS_TEST;
  assert.deepEqual(fill(env), { refused: null, fault: null });
});
