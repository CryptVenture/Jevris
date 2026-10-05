// K3 (owner decision DOMAINS ededdba; sidecar concurrency audit, lifecycle target): a compact
// restore and a Stop reminder are never queued behind load. While 50 subagents run concurrently
// in one parent session (the subagents50 shape: SubagentStart, 3 x PreToolUse/PostToolUse,
// SubagentStop each), four other sessions compact, restore and stop. Every SessionStart(compact)
// and Stop answer is given in its own hook call, never OK_QUEUED (B's answer slice, 867e928), and
// each answered one carries its restore context or its Stop reminder. The PreCompact that writes
// the capsule waits like an answer (B 528dff7); one whose write runs past the deadline itself is
// answered OK_QUEUED by design and held for its session, so that session's restore still carries
// the capsule. That is a latency outcome under host load (seen once at d4351f9), not a queued
// restore or Stop, and it is reported, not failed.
//
// Each hook is sent as the launcher sends it (op `event`, scope hook, hot budget, 1500 ms) with the
// Claude Code adapter, from one driver process, to a real sidecar started in a temporary home with
// stub harness binaries. No model is called and no real harness starts. The lifecycle hooks ride
// B's answer lane (63a0a31), so none is refused BUSY while subagent hooks fill the hot pool. The
// target is a count, not a latency, so it holds on a loaded machine: an answer that ran out of
// time (DEADLINE) is not a queued answer, and is reported, never counted as a pass.
//
// Two things keep a slow host from turning that count into a red test (windows-latest, CI run
// 37234452207: four PreCompact hooks ended as the client's own TIMEOUT, and 38 subagent hooks with
// them, in one round, with every other answer on time):
//
// - The sidecar is warm before the load starts. A burst of 50 subagents runs inside a parent
//   session that has already started, in a sidecar that has already served it; the first git
//   process, the first store open and the first security scan are paid before, not by the first
//   PreCompact. A sidecar has one event loop, and what the first use of a thing costs it (on
//   windows-latest a process start takes seconds) stops that loop for every hook in flight.
// - A client that gave up is judged by the sidecar's own record. A healthy sidecar answers before
//   its client leaves: its deadline answer is written 50 ms before the client's deadline. So a
//   client-side TIMEOUT is accepted only where a ticker in the sidecar process (and one in the
//   driver) shows that process's event loop standing still across the moment the answer was due,
//   and still standing when the client left. A TIMEOUT with a loop that was turning is a sidecar
//   that did not answer, and fails. The ticker is a preload of this test, never part of the product.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedHostSkip } from './managed-host.mjs';
import { repoRoot, sandbox } from './acceptance/lib.mjs';
import { certifyHooks } from './acceptance/certified-hooks.mjs';

const SUBAGENTS = 50;
const ROUNDS = 2;
const SESSIONS = 4;
/** The hook launcher's default deadline: the client's own wait, in ms. */
const CLIENT_TIMEOUT_MS = 1500;
/** The shortest stretch without a timer turn the tickers record, in ms. */
const STALL_MIN_MS = 100;
/**
 * A client that left with no answer is explained by a stall of the sidecar (or of the driver) that began at least this long before
 * it left: a loop that is turning answers at the slice of an answer-lane hook (90% of the time left) or, at the latest, 50 ms
 * before the client's deadline, so one that had not answered for the last 200 ms was not turning.
 */
const STALL_BEFORE_MS = 200;
/** ... and that had not ended by this long before the client left (the tickers tick every 10 ms). */
const STALL_UNTIL_MS = 30;

/** The sidecar's ticker: a preload (CommonJS) that writes `start end` for every stretch of 100 ms or more in which its loop ran no timer. */
const SIDECAR_TICKER = (log) => `
'use strict';
const path = require('node:path');
if (/sidecar/.test(path.basename(process.argv[1] ?? ''))) {
  const fs = require('node:fs');
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - last >= ${String(STALL_MIN_MS)}) {
      try {
        fs.appendFileSync(${JSON.stringify(log)}, last + ' ' + now + '\\n');
      } catch {
        // a ticker never takes the sidecar down
      }
    }
    last = now;
  }, 10);
  ticker.unref();
}
`;

/** The `[start, end]` pairs a ticker log holds; a line that is not two numbers is ignored. */
function readStalls(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+) (\d+)$/.exec(line.trim());
    if (match !== null) out.push([Number(match[1]), Number(match[2])]);
  }
  return out;
}

/** Whether one of `stalls` explains a client that waited `timeoutMs` from `began` and gave up with no answer. */
function stallExplains(stalls, began, timeoutMs = CLIENT_TIMEOUT_MS) {
  const leftAt = began + timeoutMs;
  return stalls.some(([from, to]) => from <= leftAt - STALL_BEFORE_MS && to >= leftAt - STALL_UNTIL_MS);
}

/** The load driver, run as its own process with the sandbox environment (sidecarRequest reads it). */
const DRIVER = `
import { join } from 'node:path';
const [sidecarUrl, adapterUrl, askUrl, work, subagentsText, roundsText, sessionsText, timeoutText] = process.argv.slice(2);
const sidecar = await import(sidecarUrl);
const { sidecarRequest } = sidecar;
const { normalize } = await import(adapterUrl);
const { waitUntilQuiet } = await import(askUrl);
const SUBAGENTS = Number(subagentsText);
const ROUNDS = Number(roundsText);
const SESSIONS = Number(sessionsText);
const TIMEOUT_MS = Number(timeoutText);
// The driver's own ticker: stretches of 100 ms or more in which this loop ran no timer.
const stalls = [];
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  if (now - lastTick >= 100) stalls.push([lastTick, now]);
  lastTick = now;
}, 10);
let serial = 0;
function nativeEvent(kind, { session, agent = null }) {
  serial += 1;
  const base = { session_id: session, transcript_path: join(work, '.no-transcript.jsonl'), cwd: work, permission_mode: 'default', ...(agent === null ? {} : { agent_id: agent, agent_type: 'general-purpose' }) };
  const tool = { tool_name: 'Bash', tool_use_id: 'toolu_' + serial, tool_input: { command: 'grep -rn load src/' + serial } };
  if (kind === 'pre') return { ...base, hook_event_name: 'PreToolUse', ...tool };
  if (kind === 'post') return { ...base, hook_event_name: 'PostToolUse', ...tool, tool_response: { stdout: 'x'.repeat(4000) } };
  if (kind === 'sstart') return { ...base, hook_event_name: 'SubagentStart' };
  if (kind === 'sstop') return { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false };
  if (kind === 'stop') return { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done ' + serial };
  if (kind === 'precompact') return { ...base, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' };
  if (kind === 'restore') return { ...base, hook_event_name: 'SessionStart', source: 'compact', model: 'claude-opus-5-5' };
  throw new Error(kind);
}
async function hook(native) {
  const normalized = normalize(native, {});
  if (!normalized.ok) return { kind: native.hook_event_name, code: 'NORMALIZE_' + normalized.reasonCode };
  const began = Date.now();
  const answer = await sidecarRequest({
    op: 'event',
    workspace: work,
    body: { envelope: normalized.event, deliveryKey: normalized.event.dedupKey, harnessVersion: '2.1.280', ...(normalized.intent ?? {}) },
    scope: 'hook',
    timeoutMs: TIMEOUT_MS,
    eventAtMs: Date.now(),
    budget: 'hot',
  });
  const queued = answer.ok && Array.isArray(answer.result?.queued) ? answer.result.queued : [];
  const code = answer.ok ? (queued.length > 0 ? 'OK_QUEUED' : answer.result?.duplicate ? 'OK_DUP' : 'OK') : (answer.reasonCode ?? 'SIDECAR_' + String(answer.reason).toUpperCase());
  const outcome = answer.ok ? answer.result?.results?.orchestrator?.hookOutcome ?? null : null;
  return { kind: native.hook_event_name, session: native.session_id, code, queued, began, ms: Date.now() - began, outcome: outcome === null ? null : { kind: outcome.kind ?? null, reasonCode: outcome.reasonCode ?? null, text: typeof outcome.text === 'string' ? outcome.text.slice(0, 200) : null } };
}
async function subagents(session, count) {
  const out = [];
  const one = async (i) => {
    const o = { session, agent: 'a' + i + '_' + serial };
    out.push(await hook(nativeEvent('sstart', o)));
    for (let c = 0; c < 3; c += 1) {
      out.push(await hook(nativeEvent('pre', o)));
      out.push(await hook(nativeEvent('post', o)));
    }
    out.push(await hook(nativeEvent('sstop', o)));
  };
  await Promise.all(Array.from({ length: count }, (_, i) => one(i)));
  return out;
}
// Warm-up, outside the measured load: one quiet session compacts, restores and stops, and two subagents run, so the first git
// process, the first store open and the first scans of each hook kind are behind the sidecar before 50 subagents start. What these
// answer is not judged. The sidecar's own background work for them (a capsule write that outlived its deadline) ends first.
const warm = [];
for (const kind of ['precompact', 'restore', 'stop']) warm.push((await hook(nativeEvent(kind, { session: 'k3-warm' }))).code);
warm.push(...(await subagents('k3-warm', 2)).map((s) => s.code));
const quietBeforeLoad = await waitUntilQuiet(sidecar, { workspace: work });
const lifecycle = [];
const load = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const burst = subagents('k3-burst-' + round, SUBAGENTS);
  await Promise.all(Array.from({ length: SESSIONS }, async (_, i) => {
    const o = { session: 'k3-life-' + round + '-' + i };
    lifecycle.push(await hook(nativeEvent('precompact', o)));
    lifecycle.push(await hook(nativeEvent('restore', o)));
    lifecycle.push(await hook(nativeEvent('stop', o)));
  }));
  load.push(...(await burst));
}
// One quiet session after the load: the same three hooks with nothing else in flight.
const quiet = [];
for (const kind of ['precompact', 'restore', 'stop']) quiet.push(await hook(nativeEvent(kind, { session: 'k3-quiet' })));
clearInterval(ticker);
process.stdout.write(JSON.stringify({ warm, quietBeforeLoad, lifecycle, quiet, load: load.map((s) => ({ code: s.code, began: s.began })), driverStalls: stalls }));
`;

function runDriver(box) {
  const sidecarUrl = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href;
  const adapterUrl = pathToFileURL(join(repoRoot, 'packages', 'adapter-claude-code', 'dist', 'index.js')).href;
  const askUrl = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'scripts', 'sidecar-ask.mjs')).href;
  const driver = box.write('k3-driver.mjs', DRIVER);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, sidecarUrl, adapterUrl, askUrl, box.work, String(SUBAGENTS), String(ROUNDS), String(SESSIONS), String(CLIENT_TIMEOUT_MS)], { cwd: box.work, env: box.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the load driver exited ${code}: ${stderr.slice(0, 2000)}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

const tally = (codes) => codes.reduce((acc, code) => ({ ...acc, [code]: (acc[code] ?? 0) + 1 }), {});

/** The outcomes of an answer that is in time or ran out of time on the sidecar's side. */
const ANSWERED = /^(OK|OK_DUP|DEADLINE)$/;
/** The outcomes of a client that left before any answer came: the connect, the handshake or the answer ran past its wait. */
const GAVE_UP = /^(CONNECT_TIMEOUT|HANDSHAKE_TIMEOUT|TIMEOUT)$/;

/**
 * What of `hooks` is neither answered nor a client that gave up while a loop stood still: the codes that fail the run. A PreCompact
 * whose write ran past its deadline reads OK_QUEUED by design and counts as answered; `extra` names the codes one more kind of hook
 * may end in (a subagent hook may be queued or refused BUSY).
 */
function lostHooks(hooks, stalls, { extra = null } = {}) {
  const lost = [];
  for (const hook of hooks) {
    const code = hook.kind === 'PreCompact' && hook.code === 'OK_QUEUED' ? 'OK' : hook.code;
    if (ANSWERED.test(code) || (extra !== null && extra.test(code))) continue;
    if (GAVE_UP.test(code) && stallExplains(stalls, hook.began)) continue;
    lost.push(code);
  }
  return lost;
}

test('K3: compact restores and Stop reminders are never queued while 50 subagents run (owner decision ededdba)', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  // The lifecycle target is about the product's own budgets and the hook's own 1500 ms wait, so the sidecar keeps them exactly whatever
  // scale the runner sets (test/budget-scale.mjs); a slow host is judged by the stall evidence below.
  const box = await sandbox(t, { exactBudgets: true });
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['R-1'], description: 'unit' }],
  });
  box.gitInit();
  const approved = await box.approveChecks();
  assert.equal(approved.code, 0, approved.reason);
  await certifyHooks(box);
  // The sandbox's environment is the one the CLI hands the sidecar it starts, so the ticker goes into it before the start.
  const tickerLog = join(box.dir, 'sidecar-stalls.log');
  const tickerPreload = join(box.dir, 'sidecar-ticker.cjs');
  writeFileSync(tickerPreload, SIDECAR_TICKER(tickerLog.replace(/\\/g, '/')));
  box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS ?? ''} --require "${tickerPreload.replace(/\\/g, '/')}"`.trim();
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  t.after(() => box.stopSidecar());

  const { warm, quietBeforeLoad, lifecycle, quiet, load, driverStalls } = await runDriver(box);
  const sidecarStalls = readStalls(existsSync(tickerLog) ? readFileSync(tickerLog, 'utf8') : '');
  const stalls = [...sidecarStalls, ...driverStalls];
  const answers = lifecycle.filter((s) => s.kind === 'SessionStart' || s.kind === 'Stop');
  assert.equal(answers.length, 2 * ROUNDS * SESSIONS, 'every restore and Stop was sent');
  assert.equal(load.length, ROUNDS * SUBAGENTS * 8, 'every subagent hook was sent');
  // The slowest answer of each lifecycle kind, in ms: what the load cost them.
  const slowest = lifecycle.reduce((acc, s) => ({ ...acc, [s.kind]: Math.max(acc[s.kind] ?? 0, s.ms) }), {});
  const longest = (list) => list.reduce((most, [from, to]) => Math.max(most, to - from), 0);
  const report = `lifecycle ${JSON.stringify(tally(lifecycle.map((s) => `${s.kind}:${s.code}`)))}; slowest ${JSON.stringify(slowest)} ms; subagent hooks ${JSON.stringify(tally(load.map((s) => s.code)))}; loop stalls of 100 ms or more, longest ${String(longest(sidecarStalls))} ms in the sidecar (${String(sidecarStalls.length)}) and ${String(longest(driverStalls))} ms in the driver (${String(driverStalls.length)}); warm-up ${JSON.stringify(tally(warm))}${quietBeforeLoad ? '' : ', the sidecar was still busy when the load began'}`;
  t.diagnostic(report);

  // The locked target: under load, a restore or a Stop is never answered from the queue.
  assert.deepEqual(answers.filter((s) => s.code === 'OK_QUEUED').map((s) => `${s.kind} queued ${s.queued.join(',')}`), [], report);
  // The answer lane (B 63a0a31) keeps hot slots for them: a lifecycle hook is never refused BUSY
  // at admission, however full the pool is with subagent hooks.
  assert.deepEqual(lifecycle.filter((s) => s.code === 'BUSY').map((s) => s.kind), [], report);
  // Every answer is in time or ran out of time (DEADLINE), never lost silently. A client that left before any answer came is
  // accepted only where a loop of the sidecar (or of the driver) stood still across the moment the answer was due.
  assert.deepEqual(lostHooks(lifecycle, stalls), [], report);
  assert.deepEqual(lostHooks(load, stalls, { extra: /^(OK_QUEUED|BUSY)$/ }), [], report);
  // An answered restore after its session's own PreCompact carries the capsule, also when that
  // PreCompact's write ran on past its deadline (held for the session, B 528dff7); an answered
  // Stop names the mandatory check `unit`, which never ran, as missing verification.
  const precompacted = new Set(lifecycle.filter((s) => s.kind === 'PreCompact' && (s.code === 'OK' || s.code === 'OK_QUEUED')).map((s) => s.session));
  for (const s of answers.filter((a) => a.code === 'OK')) {
    if (s.kind === 'Stop') assert.match(s.outcome?.text ?? '', /unit:missing/, `a Stop without its reminder: ${JSON.stringify(s.outcome)}; ${report}`);
    else if (precompacted.has(s.session)) {
      assert.equal(s.outcome?.kind, 'context', `a compact restore without its context: ${JSON.stringify(s.outcome)}; ${report}`);
      assert.match(s.outcome.text ?? '', /resumed context from capsule/, report);
    }
  }
  // The same path, quiet: the restore and the reminder are delivered, so the checks above are not vacuous.
  assert.deepEqual(quiet.map((s) => `${s.kind}:${s.code}`), ['PreCompact:OK', 'SessionStart:OK', 'Stop:OK'], report);
  assert.match(quiet[1].outcome?.text ?? '', /resumed context from capsule/);
  assert.match(quiet[2].outcome?.text ?? '', /unit:missing/);
});

// The judgement of a client that gave up, with no sidecar and no clock: a stall explains it only where it covers the moment the
// answer was due and had not ended before the client left.
test('K3: a client that left with no answer is explained only by a loop that stood still across the moment the answer was due', () => {
  const began = 1_000_000;
  const leftAt = began + CLIENT_TIMEOUT_MS;
  // The whole of the wait: the loop stood still from before the answer was due until after the client left (windows-latest).
  assert.equal(stallExplains([[began + 100, leftAt + 400]], began), true, 'a stall across the whole wait');
  assert.equal(stallExplains([[began + 1_300, leftAt]], began), true, 'a stall for the last 200 ms of the wait');
  // The loop was turning when the answer was due, or turned again in time: a healthy sidecar answers, so there is no excuse.
  assert.equal(stallExplains([], began), false, 'no stall at all');
  assert.equal(stallExplains([[began, began + 1_000]], began), false, 'a stall that ended while there was time to answer');
  assert.equal(stallExplains([[began + 1_400, leftAt + 400]], began), false, 'a stall that began after the answer was due and when the loop was already answering');
  assert.equal(stallExplains([[began + 400, began + 1_460]], began), false, 'a stall that ended before the client left');
  assert.equal(stallExplains([[began - 3_000, began - 1_500]], began), false, 'a stall of an earlier wait');
  // A client that waited longer is judged by its own deadline.
  assert.equal(stallExplains([[began + 3_000, began + 4_500]], began, 4_000), true);
  // The ticker log.
  assert.deepEqual(readStalls('100 250\nnot a line\n\n300 450\n12 x\n'), [[100, 250], [300, 450]]);
  // What fails a run: an answer is in time, ran out of time, or came from a PreCompact whose write ran on; a client that gave up is
  // accepted only with a stall, and any other reason (a refusal, a malformed answer) is never accepted.
  const hooks = [
    { kind: 'PreCompact', code: 'OK_QUEUED', began },
    { kind: 'SessionStart', code: 'DEADLINE', began },
    { kind: 'Stop', code: 'TIMEOUT', began },
    { kind: 'PreCompact', code: 'HANDSHAKE_TIMEOUT', began },
    { kind: 'Stop', code: 'BUSY', began },
    { kind: 'SessionStart', code: 'OK_QUEUED', began },
    { kind: 'SessionStart', code: 'REFUSED', began },
  ];
  assert.deepEqual(lostHooks(hooks, []), ['TIMEOUT', 'HANDSHAKE_TIMEOUT', 'BUSY', 'OK_QUEUED', 'REFUSED'], 'with no stall every give-up, refusal and queued restore is lost');
  assert.deepEqual(lostHooks(hooks, [[began + 100, leftAt + 400]]), ['BUSY', 'OK_QUEUED', 'REFUSED'], 'a stall explains the give-ups, and only those');
  assert.deepEqual(lostHooks(hooks, [], { extra: /^(OK_QUEUED|BUSY)$/ }).sort(), ['HANDSHAKE_TIMEOUT', 'REFUSED', 'TIMEOUT'], 'a subagent hook may be queued or refused BUSY');
});
