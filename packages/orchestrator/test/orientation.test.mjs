// The one orientation line a fresh session gets: present when Jevris is on and the harness's
// context is certified, absent when it is off, only observing, kill-switched or not certified,
// and never a second copy beside the capsule a compaction restores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_FEATURE,
  ORIENTATION_MAX_BYTES,
  certificationGateFrom,
  declare,
  handleHookEvent,
  openWorkspace,
  orientationLine,
  setCertificationGate,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

function fixture() {
  const dir = tempDir('jv-ori-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const ctx = (body, extra = {}) => ({
    op: 'event',
    client: 'cli',
    scopes: ['status', 'advice', 'checkpoint', 'submit', 'admin'],
    workspace: { id: ws.workspaceId, root: ws.workspaceRoot },
    body,
    home,
    signal: new AbortController().signal,
    deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false },
    store,
    killSwitchStopped: false,
    engine: undefined,
    trace: () => {},
    ...extra,
  });
  return { ws, repo, ctx, done: () => { closeTestStore(store); rmSync(dir, { recursive: true, force: true }); } };
}

function certified(harness) {
  return {
    id: 'cert1',
    schemaVersion: '1.0',
    harness,
    actuatorId: 'context',
    harnessVersionRange: { minimum: '2.0.0', maximumExclusive: '3.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: [{ featureId: CONTEXT_FEATURE, status: 'certified', reasonCode: null }],
    certifiedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    signature: { algorithm: 'ed25519', keyId: 'k', value: 'AAAA' },
  };
}

let seq = 0;
function started(f, extra = {}, mode = 'advise', ctxExtra = {}) {
  seq += 1;
  const envelope = { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'SessionStart', kind: 'session.started', sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: 'startup', blocking: false, responseRequired: false, payload: {}, dedupKey: 'd', ...extra };
  return f.ctx({ envelope, deliveryKey: `ori-${seq}` }, { mode, ...ctxExtra });
}

const withGate = (harness, run) => async () => {
  setCertificationGate(certificationGateFrom(async () => [certified(harness)], () => '2.1.0'));
  const f = fixture();
  try {
    await run(f);
  } finally {
    setCertificationGate(null);
    f.done();
  }
};

test('orientation: the line fits its byte cap in every mode, and says advice only, permissions unchanged and where to look', () => {
  for (const mode of ['advise', 'bounded-auto', 'observe']) {
    for (const harness of ['claude', 'codex', 'kilocode', 'opencode']) {
      const own = orientationLine(mode, harness);
      assert.ok(Buffer.byteLength(own, 'utf8') <= ORIENTATION_MAX_BYTES, `${mode} on ${harness}: ${Buffer.byteLength(own, 'utf8')} bytes`);
    }
    const line = orientationLine(mode, 'claude');
    // Owner decision 2026-10-08: the standing sentence on the subagent model policy, Claude Code only, with nothing forced.
    assert.match(line, /A low-risk subagent may run on a cheaper model for that one call only; Jevris advises it and sets it where certified, and your session model is never changed\./);
    assert.match(line, /may suggest \/model; nothing is forced\./);
    assert.equal(orientationLine(mode, 'codex').includes('subagent'), false);
    assert.equal(orientationLine(mode).includes('subagent'), false);
    assert.ok(line.includes(`mode: ${mode}`));
    assert.match(line, /advice/);
    assert.match(line, /permissions and approvals are unchanged/);
    assert.match(line, /jevris_status/);
    assert.equal(/\/(Users|Volumes|home)\//.test(line), false, 'no machine path');
  }
});

test('orientation: a fresh session start gets the line once when Jevris is on and the context is certified', withGate('claude', async (f) => {
  const first = await handleHookEvent(started(f));
  assert.deepEqual([first.hookOutcome.kind, first.reasonCode, first.certified], ['context', 'ORIENTATION', true]);
  assert.equal(first.hookOutcome.text, orientationLine('advise', 'claude'));
  const boundedAuto = await handleHookEvent(started(f, { sessionId: 's2' }, 'bounded-auto'));
  assert.equal(boundedAuto.hookOutcome.text, orientationLine('bounded-auto', 'claude'));
  // A clear starts a new context, so it gets the line too.
  assert.equal((await handleHookEvent(started(f, { trigger: 'clear', sessionId: 's3' }))).hookOutcome.kind, 'context');
  // The same delivery again is a duplicate: no second copy.
  const replay = started(f);
  await handleHookEvent(replay);
  assert.equal((await handleHookEvent(replay)).hookOutcome.kind, 'observe');
}));

test('orientation: nothing is said when Jevris only observes, is off, is kill-switched, or the harness context is not certified', withGate('claude', async (f) => {
  const observe = await handleHookEvent(started(f, {}, 'observe'));
  assert.deepEqual([observe.hookOutcome.kind, observe.reasonCode], ['observe', 'MODE_DOES_NOT_ADVISE']);
  const off = await handleHookEvent(started(f, {}, 'off'));
  assert.deepEqual([off.hookOutcome.kind, off.reasonCode], ['observe', 'MODE_DOES_NOT_ADVISE']);
  const stopped = await handleHookEvent(started(f, {}, 'advise', { killSwitchStopped: true }));
  assert.deepEqual([stopped.hookOutcome.kind, stopped.reasonCode], ['observe', 'KILL_SWITCH']);
  const subagent = await handleHookEvent(started(f, { agentId: 'sub-1' }));
  assert.equal(subagent.hookOutcome.kind, 'observe', 'a subagent start is not a session start');
  // Codex has no certification record here: the line is not proposed.
  const codex = await handleHookEvent(started(f, { harness: 'codex' }));
  assert.equal(codex.hookOutcome.kind, 'observe');
  assert.equal(codex.certified, false);
}));

test('orientation: a compaction restores the capsule alone, with no second copy of the line', withGate('claude', async (f) => {
  await declare(f.ws, null, { objective: 'Keep going', constraints: ['C7: never force-push'] });
  const pre = f.ctx({ envelope: { schemaVersion: '1.0', harness: 'claude', nativeEventName: 'X', kind: 'context.compacting', sessionId: 's1', turnId: null, toolUseId: null, toolName: null, agentId: null, model: null, permissionMode: null, cwd: f.repo, trigger: 'auto', blocking: false, responseRequired: false, payload: {}, dedupKey: 'd' }, deliveryKey: 'ori-pre' }, { mode: 'advise' });
  await handleHookEvent(pre);
  const restore = await handleHookEvent(started(f, { trigger: 'compact' }));
  assert.deepEqual([restore.hookOutcome.kind, restore.reasonCode], ['context', 'CAPSULE_RESTORED']);
  assert.match(restore.hookOutcome.text, /C7: never force-push/);
  assert.equal(restore.hookOutcome.text.includes('Jevris is on here'), false, 'the capsule carries no orientation line');
  const resume = await handleHookEvent(started(f, { trigger: 'resume', sessionId: 's9' }));
  assert.equal(resume.hookOutcome.kind === 'context' && resume.hookOutcome.text.includes('Jevris is on here'), false, 'a resume is not a fresh session');
}));

test('orientation: on Kilo Code and OpenCode a line the harness does not show on session creation is held for the next showing event, once', async () => {
  for (const harness of ['kilocode', 'opencode']) {
    await withGate(harness, async (f) => {
      const sessionId = `s-${harness}`;
      const hiddenStart = started(f, { harness, sessionId });
      hiddenStart.body.showsExplain = false;
      const held = await handleHookEvent(hiddenStart);
      assert.deepEqual([held.hookOutcome.kind, held.reasonCode], ['observe', 'DISPLAY_QUEUED'], harness);
      const next = await handleHookEvent(started(f, { harness, sessionId, kind: 'task.requested', nativeEventName: 'Y', trigger: null }));
      assert.deepEqual([next.hookOutcome.kind, next.reasonCode], ['context', 'DISPLAY_FLUSHED'], harness);
      assert.equal(next.hookOutcome.text, orientationLine('advise', harness));
      assert.equal(next.hookOutcome.text.includes('subagent'), false, 'the subagent model policy is Claude Code only');
      const again = await handleHookEvent(started(f, { harness, sessionId, kind: 'task.requested', nativeEventName: 'Y', trigger: null }));
      assert.equal(again.hookOutcome.kind, 'observe', 'once');
    })();
  }
});
