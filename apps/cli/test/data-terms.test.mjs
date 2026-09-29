// Owner decision 7be3c43 (SPEC 8.1 review §5 item 2): route and explain show the data line for
// the model they name, per sign-in, from the registry's dataGovernance.bySignIn (C's facts, E's
// wording); with no row for it, nothing is shown. Fake ports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { modelDataTermsLine } = await import('../dist/data-terms.js');
const { runPublicCommand } = await import('../dist/public-commands.js');
const core = await import('@jevris/core');

const row = (signIn, reasonCode, extra = {}) => ({ signIn, trainsOnContent: null, retentionDays: null, location: null, reasonCode, sourceId: 'S1', ...extra });

function registryWithTerms() {
  const registry = JSON.parse(JSON.stringify(core.BUNDLED_MODEL_REGISTRY));
  const entry = registry.entries.find((e) => e.modelId === 'claude-opus-5-5');
  entry.dataGovernance = {
    ...(entry.dataGovernance ?? { zdrEligible: false, requiredRetentionDays: null, sourceId: 'S1' }),
    bySignIn: [row('api-key', 'API_NO_TRAINING', { trainsOnContent: false, retentionDays: 30, location: 'global' }), row('subscription', 'WORKSPACE_SETTINGS_APPLY'), row('workspace', 'WORKSPACE_SETTINGS_APPLY')],
  };
  return registry;
}

test('the line picks the sign-in row, resolves a harness model id, and shows nothing it does not know', () => {
  const registry = registryWithTerms();
  assert.equal(modelDataTermsLine(registry, 'claude-opus-5-5', 'api-key'), 'data terms (anthropic): API key: not used for training, kept 30 days, stored in any region the provider uses');
  assert.equal(
    modelDataTermsLine(registry, 'anthropic/claude-opus-5-5[1m]', 'subscription'),
    'data terms (anthropic): subscription sign-in: your account or workspace settings decide training and retention; workspace sign-in: your account or workspace settings decide training and retention',
    'a subscription also shows the workspace row, which Jevris cannot tell apart',
  );
  assert.match(modelDataTermsLine(registry, 'claude-opus-5-5', 'unknown'), /API key: .*; subscription sign-in: .*; workspace sign-in: /, 'an unknown sign-in shows every row');
  assert.equal(modelDataTermsLine(registry, 'claude-sonnet-5', 'api-key'), null, 'no rows: nothing guessed');
  assert.equal(modelDataTermsLine(registry, 'not-a-model', 'api-key'), null);
  assert.equal(modelDataTermsLine(null, 'claude-opus-5-5', 'api-key'), null);
  // Serving hosts (owner 8c1f85d): a gateway id is not the maker's model, so its bare segment
  // never picks the maker's terms.
  assert.equal(modelDataTermsLine(registry, 'openrouter/claude-opus-5-5', 'api-key'), null);
});

test('jevris route prints the data line for the model under the named sign-in', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-data-terms-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const registry = registryWithTerms();
  const ports = {
    sidecar: {
      async ensure() {
        return { ok: true, endpoint: 'fake', started: false };
      },
      async request() {
        return { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'not running' };
      },
    },
    engine: { loadRegistry: () => registry },
    config: {},
  };
  const run = async (argv) => {
    let text = '';
    const code = await runPublicCommand('route', argv, (chunk) => (text += chunk), { ports, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' }, cwd: workspace });
    return { code, text };
  };
  const human = await run(['--model', 'claude-opus-5-5', '--auth-mode', 'api-key']);
  assert.equal(human.code, 0, human.text);
  assert.match(human.text, /^data terms \(anthropic\): API key: not used for training, kept 30 days/m);
  const json = await run(['--model', 'claude-opus-5-5', '--auth-mode', 'api-key', '--json']);
  assert.doesNotMatch(json.text, /data terms/, 'the JSON result stays the route contract');
});
