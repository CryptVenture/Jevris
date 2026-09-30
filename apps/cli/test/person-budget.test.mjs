// A command a person runs does real work (a store write, a network round trip, a git read, a ledger
// transaction), so it never asks the sidecar for the 900 ms hook budget, and it waits longer than
// the sidecar's own background budget. CI failed on this for `control migrate` (windows-latest)
// and `budget update` (ubuntu-latest, DEADLINE at 5.9 s). Table-driven: each command's request is
// captured, so a new command that copies the old 'hot' pattern fails here. lint/person-budget.lint.mjs
// scans the source for a command the table does not list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = (name) => import(`../dist/${name}.js`);
// (route limits clear needs a written access-limit record first; lint/person-budget.lint.mjs covers it.)
const SIDECAR_BACKGROUND_MS = 5000;

const COMMANDS = [
  ['budget status', 'budget-command', 'runBudgetCommand', ['status', 'b1'], 'budget.get'],
  ['budget update', 'budget-command', 'runBudgetCommand', ['update', 'b1', '--resume', '--yes'], 'budget.update'],
  ['task get/cancel', 'task-command', 'runTaskCommand', ['cancel', 't1', '--yes'], 'task.get'],
  ['task reconcile', 'task-command', 'runTaskCommand', ['reconcile', 't1', '--applied', '--yes'], 'task.reconcile'],
  ['feedback', 'feedback-command', 'runFeedbackCommand', ['d-0123abcd-0000-4000-8000-000000000000', '--accepted'], 'decision.feedback'],
  ['integrate status', 'integrate-command', 'runIntegrateCommand', ['status'], 'integration.get'],
  ['integrate run', 'integrate-command', 'runIntegrateCommand', ['T1', 'T2'], 'integration.run'],
  ['control status', 'control-command', 'runControlCommand', ['status'], 'control.status'],
  ['control migrate', 'control-command', 'runControlCommand', ['migrate', '--yes'], 'control.migrate'],
  ['consent status', 'consent-command', 'runConsentCommand', ['provider'], 'provider.consent.status'],
  ['consent revoke', 'consent-command', 'runConsentCommand', ['provider', 'typesafe', '--revoke'], 'provider.consent.revoke'],
  ['route link', 'route-link', 'runRouteLink', ['--task', 't1', '--link'], 'session.link'],
  ['route unlink', 'route-link', 'runRouteLink', ['--unlink'], 'session.unlink'],
  ['credential re-enable', 'credential-reenable', 'runCredentialReenableCommand', [], 'jev.reenable'],
  ['verify required', 'verify-admin', 'runVerifyAdmin', ['required', 'unit'], 'verify.required'],
];

test('every command a person runs asks the sidecar for the background budget and waits past it', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-person-budget-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const seen = [];
  for (const [label, file, fn, argv, op] of COMMANDS) {
    const calls = [];
    const ports = {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          return { ok: false, reason: 'timeout', reasonCode: 'DEADLINE' };
        },
      },
      engine: {},
      config: {},
    };
    const module = await cli(file);
    await module[fn](argv, () => {}, { ports, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'alice', LOGNAME: 'alice' }, cwd: work, confirm: async () => true, interactive: () => true });
    const call = calls.find((c) => c.op === op);
    assert.ok(call, `${label}: sent ${JSON.stringify(calls.map((c) => c.op))}, not ${op}`);
    seen.push(label);
    for (const c of calls) {
      assert.equal(c.budget, 'background', `${label}: ${c.op} is a person's command, not a hook call`);
      assert.ok(c.timeoutMs > SIDECAR_BACKGROUND_MS, `${label}: ${c.op} waits past the ${SIDECAR_BACKGROUND_MS} ms background budget (${c.timeoutMs} ms)`);
    }
  }
  assert.equal(seen.length, COMMANDS.length);
});
