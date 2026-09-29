import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// F's live certification evidence and background re-checks, wired into the sidecar by B.
const { envelopeShape, liveHarnessOf, recordDelivery, reverifyHarnesses } = await import('../dist/live-certification.js');
const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { jevrisPaths } = await import('@jevris/platform');
const claude = await import('@jevris/adapter-claude-code');

const posix = process.platform !== 'win32';
const CANARY = 'CANARY_prompt_text_do_not_record';

function normalized(native) {
  const result = claude.normalize(native);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.event;
}

const sessionStart = () => normalized({ hook_event_name: 'SessionStart', session_id: 'sess-live-1', source: 'startup', model: 'claude-sonnet-5', cwd: '/tmp' });
const promptEvent = () => normalized({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-live-1', prompt: CANARY, cwd: '/tmp' });

test('an adapter-normalized envelope conforms; each missing or mistyped required field is malformed with its reason (HCF)', () => {
  const event = sessionStart();
  assert.deepEqual(envelopeShape(event), { conforming: true });
  assert.deepEqual(envelopeShape(promptEvent()), { conforming: true });
  const subagentTool = normalized({ hook_event_name: 'PostToolUse', session_id: 'sess-live-1', agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'toolu_1', cwd: '/tmp' });
  assert.equal(subagentTool.parentSessionId, 'sess-live-1');
  assert.deepEqual(envelopeShape(subagentTool), { conforming: true }, "a subagent's event conforms");
  assert.deepEqual(envelopeShape({ ...subagentTool, parentSessionId: 3 }), { conforming: false, reasonCode: 'EVENT_FIELDS' });
  assert.equal(liveHarnessOf(event), 'claude');
  assert.equal(liveHarnessOf({ ...event, harness: 'other' }), undefined);
  const cases = [
    [{ ...event, schemaVersion: '2.0' }, 'EVENT_SCHEMA_VERSION'],
    [{ ...event, kind: '' }, 'EVENT_KIND'],
    [{ ...event, nativeEventName: 7 }, 'EVENT_NATIVE_NAME'],
    [{ ...event, blocking: 'yes' }, 'EVENT_FLAGS'],
    [{ ...event, payload: [] }, 'EVENT_PAYLOAD'],
    [{ ...event, sessionId: 12 }, 'EVENT_FIELDS'],
    [{ ...event, dedupKey: 'short' }, 'EVENT_DEDUP_KEY'],
    ['text', 'EVENT_NOT_OBJECT'],
  ];
  for (const [envelope, reasonCode] of cases) assert.deepEqual(envelopeShape(envelope), { conforming: false, reasonCode });
});

test('a delivery records its harness, version and feature, never content; the ledger version is used when none is supplied (HCF)', async () => {
  const seen = [];
  const record = async (home, event) => seen.push({ home, event });
  assert.equal(await recordDelivery('/h', promptEvent(), '2.1.280', { record, versionOf: () => '9.9.9' }), true);
  assert.equal(await recordDelivery('/h', { ...promptEvent(), dedupKey: 'x' }, undefined, { record, versionOf: () => '2.1.281' }), true);
  assert.equal(await recordDelivery('/h', { ...promptEvent(), harness: 'unknown' }, '2.1.280', { record }), false, 'no harness, nothing recorded');
  assert.equal(await recordDelivery('/h', promptEvent(), 'not-a-version', { record, versionOf: () => null }), false, 'no version, nothing recorded');
  assert.equal(await recordDelivery('/h', promptEvent(), '2.1.280', { record: async () => { throw new Error('disk full'); } }), false, 'a failed write never throws');
  assert.deepEqual(seen, [
    { home: '/h', event: { harness: 'claude', version: '2.1.280', featureId: 'hooks.observe', conforming: true } },
    { home: '/h', event: { harness: 'claude', version: '2.1.281', featureId: 'hooks.observe', conforming: false, reasonCode: 'EVENT_DEDUP_KEY' } },
  ]);
  assert.equal(JSON.stringify(seen).includes(CANARY), false);
});

test('a re-check names only harnesses with a known version, and never throws (HCF)', async () => {
  const asked = [];
  const reverify = async (options) => asked.push(options);
  const versionOf = (_home, harness) => (harness === 'codex' ? '0.130.0' : harness === 'claude' ? '2.1.280' : null);
  assert.equal(await reverifyHarnesses('/h', undefined, { reverify, versionOf, root: () => '/pkg' }), true);
  assert.equal(await reverifyHarnesses('/h', ['kilocode'], { reverify, versionOf, root: () => '/pkg' }), false, 'no version known');
  assert.equal(await reverifyHarnesses('/h', ['claude'], { reverify, versionOf, root: () => null }), false, 'no package root');
  assert.equal(await reverifyHarnesses('/h', ['claude'], { reverify: async () => { throw new Error('boom'); }, versionOf, root: () => '/pkg' }), false);
  assert.deepEqual(asked, [{ home: '/h', root: '/pkg', installed: ['claude', 'codex'], versions: { claude: '2.1.280', codex: '0.130.0' } }]);
});

function tempHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'b-live-')));
}

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test('through the sidecar: one live event per recorded delivery, a re-check at start and on SessionStart, after the answer (HCF)', { skip: managedHostSkip() }, async () => {
  const home = tempHome();
  const recorded = [];
  const rechecks = [];
  const liveCertification = {
    record: async (_home, event) => recorded.push(event),
    reverify: async (options) => rechecks.push({ installed: options.installed, versions: options.versions }),
    versionOf: (_home, harness) => (harness === 'claude' ? '2.1.280' : null),
    root: () => '/pkg',
  };
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification });
  assert.equal(started.ok, true);
  try {
    assert.ok(await waitFor(() => rechecks.length === 1), 'the start re-check ran');
    assert.deepEqual(rechecks[0], { installed: ['claude'], versions: { claude: '2.1.280' } });
    const root = join(home, 'ws');
    mkdirSync(root);
    const send = (envelope, harnessVersion) =>
      sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 5000, body: { envelope, deliveryKey: envelope.dedupKey, ...(harnessVersion !== undefined ? { harnessVersion } : {}) } });
    const start = sessionStart();
    assert.equal((await send(start, '2.1.282')).ok, true);
    const again = await send(start, '2.1.282');
    assert.equal(again.result.duplicate, true);
    assert.equal((await send(promptEvent())).ok, true);
    assert.ok(await waitFor(() => recorded.length === 2 && rechecks.length === 2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(recorded, [
      { harness: 'claude', version: '2.1.282', featureId: 'hooks.observe', conforming: true },
      { harness: 'claude', version: '2.1.280', featureId: 'hooks.observe', conforming: true },
    ], 'one per recorded delivery; a duplicate is not counted again');
    assert.deepEqual(rechecks[1], { installed: ['claude'], versions: { claude: '2.1.282' } }, 'SessionStart re-checks its own harness');
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});

test("with F's real modules: the event log is owner-only and content-free, and a test run starts no re-check (HCF)", { skip: managedHostSkip() }, async () => {
  const home = tempHome();
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined });
  assert.equal(started.ok, true);
  try {
    const root = join(home, 'ws');
    mkdirSync(root);
    const envelope = promptEvent();
    const res = await sidecarRequest({ home, op: 'event', scope: 'hook', workspace: root, timeoutMs: 5000, body: { envelope, deliveryKey: envelope.dedupKey, harnessVersion: '2.1.280' } });
    assert.equal(res.ok, true, JSON.stringify(res));
    const file = join(jevrisPaths({ home }).data, 'live-evidence', 'events.jsonl');
    assert.ok(await waitFor(() => {
      try {
        return readFileSync(file, 'utf8').length > 0;
      } catch {
        return false;
      }
    }), 'the live event was appended');
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes(CANARY), false, 'no event content');
    assert.match(text, /"h":"claude"/);
    if (posix) assert.equal(statSync(file).mode & 0o077, 0);
    // maybeReverify refuses in a test run, so no marker is ever written here.
    let markers = [];
    try {
      markers = (await import('node:fs')).readdirSync(join(jevrisPaths({ home }).data, 'reverify'));
    } catch {
      markers = [];
    }
    assert.deepEqual(markers, []);
  } finally {
    await started.daemon.stop('test');
    rmSync(home, { recursive: true, force: true });
  }
});
