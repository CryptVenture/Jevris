import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from './temp-dirs.mjs';

// JEV-0018: `jevris audit verify` and `audit export` answer from the store file, read-only, when
// no sidecar runs and JEVRIS_SIDECAR_AUTOSTART=0 forbids starting one.

const s = await import(new URL('../dist/index.js', import.meta.url).href);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dirs = [];
test.after(() => {
  for (const dir of dirs) removeTempDir(dir);
});

function storeWithAudit(rows) {
  const dir = makeTempDir('jevris-audit-file-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  const opened = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  for (let i = 0; i < rows; i += 1) assert.equal(s.appendAudit(opened, { kind: 'kill-switch.drill', actor: 'tester', channel: 'cli', atMs: 1_000 + i, detail: { n: i } }).ok, true);
  s.closeStore(opened);
  return path;
}

test('verifyAuditChainAt reads the chain from the file, changes nothing, and names a store that is not there', () => {
  const path = storeWithAudit(3);
  const before = readFileSync(path);
  const verified = s.verifyAuditChainAt(path);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.count, 3);
  assert.deepEqual(readFileSync(path), before, 'a read-only verify leaves the store file as it was');
  assert.deepEqual(s.verifyAuditChainAt(join(path, '..', 'missing.db')), { ok: false, reason: 'no-store' });
});

test('verifyAuditChainAt finds an edited row, as the live verify does', () => {
  const path = storeWithAudit(3);
  const raw = new Database(path);
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'").all()) raw.exec(`DROP TRIGGER ${row.name}`);
  raw.prepare("UPDATE audit_log SET actor = 'mallory' WHERE seq = 2").run();
  raw.close();
  assert.deepEqual(s.verifyAuditChainAt(path), { ok: false, brokenAt: 2 });
});

test('exportAuditJsonlAt matches the live export byte for byte', () => {
  const path = storeWithAudit(2);
  const live = s.openStore({ path, role: 'sidecar', workspaceId: 'host', hostScope: 'hostA', fsKind: () => ({ kind: 'local', label: 't' }) });
  const expected = s.exportAuditJsonl(live);
  s.closeStore(live);
  const answer = s.exportAuditJsonlAt(path);
  assert.equal(answer.ok, true);
  assert.equal(answer.text, expected);
  assert.equal(answer.text.trimEnd().split('\n').length, 2);
  assert.equal(statSync(path).isFile(), true);
});

test('a file that is not a store is refused, not thrown', () => {
  const dir = makeTempDir('jevris-audit-file-');
  dirs.push(dir);
  const path = join(dir, 'jevris.db');
  require('node:fs').writeFileSync(path, 'this is not a sqlite database at all'.repeat(40));
  const answer = s.verifyAuditChainAt(path);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /store-(corrupt|unreadable)/);
});
