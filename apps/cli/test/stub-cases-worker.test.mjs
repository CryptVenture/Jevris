// K8 (worker.actual-model) and K2 (Codex spawn_agent route under OD-6) stub cases: a stand-in CLI
// (or, for K2, a stand-in app-server session) plays the harness against the real loopback stub and
// runs the case's own probe hook or plugin. No real harness starts, and the temp profile is the
// only home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runStubCases, readProbeRecords, codexProbeHook, codexProbeFlags, codexProbeConfig, actualModelVerdict, codexShellCall, offeredTool, k2Route, k2WriteCommand, fileUrl, K8_MODELS, K2_MODELS, K2_ESCAPE_FILE, K2_SPAWN_INPUT, STUB_CASE_MODELS } = await import('../dist/stub-cases.js');

async function withProfile(fn) {
  const profile = await mkdtemp(join(tmpdir(), 'jevris-stub-worker-'));
  try {
    await mkdir(join(profile, '.codex'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: profile, CODEX_HOME: join(profile, '.codex'), JEVRIS_HOOK_OBSERVE_ONLY: '1', OPENAI_API_KEY: 'sk-real-looking' };
    return await fn(profile, env);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

function cli(behave) {
  const calls = [];
  return {
    calls,
    cli: {
      available: () => true,
      run: async (file, args, _timeout, env, options) => {
        calls.push({ file, args: [...args], cwd: options?.cwd ?? null });
        await behave(file, args, env, options?.cwd ?? null);
        return { spawned: true, code: 0, stdout: '' };
      },
    },
  };
}

async function responses(base, key, body) {
  const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ stream: true, ...body }) });
  return response.text();
}

async function codexBase(env) {
  const toml = await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8');
  return /base_url = "([^"]+)"/.exec(toml)[1].replace(/\/v1$/, '');
}

function hook(probe, input) {
  return execFileSync(process.execPath, [probe], { input: JSON.stringify(input), encoding: 'utf8' });
}

const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));

test('codex.worker-actual-model (K8): the probe notes the model SessionStart reports; a mismatch or silence fails', async () => {
  await withProfile(async (profile, env) => {
    const play = (reported) =>
      cli(async (_file, args, runEnv, cwd) => {
        const base = await codexBase(runEnv);
        await responses(base, runEnv.JEVRIS_STUB_KEY, { model: args[args.indexOf('--model') + 1], input: [] });
        if (!args.includes('--dangerously-bypass-hook-trust')) return;
        const probe = join(cwd, 'k8-codex-probe.cjs');
        if (!existsSync(probe) || reported === null) return;
        hook(probe, { hook_event_name: 'SessionStart', model: reported, session_id: 's', source: 'startup', cwd, transcript_path: null, permission_mode: 'default' });
        hook(probe, { hook_event_name: 'UserPromptSubmit', model: reported, prompt: 'secret prompt text' });
      });
    const good = play(K8_MODELS.codex);
    const ok = byId(await runStubCases({ harness: 'codex', cli: good.cli, env, profile, hookEntry: null, timeoutMs: 5000 }))['codex.worker-actual-model'];
    assert.deepEqual([ok.passed, ok.reasonCode], [true, null], ok.detail);
    assert.match(ok.detail, /SessionStart and UserPromptSubmit reported gpt-5\.5/);
    const call = good.calls.find((item) => item.args.includes('--dangerously-bypass-hook-trust') && !item.args.includes('features.multi_agent_v2=true'));
    assert.deepEqual(call.args.slice(0, 4), ['exec', '--json', '--model', K8_MODELS.codex], "the owned worker's own argv");
    assert.ok(call.args.includes('approval_policy="never"') && call.args.includes('read-only'));
    assert.equal(call.args.at(-1), 'Reply with the single word ok.');
    const wrong = byId(await runStubCases({ harness: 'codex', cli: play('gpt-6-luna').cli, env, profile, hookEntry: null, timeoutMs: 5000 }))['codex.worker-actual-model'];
    assert.deepEqual([wrong.passed, wrong.reasonCode], [false, 'MODEL_MISREPORTED']);
    const silent = byId(await runStubCases({ harness: 'codex', cli: play(null).cli, env, profile, hookEntry: null, timeoutMs: 5000 }))['codex.worker-actual-model'];
    assert.deepEqual([silent.passed, silent.reasonCode], [false, 'MODEL_NOT_REPORTED']);
  });
});

test('codex probe: records names and models only, and answers only the expected spawn_agent call, with the given text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-codex-probe-'));
  try {
    const marker = join(dir, 'm.jsonl');
    const probe = join(dir, 'p.cjs');
    const route = { input: { message: 'secret task text', task_name: 't' }, text: '{"routed":true}' };
    await writeFile(probe, codexProbeHook(marker, route));
    assert.equal(hook(probe, { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', model: 'gpt-5.5', tool_input: { task_name: 't', message: 'secret task text' } }), route.text, 'key order does not matter');
    assert.equal(hook(probe, { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_input: { message: 'other', task_name: 't' } }), '', 'another input gets no answer');
    assert.equal(hook(probe, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > f' } }), '', 'a shell call gets no answer, as from the installed hook');
    assert.equal(hook(probe, 'not an object'), '');
    const text = await readFile(marker, 'utf8');
    assert.equal(text.includes('secret'), false, 'no input text is written');
    assert.deepEqual((await readProbeRecords(marker)).map((item) => [item.event, item.tool, item.answered]), [['PreToolUse', 'spawn_agent', true], ['PreToolUse', 'spawn_agent', false], ['PreToolUse', 'Bash', false]]);
    await writeFile(probe, codexProbeHook(marker, null));
    assert.equal(hook(probe, { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_input: route.input }), '', 'K8 never answers');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const flags = codexProbeFlags('/p/probe.cjs');
  assert.equal(flags[0], '--dangerously-bypass-hook-trust');
  assert.deepEqual(flags.slice(1), [...codexProbeConfig('/p/probe.cjs')]);
  assert.equal(codexProbeConfig('/p/probe.cjs').length, 8);
  assert.match(flags[2], /^hooks\.SessionStart=\[\{hooks=\[\{type="command",command=".*probe\.cjs.*",timeout=10\}\]\}\]$/);
  assert.deepEqual(codexShellCall(['exec_command'], 'c'), { kind: 'tool', name: 'exec_command', input: { cmd: 'c' } });
  assert.deepEqual(codexShellCall(['exec_command'], 'c', true).input, { cmd: 'c', sandbox_permissions: 'require_escalated', justification: 'Jevris certify probe: must be declined' });
  assert.deepEqual(codexShellCall(['shell'], 'c').input, { command: ['sh', '-c', 'c'] });
  assert.equal(codexShellCall(['apply_patch'], 'c'), null);
  assert.equal(k2WriteCommand("/a b/it's/f"), "echo x > '/a b/it'\\''s/f'");
  assert.deepEqual([actualModelVerdict('x', 'a', null, []).reasonCode, actualModelVerdict('x', 'anthropic/m', 'm', [{ source: 's', model: 'anthropic/m' }]).passed], ['MODEL_NOT_REPORTED', true]);
});

test('offeredTool finds a tool plain first, then in a Responses namespace', () => {
  assert.deepEqual(offeredTool(['spawn_agent', 'collaboration.spawn_agent'], 'spawn_agent'), {});
  assert.deepEqual(offeredTool(['collaboration', 'collaboration.spawn_agent'], 'spawn_agent'), { namespace: 'collaboration' });
  assert.deepEqual(offeredTool(['multi_agent_v1.spawn_agent'], 'spawn_agent'), { namespace: 'multi_agent_v1' });
  assert.equal(offeredTool(['collaboration', '.spawn_agent', 'xspawn_agent'], 'spawn_agent'), null);
  assert.equal(offeredTool([], 'wait_agent'), null);
});

test("K2's route is the installed Codex adapter's own answer: allow, the scripted spawn_agent input key for key, plus model", () => {
  const route = k2Route();
  assert.deepEqual(route.input, K2_SPAWN_INPUT);
  assert.deepEqual(JSON.parse(route.text), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...K2_SPAWN_INPUT, model: K2_MODELS.routed } } });
});

for (const harness of ['opencode', 'kilocode']) {
  test(`${harness}.worker-actual-model (K8): chat.message and the assistant message report the model the request carried`, async () => {
    await withProfile(async (profile, env) => {
      const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
      const play = (reports) =>
        cli(async (_file, args, runEnv) => {
          const config = JSON.parse(runEnv[key]);
          const provider = config.provider.anthropic.options;
          const hooks = await (await import(config.plugin[0])).JevrisStubProbe({});
          if (args.includes('--model') && hooks['chat.message'] !== undefined && hooks['experimental.chat.system.transform'] === undefined && reports !== null) {
            const [providerID, modelID] = reports.split('/');
            await hooks['chat.message']({ sessionID: 's', model: { providerID, modelID } }, { message: {}, parts: [{ type: 'text', text: 'secret' }] });
            await hooks.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', providerID, modelID } } } });
          }
          await fetch(`${provider.baseURL.replace(/\/v1$/, '')}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey }, body: JSON.stringify({ model: STUB_CASE_MODELS[harness], messages: [], tools: [{ name: 'bash', input_schema: {} }] }) }).then((r) => r.text());
        });
      const good = play(K8_MODELS[harness]);
      const ok = byId(await runStubCases({ harness, cli: good.cli, env, profile, hookEntry: null, timeoutMs: 5000 }))[`${harness}.worker-actual-model`];
      assert.deepEqual([ok.passed, ok.reasonCode], [true, null], ok.detail);
      assert.match(ok.detail, /chat\.message and message\.updated reported anthropic\/claude-haiku-4-5/);
      const call = good.calls.find((item) => item.args.includes('--model'));
      assert.deepEqual(call.args.slice(0, 5), ['run', '--format', 'json', '--model', K8_MODELS[harness]]);
      const wrong = byId(await runStubCases({ harness, cli: play('anthropic/claude-opus-5-5').cli, env, profile, hookEntry: null, timeoutMs: 5000 }))[`${harness}.worker-actual-model`];
      assert.deepEqual([wrong.passed, wrong.reasonCode], [false, 'MODEL_MISREPORTED']);
      const silent = byId(await runStubCases({ harness, cli: play(null).cli, env, profile, hookEntry: null, timeoutMs: 5000 }))[`${harness}.worker-actual-model`];
      assert.equal(silent.reasonCode, 'MODEL_NOT_REPORTED');
    });
  });
}

const argsOf = (text) => JSON.parse(JSON.parse(/"arguments":("(?:[^"\\]|\\.)+")/.exec(text)[1]));

/**
 * Plays `codex app-server` for K2 over a stand-in stdio session: initialize, thread/start and
 * turn/start get their answers; the turn asks the real stub for the parent's spawn_agent call,
 * runs the probe hook on it, asks the stub again on the model the hook chose (the subagent), runs
 * the probe on the subagent's shell call, and then either sends Codex's approval request and waits
 * for the client's answer (`asks`) or, when `runsUnasked`, writes the file as an unsandboxed
 * command would. With `namespace`, the parent's agent tools come inside that Responses namespace,
 * and the hook names the spawn call as Codex 0.157.1 does: `spawn_agent` in multi_agent_v1,
 * `<namespace>spawn_agent` in any other. As in 0.157.1, spawn_agent returns at once and the child
 * runs on its own thread (`thread-child`): by default (`parentFirst`) the parent's turn completes
 * before the child's shell call runs, and a client that has stopped by then never lets it run
 * (the owner's certify run, SHELL_NOT_SEEN). The child's turn then completes on its own thread.
 * As 0.157.1 does, the parent's thread announces the child with a subAgentActivity item carrying
 * its thread id (`announces`), started when spawned and completed when done, and the child's hook
 * input names the child in `agent_id`. Without `childTurns`, the child's own turn/started and
 * turn/completed never reach the client, only the announcements and the approval request.
 */
function playK2({ honoursModel = true, runsHook = true, shellHook = true, asks = true, runsUnasked = false, threadStart = true, namespace = null, parentFirst = true, announces = true, childTurns = true } = {}) {
  const seen = { args: null, threadStart: null, answers: [], shellAfterParent: false };
  const launch = (file, args, options) => {
    seen.args = [...args];
    seen.file = file;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      resolveDone({ spawned: true, code: 0 });
    };
    const emit = (message) => {
      if (!exited) options.onLine(JSON.stringify(message));
    };
    const waiters = new Map();
    const probe = join(options.cwd, 'k2-codex-probe.cjs');
    const turn = async () => {
      const base = await codexBase(options.env);
      const key = options.env.JEVRIS_STUB_KEY;
      const agentTools = [{ type: 'function', name: 'spawn_agent' }, { type: 'function', name: 'wait_agent' }];
      const parentTools = [...(namespace === null ? agentTools : [{ type: 'namespace', name: namespace, description: 'agents', tools: agentTools }]), { type: 'function', name: 'exec_command' }];
      const first = await responses(base, key, { model: K2_MODELS.session, input: [], tools: parentTools });
      if (namespace !== null) assert.match(first, new RegExp(`"namespace":"${namespace}"`), 'the call names the namespace its tool came in');
      const toolInput = argsOf(first);
      let childModel = K2_MODELS.session;
      if (runsHook) {
        const hookName = namespace === null || namespace === 'multi_agent_v1' ? 'spawn_agent' : `${namespace}spawn_agent`;
        const out = hook(probe, { hook_event_name: 'PreToolUse', tool_name: hookName, model: K2_MODELS.session, tool_input: toolInput });
        if (honoursModel && out.length > 0) childModel = JSON.parse(out).hookSpecificOutput.updatedInput.model;
      }
      const activity = (method, kind) => emit({ method, params: { threadId: 'thread-parent', turnId: 'p1', item: { type: 'subAgentActivity', id: `spawn-${kind}`, kind, agentThreadId: 'thread-child', agentPath: '/root/worker' } } });
      if (announces) activity('item/started', 'started');
      const child = await responses(base, key, { model: childModel, input: [], tools: [{ type: 'function', name: 'exec_command' }] });
      const parentTurn = async () => {
        const after = await responses(base, key, { model: K2_MODELS.session, input: [], tools: parentTools });
        assert.match(after, /"name":"wait_agent"/);
        emit({ method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'p1' } } });
      };
      if (parentFirst) {
        await parentTurn();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (exited) return;
        seen.shellAfterParent = true;
      }
      if (childTurns) emit({ method: 'turn/started', params: { threadId: 'thread-child', turn: { id: 'c1' } } });
      if (childModel === K2_MODELS.routed) {
        const call = argsOf(child);
        assert.equal(call.cmd, k2WriteCommand(join(options.cwd, K2_ESCAPE_FILE)), 'the absolute path of the file the case checks');
        assert.equal(call.sandbox_permissions, 'require_escalated');
        if (shellHook) assert.equal(hook(probe, { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'thread-child', agent_type: 'default', tool_input: { command: call.cmd } }), '', 'the probe never answers a shell call');
        if (asks) {
          const answered = new Promise((resolve) => waiters.set('approval-1', resolve));
          emit({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-child', turnId: 'c1', itemId: 'i1', startedAtMs: 1, command: call.cmd } });
          const answer = await answered;
          seen.answers.push(answer);
          if (answer.result?.decision === 'accept') await writeFile(join(options.cwd, K2_ESCAPE_FILE), 'x');
        } else if (runsUnasked) {
          await writeFile(join(options.cwd, K2_ESCAPE_FILE), 'x');
        }
      }
      if (childTurns) emit({ method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'c1' } } });
      if (announces) activity('item/completed', 'completed');
      if (!parentFirst) await parentTurn();
    };
    const session = {
      pid: 4242,
      done,
      stderr: Promise.resolve(''),
      kill: exit,
      endInput: () => {},
      send: (text) => {
        const message = JSON.parse(text);
        if (message.method === undefined && waiters.has(message.id)) {
          waiters.get(message.id)(message);
          waiters.delete(message.id);
          return true;
        }
        if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'codex' } });
        if (message.method === 'thread/start') {
          seen.threadStart = message.params;
          emit(threadStart ? { id: message.id, result: { thread: { id: 'thread-parent' } } } : { id: message.id, error: { code: -1, message: 'no' } });
        }
        if (message.method === 'turn/start') {
          emit({ id: message.id, result: { turn: { id: 'p1' } } });
          turn().catch((error) => {
            seen.error = error;
            exit();
          });
        }
        return true;
      },
    };
    return session;
  };
  return { seen, launch };
}

test('codex.subagent-route (K2): the installed allow routes the subagent, and under on-request its escalated write still asks for approval', async () => {
  await withProfile(async (profile, env) => {
    const quiet = cli(async (_file, _args, runEnv) => {
      await responses(await codexBase(runEnv), runEnv.JEVRIS_STUB_KEY, { model: 'gpt-5.5', input: [] });
    });
    const k2 = async (behaviour) => {
      const play = playK2(behaviour);
      const found = byId(await runStubCases({ harness: 'codex', cli: quiet.cli, env, profile, hookEntry: null, timeoutMs: 5000, launchInteractive: play.launch }))['codex.subagent-route'];
      assert.equal(play.seen.error, undefined, String(play.seen.error));
      return { found, seen: play.seen };
    };
    const { found: ok, seen } = await k2({});
    assert.deepEqual([ok.passed, ok.reasonCode], [true, null], ok.detail);
    assert.equal(seen.shellAfterParent, true, "the client waited for the child's turn after the parent's completed");
    const sequential = (await k2({ parentFirst: false })).found;
    assert.deepEqual([sequential.passed, sequential.reasonCode], [true, null], 'a child that finishes before the parent passes too');
    // The client learns of the child from the parent's subAgentActivity items alone, as well as
    // from the child's own turn notifications.
    const announced = (await k2({ childTurns: false })).found;
    assert.deepEqual([announced.passed, announced.reasonCode], [true, null], announced.detail);
    const unannounced = (await k2({ announces: false })).found;
    assert.deepEqual([unannounced.passed, unannounced.reasonCode], [true, null], unannounced.detail);
    // The trace: names and thread roles only, never a thread id, command, path or content.
    const has = (from, name, thread) => ok.trace.some((item) => item.from === from && item.name === name && item.thread === thread);
    assert.ok(has('client', 'initialize', 'none') && has('client', 'turn/start', 'parent'), JSON.stringify(ok.trace));
    assert.ok(has('server', 'item/started:subAgentActivity:started', 'parent'), 'the spawn announcement');
    assert.ok(announced.trace.some((item) => item.from === 'server' && item.name === 'item/completed:subAgentActivity:completed' && item.thread === 'parent'), "the child's end, announced on the parent's thread, settles the run");
    assert.ok(!announced.trace.some((item) => item.name === 'turn/started' && item.thread === 'child-1') && announced.trace.some((item) => item.name === 'item/commandExecution/requestApproval' && item.thread === 'child-1'), 'the announced thread id is the one the approval names');
    assert.ok(has('server', 'turn/started', 'child-1') && has('server', 'turn/completed', 'child-1'), "the child's own turn");
    assert.ok(has('server', 'item/commandExecution/requestApproval', 'child-1') && has('client', 'answer:item/commandExecution/requestApproval', 'child-1'), 'the approval, asked and refused on the child');
    assert.ok(has('stub', 'request:routed', 'none') && has('stub', 'offers:exec_command', 'none') && has('stub', 'reply:exec_command', 'none'), "the child's request and the stub's reply");
    assert.ok(has('hook', 'PreToolUse:spawn_agent', 'parent') && has('hook', 'PreToolUse:Bash', 'child-1'), 'the hook calls by thread role');
    assert.ok(has('client', 'ended:completed', 'none'));
    const text = JSON.stringify(ok.trace);
    for (const secret of ['thread-child', 'thread-parent', K2_ESCAPE_FILE, profile, 'sandbox_permissions']) assert.equal(text.includes(secret), false, secret);
    assert.ok(ok.trace.every((item) => /^[A-Za-z0-9_./:-]{1,96}$/.test(item.name) && /^(?:parent|child-[0-9]{1,2}|none)$/.test(item.thread) && item.count >= 1));
    const unseen = (await k2({ shellHook: false })).found;
    assert.equal(unseen.reasonCode, 'SHELL_NOT_SEEN');
    assert.ok(unseen.trace.some((item) => item.name === 'reply:exec_command') && !unseen.trace.some((item) => item.name === 'PreToolUse:Bash'), 'a failure carries its trace too');
    assert.match(ok.detail, /ran the subagent on gpt-6-astra while the session ran gpt-5\.5; under on-request the subagent's escalated write still asked for approval \(1 request\(s\), on the subagent's thread\) and, declined, did not run/);
    assert.deepEqual(seen.answers.map((item) => item.result), [{ decision: 'decline' }], 'every approval is declined');
    assert.deepEqual(seen.threadStart, { model: K2_MODELS.session, cwd: seen.threadStart.cwd, approvalPolicy: 'on-request', sandbox: 'read-only', config: { bypass_hook_trust: true } });
    assert.equal(seen.args.at(-1), 'app-server');
    assert.ok(seen.args.includes('features.multi_agent_v2=true'));
    assert.equal(seen.args.includes('--dangerously-bypass-hook-trust'), false, 'trust is bypassed for the thread only');
    assert.equal((await k2({ honoursModel: false })).found.reasonCode, 'ROUTE_IGNORED');
    assert.equal((await k2({ runsHook: false })).found.reasonCode, 'HOOK_NOT_RUN');
    assert.equal((await k2({ asks: false })).found.reasonCode, 'APPROVAL_NOT_ASKED');
    assert.equal((await k2({ asks: false, runsUnasked: true })).found.reasonCode, 'ALLOW_SKIPPED_APPROVAL');
    assert.equal((await k2({ threadStart: false })).found.reasonCode, 'APP_SERVER_REFUSED');
    // Codex 0.157.1 offers the MultiAgentV2 tools inside the "collaboration" namespace and names the
    // spawn call "collaborationspawn_agent" in the hook, which the adapter routes as spawn_agent
    // (owner decision 0a9dc8c); a namespace the user sets is not routed.
    const namespaced = (await k2({ namespace: 'collaboration' })).found;
    assert.deepEqual([namespaced.passed, namespaced.reasonCode], [true, null], namespaced.detail);
    assert.match(namespaced.detail, /on the collaborationspawn_agent call, ran the subagent on gpt-6-astra/);
    const custom = (await k2({ namespace: 'team' })).found;
    assert.equal(custom.reasonCode, 'SPAWN_HOOK_NAME_NAMESPACED');
    assert.match(custom.detail, /"teamspawn_agent"/);
    const v1 = (await k2({ namespace: 'multi_agent_v1' })).found;
    assert.deepEqual([v1.passed, v1.reasonCode], [true, null], 'a namespace whose hook name stays spawn_agent routes as a plain one');
    assert.equal(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8').catch(() => null), null, 'the profile config is restored (none before)');
  });
  assert.match(fileUrl(join(tmpdir(), 'x.mjs')), /^file:/);
});

test("hooks.route on Codex is certified only by a passing codex.subagent-route case, never by the hook smoke alone", async () => {
  const { routeGatedByStubCase, ROUTE_STUB_CASES } = await import('../dist/certification.js');
  assert.deepEqual(ROUTE_STUB_CASES, { codex: 'codex.subagent-route', kilocode: 'kilocode.subagent-route', opencode: 'opencode.subagent-route' });
  const smoke = [{ featureId: 'hooks.observe', passed: true, reasonCode: null, detail: 'ran' }, { featureId: 'hooks.route', passed: true, reasonCode: null, detail: 'routed input renders' }];
  const route = (features) => features.find((item) => item.featureId === 'hooks.route');
  assert.deepEqual([route(routeGatedByStubCase('codex', smoke, [])).passed, route(routeGatedByStubCase('codex', smoke, [])).reasonCode], [false, 'ROUTE_CASE_NOT_RUN']);
  const failed = route(routeGatedByStubCase('codex', smoke, [{ id: 'codex.subagent-route', passed: false, reasonCode: 'APPROVAL_NOT_ASKED', detail: '' }]));
  assert.deepEqual([failed.passed, failed.reasonCode, failed.detail], [false, 'ROUTE_CASE_FAILED', 'codex.subagent-route: APPROVAL_NOT_ASKED']);
  const passed = route(routeGatedByStubCase('codex', smoke, [{ id: 'codex.subagent-route', passed: true, reasonCode: null, detail: '' }]));
  assert.deepEqual([passed.passed, passed.reasonCode, passed.detail], [true, null, 'routed input renders; codex.subagent-route passed']);
  const unrun = [{ ...smoke[1], passed: false, reasonCode: 'HOOKS_NOT_RUNNING' }];
  assert.equal(route(routeGatedByStubCase('codex', unrun, [{ id: 'codex.subagent-route', passed: true, reasonCode: null, detail: '' }])).reasonCode, 'HOOKS_NOT_RUNNING', 'a passing case never lifts a failed smoke');
  assert.deepEqual(routeGatedByStubCase('claude', smoke, []), smoke, "Claude Code's route renders no decision and keeps its own proof");
  // Kilo and OpenCode (R20): the shim's model write is certified only by the harness's own subagent-route case.
  for (const harness of ['kilocode', 'opencode']) {
    assert.equal(route(routeGatedByStubCase(harness, smoke, [])).reasonCode, 'ROUTE_CASE_NOT_RUN');
    assert.equal(route(routeGatedByStubCase(harness, smoke, [{ id: `${harness}.subagent-route`, passed: false, reasonCode: 'ROUTE_IGNORED', detail: '' }])).detail, `${harness}.subagent-route: ROUTE_IGNORED`);
    assert.equal(route(routeGatedByStubCase(harness, smoke, [{ id: `${harness}.subagent-route`, passed: true, reasonCode: null, detail: '' }])).passed, true);
    assert.equal(route(routeGatedByStubCase(harness, smoke, [{ id: 'codex.subagent-route', passed: true, reasonCode: null, detail: '' }])).passed, false, "another harness's case never counts");
  }
});

test('session.route (OD-8) is present for Kilo and OpenCode only, and certified only with running hooks and a passing session-route case', async () => {
  const { sessionRouteChecks, SESSION_ROUTE_STUB_CASES } = await import('../dist/certification.js');
  assert.deepEqual(SESSION_ROUTE_STUB_CASES, { kilocode: 'kilocode.session-route', opencode: 'opencode.session-route' });
  const live = [{ featureId: 'plugin.install', passed: true, reasonCode: null, detail: '' }, { featureId: 'hooks.observe', passed: true, reasonCode: null, detail: '' }];
  for (const harness of ['claude', 'codex', 'antigravity']) assert.deepEqual(sessionRouteChecks(harness, live, [{ id: `${harness}.session-route`, passed: true, reasonCode: null, detail: '' }]), []);
  for (const harness of ['kilocode', 'opencode']) {
    const one = (features, cases) => {
      const out = sessionRouteChecks(harness, features, cases);
      assert.equal(out.length, 1);
      assert.equal(out[0].featureId, 'session.route');
      return [out[0].passed, out[0].reasonCode];
    };
    const id = `${harness}.session-route`;
    assert.deepEqual(one(live, [{ id, passed: true, reasonCode: null, detail: '' }]), [true, null]);
    assert.deepEqual(one(live, []), [false, 'SESSION_ROUTE_CASE_NOT_RUN']);
    assert.deepEqual(one(live, [{ id, passed: false, reasonCode: 'ROUTE_STUCK', detail: '' }]), [false, 'SESSION_ROUTE_CASE_FAILED']);
    assert.deepEqual(one([live[0], { ...live[1], passed: false }], [{ id, passed: true, reasonCode: null, detail: '' }]), [false, 'HOOKS_NOT_RUNNING'], 'a passing case never lifts hooks that did not run');
    assert.deepEqual(one([live[1]], [{ id, passed: true, reasonCode: null, detail: '' }]), [false, 'HOOKS_NOT_RUNNING']);
  }
});

test('models.list-hosts and route.host (R57) are Kilo and OpenCode only; route.host needs session.route in the same run and both host cases', async () => {
  const { hostChecks, HOST_STUB_CASES } = await import('../dist/certification.js');
  const pass = (id) => ({ id, passed: true, reasonCode: null, detail: '' });
  const fail = (id, reasonCode = 'ROUTE_IGNORED') => ({ id, passed: false, reasonCode, detail: '' });
  const session = (passed) => [{ featureId: 'session.route', passed, reasonCode: passed ? null : 'SESSION_ROUTE_CASE_FAILED', detail: '' }];
  for (const harness of ['claude', 'codex', 'antigravity']) assert.deepEqual(hostChecks(harness, session(true), [pass(`${harness}.session-route-host`)]), [], `${harness} records neither, like session.route`);
  for (const harness of ['kilocode', 'opencode']) {
    const ids = HOST_STUB_CASES[harness];
    assert.deepEqual(ids, { listing: `${harness}.models-list-hosts`, route: `${harness}.session-route-host`, redefined: `${harness}.session-route-host-redefined` });
    const run = (features, cases) => Object.fromEntries(hostChecks(harness, features, cases).map((item) => [item.featureId, [item.passed, item.reasonCode]]));
    const all = [pass(ids.listing), pass(ids.route), pass(ids.redefined)];
    assert.deepEqual(run(session(true), all), { 'models.list-hosts': [true, null], 'route.host': [true, null] });
    assert.deepEqual(run(session(false), all), { 'models.list-hosts': [true, null], 'route.host': [false, 'ROUTE_HOST_NEEDS_SESSION_ROUTE'] }, 'passing host cases never lift an uncertified session.route');
    assert.deepEqual(run([], all)['route.host'], [false, 'ROUTE_HOST_NEEDS_SESSION_ROUTE']);
    assert.deepEqual(run(session(true), []), { 'models.list-hosts': [false, 'MODELS_LIST_HOSTS_NOT_RUN'], 'route.host': [false, 'ROUTE_HOST_CASE_NOT_RUN'] }, 'a case that did not run is never a pass');
    assert.deepEqual(run(session(true), [pass(ids.route)])['route.host'], [false, 'ROUTE_HOST_CASE_NOT_RUN'], 'K14 alone is not enough');
    assert.deepEqual(run(session(true), [pass(ids.redefined)])['route.host'], [false, 'ROUTE_HOST_CASE_NOT_RUN'], 'K15 alone is not enough');
    assert.deepEqual(run(session(true), [pass(ids.route), fail(ids.redefined, 'ROUTE_NOT_REFUSED')])['route.host'], [false, 'ROUTE_HOST_CASE_FAILED']);
    assert.deepEqual(run(session(true), [fail(ids.route), pass(ids.redefined)])['route.host'], [false, 'ROUTE_HOST_CASE_FAILED']);
    assert.deepEqual(run(session(true), [fail(ids.listing, 'LISTING_SIDE_EFFECT'), pass(ids.route), pass(ids.redefined)]), { 'models.list-hosts': [false, 'MODELS_LIST_HOSTS_FAILED'], 'route.host': [true, null] }, 'the two features are independent');
    assert.deepEqual(run(session(true), [pass(`${harness === 'kilocode' ? 'opencode' : 'kilocode'}.session-route-host`), pass(`${harness === 'kilocode' ? 'opencode' : 'kilocode'}.session-route-host-redefined`)])['route.host'], [false, 'ROUTE_HOST_CASE_NOT_RUN'], "another harness's cases never count");
  }
});

test('the conformance exemption is only the exact OD-6 answer on a spawn_agent call that names no model or effort', async () => {
  const { od6RouteShape } = await import('../dist/conformance-run.js');
  const native = { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', tool_input: { message: 'm', task_name: 't' } };
  const answer = (input, extra = {}) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input, ...extra } });
  assert.equal(od6RouteShape('codex', native, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' })), true);
  assert.equal(od6RouteShape('claude', native, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' })), false, 'Codex only');
  assert.equal(od6RouteShape('codex', { ...native, tool_name: 'Bash' }, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' })), false, 'spawn_agent only');
  assert.equal(od6RouteShape('codex', native, answer({ message: 'changed', task_name: 't', model: 'gpt-6-astra' })), false, 'the input is kept key for key');
  assert.equal(od6RouteShape('codex', native, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra', reasoning_effort: 'high' })), false, 'nothing but model is added');
  assert.equal(od6RouteShape('codex', native, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' }, { additionalContext: 'x' })), false, 'no other output field');
  assert.equal(od6RouteShape('codex', native, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', updatedInput: { message: 'm', task_name: 't', model: 'x' } } })), false, 'allow only');
  for (const pin of ['model', 'reasoning_effort']) {
    const pinned = { ...native, tool_input: { ...native.tool_input, [pin]: 'x' } };
    assert.equal(od6RouteShape('codex', pinned, answer({ ...pinned.tool_input, model: 'gpt-6-astra' })), false, `a spawn naming ${pin} gets no decision`);
  }
  // Owner decision 0a9dc8c: Codex's default-namespace name is spawn_agent too; no other name is.
  const namespaced = { ...native, tool_name: 'collaborationspawn_agent' };
  assert.equal(od6RouteShape('codex', namespaced, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' })), true);
  assert.equal(od6RouteShape('codex', { ...native, tool_name: 'teamspawn_agent' }, answer({ message: 'm', task_name: 't', model: 'gpt-6-astra' })), false);
});

test("every adapter passes certify's own conformance cases on its recorded fixtures", async () => {
  // The owner's certify run of 2026-09-28 (after 62adf91) built a tree holding a new Codex fixture
  // without the conformance change that names it, and failed three cases. This keeps the adapter
  // fixtures and the certify cases in step.
  const { adapterCases } = await import('../dist/conformance-run.js');
  for (const harness of ['claude', 'codex', 'kilocode', 'opencode', 'antigravity']) {
    const failed = [...adapterCases(harness)].filter(([, reason]) => reason !== null);
    assert.deepEqual(failed, [], harness);
  }
});
