/**
 * Contract fuzzing (QA-04; SSOT §18.1, US30). The response validator of the Jev provider is
 * fuzzed next to its code (packages/core/test/decision-validate.test.mjs). This suite covers the
 * other untrusted inputs:
 *
 * - hook stdin, in process: the launcher with every real adapter, fed seeded mutations of each
 *   adapter's own fixtures plus hostile forms (malformed and truncated JSON, NaN, lone
 *   surrogates, `__proto__` and `constructor` keys, deep nesting, oversize strings) and a
 *   sidecar that answers with hostile results. It never throws, always exits 0, never echoes
 *   input content, never actuates an uncertified proposal and never pollutes a prototype;
 * - hook stdin, as a process: the bundled hook given malformed UTF-8, a lone surrogate encoded
 *   in UTF-8, an input over the cap and truncated JSON exits 0 quickly with no content echoed;
 * - every exported contract validator: hostile values are refused as data, never thrown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contracts from '@jevris/contracts';
import * as hook from '@jevris/hook';
import * as antigravity from '@jevris/adapter-antigravity';
import * as claude from '@jevris/adapter-claude-code';
import * as codex from '@jevris/adapter-codex';
import * as kilocode from '@jevris/adapter-kilocode';
import * as opencode from '@jevris/adapter-opencode';
import { forAll, RUNS } from './prng.mjs';

const ADAPTERS = { claude, kilo: kilocode, codex, opencode, agy: antigravity };
// The HKR-01 launcher (E). Until it is exported the in-process hook fuzz is skipped by name.
const runLauncher = hook.runLauncher;
const CANARY = 'CANARY-qa04-9d1c-input-must-not-echo';
const root = fileURLToPath(new URL('../..', import.meta.url));

function plantCanary(value, rand) {
  if (Array.isArray(value)) return value.map((item) => plantCanary(item, rand));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = typeof item === 'string' && rand.bool(0.3) ? `${item} ${CANARY}` : plantCanary(item, rand);
    return out;
  }
  return value;
}

/** A hostile variant of a native input, as the text the launcher reads from stdin. */
function hostileText(rand, native) {
  const planted = plantCanary(native, rand);
  const text = JSON.stringify(planted);
  return rand.pick([
    () => text,
    () => text.slice(0, rand.int(0, Math.max(0, text.length - 1))),
    () => text.replace(/"[^"]*"\s*:/, '"__proto__":'),
    () => text.replace(/^\{/, '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},'),
    () => text.replace(/:\s*"[^"]*"/, ':NaN'),
    () => text.replace(/:\s*"[^"]*"/, ':-Infinity'),
    () => text.replace(/"([^"]*)"$/, '"\\ud800$1"').replace(/\}$/, ',"lone":"\\udfff"}'),
    () => `${'['.repeat(rand.int(500, 5000))}${CANARY}`,
    () => JSON.stringify({ ...planted, pad: CANARY.repeat(rand.int(100, 4000)) }),
    () => {
      const chars = [...text];
      for (let i = 0; i < rand.int(1, 6); i += 1) chars[rand.int(0, chars.length - 1)] = String.fromCharCode(rand.int(0, 0xffff));
      return chars.join('');
    },
    () => JSON.stringify([planted]),
    () => 'null',
    () => '',
  ])();
}

/** Sidecar answers a hostile or buggy sidecar could send; none carries input content. */
function hostileAnswer(rand) {
  const route = { hookOutcome: { kind: 'route', model: 'claude-haiku-4-5' }, certified: rand.bool(0.5) };
  const context = { hookOutcome: { kind: 'context', text: 'jevris context' }, certified: rand.bool(0.5) };
  return rand.pick([
    { ok: true, result: { recorded: true, duplicate: false, results: {} } },
    { ok: true, result: { duplicate: true, results: { a: route } } },
    { ok: true, result: { results: { a: route, b: context } } },
    // Owner decision 2026-10-08: a route may carry a short note for the model (Claude Code renders it beside the rewrite).
    { ok: true, result: { results: { a: { hookOutcome: { kind: 'route', model: 'claude-haiku-5-5', context: 'Jevris set model haiku on this one Agent call (read-only type, low risk by rules). The session model is unchanged.' }, certified: rand.bool(0.5) } } } },
    { ok: true, result: { results: JSON.parse('{"__proto__":{"hookOutcome":{"kind":"route"}},"x":{"hookOutcome":{"kind":"nonsense"}}}') } },
    { ok: true, result: { results: { a: { hookOutcome: { kind: 'route', updatedInput: 'not-an-object' }, certified: true } } } },
    { ok: true, result: { results: { a: { hookOutcome: { kind: 'route', updatedInput: { command: 'echo routed' } }, certified: true } } } },
    { ok: true, result: { results: { a: { hookOutcome: { kind: 'route', model: 'https://evil.example/m' }, certified: true } } } },
    { ok: true, result: null },
    { ok: true, result: [route] },
    { ok: false, reason: 'refused', reasonCode: 'KILL_SWITCH', message: 'stopped' },
    { ok: false, reason: 'timeout', message: 'deadline' },
  ]);
}

/**
 * Claude Code's route (owner decision 9ce2ba5, F 47144df): `updatedInput` replaces the Agent
 * tool's whole input, so the harness gets its own tool input back with only `model` added. That
 * is the one place an input value may appear, and only as exactly that; everything else in the
 * output is still checked for echoed input.
 */
function withoutRouteInput(stdout, text) {
  let output;
  let input;
  try {
    output = JSON.parse(stdout);
    input = JSON.parse(text);
  } catch {
    return stdout;
  }
  const updated = output?.hookSpecificOutput?.updatedInput;
  const own = input?.tool_input;
  if (updated === null || typeof updated !== 'object' || own === null || typeof own !== 'object' || 'model' in own) return stdout;
  const { model, ...rest } = updated;
  assert.equal(typeof model, 'string', 'a route adds the model');
  assert.deepEqual(rest, own, 'a route hands back the harness\'s own tool input unchanged, with only the model added');
  const { updatedInput: _input, additionalContext: _note, ...hookRest } = output.hookSpecificOutput;
  return JSON.stringify({ ...output, hookSpecificOutput: hookRest, model });
}

test(`the hook launcher survives ${RUNS} hostile stdin and sidecar answers per run seed (QA-04, US30)`, async (t) => {
  assert.equal(typeof runLauncher, 'function', '@jevris/hook exports runLauncher (HKR-01)');
  const reasons = new Map();
  const { seed } = await forAll('hook launcher fuzz', async (rand, run) => {
    const harness = rand.pick(Object.keys(ADAPTERS));
    const adapter = ADAPTERS[harness];
    const fixture = rand.pick(adapter.FIXTURES);
    // Run 0 is always an input over the cap, so the coverage checks below never depend on a seed
    // drawing the one rare oversize variant (seed 1657067800 drew none in 1000 runs).
    const text = run === 0 ? 'x'.repeat(contracts.HARNESS_INPUT_CAP + 1) : hostileText(rand, fixture.native);
    const answer = hostileAnswer(rand);
    let requested = false;
    const deps = {
      adapters: ADAPTERS,
      sidecar: {
        ensure: async () => (rand.bool(0.9) ? { ok: true, endpoint: 'fake', started: false } : { ok: false, reason: 'unavailable', message: 'down' }),
        request: async () => {
          requested = true;
          return answer;
        },
      },
      env: { JEVRIS_HOME: '/tmp/jevris-qa-home' },
      cwd: () => '/work',
      nowMs: () => 0,
    };
    const hookKey = typeof fixture.native?.hookKey === 'string' ? fixture.native.hookKey : null;
    const result = await runLauncher({ harness, event: hookKey }, text.length > contracts.HARNESS_INPUT_CAP ? null : text, deps, 0);
    reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.stdout, 'string');
    assert.equal(withoutRouteInput(result.stdout, text).includes(CANARY), false, `${harness} echoed input content (${result.reason})`);
    const proposals = answer.ok && answer.result !== null && typeof answer.result === 'object' ? Object.values(answer.result.results ?? {}) : [];
    const certifiedActuation = proposals.some((p) => p?.certified === true && ['route', 'context'].includes(p?.hookOutcome?.kind));
    if (!certifiedActuation || answer.result?.duplicate === true) {
      assert.equal(result.stdout.includes('echo routed'), false, `${harness} actuated an uncertified or duplicate proposal`);
      assert.equal(result.stdout.includes('jevris context'), false, `${harness} added uncertified context`);
    }
    assert.equal(/echo routed|evil\.example/.test(result.stdout), false, `${harness} rendered a tool input or model the wire cannot carry`);
    if (!requested) assert.ok(result.reason.length > 0);
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  });
  t.diagnostic(`seed ${seed}, reasons ${JSON.stringify(Object.fromEntries([...reasons].sort()))}`);
  if (RUNS >= 200) {
    for (const reason of ['INVALID_JSON', 'INPUT_REFUSED']) assert.ok(reasons.has(reason), `the fuzzer never produced ${reason}`);
    // A certified proposal ends as an actuation (PROPOSED_BY_*) or, for a route the harness's own
    // input cannot carry, as ROUTE_NOT_RENDERED or ROUTE_INPUT_CUT (F 47144df): only a Claude Agent
    // fixture renders a route now, so some seeds draw no actuation at all.
    assert.ok([...reasons.keys()].some((r) => r.startsWith('PROPOSED_BY_') || r === 'ROUTE_NOT_RENDERED' || r === 'ROUTE_INPUT_CUT'), 'the fuzzer never reached a certified proposal');
  }
});

const HOOK = join(root, 'dist', 'hook.mjs');

test('the bundled hook exits 0 quickly on hostile stdin bytes and echoes nothing (QA-04)', () => {
  assert.equal(existsSync(HOOK), true, 'npm run build writes dist/hook.mjs');
  const enc = (text) => Buffer.from(text, 'utf8');
  const valid = JSON.stringify({ ...claude.FIXTURES.find((f) => f.native.hook_event_name === 'PreToolUse')?.native, note: CANARY });
  const cases = [
    ['malformed UTF-8', Buffer.concat([enc('{"a":"'), Buffer.from([0xff, 0xfe, 0xc0]), enc(`${CANARY}"}`)])],
    ['UTF-8 encoded lone surrogate', Buffer.concat([enc('{"a":"'), Buffer.from([0xed, 0xa0, 0x80]), enc(`${CANARY}"}`)])],
    ['over the input cap', enc(`{"pad":"${CANARY}${'x'.repeat(contracts.HARNESS_INPUT_CAP)}"}`)],
    ['truncated JSON', enc(valid.slice(0, Math.floor(valid.length / 2)))],
    ['NaN', enc(`{"hook_event_name":"PreToolUse","x":NaN,"c":"${CANARY}"}`)],
    ['prototype keys', enc(`{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"c":"${CANARY}"}`)],
    ['valid input, observe only', enc(valid)],
  ];
  for (const harness of ['claude', 'codex', 'kilo', 'opencode', 'agy']) {
    for (const [name, input] of cases) {
      const started = process.hrtime.bigint();
      const run = spawnSync(process.execPath, [HOOK, '--harness', harness], {
        input,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, JEVRIS_HOOK_OBSERVE_ONLY: '1', JEVRIS_HOOK_DEBUG: '0' },
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(run.status, 0, `${harness} ${name}: exit ${run.status} ${run.stderr}`);
      assert.equal(run.stdout.includes(CANARY), false, `${harness} ${name}: stdout echoes input`);
      assert.equal(run.stderr.includes(CANARY), false, `${harness} ${name}: stderr echoes input`);
      assert.equal(/\bat .+:\d+:\d+/.test(run.stderr), false, `${harness} ${name}: a stack trace reached stderr`);
      assert.ok(ms < 8_000, `${harness} ${name}: took ${ms} ms`);
    }
  }
});

function hostileValue(rand, depth = 0) {
  return rand.pick([
    () => null,
    () => undefined,
    () => rand.int(-1e9, 1e9),
    () => rand.pick([Number.NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 2, 0.1 + 0.2]),
    () => BigInt(rand.int(-10, 10)),
    () => rand.pick(['', '\ud800', '\udfff\ud800', 'a'.repeat(rand.int(1, 70_000)), '__proto__', 'constructor', '../../etc/passwd', '\u0000', 'passed']),
    () => rand.bool(),
    () => (depth > 3 ? [] : Array.from({ length: rand.int(0, 4) }, () => hostileValue(rand, depth + 1))),
    () => JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"schemaVersion":"1.0"}'),
    () => {
      if (depth > 3) return {};
      const out = {};
      for (const key of rand.subset(['id', 'schemaVersion', 'kind', 'state', 'workspaceId', 'payload', 'subject', 'revision', 'version', 'value', 'toString', 'valueOf'], 4)) {
        out[key] = hostileValue(rand, depth + 1);
      }
      return out;
    },
    () => {
      let nested = {};
      const top = nested;
      for (let i = 0; i < rand.int(100, 3000); i += 1) nested = nested.x = {};
      return top;
    },
  ])();
}

test(`every exported contract validator refuses hostile values without throwing over ${RUNS} runs (QA-04)`, async (t) => {
  const validators = Object.entries(contracts).filter(([, value]) => value !== null && typeof value === 'object' && typeof value.validate === 'function');
  assert.ok(validators.length >= 20, `found ${validators.length} contract validators`);
  const accepted = new Map();
  const { seed } = await forAll('contract validator fuzz', (rand) => {
    const value = hostileValue(rand);
    for (const [name, contract] of validators) {
      let result;
      assert.doesNotThrow(() => {
        result = contract.validate(value);
      }, `${name}.validate threw`);
      assert.equal(typeof result?.ok, 'boolean', `${name}.validate returned ${typeof result}`);
      if (result.ok) accepted.set(name, (accepted.get(name) ?? 0) + 1);
    }
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  });
  t.diagnostic(`seed ${seed}, validators ${validators.length}, accepted ${JSON.stringify(Object.fromEntries(accepted))}`);
  // Only the generic JSON contract may accept arbitrary data.
  for (const name of accepted.keys()) assert.ok(['JsonContract'].includes(name), `${name} accepted a hostile value`);
});
