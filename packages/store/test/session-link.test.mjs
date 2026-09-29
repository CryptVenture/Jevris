// Session-to-task links (owner decision 29423b6; B's store half, schema 10): one link per
// session, audited, live only while the session is active, and dropped when it ends. The
// session's last-seen time tells the op which sessions were seen recently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function openHost() {
  const dir = makeTempDir('jevris-store-link-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { store: opened, path };
}

const who = { actor: 'cli', channel: 'terminal' };

test('schema 10 adds session_link and the session last-seen time; an older store is migrated and backfilled', () => {
  const { store, path } = openHost();
  assert.ok(s.latestSchemaVersion() >= 10);
  const ws = s.workspaceView(store, 'wAbc');
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 100 });
  s.closeStore(store);
  // Undo v10 by hand, as a store written by the previous build would be.
  const db = new Database(path);
  db.exec("DROP TABLE session_link; DROP INDEX IF EXISTS session_seen; ALTER TABLE session DROP COLUMN last_seen_at_ms; DELETE FROM schema_migrations WHERE version = 10;");
  db.close();
  const again = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.schemaVersion, s.latestSchemaVersion());
  const view = s.workspaceView(again, 'wAbc');
  assert.deepEqual(s.listActiveSessions(view, { sinceMs: 0 }), [{ sessionId: 'k1', harness: 'kilocode', lastSeenAtMs: 100 }], 'backfilled from the start time');
  s.closeStore(again);
});

test('last seen follows the latest event; the active list is per workspace and harness, newest first, within the window', () => {
  const { store } = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 100 });
  s.recordSession(ws, { sessionId: 'o1', harness: 'opencode', state: 'active', atMs: 200 });
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 300 });
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 250 });
  s.recordSession(ws, { sessionId: 'k2', harness: 'kilocode', state: 'ended', atMs: 400 });
  s.recordSession(s.workspaceView(store, 'wOther'), { sessionId: 'k9', harness: 'kilocode', state: 'active', atMs: 500 });
  assert.deepEqual(s.listActiveSessions(ws, { sinceMs: 0 }), [
    { sessionId: 'k1', harness: 'kilocode', lastSeenAtMs: 300 },
    { sessionId: 'o1', harness: 'opencode', lastSeenAtMs: 200 },
  ]);
  assert.deepEqual(s.listActiveSessions(ws, { harness: 'opencode', sinceMs: 0 }).map((x) => x.sessionId), ['o1']);
  assert.deepEqual(s.listActiveSessions(ws, { sinceMs: 250 }).map((x) => x.sessionId), ['k1']);
  assert.deepEqual(s.listActiveSessions(ws, { harness: 'Bad Harness', sinceMs: 0 }), { ok: false, reason: 'invalid-input' });
  s.closeStore(store);
});

test('link: only a recorded active session of that harness; one link per session; replace; each change audited', () => {
  const { store } = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 100 });
  s.recordSession(ws, { sessionId: 'k2', harness: 'kilocode', state: 'ended', atMs: 100 });
  const link = (input) => s.linkSession(ws, { sessionId: 'k1', harness: 'kilocode', taskId: 'T1', via: 'route', atMs: 1000, ...who, ...input });
  assert.deepEqual(link({ sessionId: 'nope' }), { ok: false, refusal: 'unknown-session' });
  assert.deepEqual(link({ harness: 'opencode' }), { ok: false, refusal: 'harness-mismatch' });
  assert.deepEqual(link({ sessionId: 'k2' }), { ok: false, refusal: 'session-ended' });
  assert.deepEqual(link({ via: 'mcp' }), { ok: false, reason: 'invalid-input' });
  assert.deepEqual(link({ actor: 'me@example.com x' }), { ok: false, reason: 'invalid-input' });
  assert.equal(s.sessionLinkFor(ws, 'k1'), undefined);

  const first = link({});
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result, 'linked');
  assert.equal(first.lastSeenAtMs, 100);
  assert.deepEqual(s.sessionLinkFor(ws, 'k1'), { sessionId: 'k1', harness: 'kilocode', taskId: 'T1', linkedAtMs: 1000, via: 'route' });
  assert.equal(s.sessionLinkFor(store, 'k1'), undefined, 'the host view sees no workspace link');
  assert.equal(s.sessionLinkFor(undefined, 'k1'), undefined);
  assert.equal(link({ atMs: 1001 }).result, 'already-linked');
  assert.deepEqual(link({ taskId: 'T2', atMs: 1002 }), { ok: false, refusal: 'session-already-linked' });
  const replaced = link({ taskId: 'T2', atMs: 1003, replace: true });
  assert.equal(replaced.result, 'linked');
  assert.equal(s.sessionLinkFor(ws, 'k1').taskId, 'T2');

  const audit = s.readAudit(store, { kinds: ['session.link', 'session.unlink'] });
  assert.deepEqual(audit.map((row) => [row.kind, row.channel, row.detail.task, row.detail.replaced]), [
    ['session.link', 'terminal', 'T1', null],
    ['session.link', 'terminal', 'T2', 'T1'],
  ]);
  assert.equal(s.verifyAuditChain(store).ok, true);
  s.closeStore(store);
});

test('unlink tightens from any channel; a session that ends drops its link, audited as the sidecar', () => {
  const { store } = openHost();
  const ws = s.workspaceView(store, 'wAbc');
  s.recordSession(ws, { sessionId: 'k1', harness: 'kilocode', state: 'active', atMs: 100 });
  s.recordSession(ws, { sessionId: 'o1', harness: 'opencode', state: 'active', atMs: 100 });
  assert.equal(s.linkSession(ws, { sessionId: 'k1', harness: 'kilocode', taskId: 'T1', via: 'route', atMs: 1000, ...who }).ok, true);
  assert.equal(s.linkSession(ws, { sessionId: 'o1', harness: 'opencode', taskId: 'T1', via: 'plan', atMs: 1000, actor: 'sidecar', channel: 'sidecar' }).ok, true);
  const removed = s.unlinkSession(ws, { sessionId: 'k1', actor: 'cli', channel: 'cli', atMs: 1100 });
  assert.equal(removed.result, 'unlinked');
  assert.equal(removed.link.taskId, 'T1');
  assert.equal(s.unlinkSession(ws, { sessionId: 'k1', actor: 'cli', channel: 'cli', atMs: 1101 }).result, 'not-linked');
  assert.equal(s.sessionLinkFor(ws, 'k1'), undefined);

  s.recordSession(ws, { sessionId: 'o1', harness: 'opencode', state: 'ended', atMs: 1200 });
  assert.equal(s.sessionLinkFor(ws, 'o1'), undefined, 'an ended session is never linked');
  const rows = s.readAudit(store, { kinds: ['session.unlink'] });
  assert.deepEqual(rows.map((row) => [row.channel, row.actor, row.detail.session]), [['cli', 'cli', 'k1'], ['system', 'sidecar', 'o1']]);
  // Reopening the ended session does not bring the link back.
  s.recordSession(ws, { sessionId: 'o1', harness: 'opencode', state: 'active', atMs: 1300 });
  assert.equal(s.sessionLinkFor(ws, 'o1'), undefined);
  s.closeStore(store);
});
