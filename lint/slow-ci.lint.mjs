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
 *   latency-bound  A test that asserts a measured latency (`worst`, `took`, `elapsed`, `p90(...)`, a `ms`) against a bound that is a
 *                literal under 2 s, or a constant that starts from one, and does not get it from `latencyBound()`
 *                (test/budget-scale.mjs): the bound scaled by the run's own quiet measurement and by JEVRIS_TEST_BUDGET_SCALE, which
 *                is 6 on the Windows runner and in `npm run test:slow`. A fixed bound is right on a quiet machine and wrong on a
 *                runner that stalls for 500 ms (the maintenance hot-commit test: 520 ms against 401, twice).
 *   platform-bound `const bound = process.platform === 'win32' ? 1200 : 400`. A Windows-only number is never run on the slow-host
 *                gate (a Mac cannot flip process.platform), so the value that matters is never tried before CI. Give the slow host
 *                the longer bound through `latencyBound()`, which the budget scale does on Windows CI and in `test:slow` alike.
 *   read-once    A test that starts or uses a real sidecar and reads what it writes later (the sidecar log, a trace file, the
 *                doctor view) with one read, no wait: the log and the traces are written asynchronously, and a start or a stop is
 *                seen a moment late on a slow disk (US25, US27, US29 and the sidecar-removal tests all failed this way). Wait for
 *                what is asserted (`readUntil`, `viewWhen`, a bounded loop on the content), or read after the sidecar's stop.
 *   second-event A test that sends two or more events to a real sidecar and asserts on the advice the later ones carry, with no
 *                deferral in mind. A subscriber whose first call took 100 ms or more is not waited for on its next event, and a
 *                cold first event takes that long on a slow host, so the second answer holds nothing (pending-advice-held, on
 *                windows-latest). Warm first and take the first answer that was not deferred (`warmHooks`, `untilShown`,
 *                test/acceptance/hook-settled.mjs; docs/testing.md, "Adding a test", item 7).
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

// ---- the rules added after the week of 2026-10-05 (latency-bound, platform-bound, read-once, second-event)

/** Where each test of a file starts (`test(`, `story(`, `it(`), with the text up to the next one: [{ at, text }]. */
function testBodies(text) {
  const starts = [...text.matchAll(/^[ \t]*(?:test|story|it)(?:\.\w+)?\(/gm)].map((m) => m.index);
  return starts.map((at, i) => ({ at, text: text.slice(at, starts[i + 1] ?? text.length) }));
}

/** The bound a test takes from the shared helper (test/budget-scale.mjs), or states for itself with a pinned budget. */
const SCALED_BOUND = /\blatencyBound\(|\bbudgetScaleOf\(|\bexactBudgets?\(/;
const CONST_DEF = /^[ \t]*(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/gm;
const PLATFORM_BOUND = /^[ \t]*(?:const|let)\s+(\w*(?:bound|limit|budget|ms|wait|deadline|cap|base|timeout|within|max|slow)\w*)\s*=\s*process\.platform\s*[!=]==?\s*['"]win32['"]\s*\?\s*([\d_]+)\s*:\s*([\d_]+)/gim;
/** What a test measures: the left side of a bound. */
const MEASURED_LEFT = /^(?:[\w.]*\.)?(?:(?:worst|slowest|longest)\w*|took|elapsed\w*|duration\w*|latenc\w*|waited\w*|ms|\w*p\d\d)(?:\(.*\))?$/i;
/** `measured < bound`, the bound a plain name or number: `took < TIMEOUT_MS + MARGIN_MS` (a bound plus a hang guard) is not one. */
const BOUND_COMPARISON = /([\w.]+(?:\([^()]*\))?)\)?\s*<=?\s*(\w+)\b(?!\s*[+*])/g;
const GUARD_LINE = /\bassert|\bok\(|\bif \(|\btiming\b|\.push\(/;

/** The constants of a file that start from a number of ms under the floor and do not use the shared helper: name -> line. */
function shortBounds(text) {
  const names = new Map();
  for (const m of text.matchAll(CONST_DEF)) {
    const expression = m[2];
    if (SCALED_BOUND.test(expression)) continue;
    const literal = /^\(?\s*([\d_]+)\b(?!\s*\*)/.exec(expression);
    const inherited = /^\(?\s*(\w+)\b/.exec(expression);
    const startsShort = literal !== null && num(literal[1]) >= 20 && num(literal[1]) < 2000;
    // A Windows-only number is a bound of its own (and flagged as one): `const base = process.platform === 'win32' ? 100 : 50`.
    const platform = /^process\.platform\s*[!=]==?\s*['"]win32['"]\s*\?\s*([\d_]+)\s*:\s*([\d_]+)/.exec(expression);
    const platformShort = platform !== null && Math.min(num(platform[1]), num(platform[2])) < 2000;
    if (startsShort || platformShort || (inherited !== null && names.has(inherited[1]))) names.set(m[1], lineOf(text, m.index));
  }
  return names;
}

function latencyBoundFindings(text, out) {
  for (const m of text.matchAll(PLATFORM_BOUND)) {
    if (num(m[2]) < 10_000 && num(m[3]) < 10_000) out.push({ rule: 'platform-bound', line: lineOf(text, m.index), detail: `${m[1]} is ${m[2]} on Windows and ${m[3]} elsewhere` });
  }
  const bounds = shortBounds(text);
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '');
    if (!GUARD_LINE.test(line) || /^\s*\*/.test(line)) return;
    for (const m of line.matchAll(BOUND_COMPARISON)) {
      if (!MEASURED_LEFT.test(m[1])) continue;
      const literal = /^[\d_]+$/.test(m[2]) ? num(m[2]) : null;
      if ((literal !== null && literal >= 20 && literal < 2000) || (literal === null && bounds.has(m[2]))) {
        out.push({ rule: 'latency-bound', line: index + 1, detail: `${m[1]} < ${m[2]}${literal === null ? ` (a bound from line ${bounds.get(m[2])} that does not use latencyBound())` : ''}` });
        return;
      }
    }
  });
}

const SIDECAR_USER = /\bstartDaemon\(|\bwithDaemon\(|\bensureSidecar\(|\bstartSidecar\(|['"]sidecar['"],\s*['"](?:start|stop|restart)['"]|\bsandbox\(/;
/** A read of something the sidecar writes later or changes with a start or a stop: its log, a trace file, its doctor view. */
const LATE_READ = [
  /\breadFileSync\([^;\n]*(?:sidecar\.log|['"]logs['"]|['"]traces?['"]|trace-)/,
  /\bbox\.read\([^)\n]*(?:sidecar\.log|logs|trace)/,
  /\bawait sidecarDoctorView\(/,
];
/** An explicit wait: a wait helper, a poll, a sleep. */
const POLL_WAIT = /\breadUntil\(|\bviewWhen\(|\buntilShown\(|\bwaitFor\w*\(|\bpollUntil\(|\buntil[A-Z]\w*\(|setTimeout|\bsleep\(|\bdelay\(/;
/** What makes a log or a trace read a settled one: the writes are flushed when the sidecar stops or its process has ended. */
const FLUSH_WAIT = /\.drained\(|\.flushSync\(|\bstop(?:Sidecar|Daemon)?\(|['"]stop['"]|\bexit\w*\(|['"](?:exit|close)['"]/;
/** A start, a stop or a restart of the sidecar: what a doctor view read after it has to wait for. */
const TRANSITION = /['"]sidecar['"],\s*['"](?:start|stop|restart)['"]|\b(?:start|stop|ensure)Sidecar\w*\(|\bstartDaemon\(|\bwithDaemon\(/;

function readOnceFindings(text, out) {
  if (!SIDECAR_USER.test(text)) return;
  for (const body of testBodies(text)) {
    const lines = body.text.split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!LATE_READ.some((pattern) => pattern.test(code)) || POLL_WAIT.test(code)) return;
      const before = lines.slice(0, index).join('\n');
      if (POLL_WAIT.test(before)) return;
      if (/sidecarDoctorView/.test(code)) {
        // The doctor view is read after a start or a stop of the sidecar, not before the test has done either, and a stop does not settle it.
        if (!TRANSITION.test(before)) return;
      } else if (FLUSH_WAIT.test(before) || FLUSH_WAIT.test(code)) return;
      out.push({ rule: 'read-once', line: lineOf(text, body.at) + index, detail: line.trim().slice(0, 80) });
    });
  }
}

const EVENT_SEND = /\bbox\.hook\(|\bsend\(|\bsidecarRequest\(\s*\{[^}]*\bop:\s*'event'|\brunLauncher\(/g;
/** Advice read off an answer: the lines a hook shows, the rendered outcome, a subscriber's own result. */
const ADVICE_READ = /\b(?:failureLines|adviceOf|rendered|chooseOutcome|showsLine|linesOf)\(|\.hookOutcome\b|\bresults\[/;
const DEFERRAL_AWARE = /\buntilShown\(|\bwarmHooks\(|\bDEFERRED\b|\bqueued\b|\banswer(?:ed)?Event\b|SUBSCRIBER_QUEUED|SUBSCRIBER_SLOW_SYNC/;

function secondEventFindings(text, out) {
  const bodies = testBodies(text);
  // A file that knows the deferral before its first test (it imports the helper, names the reason) is aware of it throughout.
  const header = text.slice(0, bodies[0]?.at ?? 0);
  if (!SIDECAR_USER.test(text) || DEFERRAL_AWARE.test(header)) return;
  for (const body of bodies) {
    const sends = [...body.text.matchAll(EVENT_SEND)];
    if (sends.length < 2 || DEFERRAL_AWARE.test(body.text)) continue;
    const after = body.text.slice(sends[1].index);
    const read = ADVICE_READ.exec(after);
    if (read !== null) out.push({ rule: 'second-event', line: lineOf(text, body.at + sends[1].index), detail: `${sends.length} events, then ${read[0].trim()}` });
  }
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
  latencyBoundFindings(text, out);
  readOnceFindings(text, out);
  secondEventFindings(text, out);
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

test('latency-bound and platform-bound: a measured latency against a fixed short bound, or a Windows-only number, is flagged; the shared helper is not', () => {
  const rules = (text) => slowFindings(text).map((f) => f.rule);
  // The maintenance hot-commit test as it was when windows-latest failed it (CI run 37324140640): a platform branch and a fixed base.
  const old = [
    "  const writeBound = process.platform === 'win32' ? 100 : 50;",
    "  const nearBusyBase = process.platform === 'win32' ? 1200 : 400;",
    '  const nearBusy = nearBusyBase + 10 * p90(quiet);',
    '  const bound = writeBound + 2 * p90(quiet);',
    '  if (!(p90(chunkMs) < bound)) timing.push(`chunks ${p90(chunkMs)}`);',
    '  if (!(worst < nearBusy)) timing.push(`worst hot commit ${worst}`);',
  ].join('\n');
  assert.deepEqual(rules(old).sort(), ['latency-bound', 'latency-bound', 'platform-bound', 'platform-bound']);
  const found = slowFindings(old);
  assert.deepEqual(found.filter((f) => f.rule === 'platform-bound').map((f) => f.line), [1, 2]);
  assert.match(found.find((f) => f.rule === 'latency-bound').detail, /a bound from line \d+ that does not use latencyBound/);
  // A literal bound, and a constant that starts from one.
  assert.deepEqual(rules('assert.ok(worst < 400, `slow ${worst}`);'), ['latency-bound']);
  assert.deepEqual(rules('assert.ok(elapsedMs <= 1500);'), ['latency-bound']);
  assert.deepEqual(rules('const LIMIT = 250;\nassert.ok(took < LIMIT);'), ['latency-bound']);
  assert.deepEqual(rules('const base = 400 + 10 * p90(quiet);\nconst limit = base * 2;\nassert.ok(latency < limit);'), ['latency-bound']);
  // The same bounds through the shared helper (and with its cap) are the fix.
  const fixed = ['const nearBusy = latencyBound(400, { quietMs: p90(quiet), capMs: 1500 });', 'const bound = latencyBound(50, { quietMs: p90(quiet), quietMultiple: 2, capMs: 100 });', 'if (!(worst < nearBusy)) timing.push(1);', 'if (!(p90(chunkMs) < bound)) timing.push(2);'].join('\n');
  assert.deepEqual(rules(fixed), []);
  assert.deepEqual(rules("const bound = latencyBound(400);\nassert.ok(took < bound);"), []);
  // What it is not about: a bound of 2 s or more (a hang guard), a hang guard added to a deadline, a number that is not a measured name,
  // a comment, a count, and a platform branch that is not a number.
  assert.deepEqual(rules('assert.ok(worst < 2500);'), []);
  assert.deepEqual(rules('assert.ok(took < TIMEOUT_MS + MARGIN_MS);'), [], 'a deadline plus a hang guard');
  assert.deepEqual(rules('const TIMEOUT_MS = 200;\nassert.ok(took < TIMEOUT_MS + MARGIN_MS);'), []);
  assert.deepEqual(rules('assert.ok(attempts < 400);'), []);
  assert.deepEqual(rules('assert.ok(rows.length <= 500);'), []);
  assert.deepEqual(rules('// failed `worst < 400` on windows-latest'), []);
  assert.deepEqual(rules("const mode = process.platform === 'win32' ? 0o666 : 0o600;"), []);
  assert.deepEqual(rules("const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';"), []);
  assert.deepEqual(rules("const pollMs = process.platform === 'win32' ? 20_000 : 12_000;"), [], 'a wait that is not a short bound');
});

test('read-once: a test that uses a real sidecar and reads its log, a trace or its doctor view once, with no wait, is flagged; every way of waiting passes', () => {
  const rules = (text) => slowFindings(text).map((f) => f.rule);
  const story = (body) => `story('US27', async ({ sandbox }) => {\n  const box = await sandbox();\n${body}\n});`;
  const log = "  const logText = readFileSync(join(paths.state, 'logs', 'sidecar.log'), 'utf8');";
  // us25 and us27 as CI failed them: the log read right after the requests.
  assert.deepEqual(rules(story(`  box.jevris(['status']);\n${log}`)), ['read-once']);
  assert.deepEqual(rules(story("  const trace = readFileSync(join(box.dir, 'traces', 'trace-2026-10-05.jsonl'), 'utf8');")), ['read-once']);
  assert.deepEqual(rules(story("  const out = box.read(join(rel, 'logs', 'sidecar.log'));")), ['read-once']);
  // sidecar-removal.test.mjs: the doctor view read right after a start.
  const doctor = "test('start', async () => {\n  await main(['sidecar', 'start', '--home', home]);\n  const view = await sidecarDoctorView(home);\n  assert.equal(view.state, 'running');\n});";
  assert.deepEqual(rules(`const { sidecarDoctorView } = x;\n${doctor}`), ['read-once']);
  assert.deepEqual(rules(doctor.replace("'sidecar', 'start'", "'sidecar', 'stop'")), ['read-once'], 'after a stop too');
  // Each way of waiting passes: a wait helper, a bounded loop with a sleep, the sidecar's stop before the read, the process's exit.
  assert.deepEqual(rules(story(`  await untilLog(box);\n${log}`)), []);
  assert.deepEqual(rules(story(`  for (let i = 0; i < 6_000 && !rejected(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));\n${log}`)), []);
  assert.deepEqual(rules(story(`  await box.stopSidecar();\n${log}`)), []);
  assert.deepEqual(rules(story(`  const exited = await exitOf(child);\n${log}`)), []);
  assert.deepEqual(rules(doctor.replace('await sidecarDoctorView(home)', 'await viewWhen(home, "running")')), []);
  assert.deepEqual(rules(doctor.replace('await sidecarDoctorView(home)', 'await readUntil(() => sidecarDoctorView(home), (v) => v.state === "running")')), []);
  // What it is not about: a doctor view read before the test starts or stops anything, a log read in a file that starts no sidecar, a comment.
  assert.deepEqual(rules("test('idle', async () => {\n  const view = await sidecarDoctorView(home);\n  assert.equal(view.state, 'idle');\n  await main(['sidecar', 'start', '--home', home]);\n});"), []);
  assert.deepEqual(rules("test('log', () => {\n  const text = readFileSync(join(dir, 'logs', 'worker.log'), 'utf8');\n});"), []);
  assert.deepEqual(rules(story("  // the log is read: readFileSync(join(x, 'logs', 'sidecar.log'))")), []);
  // The wait of an earlier test does not excuse a later one.
  assert.deepEqual(rules(`${story(`  await sleep(50);\n${log}`)}\n${story(log)}`), ['read-once']);
});

test('second-event: a test that sends two events to a real sidecar and asserts on the later advice without the deferral in mind is flagged; the deferral-aware helpers pass', () => {
  const rules = (text) => slowFindings(text).map((f) => f.rule);
  const real = "const box = await sandbox(t);\nassert.equal(box.startSidecar().code, 0);\n";
  // pending-advice-channels.test.mjs as CI failed it on windows-latest (run 37314945589): the second failure's own answer.
  const channels = `test('the line arrives once', async (t) => {\n  ${real}  assert.deepEqual(failureLines(box.hook('claude', failure('toolu_cc1'))), []);\n  const second = box.hook('claude', failure('toolu_cc2'));\n  assert.equal(adviceOf(second).key, 'systemMessage');\n});`;
  assert.deepEqual(rules(channels), ['second-event']);
  assert.equal(slowFindings(channels)[0].line, 5, 'at the second event');
  // pending-advice-held.test.mjs: an in-process daemon, `send` twice, the rendered outcome of the second.
  const held = "const { startDaemon } = await import('../dist/index.js');\ntest('a held line', async () => {\n  await withDaemon(t, async ({ send }) => {\n    const first = await send(chat(session));\n    const second = await send(chat(session));\n    assert.deepEqual(rendered(second), { kind: 'explain', text: LINE });\n  });\n});";
  assert.deepEqual(rules(held), ['second-event']);
  // The fix of 8a526f1: warm first, take the first answer that was not deferred, or know the deferral.
  assert.deepEqual(rules(channels.replace("assert.deepEqual(failureLines(box.hook('claude', failure('toolu_cc1'))), []);", "warmHooks(box, 'claude', warm);")), []);
  assert.deepEqual(rules(channels.replace("const second = box.hook('claude', failure('toolu_cc2'));", "const second = untilShown(box, 'claude', make, shows).hook;")), []);
  assert.deepEqual(rules(held.replace('const second = await send(chat(session));', 'const second = await send(chat(session));\n    assert.equal(second.queued, undefined);')), []);
  assert.deepEqual(rules(`import { DEFERRED } from './hook-settled.mjs';\n${channels}`), [], 'a file that names the deferral');
  // What it is not about: one event, two events whose answers no advice is read from, and a file with no real sidecar.
  assert.deepEqual(rules(`test('one', async (t) => {\n  ${real}  const only = box.hook('claude', one);\n  assert.equal(adviceOf(only).key, 'systemMessage');\n});`), []);
  assert.deepEqual(rules(`test('two', async (t) => {\n  ${real}  box.hook('claude', one);\n  const second = box.hook('claude', two);\n  assert.equal(second.code, 0);\n});`), []);
  assert.deepEqual(rules(channels.replace(real, '')), [], 'no sidecar of the test\'s own');
});

test('every rule added after the week of 2026-10-05 flags the test as it was when CI failed it, and the shapes of the fixes pass', async () => {
  const { execFileSync } = await import('node:child_process');
  const show = (commit, path) => {
    try {
      return execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  // Each row: the commit before the fix, the file, the rule it must flag. A clone with no history of that commit skips the row.
  const rows = [
    ['47c1b9a', 'apps/sidecar/test/maintenance-worker.test.mjs', 'platform-bound'],
    ['47c1b9a', 'apps/sidecar/test/maintenance-worker.test.mjs', 'latency-bound'],
    ['8a526f1~1', 'apps/sidecar/test/pending-advice-channels.test.mjs', 'second-event'],
    ['8a526f1~1', 'apps/sidecar/test/pending-advice-held.test.mjs', 'second-event'],
    ['8a526f1~1', 'apps/sidecar/test/pending-advice-outranked.test.mjs', 'second-event'],
    ['8ca670e~1', 'test/acceptance/us25.test.mjs', 'read-once'],
    ['8ca670e~1', 'test/acceptance/us27.test.mjs', 'read-once'],
    ['bc5575d~1', 'apps/cli/test/sidecar-removal.test.mjs', 'read-once'],
    ['bc5575d~1', 'apps/cli/test/admin-sidecar-removal.test.mjs', 'read-once'],
    ['24520c5~1', 'apps/cli/test/runtime-commands.test.mjs', 'bare-env'],
  ];
  for (const [commit, path, rule] of rows) {
    const old = show(commit, path);
    if (old === null) continue;
    assert.ok(slowFindings(old).some((f) => f.rule === rule), `${path} at ${commit} is flagged ${rule}`);
  }
});
