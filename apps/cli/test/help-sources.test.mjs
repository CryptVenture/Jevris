// One source per command's help (ADM-01, UDOC-08): `jevris help <cmd>` prints exactly what
// the owning handler prints for `<cmd> --help`, and the top-level usage lists every command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';
const { main } = await import('../dist/cli.js');
const { helpText } = await import('../dist/admin-cli.js');
const { OPERATOR_HELP } = await import('../dist/operator-help.js');
const { PUBLIC_HELP, EVIDENCE_HELP } = await import('../dist/public-commands.js');
const { TASK_HELP } = await import('../dist/task-command.js');
const { PUBLIC_COMMAND_NAMES } = await import('../../../packages/contracts/dist/index.js');

const ADMIN = ['install', 'uninstall', 'doctor', 'certify'];
const OPERATOR = ['credential', 'policy', 'shadow', 'shortlist'];
// Families whose handler prints its own help (B: sidecar, kill-switch, data, store, audit,
// authorize; A: gates).
const OWN = ['sidecar', 'kill-switch', 'gates', 'data', 'store', 'audit', 'authorize', 'cost-report', 'delivery', 'integrate', 'advise', 'budget', 'control', 'egress', 'feedback', 'consent'];

async function run(argv) {
  let text = '';
  const code = await main(argv, (chunk) => (text += chunk));
  return { code, text };
}

test('help for every command comes from its one source', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'jevris-help-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.JEVRIS_HOME = home;
  const nl = (text) => (text.endsWith('\n') ? text : `${text}\n`);
  for (const name of ADMIN) {
    const source = helpText(name);
    assert.equal(typeof source, 'string', `${name} has admin help`);
    assert.equal((await run(['help', name])).text, nl(source), `help ${name} is admin-cli's text`);
  }
  assert.match(helpText('install'), /--dry-run/);
  assert.match(helpText('install'), /--yes/);
  for (const name of OPERATOR) {
    assert.equal((await run(['help', name])).text, nl(OPERATOR_HELP[name]), `help ${name}`);
    const own = await run([name, '--help']);
    assert.equal(own.code, 0);
    assert.equal(own.text, nl(OPERATOR_HELP[name]), `${name} --help`);
  }
  for (const name of PUBLIC_COMMAND_NAMES) {
    assert.equal((await run(['help', name])).text, nl(PUBLIC_HELP[name]));
    assert.equal((await run([name, '--help'])).text, nl(PUBLIC_HELP[name]));
    assert.match(PUBLIC_HELP[name], /Exit codes:/);
    assert.match(PUBLIC_HELP[name], /Examples?:/);
  }
  assert.equal((await run(['help', 'evidence'])).text, nl(EVIDENCE_HELP));
  assert.equal((await run(['help', 'task'])).text, nl(TASK_HELP));
  assert.equal((await run(['task', '--help'])).text, nl(TASK_HELP));
  assert.match(TASK_HELP, /Exit codes:/);
  for (const name of OWN) {
    const own = await run([name, '--help']);
    assert.match(own.text, /^[Uu]sage: jevris /, `${name} --help`);
    assert.equal((await run(['help', name])).text, own.text, `help ${name} is ${name} --help`);
  }
  assert.equal((await run(['help', 'no-such-command'])).code, 2);
});

test('the top-level usage lists every public, administration and operator command', async () => {
  const { text } = await run(['--help']);
  for (const name of [...PUBLIC_COMMAND_NAMES, 'evidence', 'task', ...ADMIN, ...OPERATOR, ...OWN]) {
    assert.match(text, new RegExp(`(^|[\\s,])${name}([\\s,]|$)`, 'm'), name);
  }
});
