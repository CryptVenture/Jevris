import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GOV-08, US26: deterministic secret and sensitive-path screening. Every credential below is
// synthesized at run time from a shape (prefix plus generated characters), so no file in the
// repository holds a key-shaped literal and no product rule can match a test canary.

const { SECRET_RULES, SENSITIVE_PATH_RULES, redactText, screenText, egressFreeText, egressFreeTextFields } = await import('../dist/egress.js');

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGIT = '0123456789';
const HEX = '0123456789abcdef';
const ALNUM = LOWER + UPPER + DIGIT;
const B64 = `${ALNUM}/+`;
const URLSAFE = `${ALNUM}_-`;

/** Deterministic characters from an alphabet (a linear congruential walk), mixing every class. */
function gen(alphabet, length, seed = 7) {
  let x = seed;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}
const mixed = (length, seed) => `${gen(LOWER, 1, seed)}${gen(UPPER, 1, seed + 1)}${gen(DIGIT, 1, seed + 2)}${gen(ALNUM, length - 3, seed + 3)}`;
const join = (...parts) => parts.join('');

/** One sample per secret type, each the rule id it must trip. */
const SECRETS = [
  ['aws-access-key-id', `key id ${join('AK', 'IA', gen(UPPER + DIGIT, 16))}`],
  ['aws-access-key-id', `role ${join('AS', 'IA', gen(UPPER + DIGIT, 16, 3))}`],
  ['aws-secret-access-key', `aws_secret_access_key = ${gen(B64, 40, 11)}`],
  ['aws-session-token', `aws_session_token=${gen(B64, 120, 5)}`],
  ['github-token', `token ${join('gh', 'p_', gen(ALNUM, 36))}`],
  ['github-token', join('gh', 's_', gen(ALNUM, 36, 9))],
  ['github-fine-grained-pat', join('github', '_pat_', gen(`${ALNUM}_`, 60))],
  ['gitlab-token', join('gl', 'pat-', gen(URLSAFE, 20))],
  ['slack-token', join('xo', 'xb-', gen(DIGIT, 12), '-', gen(ALNUM, 24))],
  ['slack-webhook', join('https://hooks.', 'slack.com/services/T', gen(UPPER + DIGIT, 8), '/B', gen(UPPER + DIGIT, 8), '/', gen(ALNUM, 24))],
  ['google-api-key', join('AI', 'za', gen(URLSAFE, 35))],
  ['google-oauth-token', join('ya', '29.', gen(URLSAFE, 40))],
  ['gcp-service-account', '{"type": "service_account", "project_id": "demo"}'],
  ['stripe-key', join('sk', '_live_', gen(ALNUM, 24))],
  ['stripe-webhook-secret', join('wh', 'sec_', gen(ALNUM, 32))],
  ['twilio-key', join('S', 'K', gen(HEX, 32))],
  ['sendgrid-key', join('S', 'G.', gen(URLSAFE, 22), '.', gen(URLSAFE, 43))],
  ['mailgun-key', join('ke', 'y-', gen(HEX, 32))],
  ['npm-token', join('np', 'm_', gen(ALNUM, 36))],
  ['pypi-token', join('pypi', '-AgE', gen(URLSAFE, 60))],
  ['anthropic-key', join('sk', '-ant-', gen(URLSAFE, 40))],
  ['openai-key', join('sk', '-proj-', gen(URLSAFE, 40))],
  ['jwt', join('ey', 'J', gen(URLSAFE, 20), '.ey', 'J', gen(URLSAFE, 30), '.', gen(URLSAFE, 43))],
  ['private-key-block', join('-----BEGIN ', 'RSA PRIVATE', ' KEY-----\nMIIE...')],
  ['private-key-block', join('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----')],
  ['private-key-block', join('-----BEGIN ', 'PGP PRIVATE KEY', ' BLOCK-----')],
  ['azure-storage-key', join('DefaultEndpointsProtocol=https;AccountName=x;Account', 'Key=', gen(B64, 86), '==')],
  ['azure-sas-token', join('https://x.blob.core.windows.net/c?sv=2022&', 'sig=', gen(B64, 44))],
  ['digitalocean-token', join('do', 'p_v1_', gen(HEX, 64))],
  ['shopify-token', join('shp', 'at_', gen(HEX, 32))],
  ['square-token', join('sq0', 'atp-', gen(URLSAFE, 22))],
  ['discord-bot-token', join('M', gen(URLSAFE, 23), '.', gen(URLSAFE, 6), '.', gen(URLSAFE, 27))],
  ['telegram-bot-token', join(gen(DIGIT, 9), ':A', 'A', gen(URLSAFE, 33))],
  ['huggingface-token', join('h', 'f_', gen(LOWER + UPPER, 34))],
  ['databricks-token', join('da', 'pi', gen(HEX, 32))],
  ['doppler-token', join('dp', '.pt.', gen(ALNUM, 43))],
  ['vault-token', join('hv', 's.', gen(URLSAFE, 90))],
  ['atlassian-token', join('ATA', 'TT3', gen(URLSAFE, 60))],
  ['linear-key', join('lin', '_api_', gen(ALNUM, 40))],
  ['notion-token', join('sec', 'ret_', gen(ALNUM, 43))],
  ['postman-key', join('PM', 'AK-', gen(HEX, 24), '-', gen(HEX, 34))],
  ['figma-token', join('fi', 'gd_', gen(URLSAFE, 40))],
  ['supabase-token', join('sb', 'p_', gen(HEX, 40))],
  ['grafana-token', join('gl', 'sa_', gen(ALNUM, 40))],
  ['newrelic-key', join('NR', 'AK-', gen(UPPER + DIGIT, 27))],
  ['age-secret-key', join('AGE-SECRET', '-KEY-1', gen(UPPER + DIGIT, 58))],
  ['terraform-token', join(gen(ALNUM, 14), '.atlas', 'v1.', gen(URLSAFE, 67))],
  ['sentry-dsn', join('https://', gen(HEX, 32), '@o1.ingest.sentry.io/1')],
  ['url-credentials', join('postgres://admin:', gen(ALNUM, 12), '@db.internal:5432/app')],
  ['url-credentials', join('mongodb+srv://svc:', gen(ALNUM, 16), '@cluster0.example.net')],
  ['env-assignment', join('DATABASE_PASS', 'WORD=', gen(ALNUM, 14))],
  ['env-assignment', join('export STRIPE_SECRET', '_KEY="', gen(ALNUM, 20), '"')],
  ['env-assignment', join('api_key: ', gen(ALNUM, 16))],
  ['high-entropy-token', mixed(48, 21)],
];

const PATHS = [
  ['path-env-file', 'cat .env'],
  ['path-env-file', 'config/.env.production'],
  ['path-ssh-key', '~/.ssh/id_rsa'],
  ['path-ssh-key', 'id_ed25519'],
  ['path-key-file', 'certs/server.pem'],
  ['path-key-file', 'release.keystore'],
  ['path-secrets-dir', 'secrets/prod.yaml'],
  ['path-cloud-credentials', '~/.aws/credentials'],
  ['path-cloud-credentials', '~/.kube/config'],
  ['path-package-credentials', 'cat ~/.npmrc'],
  ['path-package-credentials', '.git-credentials'],
];

/** Ordinary development text that must pass (false-positive corpus). */
const BENIGN = [
  'TypeError: Cannot read properties of undefined (reading "length") at parse (app/parse.ts:14:7)',
  'expected 3 tests to pass, got 2; see test/parse.test.ts',
  'commit 9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
  `sha256:${gen(HEX, 64, 13)}`,
  'uuid 123e4567-e89b-12d3-a456-426614174000',
  'npm ERR! code ERESOLVE unable to resolve dependency tree',
  'const apiKeyHeader = "x-api-key";',
  'function getAccessToken(user) { return tokens.get(user.id); }',
  'password: process.env.DB_PASSWORD',
  'Set AWS_REGION=eu-west-1 before running the deploy script',
  'https://github.com/example/repo/pull/42',
  'docs/configuration.md#retention-and-deletion',
  'Error: ENOENT: no such file or directory, open "fixtures/input.json"',
  'The build took 12.4s with 3 warnings',
  'import { createServer } from "node:http";',
  'SELECT id, name FROM users WHERE created_at > NOW() - INTERVAL 1 DAY',
  'width: calc(100% - 2rem); color: #1a2b3c;',
  'base64 image data omitted',
  'The environment variable is named JEVRIS_HOME',
  'ssh-keygen -t ed25519 -C "dev@example.com"',
  'Refactor the EventDeduper and TriggerFilter classes',
  'Retrying in 1500ms (attempt 2 of 3)',
  'ReferenceError: tokenizerForModelVersion is not defined',
  'Use the environment file example (env.example) as a template',
  'git push origin feature/login-redesign',
];

test('screening trips every one of at least 40 secret types and each sensitive path rule (GOV-08, US26)', () => {
  const types = new Set(SECRETS.map(([id]) => id));
  assert.ok(types.size >= 40, `only ${types.size} secret types`);
  for (const id of types) assert.ok(SECRET_RULES.some((item) => item.id === id), `no rule ${id}`);
  for (const [id, text] of SECRETS) {
    const found = screenText(text).map((finding) => finding.ruleId);
    assert.ok(found.includes(id), `${id} not found in sample (found ${found.join(', ') || 'nothing'})`);
  }
  for (const [id, text] of PATHS) {
    assert.ok(screenText(text).some((finding) => finding.ruleId === id), `${id} not found in "${text}"`);
  }
  for (const { id } of SENSITIVE_PATH_RULES) assert.ok(PATHS.some(([sample]) => sample === id), `path rule ${id} has no sample`);
});

test('the false-positive rate on ordinary development text is recorded and bounded (GOV-08)', () => {
  const flagged = BENIGN.filter((text) => screenText(text).length > 0);
  const rate = flagged.length / BENIGN.length;
  process.stdout.write(`# secret screening false-positive rate: ${flagged.length}/${BENIGN.length} (${(rate * 100).toFixed(1)}%)\n`);
  assert.ok(rate <= 0.04, `false positives: ${flagged.join(' | ')}`);
});

test('findings carry rule ids and offsets, never the matched value; redact-and-continue leaves no fragment (GOV-08)', () => {
  const key = join('gh', 'p_', gen(ALNUM, 36, 99));
  const text = `retry failed with ${key} after reading .env`;
  const findings = screenText(text);
  assert.equal(JSON.stringify(findings).includes(key), false);
  for (const id of ['github-token', 'path-env-file']) assert.ok(findings.some((finding) => finding.ruleId === id), id);
  const redacted = redactText(text);
  assert.equal(redacted.text.includes(key.slice(4, 20)), false);
  assert.match(redacted.text, /\[REDACTED:github-token\]/);
  assert.deepEqual(screenText(redacted.text.replace(/\[REDACTED:[a-z-]+\]/g, '')).filter((finding) => finding.ruleId !== 'path-env-file'), []);
});

test('a data scope can allow a rule explicitly; paths can be left out (GOV-08)', () => {
  const token = join('ey', 'J', gen(URLSAFE, 20, 3), '.ey', 'J', gen(URLSAFE, 30, 4), '.', gen(URLSAFE, 43, 5));
  assert.ok(screenText(token).some((finding) => finding.ruleId === 'jwt'));
  assert.equal(screenText(token, { allow: ['jwt', 'high-entropy-token'] }).length, 0);
  assert.equal(screenText('see .env', { paths: false }).length, 0);
});

test('the free text of a Jev request is the evidence text and a task statement, never Jevris-authored fields (GOV-01)', () => {
  const body = {
    model: 'jev-1.13.0',
    state: {
      objective: 'Classify the failure pattern.',
      task: 'Add a display label',
      facts: { failures: 2 },
      candidates: [{ id: 'a', description: 'Retry' }],
      missingEvidence: ['consumer test'],
      untrustedEvidence: [{ span: 's1', source: 'tool', text: 'boom' }, { span: 's2', source: 'tool', text: '  ' }],
      evidence: [{ id: 'e1', text: 'Existing consumers deserialize this.' }],
    },
    questions: { q: { type: 'choice', instructions: 'Choose one.', criteria: { a: 'x', b: 'y' } } },
  };
  assert.deepEqual(egressFreeTextFields(body), ['/state/untrustedEvidence/0/text', '/state/evidence/0/text', '/state/task']);
  assert.deepEqual(egressFreeText(body).map((item) => item.text), ['boom', 'Existing consumers deserialize this.', 'Add a display label']);
  assert.deepEqual(egressFreeTextFields({ state: { facts: {} } }), []);
  assert.deepEqual(egressFreeTextFields('not an object'), []);
});

test('the compiled screening holds no key-shaped literal (no test canary in the product)', () => {
  const js = readFileSync(new URL('../dist/egress.js', import.meta.url), 'utf8');
  for (const [, sample] of SECRETS) assert.equal(js.includes(sample), false);
});
