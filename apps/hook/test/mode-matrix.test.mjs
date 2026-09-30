// Owner decision 0eb319de: the mode is the single ceiling, and every gate asks modeAllows. This is
// the full matrix of modes by actions through the real path: the hook launcher, the sidecar client,
// a running sidecar (temporary home, no keychain, no harness binary) and its event subscribers.
//
//   action         off   observe   advise   bounded-auto
//   record          -       x        x          x
//   counterfactual  -       x        x          x      (a subscriber runs and its decision is recorded)
//   show-advice     -       -        x          x      (explain text and the Stop continuation)
//   actuate         -       -        -          x      (a certified route reaches the harness)
//
// A probe subscriber proposes each action with `certified: true`, so only the mode can hold it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { runLauncher } = await import('../dist/launcher.js');
const { startDaemon, sidecarRequest } = await import('@jevris/sidecar');
const client = await import('@jevris/sidecar/client');
const { DEFAULT_CONFIG, configFilePath } = await import('@jevris/orchestrator');
const { MODES, MODE_ACTIONS, modeAllows } = await import('@jevris/contracts');
const claude = await import('@jevris/adapter-claude-code');

const EXPECTED = {
  off: { record: false, counterfactual: false, 'show-advice': false, actuate: false },
  observe: { record: true, counterfactual: true, 'show-advice': false, actuate: false },
  advise: { record: true, counterfactual: true, 'show-advice': true, actuate: false },
  'bounded-auto': { record: true, counterfactual: true, 'show-advice': true, actuate: true },
};

const REMIND = 'Missing verification evidence: unit. Run the declared checks (jevris verify) before finishing.';
const nativeOf = (id) => claude.FIXTURES.find((fixture) => fixture.id === id).native;

function writeConfig(home, mode) {
  const path = configFilePath({ home });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...DEFAULT_CONFIG, mode }, null, 2)}\n`);
}

test('modeAllows is the table above, for every mode and action', () => {
  assert.deepEqual([...MODES].sort(), Object.keys(EXPECTED).sort());
  for (const mode of MODES) for (const action of MODE_ACTIONS) assert.equal(modeAllows(mode, action), EXPECTED[mode][action], `${mode} ${action}`);
  assert.equal(modeAllows('bogus', 'record'), false);
  assert.equal(modeAllows('bounded-auto', 'bogus'), false);
});

test('every mode by every action, through the hook launcher and a running sidecar', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-mode-matrix-')));
  const ws = join(home, 'ws');
  mkdirSync(join(ws, '.git'), { recursive: true });
  const logs = [];
  const calls = [];
  const recordedModes = [];
  let proposal = null;
  const probe = {
    name: 'probe',
    async handle(ctx) {
      calls.push({ mode: ctx.mode, shown: ctx.signal.aborted !== true });
      // The engine stamps each record with the workspace's mode (the caller names none).
      await ctx.engine?.recordAdvice?.({ specId: 'probe', workspaceId: ctx.workspace.id, evidenceRevision: 'r0', action: { kind: 'none' }, reasonCodes: ['PROBE'] });
      return proposal;
    },
  };
  const engine = {
    async decide() {
      return { ok: false, reasonCode: 'NOT_USED' };
    },
    async lookup() {
      return null;
    },
    async entry() {
      return null;
    },
    async recordAdvice(input) {
      recordedModes.push(input.mode);
      return { ok: false, reasonCode: 'NOT_KEPT' };
    },
  };
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers: [probe], engine, log: (entry) => logs.push(entry), liveCertification: false, modelOffer: false });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  });
  const deps = {
    adapters: { claude },
    sidecar: { ensure: (input) => client.ensureSidecar(input), request: (input) => client.sidecarRequest(input) },
    env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', JEVRIS_HOOK_DEADLINE_MS: '4000' },
    cwd: () => ws,
    nowMs: () => Date.now(),
  };
  let n = 0;
  const deliver = (id, over) => {
    n += 1;
    const native = { ...nativeOf(id), cwd: ws, session_id: `s-${n}`, ...(id === 'claude.pre-agent' ? { tool_use_id: `toolu_${n}` } : {}), ...over };
    delete native.transcript_path;
    return runLauncher({ harness: 'claude', event: null }, JSON.stringify(native), deps, Date.now());
  };
  const settle = async (count) => {
    for (let i = 0; i < 3_000 && calls.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const traced = (event) => logs.filter((entry) => entry.event === `trace:${event}`).length;

  const table = {};
  for (const mode of MODES) {
    writeConfig(home, mode);
    const row = {};

    // record and counterfactual: an event with an explain proposal.
    const recordedBefore = traced('event-recorded');
    const callsBefore = calls.length;
    const modesBefore = recordedModes.length;
    proposal = { hookOutcome: { kind: 'explain', text: 'probe advice' }, certified: false, reasonCode: 'PROBE' };
    const advice = await deliver('claude.stop', { stop_hook_active: true });
    await settle(callsBefore + 1);
    row.record = traced('event-recorded') > recordedBefore;
    row.counterfactual = calls.length > callsBefore && recordedModes.length > modesBefore;
    if (row.counterfactual) {
      assert.equal(calls.at(-1).mode, mode, `${mode}: the subscriber saw another mode`);
      assert.equal(recordedModes.at(-1), mode, `${mode}: the decision was recorded under another mode`);
    }
    const adviceShown = advice.stdout.includes('probe advice');

    // show-advice: the Stop continuation (owner decision: it counts as advice).
    proposal = { hookOutcome: { kind: 'explain', text: REMIND }, certified: false, reasonCode: 'STOP_REMINDER', stopContinuation: { text: REMIND, certified: true, missingEvidence: ['unit'] } };
    const stop = await deliver('claude.stop', { stop_hook_active: false });
    const continued = stop.reason === 'STOP_CONTINUATION';
    assert.equal(adviceShown, continued, `${mode}: explain and the Stop continuation disagree`);
    row['show-advice'] = adviceShown && continued;

    // actuate: a certified subagent route.
    proposal = { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: true, reasonCode: 'PROBE_ROUTE' };
    const routed = await deliver('claude.pre-agent');
    row.actuate = routed.stdout.includes('updatedInput');
    if (row.actuate) assert.equal(JSON.parse(routed.stdout).hookSpecificOutput.updatedInput.model, 'haiku');
    else assert.equal(routed.stdout, '', `${mode}: a withheld route showed something`);
    await settle(calls.length);
    table[mode] = row;
  }
  assert.deepEqual(table, EXPECTED);
  // off records nothing and runs nothing: each of its deliveries was skipped.
  assert.equal(traced('event-skipped'), 3);
  // advise withholds the certified route centrally.
  assert.ok(traced('route-withheld') >= 1);
});

test('route.turn: off and observe give no switch and no text; advise caps the main session to advice-only', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-mode-turn-')));
  const ws = join(home, 'ws');
  mkdirSync(join(ws, '.git'), { recursive: true });
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, modelOffer: false, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  t.after(async () => {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  });
  const ask = (i) =>
    sidecarRequest({ home, op: 'route.turn', scope: 'hook', workspace: ws, budget: 'hot', timeoutMs: 60_000, body: { harness: 'opencode', sessionId: `turn-${i}`, current: { providerID: 'anthropic', modelID: 'claude-opus-4-5' }, modelPin: null } });
  const seen = {};
  let i = 0;
  for (const mode of MODES) {
    writeConfig(home, mode);
    const answer = await ask((i += 1));
    seen[mode] = answer.ok ? { mainSession: answer.result.mainSession.mode, actuate: answer.result.actuate } : answer.reasonCode;
  }
  assert.deepEqual(seen, {
    off: 'MODE_DOES_NOT_ADVISE',
    observe: 'MODE_DOES_NOT_ADVISE',
    advise: { mainSession: 'advice-only', actuate: false },
    // No approved scope or certification here, so bounded-auto does not switch either; the
    // main session keeps its configured mode.
    'bounded-auto': { mainSession: 'plugin-bounded-auto', actuate: false },
  });
});
