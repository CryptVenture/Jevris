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
// - The sidecar starts git off its event loop. Starting a process is a blocking call of the thread that makes it (on windows-latest
//   CreateProcess runs inside `spawn`, and four sessions compacting together stood the loop still for four of them: CI run
//   37329307976, a stall of 3.7 s, 8 lifecycle and 54 subagent hooks lost, then a quiet round that was not quiet). The product's git
//   worker thread does it (packages/orchestrator/src/verify/git-work.ts), and the second test below gives every git process a
//   300 ms start, blocking whichever thread makes it, and asserts that once the worker is up none starts on the main thread.
// - The 50 subagent streams do not share one event loop. A driver that carried them in one loop stands still itself on a slow host:
//   every request opens three small files (the sidecar's endpoint, key and locality) with a synchronous call, and on a host that opens a
//   file in 6 ms 800 requests keep that loop blocked for 14 s, in stretches of seconds. Its clients then gave up (CLOSED, TIMEOUT) and
//   its requests reached the sidecar with their time half spent and were answered from the queue: a test that cannot keep up, not a
//   sidecar that does not answer (the slow-host gate, `npm run test:slow`, failed this test in 3 runs of 4 that way, while the
//   sidecar's own loop stood still for 0.8 s at most; on windows-latest the driver never stood still). In life each hook is a process of
//   its own, so the streams run on STREAM_LOOPS worker threads of the driver, each with an event loop of its own.
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
import { gitStartPreload } from './git-start-probe.mjs';

const SUBAGENTS = 50;
const ROUNDS = 2;
const SESSIONS = 4;
/** Worker threads of the load driver that carry the subagent streams, each on an event loop of its own (50 streams: five on each). */
const STREAM_LOOPS = 10;
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
if (/sidecar/.test(path.basename(process.argv[1] ?? '')) && require('node:worker_threads').isMainThread) {
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

/**
 * The stalls that may explain a client that gave up: those of the sidecar, and those of the driver loop the client was sent from. The
 * driver has one loop for the lifecycle sessions and one for each share of the subagent streams (`driverStalls[0]` is the first), and a
 * stall of one loop does not stop another, so it explains only the clients of its own.
 */
function stallsFor(sidecarStalls, driverStalls) {
  return (hook) => [...sidecarStalls, ...(driverStalls[hook.loop ?? 0] ?? [])];
}

/**
 * The load driver, run as its own process with the sandbox environment (sidecarRequest reads it). It stands for the hook launchers of the
 * harness: in life every hook is a process of its own, whose reads of the sidecar's endpoint and key files and whose connect run
 * beside every other hook's, never behind them. One event loop that carried all 50 subagent streams would serialise those synchronous
 * reads (three file opens a request): a host that opens a file in 6 ms made that loop stand still for seconds, so the clients gave up
 * and the requests reached the sidecar with their time half spent, which is a driver that cannot keep up, not a sidecar that does not
 * answer. So the subagent streams run on STREAM_LOOPS worker threads of the driver, each with an event loop of its own (a handful of
 * streams each), and the lifecycle sessions run on the main thread. Every loop has its own stall ticker, and a hook is judged by the
 * stalls of the sidecar and of its own loop only.
 */
const DRIVER = `
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const argv = isMainThread ? process.argv.slice(2) : workerData.argv;
const [sidecarUrl, adapterUrl, askUrl, work, subagentsText, roundsText, sessionsText, timeoutText, gitLog, quietAttemptsText, loopsText] = argv;
const sidecar = await import(sidecarUrl);
const { sidecarRequest } = sidecar;
const { normalize } = await import(adapterUrl);
const { waitUntilQuiet } = await import(askUrl);
const SUBAGENTS = Number(subagentsText);
const ROUNDS = Number(roundsText);
const SESSIONS = Number(sessionsText);
const TIMEOUT_MS = Number(timeoutText);
const QUIET_ATTEMPTS = Number(quietAttemptsText);
const LOOPS = Number(loopsText);
/** The thread ids the git start log holds, one per git process started (the log is the test's, kept only when git starts are probed). */
const gitStarts = () => {
  try {
    return readFileSync(gitLog, 'utf8').split('\\n').filter((line) => line !== '');
  } catch {
    return [];
  }
};
// This loop's own ticker: stretches of 100 ms or more in which it ran no timer.
const loopId = isMainThread ? 0 : workerData.loop;
const stalls = [];
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  if (now - lastTick >= 100) stalls.push([lastTick, now]);
  lastTick = now;
}, 10);
// Ids that are unique across the loops, so no two loops send the same tool use or agent.
let serial = loopId * 1_000_000;
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
  if (!normalized.ok) return { kind: native.hook_event_name, code: 'NORMALIZE_' + normalized.reasonCode, loop: loopId };
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
  return { kind: native.hook_event_name, session: native.session_id, code, queued, began, ms: Date.now() - began, loop: loopId, outcome: outcome === null ? null : { kind: outcome.kind ?? null, reasonCode: outcome.reasonCode ?? null, text: typeof outcome.text === 'string' ? outcome.text.slice(0, 200) : null } };
}
/** The streams first to first + count - 1 of a session's subagents: SubagentStart, three tool calls (before and after), SubagentStop each. */
async function subagents(session, first, count) {
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
  await Promise.all(Array.from({ length: count }, (_, i) => one(first + i)));
  return out;
}
if (!isMainThread) {
  // A stream loop: runs the share of subagent streams it is told to, and reports its stalls when it is told to end.
  parentPort.on('message', async (message) => {
    if (message.type === 'burst') parentPort.postMessage({ type: 'burst', hooks: await subagents(message.session, message.first, message.count) });
    else if (message.type === 'end') {
      clearInterval(ticker);
      parentPort.postMessage({ type: 'end', stalls });
    }
  });
  parentPort.postMessage({ type: 'ready' });
} else {
  const workers = await Promise.all(Array.from({ length: LOOPS }, (_, k) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { argv, loop: k + 1 } });
    worker.once('error', reject);
    worker.once('message', () => {
      worker.off('error', reject);
      worker.on('error', (error) => {
        process.stderr.write('a stream loop failed: ' + String(error?.stack ?? error) + '\\n');
        process.exit(3);
      });
      resolve(worker);
    });
  })));
  const ask = (worker, message, field) => new Promise((resolve) => {
    worker.once('message', (answer) => resolve(answer[field]));
    worker.postMessage(message);
  });
  const perLoop = Math.ceil(SUBAGENTS / LOOPS);
  /** One burst of SUBAGENTS subagent streams in a session, shared out over the stream loops. */
  const burstOf = async (session) => (await Promise.all(workers.map((worker, k) => ask(worker, { type: 'burst', session, first: k * perLoop, count: Math.max(0, Math.min(perLoop, SUBAGENTS - k * perLoop)) }, 'hooks')))).flat();
  // Warm-up, outside the measured load: one quiet session compacts, restores and stops, and two subagents run, so the first git
  // process, the first store open and the first scans of each hook kind are behind the sidecar before 50 subagents start. What these
  // answer is not judged. The sidecar's own background work for them (a capsule write that outlived its deadline) ends first.
  const warm = [];
  for (const kind of ['precompact', 'restore', 'stop']) warm.push((await hook(nativeEvent(kind, { session: 'k3-warm' }))).code);
  warm.push(...(await subagents('k3-warm', 0, 2)).map((s) => s.code));
  // With git starts probed: more warm-up sessions until a git process has been started by a thread that is not the main one (the sidecar's
  // git worker is up: it starts once the sidecar is, and a git call before it says it is ready runs on the main thread, as it always did).
  // What the log holds up to then is not judged; every git start after it is.
  let readyAt = null;
  if (gitLog !== '') {
    for (let attempt = 0; attempt < 60 && readyAt === null; attempt += 1) {
      await waitUntilQuiet(sidecar, { workspace: work });
      if (gitStarts().some((id) => id !== '0')) readyAt = gitStarts().length;
      else warm.push((await hook(nativeEvent('precompact', { session: 'k3-ready-' + attempt }))).code);
    }
    if (readyAt === null) readyAt = gitStarts().length;
  }
  const quietBeforeLoad = await waitUntilQuiet(sidecar, { workspace: work });
  const lifecycle = [];
  const load = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const burst = burstOf('k3-burst-' + round);
    await Promise.all(Array.from({ length: SESSIONS }, async (_, i) => {
      const o = { session: 'k3-life-' + round + '-' + i };
      lifecycle.push(await hook(nativeEvent('precompact', o)));
      lifecycle.push(await hook(nativeEvent('restore', o)));
      lifecycle.push(await hook(nativeEvent('stop', o)));
    }));
    load.push(...(await burst));
  }
  // A quiet session after the load: the same three hooks with nothing else in flight. A round the host cut short (a capsule write that ran past
  // its deadline, its restore then waiting on it) is asked again in a session of its own once the sidecar's own state says it is quiet, as the
  // other tests ask again (docs/testing.md): a sidecar that never answers a quiet session in time still fails every attempt.
  let quiet = [];
  let quietAttempts = 0;
  for (let attempt = 0; attempt < QUIET_ATTEMPTS; attempt += 1) {
    quietAttempts += 1;
    await waitUntilQuiet(sidecar, { workspace: work });
    quiet = [];
    for (const kind of ['precompact', 'restore', 'stop']) quiet.push(await hook(nativeEvent(kind, { session: 'k3-quiet-' + attempt })));
    if (quiet.map((s) => s.kind + ':' + s.code).join() === 'PreCompact:OK,SessionStart:OK,Stop:OK') break;
  }
  clearInterval(ticker);
  const driverStalls = [stalls];
  for (const worker of workers) driverStalls.push(await ask(worker, { type: 'end' }, 'stalls'));
  await Promise.all(workers.map((worker) => worker.terminate()));
  process.stdout.write(JSON.stringify({ warm, quietBeforeLoad, lifecycle, quiet, quietAttempts, gitStarts: gitLog === '' ? null : { all: gitStarts(), readyAt }, load: load.map((s) => ({ code: s.code, began: s.began, loop: s.loop })), driverStalls }));
}
`;

/** Quiet sessions asked at most, the first included, before the quiet check of the run is judged. */
const QUIET_ATTEMPTS = 4;

function runDriver(box, gitLog = '') {
  const sidecarUrl = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href;
  const adapterUrl = pathToFileURL(join(repoRoot, 'packages', 'adapter-claude-code', 'dist', 'index.js')).href;
  const askUrl = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'scripts', 'sidecar-ask.mjs')).href;
  const driver = box.write('k3-driver.mjs', DRIVER);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, sidecarUrl, adapterUrl, askUrl, box.work, String(SUBAGENTS), String(ROUNDS), String(SESSIONS), String(CLIENT_TIMEOUT_MS), gitLog, String(QUIET_ATTEMPTS), String(STREAM_LOOPS)], { cwd: box.work, env: box.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
 * may end in (a subagent hook may be queued or refused BUSY); `held` names the sessions whose capsule write ran past its deadline
 * (`heldWriteSessions`), whose restore waits for that write (K2) and, if the write outlasts the restore's own deadline, is queued with
 * reason DEADLINE: a restore of such a session reads OK_QUEUED and counts as answered too. `stalls` is the list of stalls that may explain a give-up,
 * or a function that gives the list for one hook (`stallsFor`).
 */
function lostHooks(hooks, stalls, { extra = null, held = new Set() } = {}) {
  const lost = [];
  for (const hook of hooks) {
    const code = (hook.kind === 'PreCompact' || (hook.kind === 'SessionStart' && held.has(hook.session))) && hook.code === 'OK_QUEUED' ? 'OK' : hook.code;
    if (ANSWERED.test(code) || (extra !== null && extra.test(code))) continue;
    if (GAVE_UP.test(code) && stallExplains(typeof stalls === 'function' ? stalls(hook) : stalls, hook.began)) continue;
    lost.push(code);
  }
  return lost;
}

/**
 * The sessions whose own PreCompact did not answer in time (its capsule write ran past the deadline and is held for the session): what
 * their restore waits for (the session's earlier work finishes first, K2), so the restore is cut short by the same slowness.
 */
function heldWriteSessions(lifecycle) {
  return new Set(lifecycle.filter((s) => s.kind === 'PreCompact' && s.code !== 'OK' && s.code !== 'OK_DUP').map((s) => s.session));
}

/**
 * The K3 run: a sandbox, a real sidecar (with the ticker, and with every git start blocking its thread for `gitStartMs` when that is not 0), the
 * driver's warm-up and load, then the judgement. Returns what the driver saw, for a caller that asserts more.
 */
async function lifecycleLoad(t, { gitStartMs = 0 } = {}) {
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
  // Every git start blocks its thread, as creating a process does on a loaded Windows runner; the log says which thread started each.
  const gitLog = gitStartMs > 0 ? join(box.dir, 'git-starts.log') : '';
  if (gitStartMs > 0) {
    const startPreload = join(box.dir, 'git-start-stall.cjs');
    writeFileSync(startPreload, gitStartPreload(gitLog.replace(/\\/g, '/'), gitStartMs));
    box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS} --require "${startPreload.replace(/\\/g, '/')}"`;
  }
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  t.after(() => box.stopSidecar());

  const { warm, quietBeforeLoad, lifecycle, quiet, quietAttempts, gitStarts, load, driverStalls } = await runDriver(box, gitLog);
  const sidecarStalls = readStalls(existsSync(tickerLog) ? readFileSync(tickerLog, 'utf8') : '');
  const stallsOf = stallsFor(sidecarStalls, driverStalls);
  const driverStallsAll = driverStalls.flat();
  const answers = lifecycle.filter((s) => s.kind === 'SessionStart' || s.kind === 'Stop');
  assert.equal(answers.length, 2 * ROUNDS * SESSIONS, 'every restore and Stop was sent');
  assert.equal(load.length, ROUNDS * SUBAGENTS * 8, 'every subagent hook was sent');
  // The slowest answer of each lifecycle kind, in ms: what the load cost them.
  const slowest = lifecycle.reduce((acc, s) => ({ ...acc, [s.kind]: Math.max(acc[s.kind] ?? 0, s.ms) }), {});
  const longest = (list) => list.reduce((most, [from, to]) => Math.max(most, to - from), 0);
  const report = `lifecycle ${JSON.stringify(tally(lifecycle.map((s) => `${s.kind}:${s.code}`)))}; slowest ${JSON.stringify(slowest)} ms; subagent hooks ${JSON.stringify(tally(load.map((s) => s.code)))}; loop stalls of 100 ms or more, longest ${String(longest(sidecarStalls))} ms in the sidecar (${String(sidecarStalls.length)}) and ${String(longest(driverStallsAll))} ms in the driver (${String(driverStallsAll.length)}); warm-up ${JSON.stringify(tally(warm))}${quietBeforeLoad ? '' : ', the sidecar was still busy when the load began'}; quiet session answered in attempt ${String(quietAttempts)} of ${String(QUIET_ATTEMPTS)}`;
  t.diagnostic(report);

  // The locked target: under load, a restore or a Stop is never answered from the queue. The one restore that is: that of a session whose own
  // capsule write ran past its deadline (K2: it waits for that write, and a write that outlasts the restore's own deadline queues it with
  // reason DEADLINE), which a host slow enough for a PreCompact to miss its deadline cannot avoid.
  const held = heldWriteSessions(lifecycle);
  assert.deepEqual(answers.filter((s) => s.code === 'OK_QUEUED' && !(s.kind === 'SessionStart' && held.has(s.session))).map((s) => `${s.kind} queued ${s.queued.join(',')}`), [], report);
  // The answer lane (B 63a0a31) keeps hot slots for them: a lifecycle hook is never refused BUSY
  // at admission, however full the pool is with subagent hooks.
  assert.deepEqual(lifecycle.filter((s) => s.code === 'BUSY').map((s) => s.kind), [], report);
  // Every answer is in time or ran out of time (DEADLINE), never lost silently. A client that left before any answer came is
  // accepted only where a loop of the sidecar (or of the driver) stood still across the moment the answer was due.
  assert.deepEqual(lostHooks(lifecycle, stallsOf, { held }), [], report);
  assert.deepEqual(lostHooks(load, stallsOf, { extra: /^(OK_QUEUED|BUSY)$/ }), [], report);
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
  return { report, gitStarts };
}

test('K3: compact restores and Stop reminders are never queued while 50 subagents run (owner decision ededdba)', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  await lifecycleLoad(t);
});

// The cause of the windows-latest failures, injected: every git process takes 400 ms to start, and the thread that starts it waits for that, as
// the thread that calls CreateProcess does. Four sessions that compact together then cost a loop that makes the starts four times 400 ms, and
// the old sidecar (git started on its event loop) lost every hook in flight (CI run 37329307976). The git worker thread takes the start, so
// the lifecycle target holds, and once it is up no git process starts on the main thread.
test('K3: the target holds while every git process takes 400 ms to start, because the sidecar starts git off its event loop', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  const { report, gitStarts } = await lifecycleLoad(t, { gitStartMs: 400 });
  const after = gitStarts.all.slice(gitStarts.readyAt);
  assert.ok(gitStarts.all.some((id) => id !== '0'), `the sidecar's git worker never started a git process: ${JSON.stringify(gitStarts.all)}; ${report}`);
  assert.ok(after.length >= 3 * (ROUNDS * SESSIONS), `git was started ${String(after.length)} times after the worker was up; ${report}`);
  assert.deepEqual(after.filter((id) => id === '0'), [], `a git process was started on the sidecar's main thread after the worker was up; ${report}`);
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
  // A stall of one loop of the driver (loop 0 carries the lifecycle sessions, the others the subagent streams) explains the clients of that
  // loop only, because the loops stand still one at a time; a stall of the sidecar explains every client.
  const stall = [began + 100, leftAt + 400];
  const sent = [{ kind: 'PreToolUse', code: 'TIMEOUT', began, loop: 1 }, { kind: 'PreToolUse', code: 'TIMEOUT', began, loop: 2 }, { kind: 'Stop', code: 'TIMEOUT', began }];
  assert.deepEqual(lostHooks(sent, stallsFor([], [[], [stall], []])), ['TIMEOUT', 'TIMEOUT'], 'only the clients of the stalled loop are explained');
  assert.deepEqual(lostHooks(sent, stallsFor([], [[stall], [], []])), ['TIMEOUT', 'TIMEOUT'], 'a lifecycle hook is the main loop\'s and a stream\'s is not');
  assert.deepEqual(lostHooks(sent, stallsFor([stall], [[], [], []])), [], 'a stall of the sidecar explains every client');
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
  // A restore waits for its own session's capsule write (K2): where that write ran past its deadline, the restore is queued with reason
  // DEADLINE, and only that session's restore may be. A Stop never may, whatever its session did.
  const compacts = [
    { kind: 'PreCompact', session: 'late', code: 'OK_QUEUED', began },
    { kind: 'PreCompact', session: 'gave-up', code: 'TIMEOUT', began },
    { kind: 'PreCompact', session: 'prompt', code: 'OK', began },
  ];
  assert.deepEqual([...heldWriteSessions(compacts)].sort(), ['gave-up', 'late'], 'a PreCompact that did not answer in time holds its session\'s write');
  const restores = [
    { kind: 'SessionStart', session: 'late', code: 'OK_QUEUED', began },
    { kind: 'SessionStart', session: 'prompt', code: 'OK_QUEUED', began },
    { kind: 'Stop', session: 'late', code: 'OK_QUEUED', began },
  ];
  assert.deepEqual(lostHooks(restores, [], { held: heldWriteSessions(compacts) }), ['OK_QUEUED', 'OK_QUEUED'], 'a restore after a prompt PreCompact, and a Stop, are never queued');
});
