// JEV-0050 through the CLI: `jevris configure set privacy.sourceEgress approved-scoped` is the
// person's own half of source-egress consent. Raising it needs a person at an interactive terminal
// who answers y; a pipe, --yes, --json and a test run are refused with CHANNEL_REFUSED before
// anything is asked, MCP never changes settings, a lowering and a dry run ask no one, every written
// change goes in the audit log, and the effective egress decision stays the administrator's: the
// preference alone approves nothing. Fake ports and a temporary home: no sidecar, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');
const { runEgressCommand } = await import('../dist/egress-command.js');
const { createSurfaceContext } = await import('../dist/public/context.js');
const { runOperation } = await import('../dist/public/operations.js');
const orchestrator = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

const KEY = 'privacy.sourceEgress';
const RAISE = 'approved-scoped';
const DENY = 'deny-until-approved';
const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-configure-egress-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { dir, home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

/** No sidecar; D's real setter, so configure set runs the product's own path. */
function ports() {
  return {
    sidecar: { ensure: async () => ({ ok: true, endpoint: 'fake', started: false }), request: async () => NOT_RUNNING },
    engine: {},
    config: { setConfigValue: orchestrator.setConfigValue },
  };
}

async function run(box, argv, extra = {}) {
  let text = '';
  const code = await runPublicCommand('configure', argv, (chunk) => (text += chunk), { ports: extra.ports ?? ports(), env: extra.env ?? box.env, cwd: box.workspace, ...(extra.terminal === undefined ? {} : { interactive: () => true, confirm: async (q) => (extra.terminal.asked.push(q), extra.terminal.answer) }) });
  return { code, text };
}

const atTerminal = (answer = true) => ({ asked: [], answer });
const refusal = `Nothing was changed (CHANNEL_REFUSED): raising ${KEY} to ${RAISE} is your half of the consent for what may leave this machine, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n`;
const prompt = `Raise ${KEY} to ${RAISE}? It is your half of the consent for advice that quotes your text to Jev; nothing is sent until an administrator also approves egress (jevris egress approve). [y/N] `;
const preference = (box) => orchestrator.readEffectiveConfig({ home: box.home }).config.privacy.sourceEgress;

/** The audit rows the CLI left for this home: the sidecar is not running, so they wait in a private file. */
function auditRows(box) {
  const file = join(jevrisPaths({ home: box.home }).state, 'audit-pending.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [];
}

test('configure set privacy.sourceEgress approved-scoped: a person at a terminal answers y; every other channel is refused before anything is asked', async (t) => {
  const box = sandbox(t);
  const never = atTerminal();
  // A pipe, --yes at a terminal, --json at a terminal and a test run: refused with B's line, nothing asked, nothing written.
  assert.deepEqual(Object.values(await run(box, ['set', KEY, RAISE])), [2, refusal]);
  assert.deepEqual(Object.values(await run(box, ['set', KEY, RAISE, '--yes'], { terminal: never })), [2, refusal]);
  const json = await run(box, ['set', KEY, RAISE, '--json'], { terminal: never });
  assert.deepEqual([json.code, JSON.parse(json.text)], [2, { error: { code: 'CHANNEL_REFUSED', message: refusal.trim() } }]);
  assert.equal((await run(box, ['set', KEY, RAISE], { terminal: never, env: { ...box.env, JEVRIS_TEST: '1' } })).code, 2);
  assert.deepEqual(never.asked, []);
  assert.equal(preference(box), DENY, 'nothing was written');
  assert.deepEqual(auditRows(box), [], 'a refusal writes no audit row');
  // A dry run shows the change and asks nobody.
  const dry = JSON.parse((await run(box, ['set', KEY, RAISE, '--dry-run', '--json'])).text);
  assert.deepEqual([dry.result.dryRun, dry.result.changed], [true, [{ key: KEY, from: DENY, to: RAISE }]]);
  assert.equal(preference(box), DENY);
  assert.deepEqual(auditRows(box), []);

  // A person who says no: nothing changes. One who says y: written, with the exact question asked.
  const no = atTerminal(false);
  assert.deepEqual(Object.values(await run(box, ['set', KEY, RAISE], { terminal: no })), [2, 'Nothing was changed.\n']);
  assert.deepEqual(no.asked, [prompt]);
  assert.equal(preference(box), DENY);
  const yes = atTerminal(true);
  const set = await run(box, ['set', KEY, RAISE], { terminal: yes });
  assert.equal(set.code, 0, set.text);
  assert.deepEqual(yes.asked, [prompt]);
  assert.equal(preference(box), RAISE);
  assert.match(set.text, new RegExp(`^changed: ${KEY.replace('.', '\\.')} ${DENY} -> ${RAISE}$`, 'm'));
  // The change is in the audit log, content-free.
  assert.deepEqual(auditRows(box).map((r) => [r.kind, r.detail]), [['policy.change', { action: 'configure.set', key: KEY, from: DENY, to: RAISE }]]);

  // Lowering asks no one, even under --yes or --json, and is audited too; the same value changes nothing and writes no row.
  assert.equal((await run(box, ['set', KEY, RAISE, '--yes'])).code, 0);
  assert.equal(auditRows(box).length, 1, 'an unchanged value writes no row');
  const lowered = JSON.parse((await run(box, ['set', KEY, DENY, '--json'])).text);
  assert.deepEqual(lowered.result.changed, [{ key: KEY, from: RAISE, to: DENY }]);
  assert.equal(preference(box), DENY);
  assert.deepEqual(auditRows(box).map((r) => r.detail.to), [RAISE, DENY]);
  // A value that is not one of the two is refused as a value, not as an administrator's key.
  const bad = await run(box, ['set', KEY, 'allowed']);
  assert.equal(bad.code, 2);
  assert.match(bad.text, /"allowed" is not a valid value for privacy\.sourceEgress/);
});

test('the same rules hold without D\'s setter (the local fallback)', async (t) => {
  const box = sandbox(t);
  const local = { ...ports(), config: {} };
  const never = atTerminal();
  assert.deepEqual(Object.values(await run(box, ['set', KEY, RAISE], { ports: local })), [2, refusal]);
  assert.deepEqual(Object.values(await run(box, ['set', KEY, RAISE, '--yes'], { ports: local, terminal: never })), [2, refusal]);
  assert.deepEqual(never.asked, []);
  assert.equal(preference(box), DENY);
  assert.equal((await run(box, ['set', KEY, RAISE], { ports: local, terminal: atTerminal() })).code, 0);
  assert.equal(preference(box), RAISE);
  assert.equal((await run(box, ['set', KEY, DENY], { ports: local })).code, 0);
  assert.equal(preference(box), DENY);
});

test('MCP never changes the preference, whatever the value', async (t) => {
  const box = sandbox(t);
  for (const value of [RAISE, DENY]) {
    const ctx = createSurfaceContext({ home: box.home, workspace: undefined, scope: 'mcp', ports: ports(), env: box.env, cwd: box.workspace });
    const outcome = await runOperation(ctx, 'configure', { key: KEY, value });
    assert.equal(outcome.ok, false, value);
    assert.match(outcome.message, /never from a model tool call/, value);
  }
  assert.equal(orchestrator.readEffectiveConfig({ home: box.home }).config.privacy.sourceEgress, DENY);
  assert.deepEqual(auditRows(box), []);
});

test('the preference alone approves nothing: configure show and egress status still say denied until the administrator approves', async (t) => {
  const box = sandbox(t);
  assert.equal((await run(box, ['set', KEY, RAISE], { terminal: atTerminal() })).code, 0);
  const shown = JSON.parse((await run(box, ['show', '--json'])).text).result.effective;
  assert.deepEqual([shown.sourceEgress, shown.sourceEgressSource, shown.sourceEgressPreference], [DENY, 'host-policy', RAISE]);
  assert.match((await run(box, ['show'])).text, new RegExp(`^source egress: ${DENY} \\(host policy; see jevris egress status\\); your jevris.config.json preference: ${RAISE}$`, 'm'));
  // The egress command reads the administrator's side only: no host.json, so denied; and configure set wrote none.
  let out = '';
  const code = await runEgressCommand(['status', '--home', box.home, '--json'], (chunk) => (out += chunk), { env: box.env, resolveEgress: async () => 'not-approved' });
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).egress, 'not-approved');
  assert.equal(existsSync(join(jevrisPaths({ home: box.home }).config, 'host.json')), false, 'configure set never writes host.json');
  assert.equal(orchestrator.egressPreferenceApproved({ home: box.home }, { workspaceRoot: null }), true, 'the person\'s half is on');
});

test('configure --help says how the preference is set and that the administrator\'s half is separate', async () => {
  let text = '';
  assert.equal(await runPublicCommand('configure', ['--help'], (chunk) => (text += chunk), {}), 0);
  assert.match(text, /Whether Jevris may send text to Jev is the administrator's\s+decision \(jevris egress approve\); set privacy\.sourceEgress records only your own half of\s+that consent \(approved-scoped, or deny-until-approved to take it back\), and nothing is sent\s+without both\./);
  assert.match(text, /privacy\.sourceEgress \(to approved-scoped\)/);
  assert.match(text, /^\s+privacy\.sourceEgress\b/m, 'it is listed among the settable keys');
  assert.doesNotMatch(text, /source egress needs administrator approval/);
});
