// Owner decision 8703ab6 through the product: `jevris route --auth-mode` and the session.authMode
// argument of jevris_plan_route reach C's switch guard, so the transition cost of a main-session
// switch carries the label of how the harness is billed. The same switch, priced the same, is
// "billed at API list price" on an API key, an API-equivalent estimate of usage-limit use on a
// subscription, and an estimate with an unknown basis when the mode is unknown or not given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { calibratedRoute, SLICE } from '../../../test/acceptance/calibrated-route.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const REMAINING = ['--remaining-input', '100000', '--remaining-output', '10000'];
const LABEL = {
  'api-key': /Transition cost \$0\.3000 \(warm prefix moved to the new model\), billed at API list price;/,
  subscription: /Transition cost \$0\.3000 \(warm prefix moved to the new model\), an API-equivalent estimate \(a subscription has no per-token charge; the real cost is usage-limit consumption\);/,
  unknown: /Transition cost \$0\.3000 \(warm prefix moved to the new model\), an API-equivalent estimate \(the harness billing mode is not known\);/,
};

test('the transition cost is labelled by the auth mode on the CLI and over MCP', { skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  await calibratedRoute(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const client = await box.mcp();
  const cli = (mode) => {
    const run = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '150000', ...(mode === null ? [] : ['--auth-mode', mode])], { json: true });
    assert.equal(run.code, 0, `${run.stdout} ${run.stderr}`);
    assert.equal(run.json.result.main.authMode, mode ?? undefined, 'main.authMode echoes the mode sent, and is absent when none is');
    return run.json.result.main.text;
  };
  const mcp = async (mode) => {
    const out = (await client.callTool({
      name: 'jevris_plan_route',
      arguments: { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: { inputTokens: 100_000, outputTokens: 10_000 }, session: { warmPrefixTokens: 150_000, ...(mode === null ? {} : { authMode: mode }) } },
    })).structuredContent;
    assert.equal(out.result.main.authMode, mode ?? undefined);
    return out.result.main.text;
  };
  for (const mode of ['api-key', 'subscription', 'unknown']) {
    for (const text of [cli(mode), await mcp(mode)]) {
      assert.match(text, LABEL[mode], `${mode}: ${text}`);
      for (const other of Object.keys(LABEL)) if (other !== mode) assert.doesNotMatch(text, LABEL[other], `${mode} carries the ${other} label`);
    }
  }
  // Not given is unknown: never presented as list-price billing or as a subscription estimate.
  for (const text of [cli(null), await mcp(null)]) assert.match(text, LABEL.unknown, text);
  // The human rendering carries the same label.
  const human = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '150000', '--auth-mode', 'subscription']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /a subscription has no per-token charge; the real cost is usage-limit consumption/);
  assert.match(human.stdout, /cost basis: +API-equivalent estimate; a subscription has no per-token charge, and this use counts against your plan's usage limits/);
  const listed = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '150000', '--auth-mode', 'api-key']);
  assert.match(listed.stdout, /cost basis: +cost \(API list price\)/);
});
