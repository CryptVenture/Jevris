import assert from 'node:assert/strict';
import { calibratedRoute, SLICE } from './calibrated-route.mjs';
import { story } from './lib.mjs';

// US10: an Opus 5 main session with a 150,000-token warm prefix and a small remaining task
// (100,000 input and 10,000 output tokens). Sonnet 5 is cheaper per token and meets the floor
// on the released calibration, but moving the warm prefix costs more than the switch saves, so
// the switch guard keeps Opus 5 and says why in money: the transition cost, not the input price.
// The pair: the same task from a cold start is recommended, so the transition cost is what
// holds the model. Both surfaces carry the session facts (CLI flags and MCP arguments).

const REMAINING = ['--remaining-input', '100000', '--remaining-output', '10000'];

story('US10', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  await calibratedRoute(box);
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');

  // When: the switch is evaluated at a boundary with the warm prefix reported.
  const warm = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '150000'], { json: true });
  evidence(warm.json);
  assert.equal(warm.code, 0, `route failed: ${warm.stdout} ${warm.stderr}`);
  const client = await box.mcp();
  const viaMcp = (await client.callTool({
    name: 'jevris_plan_route',
    arguments: { currentModel: 'claude-opus-5', sliceId: SLICE, remaining: { inputTokens: 100_000, outputTokens: 10_000 }, session: { warmPrefixTokens: 150_000, cacheWarm: true, atBoundary: true } },
  })).structuredContent;
  evidence(viaMcp);

  await then('Hysteresis retains the current model, and the explanation includes transition cost rather than input price alone', () => {
    for (const main of [warm.json.result.main, viaMcp.result.main]) {
      assert.deepEqual([main.outcome, main.reasonCode, main.recommendedModel], ['keep', 'BELOW_MINIMUM_BENEFIT', null], JSON.stringify(main));
      assert.match(main.text, /^Keep Opus 5\./);
      // 150K warm tokens x (Sonnet 5's $2.50/M 5-minute cache write - Opus 5's $0.50/M cache read).
      assert.match(main.text, /Transition cost \$0\.3000 \(warm prefix moved to the new model\)/);
      assert.match(main.text, /worst-case saving \$\d+\.\d{4}, net -\$\d+\.\d{4}/);
    }
    assert.equal(warm.json.result.applied, false);
    const text = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '150000']);
    assert.match(text.stdout, /main session: keep/);
    assert.match(text.stdout, /Transition cost \$0\.3000/);

    // The pair: from a cold start the same switch clears the minimum benefit, so it is the
    // transition cost that keeps the model. Without the warm prefix the cost is unknown and the
    // model is kept for that reason, never switched on input price alone.
    const cold = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING, '--warm-prefix', '0'], { json: true });
    evidence(cold.json);
    assert.deepEqual([cold.json.result.main.outcome, cold.json.result.main.recommendedModel], ['recommend', 'claude-sonnet-5']);
    const unknown = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, ...REMAINING], { json: true });
    assert.deepEqual([unknown.json.result.main.outcome, unknown.json.result.main.reasonCode], ['keep', 'TRANSITION_COST_UNKNOWN']);
    // Mid-step there is no switch at all.
    const midStep = box.jevris(['route', '--model', 'claude-opus-5', '--slice', SLICE, '--warm-prefix', '0', '--mid-step'], { json: true });
    assert.equal(midStep.json.result.main.reasonCode, 'NOT_AT_BOUNDARY');
  });
});
