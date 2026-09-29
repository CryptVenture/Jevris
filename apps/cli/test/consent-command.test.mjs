// R30 and OD-4 (owner decisions DOMAINS 7be3c43, 38be7b5): `jevris consent provider` lists each
// provider's consent state and why, grants only from an interactive terminal after showing the
// training term and storage location and a typed phrase, and revokes without a terminal. Fake
// sidecar ports only: nothing is stored and no harness runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runConsentCommand, checkConsentStatus, consentViews, CONSENT_HELP } = await import('../dist/consent-command.js');
const { PROVIDER_CONSENT_TEXT, providerConsentPhrase } = await import('../../../packages/contracts/dist/index.js');

const DAY = Date.parse('2026-09-27T12:00:00Z');

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-consent-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { home, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0', USER: 'dev' }, cwd: dir };
}

function fakePorts(answers) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure() {
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push(input);
          const answer = answers[input.op];
          return typeof answer === 'function' ? answer(input) : (answer ?? { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' });
        },
      },
      engine: {},
      config: {},
    },
  };
}

async function run(box, argv, ports, extra = {}) {
  let text = '';
  const code = await runConsentCommand(argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.cwd, ...extra });
  return { code, text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

const granted = (provider, current = true) => ({ provider, state: 'granted', textVersion: current ? PROVIDER_CONSENT_TEXT[provider].version : 'old-1', grantedAtMs: DAY, revokedAtMs: null, revokedBy: null, current });
const status = (rows) => ({ ok: true, result: { providers: rows } });

test('the consent text names a version, the training term, the storage location and a dated source for each provider', () => {
  for (const id of ['deepseek', 'moonshot']) assert.equal(PROVIDER_CONSENT_TEXT[id].alwaysRequired, true, id);
  for (const id of ['anthropic', 'openai', 'google', 'xai', 'zai']) assert.equal(PROVIDER_CONSENT_TEXT[id].alwaysRequired, false, id);
  for (const [id, text] of Object.entries(PROVIDER_CONSENT_TEXT)) {
    assert.match(id, /^[a-z][a-z0-9-]{0,31}$/);
    assert.match(text.version, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
    assert.ok(text.version.startsWith(`${id}-`), id);
    for (const key of ['name', 'training', 'storage', 'source']) assert.ok(typeof text[key] === 'string' && text[key].length > (key === 'name' ? 2 : 20), `${id}.${key}`);
    assert.match(text.source, /\d{4}-\d{2}-\d{2}/, `${id}: a dated source`);
  }
  assert.match(PROVIDER_CONSENT_TEXT.deepseek.storage, /People's Republic of China/);
  assert.match(PROVIDER_CONSENT_TEXT.moonshot.storage, /Singapore/);
  assert.equal(providerConsentPhrase('deepseek'), 'consent to deepseek');
});

test('the list shows each provider state and why (OD-4)', async (t) => {
  const box = sandbox(t);
  const revoked = { provider: 'openai', state: 'revoked', textVersion: PROVIDER_CONSENT_TEXT.openai.version, grantedAtMs: DAY - 86_400_000, revokedAtMs: DAY, revokedBy: 'user', current: false };
  const fake = fakePorts({ 'provider.consent.status': status([granted('deepseek'), granted('moonshot', false), granted('google', false), revoked]) });
  const listed = await run(box, ['provider', '--json'], fake.ports);
  assert.equal(listed.code, 0, listed.text);
  const by = Object.fromEntries(listed.json.providers.map((v) => [v.provider, v]));
  assert.equal(by.deepseek.state, 'granted');
  assert.equal(by.moonshot.state, 'required', 'a grant for an older text is not consent');
  assert.match(by.moonshot.why, /text changed/);
  assert.equal(by.google.state, 'required', 'a stale grant blocks a passed provider too, until given again (C)');
  assert.equal(by.openai.state, 'revoked');
  assert.match(by.openai.why, /even while you are signed in/, 'a revoke overrides the signed-in default (C)');
  assert.equal(by.xai.state, 'signed-in-default');
  assert.equal(by.zai.state, 'signed-in-default');
  assert.equal(fake.calls[0].op, 'provider.consent.status');
  assert.equal(fake.calls[0].scope, 'cli');

  const text = await run(box, ['provider'], fakePorts({ 'provider.consent.status': status([]) }).ports);
  assert.equal(text.code, 0);
  assert.match(text.text, /^deepseek \(DeepSeek\): consent required: its terms train on what it receives by default/m);
  assert.match(text.text, /^openai \(OpenAI\): signed-in default: allowed while you are signed in to it on an installed harness/m);

  const one = await run(box, ['provider', 'deepseek'], fakePorts({ 'provider.consent.status': status([]) }).ports);
  assert.match(one.text, /^training: /m);
  assert.match(one.text, /^storage: People's Republic of China/m);
  assert.match(one.text, /^source: DeepSeek privacy policy, last updated 2026-02-10/m);
});

test('a grant needs an interactive terminal and the typed phrase, and names the text version shown', async (t) => {
  const box = sandbox(t);
  const answers = {
    'provider.consent.status': status([]),
    'provider.consent.grant': (input) => ({ ok: true, result: { result: 'granted', provider: input.body.provider, textVersion: input.body.textVersion } }),
  };

  const piped = fakePorts(answers);
  const noTty = await run(box, ['provider', 'deepseek', '--grant'], piped.ports, { interactive: () => false });
  assert.equal(noTty.code, 2);
  assert.match(noTty.text, /interactive terminal/);
  assert.equal(piped.calls.length, 0, 'nothing is asked of the sidecar without a person');

  const underTest = fakePorts(answers);
  const refusedTest = await run({ ...box, env: { ...box.env, JEVRIS_TEST: '1' } }, ['provider', 'deepseek', '--grant'], underTest.ports, { interactive: () => true, readLine: async () => 'consent to deepseek' });
  assert.equal(refusedTest.code, 2, 'never from a test run');
  assert.equal(underTest.calls.length, 0);

  const wrong = fakePorts(answers);
  const mismatch = await run(box, ['provider', 'deepseek', '--grant'], wrong.ports, { interactive: () => true, readLine: async () => 'yes' });
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.text, /training: .*storage: People's Republic of China/s, 'the terms are shown before the question');
  assert.equal(wrong.calls.some((c) => c.op === 'provider.consent.grant'), false);

  const person = fakePorts(answers);
  let prompt = '';
  const ok = await run(box, ['provider', 'deepseek', '--grant'], person.ports, { interactive: () => true, readLine: async (p) => ((prompt = p), 'consent to deepseek') });
  assert.equal(ok.code, 0, ok.text);
  assert.match(prompt, /Type "consent to deepseek"/);
  const grant = person.calls.find((c) => c.op === 'provider.consent.grant');
  assert.deepEqual(grant.body, { provider: 'deepseek', textVersion: PROVIDER_CONSENT_TEXT.deepseek.version, channel: 'terminal', actor: 'dev' });
  assert.match(ok.text, /Consent to DeepSeek granted/);

  const stale = fakePorts({ ...answers, 'provider.consent.grant': { ok: false, reason: 'refused', reasonCode: 'PROVIDER_CONSENT_TEXT_MISMATCH', message: 'changed' } });
  const changed = await run(box, ['provider', 'deepseek', '--grant'], stale.ports, { interactive: () => true, readLine: async () => 'consent to deepseek' });
  assert.equal(changed.code, 1);
  assert.match(changed.text, /PROVIDER_CONSENT_TEXT_MISMATCH/);

  const already = await run(box, ['provider', 'deepseek', '--grant'], fakePorts({ ...answers, 'provider.consent.status': status([granted('deepseek')]) }).ports, { interactive: () => true, readLine: async () => assert.fail('no question when already granted') });
  assert.equal(already.code, 0);
  assert.match(already.text, /already granted/);

  const unknown = await run(box, ['provider', 'acme', '--grant'], fakePorts(answers).ports, { interactive: () => true });
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /UNKNOWN_PROVIDER/);
});

test('a revoke needs no terminal, and --all revokes every provider', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({ 'provider.consent.revoke': (input) => ({ ok: true, result: { result: 'revoked', providers: input.body.all ? ['deepseek', 'moonshot'] : [input.body.provider] } }) });
  const one = await run(box, ['provider', 'deepseek', '--revoke', '--json'], fake.ports, { interactive: () => false });
  assert.equal(one.code, 0, one.text);
  assert.deepEqual(one.json, { schemaVersion: '1.0', command: 'consent provider', changed: true, result: 'revoked', providers: ['deepseek'] });
  assert.deepEqual(fake.calls[0].body, { provider: 'deepseek', actor: 'dev' });
  const oneText = await run(box, ['provider', 'deepseek', '--revoke'], fake.ports, { interactive: () => false });
  assert.equal(oneText.text, 'Consent revoked for deepseek. Jevris will not route to it, even while you are signed in to it, until you grant it again (jevris consent provider deepseek --grant).\n');
  const every = await run(box, ['provider', '--all', '--revoke'], fake.ports, { interactive: () => false });
  assert.equal(every.code, 0);
  assert.deepEqual(fake.calls[2].body, { all: true, actor: 'dev' });
  assert.match(every.text, /^Consent revoked for 2 providers: deepseek, moonshot\.$/m);

  // B ae73f00: --all also refuses every provider never granted, so the list can be long; it
  // reads as a count, the ids, and one line on what it means.
  const known = ['anthropic', 'deepseek', 'google', 'moonshot', 'openai', 'xai', 'zai'];
  const wide = await run(box, ['provider', '--all', '--revoke'], fakePorts({ 'provider.consent.revoke': { ok: true, result: { result: 'revoked', providers: known } } }).ports);
  assert.deepEqual(wide.text.trimEnd().split('\n'), [
    `Consent revoked for 7 providers: ${known.join(', ')}.`,
    'Jevris will not route to them, even while you are signed in to them, including any you never granted.',
    'Grant one again with jevris consent provider <provider> --grant.',
  ]);

  // A revoke is now stored even where nothing was granted, so `not-granted` means already revoked.
  const none = await run(box, ['provider', 'xai', '--revoke'], fakePorts({ 'provider.consent.revoke': { ok: true, result: { result: 'not-granted', providers: [] } } }).ports);
  assert.equal(none.code, 0);
  assert.equal(none.text, 'xai is already revoked; nothing changed.\n');
  const noneAll = await run(box, ['provider', '--all', '--revoke'], fakePorts({ 'provider.consent.revoke': { ok: true, result: { result: 'not-granted', providers: [] } } }).ports);
  assert.equal(noneAll.text, 'Every provider is already revoked; nothing changed.\n');
});

test('a revoke of a provider never granted shows as "revoked (never granted)", with no text version or grant time (B ae73f00)', async (t) => {
  const box = sandbox(t);
  const never = { provider: 'xai', state: 'revoked', textVersion: 'none', grantedAtMs: 0, revokedAtMs: DAY, revokedBy: 'user', current: false };
  const fake = fakePorts({ 'provider.consent.status': status([never]) });
  const listed = await run(box, ['provider', '--json'], fake.ports);
  const xai = listed.json.providers.find((v) => v.provider === 'xai');
  assert.deepEqual([xai.state, xai.textVersion, xai.grantedAtMs, xai.revokedAtMs], ['revoked', null, null, DAY]);
  assert.match(xai.why, /^you revoked it on 2026-09-27 without ever granting it; Jevris does not route to it even while you are signed in to it/);
  const text = await run(box, ['provider'], fake.ports);
  assert.match(text.text, /^xai \(xAI \(Grok\)\): revoked \(never granted\): you revoked it on 2026-09-27 without ever granting it/m);
  assert.doesNotMatch(text.text, /1970-01-01/, 'grant time 0 is never shown as a date');
});

test('usage errors, a sidecar that is down, and an answer that does not match are refused', async (t) => {
  const box = sandbox(t);
  const fake = fakePorts({});
  for (const argv of [['provider', 'deepseek', '--grant', '--revoke'], ['provider', '--grant'], ['provider', 'deepseek', '--all', '--revoke'], ['provider', '--all'], ['provider', 'Deep Seek'], ['provider', 'a', 'b'], ['model'], ['provider', '--bogus'], ['provider', 'deepseek', '--grant', '--json']]) {
    const r = await run(box, argv, fake.ports);
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(fake.calls.length, 0);
  const down = await run(box, ['provider'], fakePorts({}).ports);
  assert.equal(down.code, 1);
  assert.match(down.text, /NOT_RUNNING/);
  const bad = await run(box, ['provider'], fakePorts({ 'provider.consent.status': status([{ provider: 'deepseek', state: 'granted' }]) }).ports);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /SIDECAR_INVALID_RESULT/);
  assert.equal(checkConsentStatus({ providers: [granted('deepseek'), granted('deepseek')] }), null, 'one row per provider');
  assert.equal(checkConsentStatus({ providers: [{ ...granted('xai'), revokedAtMs: 5 }] }), null);
  assert.equal(consentViews([]).find((v) => v.provider === 'deepseek').state, 'required');
  assert.match(CONSENT_HELP, /jevris consent provider <provider> --grant/);
});

test('doctor names the registry routing reads and each provider consent state', async (t) => {
  const { consentDoctorLines } = await import('../dist/consent-command.js');
  const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
  const core = await import('@jevris/core');
  const { writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const box = sandbox(t);
  const bundled = await consentDoctorLines(box.home, async () => null);
  assert.equal(bundled[0], `modelRegistry: bundled snapshot ${core.BUNDLED_MODEL_REGISTRY.snapshotId}`);
  assert.equal(bundled.at(-1), 'providerConsent: not read (the sidecar is not running); jevris consent provider shows it');
  assert.ok(bundled.slice(1, -2).every((line) => line.startsWith('dataTerms ')), 'between them, the data lines of the bundled snapshot');
  // Serving hosts R56: then the hosts' tariffs from the same registry.
  assert.match(bundled.at(-2), /^hostTariffs: \d+ servings on 3 hosts \(kilo \d+, nvidia \d+, openrouter \d+\): \d+ at the host's tariff, /);
  assert.ok(bundled.map(doctorLineSeverity).every((severity) => severity === 'info'));

  const file = core.modelRegistryFile(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...core.BUNDLED_MODEL_REGISTRY, snapshotId: 'admin-refresh-1' })}\n`);
  const withOverride = await consentDoctorLines(box.home, async () => ({ providers: [granted('deepseek')] }));
  const [override, consent, hosts] = [withOverride[0], withOverride.at(-2), withOverride.at(-1)];
  assert.equal(override, `modelRegistry: administrator override ${file} (snapshot admin-refresh-1) in place of the bundled ${core.BUNDLED_MODEL_REGISTRY.snapshotId}`);
  assert.match(consent, /^providerConsent: anthropic signed-in default, deepseek granted, google signed-in default, moonshot consent required, /);
  // Serving hosts (R47, design 8): the makers and the pinned hosts are separate lines.
  assert.doesNotMatch(consent, /openrouter|kilo|nvidia/);
  assert.equal(hosts, 'servingHosts: kilo (gateway) signed-in default, nvidia (inference-host) no consent text: never routed, openrouter (gateway) signed-in default');
  assert.equal(doctorLineSeverity(hosts), 'info');
  const neverLine = (await consentDoctorLines(box.home, async () => ({ providers: [{ provider: 'xai', state: 'revoked', textVersion: 'none', grantedAtMs: 0, revokedAtMs: DAY, revokedBy: 'user', current: false }] }))).at(-2);
  assert.match(neverLine, /xai revoked \(never granted\)/);
  assert.equal(doctorLineSeverity(override), 'info');

  writeFileSync(file, '{"not":"a registry"}\n');
  const [broken] = await consentDoctorLines(box.home, async () => null);
  assert.match(broken, /^modelRegistry: the administrator override .* was refused \(MODEL_REGISTRY_INVALID\), so routing is unavailable/);
  writeFileSync(file, 'not json');
  const [notJson] = await consentDoctorLines(box.home, async () => null);
  assert.match(notJson, /\(MODEL_REGISTRY_NOT_JSON\)/);
  assert.equal(doctorLineSeverity(broken), 'broken');
});

test('doctor carries the data line for each provider and sign-in from the registry (7be3c43)', async (t) => {
  const { consentDoctorLines } = await import('../dist/consent-command.js');
  const { dataTermsDoctorLines, signInTermsText } = await import('../dist/data-terms.js');
  const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
  const core = await import('@jevris/core');
  const { writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const row = (signIn, reasonCode, extra = {}) => ({ signIn, trainsOnContent: null, retentionDays: null, location: null, reasonCode, sourceId: 'S1', ...extra });
  const models = [
    { provider: 'openai', dataGovernance: { bySignIn: [row('api-key', 'API_NO_TRAINING', { trainsOnContent: false, retentionDays: 30 }), row('workspace', 'WORKSPACE_SETTINGS_APPLY')] } },
    { provider: 'openai', dataGovernance: { bySignIn: [row('api-key', 'OTHER_ROW')] } },
    { provider: 'deepseek', dataGovernance: { bySignIn: [row('api-key', 'TRAINS_BY_DEFAULT_OPT_OUT', { trainsOnContent: true, location: 'cn' })] } },
    { provider: 'anthropic' },
  ];
  assert.deepEqual(dataTermsDoctorLines(models), [
    "dataTerms deepseek: API key: used for training by default; you can opt out in your account, stored in the People's Republic of China",
    'dataTerms openai: API key: not used for training, kept 30 days; workspace sign-in: your account or workspace settings decide training and retention',
  ]);
  assert.equal(signInTermsText(row('unpaid', 'NEW_CODE', { trainsOnContent: true })), 'unpaid key: may be used for training', 'an unworded code reads from its fields');
  assert.equal(doctorLineSeverity('dataTerms openai: API key: not used for training'), 'info');

  // The lines follow the registry routing reads: an administrator override's terms show.
  const box = sandbox(t);
  const override = JSON.parse(JSON.stringify(core.BUNDLED_MODEL_REGISTRY));
  override.snapshotId = 'admin-terms-1';
  override.entries[0].dataGovernance = { ...(override.entries[0].dataGovernance ?? { zdrEligible: false, requiredRetentionDays: null, sourceId: 'S1' }), bySignIn: [row('api-key', 'API_NO_TRAINING', { trainsOnContent: false })] };
  const file = core.modelRegistryFile(box.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(override)}\n`);
  const lines = await consentDoctorLines(box.home, async () => null);
  assert.ok(lines.includes(`dataTerms ${override.entries[0].provider}: API key: not used for training`), lines.join('\n'));
});

// B's routing-authority review, LOW 13: the grant's `channel` is asserted by the client, so the
// guard is that only the CLI key reaches provider.consent.*. The sidecar refuses the MCP and hook
// keys (B's provider-consent daemon test); here, the MCP surface and the hook launcher never name
// a consent op at all.
test('neither the MCP surface nor the hook launcher can call provider.consent.grant (security review LOW 13)', async () => {
  const { isSurfaceOperation } = await import('../../../packages/contracts/dist/index.js');
  const { runSurfaceCall } = await import('../dist/public-commands.js');
  const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');
  const consentOps = ['provider.consent.status', 'provider.consent.grant', 'provider.consent.revoke'];
  for (const op of consentOps) {
    assert.equal(isSurfaceOperation(op), false, `${op} is no surface operation`);
    const fake = fakePorts({ [op]: { ok: true, result: { result: 'granted' } } });
    let text = '';
    const body = new TextEncoder().encode(JSON.stringify({ provider: 'deepseek', textVersion: PROVIDER_CONSENT_TEXT.deepseek.version, channel: 'terminal' }));
    const code = await runSurfaceCall([op], (chunk) => (text += chunk), async () => body, { ports: fake.ports, env: { JEVRIS_SIDECAR_AUTOSTART: '0' } });
    assert.equal(code, 2, op);
    assert.equal(JSON.parse(text).error.code, 'UNKNOWN_OPERATION', op);
    assert.equal(fake.calls.length, 0, `${op}: nothing reached the sidecar`);
  }
  assert.ok(TOOLS.length > 0);
  for (const tool of TOOLS) assert.ok(!tool.op.startsWith('provider.consent'), `${tool.name} maps to ${tool.op}`);

  const { runLauncher } = await import('../../hook/dist/launcher.js');
  const claude = await import('@jevris/adapter-claude-code');
  const requests = [];
  const sidecar = {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request(input) {
      requests.push(input);
      return { ok: true, result: { recorded: true, duplicate: false, results: {} } };
    },
  };
  for (const fixture of claude.FIXTURES.filter((f) => f.kind !== null)) {
    await runLauncher({ harness: 'claude', event: null }, JSON.stringify(fixture.native), { adapters: { claude }, sidecar, env: { JEVRIS_HOME: '/tmp/jevris-home' }, cwd: () => '/work', nowMs: () => Date.now() }, Date.now());
  }
  assert.ok(requests.length > 0);
  for (const request of requests) assert.deepEqual([request.op, request.scope], ['event', 'hook']);
});

test('serving hosts (R47): the list groups makers and hosts, a host grant shows forwarding and the maker rule, NVIDIA is refused', async (t) => {
  const { SERVING_HOST_CONSENT_TEXT } = await import('../../../packages/contracts/dist/index.js');
  const box = sandbox(t);
  const hostGranted = { provider: 'openrouter', state: 'granted', textVersion: SERVING_HOST_CONSENT_TEXT.openrouter.version, grantedAtMs: DAY, revokedAtMs: null, revokedBy: null, current: true };
  const listed = await run(box, ['provider'], fakePorts({ 'provider.consent.status': status([hostGranted]) }).ports);
  assert.equal(listed.code, 0, listed.text);
  const lines = listed.text.trimEnd().split('\n');
  const makersAt = lines.indexOf('Makers:');
  const hostsAt = lines.indexOf('Hosts (a route through a host also needs the maker):');
  assert.ok(makersAt > 0 && hostsAt > makersAt);
  assert.ok(lines.slice(makersAt + 1, hostsAt).every((l) => !/^(openrouter|kilo|nvidia) /.test(l)));
  assert.deepEqual(lines.slice(hostsAt + 1).map((l) => l.split(' ')[0]), ['kilo', 'nvidia', 'openrouter']);
  assert.match(listed.text, /^openrouter \(gateway\): granted: you consented on 2026-09-27; routes through it also need the maker's consent$/m);
  assert.match(listed.text, /^kilo \(gateway\): signed-in default: .*; it passes requests to openrouter, so revoking openrouter blocks it too$/m);
  assert.match(listed.text, /^nvidia \(inference-host\): consent required: Jevris has no consent text for this serving host, so it cannot be granted and is never routed to$/m);
  const json = await run(box, ['provider', '--json'], fakePorts({ 'provider.consent.status': status([]) }).ports);
  assert.equal(json.json.providers.find((v) => v.provider === 'kilo').party, 'host');
  assert.equal(json.json.providers.find((v) => v.provider === 'moonshot').party, 'maker');

  const one = await run(box, ['provider', 'kilo'], fakePorts({ 'provider.consent.status': status([]) }).ports);
  assert.match(one.text, /^forwarding: Kilo routes requests through OpenRouter/m);

  // B's note: when OpenRouter is revoked, the Kilo Gateway (which passes requests there) reads as blocked.
  const orRevoked = { provider: 'openrouter', state: 'revoked', textVersion: SERVING_HOST_CONSENT_TEXT.openrouter.version, grantedAtMs: DAY, revokedAtMs: DAY, revokedBy: 'user', current: false };
  const blocked = await run(box, ['provider'], fakePorts({ 'provider.consent.status': status([orRevoked]) }).ports);
  assert.match(blocked.text, /^kilo \(gateway\): blocked: openrouter is revoked, and kilo passes requests there, so Jevris does not route through kilo \(jevris consent provider openrouter --grant\)$/m);
  const staleOr = await run(box, ['provider'], fakePorts({ 'provider.consent.status': status([{ ...hostGranted, current: false }]) }).ports);
  assert.match(staleOr.text, /^kilo \(gateway\): blocked: openrouter needs your consent again/m);

  // A grant for a host: the terms, who it forwards to and the maker rule, then the phrase.
  const answers = {
    'provider.consent.status': status([]),
    'provider.consent.grant': (input) => ({ ok: true, result: { result: 'granted', provider: input.body.provider, party: 'host', textVersion: input.body.textVersion } }),
  };
  const person = fakePorts(answers);
  const ok = await run(box, ['provider', 'openrouter', '--grant'], person.ports, { interactive: () => true, readLine: async () => 'consent to openrouter' });
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /go to OpenRouter \(gateway\) and to the provider it passes them to/);
  assert.match(ok.text, /^- forwarding: Each request goes to a provider OpenRouter selects/m);
  assert.match(ok.text, /^A route through OpenRouter \(gateway\) also needs consent for the model's maker, for example Moonshot for Kimi K3\.$/m);
  assert.deepEqual(person.calls.find((c) => c.op === 'provider.consent.grant').body, { provider: 'openrouter', textVersion: 'openrouter-2026-09-28', channel: 'terminal', actor: 'dev' });

  // An answer that names the wrong party is not trusted.
  const wrongParty = await run(box, ['provider', 'openrouter', '--grant'], fakePorts({ ...answers, 'provider.consent.grant': (input) => ({ ok: true, result: { result: 'granted', provider: 'openrouter', party: 'maker', textVersion: input.body.textVersion } }) }).ports, { interactive: () => true, readLine: async () => 'consent to openrouter' });
  assert.equal(wrongParty.code, 1);
  assert.match(wrongParty.text, /SIDECAR_INVALID_RESULT/);

  // NVIDIA has no text: refused before the sidecar is asked.
  const nv = fakePorts(answers);
  const refused = await run(box, ['provider', 'nvidia', '--grant'], nv.ports, { interactive: () => true, readLine: async () => assert.fail('no question') });
  assert.equal(refused.code, 1);
  assert.equal(refused.text, 'Nothing changed (CONSENT_TEXT_MISSING): Jevris has no consent text for this serving host, so it cannot be granted and is never routed to.\n');
  assert.equal(nv.calls.length, 0);
});
