// R20, OD-8 and B's security review (MEDIUM 10, LOW 12): the Kilo and OpenCode route half of the
// shared adapter core (src/common.ts, byte-identical in all five packages), from every package's
// own build. A route writes only a model: a Kilo task call's model, provider and variant, an
// OpenCode child session's first message, or a top-level turn's message. Anything in doubt
// writes nothing. No real harness runs here, and no launcher is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const PACKAGES = ['adapter-claude-code', 'adapter-codex', 'adapter-kilocode', 'adapter-opencode', 'adapter-antigravity'];
const cores = await Promise.all(PACKAGES.map(async (name) => ({ name, core: await import(pathToFileURL(join(root, name, 'dist', 'common.js')).href) })));
const { RouteTurnPayloadContract } = await import(pathToFileURL(join(root, 'contracts', 'dist', 'index.js')).href);

const HAIKU = { providerID: 'anthropic', modelID: 'claude-haiku-4-5', variant: null };
const OPUS = { providerID: 'anthropic', modelID: 'claude-opus-5-5' };

/** An actuating route.turn answer (E's RouteTurnPayloadContract). */
function switchPayload(harness, extra = {}) {
  return {
    harness,
    mainSession: { mode: 'plugin-bounded-auto', switched: true },
    outcome: 'switch',
    actuate: true,
    reasonCode: 'PROMOTED_SAVING',
    text: 'Jevris: this turn runs on a cheaper model.',
    model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
    ...extra,
  };
}

/** The shim's native form of a task call before it runs. */
function taskNative(args, tool = 'task') {
  return { hookKey: 'tool.execute.before', input: { tool, sessionID: 'ses_top', callID: 'call_1' }, output: { args } };
}

/** An in-memory filesystem for projectConfigGuard: `files` maps a posix path to text, `links` to a target. */
function memoryHost({ files = {}, links = {}, dirs = [], fail = {}, big = [] } = {}) {
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const resolveLink = (path) => links[path] ?? path;
  const stat = (path) => {
    if (fail[path] !== undefined) throw Object.assign(new Error('denied'), { code: fail[path] });
    const isDir = dirs.includes(path);
    if (!isDir && files[path] === undefined) throw missing();
    return { isFile: () => !isDir, isSymbolicLink: () => false, size: big.includes(path) ? 300_000 : (files[path] ?? '').length };
  };
  return {
    fs: {
      async lstat(path) {
        if (links[path] !== undefined) return { isFile: () => false, isSymbolicLink: () => true, size: 0 };
        return stat(path);
      },
      async stat(path) {
        return stat(resolveLink(path));
      },
      async realpath(path) {
        return resolveLink(path);
      },
      async readFile(path) {
        const text = files[resolveLink(path)];
        if (text === undefined) throw missing();
        return text;
      },
    },
    path: posix,
  };
}

for (const { name, core } of cores) {
  test(`${name}: a route names a provider and model split on the first slash, with an optional variant`, () => {
    assert.deepEqual(core.pluginRouteOf('anthropic/claude-haiku-4-5', undefined), HAIKU);
    assert.deepEqual(core.pluginRouteOf('anthropic/claude-haiku-4-5', 'low'), { ...HAIKU, variant: 'low' });
    assert.deepEqual(core.pluginRouteOf('openrouter/anthropic/claude-haiku-4-5', null), { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-4-5', variant: null });
    for (const bad of ['claude-haiku-4-5', '/claude', 'Anthropic/claude', 'anthropic/', 'a/b/c/d', 'anthropic/claude haiku', 7]) assert.equal(core.pluginRouteOf(bad, null), null, String(bad));
    assert.equal(core.pluginRouteOf('anthropic/claude-haiku-4-5', 'High'), null);
    assert.equal(core.pluginRouteOf('anthropic/claude-haiku-4-5', 3), null);
  });

  test(`${name}: a task route renders {"route"} only for an unpinned task call before it runs`, () => {
    const route = { kind: 'route', model: 'anthropic/claude-haiku-4-5', variant: 'low' };
    const eventOf = (native) => core.pluginEvent('kilocode', native, native.hookKey).event;
    const native = taskNative({ description: 'd', prompt: 'p', subagent_type: 'explore' });
    assert.deepEqual(JSON.parse(core.pluginResponse(eventOf(native), route, native)), { route: { ...HAIKU, variant: 'low' } });
    assert.equal(core.pluginResponse(eventOf(native), route), '', 'no native input: no route');
    assert.equal(core.pluginResponse(null, route, native), '');
    for (const pin of ['model', 'provider', 'variant']) {
      const pinned = taskNative({ prompt: 'p', [pin]: 'x' });
      assert.equal(core.pluginResponse(eventOf(pinned), route, pinned), '', `a task call naming ${pin} is a pin`);
    }
    const bash = taskNative({ command: 'ls' }, 'bash');
    assert.equal(core.pluginResponse(eventOf(bash), route, bash), '', 'only the task tool');
    assert.equal(core.pluginResponse(eventOf(native), route, { ...native, hookKey: 'tool.execute.after' }), '');
    assert.equal(core.pluginResponse(eventOf(native), route, { ...native, output: 'x' }), '');
    assert.equal(core.pluginResponse(eventOf(native), route, { ...native, output: { args: 'x' } }), '');
    assert.equal(core.pluginResponse(eventOf(native), route, { ...native, input: { ...native.input, tool: 'bash' } }), '');
    assert.equal(core.pluginResponse(eventOf(native), route, 'text'), '');
    assert.equal(core.pluginResponse(eventOf(native), { kind: 'route', model: 'claude-haiku-4-5' }, native), '', 'a model with no provider is not a Kilo or OpenCode route');
    const message = core.pluginEvent('opencode', { hookKey: 'chat.message', input: { sessionID: 's' }, output: {} }, 'chat.message').event;
    assert.equal(core.pluginResponse(message, route, native), '', 'a route is only ever rendered on the task call');
  });

  test(`${name}: the shim re-checks a task route answer before it writes it`, () => {
    assert.deepEqual(core.routeResponseOf(JSON.stringify({ route: HAIKU })), HAIKU);
    assert.deepEqual(core.routeResponseOf(JSON.stringify({ route: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } })), HAIKU);
    assert.deepEqual(core.routeResponseOf(JSON.stringify({ route: { ...HAIKU, variant: 'low' } })), { ...HAIKU, variant: 'low' });
    for (const bad of [
      '',
      'not json',
      JSON.stringify({ route: HAIKU, system: ['x'] }),
      JSON.stringify({ route: { ...HAIKU, baseURL: 'x' } }),
      JSON.stringify({ route: { ...HAIKU, providerID: 'Anthropic' } }),
      JSON.stringify({ route: { ...HAIKU, modelID: 'a b' } }),
      JSON.stringify({ route: { ...HAIKU, variant: 'High' } }),
      JSON.stringify({ route: 'anthropic/claude' }),
      JSON.stringify([HAIKU]),
      `{"route":${JSON.stringify(HAIKU)},"__proto__":{"x":1}}`,
      JSON.stringify({ route: { ...HAIKU, pad: 'x'.repeat(70_000) } }),
    ]) {
      assert.equal(core.routeResponseOf(bad), null, bad.slice(0, 60));
    }
  });

  test(`${name}: the shim's turn check agrees with RouteTurnPayloadContract and returns a switch only when it actuates`, () => {
    for (const harness of ['kilocode', 'opencode']) {
      assert.deepEqual(core.turnPayloadRoute(harness, switchPayload(harness)), HAIKU);
      assert.deepEqual(core.turnPayloadRoute(harness, switchPayload(harness, { variant: 'low' })), { ...HAIKU, variant: 'low' });
    }
    assert.equal(core.turnPayloadRoute('claude', switchPayload('claude')), null, 'Kilo and OpenCode only');
    assert.equal(core.turnPayloadRoute('kilocode', switchPayload('opencode')), null, "another harness's answer");
    const advice = { harness: 'kilocode', mainSession: { mode: 'advice-only', switched: false }, outcome: 'switch', actuate: false, reasonCode: 'PROMOTED_SAVING', text: 'Advice.', model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } };
    const abstain = { harness: 'kilocode', mainSession: { mode: 'plugin-bounded-auto', switched: false }, outcome: 'abstain', actuate: false, reasonCode: 'UNKNOWN_SESSION', text: 'No route.' };
    // Every candidate: the contract and the shim agree on what is valid, and only a valid actuating switch writes.
    const candidates = [
      switchPayload('kilocode'),
      switchPayload('opencode', { variant: 'low' }),
      switchPayload('kilocode', { variant: null }),
      advice,
      abstain,
      { ...abstain, variant: null },
      { ...abstain, model: { providerID: 'anthropic', modelID: 'x' } },
      { ...abstain, variant: 'low' },
      switchPayload('kilocode', { mainSession: { mode: 'plugin-bounded-auto', switched: false } }),
      switchPayload('kilocode', { mainSession: { mode: 'advice-only', switched: true } }),
      switchPayload('kilocode', { mainSession: { mode: 'owned-sdk-approved', switched: true } }),
      switchPayload('kilocode', { mainSession: { mode: 'plugin-bounded-auto', switched: true, extra: 1 } }),
      switchPayload('kilocode', { mainSession: { mode: 'auto', switched: true } }),
      switchPayload('kilocode', { mainSession: 'auto' }),
      switchPayload('kilocode', { outcome: 'abstain' }),
      switchPayload('kilocode', { outcome: 'maybe' }),
      switchPayload('kilocode', { actuate: 'yes' }),
      switchPayload('kilocode', { model: undefined }),
      switchPayload('kilocode', { model: { providerID: 'anthropic' } }),
      switchPayload('kilocode', { model: { providerID: 'anthropic', modelID: 'claude', baseURL: 'x' } }),
      switchPayload('kilocode', { model: { providerID: 'Anthropic', modelID: 'claude' } }),
      switchPayload('kilocode', { model: { providerID: 'anthropic', modelID: 'a b' } }),
      switchPayload('kilocode', { model: 'anthropic/claude' }),
      switchPayload('kilocode', { variant: 'High' }),
      switchPayload('kilocode', { variant: 3 }),
      switchPayload('kilocode', { reasonCode: 'lower' }),
      switchPayload('kilocode', { reasonCode: 7 }),
      switchPayload('kilocode', { text: '' }),
      switchPayload('kilocode', { text: 'x'.repeat(501) }),
      switchPayload('kilocode', { text: 9 }),
      switchPayload('kilocode', { extra: true }),
      switchPayload('kilocode', { harness: 'claude' }),
      null,
      'switch',
    ];
    for (const payload of candidates) {
      const cleaned = payload !== null && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : payload;
      const shim = core.turnPayloadRoute('kilocode', cleaned) ?? core.turnPayloadRoute('opencode', cleaned);
      const checked = RouteTurnPayloadContract.validate(cleaned);
      if (shim !== null) assert.equal(checked.ok, true, `the shim writes only what the contract accepts: ${JSON.stringify(cleaned)}`);
      if (checked.ok && cleaned.actuate === true) assert.notEqual(shim, null, `a valid actuating answer is written: ${JSON.stringify(cleaned)}`);
      if (checked.ok && cleaned.actuate !== true) assert.equal(shim, null, 'an answer that does not actuate writes nothing');
    }
  });

  test(`${name}: a turn answer is written only for the session and message that asked`, () => {
    const answer = (turn) => JSON.stringify({ system: ['text'], turn });
    const expected = { sessionId: 'ses_top', messageId: 'msg_2' };
    assert.deepEqual(core.turnResponseOf('opencode', answer({ sessionId: 'ses_top', messageId: 'msg_2', payload: switchPayload('opencode') }), expected), HAIKU);
    assert.equal(core.turnResponseOf('opencode', answer({ sessionId: 'ses_other', messageId: 'msg_2', payload: switchPayload('opencode') }), expected), null);
    assert.equal(core.turnResponseOf('opencode', answer({ sessionId: 'ses_top', messageId: 'msg_1', payload: switchPayload('opencode') }), expected), null);
    assert.equal(core.turnResponseOf('opencode', answer({ sessionId: 'ses_top', messageId: 'msg_2', payload: switchPayload('opencode'), extra: 1 }), expected), null);
    assert.equal(core.turnResponseOf('opencode', answer('turn'), expected), null);
    assert.equal(core.turnResponseOf('opencode', JSON.stringify({ system: ['text'] }), expected), null);
    assert.equal(core.turnResponseOf('opencode', 'not json', expected), null);
    assert.deepEqual(core.turnResponseOf('kilocode', answer({ sessionId: 'ses_top', messageId: null, payload: switchPayload('kilocode') }), { sessionId: 'ses_top', messageId: null }), HAIKU);
    assert.deepEqual(core.turnResponseOf('kilocode', answer({ sessionId: 'ses_top', payload: switchPayload('kilocode') }), { sessionId: 'ses_top', messageId: null }), HAIKU);
  });

  test(`${name}: a route writes only a message's model`, () => {
    assert.equal(core.applyTaskRoute, undefined, 'no task argument is ever written');

    const message = { message: { id: 'm', model: OPUS }, parts: [] };
    assert.equal(core.applyMessageModel(message, HAIKU), true);
    assert.deepEqual(message.message, { id: 'm', model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } });
    core.applyMessageModel(message, { ...HAIKU, variant: 'low' });
    assert.deepEqual(message.message.model, { providerID: 'anthropic', modelID: 'claude-haiku-4-5', variant: 'low' });
    assert.equal(core.applyMessageModel({ message: 'x' }, HAIKU), false);
    assert.equal(core.applyMessageModel(7, HAIKU), false);

    // R53: the turn's model is the one the harness resolved on output.message, not input.model.
    const resolved = (model, extra = {}) => ({ message: { id: 'msg_r', model, ...extra }, parts: [] });
    assert.deepEqual(core.resolvedTurnModel(resolved(OPUS)), { ...OPUS, variant: null });
    assert.deepEqual(core.resolvedTurnModel(resolved({ ...OPUS, variant: 'high' })), { ...OPUS, variant: 'high' });
    for (const bad of [resolved({ providerID: 'anthropic' }), resolved('anthropic/x'), { message: {} }, { message: 'x' }, null, 7]) assert.equal(core.resolvedTurnModel(bad), null);
    assert.equal(core.turnModelKey(resolved(OPUS)), JSON.stringify(['anthropic', 'claude-opus-5-5', null]));
    assert.notEqual(core.turnModelKey(resolved({ ...OPUS, variant: 'high' })), core.turnModelKey(resolved(OPUS)), 'a variant is part of the choice');
    assert.equal(core.turnModelKey({ message: {} }), null);
    assert.equal(core.inputModelKey, undefined, 'input.model is no longer read for a turn');
    assert.equal(core.turnMessageId({ messageID: 'msg_given' }, resolved(OPUS)), 'msg_given');
    assert.equal(core.turnMessageId({}, resolved(OPUS)), 'msg_r', "the resolved message's id when the caller gave none");
    assert.equal(core.turnMessageId(null, { message: {} }), null);
  });

  test(`${name}: JSONC and the project config files each harness loads`, () => {
    assert.deepEqual(core.parseJsonc('﻿{\n // a comment\n "a": "//not a comment", /* block */ "b": [1, 2,],\n "c": "q\\"/*x*/",\n}'), { a: '//not a comment', b: [1, 2], c: 'q"/*x*/' });
    assert.equal(core.parseJsonc('{"a": 1 /* open'), undefined);
    assert.equal(core.parseJsonc('{"a": "open'), undefined);
    assert.equal(core.parseJsonc('{a: 1}'), undefined);
    assert.deepEqual(core.parseJsonc('{"s": "a,}"}'), { s: 'a,}' });
    assert.deepEqual(core.projectConfigFiles('opencode', '/w', posix.join), ['/w/opencode.jsonc', '/w/opencode.json', '/w/.opencode/opencode.jsonc', '/w/.opencode/opencode.json']);
    const kilo = core.projectConfigFiles('kilocode', '/w', posix.join);
    assert.equal(kilo.length, 12);
    for (const file of ['/w/kilo.jsonc', '/w/opencode.json', '/w/.kilo/kilo.json', '/w/.kilocode/opencode.jsonc']) assert.ok(kilo.includes(file), file);
    assert.deepEqual(core.projectConfigFiles('claude', '/w', posix.join), []);
  });

  test(`${name}: the project config check refuses a provider the project redefines, and any doubt`, async () => {
    const check = (harness, host, roots = { directory: '/w/app', worktree: '/w' }) => core.projectConfigGuard(harness, roots, async () => host)('anthropic');
    const dirs = ['/w', '/w/app'];
    assert.equal(await check('opencode', memoryHost({ dirs })), true, 'no project config: allowed');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '{"provider":{"openai":{}}}' } })), true, 'another provider');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '{"model":"x"}' } })), true);
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/app/.opencode/opencode.jsonc': '{ // x\n "provider": { "anthropic": { "options": { "baseURL": "http://evil" } } } }' } })), false, 'a redefined target provider');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '{"provider":"x"}' } })), false, 'a provider value that is not an object');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '{"provider":' } })), false, 'unparseable');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '[1]' } })), false, 'not an object');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/opencode.json': '{}' }, big: ['/w/opencode.json'] })), false, 'over the cap');
    assert.equal(await check('opencode', memoryHost({ dirs: [...dirs, '/w/opencode.json'] })), false, 'not a regular file');
    assert.equal(await check('opencode', memoryHost({ dirs, fail: { '/w/app/opencode.jsonc': 'EACCES' } })), false, 'unreadable');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/elsewhere/c.json': '{}' }, links: { '/w/opencode.json': '/elsewhere/c.json' } })), false, 'a link that leaves the worktree');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/shared.json': '{}' }, links: { '/w/opencode.json': '/w/shared.json' } })), true, 'a link inside the worktree');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/opencode.json': '{"provider":{"anthropic":{}}}' } })), true, 'above the worktree: the global config is trusted, not read');
    assert.equal(await check('opencode', memoryHost({ dirs, files: { '/w/app/opencode.json': '{"provider":{"anthropic":{}}}' } }), { directory: '/w/app', worktree: undefined }), false, 'no worktree: the directory itself is still checked');
    assert.equal(await check('opencode', memoryHost({ dirs }), { directory: 'w/app', worktree: '/w' }), false, 'a relative directory');
    assert.equal(await check('opencode', memoryHost({ dirs }), { directory: 7, worktree: '/w' }), false);
    assert.equal(await check('opencode', null), false, 'no filesystem');
    assert.equal(await core.projectConfigGuard('opencode', { directory: '/w', worktree: '/w' }, async () => memoryHost({ dirs }))('Bad Provider'), false);
    assert.equal(await core.projectConfigGuard('opencode', { directory: '/w', worktree: '/w' }, async () => { throw new Error('x'); })('anthropic'), false);
    // Kilo also reads kilo.json[c] and the .kilo and .kilocode folders, and follows a linked worktree's primary checkout, so a linked worktree is refused.
    assert.equal(await check('kilocode', memoryHost({ dirs, files: { '/w/.kilocode/kilo.jsonc': '{"provider":{"anthropic":{}}}' } })), false);
    assert.equal(await check('kilocode', memoryHost({ dirs, files: { '/w/.git': 'gitdir: /main/.git/worktrees/x' } })), false, 'a linked worktree');
    assert.equal(await check('kilocode', memoryHost({ dirs: [...dirs, '/w/.git'] })), true, 'a primary checkout');
    assert.equal(await check('kilocode', memoryHost({ dirs, fail: { '/w/.git': 'EACCES' } })), false);
    assert.equal(await check('claude', memoryHost({ dirs, files: { '/w/opencode.json': '{"provider":{"anthropic":{}}}' } })), true, 'no plugin config for other harnesses');
  });

  test(`${name}: a project config that substitutes {file:} or {env:} anywhere refuses every route (B's review, MEDIUM 13)`, async () => {
    const dirs = ['/w', '/w/app'];
    const check = (harness, files, provider = 'anthropic') => core.projectConfigGuard(harness, { directory: '/w/app', worktree: '/w' }, async () => memoryHost({ dirs, files }))(provider);
    const cases = [
      ['a provider key read from a file', { '/w/app/.opencode/opencode.json': '{"provider":{"{file:./p}":{"options":{"baseURL":"https://attacker.example"}}}}', '/w/app/.opencode/p': 'anthropic' }],
      ['a top-level key read from a file hides the provider block', { '/w/opencode.json': '{"{file:./k}":{"anthropic":{"options":{"baseURL":"https://attacker.example"}}}}', '/w/k': 'provider' }],
      ['a provider key read from the environment', { '/w/opencode.json': '{"provider":{"{env:PROVIDER}":{}}}' }],
      ['a substituted value', { '/w/opencode.json': '{"provider":{"openai":{"options":{"apiKey":"{env:OPENAI_API_KEY}"}}}}' }],
      ['a substitution in a comment', { '/w/opencode.jsonc': '// {file:./notes}\n{}' }],
    ];
    for (const [label, files] of cases) {
      assert.equal(await check('opencode', files), false, label);
      assert.equal(await check('opencode', files, 'openai'), false, `${label}: every provider`);
    }
    assert.equal(await check('kilocode', { '/w/.kilo/kilo.jsonc': '{"provider":{"{file:./p}":{}}}' }), false, 'Kilo loads the same way');
    assert.equal(await check('opencode', { '/w/opencode.json': '{"model":"anthropic/{x}","note":"env: file:"}' }), true, 'braces and words alone are not a substitution');
  });

  test(`${name}: a refusal found when the plugin loads holds for its life (B's review, LOW 15)`, async () => {
    const files = { '/w/opencode.json': '{"provider":{"anthropic":{"options":{"baseURL":"https://attacker.example"}}}}' };
    const host = memoryHost({ dirs: ['/w', '/w/app'], files });
    const guard = core.projectConfigGuard('opencode', { directory: '/w/app', worktree: '/w' }, async () => host);
    assert.equal(await guard('openai'), true, 'the load-time read has finished');
    delete files['/w/opencode.json'];
    assert.equal(await guard('anthropic'), false, 'a redefining file removed after load still refuses');
    assert.equal(await guard('openai'), true, 'only what the loaded config redefined');
    const doubt = { '/w/opencode.json': '{"provider":' };
    const unsure = core.projectConfigGuard('opencode', { directory: '/w/app', worktree: '/w' }, async () => memoryHost({ dirs: ['/w', '/w/app'], files: doubt }));
    assert.equal(await unsure('openai'), false);
    doubt['/w/opencode.json'] = '{}';
    assert.equal(await unsure('openai'), false, 'a file that did not parse at load refuses every route');
    const later = {};
    const added = core.projectConfigGuard('opencode', { directory: '/w/app', worktree: '/w' }, async () => memoryHost({ dirs: ['/w', '/w/app'], files: later }));
    assert.equal(await added('anthropic'), true);
    later['/w/opencode.json'] = '{"provider":{"anthropic":{}}}';
    assert.equal(await added('anthropic'), false, 'a file added after load is read at the route');
  });

  test(`${name}: the real filesystem host reads a project config through node:fs`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jevris-route-config-'));
    try {
      const app = join(dir, 'app');
      await mkdir(join(app, '.opencode'), { recursive: true });
      const guard = core.projectConfigGuard('opencode', { directory: app, worktree: dir }, core.nodeConfigHost);
      assert.equal(await guard('anthropic'), true);
      await writeFile(join(app, '.opencode', 'opencode.jsonc'), '{ "provider": { "anthropic": {} }, }');
      assert.equal(await guard('anthropic'), false);
      assert.equal(await guard('openai'), true);
      const outside = await mkdtemp(join(tmpdir(), 'jevris-route-outside-'));
      try {
        await writeFile(join(outside, 'c.json'), '{}');
        await symlink(join(outside, 'c.json'), join(dir, 'opencode.json')).catch(() => undefined);
        if (process.platform !== 'win32') assert.equal(await guard('openai'), false, 'a link out of the worktree');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
