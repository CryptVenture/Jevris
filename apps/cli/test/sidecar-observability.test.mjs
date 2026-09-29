import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// OBS-02, OBS-03 through the CLI: `jevris sidecar metrics`, `jevris sidecar diagnose` and
// `jevris sidecar statusline` (read from the cache file, no sidecar call).

const { main } = await import('../dist/cli.js');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');

function capture() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

async function run(args) {
  const out = capture();
  const code = await main(args, out.write);
  return { code, text: out.text() };
}

test('jevris sidecar metrics, diagnose and statusline (OBS-02, OBS-03)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-obs-cli-')));
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  try {
    // Nothing has run: the status line says so, from no file, with no sidecar started.
    let r = await run(['sidecar', 'statusline', '--home', home]);
    assert.equal(r.code, 0);
    assert.equal(r.text, 'jevris: sidecar not running (rules-only)\n');
    r = await run(['sidecar', 'metrics', '--home', home]);
    assert.equal(r.code, 1);
    assert.match(r.text, /not running/);
    r = await run(['sidecar', 'diagnose', 'on', '--minutes', '90', '--home', home]);
    assert.equal(r.code, 2, 'more than an hour is refused before anything starts');
    r = await run(['sidecar', 'diagnose', 'status', '--home', home]);
    assert.equal(r.code, 0);
    assert.match(r.text, /off/);

    assert.equal((await run(['sidecar', 'start', '--home', home])).code, 0);
    r = await run(['sidecar', 'diagnose', 'on', '--minutes', '5', '--home', home]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /diagnostic mode: on until .*never content/);
    r = await run(['sidecar', 'diagnose', 'status', '--home', home, '--json']);
    assert.equal(JSON.parse(r.text).active, true);
    r = await run(['sidecar', 'metrics', '--home', home, '--hours', '2']);
    assert.equal(r.code, 0, r.text);
    for (const field of ['window: last 2 h', 'decisions: 0', 'abstentions: 0', 'latency Jev: none', 'cost: $0.0000 actual', 'requests since start:', 'traces:', 'diagnostic mode: on until']) {
      assert.ok(r.text.includes(field), `${field}\n${r.text}`);
    }
    r = await run(['sidecar', 'metrics', '--home', home, '--json']);
    const metrics = JSON.parse(r.text);
    assert.equal(metrics.windowHours, 24);
    assert.equal(typeof metrics.requests.requests, 'number');
    assert.equal((await run(['sidecar', 'diagnose', 'off', '--home', home])).text, 'diagnostic mode: off\n');

    // The cache is written at start and after requests; statusline reads it without a request.
    const until = Date.now() + 5000;
    do {
      r = await run(['sidecar', 'statusline', '--home', home]);
      if (r.text.startsWith('jevris: ') && !r.text.includes('not running')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < until);
    assert.match(r.text, /^jevris: (rules-only|Jev|degraded) · \d+ decisions today/);
    r = await run(['sidecar', 'statusline', '--home', home, '--json']);
    assert.equal(JSON.parse(r.text).cache.sidecar, 'running');
  } finally {
    await run(['sidecar', 'stop', '--home', home]);
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    rmSync(home, { recursive: true, force: true });
  }
  const after = await run(['sidecar', 'statusline', '--home', home]);
  assert.equal(after.text, 'jevris: sidecar not running (rules-only)\n');
});
