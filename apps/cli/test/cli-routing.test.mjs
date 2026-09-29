// cli.ts hosts dispatch lines from several domains. Each command family must reach its own
// handler, not the generic parser: a rewrite that drops a dispatch line fails here at once.
// Add a row when a domain adds a command family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
const { main } = await import('../dist/cli.js');

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

// The generic parser answers an unknown shape with exactly "refused".
const GENERIC_REFUSAL = 'refused\n';

const ROUTES = [
  // [owner, argv (home appended), what the owning handler prints]
  ['B sidecar lifecycle', ['sidecar', 'status'], /^sidecar: /],
  ['A release gates', ['gates', '--help'], /^Usage: jevris gates/],
  ['E public commands', ['status', '--json'], /^\{"schemaVersion":"1\.0","command":"status"/],
  ['E public help', ['route', '--help'], /^Usage: jevris route/],
  ['E global help', ['--help'], /^Usage: jevris <command>/],
  ['E version', ['--version'], /^jevris \d+\.\d+\.\d+/],
  ['E evidence', ['evidence', '--help'], /^Usage: jevris evidence get/],
  ['E evidence help topic', ['help', 'evidence'], /^Usage: jevris evidence get/],
  ['E task reconcile', ['task', '--help'], /^Usage: jevris task reconcile/],
  ['E verify administration', ['verify', 'profile', '--help'], /^Usage: jevris verify/],
  ['F administration', ['doctor', '--help'], /jevris doctor/],
];

test('each command family reaches its own handler', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-routing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const saved = process.env.JEVRIS_HOME;
  process.env.JEVRIS_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.JEVRIS_HOME;
    else process.env.JEVRIS_HOME = saved;
  });
  for (const [owner, argv, expected] of ROUTES) {
    const { text } = await run(argv);
    assert.notEqual(text, GENERIC_REFUSAL, `${owner}: ${argv.join(' ')} fell through to the generic parser`);
    assert.match(text, expected, `${owner}: ${argv.join(' ')}`);
  }
});
