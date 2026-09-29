// The owned workers' id and effort map (routing design R6, R13, R18): the bundled registry's
// harnessModels rows and harnessAccess templates spell each model for each harness; no family
// regex. Ids only; nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';

const { harnessModelChoice, registryRefOf, listedModelId } = await import('../dist/harness-model.js');
const { BUNDLED_MODEL_REGISTRY } = await import('@jevris/core');

const PASS = (id) => id;
const PIN = (id) => (/^[a-z0-9][a-z0-9._-]*\/[^/]/i.test(id) ? id : null);

test('registry refs: a registry id, a provider-prefixed id, or the harness own id', () => {
  const r = BUNDLED_MODEL_REGISTRY;
  assert.deepEqual(registryRefOf(r, 'codex', 'gpt-6-sol'), { provider: 'openai', modelId: 'gpt-6-sol' });
  assert.deepEqual(registryRefOf(r, 'codex', 'openai/gpt-6-sol'), { provider: 'openai', modelId: 'gpt-6-sol' }, "D's provider/ prefix");
  assert.deepEqual(registryRefOf(r, 'opencode', 'moonshotai/kimi-k3'), { provider: 'moonshot', modelId: 'kimi-k3' }, "the harness's provider id");
  assert.deepEqual(registryRefOf(r, 'antigravity', 'gemini-3.8-flash-low'), { provider: 'google', modelId: 'gemini-3.8-flash' }, 'an effort slug');
  assert.equal(registryRefOf(r, 'opencode', 'openrouter/qwen/qwen3-coder'), null);
  assert.equal(registryRefOf(r, 'codex', 'mystery'), null);
});

test('Codex: the registry id and its reasoning levels; another provider refused; an unknown id as given', () => {
  const sol = harnessModelChoice('codex', 'gpt-6-sol', 'max', { fallbackLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], unregistered: PASS });
  assert.equal(sol.id, 'gpt-6-sol');
  assert.equal(sol.effortInModel, false);
  assert.ok(['high', 'xhigh', 'max'].includes(sol.level), 'C\'s max maps to a level Codex lists for the model');
  assert.equal(sol.effortToken, sol.level);
  assert.equal(harnessModelChoice('codex', 'claude-opus-5-5', undefined, { fallbackLevels: [], unregistered: PASS }), null, 'Codex names no Claude id');
  const unknown = harnessModelChoice('codex', 'gpt-5.2-codex', 'max', { fallbackLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], unregistered: PASS });
  assert.deepEqual([unknown.id, unknown.model, unknown.level], ['gpt-5.2-codex', null, 'xhigh'], 'the port levels for an id the registry does not know');
  const none = harnessModelChoice('codex', 'gpt-6-sol', undefined, { fallbackLevels: [], unregistered: PASS });
  assert.deepEqual([none.level, none.effortToken], [null, null], 'no effort asked, none passed');
});

test('Antigravity: the effort goes in the slug, and a pinned slug is kept', () => {
  const opts = { fallbackLevels: ['low', 'medium', 'high', 'max'], unregistered: PASS };
  const low = harnessModelChoice('antigravity', 'gemini-3.8-flash', 'low', opts);
  assert.deepEqual([low.id, low.level, low.effortInModel], ['gemini-3.8-flash-low', 'low', true]);
  const top = harnessModelChoice('antigravity', 'gemini-3.8-flash', 'max', opts);
  assert.deepEqual([top.id, top.level], ['gemini-3.8-flash-high', 'high'], 'Gemini has no xhigh or max (R18)');
  assert.equal(harnessModelChoice('antigravity', 'gemini-3.8-flash', undefined, opts).id, 'gemini-3.8-flash-medium', "the row's default slug");
  assert.equal(harnessModelChoice('antigravity', 'gemini-3.7-flash-high', undefined, opts).id, 'gemini-3.7-flash-high', 'a pinned slug as given');
  assert.equal(harnessModelChoice('antigravity', 'gpt-6-sol', undefined, opts), null, 'Antigravity names no OpenAI slug');
  const unknown = harnessModelChoice('antigravity', 'gemini-3.5-pro', 'xhigh', opts);
  assert.deepEqual([unknown.id, unknown.level, unknown.effortInModel], ['gemini-3.5-pro', 'high', false], 'an unknown id keeps --effort');
});

test('OpenCode and Kilo: the provider/model spelling per harness; a pin passes; a bare unknown id is refused', () => {
  const opts = { fallbackLevels: ['low', 'medium', 'high', 'xhigh', 'max'], unregistered: PIN };
  const kimi = harnessModelChoice('opencode', 'kimi-k3', 'high', opts);
  assert.deepEqual([kimi.id, kimi.model, kimi.effortInModel], ['moonshotai/kimi-k3', { provider: 'moonshot', modelId: 'kimi-k3' }, false]);
  assert.equal(harnessModelChoice('kilocode', 'kimi-k3', undefined, opts).id, 'moonshotai/kimi-k3', 'Kilo spells Kimi as the models.dev catalog it ships does');
  assert.equal(harnessModelChoice('kilocode', 'moonshot/kimi-k3', undefined, opts).id, 'moonshot/kimi-k3', "a user's pin passes as given");
  assert.equal(harnessModelChoice('opencode', 'grok-4.7', undefined, opts).id, 'xai/grok-4.7');
  assert.equal(harnessModelChoice('opencode', 'mystery', undefined, opts), null);
  assert.equal(harnessModelChoice('opencode', 'openrouter/qwen/qwen3-coder', 'high', opts).effortToken, 'high', 'a pin keeps the port levels');
});

test('listed ids: provider lines by the access rows, plain lines by the harness own ids', () => {
  const r = BUNDLED_MODEL_REGISTRY;
  assert.equal(listedModelId(r, 'opencode', 'google-vertex/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(listedModelId(r, 'opencode', 'openai/gpt-5.5'), 'gpt-5.5', 'an unregistered model under a named provider keeps its bare id');
  assert.equal(listedModelId(r, 'opencode', 'openrouter/openai/gpt-5.5'), null);
  assert.equal(listedModelId(r, 'kilocode', 'moonshotai/kimi-k3'), 'kimi-k3');
  assert.equal(listedModelId(r, 'kilocode', 'kilo/z-ai/glm-5.3'), null, 'a Kilo Gateway line is not a direct provider listing');
  assert.equal(listedModelId(r, 'antigravity', 'gemini-3.7-flash-low'), 'gemini-3.7-flash');
  assert.equal(listedModelId(r, 'antigravity', 'gemini-9'), 'gemini-9');
  assert.equal(listedModelId(r, 'codex', 'gpt-6-luna'), 'gpt-6-luna');
});

// Serving hosts R52: the choice names the host its id reaches, from core's one resolver. It is
// information only until D's workers.ts and the parked task-ops wiring read it: every other field
// is what it was before, for a maker spelling and a gateway spelling alike.
test('serving (R52): a maker spelling reaches the maker, a pinned gateway spelling its host; nothing else changes', () => {
  const pin = { fallbackLevels: ['low', 'medium', 'high', 'xhigh', 'max'], unregistered: PIN };
  const maker = harnessModelChoice('opencode', 'kimi-k3', 'high', pin);
  assert.deepEqual(maker.serving, { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'moonshot', via: 'maker' });
  assert.deepEqual([maker.id, maker.model, maker.effortInModel], ['moonshotai/kimi-k3', { provider: 'moonshot', modelId: 'kimi-k3' }, false], 'as before R52');
  assert.deepEqual(harnessModelChoice('codex', 'gpt-6-sol', 'max', { fallbackLevels: ['low'], unregistered: PASS }).serving, { provider: 'openai', modelId: 'gpt-6-sol', servingHost: 'openai', via: 'maker' });
  const slug = harnessModelChoice('antigravity', 'gemini-3.8-flash', 'low', { fallbackLevels: ['low', 'medium', 'high'], unregistered: PASS });
  assert.deepEqual([slug.id, slug.serving?.servingHost, slug.serving?.via, slug.serving?.modelId], ['gemini-3.8-flash-low', 'google', 'maker', 'gemini-3.8-flash'], 'the started slug resolves to its maker');

  for (const harness of ['opencode', 'kilocode']) {
    const gateway = harnessModelChoice(harness, 'openrouter/moonshotai/kimi-k3', 'high', pin);
    assert.deepEqual(gateway.serving, { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter', via: 'host' }, harness);
    // Inert: the gateway pin still runs exactly as the user's pin did before R52.
    assert.deepEqual([gateway.id, gateway.model, gateway.level, gateway.effortToken, gateway.effortInModel], ['openrouter/moonshotai/kimi-k3', null, 'high', 'high', false], `${harness}: as before R52`);
  }
  const unpinned = harnessModelChoice('opencode', 'openrouter/qwen/qwen3-coder', 'high', pin);
  assert.deepEqual([unpinned.id, unpinned.serving], ['openrouter/qwen/qwen3-coder', null], 'a host serving the registry does not pin resolves to nothing');
  assert.equal(harnessModelChoice('codex', 'gpt-5.2-codex', undefined, { fallbackLevels: [], unregistered: PASS }).serving, null, 'an id the registry does not know');
});

test('servingHost (R52, agreed with D): the one host spelling for the registry model, never the maker spelling; absent is the maker route as before', () => {
  const pin = { fallbackLevels: ['low', 'medium', 'high', 'xhigh', 'max'], unregistered: PIN };
  for (const harness of ['opencode', 'kilocode']) {
    const via = harnessModelChoice(harness, 'kimi-k3', 'high', { ...pin, servingHost: 'openrouter' });
    assert.equal(via.id, 'openrouter/moonshotai/kimi-k3', harness);
    assert.deepEqual(via.model, { provider: 'moonshot', modelId: 'kimi-k3' });
    assert.deepEqual(via.serving, { provider: 'moonshot', modelId: 'kimi-k3', servingHost: 'openrouter', via: 'host' });
    const maker = harnessModelChoice(harness, 'kimi-k3', 'high', pin);
    assert.deepEqual([via.level, via.effortToken], [maker.level, maker.effortToken], "the maker's effort tokens");
    assert.equal(maker.id, 'moonshotai/kimi-k3', 'no servingHost: the maker route, unchanged');
    assert.equal(harnessModelChoice(harness, 'kimi-k3', 'high', { ...pin, servingHost: 'moonshot' }), null, 'a maker id is not a serving host');
    assert.equal(harnessModelChoice(harness, 'mystery-model', 'high', { ...pin, servingHost: 'openrouter' }), null, 'only a registry model');
  }
  assert.equal(harnessModelChoice('opencode', 'kimi-k3', 'high', { ...pin, servingHost: 'kilo' }), null, 'OpenCode has no Kilo Gateway row: no spelling, never the maker one');
  assert.equal(harnessModelChoice('codex', 'gpt-6-sol', 'high', { fallbackLevels: [], unregistered: PASS, servingHost: 'openrouter' }), null, 'Codex reaches no pinned host');
});
