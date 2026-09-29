// P6 (sidecar concurrency audit): a check's output is parsed in linear time and stored without
// holding the event loop for the whole hash and write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openEvidenceStore, parseJUnit } from '../dist/index.js';
import { tempDir } from './temp-dirs.mjs';

/** The earlier case pattern, as the reference the linear scan must agree with. */
function referenceCases(text) {
  const out = [];
  for (const m of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) out.push([m[1] ?? '', m[3] ?? '']);
  return out;
}

/** A small seeded generator (no Math.random: a failure replays). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = ['<testcase name="a"/>', '<testcase name="b">', '</testcase>', '<failure message="x &amp; y"/>', '<skipped/>', '<testcases>', '<testcase/>', '<testcase classname="c" name="d">', 'text', '<error message="e">', '>', '/', '<testsuite tests="3">', '</testsuite>'];

test('the linear JUnit scan finds the same cases as the earlier pattern, over seeded random documents', () => {
  const next = rng(20260927);
  for (let doc = 0; doc < 400; doc += 1) {
    const parts = [];
    const n = 1 + Math.floor(next() * 14);
    for (let i = 0; i < n; i += 1) parts.push(PIECES[Math.floor(next() * PIECES.length)]);
    const text = `<testsuite>${parts.join('')}</testsuite>`;
    const expected = referenceCases(text);
    const got = parseJUnit(text);
    if (expected.length === 0) {
      assert.ok(got === null || got.total >= 0, text);
      continue;
    }
    assert.equal(got?.total, expected.length, text);
    const failed = expected.filter(([, body]) => !/<skipped\b/.test(body) && /<(failure|error)\b/.test(body)).length;
    const skipped = expected.filter(([, body]) => /<skipped\b/.test(body)).length;
    assert.deepEqual([got.failed, got.skipped], [failed, skipped], text);
  }
});

test('many unclosed test cases parse in one pass (the earlier pattern rescanned to the end for each)', () => {
  const text = `<testsuite>${'<testcase name="open">'.repeat(40_000)}<testcase name="last"/></testsuite>`;
  const result = parseJUnit(text);
  assert.equal(result?.total, 1);
  assert.equal(result?.failures.length, 0);
});

test('storing 12 MiB of check output lets the event loop turn, and the handle is the content hash', async () => {
  const store = openEvidenceStore(join(tempDir('jv-ev-'), 'evidence'));
  const bytes = new Uint8Array(12 * 1024 * 1024).fill(65);
  let turns = 0;
  let running = true;
  const spin = () => {
    turns += 1;
    if (running) setTimeout(spin, 0);
  };
  setTimeout(spin, 0);
  const meta = await store.put({ workspaceId: 'wsP6', kind: 'runner-output', bytes, nowMs: 1 });
  running = false;
  assert.ok(turns >= 3, `the loop turned ${String(turns)} times while the output was stored`);
  assert.equal(meta.handle, `ev:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.equal(meta.bytes, bytes.length);
  assert.equal(store.get(meta.handle, 'wsP6')?.length, bytes.length);
  // Storing it again is idempotent.
  assert.equal((await store.put({ workspaceId: 'wsP6', kind: 'runner-output', bytes, nowMs: 2 })).handle, meta.handle);
});
