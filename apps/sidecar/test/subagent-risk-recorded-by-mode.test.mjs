import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// JEV-0076/0082 through the real sidecar: a Claude Code subagent launch that the route judges leaves one `subagent-risk`
// decision in the journal in observe (the counterfactual, nothing shown) as well as in advise. A launch the route does not judge
// (a medium one on a Sonnet session has no rung between, so nothing could be routed) is recorded in no mode. Temp home, no
// credential (rules-only engine), no harness binary; a recorded Haiku 5.5 run stands in for the local evidence that makes it usable.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');
const core = await import('@jevris/core');

const sha = (text) => createHash('sha256').update(text).digest('hex');
let n = 0;
const keyNames = (count) => Array.from({ length: count }, (_, i) => `k${i}`);

async function launch(home, repo, { mode, toolInputBytes, keys }) {
  n += 1;
  const key = `risk-${mode}-${n}`;
  const envelope = {
    schemaVersion: '1.0', harness: 'claude', nativeEventName: 'PreToolUse', kind: 'tool.proposed', sessionId: `sess-${mode}-${n}`, turnId: null, toolUseId: `tu-${n}`, toolName: 'Agent',
    agentId: null, model: 'claude-sonnet-5-5', permissionMode: null, cwd: null, trigger: null, blocking: true, responseRequired: true,
    payload: { toolName: 'Agent', subagentType: 'Explore', toolInputBytes, toolInputKeys: keyNames(keys) }, dedupKey: sha(key), flags: {},
  };
  const res = await sidecarRequest({ home, op: 'event', workspace: repo, scope: 'hook', timeoutMs: 60_000, body: { deliveryKey: key, harnessVersion: '2.1.294', envelope } });
  assert.equal(res.ok, true, JSON.stringify(res));
}

function riskDecisions(home) {
  const dir = join(jevrisPaths({ home }).data, 'decisions');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (entry.record?.specId === 'subagent-risk') out.push(entry);
    } catch {
      // a write in progress
    }
  }
  return out;
}

async function settled(home, count) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (riskDecisions(home).length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('observe records the subagent-risk decision of a judged launch, as advise does; a launch that is not judged is recorded in neither', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-risk-mode-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const setMode = (mode) => writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, mode }));
  assert.equal(await core.recordModelRun(home, { harness: 'claude', authMode: 'unknown', modelId: 'claude-haiku-5-5', nowMs: Date.now(), raw: null, servingHost: null, source: 'reported' }), true);
  const started = await startDaemon({ home, idleMs: 0, log: () => undefined, liveCertification: false, limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    // After the start: the sidecar moves an `observe` file written before its first start to bounded-auto (the 1.2 upgrade migration).
    setMode('observe');
    // Observe: a small read-only launch is judged low by the rules; the record is written after the answer.
    await launch(home, repo, { mode: 'observe', toolInputBytes: 600, keys: 3 });
    const recorded = await settled(home, 1);
    assert.equal(recorded, true, 'observe wrote the decision');
    // The control: advise records a launch of its own (a different key count is a different feature set, so a new decision).
    setMode('advise');
    await launch(home, repo, { mode: 'advise', toolInputBytes: 600, keys: 4 });
    assert.equal(await settled(home, 2), true, 'advise wrote its decision');
    // A large read-only launch is medium; a Sonnet session has no rung between, so nothing is judged and nothing is recorded, in any mode.
    const before = riskDecisions(home).length;
    for (const mode of ['observe', 'advise']) {
      setMode(mode);
      await launch(home, repo, { mode, toolInputBytes: 7000, keys: 5 });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(riskDecisions(home).length, before, 'a launch with nothing to route is recorded in no mode');
  } finally {
    await started.daemon.stop('test');
  }
});
