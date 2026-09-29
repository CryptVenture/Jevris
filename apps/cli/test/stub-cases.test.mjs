// R33 stub cases (stub-cases.ts): one real turn against the loopback stub provider, here driven
// by stand-in harnesses that do what the real binary would with A's stub profile: send the model
// request to the stub with the dummy key, start the hook, load the probe plugin. No real harness
// starts, and no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runStubCases, stubCaseLines, hookEntryStarted, fileUrl, STUB_CASE_MODELS, ROUTE_CASE_MODELS, UNROUTED_MARK, routeProbePlugin } = await import('../dist/stub-cases.js');

async function withProfile(fn) {
  const profile = await mkdtemp(join(tmpdir(), 'jevris-stub-cases-'));
  try {
    await mkdir(join(profile, '.codex'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: profile, CODEX_HOME: join(profile, '.codex'), JEVRIS_HOOK_OBSERVE_ONLY: '1', ANTHROPIC_API_KEY: 'sk-real-looking', OPENAI_API_KEY: 'sk-real-looking' };
    return await fn(profile, env);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function post(base, path, key, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  await response.text();
  return response.status;
}

/** A stand-in CLI: `behave(file, args, env, cwd)` plays the harness. */
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

test('claude.hook-spawn: a turn against the stub that starts the Jevris hook passes; the key and cloud variables are the stub\'s', async () => {
  await withProfile(async (profile, env) => {
    const hookEntry = join(profile, 'runtime', 'dist', 'hook.mjs');
    await mkdir(join(profile, 'runtime', 'dist'), { recursive: true });
    await writeFile(hookEntry, '');
    const seen = [];
    const fake = cli(async (_file, _args, runEnv) => {
      seen.push(runEnv);
      assert.equal(runEnv.ANTHROPIC_API_KEY, 'jevris-stub-key', 'the real key never reaches the run');
      execFileSync(process.execPath, [hookEntry], { env: runEnv });
      await post(runEnv.ANTHROPIC_BASE_URL, '/v1/messages', runEnv.ANTHROPIC_API_KEY, { model: 'claude-haiku-4-5', messages: [] });
    });
    const [result] = await runStubCases({ harness: 'claude', cli: fake.cli, env, profile, hookEntry, timeoutMs: 5000 });
    assert.deepEqual([result.id, result.passed, result.reasonCode], ['claude.hook-spawn', true, null], result.detail);
    assert.match(result.detail, /1 model request\(s\) reached the stub, none billed/);
    assert.match(seen[0].ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(fake.calls[0].args.slice(0, 2), ['-p', '--output-format']);
    assert.ok(fake.calls[0].args.includes('--no-session-persistence') && fake.calls[0].args.includes(STUB_CASE_MODELS.claude));
    assert.equal(fake.calls[0].cwd, join(profile, 'jevris-stub-case'), 'the turn runs in an empty folder in the profile');

    const noHook = cli(async (_file, _args, runEnv) => {
      await post(runEnv.ANTHROPIC_BASE_URL, '/v1/messages', runEnv.ANTHROPIC_API_KEY, { model: 'm', messages: [] });
    });
    const [missed] = await runStubCases({ harness: 'claude', cli: noHook.cli, env, profile: await mkdtemp(join(profile, 'p2-')), hookEntry, timeoutMs: 5000 });
    assert.deepEqual([missed.passed, missed.reasonCode], [false, 'HOOK_NOT_SPAWNED']);

    const wrongKey = cli(async (_file, _args, runEnv) => {
      execFileSync(process.execPath, [hookEntry], { env: runEnv });
      await post(runEnv.ANTHROPIC_BASE_URL, '/v1/messages', 'oauth-bearer-from-keychain', { model: 'm', messages: [] });
    });
    const [refused] = await runStubCases({ harness: 'claude', cli: wrongKey.cli, env, profile: await mkdtemp(join(profile, 'p3-')), hookEntry, timeoutMs: 5000 });
    assert.deepEqual([refused.passed, refused.reasonCode], [false, 'STUB_KEY_REFUSED']);

    const nothing = cli(async () => {});
    const [absent] = await runStubCases({ harness: 'claude', cli: nothing.cli, env, profile: await mkdtemp(join(profile, 'p4-')), hookEntry, timeoutMs: 5000 });
    assert.equal(absent.reasonCode, 'HOOK_NOT_SPAWNED');
    assert.match(absent.detail, /no model request reached the stub/);
    const [noEntry] = await runStubCases({ harness: 'claude', cli: nothing.cli, env, profile, hookEntry: null });
    assert.equal(noEntry.reasonCode, 'NO_HOOK_ENTRY');
  });
});

for (const harness of ['opencode', 'kilocode']) {
  test(`${harness}.system-transform: the probe plugin's system text reaches the stub; a harness that ignores it fails`, async () => {
    await withProfile(async (profile, env) => {
      const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
      const play = (honours) =>
        cli(async (_file, args, runEnv) => {
          assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
          const config = JSON.parse(runEnv[key]);
          const system = ['vendor prompt'];
          const probe = await (await import(config.plugin[0])).JevrisStubProbe({});
          if (probe['experimental.chat.system.transform'] === undefined) return;
          if (honours) {
            const plugin = await import(config.plugin[0]);
            const hooks = await plugin.JevrisStubProbe({});
            await hooks['experimental.chat.system.transform']({ sessionID: 's', model: {} }, { system });
          }
          const provider = config.provider.anthropic.options;
          assert.equal(config.model, `anthropic/${STUB_CASE_MODELS[harness]}`);
          await post(provider.baseURL.replace(/\/v1$/, ''), '/v1/messages', provider.apiKey, { model: config.model.split('/')[1], system: system.join('\n'), messages: [] });
        });
      const passed = (await runStubCases({ harness, cli: play(true).cli, env, profile, hookEntry: null, timeoutMs: 5000 })).find((item) => item.id === `${harness}.system-transform`);
      assert.deepEqual([passed.id, passed.passed], [`${harness}.system-transform`, true], passed.detail);
      const ignored = (await runStubCases({ harness, cli: play(false).cli, env, profile, hookEntry: null, timeoutMs: 5000 })).find((item) => item.id === `${harness}.system-transform`);
      assert.deepEqual([ignored.passed, ignored.reasonCode], [false, 'SYSTEM_TEXT_MISSING']);
    });
  });
}

test('codex.store: the Responses request reaches the stub through the profile config, which is restored afterwards', async () => {
  await withProfile(async (profile, env) => {
    const configPath = join(env.CODEX_HOME, 'config.toml');
    await writeFile(configPath, '[hooks]\nx = 1\n');
    const fake = cli(async (_file, args, runEnv) => {
      assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
      const toml = await readFile(configPath, 'utf8');
      assert.match(toml, /model_provider = "stub"/);
      assert.match(toml, /\[hooks\]/, 'install\'s hooks stay');
      const base = /base_url = "([^"]+)"/.exec(toml)[1];
      await post(base.replace(/\/v1$/, ''), '/v1/responses', runEnv.JEVRIS_STUB_KEY, { model: 'gpt-5.5', store: false, input: [] });
    });
    const [result] = await runStubCases({ harness: 'codex', cli: fake.cli, env, profile, hookEntry: null, timeoutMs: 5000 });
    assert.deepEqual([result.id, result.passed, result.detail], ['codex.store', true, 'the Responses request sends store: false']);
    assert.equal(await readFile(configPath, 'utf8'), '[hooks]\nx = 1\n');
  });
});

test('stub cases: Antigravity has none (owner-run); lines, file URLs and the hook-start reader', async () => {
  await withProfile(async (profile, env) => {
    assert.deepEqual(await runStubCases({ harness: 'antigravity', cli: cli(async () => {}).cli, env, profile, hookEntry: null }), []);
    const marker = join(profile, 'm.jsonl');
    await writeFile(marker, `torn\n${JSON.stringify({ argv: [process.execPath, join(profile, 'other.mjs')] })}\n`);
    assert.equal(await hookEntryStarted(marker, join(profile, 'hook.mjs')), false);
    assert.equal(await hookEntryStarted(join(profile, 'none'), 'x'), false);
  });
  assert.deepEqual(stubCaseLines([{ id: 'a.b', passed: false, reasonCode: 'X', detail: 'd' }, { id: 'c.d', passed: true, reasonCode: null, detail: 'e' }]), ['stub case a.b: fail (X); d', 'stub case c.d: pass; e']);
  const url = fileUrl(join(tmpdir(), 'a b', 'p.mjs'));
  assert.match(url, /^file:\/\/\/.*a%20b\/p\.mjs$/);
});

test('claude.subagent-route (K1): the probe hook\'s updatedInput.model reaches the subagent request; a harness that ignores it fails', async () => {
  await withProfile(async (profile, env) => {
    const play = (honours) =>
      cli(async (_file, args, runEnv) => {
        if (!args.includes('--settings')) return;
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        const command = settings.hooks.PreToolUse[0].hooks[0].command;
        const [node, probe] = JSON.parse(`[${command.replace('" "', '","')}]`);
        const base = runEnv.ANTHROPIC_BASE_URL;
        const main = args[args.indexOf('--model') + 1];
        const first = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': runEnv.ANTHROPIC_API_KEY }, body: JSON.stringify({ model: main, stream: false, messages: [], tools: [{ name: 'Agent' }] }) });
        const reply = await first.json();
        const call = reply.content[0];
        assert.equal(call.name, 'Agent');
        const out = execFileSync(node, [probe], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: call.input }) }).toString();
        const routed = JSON.parse(out).hookSpecificOutput.updatedInput;
        assert.equal(routed.subagent_type, 'general-purpose', 'the rest of the input is kept');
        assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, undefined, 'no permission decision');
        const model = honours && routed.model === 'haiku' ? 'claude-haiku-4-5-20251001' : main;
        const second = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': runEnv.ANTHROPIC_API_KEY }, body: JSON.stringify({ model, stream: false, messages: [] }) });
        await second.text();
      });
    const results = await runStubCases({ harness: 'claude', cli: play(true).cli, env, profile, hookEntry: null, timeoutMs: 5000 });
    const k1 = results.find((item) => item.id === 'claude.subagent-route');
    assert.deepEqual([k1.passed, k1.reasonCode], [true, null], k1.detail);
    assert.match(k1.detail, /asked for claude-haiku-4-5-20251001 while the session ran claude-opus-5-5/);
    const ignored = (await runStubCases({ harness: 'claude', cli: play(false).cli, env, profile, hookEntry: null, timeoutMs: 5000 })).find((item) => item.id === 'claude.subagent-route');
    assert.deepEqual([ignored.passed, ignored.reasonCode], [false, 'ROUTE_IGNORED']);
    const silent = (await runStubCases({ harness: 'claude', cli: cli(async () => {}).cli, env, profile, hookEntry: null, timeoutMs: 5000 })).find((item) => item.id === 'claude.subagent-route');
    assert.equal(silent.reasonCode, 'STUB_NOT_REACHED');
  });
});

/**
 * Plays OpenCode or Kilo against the stub with the probe plugin: `honours` says whether the model
 * the plugin sets is used; `sticky` plays a harness whose routed model outlives its turn, so a
 * `run --continue` turn still runs on it. `runs` records each run's argv.
 */
function playRoute(harness, honours, { sticky = false, runs = [] } = {}) {
  const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
  return cli(async (_file, args, runEnv) => {
    const config = JSON.parse(runEnv[key]);
    const probe = await (await import(config.plugin[0])).JevrisStubProbe({});
    if (probe['experimental.chat.system.transform'] !== undefined) return;
    runs.push(args);
    const provider = config.provider.anthropic.options;
    const base = provider.baseURL.replace(/\/v1$/, '');
    const configured = config.model.split('/')[1];
    const ask = async (model) => (await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': provider.apiKey }, body: JSON.stringify({ model, stream: false, messages: [], tools: [{ name: 'task' }, { name: 'bash' }] }) })).json();
    if (args.includes('--continue')) {
      const next = { message: { model: { providerID: 'anthropic', modelID: configured } }, parts: [{ type: 'text', text: args.at(-1) }] };
      await probe['chat.message']({ sessionID: 'ses_main' }, next);
      await ask(sticky ? ROUTE_CASE_MODELS.routed : honours ? next.message.model.modelID : configured);
      return;
    }
    // A title request offers no tools, and the case ignores it.
    await (await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': provider.apiKey }, body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }) })).text();
    const mainOut = { message: { model: { providerID: 'anthropic', modelID: configured } }, parts: [{ type: 'text', text: args.at(-1) }] };
    await probe['chat.message']({ sessionID: 'ses_main' }, mainOut);
    const reply = await ask(honours ? mainOut.message.model.modelID : configured);
    if (reply.content[0].type !== 'tool_use') return;
    // Both harnesses (Kilo's task tool ignores a model argument): the child session's first message.
    assert.equal(probe['tool.execute.before'], undefined, 'the probe never writes task arguments');
    let child = configured;
    await probe.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_main' } } } });
    const childOut = { message: { model: { providerID: 'anthropic', modelID: configured } }, parts: [] };
    await probe['chat.message']({ sessionID: 'ses_child' }, childOut);
    if (honours) child = childOut.message.model.modelID;
    await ask(child);
    await ask(configured);
  });
}

for (const harness of ['opencode', 'kilocode']) {
  test(`${harness}.session-route and ${harness}.subagent-route: the probe's model runs the turn or the subagent; ignored, each fails`, async () => {
    await withProfile(async (profile, env) => {
      const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));
      const good = byId(await runStubCases({ harness, cli: playRoute(harness, true).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(good[`${harness}.subagent-route`].passed, true, good[`${harness}.subagent-route`].detail);
      assert.match(good[`${harness}.subagent-route`].detail, /the parent kept its model/);
      const bad = byId(await runStubCases({ harness, cli: playRoute(harness, false).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(bad[`${harness}.session-route`].reasonCode, 'ROUTE_IGNORED');
      assert.equal(bad[`${harness}.subagent-route`].reasonCode, 'ROUTE_IGNORED');
    });
  });
}

test('session-route: the routed turn runs on the probe model and the next unrouted turn on the session model; a switch that sticks fails', async () => {
  await withProfile(async (profile, env) => {
    const runs = [];
    const [, session] = await runStubCases({ harness: 'opencode', cli: playRoute('opencode', true, { runs }).cli, env, profile, hookEntry: null, timeoutMs: 5000 });
    assert.equal(session.id, 'opencode.session-route');
    // In main mode the probe also routed the parent, so the case sees its first agent request on the routed model.
    assert.deepEqual([session.passed, session.reasonCode], [true, null], session.detail);
    assert.match(session.detail, new RegExp(`${ROUTE_CASE_MODELS.routed} instead of the configured ${ROUTE_CASE_MODELS.session}, and the next unrouted turn ran on ${ROUTE_CASE_MODELS.session}`));
    const second = runs.find((args) => args.includes('--continue'));
    assert.ok(second !== undefined, 'the case runs a second turn in the same session');
    assert.equal(second.includes('--model'), false, 'the second turn names no model: it runs on what the session stored');
    assert.equal(second.at(-1).includes(UNROUTED_MARK), true);
    for (const harness of ['opencode', 'kilocode']) {
      const stuck = (await runStubCases({ harness, cli: playRoute(harness, true, { sticky: true }).cli, env, profile, hookEntry: null, timeoutMs: 5000 })).find((item) => item.id === `${harness}.session-route`);
      assert.deepEqual([stuck.passed, stuck.reasonCode], [false, 'ROUTE_STUCK'], stuck.detail);
    }
  });
  const dir = await mkdtemp(join(tmpdir(), 'jevris-probe-'));
  try {
    const file = join(dir, 'p.mjs');
    await writeFile(file, routeProbePlugin('main'));
    const probe = await (await import(fileUrl(file))).JevrisStubProbe({});
    await probe.event({ event: { type: 'session.created', properties: { info: { id: 'c', parentID: 'p' } } } });
    const out = { message: { model: { providerID: 'anthropic', modelID: 'x' } } };
    await probe['chat.message']({ sessionID: 'c' }, out);
    assert.equal(out.message.model.modelID, 'x', 'a child is not routed in main mode');
    const unrouted = { message: { model: { providerID: 'anthropic', modelID: 'x' } }, parts: [{ type: 'text', text: `ok ${UNROUTED_MARK}` }] };
    await probe['chat.message']({ sessionID: 'p' }, unrouted);
    assert.equal(unrouted.message.model.modelID, 'x', 'a message that carries the unrouted mark is left alone');
    await probe['chat.message']({ sessionID: 'p' }, out);
    assert.equal(out.message.model.modelID, ROUTE_CASE_MODELS.routed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Serving hosts R57 part 2: K13 (<h>.models-list-hosts), K14 (<h>.session-route-host) and K15
// (<h>.session-route-host-redefined), played by a stand-in harness against the stub.
const { HOST_CASE, HOST_CASE_PATHS, K13_LINES, hostRouteProbePlugin, guardAllowsAt, k13Registry, k13Verdict } = await import('../dist/stub-cases.js');

/**
 * Plays OpenCode or Kilo for the host cases. `models` prints each configured provider's models as
 * `<provider>/<model>` lines. A turn loads the probe with the run's folder as its directory and
 * worktree, lets it set the model, and posts to the provider that model names: the project
 * config's when `honoursProject` and one is in the folder, else the inline config's.
 */
function playHost(harness, { honours = true, honoursProject = true, sticky = false, leave = false, listing = null } = {}) {
  const key = harness === 'kilocode' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
  const calls = [];
  return {
    calls,
    cli: {
      available: () => true,
      run: async (_file, args, _timeout, env, options) => {
        const cwd = options?.cwd ?? null;
        calls.push({ args: [...args], cwd, env });
        const config = JSON.parse(env[key]);
        if (args[0] === 'models') {
          const lines = listing ?? Object.entries(config.provider).flatMap(([provider, entry]) => Object.keys(entry.models ?? {}).map((model) => `${provider}/${model}`));
          return { spawned: true, code: 0, stdout: `${lines.join('\n')}\n` };
        }
        const probe = await (await import(config.plugin[0])).JevrisStubProbe({ directory: cwd, worktree: cwd });
        if (probe['experimental.chat.system.transform'] !== undefined) return { spawned: true, code: 0, stdout: '' };
        const [providerID, ...rest] = config.model.split('/');
        const out = { message: { model: { providerID, modelID: rest.join('/') } }, parts: [{ type: 'text', text: args.at(-1) }] };
        await probe['chat.message']({ sessionID: 'ses_main' }, out);
        let project = null;
        try {
          project = JSON.parse(await readFile(join(cwd, harness === 'kilocode' ? 'kilo.jsonc' : 'opencode.jsonc'), 'utf8'));
        } catch {}
        const entry = (honoursProject ? project?.provider?.[out.message.model.providerID] : undefined) ?? config.provider[out.message.model.providerID];
        if (entry === undefined) return { spawned: true, code: 0, stdout: '' };
        const routed = out.message.model.modelID;
        const model = args.includes('--continue') ? (sticky ? HOST_CASE.routed : rest.join('/')) : honours ? routed : rest.join('/');
        const base = leave ? config.provider.anthropic.options.baseURL : entry.options.baseURL;
        const path = leave ? '/messages' : '/chat/completions';
        await (await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${entry.options.apiKey}`, 'x-api-key': entry.options.apiKey }, body: JSON.stringify({ model, stream: false, messages: [], tools: [{ type: 'function', function: { name: 'bash' } }, { name: 'bash' }] }) })).text();
        return { spawned: true, code: 0, stdout: '' };
      },
    },
  };
}

for (const harness of ['opencode', 'kilocode']) {
  test(`${harness} host cases (R57): K14 keeps the host and the nested id, K15's guard refuses a redefined host, K13 keeps the gateway line`, async () => {
    await withProfile(async (profile, env) => {
      const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));
      const fake = playHost(harness);
      const good = byId(await runStubCases({ harness, cli: fake.cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      const k13 = good[`${harness}.models-list-hosts`];
      const k14 = good[`${harness}.session-route-host`];
      const k15 = good[`${harness}.session-route-host-redefined`];
      assert.deepEqual([k13.passed, k13.reasonCode], [true, null], k13.detail);
      assert.match(k13.detail, new RegExp(`${HOST_CASE.provider}/${HOST_CASE.session} \\(${HOST_CASE.provider}\\)`));
      assert.doesNotMatch(k13.detail, /:free|\/~/);
      assert.deepEqual([k14.passed, k14.reasonCode], [true, null], k14.detail);
      assert.deepEqual([k15.passed, k15.reasonCode], [true, null], k15.detail);
      assert.match(k15.detail, /so the redefinition is live on this binary/);
      const listed = fake.calls.find((call) => call.args[0] === 'models');
      assert.equal(listed.env[harness === 'kilocode' ? 'KILO_DISABLE_AUTOUPDATE' : 'OPENCODE_DISABLE_AUTOUPDATE'], '1', 'the listing runs with the no-update variable');
      const [redefinedRun] = fake.calls.filter((call) => call.cwd?.endsWith('host-redefined'));
      assert.ok(redefinedRun !== undefined, 'K15 runs in a folder of its own');
      assert.equal(fake.calls.some((call) => call.cwd === join(profile, 'jevris-stub-case', 'host')), true, 'K14 runs in a folder of its own too');

      const ignored = byId(await runStubCases({ harness, cli: playHost(harness, { honours: false }).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(ignored[`${harness}.session-route-host`].reasonCode, 'ROUTE_IGNORED');
      const stuck = byId(await runStubCases({ harness, cli: playHost(harness, { sticky: true }).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(stuck[`${harness}.session-route-host`].reasonCode, 'ROUTE_STUCK');
      const left = byId(await runStubCases({ harness, cli: playHost(harness, { leave: true }).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(left[`${harness}.session-route-host`].reasonCode, 'ROUTE_LEFT_HOST');
      const notHonoured = byId(await runStubCases({ harness, cli: playHost(harness, { honoursProject: false }).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(notHonoured[`${harness}.session-route-host-redefined`].passed, true, 'the guard refuses whether or not the binary honoured the project provider');
      assert.doesNotMatch(notHonoured[`${harness}.session-route-host-redefined`].detail, /live on this binary/);
      const freeOnly = byId(await runStubCases({ harness, cli: playHost(harness, { listing: ['openrouter/moonshotai/kimi-k3:free', 'anthropic/claude-haiku-4-5'] }).cli, env, profile, hookEntry: null, timeoutMs: 5000 }));
      assert.equal(freeOnly[`${harness}.models-list-hosts`].reasonCode, 'HOST_LINE_NOT_KEPT');
    });
  });
}

test('host cases (R57): the guard reads the roots the probe recorded; K13 verdicts and registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-host-probe-'));
  try {
    const roots = join(dir, 'roots.json');
    const file = join(dir, 'p.mjs');
    await writeFile(file, hostRouteProbePlugin(roots));
    const probe = await (await import(fileUrl(file))).JevrisStubProbe({ directory: dir, worktree: dir });
    const out = { message: { model: { providerID: HOST_CASE.provider, modelID: HOST_CASE.session } }, parts: [{ type: 'text', text: 'go' }] };
    await probe['chat.message']({ sessionID: 's' }, out);
    assert.deepEqual(out.message.model, { providerID: HOST_CASE.provider, modelID: HOST_CASE.routed });
    const next = { message: { model: { providerID: HOST_CASE.provider, modelID: HOST_CASE.session } }, parts: [{ type: 'text', text: UNROUTED_MARK }] };
    await probe['chat.message']({ sessionID: 's' }, next);
    assert.equal(next.message.model.modelID, HOST_CASE.session, 'the marked turn is left alone');
    assert.deepEqual(JSON.parse(await readFile(roots, 'utf8')), { directory: dir, worktree: dir });
    for (const harness of ['opencode', 'kilocode']) assert.equal(await guardAllowsAt(harness, roots, dir, HOST_CASE.provider), true, harness);
    // LOW 23: a reported worktree of "/" does not make the guard climb above the case folder.
    const inner = join(dir, 'case');
    await mkdir(inner, { recursive: true });
    const innerRoots = join(inner, 'roots.json');
    await writeFile(innerRoots, JSON.stringify({ directory: inner, worktree: '/' }));
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ provider: { [HOST_CASE.provider]: {} } }));
    for (const harness of ['opencode', 'kilocode']) assert.equal(await guardAllowsAt(harness, innerRoots, inner, HOST_CASE.provider), true, `${harness}: a config above the case folder is never read`);
    for (const harness of ['opencode', 'kilocode']) assert.equal(await guardAllowsAt(harness, roots, dir, HOST_CASE.provider), false, `${harness}: a project config that redefines the host refuses`);
    assert.equal(await guardAllowsAt('opencode', roots, inner, HOST_CASE.provider), 'outside', 'a directory outside the case folder is refused');
    assert.equal(await guardAllowsAt('opencode', join(dir, 'none.json'), dir, HOST_CASE.provider), 'unrecorded');
    await writeFile(join(dir, 'big.json'), JSON.stringify({ directory: dir, pad: 'x'.repeat(5000) }));
    assert.equal(await guardAllowsAt('opencode', join(dir, 'big.json'), dir, HOST_CASE.provider), 'unrecorded', 'over 4 KiB');
    await writeFile(join(dir, 'rel.json'), JSON.stringify({ directory: 'case' }));
    assert.equal(await guardAllowsAt('opencode', join(dir, 'rel.json'), dir, HOST_CASE.provider), 'unrecorded', 'a relative directory');
    assert.equal(await guardAllowsAt('opencode', inner, dir, HOST_CASE.provider), 'unrecorded', 'not a regular file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(k13Verdict('x', 'opencode', { spawned: false, code: 1, stdout: '' }).reasonCode, 'HARNESS_NOT_STARTED');
  assert.equal(k13Verdict('x', 'opencode', { spawned: true, code: 2, stdout: '' }).reasonCode, 'LISTING_FAILED');
  assert.equal(k13Verdict('x', 'opencode', { spawned: true, code: 0, stdout: 'Available models:\n' }).reasonCode, 'LISTING_MALFORMED');
  const lines = Object.entries(K13_LINES.kilocode).flatMap(([provider, models]) => models.map((model) => `${provider}/${model}`));
  const kilo = k13Verdict('x', 'kilocode', { spawned: true, code: 0, stdout: lines.join('\n') });
  assert.equal(kilo.passed, true, kilo.detail);
  assert.match(kilo.detail, /kilo\/z-ai\/glm-5\.3 \(kilo\)/);
  assert.match(kilo.detail, /nvidia\/moonshotai\/kimi-k3 \(nvidia\)/, 'the NVIDIA line is kept as evidence');
  assert.match(kilo.detail, /kilo\/moonshotai\/kimi-k3 \(kilo\)/);
  const { k13Expected } = await import('../dist/stub-cases.js');
  assert.deepEqual(k13Expected('opencode').map((item) => item.raw), ['openrouter/moonshotai/kimi-k3', 'nvidia/moonshotai/kimi-k3']);
  assert.deepEqual(k13Expected('kilocode').map((item) => `${item.raw}@${item.servingHost}`), ['openrouter/moonshotai/kimi-k3@openrouter', 'kilo/moonshotai/kimi-k3@kilo', 'kilo/z-ai/glm-5.3@kilo', 'nvidia/moonshotai/kimi-k3@nvidia']);
  for (const harness of ['opencode', 'kilocode']) {
    const all = Object.entries(K13_LINES[harness]).flatMap(([provider, models]) => models.map((model) => `${provider}/${model}`));
    const noNvidia = k13Verdict('x', harness, { spawned: true, code: 0, stdout: all.filter((line) => !line.startsWith('nvidia/')).join('\n') });
    assert.deepEqual([noNvidia.reasonCode, /nvidia\/moonshotai\/kimi-k3 on nvidia/.test(noNvidia.detail)], ['HOST_LINE_NOT_KEPT', true], `${harness}: a listing that lacks the NVIDIA line fails and names it`);
  }
  const noKilo = k13Verdict('x', 'kilocode', { spawned: true, code: 0, stdout: lines.filter((line) => line !== 'kilo/z-ai/glm-5.3').join('\n') });
  assert.match(noKilo.detail, /kilo\/z-ai\/glm-5\.3 on kilo/);
  const { validateModelRegistry } = await import('@jevris/core');
  assert.equal(validateModelRegistry(k13Registry()).ok, true, 'the K13 registry is a valid registry');
  assert.deepEqual(HOST_CASE_PATHS, { global: 'openrouter', project: 'project-openrouter' });
});
