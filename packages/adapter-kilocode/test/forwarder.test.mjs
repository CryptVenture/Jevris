// KIL-01: the Kilo shim forwards normalized events to the hook launcher as a child process:
// argv carries only the harness name, the event travels on stdin, a slow launcher is cut off,
// and a compaction hook adds the launcher's context lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHooks, spawnForwarder } from '../dist/index.js';

function launcher(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-kilo-fwd-'));
  const path = join(dir, 'launcher.mjs');
  writeFileSync(path, body);
  return { dir, path };
}

test('the forwarder passes the event on stdin, the harness in argv, and returns stdout', async () => {
  const { dir, path } = launcher(
    [
      "import { writeFileSync } from 'node:fs';",
      "let data = '';",
      "process.stdin.on('data', (c) => { data += c; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(new URL('./seen.json', import.meta.url), JSON.stringify({ argv: process.argv.slice(2), data }));",
      "  process.stdout.write(JSON.stringify({ context: ['from launcher'] }));",
      '});',
    ].join('\n'),
  );
  try {
    const forward = spawnForwarder(process.execPath, path, 'kilo');
    const out = await forward(JSON.stringify({ hookKey: 'experimental.session.compacting', input: { sessionID: 's' } }), true);
    assert.deepEqual(JSON.parse(out), { context: ['from launcher'] });
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    assert.deepEqual(seen.argv, ['--harness', 'kilo']);
    assert.equal(JSON.parse(seen.data).input.sessionID, 's');

    const hooks = createHooks(forward, 4000);
    const output = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
    assert.deepEqual(output.context, ['from launcher']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a launcher that hangs is cut off and the compaction hook proceeds without context', async () => {
  const { dir, path } = launcher('setInterval(() => {}, 1000);');
  try {
    const hooks = createHooks(spawnForwarder(process.execPath, path, 'kilo'), 200);
    const output = { context: [] };
    const started = Date.now();
    await hooks['experimental.session.compacting']({ sessionID: 's' }, output);
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(output.context, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fire-and-forget hook returns before the launcher finishes', async () => {
  // The launcher cannot finish until the test releases it, so the hook resolving at all
  // proves it did not wait. No elapsed-time window is asserted (QA-05).
  const { dir, path } = launcher(
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'process.stdin.resume();',
      "const release = new URL('./release', import.meta.url);",
      'const started = Date.now();',
      'const timer = setInterval(() => {',
      '  if (!existsSync(release) && Date.now() - started < 30000) return;',
      '  clearInterval(timer);',
      "  writeFileSync(new URL('./finished', import.meta.url), 'x');",
      '  process.exit(0);',
      '}, 20);',
    ].join('\n'),
  );
  try {
    const hooks = createHooks(spawnForwarder(process.execPath, path, 'kilo'));
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} });
    assert.equal(existsSync(join(dir, 'finished')), false, 'the hook returned while the launcher was still running');
  } finally {
    writeFileSync(join(dir, 'release'), 'x');
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2000);
  }
});

test('G16: the forwarder reports a launcher that cannot start, and one it kills, once each', async () => {
  const missing = [];
  const out = await spawnForwarder(join(tmpdir(), 'jevris-no-such-node'), 'launcher.mjs', 'kilo')('{}', false, (code, ms) => missing.push([code, ms]));
  assert.equal(out, '');
  assert.equal(missing.length, 1);
  assert.equal(missing[0][0], 'SHIM_SPAWN_FAILED');

  const { dir, path } = launcher('setInterval(() => {}, 1000);');
  try {
    const killed = [];
    const answer = await spawnForwarder(process.execPath, path, 'kilo')('{}', true, (code, ms) => killed.push([code, ms]));
    assert.equal(answer, '');
    assert.deepEqual(killed.map(([code]) => code), ['SHIM_KILLED']);
    assert.ok(killed[0][1] >= 4900, String(killed[0][1]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
