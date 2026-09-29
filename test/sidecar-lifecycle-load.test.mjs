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
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedHostSkip } from './managed-host.mjs';
import { repoRoot, sandbox } from './acceptance/lib.mjs';
import { certifyHooks } from './acceptance/certified-hooks.mjs';

const SUBAGENTS = 50;
const ROUNDS = 2;
const SESSIONS = 4;

/** The load driver, run as its own process with the sandbox environment (sidecarRequest reads it). */
const DRIVER = `
import { join } from 'node:path';
const [sidecarUrl, adapterUrl, work, subagentsText, roundsText, sessionsText] = process.argv.slice(2);
const { sidecarRequest } = await import(sidecarUrl);
const { normalize } = await import(adapterUrl);
const SUBAGENTS = Number(subagentsText);
const ROUNDS = Number(roundsText);
const SESSIONS = Number(sessionsText);
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
    timeoutMs: 1500,
    eventAtMs: Date.now(),
    budget: 'hot',
  });
  const queued = answer.ok && Array.isArray(answer.result?.queued) ? answer.result.queued : [];
  const code = answer.ok ? (queued.length > 0 ? 'OK_QUEUED' : answer.result?.duplicate ? 'OK_DUP' : 'OK') : (answer.reasonCode ?? 'SIDECAR_' + String(answer.reason).toUpperCase());
  const outcome = answer.ok ? answer.result?.results?.orchestrator?.hookOutcome ?? null : null;
  return { kind: native.hook_event_name, session: native.session_id, code, queued, ms: Date.now() - began, outcome: outcome === null ? null : { kind: outcome.kind ?? null, reasonCode: outcome.reasonCode ?? null, text: typeof outcome.text === 'string' ? outcome.text.slice(0, 200) : null } };
}
async function subagents(session) {
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
  await Promise.all(Array.from({ length: SUBAGENTS }, (_, i) => one(i)));
  return out;
}
const lifecycle = [];
const load = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const burst = subagents('k3-burst-' + round);
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
process.stdout.write(JSON.stringify({ lifecycle, quiet, load: load.map((s) => s.code) }));
`;

function runDriver(box) {
  const sidecarUrl = pathToFileURL(join(repoRoot, 'apps', 'sidecar', 'dist', 'index.js')).href;
  const adapterUrl = pathToFileURL(join(repoRoot, 'packages', 'adapter-claude-code', 'dist', 'index.js')).href;
  const driver = box.write('k3-driver.mjs', DRIVER);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, sidecarUrl, adapterUrl, box.work, String(SUBAGENTS), String(ROUNDS), String(SESSIONS)], { cwd: box.work, env: box.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

test('K3: compact restores and Stop reminders are never queued while 50 subagents run (owner decision ededdba)', { timeout: 300_000, skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: [{ id: 'unit', argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', requirementIds: ['R-1'], description: 'unit' }],
  });
  box.gitInit();
  const approved = await box.approveChecks();
  assert.equal(approved.code, 0, approved.reason);
  await certifyHooks(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  t.after(() => box.stopSidecar());

  const { lifecycle, quiet, load } = await runDriver(box);
  const answers = lifecycle.filter((s) => s.kind === 'SessionStart' || s.kind === 'Stop');
  assert.equal(answers.length, 2 * ROUNDS * SESSIONS, 'every restore and Stop was sent');
  assert.equal(load.length, ROUNDS * SUBAGENTS * 8, 'every subagent hook was sent');
  // The slowest answer of each lifecycle kind, in ms: what the load cost them.
  const slowest = lifecycle.reduce((acc, s) => ({ ...acc, [s.kind]: Math.max(acc[s.kind] ?? 0, s.ms) }), {});
  const report = `lifecycle ${JSON.stringify(tally(lifecycle.map((s) => `${s.kind}:${s.code}`)))}; slowest ${JSON.stringify(slowest)} ms; subagent hooks ${JSON.stringify(tally(load))}`;
  t.diagnostic(report);

  // The locked target: under load, a restore or a Stop is never answered from the queue.
  assert.deepEqual(answers.filter((s) => s.code === 'OK_QUEUED').map((s) => `${s.kind} queued ${s.queued.join(',')}`), [], report);
  // The answer lane (B 63a0a31) keeps hot slots for them: a lifecycle hook is never refused BUSY
  // at admission, however full the pool is with subagent hooks.
  assert.deepEqual(lifecycle.filter((s) => s.code === 'BUSY').map((s) => s.kind), [], report);
  // Every answer is in time or ran out of time (DEADLINE), never lost silently.
  assert.deepEqual(lifecycle.map((s) => (s.kind === 'PreCompact' && s.code === 'OK_QUEUED' ? 'OK' : s.code)).filter((code) => !/^(OK|OK_DUP|DEADLINE)$/.test(code)), [], report);
  assert.deepEqual(load.filter((code) => !/^(OK|OK_QUEUED|OK_DUP|DEADLINE|BUSY)$/.test(code)), [], report);
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
