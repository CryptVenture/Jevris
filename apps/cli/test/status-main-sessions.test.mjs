// OD-8: `jevris status` shows, per harness, the main-session mode `routing.mainSession` gives it
// and whether its turns can be switched at all (D's mainSessionView). Without the sidecar no
// certification is read, so no harness shows turns as switchable. Explain shows the mode a
// main-session turn decision ran under. Temp home, no sidecar, no harness binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../../bin/jevris.mjs', import.meta.url));
const { mainSessionsLines, mainSessionExplainLine } = await import('../dist/public/render.js');
const { surfacePayloadContract } = await import('../../../packages/contracts/dist/index.js');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-status-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, JEVRIS_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), JEVRIS_SIDECAR_AUTOSTART: '0', CLAUDE_PROJECT_DIR: work };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: work, encoding: 'utf8', input: '' });
  return { run };
}

test('status with routing.mainSession advice-only shows every harness as advice only, with the reason', (t) => {
  const { run } = sandbox(t);
  const set = run('configure', 'set', 'routing.mainSession', 'advice-only');
  assert.equal(set.status, 0, set.stderr);
  const out = run('status', '--json');
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout).result;
  assert.deepEqual(result.mainSessions.map((v) => v.harness), ['claude', 'kilocode', 'codex', 'opencode', 'antigravity']);
  for (const v of result.mainSessions) {
    assert.equal(v.mode, 'advice-only');
    assert.equal(v.turnSwitching, 'advice-only');
    assert.equal(v.reasonCode, 'MAIN_SESSION_ADVICE_ONLY');
  }
  assert.equal(surfacePayloadContract('status').validate(result).ok, true);
  const human = run('status');
  assert.match(human.stdout, /^main session kilocode: advice-only, advice only: routing\.mainSession is not plugin-bounded-auto \(MAIN_SESSION_ADVICE_ONLY\)$/m);
});

test('status with plugin-bounded-auto (the default) shows Kilo and OpenCode uncertified without the sidecar, the rest advice only', (t) => {
  const { run } = sandbox(t);
  const out = run('status', '--json');
  assert.equal(out.status, 0, out.stderr);
  const byHarness = Object.fromEntries(JSON.parse(out.stdout).result.mainSessions.map((v) => [v.harness, v]));
  for (const h of ['kilocode', 'opencode']) assert.deepEqual(byHarness[h], { harness: h, mode: 'plugin-bounded-auto', turnSwitching: 'advice-only', reasonCode: 'TURN_ROUTE_UNCERTIFIED' });
  for (const h of ['claude', 'codex', 'antigravity']) assert.deepEqual(byHarness[h], { harness: h, mode: 'advice-only', turnSwitching: 'advice-only', reasonCode: 'HARNESS_ADVICE_ONLY' });
  const human = run('status');
  assert.match(human.stdout, /^main session opencode: plugin-bounded-auto, advice only: turn switching is not certified for this harness; run jevris certify \(TURN_ROUTE_UNCERTIFIED\)$/m);
});

test('the status line says when turns may be switched, and the contract refuses an unknown value', (t) => {
  assert.deepEqual(mainSessionsLines([{ harness: 'kilocode', mode: 'plugin-bounded-auto', turnSwitching: 'possible', reasonCode: null }]), [
    'main session kilocode: plugin-bounded-auto, turns may be switched (each turn still needs a linked session, low risk and budget)',
  ]);
  assert.deepEqual(mainSessionsLines([]), ['main sessions: unknown']);
  assert.deepEqual(mainSessionsLines([{ harness: 'codex', mode: 'advice-only', turnSwitching: 'advice-only', reasonCode: 'SOMETHING_NEW' }]), ['main session codex: advice-only, advice only (SOMETHING_NEW)']);
  const { run } = sandbox(t);
  const result = JSON.parse(run('status', '--json').stdout).result;
  const status = surfacePayloadContract('status');
  assert.equal(status.validate({ ...result, mainSessions: [{ ...result.mainSessions[0], turnSwitching: 'always' }] }).ok, false);
  assert.equal(status.validate({ ...result, mainSessions: [{ ...result.mainSessions[0], mode: 'auto' }] }).ok, false);
  assert.equal(status.validate({ ...result, mainSessions: null }).ok, true);
});

test('explain names the mode a main-session turn ran under and whether it switched', () => {
  assert.equal(mainSessionExplainLine({ harness: 'opencode', mode: 'plugin-bounded-auto', switched: true, reasonCode: null }), "main session: opencode plugin-bounded-auto, the turn's model was switched");
  assert.equal(mainSessionExplainLine({ harness: 'kilocode', mode: 'plugin-bounded-auto', switched: false, reasonCode: 'KILL_SWITCH' }), 'main session: kilocode plugin-bounded-auto, advice only: the kill switch is on or unknown (KILL_SWITCH)');
  const explain = surfacePayloadContract('explain');
  const trace = (mainSession) => ({ decisionId: 'dec-1', found: true, trace: { outcome: 'advise', reasonCodes: ['TURN_ADVICE'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'none', policyVersion: null, applied: false, rendered: 'x', mainSession } });
  assert.equal(explain.validate(trace({ harness: 'kilocode', mode: 'advice-only', switched: false, reasonCode: 'MAIN_SESSION_ADVICE_ONLY' })).ok, true);
  // Only Kilo and OpenCode turns are switched, so a Claude turn decision cannot carry one.
  assert.equal(explain.validate(trace({ harness: 'claude', mode: 'advice-only', switched: false, reasonCode: null })).ok, false);
});

test('a HOST_UNKNOWN abstention reads as plain text wherever a route reason is shown', async () => {
  const { routeReasonLabel, renderHuman } = await import('../dist/public/render.js');
  const text = "HOST_UNKNOWN (Jevris cannot read this session's host, so it gives advice only)";
  assert.equal(routeReasonLabel('HOST_UNKNOWN'), text);
  assert.equal(routeReasonLabel('NO_PROMOTION'), 'NO_PROMOTION');
  // Serving hosts R44 and R48.
  assert.equal(routeReasonLabel('NOT_ON_SESSION_HOST'), "NOT_ON_SESSION_HOST (a route keeps the session's host, and Jevris has not seen this model served there, so it gives advice only)");
  assert.equal(routeReasonLabel('HOST_TARIFF_UNKNOWN'), "HOST_TARIFF_UNKNOWN (the serving host's tariff for this model is not known, so Jevris gives advice only)");
  assert.equal(routeReasonLabel(null), null);
  assert.equal(mainSessionExplainLine({ harness: 'kilocode', mode: 'plugin-bounded-auto', switched: false, reasonCode: 'HOST_UNKNOWN' }), `main session: kilocode plugin-bounded-auto, advice only: Jevris cannot read this session's host, so it gives advice only (HOST_UNKNOWN)`);
  {
    const out = renderHuman({ command: 'explain', summary: 'explain', mode: 'full', workspace: { root: null }, sidecar: { state: 'running', reasonCode: null, message: null }, result: { decisionId: 'dec-1', found: true, trace: { outcome: 'abstain', reasonCodes: ['HOST_UNKNOWN'], resolvedModel: null, usage: { known: false, inputTokens: null, outputTokens: null }, uncertainty: 'none', policyVersion: null, applied: false, rendered: 'x' } } });
    assert.match(out, /^reasons: HOST_UNKNOWN \(Jevris cannot read this session's host, so it gives advice only\)$/m);
  }
});

test("a maker-price estimate reads as an estimate on the route's cost line", async () => {
  const { renderHuman } = await import('../dist/public/render.js');
  const { COST_BASES } = await import('../../../packages/contracts/dist/index.js');
  assert.ok(COST_BASES.includes('maker-price-estimate'));
  const main = { currentModel: 'kimi-k3', modelPin: null, pinState: 'unpinned', outcome: 'recommend', recommendedModel: 'glm-5.3', reasonCode: 'CHEAPER_SUFFICIENT', costBasis: 'maker-price-estimate', text: 'x', adviceKey: null };
  const out = renderHuman({ command: 'route', summary: 'route', mode: 'full', workspace: { root: null }, sidecar: { state: 'running', reasonCode: null, message: null }, result: { main, worker: { outcome: 'abstain', recommendedModel: null, reasonCode: 'NO_CALIBRATION', text: 'y' }, applied: false } });
  assert.match(out, /^cost basis: estimate: the maker's list price; the serving host's tariff is not known$/m);
});
