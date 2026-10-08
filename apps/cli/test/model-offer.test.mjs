// The harness model listing (owner decision DOMAINS 3f090fa): parsers, gates, bounds, the certify
// case's side-effect check and doctor's line. Every listing runs a node stub from the temp folder;
// no test starts a real harness binary. Temp homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevrisPaths } from '@jevris/platform';

const offer = await import('../dist/model-offer.js');
const { maybeReverify, newerFeaturesFor, NEWER_FEATURES } = await import('../dist/reverify.js');
const { DEFAULT_CONFIG, CONFIG_FILE } = await import('@jevris/orchestrator');

async function withBox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jevris-model-offer-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// One stub for every harness: STUB_MODE picks the answer. `--version` always answers.
const STUB = `
const args = process.argv.slice(2);
const mode = process.env.STUB_MODE || 'ok';
const out = (text) => process.stdout.write(text);
if (args.at(-1) === '--version') { out(process.env.STUB_VERSION || '1.18.32\\n'); process.exit(0); }
if (args.includes('app-server')) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.method === 'initialize') out(JSON.stringify({ id: message.id, result: {} }) + '\\n');
      if (message.method === 'model/list') {
        if (mode === 'error') { out(JSON.stringify({ id: message.id, error: { code: -1, message: 'no' } }) + '\\n'); continue; }
        const second = message.params && message.params.cursor === 'page-2';
        out('{"method":"account/updated","params":{}}\\n');
        const data = second ? [{ id: 'x', model: 'gpt-5.5-mini', hidden: false }] : [{ id: 'a', model: 'gpt-5.5', hidden: false }, { id: 'b', model: 'secret-internal', hidden: true }];
        out(JSON.stringify({ id: message.id, result: { data, nextCursor: second ? null : 'page-2' } }) + '\\n');
      }
      if (message.method === 'account/rateLimits/read') {
        // OP-6: the usage read. USAGE_MARK records that it was sent; USAGE_MODE picks the answer.
        if (process.env.USAGE_MARK) require('node:fs').writeFileSync(process.env.USAGE_MARK, JSON.stringify(message.params ?? null));
        const usage = process.env.USAGE_MODE || 'ok';
        if (usage === 'hang') continue;
        if (usage === 'error') { out(JSON.stringify({ id: message.id, error: { code: -32600, message: 'not signed in as person@example.invalid' } }) + '\\n'); continue; }
        if (usage === 'malformed') { out(JSON.stringify({ id: message.id, result: { rateLimits: { primary: { usedPercent: 'lots' } } } }) + '\\n'); continue; }
        const reset = Number(process.env.USAGE_RESET || 0);
        out(JSON.stringify({ id: message.id, result: {
          ordinaryUsageAllowed: usage === 'refused' ? false : true,
          accountId: 'acct-person@example.invalid',
          rateLimitUpsell: { title: 'Upgrade, person@example.invalid' },
          rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'c1', title: 'person@example.invalid' }] },
          rateLimits: {
            limitId: 'codex', limitName: 'person@example.invalid', planType: 'plus',
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: reset, note: 'person@example.invalid' },
            secondary: { usedPercent: usage === 'exhausted' ? 100 : 12, windowDurationMins: 10080, resetsAt: reset + 86400 },
            credits: { hasCredits: true, unlimited: false, balance: '17.50' },
          },
        } }) + '\\n');
      }
    }
  });
} else if (args.includes('--input-format')) {
  // Claude Code's idle print session: answers only the initialize control request. A user
  // message would be a billed turn; the stub records it so the test can prove none is sent.
  let buffer = '';
  process.stdin.setEncoding('utf8');
  out(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' }) + '\\n');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.type === 'user') { out(JSON.stringify({ type: 'result', subtype: 'success', billed: true }) + '\\n'); process.exit(9); }
      if (message.type !== 'control_request' || message.request.subtype !== 'initialize') continue;
      if (mode === 'error') { out(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'no' } }) + '\\n'); continue; }
      const models = [
        { value: 'default', displayName: 'Default', description: 'x' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'x' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'x' },
        { value: 'claude-haiku-4-5', displayName: 'Haiku', description: 'x' },
        { value: 'haiku', displayName: 'no resolved id', description: 'x' },
      ];
      out(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models, account: { email: 'person@example.invalid' } } } }) + '\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else if (args[0] === 'models') {
  if (mode === 'ok') out('anthropic/claude-sonnet-4-5\\nopenai/gpt-5.5\\nopenrouter/openai/gpt-5.5\\nopencode/big-pickle\\n');
  if (mode === 'maker') out('moonshotai/kimi-k3\\nopenrouter/moonshotai/kimi-k3\\n');
  if (mode === 'plain') out('gemini-3-pro\\ngemini-3-flash\\n');
  if (mode === 'malformed') out('Available models:\\nopenai/gpt-5.5\\n');
  if (mode === 'fail') process.exit(3);
  if (mode === 'big') { const line = 'openai/' + 'a'.repeat(100) + '\\n'; for (let i = 0; i < 4000; i += 1) out(line); }
  if (mode === 'slow') setTimeout(() => out('openai/gpt-5.5\\n'), 30000);
  if (mode === 'env') out('openai/gpt-' + (process.env.OPENCODE_DISABLE_AUTOUPDATE === '1' ? 'noupdate' : 'update') + '\\n');
}
`;

async function stubCommand(dir) {
  const script = join(dir, 'stub.cjs');
  await writeFile(script, STUB);
  return { file: process.execPath, args: [script] };
}

function coveringLoad(harness, version, features = ['models.list']) {
  const record = {
    harness,
    harnessVersionRange: { minimum: version, maximumExclusive: '99.0.0' },
    operatingSystems: [process.platform],
    certifiedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2027-09-01T00:00:00Z',
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: null })),
  };
  return { dir: '', records: [{ record, trust: 'local' }], rejected: [] };
}

const NOW = Date.parse('2026-09-27T12:00:00Z');

async function list(dir, input) {
  const command = await stubCommand(dir);
  return offer.listOfferedModels({ home: dir, nowMs: NOW, command, ...input, env: { ...process.env, ...(input.env ?? {}) } });
}

test('provider listing: keeps the providers the registry names for the harness, strips them, and refuses a stray line', () => {
  const ids = (...args) => offer.parseProviderListing(...args)?.models ?? null;
  // R43: openrouter/openai/gpt-5.5 stays out, as the bundled registry has no OpenRouter serving for it.
  assert.deepEqual(ids('anthropic/claude-sonnet-4-5\nopenai/gpt-5.5\nopenrouter/openai/gpt-5.5\nopencode/big-pickle\n\n'), ['claude-sonnet-4-5', 'gpt-5.5']);
  assert.deepEqual(ids('openai/gpt-5.5\r\nopenai/gpt-5.5\n'), ['gpt-5.5'], 'unique, CRLF tolerated');
  assert.equal(offer.parseProviderListing('Available models:\nopenai/gpt-5.5\n'), null);
  assert.deepEqual(offer.parseProviderListing(''), { models: [], spellings: [] });
  assert.deepEqual(ids(`openai/${'g'.repeat(200)}\n`), [], 'an id over the pattern length is dropped');
  // R13: every provider id the registry's access rows name for the harness, not only the worker's family.
  const many = 'moonshotai/kimi-k3\nzai-coding-plan/glm-5.3\ngoogle-vertex/gemini-3.8-flash\ndeepseek/deepseek-v4-pro\nmoonshot/kimi-k3\n';
  assert.deepEqual(ids(many, 'opencode'), ['deepseek-v4-pro', 'gemini-3.8-flash', 'glm-5.3', 'kimi-k3']);
  assert.deepEqual(ids('moonshotai/kimi-k3\ngoogle/gemini-3.8-flash\nzai/glm-5.3\n', 'kilocode'), ['gemini-3.8-flash', 'glm-5.3', 'kimi-k3'], "Kilo's rows take the models.dev provider ids, as OpenCode's do");
});

// Serving hosts R43 (design 7): the bundled registry plus OpenRouter and NVIDIA on both harnesses
// and the Kilo Gateway on Kilo, with the lines certify case K13's stub listing uses.
test('R43 (K13 lines): a listing keeps each pinned host spelling the registry has an exact serving for, and drops the rest', async () => {
  const { BUNDLED_MODEL_REGISTRY: R, validateModelRegistry } = await import('@jevris/core');
  const TARIFF = { ...R.entries.find((e) => e.modelId === 'kimi-k3').tariff, version: 'openrouter-2026-09-27', sourceId: 'MODELSDEV-TEST' };
  const row = (harness, host) => ({ harness, host, segment: host, signIns: ['api-key'], sourceIds: ['MODELSDEV-TEST'] });
  const serving = (host, provider, modelId, hostModelId, extra = {}) => ({ host, provider, modelId, hostModelId, tariff: TARIFF, tariffBasis: 'host', sourceIds: ['MODELSDEV-TEST'], ...extra });
  const REG = {
    ...R,
    harnessHosts: ['opencode', 'kilocode'].flatMap((harness) => [row(harness, 'openrouter'), row(harness, 'nvidia')]).concat([row('kilocode', 'kilo')]),
    servings: [
      serving('openrouter', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
      serving('kilo', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3'),
      serving('kilo', 'zai', 'glm-5.3', 'z-ai/glm-5.3'),
      serving('nvidia', 'moonshot', 'kimi-k3', 'moonshotai/kimi-k3', { tariff: null, tariffBasis: 'free-tier' }),
    ],
  };
  assert.equal(validateModelRegistry(REG).ok, true);
  const K13 = ['openrouter/moonshotai/kimi-k3', 'kilo/moonshotai/kimi-k3', 'kilo/z-ai/glm-5.3', 'nvidia/moonshotai/kimi-k3', 'openrouter/moonshotai/kimi-k3:free', 'kilo/~deepseek/deepseek-v4-flash-latest'].join('\n');
  assert.deepEqual(offer.parseProviderListing(`${K13}\n`, 'kilocode', REG), {
    models: ['glm-5.3', 'kimi-k3'],
    spellings: [
      { raw: 'kilo/moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'kilo' },
      { raw: 'kilo/z-ai/glm-5.3', modelId: 'glm-5.3', servingHost: 'kilo' },
      { raw: 'nvidia/moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'nvidia' },
      { raw: 'openrouter/moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'openrouter' },
    ],
  }, 'the NVIDIA line is kept as evidence (consent keeps it from routing); the :free and ~ lines are dropped');
  const onOpenCode = offer.parseProviderListing(`${K13}\nmoonshotai/kimi-k3\n`, 'opencode', REG);
  assert.deepEqual(onOpenCode.spellings.map((item) => [item.raw, item.servingHost]), [
    ['moonshotai/kimi-k3', 'moonshot'],
    ['nvidia/moonshotai/kimi-k3', 'nvidia'],
    ['openrouter/moonshotai/kimi-k3', 'openrouter'],
  ], "the Kilo Gateway is not an OpenCode host, and a maker line keeps the maker as its host");
  assert.deepEqual(onOpenCode.models, ['kimi-k3']);
  // R38: the bundled snapshot pins these servings too, so the same lines count without a test registry.
  assert.deepEqual(offer.parseProviderListing(`${K13}\n`, 'kilocode').spellings.map((item) => [item.raw, item.servingHost]), [
    ['kilo/moonshotai/kimi-k3', 'kilo'],
    ['kilo/z-ai/glm-5.3', 'kilo'],
    ['nvidia/moonshotai/kimi-k3', 'nvidia'],
    ['openrouter/moonshotai/kimi-k3', 'openrouter'],
  ], 'the bundled registry pins these servings (R38); the :free and ~ lines stay out');
  assert.deepEqual(offer.parseProviderListing(`${K13}\n`, 'kilocode').models, ['glm-5.3', 'kimi-k3']);
});

test('plain and Codex listings: ids checked against the pattern; hidden models left out; the cursor followed', () => {
  assert.deepEqual(offer.parsePlainListing('gemini-3-pro\ngemini-3-flash\n'), ['gemini-3-flash', 'gemini-3-pro']);
  assert.equal(offer.parsePlainListing('gemini 3 pro\n'), null);
  assert.deepEqual(offer.parsePlainListing('gemini-3.8-flash-low\ngemini-3.8-flash-high\n'), ['gemini-3.8-flash'], 'a known Antigravity slug is kept as its registry id');
  const page = offer.parseCodexModelPage({ data: [{ id: 'a', model: 'gpt-5.5', hidden: false }, { id: 'b', model: 'internal', hidden: true }], nextCursor: 'c1' });
  assert.deepEqual(page, { models: ['gpt-5.5'], nextCursor: 'c1' });
  assert.deepEqual(offer.parseCodexModelPage({ data: [{ id: 'gpt-5.5' }], nextCursor: null }), { models: ['gpt-5.5'], nextCursor: null });
  assert.equal(offer.parseCodexModelPage({ data: 'x' }), null);
  assert.equal(offer.parseCodexModelPage({ data: [{ hidden: false }] }), null);
  assert.equal(offer.validModelId('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'), false, 'a secret-shaped id is never kept');
});

test('the listing argv and environment: no --refresh, the no-update variables, Codex update check off', () => {
  assert.deepEqual(offer.listingArgv('opencode'), ['models']);
  assert.deepEqual(offer.listingArgv('kilocode'), ['models']);
  assert.deepEqual(offer.listingArgv('antigravity'), ['models']);
  assert.deepEqual(offer.listingArgv('codex'), ['-c', 'check_for_update_on_startup=false', 'app-server']);
  assert.deepEqual(offer.listingArgv('claude'), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--settings', '{"disableAllHooks":true}']);
  for (const harness of ['claude', 'codex', 'opencode', 'kilocode', 'antigravity']) assert.equal((offer.listingArgv(harness) ?? []).includes('--refresh'), false);
  assert.equal(offer.listingEnv('opencode', {}).OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.deepEqual([offer.listingEnv('kilocode', {}).KILO_DISABLE_AUTOUPDATE, offer.listingEnv('kilocode', {}).KILO_NO_DAEMON], ['1', '1']);
});

// windows-latest, pack-smoke doctor proof: through the claude.cmd stand-in the listing read as
// HARNESS_NOT_INSTALLED, because a cmd shim never carries the JSON's double quotes.
test('on Windows the Claude listing names a settings file, which a claude.cmd shim can carry', async () => {
  const { planSpawn } = await import('../../../packages/platform/dist/index.js');
  const shim = 'C:\\npm\\claude.cmd';
  const options = { platform: 'win32', env: { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, isExecutableFile: (path) => path.toLowerCase() === shim.toLowerCase() };
  assert.deepEqual(planSpawn(shim, [...offer.listingArgv('claude')], options), { ok: false, reason: 'unsafe-argument' });
  const file = 'C:\\Users\\ada\\AppData\\Local\\Temp\\jevris-listing-x\\settings.json';
  const argv = offer.claudeListingArgv(file);
  assert.deepEqual(argv, [...offer.listingArgv('claude').slice(0, -1), file]);
  assert.equal(argv[argv.indexOf('--settings') + 1], file);
  assert.equal(planSpawn(shim, [...argv], options).ok, true);
  assert.deepEqual(JSON.parse(offer.CLAUDE_LISTING_SETTINGS), { disableAllHooks: true });
  assert.equal(offer.listingArgv('claude').at(-1), offer.CLAUDE_LISTING_SETTINGS);
});

test('listOfferedModels gates: an unknown harness is unsupported, a test run never starts the real binary, an uncertified version never lists', async () => {
  await withBox(async (dir) => {
    assert.deepEqual(await offer.listOfferedModels({ home: dir, harness: 'claude', env: { ...process.env, JEVRIS_TEST: '1' } }), { ok: false, reasonCode: 'LISTING_REFUSED' }, 'Claude Code lists now (G13), behind the same gates');
    assert.deepEqual(await offer.listOfferedModels({ home: dir, harness: 'gemini' }), { ok: false, reasonCode: 'LISTING_UNSUPPORTED' });
    assert.deepEqual(await offer.listOfferedModels({ home: dir, harness: 'opencode', env: { ...process.env, JEVRIS_TEST: '1' } }), { ok: false, reasonCode: 'LISTING_REFUSED' });
    assert.deepEqual(await list(dir, { harness: 'opencode', load: { dir: '', records: [], rejected: [] } }), { ok: false, reasonCode: 'LISTING_NOT_CERTIFIED' });
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.18.32', ['worker.route']) }), { ok: false, reasonCode: 'LISTING_NOT_CERTIFIED' });
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.19.0') }), { ok: false, reasonCode: 'LISTING_NOT_CERTIFIED' }, 'a version outside the range');
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.18.32'), env: { STUB_VERSION: 'no version\n' } }), { ok: false, reasonCode: 'HARNESS_VERSION_UNKNOWN' });
    const missing = await offer.listOfferedModels({ home: dir, harness: 'opencode', command: { file: join(dir, 'no-such-opencode') }, load: coveringLoad('opencode', '1.18.32'), nowMs: NOW });
    assert.deepEqual(missing, { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' });
  });
});

test('routing.modelListing off stops every listing', async () => {
  await withBox(async (dir) => {
    const config = jevrisPaths({ home: dir }).config;
    await mkdir(config, { recursive: true });
    await writeFile(join(config, CONFIG_FILE), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, modelListing: 'off' } }));
    assert.equal(await offer.modelListingSetting(dir), 'off');
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.18.32') }), { ok: false, reasonCode: 'LISTING_OFF' });
    await writeFile(join(config, CONFIG_FILE), JSON.stringify({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, modelListing: 'on' } }));
    assert.equal(await offer.modelListingSetting(dir), 'on');
  });
});

test('a certified listing returns plain ids and the version; Codex follows the cursor and leaves hidden models out', async () => {
  await withBox(async (dir) => {
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.18.32') }), { ok: true, version: '1.18.32', models: ['claude-sonnet-4-5', 'gpt-5.5'], spellings: [] });
    assert.deepEqual(await list(dir, { harness: 'kilocode', load: coveringLoad('kilocode', '1.18.32') }), { ok: true, version: '1.18.32', models: ['claude-sonnet-4-5', 'gpt-5.5'], spellings: [] });
    assert.deepEqual(await list(dir, { harness: 'kilocode', load: coveringLoad('kilocode', '1.18.32'), env: { STUB_MODE: 'maker' } }), { ok: true, version: '1.18.32', models: ['kimi-k3'], spellings: [{ raw: 'moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'moonshot' }, { raw: 'openrouter/moonshotai/kimi-k3', modelId: 'kimi-k3', servingHost: 'openrouter' }] }, "the listing's spellings reach C's recordModelListing (R43); the bundled snapshot pins OpenRouter's Kimi K3 serving (R38)");
    assert.deepEqual(await list(dir, { harness: 'opencode', load: coveringLoad('opencode', '1.18.32'), env: { STUB_MODE: 'env' } }), { ok: true, version: '1.18.32', models: ['gpt-noupdate'], spellings: [] }, 'the no-update variable reaches the child');
    assert.deepEqual(await list(dir, { harness: 'antigravity', load: coveringLoad('antigravity', '1.18.32'), env: { STUB_MODE: 'plain' } }), { ok: true, version: '1.18.32', models: ['gemini-3-flash', 'gemini-3-pro'] });
    const codex = await list(dir, { harness: 'codex', load: coveringLoad('codex', '0.157.1'), env: { STUB_VERSION: 'codex-cli 0.157.1\n' } });
    assert.deepEqual(codex, { ok: true, version: '0.157.1', models: ['gpt-5.5', 'gpt-5.5-mini'] });
    assert.deepEqual(await list(dir, { harness: 'codex', load: coveringLoad('codex', '0.157.1'), env: { STUB_VERSION: '0.157.1\n', STUB_MODE: 'error' } }), { ok: false, reasonCode: 'LISTING_FAILED' });
  });
});

test('bounds: a failed, malformed, oversized, slow or aborted listing gives only its reason code', async () => {
  await withBox(async (dir) => {
    const load = coveringLoad('opencode', '1.18.32');
    assert.deepEqual(await list(dir, { harness: 'opencode', load, env: { STUB_MODE: 'fail' } }), { ok: false, reasonCode: 'LISTING_FAILED' });
    assert.deepEqual(await list(dir, { harness: 'opencode', load, env: { STUB_MODE: 'malformed' } }), { ok: false, reasonCode: 'LISTING_MALFORMED' });
    assert.deepEqual(await list(dir, { harness: 'opencode', load, env: { STUB_MODE: 'big' } }), { ok: false, reasonCode: 'LISTING_TOO_LARGE' });
    const started = Date.now();
    assert.deepEqual(await list(dir, { harness: 'opencode', load, timeoutMs: 1500, env: { STUB_MODE: 'slow' } }), { ok: false, reasonCode: 'LISTING_TIMEOUT' });
    assert.ok(Date.now() - started < 10_000, 'killed at the timeout, not after the stub finished');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);
    assert.deepEqual(await list(dir, { harness: 'opencode', load, signal: controller.signal, env: { STUB_MODE: 'slow' } }), { ok: false, reasonCode: 'LISTING_ABORTED' });
    assert.equal(offer.LISTING_TIMEOUT_MS, 10_000);
    assert.equal(offer.LISTING_STDOUT_CAP, 256 * 1024);
  });
});

test('certify case: a listing that writes a session, history or config, or updates itself, is not certified; caches and logs are named but allowed', async () => {
  await withBox(async (profile) => {
    await mkdir(join(profile, '.config', 'opencode'), { recursive: true });
    await writeFile(join(profile, '.config', 'opencode', 'opencode.json'), '{}');
    const writing = (files) => async () => {
      for (const [path, body] of Object.entries(files)) {
        await mkdir(join(profile, path, '..'), { recursive: true });
        await writeFile(join(profile, path), body);
      }
      return { ok: true, models: ['gpt-5.5'] };
    };
    const clean = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: writing({ '.cache/opencode/models.json': '{}', '.local/share/opencode/log/1.log': 'x' }) });
    assert.equal(clean.passed, true, clean.detail);
    assert.deepEqual(clean.touched, ['.cache/opencode/models.json', '.local/share/opencode/log/1.log'], 'new folders are named through the files inside them');
    assert.match(clean.detail, /1 model id; touched only caches and logs/);
    const session = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: writing({ '.local/share/opencode/storage/session/ses_1.json': '{}' }) });
    assert.deepEqual([session.passed, session.reasonCode], [false, 'LISTING_SIDE_EFFECT']);
    assert.match(session.detail, /storage\/session\/ses_1\.json/);
    const config = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: writing({ '.config/opencode/opencode.json': '{"x":1}' }) });
    assert.deepEqual([config.passed, config.reasonCode], [false, 'LISTING_SIDE_EFFECT']);
    const update = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: writing({ '.codex/version.json': '{}' }) });
    assert.deepEqual([update.passed, update.reasonCode], [false, 'LISTING_SELF_UPDATE']);
    const failed = await offer.modelListCheck({ harness: 'kilocode', env: {}, profile, run: async () => ({ ok: false, reasonCode: 'LISTING_TIMEOUT' }) });
    assert.deepEqual([failed.passed, failed.reasonCode], [false, 'LISTING_TIMEOUT']);
    assert.equal(await offer.modelListCheck({ harness: 'gemini', env: {}, profile }), null, 'an unknown harness has no case');
  });
});

test('certify case: the first run is a warm-up; only the second run is checked, with the owner-allowed side files', async () => {
  await withBox(async (profile) => {
    const put = async (path, body = 'x') => {
      await mkdir(join(profile, path, '..'), { recursive: true });
      await writeFile(join(profile, path), body);
    };
    // Each run writes `every`; the first also writes `first`. A second write stamps a new mtime.
    // A `-wal` path is written empty, as a read-only open leaves it, unless `walBody` is given;
    // `removed` paths are deleted on the second run.
    const runs = (first, every, pid, { walBody = '', removed = [] } = {}) => {
      let count = 0;
      return async (input) => {
        count += 1;
        assert.equal(input.cwd, profile);
        if (count === 1) for (const path of first) await put(path);
        for (const path of every) await put(path, path.endsWith('-wal') ? walBody : `x${count}`);
        if (count === 2) for (const path of removed) await rm(join(profile, path), { force: true });
        return { ok: true, models: ['gpt-5.5'], ...(pid === undefined ? {} : { pid }) };
      };
    };
    const setup = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: runs(['.codex/installation_id', '.codex/skills/.system/plugin-creator/references/installing-and-updating.md', '.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py'], []) });
    assert.equal(setup.passed, true, setup.detail);
    assert.deepEqual(setup.touched, [], "a fresh profile's first-run setup is not a listing effect");
    assert.match(setup.detail, /touched nothing/);
    const again = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: runs([], ['.codex/installation_id']) });
    assert.deepEqual([again.passed, again.reasonCode], [false, 'LISTING_SIDE_EFFECT'], 'the same write on the second run still fails');
    const updater = await offer.modelListCheck({ harness: 'antigravity', env: {}, profile, run: runs(['.gemini/antigravity-cli/updater/update.lock'], []) });
    assert.deepEqual([updater.passed, updater.reasonCode], [false, 'LISTING_SELF_UPDATE'], 'an update check on the warm-up still fails');
    assert.match(updater.detail, /updater\/update\.lock/);

    for (const [harness, name] of [['opencode', 'opencode'], ['kilocode', 'kilo']]) {
      const sides = [`.local/share/${name}/${name}.db-shm`, `.local/share/${name}/${name}.db-wal`];
      const db = await offer.modelListCheck({ harness, env: {}, profile, run: runs([`.local/share/${name}/${name}.db`], sides) });
      assert.equal(db.passed, true, db.detail);
      assert.match(db.detail, /touched only caches and logs and allowed side files/);
      const written = await offer.modelListCheck({ harness, env: {}, profile, run: runs([], [...sides, `.local/share/${name}/${name}.db`]) });
      assert.deepEqual([written.passed, written.reasonCode], [false, 'LISTING_SIDE_EFFECT'], 'the database itself must not change');
      assert.match(written.detail, new RegExp(`${name}\\.db(?:,|$)`));
    }
    // B's review, LOW 16: a -wal that holds data after the run is a committed write not yet in the .db.
    const walWrite = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: runs([], ['.local/share/opencode/opencode.db-wal'], undefined, { walBody: 'frame' }) });
    assert.deepEqual([walWrite.passed, walWrite.reasonCode], [false, 'LISTING_SIDE_EFFECT'], 'a non-empty -wal is a database write');
    assert.match(walWrite.detail, /opencode\.db-wal/);
    await put('.local/share/kilo/kilo.db-wal', 'frame');
    const checkpointed = await offer.modelListCheck({ harness: 'kilocode', env: {}, profile, run: runs([], [], undefined, { removed: ['.local/share/kilo/kilo.db-wal'] }) });
    assert.equal(checkpointed.passed, true, `a -wal removed at close was checkpointed: ${checkpointed.detail}`);
    const other = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: runs([], ['.local/share/kilo/kilo.db-wal']) });
    assert.equal(other.passed, false, "only the harness's own database");

    // DOMAINS c78bedef: the second run of the owner's certify of Codex 0.157.1 touched exactly these (paths only, from the evidence file).
    const codexSecondRun = [
      '.codex/.tmp/git-B9TUOt/HEAD',
      '.codex/.tmp/git-B9TUOt/objects',
      '.codex/.tmp/git-B9TUOt/refs',
      '.codex/goals_1.sqlite-shm',
      '.codex/goals_1.sqlite-wal',
      '.codex/logs_2.sqlite',
      '.codex/logs_2.sqlite-shm',
      '.codex/logs_2.sqlite-wal',
      '.codex/memories_1.sqlite-shm',
      '.codex/memories_1.sqlite-wal',
      '.codex/queue_1.sqlite-shm',
      '.codex/queue_1.sqlite-wal',
      '.codex/state_5.sqlite-shm',
      '.codex/state_5.sqlite-wal',
      '.codex/tmp/arg0/codex-arg0FESuDX/.lock',
      '.codex/tmp/arg0/codex-arg0FESuDX/apply_patch',
      '.codex/tmp/arg0/codex-arg0FESuDX/applypatch',
      '.codex/tmp/arg0/codex-arg0FESuDX/codex-execve-wrapper',
      '.codex/tmp/arg0/codex-arg0rtQCEX/.lock',
      '.codex/tmp/arg0/codex-arg0rtQCEX/apply_patch',
      '.codex/tmp/arg0/codex-arg0rtQCEX/applypatch',
      '.codex/tmp/arg0/codex-arg0rtQCEX/codex-execve-wrapper',
    ];
    const codexMains = ['.codex/goals_1.sqlite', '.codex/memories_1.sqlite', '.codex/queue_1.sqlite', '.codex/state_5.sqlite'];
    const codex = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: runs(codexMains, codexSecondRun) });
    assert.equal(codex.passed, true, codex.detail);
    assert.match(codex.detail, /touched only caches and logs and allowed side files/);
    assert.deepEqual(codex.touched, [...codexSecondRun].sort(), "the owner's run's paths are all allowed");
    for (const [label, extra] of [
      ['a main database', '.codex/state_5.sqlite'],
      ['the config', '.codex/config.toml'],
      ['the sign-in', '.codex/auth.json'],
      ['a rules file', '.codex/rules/default.rules'],
      ['a session', '.codex/sessions/2026/09/28/rollout-1.jsonl'],
    ]) {
      const wrote = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: runs([], [...codexSecondRun, extra]) });
      assert.deepEqual([wrote.passed, wrote.reasonCode], [false, 'LISTING_SIDE_EFFECT'], label);
      assert.ok(wrote.detail.includes(extra), label);
    }
    const codexWal = await offer.modelListCheck({ harness: 'codex', env: {}, profile, run: runs([], ['.codex/state_5.sqlite-wal'], undefined, { walBody: 'frame' }) });
    assert.deepEqual([codexWal.passed, codexWal.reasonCode], [false, 'LISTING_SIDE_EFFECT'], "a non-empty -wal of Codex's state database is a database write");

    const own = await offer.modelListCheck({ harness: 'claude', env: {}, profile, run: runs(['.claude/plugins/data/jevris-jevris-local/.keep'], ['.claude/sessions/4242.json', '.claude/sessions/4242.e9788a66bb4e.key'], 4242) });
    assert.equal(own.passed, true, own.detail);
    const foreign = await offer.modelListCheck({ harness: 'claude', env: {}, profile, run: runs([], ['.claude/sessions/4243.json'], 4242) });
    assert.deepEqual([foreign.passed, foreign.reasonCode], [false, 'LISTING_SIDE_EFFECT'], "another process's entry");
    const unknown = await offer.modelListCheck({ harness: 'claude', env: {}, profile, run: runs([], ['.claude/sessions/4244.json']) });
    assert.equal(unknown.passed, false, 'no pid, nothing allowed');

    // Claude Code 2.1.284 (the owner's RC5 run): the second run sweeps the warm-up run's stale register entry
    // (certify ends the warm-up listing) and touches its marketplace lock. Each case gets a fresh folder.
    let box = 0;
    const claudeRuns = async ({ warmPid = 29214, pid = 29228, sweep = true, lock = null, keepStale = false } = {}) => {
      box += 1;
      const base = join(profile, `claude-${box}`);
      await mkdir(base, { recursive: true });
      const at = async (path, body = 'x') => {
        await mkdir(join(base, path, '..'), { recursive: true });
        await writeFile(join(base, path), body);
      };
      const lockPath = '.claude/plugins/known_marketplaces.json.lock';
      let count = 0;
      const run = async () => {
        count += 1;
        if (count === 1) {
          await at(`.claude/sessions/${warmPid}.json`);
          await at(`.claude/sessions/${warmPid}.aef96138e6dd.key`);
          if (lock === 'gone') await at(lockPath, '');
          return { ok: true, models: ['claude-opus-5-5'], pid: warmPid };
        }
        await at(`.claude/sessions/${pid}.json`);
        await at(`.claude/sessions/${pid}.aef96138e6dd.key`);
        if (sweep) for (const file of [`${warmPid}.json`, `${warmPid}.aef96138e6dd.key`]) await rm(join(base, '.claude/sessions', file), { force: true });
        if (keepStale) await at(`.claude/sessions/${warmPid}.json`, 'rewritten');
        if (lock === 'empty') await at(lockPath, '');
        if (lock === 'data') await at(lockPath, 'pid 29228');
        if (lock === 'folder') await mkdir(join(base, lockPath), { recursive: true });
        if (lock === 'full-folder') await at(`${lockPath}/owner`, 'x');
        if (lock === 'gone') await rm(join(base, lockPath), { force: true });
        return { ok: true, models: ['claude-opus-5-5'], pid };
      };
      return offer.modelListCheck({ harness: 'claude', env: {}, profile: base, run });
    };
    const rc5 = await claudeRuns({ lock: 'empty' });
    assert.equal(rc5.passed, true, rc5.detail);
    assert.ok(rc5.touched.includes('.claude/sessions/29214.json'), "the warm-up run's swept entry is among the touched paths");
    for (const lock of ['folder', 'gone', null]) assert.equal((await claudeRuns({ lock })).passed, true, `lock ${lock}`);
    for (const [label, options] of [
      ['a lock that holds data', { lock: 'data' }],
      ['a lock folder with something in it', { lock: 'full-folder' }],
      ["a warm-up entry still there, rewritten", { keepStale: true }],
    ]) {
      const failed = await claudeRuns(options);
      assert.deepEqual([failed.passed, failed.reasonCode], [false, 'LISTING_SIDE_EFFECT'], label);
    }
    const stranger = await claudeRuns({ warmPid: 29214, pid: 29228, sweep: false });
    assert.equal(stranger.passed, true, 'an untouched stale entry is not a write');
  });
});

test('allowedListingWrite names only the owner-allowed second-run writes', () => {
  const allowed = offer.allowedListingWrite;
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db-wal', null, null), true, 'gone afterwards');
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db-wal', null, 0), true, 'empty afterwards');
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db-wal', null, 32), false, 'holds a write');
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db-shm', null, 32768), true, 'the shared-memory index may hold data');
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db-shm', null, null), true);
  assert.equal(allowed('opencode', '.local/share/opencode/opencode.db', null, null), false);
  assert.equal(allowed('opencode', '.local/share/opencode/storage/opencode.db-wal', null, null), false);
  assert.equal(allowed('kilocode', '.local/share/kilo/kilo.db-wal', null, null), true);
  assert.equal(allowed('kilocode', '.local/share/opencode/opencode.db-wal', null, null), false);
  assert.equal(allowed('opencode', 'opencode.db-wal', null, null), false);
  assert.equal(allowed('claude', '.claude/sessions/7.json', 7, null), true);
  assert.equal(allowed('claude', '.claude/sessions/7.abc123.key', 7, null), true);
  assert.equal(allowed('claude', '.claude/sessions/77.json', 7, null), false);
  assert.equal(allowed('claude', '.claude/sessions/7.a.b.key', 7, null), false);
  assert.equal(allowed('claude', '.claude/sessions/7.json', null, null), false);
  assert.equal(allowed('claude', '.claude/sessions/7.json', 0, null), false);
  assert.equal(allowed('claude', 'x/.claude/sessions/7.json', 7, null), false);
  // The warm-up run's entries, only when gone afterwards; the marketplace lock, only gone or empty.
  assert.equal(allowed('claude', '.claude/sessions/5.json', 7, null, 5), true, "the warm-up run's entry, swept");
  assert.equal(allowed('claude', '.claude/sessions/5.abc123.key', 7, null, 5), true);
  assert.equal(allowed('claude', '.claude/sessions/5.json', 7, 40, 5), false, "the warm-up run's entry still there");
  assert.equal(allowed('claude', '.claude/sessions/6.json', 7, null, 5), false, 'another pid');
  assert.equal(allowed('claude', '.claude/sessions/5.json', 7, null, null), false, 'no warm-up pid');
  assert.equal(allowed('claude', '.claude/plugins/known_marketplaces.json.lock', 7, 0), true, 'empty');
  assert.equal(allowed('claude', '.claude/plugins/known_marketplaces.json.lock', 7, null), true, 'gone');
  assert.equal(allowed('claude', '.claude/plugins/known_marketplaces.json.lock', 7, 12), false, 'holds data');
  assert.equal(allowed('claude', '.claude/plugins/known_marketplaces.json', 7, 0), false, 'the list itself');
  assert.equal(allowed('claude', '.claude/plugins/other.json.lock', 7, 0), false, 'only that lock');
  assert.equal(allowed('codex', '.codex/sessions/7.json', 7, null), false);
  // DOMAINS c78bedef: Codex's SQLite side files, its log database and .codex/.tmp, directly in .codex only.
  assert.equal(allowed('codex', '.codex/state_5.sqlite-shm', null, 32768), true);
  assert.equal(allowed('codex', '.codex/state_5.sqlite-wal', null, 0), true, 'empty afterwards');
  assert.equal(allowed('codex', '.codex/state_5.sqlite-wal', null, null), true, 'gone afterwards');
  assert.equal(allowed('codex', '.codex/state_5.sqlite-wal', null, 4096), false, 'holds a write');
  assert.equal(allowed('codex', '.codex/state_5.sqlite', null, 4096), false, 'a main database never');
  assert.equal(allowed('codex', '.codex/logs_2.sqlite', null, 65536), true, 'the log database, as logs');
  assert.equal(allowed('codex', '.codex/logs_2.sqlite-wal', null, 65536), true, "the log database's -wal, as logs");
  assert.equal(allowed('codex', '.codex/logs_2.sqlite-shm', null, 32768), true);
  assert.equal(allowed('codex', '.codex/logs.sqlite', null, 10), false, 'only logs_<n>.sqlite');
  assert.equal(allowed('codex', '.codex/.tmp/git-B9TUOt/HEAD', null, 23), true);
  assert.equal(allowed('codex', '.codex/.tmp', null, null), true);
  assert.equal(allowed('codex', '.codex/sub/state_5.sqlite-shm', null, 0), false, 'directly in .codex only');
  assert.equal(allowed('codex', 'x/.codex/state_5.sqlite-shm', null, 0), false);
  assert.equal(allowed('codex', '.codex/config.toml', null, 10), false);
  assert.equal(allowed('codex', '.codex/auth.json', null, 10), false);
  assert.equal(allowed('codex', '.codex/.tmpx/a', null, 10), false);
  assert.equal(allowed('opencode', '.codex/state_5.sqlite-shm', null, 0), false, "another harness's files");
  assert.equal(allowed('antigravity', '.gemini/antigravity-cli/updater/update.lock', null, null), false);
});

test('certify case: a profile snapshot cut short at its cap fails the check, since it could hide a write', async () => {
  assert.equal(offer.snapshotTruncated(new Map(Array.from({ length: offer.SNAPSHOT_CAP - 1 }, (_, i) => [`f${i}`, '1:1']))), false);
  assert.equal(offer.snapshotTruncated(new Map(Array.from({ length: offer.SNAPSHOT_CAP }, (_, i) => [`f${i}`, '1:1']))), true);
  await withBox(async (profile) => {
    const dir = join(profile, 'many');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < offer.SNAPSHOT_CAP; i += 500) await Promise.all(Array.from({ length: 500 }, (_, j) => writeFile(join(dir, `f${i + j}`), '')));
    const cut = await offer.modelListCheck({ harness: 'opencode', env: {}, profile, run: async () => ({ ok: true, models: ['gpt-5.5'] }) });
    assert.deepEqual([cut.passed, cut.reasonCode], [false, 'LISTING_SNAPSHOT_TRUNCATED']);
    assert.match(cut.detail, /20000 or more entries/);
  });
});

test('touched paths are classified by path only', () => {
  assert.equal(offer.classifyTouchedPath('.cache/opencode/models.json'), 'harmless');
  assert.equal(offer.classifyTouchedPath('.codex/log/codex-tui.log'), 'harmless');
  assert.equal(offer.classifyTouchedPath('.codex/sessions/2026/rollout.jsonl'), 'side-effect');
  assert.equal(offer.classifyTouchedPath('.codex/history.jsonl'), 'side-effect');
  assert.equal(offer.classifyTouchedPath('.local/share/opencode/opencode.db'), 'side-effect');
  assert.equal(offer.classifyTouchedPath('.local/bin/agy'), 'self-update');
  assert.equal(offer.classifyTouchedPath('.codex/version.json'), 'self-update');
  assert.equal(offer.classifyTouchedPath('.codex/installation_id'), 'side-effect', 'an installation id is not an update');
  assert.equal(offer.classifyTouchedPath('.codex/skills/.system/plugin-creator/references/installing-and-updating.md'), 'side-effect');
  assert.equal(offer.classifyTouchedPath('.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py'), 'side-effect');
  for (const name of ['.install', 'install.json', 'installer', '.installed', 'install.lock', 'updater', 'updates']) assert.equal(offer.classifyTouchedPath(`.tool/${name}`), 'self-update', name);
  const before = new Map([['a', '1:1'], ['d', 'dir'], ['gone', '1:1']]);
  const after = new Map([['a', '2:2'], ['d', 'dir'], ['new', '1:1']]);
  assert.deepEqual(offer.touchedPaths(before, after), ['a', 'gone', 'new']);
  assert.deepEqual(offer.touchedPaths(new Map(), new Map([['s', 'dir'], ['s/x', 'dir'], ['e', 'dir']])), ['e', 's/x'], 'an empty new folder is named; a parent of one is not');
});

test('doctor line: lists its models only when certified and on; otherwise a model becomes eligible after it has run once', () => {
  const row = (harness, certifiedFeatures) => ({ harness, certifiedFeatures, certifyCommand: `jevris certify --harness ${harness}` });
  assert.equal(offer.modelListingLine(row('claude', ['worker.route']), 'on'), 'harness claude models: cannot list models; a model becomes eligible after it has run once (models.list is not certified here; fix: jevris certify --harness claude)');
  assert.equal(offer.modelListingLine(row('codex', ['models.list']), 'on'), 'harness codex models: lists its models (refreshed by the sidecar while idle, no model call)');
  assert.equal(offer.modelListingLine(row('codex', ['models.list']), 'off'), 'harness codex models: cannot list models; a model becomes eligible after it has run once (routing.modelListing is off)');
  assert.equal(offer.modelListingLine(row('opencode', []), 'on'), 'harness opencode models: cannot list models; a model becomes eligible after it has run once (models.list is not certified here; fix: jevris certify --harness opencode)');
});

test('an upgrade re-checks a record that predates models.list once, in the background, Claude Code included (G13), and never when the record lists it as failed (DOMAINS d7856f5)', async () => {
  await withBox(async (home) => {
    assert.deepEqual(NEWER_FEATURES, ['worker.route', 'models.list']);
    assert.deepEqual(newerFeaturesFor('claude'), ['worker.route', 'models.list']);
    assert.deepEqual(newerFeaturesFor('opencode'), ['worker.route', 'models.list']);
    const base = ['plugin.install', 'mcp.tools', 'hooks.observe', 'worker.route'];
    const run = async (harness, version, features, extra = []) => {
      const load = coveringLoad(harness, version, features);
      for (const item of extra) load.records[0].record.features.push(item);
      const jobs = [];
      const states = await maybeReverify({ home, root: home, installed: [harness], versions: { [harness]: version }, load, nowMs: NOW, start: async (job) => (jobs.push(job), true), guard: () => null });
      return { states: states.map((item) => [item.state, item.reason]), jobs: jobs.length };
    };
    assert.deepEqual(await run('opencode', '1.18.32', base), { states: [['started', 'new-feature']], jobs: 1 }, 'a record without models.list is re-checked');
    assert.deepEqual(await run('opencode', '1.18.32', base), { states: [['running', 'new-feature']], jobs: 0 }, 'exactly once');
    assert.deepEqual(await run('claude', '2.1.283', base), { states: [['started', 'new-feature']], jobs: 1 }, 'Claude Code lists now, so its record is re-checked too');
    assert.deepEqual(await run('codex', '0.157.1', base, [{ featureId: 'models.list', status: 'unsupported', reasonCode: 'LISTING_SIDE_EFFECT' }]), { states: [], jobs: 0 }, 'a failed listing stays off; no re-check loop');
    assert.deepEqual(await run('kilocode', '7.7.9', [...base, 'models.list']), { states: [], jobs: 0 });
  });
});

test('doctor eligibility (C 8b4b851): one keyed info line per harness and sign-in; every model with --harness; a listing counts only within the harness map', async () => {
  const { recordModelListing, recordModelRun } = await import('@jevris/core');
  const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
  await withBox(async (home) => {
    const fresh = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription' }], false);
    assert.equal(fresh.length, 1);
    assert.match(fresh[0], /^harness claude eligibility \(subscription sign-in\): no model is eligible yet; not eligible: (?:NOT_ON_HARNESS \d+, )?NO_LOCAL_EVIDENCE \d+/);
    assert.equal(await recordModelRun(home, { harness: 'claude', authMode: 'subscription', modelId: 'claude-opus-5-5', nowMs: NOW }), true);
    assert.equal(await recordModelListing(home, { harness: 'codex', authMode: 'subscription', result: { ok: true, version: '0.157.1', models: ['claude-opus-5-5'] }, nowMs: NOW }), true);
    const lines = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription' }, { harness: 'claude', authMode: 'api-key' }, { harness: 'codex', authMode: 'subscription' }], false);
    assert.match(lines[0], /^harness claude eligibility \(subscription sign-in\): eligible: claude-opus-5-5;/);
    assert.match(lines[1], /^harness claude eligibility \(api-key sign-in\): no model is eligible yet/, 'a run under another sign-in does not count');
    assert.doesNotMatch(lines[2], /eligible: claude-opus-5-5/, 'Codex has no map entry for Anthropic, so its listing does not make a Claude model eligible');
    const detail = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription' }], true);
    assert.ok(detail.length > 2);
    assert.ok(detail.some((line) => line.startsWith('harness claude eligibility (subscription sign-in): claude-opus-5-5 is eligible: it has run on claude')));
    for (const line of [...lines, ...detail]) assert.equal(doctorLineSeverity(line), 'info', line);
    assert.deepEqual(await offer.eligibilityDoctorLines(home, [], true), []);
  });
});

test('owner decision 2026-10-08: doctor shows Claude Code\'s alias models as eligible for subagent routes only once hooks.route is certified, as their own reason', async () => {
  const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
  await withBox(async (home) => {
    const [off] = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription', aliasCertified: false }], false);
    assert.match(off, /no model is eligible yet/);
    assert.doesNotMatch(off, /HARNESS_ALIAS/);
    const [on] = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription', aliasCertified: true, harnessVersion: '2.1.294' }], false);
    assert.match(on, /eligible: claude-/);
    const via = /eligible because Claude Code resolves its family alias, for subagent routes only \(HARNESS_ALIAS\): ([^;]*)/.exec(on)?.[1].split(', ');
    assert.deepEqual([...via].sort(), ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], 'the model each family alias means, and no older release');
    assert.equal(doctorLineSeverity(on), 'info');
    const detail = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription', aliasCertified: true, harnessVersion: '2.1.294' }], true);
    assert.ok(detail.some((line) => /claude-haiku-5-5 is eligible for a subagent route: Claude Code's own family alias resolves to it on claude with subscription sign-in, and hooks.route is certified for the installed version \(HARNESS_ALIAS\)/.test(line)), detail.join('\n'));
    // Amended 2026-10-08: on Claude Code 2.1.292 `haiku` still means Haiku 4.5, so Haiku 5.5 is not offered through the alias and doctor says what to do.
    const old = await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription', aliasCertified: true, harnessVersion: '2.1.292' }], false);
    const via292 = /\(HARNESS_ALIAS\): ([^;]*)/.exec(old[0])?.[1].split(', ');
    assert.deepEqual([...via292].sort(), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.equal(old.length, 2);
    assert.match(old[1], /^harness claude eligibility \(subscription sign-in\): Claude Code 2\.1\.292 may map the haiku alias to an older model; update to 2\.1\.293 or later/);
    assert.equal(doctorLineSeverity(old[1]), 'info');
    // A version that is not known makes no claim of its own (nothing is certified without one).
    assert.equal((await offer.eligibilityDoctorLines(home, [{ harness: 'claude', authMode: 'subscription', aliasCertified: false }], false)).length, 1);
    // No other harness gets the proof, whatever the flag says.
    const [codex] = await offer.eligibilityDoctorLines(home, [{ harness: 'codex', authMode: 'subscription', aliasCertified: true }], false);
    assert.doesNotMatch(codex, /HARNESS_ALIAS/);
  });
});

test('G13: Claude Code lists through one initialize control request on an idle print session; no user turn, no account read', async () => {
  await withBox(async (dir) => {
    const command = await stubCommand(dir);
    const listed = await offer.runModelListing({ harness: 'claude', command, env: { ...process.env, STUB_MODE: 'ok' }, cwd: dir });
    assert.deepEqual({ ...listed, pid: undefined }, { ok: true, models: ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-5'], pid: undefined }, 'resolved ids and full ids only; aliases without one are left out');
    assert.equal(Number.isSafeInteger(listed.pid), true, "the listing process's pid, for certify's session register check");
    assert.equal(JSON.stringify(listed).includes('example.invalid'), false, 'the account is never read');
    const failed = await offer.runModelListing({ harness: 'claude', command, env: { ...process.env, STUB_MODE: 'error' }, cwd: dir });
    assert.deepEqual(failed, { ok: false, reasonCode: 'LISTING_FAILED' });
    const missing = await offer.runModelListing({ harness: 'claude', command: { file: join(dir, 'no-such-claude') }, env: process.env, cwd: dir });
    assert.deepEqual(missing, { ok: false, reasonCode: 'HARNESS_NOT_INSTALLED' });
  });
  assert.deepEqual(offer.parseClaudeInitialize({ models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5' }, { value: 'x' }] }), ['claude-opus-5-5']);
  assert.equal(offer.parseClaudeInitialize({ commands: [] }), null);
  assert.equal(offer.parseClaudeInitialize({ models: ['opus'] }), null);
});

// OP-6 (owner decision DOMAINS 9deb30c8): the Codex usage read, read-only, inside the listing.
const USAGE_RESET = Math.floor(NOW / 1000) + 3600;
const codexUsage = (dir, extra = {}) => list(dir, {
  harness: 'codex',
  load: coveringLoad('codex', '0.157.1'),
  codexLogin: async () => 'subscription',
  ...extra,
  env: { STUB_VERSION: '0.157.1\n', USAGE_RESET: String(USAGE_RESET), USAGE_MARK: join(dir, 'usage-mark.json'), ...(extra.env ?? {}) },
});
const exists = async (file) => (await import('node:fs/promises')).access(file).then(() => true, () => false);

test('OP-6 parse: only the two windows and ordinaryUsageAllowed leave the payload; extra fields and email-shaped text never do', () => {
  const payload = {
    ordinaryUsageAllowed: true,
    accountId: 'acct-person@example.invalid',
    rateLimitUpsell: { title: 'person@example.invalid' },
    rateLimits: {
      limitName: 'person@example.invalid',
      planType: 'plus',
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790000000, note: 'person@example.invalid' },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: '17.50' },
    },
  };
  const read = offer.parseCodexRateLimits(payload);
  assert.deepEqual(read, {
    windows: [
      { usedPercent: 42, windowMinutes: 300, resetsAtMs: 1790000000000 },
      { usedPercent: 100, windowMinutes: 10080, resetsAtMs: null },
    ],
    ordinaryUsageAllowed: true,
  });
  const text = JSON.stringify(read);
  for (const leak of ['@', 'example', 'plus', 'acct', '17.50', 'note', 'balance']) assert.equal(text.includes(leak), false, `nothing of the payload but the five fields: ${leak}`);
  assert.deepEqual(offer.parseCodexRateLimits({ rateLimits: { primary: null, secondary: { usedPercent: 7, windowDurationMins: null, resetsAt: null } } }), { windows: [{ usedPercent: 7, windowMinutes: null, resetsAtMs: null }], ordinaryUsageAllowed: null }, 'an absent flag is null, never a guess');
  for (const bad of [
    null,
    { rateLimits: null },
    { rateLimits: {} },
    { rateLimits: { primary: { usedPercent: 'lots' } } },
    { rateLimits: { primary: { usedPercent: -1 } } },
    { rateLimits: { primary: { usedPercent: 5, resetsAt: 17.5 } } },
    { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 0 } } },
    { rateLimits: { primary: { usedPercent: 5 }, secondary: 'x' } },
    { ordinaryUsageAllowed: 'yes', rateLimits: { primary: { usedPercent: 5 } } },
  ]) assert.equal(offer.parseCodexRateLimits(bad), null, `malformed drops the reading: ${JSON.stringify(bad)}`);
});

test('OP-6 sign-in: the read is sent only on a ChatGPT login with no Codex or OpenAI key in the environment', async () => {
  const login = (mode) => async () => mode;
  assert.equal(await offer.codexUsageSignIn({}, login('subscription')), 'subscription');
  assert.equal(await offer.codexUsageSignIn({ CODEX_API_KEY: 'x' }, login('subscription')), null);
  assert.equal(await offer.codexUsageSignIn({ OPENAI_API_KEY: 'x' }, login('subscription')), null);
  assert.equal(await offer.codexUsageSignIn({ OPENAI_API_KEY: '' }, login('subscription')), 'subscription', 'an empty variable is no key');
  for (const mode of ['api-key', 'signed-out', 'unknown', 'not-probed']) assert.equal(await offer.codexUsageSignIn({}, login(mode)), null, mode);
  assert.equal(await offer.codexUsageSignIn({}, async () => { throw new Error('boom'); }), null);
  await withBox(async (dir) => {
    const keyed = await codexUsage(dir, { env: { CODEX_API_KEY: 'test-only-not-a-key' } });
    assert.deepEqual(keyed, { ok: true, version: '0.157.1', models: ['gpt-5.5', 'gpt-5.5-mini'] });
    assert.equal(await exists(join(dir, 'usage-mark.json')), false, 'an API-key listing sends no usage read');
    const probed = await list(dir, { harness: 'codex', load: coveringLoad('codex', '0.157.1'), env: { STUB_VERSION: '0.157.1\n', USAGE_MARK: join(dir, 'usage-mark.json') } });
    assert.equal(probed.ok, true);
    assert.equal(await exists(join(dir, 'usage-mark.json')), false, 'in a test run the login is not probed, so nothing is read');
  });
});

test('OP-6 record: an exhausted weekly window sets a timed Codex usage window; the reading keeps bands only; uncertified never lifts', async () => {
  const core = await import('@jevris/core');
  await withBox(async (dir) => {
    const listed = await codexUsage(dir, { env: { USAGE_MODE: 'exhausted' } });
    assert.deepEqual(listed, { ok: true, version: '0.157.1', models: ['gpt-5.5', 'gpt-5.5-mini'], usage: { recorded: true, lifted: 0 } });
    assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'usage-mark.json'), 'utf8')), { excludeResetCreditDetails: true }, 'the background-poll form: no reset-credit lookup, no Luna Reserve opt-in');
    const kept = await core.readAccessUsageReadings(dir, NOW);
    assert.equal(kept.readable, true);
    assert.deepEqual(kept.readings.map((r) => [r.harness, r.authMode, r.allowed, r.windows.map((w) => [w.weekly, w.band])]), [['codex', 'subscription', true, [[false, 'under-50'], [true, 'exhausted']]]]);
    const files = await (await import('node:fs/promises')).readdir(join(jevrisPaths({ home: dir }).data, 'route-learning'));
    for (const name of files) {
      const body = await (await import('node:fs/promises')).readFile(join(jevrisPaths({ home: dir }).data, 'route-learning', name), 'utf8');
      assert.equal(/@|example\.invalid|17\.50|plus/.test(body), false, `${name} keeps nothing of the payload`);
    }
    // Uncertified (no access.usage-read yet): a later reading with nothing exhausted lifts nothing.
    const later = await codexUsage(dir, { env: { USAGE_MODE: 'ok' } });
    assert.deepEqual(later.usage, { recorded: false, lifted: 0 });
  });
});

test('OP-6 bounds: a hung, failed or malformed usage read leaves the listing ok within its 3 s sub-bound', async () => {
  await withBox(async (dir) => {
    for (const mode of ['error', 'malformed']) {
      assert.deepEqual(await codexUsage(dir, { env: { USAGE_MODE: mode } }), { ok: true, version: '0.157.1', models: ['gpt-5.5', 'gpt-5.5-mini'] }, mode);
    }
    const started = Date.now();
    const hung = await codexUsage(dir, { env: { USAGE_MODE: 'hang' } });
    const took = Date.now() - started;
    assert.deepEqual(hung, { ok: true, version: '0.157.1', models: ['gpt-5.5', 'gpt-5.5-mini'] });
    assert.ok(took >= offer.CODEX_USAGE_READ_TIMEOUT_MS - 100 && took < offer.CODEX_USAGE_READ_TIMEOUT_MS + 5_000, `a hung read waits its 3 s sub-bound, then the models stand (${took} ms)`);
    const command = await stubCommand(dir);
    const quick = await offer.runModelListing({ harness: 'codex', command, env: { ...process.env, USAGE_MODE: 'hang' }, usageRead: true, usageReadTimeoutMs: 50 });
    assert.deepEqual(quick, { ok: true, models: ['gpt-5.5', 'gpt-5.5-mini'] });
    const without = await offer.runModelListing({ harness: 'codex', command, env: { ...process.env, USAGE_MODE: 'exhausted', USAGE_MARK: join(dir, 'unasked.json') } });
    assert.deepEqual(without, { ok: true, models: ['gpt-5.5', 'gpt-5.5-mini'] });
    assert.equal(await exists(join(dir, 'unasked.json')), false, 'no read unless asked for');
  });
});

// K21 (DOMAINS 3298853d): only a signed access.usage-read record for the installed version lets a
// reading lift a window; an unsupported record (Windows, ACCESS_USAGE_ISOLATION_UNAVAILABLE) never does.
test('K21: a certified usage read lifts the window an earlier reading set; an unsupported record for the same version does not', async () => {
  const unsupportedLoad = () => {
    const load = coveringLoad('codex', '0.157.1');
    const record = { ...load.records[0].record, features: [...load.records[0].record.features, { featureId: 'access.usage-read', status: 'unsupported', reasonCode: 'ACCESS_USAGE_ISOLATION_UNAVAILABLE' }] };
    return { ...load, records: [{ record, trust: 'local' }] };
  };
  const later = NOW + 10 * 60_000;
  await withBox(async (dir) => {
    assert.deepEqual((await codexUsage(dir, { env: { USAGE_MODE: 'exhausted' } })).usage, { recorded: true, lifted: 0 });
    const kept = await codexUsage(dir, { env: { USAGE_MODE: 'ok' }, load: unsupportedLoad(), nowMs: later });
    assert.deepEqual(kept.usage, { recorded: false, lifted: 0 }, 'unsupported never certifies, so nothing lifts');
    const other = await codexUsage(dir, { env: { USAGE_MODE: 'ok' }, load: coveringLoad('codex', '0.158.0', ['models.list', 'access.usage-read']), nowMs: later });
    assert.equal(other.ok, false, 'a record for another version does not even cover the listing');
    const lifted = await codexUsage(dir, { env: { USAGE_MODE: 'ok' }, load: coveringLoad('codex', '0.157.1', ['models.list', 'access.usage-read']), nowMs: later });
    assert.deepEqual(lifted.usage, { recorded: false, lifted: 1 }, 'certified for this version: the window lifts');
  });
  const unsupported = unsupportedLoad();
  assert.equal(offer.usageReadCertified(unsupported, '0.157.1', NOW), false);
  assert.equal(offer.usageReadCertified(coveringLoad('codex', '0.157.1', ['access.usage-read']), '0.157.1', NOW), true);
  assert.equal(offer.usageReadCertified(coveringLoad('codex', '0.157.1', ['access.usage-read']), '0.157.1', NOW, 'win32'), process.platform === 'win32', 'another OS is not covered');
});

// ---- SQLite side files: a warm-up run's leftover write-ahead frames are not the second run's writes ----

const Sqlite = createRequire(import.meta.url)('better-sqlite3');

/**
 * A database as a killed harness leaves it: rows committed to the write-ahead log, not yet
 * checkpointed into the `.db` (the copies are taken while the writer still holds the log).
 */
function leaveUncheckpointed(path, rows = 3) {
  const seed = new Sqlite(path);
  seed.pragma('journal_mode = WAL');
  seed.exec('CREATE TABLE IF NOT EXISTS t (n INTEGER)');
  seed.close();
  const db = new Sqlite(path);
  db.pragma('wal_autocheckpoint = 0');
  for (let i = 0; i < rows; i += 1) db.prepare('INSERT INTO t VALUES (?)').run(i);
  copyFileSync(path, `${path}.keep`);
  copyFileSync(`${path}-wal`, `${path}-wal.keep`);
  db.close();
  copyFileSync(`${path}.keep`, path);
  copyFileSync(`${path}-wal.keep`, `${path}-wal`);
  return () => {
    for (const suffix of ['.keep', '-wal.keep', '-shm']) rmSyncQuiet(`${path}${suffix}`);
  };
}

function rmSyncQuiet(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

/** A stand-in listing: the first call runs `first`, the second `second`; both answer with one model. */
function twice(first, second) {
  let count = 0;
  return async () => {
    count += 1;
    await (count === 1 ? first : second)();
    return { ok: true, models: ['gpt-5.5'] };
  };
}

test('certify case: SQLite frames the warm-up left in a write-ahead log do not fail the second run (Kilo, OpenCode, Codex)', async () => {
  for (const [harness, rel] of [
    ['kilocode', '.local/share/kilo/kilo.db'],
    ['opencode', '.local/share/opencode/opencode.db'],
    ['codex', '.codex/state_5.sqlite'],
  ]) {
    await withBox(async (profile) => {
      const path = join(profile, ...rel.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      // The second run only opens the database and closes it, which checkpoints the warm-up's frames.
      const readOnly = async () => {
        const db = new Sqlite(path);
        db.prepare('SELECT count(*) FROM t').get();
        db.close();
      };
      const result = await offer.modelListCheck({ harness, env: {}, profile, run: twice(async () => leaveUncheckpointed(path), readOnly) });
      assert.equal(result.passed, true, `${harness}: ${result.detail}`);
      assert.ok(!result.touched.includes(rel), `${harness}: the main database did not change on the second run`);
    });
  }
});

test('certify case: a genuine row written on the second run still fails, closed cleanly or left in the log', async () => {
  for (const [harness, rel] of [
    ['kilocode', '.local/share/kilo/kilo.db'],
    ['opencode', '.local/share/opencode/opencode.db'],
    ['codex', '.codex/state_5.sqlite'],
  ]) {
    for (const hold of [false, true]) {
      await withBox(async (profile) => {
        const path = join(profile, ...rel.split('/'));
        await mkdir(join(path, '..'), { recursive: true });
        const held = [];
        const writes = async () => {
          const db = new Sqlite(path);
          db.pragma('wal_autocheckpoint = 0');
          db.prepare('INSERT INTO t VALUES (99)').run();
          if (hold) held.push(db);
          else db.close();
        };
        try {
          // The warm-up leaves frames too: the fix must fold them in without hiding this write.
          const result = await offer.modelListCheck({ harness, env: {}, profile, run: twice(async () => leaveUncheckpointed(path), writes) });
          assert.deepEqual([result.passed, result.reasonCode], [false, 'LISTING_SIDE_EFFECT'], `${harness} hold=${hold}: ${result.detail}`);
          assert.match(result.detail, hold ? /-wal/ : /\.(?:db|sqlite)(?:,|$)/);
        } finally {
          for (const db of held) db.close();
        }
      });
    }
  }
});

test('certify case: a second run that writes a row to a database with no leftover log fails as before', async () => {
  await withBox(async (profile) => {
    const path = join(profile, '.local', 'share', 'kilo', 'kilo.db');
    await mkdir(join(path, '..'), { recursive: true });
    const seed = new Sqlite(path);
    seed.pragma('journal_mode = WAL');
    seed.exec('CREATE TABLE t (n INTEGER)');
    seed.close();
    const insert = async () => {
      const db = new Sqlite(path);
      db.prepare('INSERT INTO t VALUES (1)').run();
      db.close();
    };
    const result = await offer.modelListCheck({ harness: 'kilocode', env: {}, profile, run: twice(async () => undefined, insert) });
    assert.deepEqual([result.passed, result.reasonCode], [false, 'LISTING_SIDE_EFFECT']);
  });
});

test('checkpointProfileDatabases folds the log into the database inside the profile only and skips what is not a database', async () => {
  await withBox(async (profile) => {
    const other = await mkdtemp(join(tmpdir(), 'jevris-model-offer-outside-'));
    try {
      const inside = join(profile, 'a.db');
      const outside = join(other, 'b.db');
      const cleanup = [leaveUncheckpointed(inside), leaveUncheckpointed(outside)];
      // A text file named like a database, with a non-empty log beside it, is never opened.
      await writeFile(join(profile, 'fake.db'), 'not a database');
      await writeFile(join(profile, 'fake.db-wal'), 'frame');
      // A log with no database beside it, and an empty log, are ignored.
      await writeFile(join(profile, 'lone.db-wal'), 'frame');
      await writeFile(join(profile, 'empty.db'), 'x');
      await writeFile(join(profile, 'empty.db-wal'), '');
      const count = await offer.checkpointProfileDatabases(profile, await offer.snapshotTree(profile));
      assert.equal(count, 1);
      assert.equal(existsSync(`${inside}-wal`) ? statSync(`${inside}-wal`).size : 0, 0, 'the log in the profile is folded in');
      assert.ok(statSync(`${outside}-wal`).size > 0, 'a database outside the profile is untouched');
      assert.equal(readFileSync(join(profile, 'fake.db'), 'utf8'), 'not a database');
      // The rows survived the checkpoint.
      const db = new Sqlite(inside, { readonly: true });
      assert.equal(db.prepare('SELECT count(*) AS c FROM t').get().c, 3);
      db.close();
      for (const run of cleanup) run();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

test('checkpointProfileDatabases does nothing for a snapshot with no log', async () => {
  assert.equal(await offer.checkpointProfileDatabases('/nonexistent-profile', new Map([['a.db', '10:1']])), 0);
});

// ---- Antigravity: the documented update opt-out, and its startup side files ----

test('the Antigravity listing sets its documented update opt-out to the literal true; no other harness gets it', () => {
  const env = offer.listingEnv('antigravity', { HOME: '/x', KEEP: 'y' });
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true', 'agy honours only the literal true, not 1');
  assert.equal(env.HOME, '/x');
  assert.equal(env.KEEP, 'y');
  for (const harness of ['claude', 'codex', 'opencode', 'kilocode']) assert.equal(offer.listingEnv(harness, {}).AGY_CLI_DISABLE_AUTO_UPDATE, undefined, harness);
});

test('Antigravity: its conversation database side files and MCP descriptor cache are allowed; the updater and real data are not', async () => {
  const allowed = offer.allowedListingWrite;
  const dir = '.gemini/antigravity-cli';
  assert.equal(allowed('antigravity', `${dir}/conversation_summaries.db-shm`, null, 32768), true);
  assert.equal(allowed('antigravity', `${dir}/conversation_summaries.db-wal`, null, 0), true);
  assert.equal(allowed('antigravity', `${dir}/conversation_summaries.db-wal`, null, 4096), false, 'a log that holds a write');
  assert.equal(allowed('antigravity', `${dir}/conversation_summaries.db`, null, 4096), false, 'the database itself');
  assert.equal(allowed('antigravity', `${dir}/mcp/jevris_jevris/jevris_advise.json`, null, 900), true);
  assert.equal(allowed('antigravity', `${dir}/mcp/jevris_jevris/instructions.md`, null, 900), true);
  assert.equal(allowed('antigravity', `${dir}/mcp/jevris_jevris/oauth_token.json`, null, 90), false, 'a credential-looking name');
  assert.equal(allowed('antigravity', `${dir}/mcp/jevris_jevris/notes.txt`, null, 90), false);
  assert.equal(allowed('antigravity', `${dir}/mcp/jevris_jevris/sub/x.json`, null, 90), false);
  assert.equal(allowed('antigravity', `${dir}/settings.json`, null, 90), false, 'config');
  assert.equal(allowed('antigravity', `${dir}/conversations/1.pb`, null, 90), false, 'a conversation');
  assert.equal(allowed('antigravity', `x/${dir}/conversation_summaries.db-shm`, null, 0), false);
  assert.equal(allowed('kilocode', `${dir}/conversation_summaries.db-shm`, null, 0), false, "another harness's files");
  assert.equal(offer.classifyTouchedPath(`${dir}/updater/update.lock`), 'self-update');
  assert.equal(offer.classifyTouchedPath(`${dir}/updater/update_status.json`), 'self-update');
  assert.equal(offer.classifyTouchedPath(`${dir}/cli.log`), 'harmless');
  assert.equal(offer.classifyTouchedPath(`${dir}/log/cli-20260930_014442.log`), 'harmless');
  // Codex's per-process helper folder (codex-rs/arg0: <CODEX_HOME>/tmp/arg0/codex-arg0*) is a temporary folder.
  for (const file of ['.lock', 'apply_patch', 'applypatch', 'codex-execve-wrapper']) assert.equal(offer.classifyTouchedPath(`.codex/tmp/arg0/codex-arg08ZsOkq/${file}`), 'harmless', file);

  await withBox(async (profile) => {
    const put = async (path, body) => {
      await mkdir(join(profile, path, '..'), { recursive: true });
      await writeFile(join(profile, path), body);
    };
    // The owner's run of agy, minus the update files (paths from the evidence file).
    const secondRun = [
      `${dir}/cli.log`,
      `${dir}/conversation_summaries.db-shm`,
      `${dir}/log/cli-20260930_014442.log`,
      `${dir}/mcp/jevris_jevris/instructions.md`,
      `${dir}/mcp/jevris_jevris/jevris_advise.json`,
      `${dir}/mcp/jevris_jevris/jevris_status.json`,
    ];
    let count = 0;
    const run = (extra) => async () => {
      count += 1;
      for (const path of [...secondRun, ...extra]) await put(path, `x${count}`);
      return { ok: true, models: ['gemini-3.8-flash'] };
    };
    const ok = await offer.modelListCheck({ harness: 'antigravity', env: {}, profile, run: run([]) });
    assert.equal(ok.passed, true, ok.detail);
    const updating = await offer.modelListCheck({ harness: 'antigravity', env: {}, profile, run: run([`${dir}/updater/update.lock`]) });
    assert.deepEqual([updating.passed, updating.reasonCode], [false, 'LISTING_SELF_UPDATE'], 'an updater file still fails it');
    const session = await offer.modelListCheck({ harness: 'antigravity', env: {}, profile, run: run([`${dir}/conversations/1.pb`]) });
    assert.deepEqual([session.passed, session.reasonCode], [false, 'LISTING_SIDE_EFFECT'], 'a conversation still fails it');
  });
});
