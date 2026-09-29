// Evidence-selection usage (audit P10): each evidence.select keeps its selection id and ranked
// handle ids, and each evidence.get of stored evidence keeps the handle, the selection that
// ranked it and its rank there. Ids, ranks and times only. Offline: a local check writes the
// evidence; the ops are the sidecar's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVIDENCE_READS,
  EVIDENCE_SELECTIONS,
  SELECTION_JOIN_MS,
  approveManifests,
  evidenceUsage,
  manifestHash,
  openWorkspace,
  parseManifest,
  recordEvidenceRead,
  recordEvidenceSelection,
  resetEvidenceUsageCache,
  runVerification,
  sidecarOps,
  usageHandleId,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const INTENT = ['importer', 'canary', process.pid].join('-');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

async function fixture() {
  resetEvidenceUsageCache();
  const dir = tempDir('jv-evu-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const m = parseManifest({ id: 'unit', argv: [process.execPath, '-e', 'console.log("importer boom"); process.exit(1)'], resultFormat: 'exit-code' }).manifest;
  await approveManifests(ws, [m], { unit: manifestHash(m) }, 'test');
  const [run] = (await runVerification(ws, { taskId: null, checkIds: [] })).ran;
  const handle = run.receipt.rawOutputHandle;
  assert.match(handle, /^ev:/);
  const call = (op, body) =>
    sidecarOps.find((o) => o.op === op).handle({
      op, client: 'mcp', scopes: ['status', 'advice', 'checkpoint'], workspace: { id: ws.workspaceId, root: ws.workspaceRoot }, body, home,
      signal: new AbortController().signal, deadline: { budgetMs: 5000, remainingMs: () => 5000, expired: () => false }, store, killSwitchStopped: false, engine: undefined, trace: () => {},
    });
  return { ws, handle, call, done: () => {
      resetEvidenceUsageCache();
      closeTestStore(store);
      rmSync(dir, { recursive: true, force: true });
    } };
}

test('P10: a selection keeps its ranked handle ids; a read of stored evidence joins the selection that ranked it, at its rank; ids only', async () => {
  const f = await fixture();
  try {
    const sel = await f.call('evidence.select', { intent: INTENT, maxItems: 5 });
    assert.equal(sel.ok, true, JSON.stringify(sel));
    const [selection] = f.ws.state.list(EVIDENCE_SELECTIONS);
    // The answer names its selection (contract-validated by the op), for the client to pass back.
    assert.equal(sel.body.selectionId, selection.selectionId);
    const handleId = usageHandleId(f.handle);
    const rank = selection.rankedHandleIds.indexOf(handleId) + 1;
    assert.ok(rank > 0, JSON.stringify(selection));
    // The shown items lead the kept ranking.
    assert.deepEqual(selection.rankedHandleIds.slice(0, sel.body.items.length), sel.body.items.map((i) => i.id));
    // A read without a selection id joins the latest selection that ranked the handle.
    const got = await f.call('evidence.get', { handle: f.handle });
    assert.equal(got.ok, true, JSON.stringify(got));
    // A named selection is used; a malformed or unknown one is ignored (never refused).
    assert.equal((await f.call('evidence.get', { handle: f.handle, selectionId: selection.selectionId })).ok, true);
    assert.equal((await f.call('evidence.get', { handle: f.handle, selectionId: '../x' })).ok, true);
    // A handle that is not stored is no read.
    assert.equal((await f.call('evidence.get', { handle: `ev:${'0'.repeat(64)}` })).ok, true);
    const reads = f.ws.state.list(EVIDENCE_READS);
    assert.equal(reads.length, 3);
    for (const r of reads) assert.deepEqual([r.handleId, r.selectionId, r.rank], [handleId, selection.selectionId, rank]);
    assert.doesNotMatch(JSON.stringify([...f.ws.state.list(EVIDENCE_SELECTIONS), ...reads]), new RegExp(`${INTENT}|boom|Raw output`));
    const usage = evidenceUsage(f.ws, 5);
    assert.deepEqual([usage.selections, usage.reads, usage.readsFromSelection, usage.recall], [1, 3, 3, 1]);
    assert.equal(usage.precisionAtK, 1 / Math.min(5, selection.rankedHandleIds.length));
  } finally {
    f.done();
  }
});

test('P10: a read with no selection that ranked it in the join window keeps a null selection and rank (pair)', async () => {
  const f = await fixture();
  try {
    const t0 = Date.parse('2026-09-27T10:00:00Z');
    assert.equal(await recordEvidenceSelection(f.ws, [], t0), null, 'nothing ranked, nothing kept');
    const id = await recordEvidenceSelection(f.ws, [usageHandleId(f.handle)], t0);
    const inWindow = await recordEvidenceRead(f.ws, f.handle, undefined, t0 + SELECTION_JOIN_MS);
    assert.deepEqual([inWindow.selectionId, inWindow.rank], [id, 1]);
    const late = await recordEvidenceRead(f.ws, f.handle, undefined, t0 + SELECTION_JOIN_MS + 1);
    assert.deepEqual([late.selectionId, late.rank], [null, null]);
    // A client naming the kept selection still joins it after the window.
    const named = await recordEvidenceRead(f.ws, f.handle, id, t0 + SELECTION_JOIN_MS + 1);
    assert.deepEqual([named.selectionId, named.rank], [id, 1]);
    // After a restart (no in-memory selections) the ledger seeds the recent ones.
    resetEvidenceUsageCache();
    const again = await recordEvidenceRead(f.ws, f.handle, undefined, t0 + 1_000);
    assert.equal(again.selectionId, id);
    const usage = evidenceUsage(f.ws);
    assert.deepEqual([usage.selections, usage.reads, usage.readsFromSelection], [1, 4, 3]);
  } finally {
    f.done();
  }
});
