// Sidecar concurrency audit P6: a check's large output is joined, hashed, parsed and viewed in a
// worker thread, with the same product as the inline path, and the inline path takes over
// whenever the worker is absent, fails or does not answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  OFF_LOOP_OUTPUT_BYTES,
  manifestHash,
  openWorkspace,
  outputRecordOf,
  parseManifest,
  parseTap,
  processOutput,
  processOutputOffLoop,
  runCheck,
  runVerification,
  approveManifests,
  setOutputWorkerScript,
} from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const ENTRY = new URL('./fixtures/output-worker-entry.mjs', import.meta.url);
const SILENT = new URL('./fixtures/silent-worker-entry.mjs', import.meta.url);

/** A TAP stream of about `bytes`, with one failure near the end. */
function tapOutput(bytes) {
  const line = 'ok 1 - a passing test with a name long enough to fill the stream\n';
  const n = Math.ceil(bytes / line.length);
  const text = `TAP version 13\n${line.repeat(n)}not ok 2 - the one failure\n  expected: 1\n  actual: 2\n1..${n + 1}\n`;
  return new TextEncoder().encode(text);
}

function job(stdout, stderr = new TextEncoder().encode('a warning\n')) {
  return { stdout, stderr, resultFormat: 'tap', resultFileText: null, command: 'check unit', exitCode: 1 };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('P6: the worker thread gives the inline product for a large output; below the threshold, with no script or with a failing script, the caller does it inline', async (t) => {
  t.after(() => setOutputWorkerScript(null));
  const large = job(tapOutput(OFF_LOOP_OUTPUT_BYTES * 2));
  const inline = processOutput(large);
  assert.equal(inline.sha256, sha256(inline.raw));
  assert.deepEqual(inline.results, parseTap(new TextDecoder().decode(large.stdout)));
  assert.equal(inline.results.failed, 1);
  assert.equal(inline.view.result.handle, `ev:${inline.sha256}`);
  assert.equal(inline.view.result.mode, 'distilled');
  assert.match(inline.view.result.text, /not ok 2 - the one failure/);

  setOutputWorkerScript(null);
  assert.equal(await processOutputOffLoop(large), null, 'no worker script: inline');

  setOutputWorkerScript(ENTRY);
  const off = await processOutputOffLoop(large);
  assert.equal(off?.where, 'worker');
  assert.deepEqual([off.sha256, off.stdoutLength, off.results, off.view], [inline.sha256, inline.stdoutLength, inline.results, inline.view]);
  assert.deepEqual(off.raw, inline.raw);
  assert.ok(large.stdout.length > OFF_LOOP_OUTPUT_BYTES, 'the caller keeps its bytes (a copy went to the worker)');
  // Several at once, answered each to its own caller.
  const outputs = [tapOutput(OFF_LOOP_OUTPUT_BYTES), tapOutput(OFF_LOOP_OUTPUT_BYTES + 4096), tapOutput(OFF_LOOP_OUTPUT_BYTES + 8192)].map((s) => job(s));
  const answers = await Promise.all(outputs.map((j) => processOutputOffLoop(j)));
  assert.deepEqual(answers.map((a) => a?.sha256), outputs.map((j) => processOutput(j).sha256));
  assert.equal(await processOutputOffLoop(job(tapOutput(1024))), null, 'a small output stays inline');

  setOutputWorkerScript(new URL('./fixtures/no-such-entry.mjs', import.meta.url));
  assert.equal(await processOutputOffLoop(large), null, 'a worker that cannot start: inline');
  setOutputWorkerScript(SILENT);
  assert.equal(await processOutputOffLoop(large, 300), null, 'a worker that does not answer in time: inline');
  setOutputWorkerScript(ENTRY);
  assert.equal((await processOutputOffLoop(large))?.where, 'worker', 'the next large output starts a fresh worker');
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('P6: a check with a large output stores the worker\'s bytes under the worker\'s hash, and the verify run records the view against that handle', async (t) => {
  t.after(() => setOutputWorkerScript(null));
  const dir = tempDir('jv-p6-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  try {
    setOutputWorkerScript(ENTRY);
    const lines = Math.ceil((OFF_LOOP_OUTPUT_BYTES * 2) / 40);
    const script = `const o=['TAP version 13'];for(let i=1;i<=${lines};i++)o.push('ok '+i+' - passing test number '+i);o.push('not ok ${lines + 1} - broken');o.push('1..${lines + 1}');console.log(o.join('\\n'));console.error('warn');process.exitCode=1`;
    const parsed = parseManifest({ id: 'big', argv: [process.execPath, '-e', script], resultFormat: 'tap', timeoutMs: 60_000 });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const m = parsed.manifest;
    const run = await runCheck(m, { workspaceRoot: repo, workspaceId: ws.workspaceId, evidence: ws.evidence, receipts: ws.receipts });
    const r = run.receipt;
    assert.deepEqual([r.outcome, r.outcomeReason, r.results.failed, r.results.passed], ['failed', 'structured-failures', 1, lines]);
    const stored = ws.evidence.get(r.rawOutputHandle, ws.workspaceId);
    assert.equal(`ev:${sha256(stored)}`, r.rawOutputHandle, 'the handle is the stored bytes\' hash');
    assert.ok(stored.length > OFF_LOOP_OUTPUT_BYTES);
    assert.equal(run.view.result.handle, r.rawOutputHandle);
    assert.match(run.view.result.text, /not ok \d+ - broken/);
    // Through the verify service: the view record is written against the handle.
    await approveManifests(ws, [m], { big: manifestHash(m) }, 'test');
    const verified = await runVerification(ws, { checkIds: ['big'] });
    const handle = verified.ran[0].receipt.rawOutputHandle;
    const record = outputRecordOf(ws, handle);
    assert.deepEqual([record.mode, record.errorState, record.stderrBytes > 0], ['distilled', 'failed', true]);
    assert.match(record.viewText, /broken/);
  } finally {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});
