// G16 (harness parity audit): a Kilo or OpenCode shim counts the deliveries it loses before the
// launcher can see them (dropped past the in-flight cap, the launcher not starting, the shim's
// own timeout, the launcher killed at its hard timeout) and carries them as `shimMisses` on the
// next event that reaches the launcher. One miss per delivery; the core is the same in all five
// adapters, so every copy is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(join(root, name, 'dist', 'common.js')) })));

const IDLE = { event: { type: 'session.idle', properties: { sessionID: 's' } } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const { name, core } of cores) {
  test(`${name}: drops past the in-flight cap are counted and carried once on the next delivery`, async () => {
    const sent = [];
    const gates = [];
    const hooks = core.createPluginHooks({
      harness: 'opencode',
      maxInFlight: 1,
      forward: (text) => {
        sent.push(JSON.parse(text));
        return new Promise((resolve) => gates.push(resolve));
      },
    });
    await hooks.event(IDLE);
    await hooks.event(IDLE);
    await hooks.event(IDLE);
    await hooks.event({ event: { type: 'lsp.updated' } });
    assert.equal(sent.length, 1);
    assert.equal(Object.hasOwn(sent[0], 'shimMisses'), false, 'nothing to carry yet');
    gates[0]('');
    await tick();
    await hooks.event(IDLE);
    assert.deepEqual(sent[1].shimMisses, [{ reasonCode: 'SHIM_DROPPED', count: 2, maxMs: 0 }], 'an unrecognised event is not a drop');
    gates[1]('');
    await tick();
    await hooks.event(IDLE);
    assert.equal(Object.hasOwn(sent[2], 'shimMisses'), false, 'carried misses are cleared');
  });

  test(`${name}: a forwarder that throws or reports a spawn failure keeps the carried misses for the next delivery`, async () => {
    const sent = [];
    let mode = 'drop';
    const gates = [];
    const hooks = core.createPluginHooks({
      harness: 'kilocode',
      maxInFlight: 1,
      forward: (text, _wait, onMiss) => {
        const native = JSON.parse(text);
        if (mode === 'throw') throw new Error('spawn failed');
        if (mode === 'report') {
          sent.push(native);
          onMiss('SHIM_SPAWN_FAILED', 3);
          onMiss('SHIM_KILLED', 5000);
          return Promise.resolve('');
        }
        sent.push(native);
        return new Promise((resolve) => gates.push(resolve));
      },
    });
    await hooks.event(IDLE);
    await hooks.event(IDLE);
    gates[0]('');
    await tick();
    mode = 'throw';
    await hooks.event(IDLE);
    mode = 'report';
    await hooks.event(IDLE);
    await tick();
    const first = Object.fromEntries(sent[1].shimMisses.map((item) => [item.reasonCode, item.count]));
    assert.deepEqual(first, { SHIM_DROPPED: 1, SHIM_SPAWN_FAILED: 1 }, 'the throw counted and the drop it carried was kept');
    mode = 'ok';
    await hooks.event(IDLE);
    const carried = Object.fromEntries(sent[2].shimMisses.map((item) => [item.reasonCode, item.count]));
    assert.deepEqual(carried, { SHIM_DROPPED: 1, SHIM_SPAWN_FAILED: 2 }, 'a spawn failure puts back what it carried; only the first report of a delivery counts');
  });

  test(`${name}: a compaction the shim stops waiting for is one SHIM_TIMEOUT at its limit`, async () => {
    const sent = [];
    const hooks = core.createPluginHooks({
      harness: 'opencode',
      responseTimeoutMs: 20,
      forward: (text, wait, onMiss) => {
        sent.push(JSON.parse(text));
        if (!wait) return Promise.resolve('');
        // The launcher is killed later too: the delivery is still one miss.
        setTimeout(() => onMiss('SHIM_KILLED', 5000), 40);
        return new Promise(() => {});
      },
    });
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await hooks.event(IDLE);
    assert.deepEqual(sent[1].shimMisses, [{ reasonCode: 'SHIM_TIMEOUT', count: 1, maxMs: 20 }]);
  });
}
