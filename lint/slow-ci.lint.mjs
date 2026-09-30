import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * Slow CI servers. The owner's rule (2026-09-30): a test must pass on a slow, loaded runner.
 * The Windows cells of the CI matrix run the whole suite in 25 to 40 minutes, start a process in
 * seconds and answer a git call in seconds. Four patterns failed there, or nearly did, because a
 * test assumed a fast machine; each is a finding here.
 *
 *   poll-bound   A fixed-count polling loop whose total wait (count x sleep) is under 10 s:
 *                `for (let i = 0; i < 200 && !ready(); i += 1) await sleep(5)`. A runner that
 *                stalls for a few seconds leaves the loop empty and the assertion after it fails.
 *   until-bound  A wait deadline under 10 s: `const until = Date.now() + 5000`.
 *   start-wait   A real sidecar start that waits under 10 s: `ensureSidecar({ waitMs: 8000 })`,
 *                `--wait-ms 3000`.
 *   exact-time   An assertion that names a step's exact run time, such as "(0s)" (verify:fresh
 *                printed "(1s)" on a slow runner).
 *
 * How to fix: raise the bound to a generous one (30 s or more; the loop or the wait ends as
 * soon as the condition holds, so a fast machine pays nothing), wait for the condition instead
 * of sleeping, or compare without the time text. A real-time bound that IS the behaviour under
 * test is driven by an injected clock or a deliberately stalled fake, not by a tight real
 * deadline. Asserting an elapsed-time window under 2 s is QA-05 (wall-clock.lint.mjs).
 *
 * A polling loop that deliberately waits a short, fixed time (a fixture a test writes for
 * another process to run, where the short wait is the subject) goes on ALLOW with its reason.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
export const FLOOR_MS = 10_000;

/** `file:rule` entries, each with the reason the short bound is the subject of the test. */
export const ALLOW = new Map([
  ['test/file-bound.test.mjs:poll-bound', 'the loops sit in fixture files the test writes to drive the file bound itself'],
]);

const num = (text) => Number(String(text).replace(/_/g, ''));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const LOOP = /for \(let (\w+) = 0; \1 < ([\d_]+)\b[^;\n]*;\s*\1(?: \+= 1|\+\+)\)\s*(\{[^}]{0,300}|[^\n]{0,260})/g;
const SLEEP = /(?:setTimeout\((?:\w+|\([^)]*\)\s*=>\s*\w+\(\)|[^,]+),\s*([\d_]+)\)|\b(?:sleep|delay|waitMs|wait|pause|nap)\(([\d_]+)\))/;
const UNTIL = /^[ \t]*(?:const|let)\s+(?:until|end|stopAt|giveUpAt)\s*=\s*Date\.now\(\)\s*\+\s*([\d_]+)\b/gm;
const START_WAIT = /(?:ensureSidecar\(\{[^}]*\bwaitMs:\s*([\d_]+)|['"]--wait-ms['"],\s*['"](\d+)['"])/g;
const EXACT_TIME = /\(\d+s\)/;

/** Findings in one file's text: [{ rule, line, detail }]. */
export function slowFindings(text) {
  const out = [];
  for (const m of text.matchAll(LOOP)) {
    const s = SLEEP.exec(m[3]);
    if (s === null) continue;
    const total = num(m[2]) * num(s[1] ?? s[2]);
    if (total >= 200 && total < FLOOR_MS) out.push({ rule: 'poll-bound', line: lineOf(text, m.index), detail: `${m[2]} x ${s[1] ?? s[2]} ms = ${total} ms` });
  }
  for (const m of text.matchAll(UNTIL)) {
    if (num(m[1]) < FLOOR_MS) out.push({ rule: 'until-bound', line: lineOf(text, m.index), detail: `${num(m[1])} ms` });
  }
  for (const m of text.matchAll(START_WAIT)) {
    const ms = num(m[1] ?? m[2]);
    if (ms > 0 && ms < FLOOR_MS) out.push({ rule: 'start-wait', line: lineOf(text, m.index), detail: `${ms} ms` });
  }
  text.split('\n').forEach((line, index) => {
    if (/\bassert|\bok\(/.test(line) && EXACT_TIME.test(line)) out.push({ rule: 'exact-time', line: index + 1, detail: line.trim().slice(0, 80) });
  });
  return out;
}

function findings() {
  const out = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const f of slowFindings(readFileSync(file, 'utf8'))) {
      if (!ALLOW.has(`${rel}:${f.rule}`)) out.push(`${rel}:${f.line} ${f.rule} (${f.detail})`);
    }
  }
  return out.sort();
}

test('no test assumes a fast machine: no short polling bound, wait deadline, sidecar start wait or exact run time (slow CI)', () => {
  assert.deepEqual(findings(), [], 'raise the bound to 30 s or more, wait for the condition, or compare without the time text (lint/slow-ci.lint.mjs)');
});

test('every allowlist entry still names a finding, so a fixed file leaves the list', () => {
  const seen = new Set();
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const f of slowFindings(readFileSync(file, 'utf8'))) seen.add(`${rel}:${f.rule}`);
  }
  assert.deepEqual([...ALLOW.keys()].filter((key) => !seen.has(key)), []);
});

test('the detector flags short polling loops, wait deadlines, start waits and exact run times, and passes generous ones', () => {
  const rules = (text) => slowFindings(text).map((f) => f.rule);
  assert.deepEqual(rules('for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 25));'), ['poll-bound']);
  assert.deepEqual(rules('for (let i = 0; i < 100 && alive(pid); i += 1) await delay(50);'), ['poll-bound']);
  assert.deepEqual(rules('for (let i = 0; i < 1_500 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 20));'), []);
  assert.deepEqual(rules('for (let i = 0; i < 3; i += 1) await client.ask();'), []);
  assert.deepEqual(rules('const until = Date.now() + 5000;'), ['until-bound']);
  assert.deepEqual(rules('const end = Date.now() + 60_000;'), []);
  assert.deepEqual(rules('await ensureSidecar({ home, waitMs: 8000 });'), ['start-wait']);
  assert.deepEqual(rules('await ensureSidecar({ home, waitMs: 0 });'), []);
  assert.deepEqual(rules("run(['sidecar', 'start', '--wait-ms', '3000']);"), ['start-wait']);
  assert.deepEqual(rules("run(['sidecar', 'start', '--wait-ms', '60000']);"), []);
  assert.deepEqual(rules("assert.ok(lines.includes('verify:fresh: lint: ok 110 tests (0s)'));"), ['exact-time']);
  assert.deepEqual(rules("assert.ok(lines.map(noSeconds).includes('verify:fresh: lint: ok 110 tests'));"), []);
  assert.deepEqual(rules("const SUMMARY = 'test: FAILED (exit 1) 10 tests (2s)';"), []);
});
