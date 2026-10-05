import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * Slow CI servers. The owner's rule (2026-09-30): a test must pass on a slow, loaded runner.
 * The Windows cells of the CI matrix run the whole suite in 25 to 40 minutes, start a process in
 * seconds and answer a git call in seconds. Five patterns failed there, or nearly did, because a
 * test assumed a fast machine; each is a finding here.
 *
 *   poll-bound   A fixed-count polling loop whose total wait (count x sleep) is under 10 s:
 *                `for (let i = 0; i < 200 && !ready(); i += 1) await sleep(5)`. A runner that
 *                stalls for a few seconds leaves the loop empty and the assertion after it fails.
 *   until-bound  A wait deadline under 10 s: `const until = Date.now() + 5000`.
 *   start-wait   A real sidecar start that waits under 10 s: `ensureSidecar({ waitMs: 8000 })`,
 *                `--wait-ms 3000`.
 *   hot-daemon   A test that starts a real daemon (startDaemon) and sends hook-scope or hot-budget
 *                requests with the default 900 ms budget: `limits: { budgetMs: { hot: 60_000,
 *                background: 60_000 } }` on the daemon and `timeoutMs: 60_000` on the request
 *                (windows-latest DEADLINE in approved-scope INT-05 and security-subscriber GOV-12).
 *   exact-time   An assertion that names a step's exact run time, such as "(0s)" (verify:fresh
 *                printed "(1s)" on a slow runner).
 *   bare-env     A test that starts a real sidecar from a child process whose environment it builds
 *                by hand (`{ PATH, HOME, USERPROFILE, JEVRIS_SIDECAR_ENTRY }`), with no slow-host
 *                setting. A hand-built environment has none of the runner's (JEVRIS_TEST,
 *                JEVRIS_SIDECAR_WAIT_MS, the budget scale), so the spawned CLI waits the product's 5 s
 *                for the start and answers "The Jevris sidecar is starting; this call ran
 *                rules-only." (windows-latest, CI run 37293344243, runtime-commands.test.mjs).
 *                JEVRIS_SIDECAR_WAIT_MS alone is not enough: the product reads it only under
 *                JEVRIS_TEST=1. It is a net, not a proof: it reads one file's text and looks for an
 *                object literal with no spread, so an environment built any other way is not seen.
 *
 * How to fix: raise the bound to a generous one (30 s or more; the loop or the wait ends as
 * soon as the condition holds, so a fast machine pays nothing), wait for the condition instead
 * of sleeping, or compare without the time text. For a hand-built child environment, spread
 * `slowHostSettings()` (test/budget-scale.mjs) into it, or pass `--wait-ms 60000`. A real-time bound that IS the behaviour under
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
  ['apps/sidecar/test/answer-lane.test.mjs:hot-daemon', 'the answer lane budget and the hot budget are what the file tests'],
  ['test/file-bound.test.mjs:poll-bound', 'the loops sit in fixture files the test writes to drive the file bound itself'],
]);

const num = (text) => Number(String(text).replace(/_/g, ''));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const LOOP = /for \(let (\w+) = 0; \1 < ([\d_]+)\b[^;\n]*;\s*\1(?: \+= 1|\+\+)\)\s*(\{[^}]{0,300}|[^\n]{0,260})/g;
const SLEEP = /(?:setTimeout\((?:\w+|\([^)]*\)\s*=>\s*\w+\(\)|[^,]+),\s*([\d_]+)\)|\b(?:sleep|delay|waitMs|wait|pause|nap)\(([\d_]+)\))/;
const UNTIL = /^[ \t]*(?:const|let)\s+(?:until|end|stopAt|giveUpAt)\s*=\s*Date\.now\(\)\s*\+\s*([\d_]+)\b/gm;
const START_WAIT = /(?:ensureSidecar\(\{[^}]*\bwaitMs:\s*([\d_]+)|['"]--wait-ms['"],\s*['"](\d+)['"])/g;
const EXACT_TIME = /\(\d+s\)/;
const STARTS_DAEMON = /\bstartDaemon\(|\bwithDaemon\(/;
const HOT_REQUEST = /scope: 'hook'|budget: 'hot'/;
const RAISED_BUDGET = /budgetMs:\s*\{\s*hot:\s*([\d_]+)/g;
const CHILD_PROCESS = /from ['"]node:child_process['"]/;
const STARTS_SIDECAR = /['"]sidecar['"],\s*['"](?:start|restart)['"]|\bJEVRIS_SIDECAR_ENTRY\s*:/;
const OBJECT_LITERAL = /\{[^{}]{0,600}\}/g;
/** Anything that gives the child a start wait, or no start at all: the settings helper, the variable, autostart off, a `--wait-ms` of 10 s or more. */
const WAIT_SETTING = /slowHostSettings\(|JEVRIS_SIDECAR_WAIT_MS|JEVRIS_SIDECAR_AUTOSTART|['"]--wait-ms['"],\s*['"]\d{5,}['"]/;

/** Where the first hand-built environment literal starts (no spread; PATH with HOME or USERPROFILE, or a sidecar entry), or -1. */
function handBuiltEnv(text) {
  for (const m of text.matchAll(OBJECT_LITERAL)) {
    const literal = m[0];
    if (literal.includes('...')) continue;
    const clean = /\bPATH\b\s*:/.test(literal) && /\b(?:HOME|USERPROFILE)\b\s*:/.test(literal);
    if (clean || /\bJEVRIS_SIDECAR_ENTRY\s*:/.test(literal)) return m.index;
  }
  return -1;
}

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
  if (STARTS_DAEMON.test(text) && HOT_REQUEST.test(text)) {
    const raised = [...text.matchAll(RAISED_BUDGET)].some((m) => num(m[1]) >= 30_000);
    if (!raised) out.push({ rule: 'hot-daemon', line: lineOf(text, text.search(HOT_REQUEST)), detail: 'hook or hot requests to a real daemon with the default 900 ms budget' });
  }
  text.split('\n').forEach((line, index) => {
    if (/\bassert|\bok\(/.test(line) && EXACT_TIME.test(line)) out.push({ rule: 'exact-time', line: index + 1, detail: line.trim().slice(0, 80) });
  });
  if (CHILD_PROCESS.test(text) && STARTS_SIDECAR.test(text) && !WAIT_SETTING.test(text)) {
    const at = handBuiltEnv(text);
    if (at >= 0) out.push({ rule: 'bare-env', line: lineOf(text, at), detail: 'a child with a hand-built environment starts a sidecar and has no slow-host setting' });
  }
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

test('no test assumes a fast machine: no short polling bound, wait deadline, sidecar start wait, exact run time or bare child environment (slow CI)', () => {
  assert.deepEqual(findings(), [], 'raise the bound to 30 s or more, wait for the condition, compare without the time text, or give a hand-built child environment slowHostSettings() (lint/slow-ci.lint.mjs)');
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
  const daemon = (limits) => `const s = await startDaemon({ home${limits} });\nsidecarRequest({ op: 'event', scope: 'hook' });`;
  assert.deepEqual(rules(daemon('')), ['hot-daemon']);
  assert.deepEqual(rules(daemon(', limits: { budgetMs: { hot: 900, background: 5000 } }')), ['hot-daemon']);
  assert.deepEqual(rules(daemon(', limits: { budgetMs: { hot: 60_000, background: 60_000 } }')), []);
  assert.deepEqual(rules("await startDaemon({ home }); sidecarRequest({ op: 'status', scope: 'cli' });"), []);
  assert.deepEqual(rules("const SUMMARY = 'test: FAILED (exit 1) 10 tests (2s)';"), []);
});

test('the detector flags a hand-built child environment that starts a sidecar with no slow-host setting, and passes every way of giving it one', () => {
  const rules = (text) => slowFindings(text).map((f) => f.rule);
  const spawn = "import { spawnSync } from 'node:child_process';\n";
  // The environment of runtime-commands.test.mjs when CI run 37293344243 failed on it.
  const old = `${spawn}const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN };\nrunCli(['sidecar', 'start', '--home', home], env);`;
  assert.deepEqual(rules(old), ['bare-env']);
  assert.equal(slowFindings(old)[0].line, 2);
  assert.deepEqual(rules(`${spawn}const env = { PATH, HOME: home, JEVRIS_SIDECAR_ENTRY: ENTRY };\nrun(['sidecar', 'restart']);`), ['bare-env']);
  assert.deepEqual(rules(`${spawn}spawnSync(node, [bin], { env: { PATH, USERPROFILE: home, JEVRIS_SIDECAR_ENTRY: ENTRY } });`), ['bare-env'], 'the entry alone names a sidecar to start');
  // Each way of giving the child a start wait, or no start, passes.
  assert.deepEqual(rules(old.replace('JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN }', 'JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN, ...slowHostSettings() }')), []);
  assert.deepEqual(rules(old.replace('JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN }', "JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN, JEVRIS_TEST: '1', JEVRIS_SIDECAR_WAIT_MS: '60000' }")), []);
  assert.deepEqual(rules(old.replace("'--home', home]", "'--home', home, '--wait-ms', '60000']")), []);
  assert.deepEqual(rules(old.replace('JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN }', "JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN, JEVRIS_SIDECAR_AUTOSTART: '0' }")), []);
  assert.deepEqual(rules(old.replace("{ PATH: process.env.PATH ?? ''," , '{ ...process.env,')), [], 'the runner\'s environment is inherited');
  // What it is not about: a child that starts no sidecar, a start in this process, an environment built from the runner's.
  assert.deepEqual(rules(`${spawn}spawnSync(file, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: home, JEVRIS_TEST: '1' } });`), []);
  assert.deepEqual(rules(old.replace(spawn, '')), [], 'no child process in the file: main() runs in this process, with the runner\'s environment');
  assert.deepEqual(rules(`${spawn}const env = { ...process.env, HOME: home, JEVRIS_HOME: home };\nrun(['sidecar', 'start', '--home', home], env);`), []);
  // A short explicit wait is the start-wait rule's finding, and still no wait setting here.
  assert.deepEqual(rules(old.replace("'--home', home]", "'--home', home, '--wait-ms', '3000']")), ['start-wait', 'bare-env']);
});
