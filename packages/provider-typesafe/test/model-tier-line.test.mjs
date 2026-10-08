// Tiered routing, step 3 (owner decisions 2026-10-08): the main-session model line, on every harness, on that harness's own provider's
// models. A hook cannot change a main session's model, so the session gets one short, honest line addressed to the model (a context)
// where the harness has one, and to the person otherwise: "this looks hard (PROTECTED_AUTH): consider Opus 5.5 (/model opus)", or
// "Sonnet 5.5 has failed this 3 times (not environmental): consider Opus 5.5", or, on routine work in a session on a dearer model than
// its harness baseline, "Sonnet 5.5 would be enough". Rules only: no Jev call on the prompt path, no prompt text anywhere.
// Temporary homes, stub certifications, a stub engine that fails any request; no live call, no real harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = await import('../dist/index.js');
const core = await import('@jevris/core');
const { HookOutcomeContract } = await import('@jevris/contracts');
const claude = await import('@jevris/adapter-claude-code');
const codex = await import('@jevris/adapter-codex');
const kilo = await import('@jevris/adapter-kilocode');
const opencode = await import('@jevris/adapter-opencode');
const antigravity = await import('@jevris/adapter-antigravity');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60_000;
const PROMPT = 'PROMPT-TEXT-REWRITE-THE-BILLING-MODULE-5d1c';
const TITLE = 'TITLE-TEXT-PAYMENTS-9e2a';
const FAILURE_TEXT = 'FAILURE-TEXT-ENOENT-7b3f';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const WS = 'w-line';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-tierline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  core.clearSessionTierMemos();
  t.after(() => core.clearSessionTierMemos());
  return dir;
}

let n = 0;
const NATIVE = { claude: 'UserPromptSubmit', codex: 'UserPromptSubmit', kilocode: 'chat.message', opencode: 'chat.message', antigravity: 'PreInvocation' };
function event(kind, { harness = 'claude', model = null, sessionId = 'sess-line', nativeEventName, toolName = null, payload = {} } = {}) {
  n += 1;
  return {
    schemaVersion: '1.0', harness, nativeEventName: nativeEventName ?? NATIVE[harness], kind, sessionId, turnId: null, toolUseId: `tu-${n}`, toolName,
    agentId: null, model, permissionMode: null, cwd: null, trigger: null, blocking: false, responseRequired: false, payload, dedupKey: sha(`tierline-${n}`),
  };
}
const prompt = (opts = {}) => event('task.requested', { ...opts, payload: { prompt: PROMPT } });

function ctx(dir, envelope, { mode = 'bounded-auto', traces = [], engine, extra = {}, adherence, killSwitchStopped = false, showsExplain } = {}) {
  // A new revision per event: the trigger filter coalesces events of one session at one revision.
  const body = { envelope, deliveryKey: `k-${envelope.dedupKey.slice(0, 8)}`, revision: `rev-${n}`, harnessVersion: '2.1.0', task: { objective: PROMPT }, ...(showsExplain === undefined ? {} : { showsExplain }), ...extra };
  return {
    op: 'event', client: 'hook', scopes: ['observe'], workspace: { id: WS, root: dir }, body, home: dir, signal: new AbortController().signal,
    deadline: { budgetMs: 900, remainingMs: () => 2000, expired: () => false }, store: null, killSwitchStopped, engine, trace: (e) => traces.push(e), mode, jevAssist: 'classify',
    ...(adherence === undefined ? {} : { adviceAdherence: adherence }),
  };
}

function record(features, harness) {
  return {
    id: `cert-${harness}-1`, schemaVersion: '1.0', harness, actuatorId: `${harness}-hooks`, harnessVersionRange: { minimum: '0.0.1', maximumExclusive: '99.0.0' },
    operatingSystems: ['darwin', 'linux', 'win32'], models: [], tools: [], limitations: [], fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: 'FIXTURES_PASSED' })),
    certifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', signature: 'sig',
  };
}
const certifiedFor = (harness, features = ['hooks.route', 'hooks.context']) => provider.recordsCertificationSource(async () => [record(features, harness)]);

/** An engine stand-in: any request to Jev is counted (and refused); the advisory record is captured. */
function stubEngine({ recordOk = true } = {}) {
  const calls = [];
  const records = [];
  const count = (name) => () => (calls.push(name), Promise.reject(new Error('no call expected')));
  const engine = {
    providerConfigured: true, now: () => NOW, decide: count('decide'), askBounded: count('askBounded'), lookup: count('lookup'),
    recordAdvice: async (input) => (records.push(input), recordOk ? { ok: true, decisionId: `d-rec-${records.length}` } : { ok: false, reasonCode: 'JOURNAL_UNAVAILABLE' }),
  };
  return { engine, calls, records };
}

/** The line system under test: a handler with its own memory, a subscriber on the same pending store, a clock tests move. */
function lineSystem({ certs, os = 'linux' } = {}) {
  const store = new provider.PendingAdviceStore({ now: () => clock.now });
  const clock = { now: NOW };
  const quiet = new Map();
  const handler = provider.createModelTierHandler({ store, quiet, now: () => clock.now });
  const subscriber = (certifications) => provider.createDecisionSubscriber({ handlers: { 'new-task': [handler], 'repeated-failure': [handler] }, certifications, now: () => NOW, operatingSystem: os, pending: store });
  return { store, quiet, handler, clock, subscriber: subscriber(certs), subscriberFor: subscriber };
}

const HARD = () => core.tierSignalsOf({ hints: { title: TITLE, paths: ['src/billing/a.ts'], checkIds: ['t1'] }, riskReasons: ['PROTECTED_AUTH'] });
const ROUTINE = () => core.tierSignalsOf({ hints: { title: 'review the notes', paths: ['docs/notes.md'], checkIds: [] } });
const SONNET = 'claude-sonnet-5-5';
const memo = (over = {}) => ({ tier: 'step-up', targetModelId: 'claude-opus-5-5', baselineModelId: SONNET, basis: 'tier-rule', reasonCodes: ['TIER_MIGRATION'], atMs: NOW, ...over });

async function nameOf(dir, modelId) {
  const registry = await core.loadModelRegistry({ home: dir });
  return core.registryModel(registry, modelId).displayName;
}

const MODEL_NOTE = ' If you are the model, tell the user this once and do not repeat it.';

// ----------------------------------------------------------------------------------------------------------- the lines

test('modelTierLine: fixed templates over names, a command and codes: hard, repeated failure, routine; at most 500 characters; nothing of a prompt, title or path can appear', () => {
  const base = { direction: 'up', harness: 'claude', reasons: ['TIER_PROTECTED_PATH'], protectedClasses: ['PROTECTED_AUTH'], attempts: null, baselineName: 'Sonnet 5.5', targetName: 'Opus 5.5', switchCommand: '/model opus', subagentAlias: 'opus' };
  assert.equal(provider.modelTierLine(base).person, 'Jevris: this looks hard (PROTECTED_AUTH): consider switching to Opus 5.5 (/model opus), or give the hard part to a subagent with model: opus. Advice only; nothing was changed.');
  assert.equal(provider.modelTierLine(base).model, `Jevris: this looks hard (PROTECTED_AUTH): consider switching to Opus 5.5 (/model opus), or give the hard part to a subagent with model: opus. Advice only; nothing was changed.${MODEL_NOTE}`);
  assert.equal(provider.modelTierLine({ ...base, reasons: ['TIER_MIGRATION'], switchCommand: null, subagentAlias: null }).person, 'Jevris: this looks hard (a migration): consider switching to Opus 5.5. Advice only; nothing was changed.');
  // A lockfile is never the reason named.
  assert.match(provider.modelTierLine({ ...base, protectedClasses: ['PROTECTED_LOCKFILE', 'PROTECTED_CI'] }).person, /\(PROTECTED_CI\)/);
  assert.equal(provider.modelTierLine({ ...base, reasons: ['TIER_REPEATED_FAILURE'], attempts: 3, subagentAlias: null }).person, 'Jevris: Sonnet 5.5 has failed this 3 times (not environmental): consider switching to Opus 5.5 (/model opus). Advice only; nothing was changed.');
  assert.equal(provider.modelTierLine({ ...base, direction: 'down', reasons: ['TIER_READ_ONLY_WORK'], baselineName: 'Opus 5.5', targetName: 'Sonnet 5.5', switchCommand: '/model sonnet', subagentAlias: null }).person, 'Jevris: this looks routine (read-only work): Sonnet 5.5 would be enough (/model sonnet). Advice only; nothing was changed.');
  for (const input of [base, { ...base, reasons: ['TIER_REPEATED_FAILURE'], attempts: 12 }, { ...base, direction: 'down', reasons: ['TIER_LOW_RISK_BOUNDED'] }]) {
    const { person, model } = provider.modelTierLine(input);
    assert.ok(person.length <= 500 && model.length <= 500, 'inside the pending-advice cap');
    assert.doesNotMatch(model, /changed everything|has switched|switched your/i, 'never claims Jevris changed anything');
  }
});

test('switchCommandFor: Claude Code /model <alias> only where the alias means the model, else its id; Codex /model; Kilo, OpenCode and Antigravity name no command', async (t) => {
  const registry = await core.loadModelRegistry({ home: home(t) });
  assert.equal(provider.switchCommandFor('claude', registry, 'claude-opus-5-5', NOW), '/model opus');
  assert.equal(provider.switchCommandFor('claude', registry, 'claude-haiku-5-5', NOW), '/model haiku');
  assert.equal(provider.switchCommandFor('claude', registry, 'claude-sonnet-5', NOW), '/model claude-sonnet-5', 'an older Sonnet is not what the alias means: its id');
  assert.equal(provider.switchCommandFor('codex', registry, 'gpt-6-astra', NOW), '/model');
  for (const harness of ['kilocode', 'opencode', 'antigravity']) assert.equal(provider.switchCommandFor(harness, registry, 'gpt-6-astra', NOW), null, harness);
  assert.equal(provider.claudeAlias(registry, 'gpt-6-astra', NOW), null);
});

// ----------------------------------------------------------------------------------------------------------- Claude Code

for (const os of ['darwin', 'linux', 'win32']) {
  test(`Claude Code (${os}): a hard linked task gets the line as additionalContext at the prompt; no Jev call, no prompt text; rendered by the adapter; recorded and explained`, async (t) => {
    const dir = home(t);
    const { engine, calls, records } = stubEngine();
    const sys = lineSystem({ certs: certifiedFor('claude'), os });
    const traces = [];
    const opus = await nameOf(dir, 'claude-opus-5-5');
    const result = await sys.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
    const text = `Jevris: this looks hard (PROTECTED_AUTH): consider switching to ${opus} (/model opus), or give the hard part to a subagent with model: opus. Advice only; nothing was changed.${MODEL_NOTE}`;
    assert.deepEqual(result.hookOutcome, { kind: 'context', text });
    assert.equal(HookOutcomeContract.validate(result.hookOutcome).ok, true);
    assert.equal(result.certified, true);
    assert.equal(result.reasonCode, 'TIER_LINE_UP');
    assert.deepEqual(result.decisionIds, ['d-rec-1']);
    // The Claude Code adapter renders it as the prompt's additionalContext.
    const native = { session_id: 'sess-line', transcript_path: '/t', cwd: '/w', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: PROMPT, prompt_id: 'p1' };
    const rendered = JSON.parse(claude.protocolResponse(prompt({ model: SONNET }), result.hookOutcome, native));
    assert.deepEqual(rendered, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
    // No Jev call; one advisory decision under the model-tier spec that `jevris explain` reads; no text of the prompt or the task anywhere.
    assert.deepEqual(calls, []);
    assert.equal(records.length, 1);
    assert.equal(records[0].specId, 'model-tier');
    assert.ok(records[0].reasonCodes.includes('TIER_MAIN_LINE_QUEUED') && records[0].reasonCodes.includes('TIER_MAIN_DIRECTION_UP') && records[0].reasonCodes.includes('TIER_SOURCE_RULE'));
    const lines = core.modelTierLines({ specId: records[0].specId, reasonCodes: records[0].reasonCodes, proposedAction: records[0].action });
    assert.match(lines[0], /^Model tier: step up, claude-opus-5-5 against the baseline claude-sonnet-5-5\. Rules-based default - not a learned route, not a signed prior\./);
    assert.doesNotMatch(JSON.stringify([result, records, lines, traces]), /PROMPT-TEXT|TITLE-TEXT/);
    // Delivered: nothing waits, and the same line is not repeated.
    assert.equal(sys.store.count(WS, 'sess-line'), 0);
  });
}

test('an uncertified hooks.context shows the person the same line without the note for the model (an explain); observe records and shows nothing; off does nothing; advise and bounded-auto show', async (t) => {
  const dir = home(t);
  const run = async (mode, certs = certifiedFor('claude')) => {
    const { engine, records } = stubEngine();
    const sys = lineSystem({ certs });
    const result = await sys.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, mode, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
    return { result, records, sys };
  };
  // hooks.route certified (the alias proof for the ladder), hooks.context not: the person reads it.
  const person = await run('bounded-auto', certifiedFor('claude', ['hooks.route']));
  assert.equal(person.result.hookOutcome.kind, 'explain');
  assert.match(person.result.hookOutcome.text, /^Jevris: this looks hard \(PROTECTED_AUTH\): consider switching to .+ \(\/model opus\)/);
  assert.doesNotMatch(person.result.hookOutcome.text, /If you are the model/);
  for (const mode of ['advise', 'bounded-auto']) assert.equal((await run(mode)).result.hookOutcome.kind, 'context', mode);
  const observe = await run('observe');
  assert.equal(observe.result.hookOutcome.kind, 'observe', 'observe shows nothing');
  assert.equal(observe.sys.store.count(WS, 'sess-line'), 0, 'and queues nothing');
  assert.equal(observe.records.length, 1, 'but the decision is recorded');
  assert.ok(observe.records[0].reasonCodes.includes('TIER_MAIN_LINE_OBSERVED'));
  const off = await run('off');
  assert.equal(off.result.hookOutcome.kind, 'observe');
  assert.equal(off.records.length, 0, 'off records nothing');
});

test('one line per session and direction in 30 minutes, counted from delivery; the other direction and another session are not held back; observe records once per period', async (t) => {
  const dir = home(t);
  const { engine, records } = stubEngine();
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const send = (signals, { session = 'sess-line', model = SONNET } = {}) => sys.subscriber.handle(ctx(dir, prompt({ model, sessionId: session }), { engine, extra: { tierSignals: signals, sessionModel: model } }));
  assert.equal((await send(HARD())).hookOutcome.kind, 'context');
  const traces = [];
  const quietly = await sys.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(quietly.hookOutcome.kind, 'observe');
  assert.ok(traces.some((e) => e.reasonCode === 'TIER_LINE_QUIET'));
  sys.clock.now = NOW + 29 * MIN;
  assert.equal((await send(HARD())).hookOutcome.kind, 'observe', 'still quiet at 29 minutes');
  assert.equal((await send(HARD(), { session: 'sess-other' })).hookOutcome.kind, 'context', 'another session has its own quiet period');
  sys.clock.now = NOW + 31 * MIN;
  assert.equal((await send(HARD())).hookOutcome.kind, 'context', 'after 30 minutes it may be said again');
  assert.equal(records.length, 3);
  // A line waiting for an event that can show it is not queued twice.
  const waiting = lineSystem({ certs: certifiedFor('claude') });
  const first = await waiting.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, showsExplain: false, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(first.hookOutcome.kind, 'observe', 'the harness shows nothing on this event: the line waits');
  assert.equal(waiting.store.count(WS, 'sess-line'), 1);
  const second = await waiting.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, showsExplain: false, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(second.hookOutcome.kind, 'observe');
  assert.equal(waiting.store.count(WS, 'sess-line'), 1, 'still one');
  // Observe: one record per period, not one per prompt.
  const watched = stubEngine();
  const obs = lineSystem({ certs: certifiedFor('claude') });
  for (let i = 0; i < 3; i += 1) await obs.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine: watched.engine, mode: 'observe', extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(watched.records.length, 1);
});

test('silence when the session is already on the right tier or a gate applies: a pin, the kill switch, no session id, no signals, no rung above, nothing to say', async (t) => {
  const dir = home(t);
  const { engine, records } = stubEngine();
  const traces = [];
  const run = async (over = {}, ctxOptions = {}) => {
    const sys = lineSystem({ certs: certifiedFor('claude') });
    traces.length = 0;
    const model = over.model ?? SONNET;
    const r = await sys.subscriber.handle(ctx(dir, prompt({ model, ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }) }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: model, ...(over.extra ?? {}) }, ...ctxOptions }));
    return { r, reason: traces.at(-1)?.reasonCode };
  };
  assert.equal((await run()).r.hookOutcome.kind, 'context', 'the baseline case speaks');
  const pinned = await run({ extra: { pins: { modelPin: 'claude-sonnet-5-5', effortPin: null } } });
  assert.deepEqual([pinned.r.hookOutcome.kind, pinned.reason], ['observe', 'TIER_LINE_PINNED']);
  const killed = await run({}, { killSwitchStopped: true });
  assert.equal(killed.r.hookOutcome.kind, 'observe', 'the kill switch stops the subscriber before any handler');
  // The session already runs the top rung: no step up exists to name (Opus 5.5; Fable 5.1 is never a rung).
  const top = await run({ model: 'claude-opus-5-5' });
  assert.deepEqual([top.r.hookOutcome.kind, top.reason], ['observe', 'TIER_LINE_NO_STEP_UP_RUNG']);
  // A lockfile alone is not a step up; a task nothing is known about says nothing.
  const lock = await run({ extra: { tierSignals: core.tierSignalsOf({ hints: { title: TITLE, paths: ['package-lock.json'], checkIds: ['t'] } }) } });
  assert.deepEqual([lock.r.hookOutcome.kind, lock.reason], ['observe', 'TIER_LINE_NOTHING_TO_SAY']);
  const none = await run({ extra: { tierSignals: undefined } });
  assert.deepEqual([none.r.hookOutcome.kind, none.reason], ['observe', 'TIER_LINE_NOTHING_TO_SAY']);
  // A body the sidecar did not make (not exactly the shape) says nothing.
  const forged = await run({ extra: { tierSignals: { ...HARD(), files: -4, risk: 'catastrophic' } } });
  assert.equal(forged.r.hookOutcome.kind, 'observe');
  // Claude Code: without hooks.route certified there is no ladder (the alias proof), so nothing to point at.
  const uncertified = lineSystem({ certs: certifiedFor('claude', ['hooks.context']) });
  const quiet = await uncertified.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(quiet.hookOutcome.kind, 'observe');
  assert.equal(traces.at(-1).reasonCode, 'TIER_LINE_NO_LADDER');
  assert.equal(records.length, 1, 'only the line that spoke was recorded');
});

test('the session tier memo of `jevris route` is used when the task is not linked: a step up names its target, a memo for another baseline is not, a step down needs the rules\' own routine signal', async (t) => {
  const dir = home(t);
  const { engine } = stubEngine();
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const send = (opts = {}) => sys.subscriber.handle(ctx(dir, prompt({ model: opts.model ?? SONNET }), { engine, extra: { sessionModel: opts.model ?? SONNET, ...(opts.extra ?? {}) } }));
  // No signals and no memo: silence.
  assert.equal((await send()).hookOutcome.kind, 'observe');
  assert.equal(core.noteSessionTier(WS, 'sess-line', memo({ atMs: NOW })), true);
  const up = await send();
  assert.equal(up.hookOutcome.kind, 'context');
  assert.match(up.hookOutcome.text, /^Jevris: this looks hard \(a migration\): consider switching to /);
  // A memo judged against another baseline than the session now runs is not the session's tier.
  const other = lineSystem({ certs: certifiedFor('claude') });
  core.noteSessionTier(WS, 'sess-line', memo({ baselineModelId: 'claude-haiku-5-5' }));
  const haiku = await other.subscriber.handle(ctx(dir, prompt({ model: 'claude-haiku-5-5' }), { engine, extra: { sessionModel: 'claude-haiku-5-5' } }));
  assert.match(haiku.hookOutcome.text ?? '', /Opus|opus/, 'a Haiku session\'s own memo still names a step up');
  // A memo's step down alone does not make a line: only the rules' read-only or low-risk-bounded signal does.
  const down = lineSystem({ certs: certifiedFor('claude') });
  core.noteSessionTier(WS, 'sess-line', memo({ tier: 'step-down', targetModelId: 'claude-haiku-5-5', basis: 'tier-jev', reasonCodes: ['TIER_JEV_ACCEPTED'] }));
  assert.equal((await down.subscriber.handle(ctx(dir, prompt({ model: 'claude-opus-5-5' }), { engine, extra: { sessionModel: 'claude-opus-5-5' } }))).hookOutcome.kind, 'observe');
});

test('"this looks routine": only on a session on a dearer model than its harness baseline, only from the rules\' read-only or low-risk-bounded signal, and the line names the harness baseline', async (t) => {
  const dir = home(t);
  const { engine } = stubEngine();
  const sonnetName = await nameOf(dir, SONNET);
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const opusSession = await sys.subscriber.handle(ctx(dir, prompt({ model: 'claude-opus-5-5' }), { engine, extra: { tierSignals: ROUTINE(), sessionModel: 'claude-opus-5-5' } }));
  assert.deepEqual(opusSession.hookOutcome, { kind: 'context', text: `Jevris: this looks routine (read-only work): ${sonnetName} would be enough (/model sonnet). Advice only; nothing was changed.${MODEL_NOTE}` });
  assert.equal(opusSession.reasonCode, 'TIER_LINE_DOWN');
  // A Sonnet session is on its harness's baseline: silence means it is on the right tier.
  const sonnetSession = lineSystem({ certs: certifiedFor('claude') });
  const traces = [];
  assert.equal((await sonnetSession.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, traces, extra: { tierSignals: ROUTINE(), sessionModel: SONNET } }))).hookOutcome.kind, 'observe');
  assert.equal(traces.at(-1).reasonCode, 'TIER_LINE_ALREADY_ON_TIER');
  // Work that is not clearly routine (a source file) says nothing, even on Opus.
  const code = lineSystem({ certs: certifiedFor('claude') });
  assert.equal((await code.subscriber.handle(ctx(dir, prompt({ model: 'claude-opus-5-5' }), { engine, extra: { tierSignals: core.tierSignalsOf({ hints: { title: TITLE, paths: ['src/a.ts'], checkIds: [] } }), sessionModel: 'claude-opus-5-5' } }))).hookOutcome.kind, 'observe');
  // Down never rides a failure event.
  const failing = lineSystem({ certs: certifiedFor('claude') });
  const failure = (nth) => ctx(dir, event('tool.failed', { toolName: 'Bash', model: 'claude-opus-5-5' }), { engine, extra: { tierSignals: ROUTINE(), sessionModel: 'claude-opus-5-5', repair: { maxAttempts: 9 }, failure: FAIL() } });
  await failing.subscriber.handle(failure(1));
  assert.equal((await failing.subscriber.handle(failure(2))).hookOutcome.kind, 'observe');
});

// ----------------------------------------------------------------------------------------------------- repeated failure

const FAIL = (over = {}) => ({ toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [], ...over });

test('a repeated failure that is not environmental, at the repair limit, gets "Sonnet 5.5 has failed this N times"; an environmental one, or one under the limit, gets nothing; no failure text anywhere', async (t) => {
  const dir = home(t);
  const { engine, calls, records } = stubEngine();
  const opus = await nameOf(dir, 'claude-opus-5-5');
  const sonnet = await nameOf(dir, SONNET);
  const failed = (extra = {}) => ctx(dir, event('tool.failed', { toolName: 'Bash', payload: { error: FAILURE_TEXT } }), { engine, extra: { sessionModel: SONNET, repair: { maxAttempts: 2 }, failure: FAIL(), ...extra } });
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const first = await sys.subscriber.handle(failed());
  assert.equal(first.hookOutcome.kind, 'observe', 'the first failure is not a repeat');
  const second = await sys.subscriber.handle(failed());
  assert.deepEqual(second.hookOutcome, { kind: 'context', text: `Jevris: ${sonnet} has failed this 2 times (not environmental): consider switching to ${opus} (/model opus), or give the hard part to a subagent with model: opus. Advice only; nothing was changed.${MODEL_NOTE}` });
  assert.equal(second.reasonCode, 'TIER_LINE_UP');
  assert.doesNotMatch(JSON.stringify([second, records]), /FAILURE-TEXT/);
  assert.deepEqual(calls, []);
  const codes = records.at(-1).reasonCodes;
  assert.ok(codes.includes('TIER_REPEATED_FAILURE') && codes.includes('TIER_MAIN_SOURCE_FAILURE'));
  // Environmental: the environment is the problem, not the model.
  const env = lineSystem({ certs: certifiedFor('claude') });
  await env.subscriber.handle(failed({ failure: FAIL({ environmental: true }) }));
  assert.equal((await env.subscriber.handle(failed({ failure: FAIL({ environmental: true }) }))).hookOutcome.kind, 'observe');
  // Under the repair limit: not yet.
  const under = lineSystem({ certs: certifiedFor('claude') });
  await under.subscriber.handle(failed({ repair: { maxAttempts: 5 } }));
  assert.equal((await under.subscriber.handle(failed({ repair: { maxAttempts: 5 } }))).hookOutcome.kind, 'observe');
});

// ----------------------------------------------------------------------------------------------------------- adherence

test('delivered advice is opened for adherence (main-route, the tier-up slice) and, after two times it was not followed, the line stops for the session; a session that followed gets it again', async (t) => {
  const dir = home(t);
  const { engine } = stubEngine();
  const opened = [];
  let overrides = 0;
  const asked = [];
  const adherence = { open: (advice) => (opened.push(advice), true), overrides: (query) => (asked.push(query), overrides) };
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const send = (session = 'sess-line') => sys.subscriber.handle(ctx(dir, prompt({ model: SONNET, sessionId: session }), { engine, adherence, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal((await send()).hookOutcome.kind, 'context');
  assert.equal(opened.length, 1);
  assert.deepEqual({ ...opened[0], decisionId: 'x' }, { decisionId: 'x', sessionId: 'sess-line', adviceKind: 'main-route', slice: 'tier-up', advisedModel: 'claude-opus-5-5', currentModel: SONNET, atMs: NOW });
  assert.equal(opened[0].decisionId, 'd-rec-1', 'the advisory decision explain shows its adherence under');
  assert.deepEqual(asked.at(-1), { sessionId: 'sess-line', adviceKind: 'main-route', slice: 'tier-up', advisedModel: 'claude-opus-5-5' });
  // Not followed once: still said (after the quiet period). Twice: the line stops for this session.
  overrides = 1;
  sys.clock.now = NOW + 31 * MIN;
  assert.equal((await send()).hookOutcome.kind, 'context');
  overrides = 2;
  sys.clock.now = NOW + 62 * MIN;
  const traces = [];
  const stopped = await sys.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, adherence, traces, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(stopped.hookOutcome.kind, 'observe');
  assert.ok(traces.some((e) => e.reasonCode === 'TIER_LINE_IGNORED'));
  overrides = 0;
  sys.clock.now = NOW + 100 * MIN;
  assert.equal((await send('sess-fresh')).hookOutcome.kind, 'context', 'another session starts at 0');
});

test('a line with no decision record (the journal is slow or refuses) is still shown and opened for adherence under an id derived from the session and the time', async (t) => {
  const dir = home(t);
  const { engine } = stubEngine({ recordOk: false });
  const opened = [];
  const sys = lineSystem({ certs: certifiedFor('claude') });
  const result = await sys.subscriber.handle(ctx(dir, prompt({ model: SONNET }), { engine, adherence: { open: (a) => (opened.push(a), true), overrides: () => 0 }, extra: { tierSignals: HARD(), sessionModel: SONNET } }));
  assert.equal(result.hookOutcome.kind, 'context');
  assert.deepEqual(result.decisionIds, []);
  assert.match(opened[0].decisionId, /^tier-line-up-[a-z0-9]+-sessline$/);
});

// ------------------------------------------------------------------------------------- Codex, Kilo, OpenCode, Antigravity

async function seen(dir, harness, modelIds) {
  for (const modelId of modelIds) assert.equal(await core.recordModelRun(dir, { harness, authMode: 'unknown', modelId, nowMs: NOW }), true);
}

test('Codex: an OpenAI session gets the OpenAI step-up rung and Codex\'s /model, never an Anthropic model, no subagent clause; rendered as Codex context; dormant without local evidence', async (t) => {
  const dir = home(t);
  const { engine, calls } = stubEngine();
  const traces = [];
  const dormant = lineSystem({ certs: certifiedFor('codex') });
  assert.equal((await dormant.subscriber.handle(ctx(dir, prompt({ harness: 'codex', model: 'gpt-6.1-sol' }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: 'gpt-6.1-sol' } }))).hookOutcome.kind, 'observe');
  assert.equal(traces.at(-1).reasonCode, 'TIER_LINE_NO_LADDER');
  await seen(dir, 'codex', ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
  const sys = lineSystem({ certs: certifiedFor('codex') });
  const astra = await nameOf(dir, 'gpt-6-astra');
  const result = await sys.subscriber.handle(ctx(dir, prompt({ harness: 'codex', model: 'gpt-6.1-sol' }), { engine, extra: { tierSignals: HARD(), sessionModel: 'gpt-6.1-sol' } }));
  assert.deepEqual(result.hookOutcome, { kind: 'context', text: `Jevris: this looks hard (PROTECTED_AUTH): consider switching to ${astra} (/model). Advice only; nothing was changed.${MODEL_NOTE}` });
  const native = { session_id: 'sess-line', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: PROMPT, model: 'gpt-6.1-sol', turn_id: 't1' };
  assert.match(codex.protocolResponse(prompt({ harness: 'codex' }), result.hookOutcome, native), /"additionalContext":"Jevris: this looks hard/);
  assert.doesNotMatch(JSON.stringify(result), /claude|subagent|opus/i);
  // Uncertified context: a message to the person (systemMessage).
  const plain = lineSystem({ certs: certifiedFor('codex', []) });
  const told = await plain.subscriber.handle(ctx(dir, prompt({ harness: 'codex', model: 'gpt-6.1-sol' }), { engine, extra: { tierSignals: HARD(), sessionModel: 'gpt-6.1-sol' } }));
  assert.equal(told.hookOutcome.kind, 'explain');
  assert.match(codex.protocolResponse(prompt({ harness: 'codex' }), told.hookOutcome, native), /"systemMessage":"Jevris: this looks hard/);
  assert.deepEqual(calls, []);
});

for (const [harness, adapter] of [['kilocode', kilo], ['opencode', opencode]]) {
  test(`${harness}: the session's own provider's step-up rung, no command named (none is documented here), delivered at the chat message into the system prompt; silent where the plugin switches the turn itself`, async (t) => {
    const dir = home(t);
    const { engine } = stubEngine();
    await seen(dir, harness, ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
    const astra = await nameOf(dir, 'gpt-6-astra');
    const send = (sys, extra = {}, mode = 'bounded-auto') => sys.subscriber.handle(ctx(dir, prompt({ harness, model: 'openai/gpt-6.1-sol' }), { engine, mode, extra: { tierSignals: HARD(), ...extra } }));
    const sys = lineSystem({ certs: certifiedFor(harness) });
    const result = await send(sys);
    assert.deepEqual(result.hookOutcome, { kind: 'context', text: `Jevris: this looks hard (PROTECTED_AUTH): consider switching to ${astra}. Advice only; nothing was changed.${MODEL_NOTE}` });
    const rendered = JSON.parse(adapter.protocolResponse(prompt({ harness, model: 'openai/gpt-6.1-sol' }), result.hookOutcome));
    assert.deepEqual(rendered, { system: [result.hookOutcome.text] });
    // A turn the plugin switches under plugin-bounded-auto needs no line to say so.
    const switched = await send(lineSystem({ certs: certifiedFor(harness) }), { tierTurn: 'up' });
    assert.equal(switched.hookOutcome.kind, 'observe');
    assert.equal((await send(lineSystem({ certs: certifiedFor(harness) }), { tierTurn: 'none' })).hookOutcome.kind, 'context', 'advice-only turns still get the line');
    // An Anthropic session on the same harness points at Anthropic rungs; a session model Jevris does not know has no baseline.
    await seen(dir, harness, ['claude-sonnet-5-5', 'claude-opus-5-5']);
    const claudeSession = await lineSystem({ certs: certifiedFor(harness) }).subscriber.handle(ctx(dir, prompt({ harness, model: 'anthropic/claude-sonnet-5-5' }), { engine, extra: { tierSignals: HARD() } }));
    assert.match(claudeSession.hookOutcome.text, /Opus 5\.5/);
    const unknown = await lineSystem({ certs: certifiedFor(harness) }).subscriber.handle(ctx(dir, prompt({ harness, model: 'openai/some-future-model' }), { engine, extra: { tierSignals: HARD() } }));
    assert.equal(unknown.hookOutcome.kind, 'observe');
    // A tool event shows nothing on these harnesses: a line waits for the next chat message and is handed over there.
    const waiting = lineSystem({ certs: certifiedFor(harness) });
    const tool = event('tool.finished', { harness, nativeEventName: 'tool.execute.after', toolName: 'bash', model: 'openai/gpt-6.1-sol' });
    await waiting.subscriber.handle(ctx(dir, prompt({ harness, model: 'openai/gpt-6.1-sol' }), { engine, showsExplain: false, extra: { tierSignals: HARD() } }));
    assert.equal(waiting.store.count(WS, 'sess-line'), 1);
    const hidden = await waiting.subscriber.handle(ctx(dir, tool, { engine, showsExplain: false }));
    assert.equal(hidden.hookOutcome.kind, 'observe', 'the tool event cannot show it');
    assert.equal(waiting.store.count(WS, 'sess-line'), 1);
    const shown = await waiting.subscriber.handle(ctx(dir, event('task.requested', { harness, model: 'openai/gpt-6.1-sol', payload: {} }), { engine }));
    assert.equal(shown.hookOutcome.kind, 'context');
    assert.equal(shown.reasonCode, 'PENDING_ADVICE_DELIVERED');
    assert.equal(waiting.store.count(WS, 'sess-line'), 0);
  });
}

test('Antigravity: the Google ladder has no rung a tier away, so no line is made; a waiting line is handed over as the ephemeral message at the next invocation', async (t) => {
  const dir = home(t);
  const { engine } = stubEngine();
  await seen(dir, 'antigravity', ['gemini-3.8-flash', 'gemini-3.7-flash']);
  const sys = lineSystem({ certs: certifiedFor('antigravity') });
  const traces = [];
  const made = await sys.subscriber.handle(ctx(dir, event('invocation.started', { harness: 'antigravity', model: 'gemini-3.8-flash' }), { engine, traces, extra: { tierSignals: HARD(), sessionModel: 'gemini-3.8-flash' } }));
  assert.equal(made.hookOutcome.kind, 'observe');
  // The delivery path itself, with a line put on the queue (as a harness with a rung would): text only, no actuator.
  const line = provider.modelTierLine({ direction: 'up', harness: 'antigravity', reasons: ['TIER_MIGRATION'], protectedClasses: [], attempts: null, baselineName: 'Gemini 3.8 Flash', targetName: 'a Google model', switchCommand: null, subagentAlias: null });
  sys.store.put(WS, 'sess-line', { kind: 'model-tier', text: line.model, personText: line.person, decisionId: null, reasonCode: 'TIER_LINE_UP' });
  const invocation = event('invocation.started', { harness: 'antigravity', model: 'gemini-3.8-flash', payload: {} });
  const delivered = await sys.subscriber.handle(ctx(dir, invocation, { engine }));
  assert.deepEqual(delivered.hookOutcome, { kind: 'context', text: line.model });
  assert.deepEqual(JSON.parse(antigravity.protocolResponse(invocation, delivered.hookOutcome)), { injectSteps: [{ ephemeralMessage: line.model }] });
  assert.equal(sys.store.count(WS, 'sess-line'), 0);
});

// ------------------------------------------------------------------------------------------------------- the wiring

test('the line is a default handler of the new-task and repeated-failure triggers; the pending store keeps its kind, its person text and its delivery note; the quiet period is 30 minutes', () => {
  assert.ok(provider.DEFAULT_TRIGGER_HANDLERS['new-task'].includes(provider.modelTierAdvice));
  assert.ok(provider.DEFAULT_TRIGGER_HANDLERS['repeated-failure'].includes(provider.modelTierAdvice));
  assert.equal(provider.TIER_LINE_QUIET_MS, 30 * MIN);
  const store = new provider.PendingAdviceStore({ now: () => NOW });
  let delivered = 0;
  assert.equal(store.put('w', 's', { kind: 'model-tier', text: 'x'.repeat(900), personText: 'y', decisionId: null, reasonCode: 'TIER_LINE_UP', delivered: () => (delivered += 1) }), true);
  const waiting = store.peek('w', 's');
  assert.equal(waiting.text.length, 500, 'the 500-character cap applies');
  assert.equal(waiting.personText, 'y');
  assert.equal(delivered, 0);
  assert.equal(store.consume('w', 's', waiting), true);
  assert.equal(delivered, 1);
  assert.equal(store.consume('w', 's', waiting), false);
  assert.equal(delivered, 1, 'taken once');
});
