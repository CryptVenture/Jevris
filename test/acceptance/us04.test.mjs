import assert from 'node:assert/strict';
import { story } from './lib.mjs';

// US04: the developer pinned a model that organization policy still permits, and a cheaper model
// is proposed (the harness reports a switch to Haiku). Jevris keeps the pin on the route surface
// and in the model-switch hook. The advice is recorded once (a decision record); asking again,
// or the harness reporting the switch again, prompts nothing new.

story('US04', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  const ask = () => box.jevris(['route', '--model', 'claude-opus-5', '--pin', 'claude-opus-5'], { json: true });
  const first = ask();
  const second = ask();
  const switchEvent = { hook_event_name: 'PreModelSwitch', session_id: 'us04', cwd: box.work, from_model: 'claude-opus-5', to_model: 'claude-haiku-4-5-20251001' };
  const hooks = [box.hook('claude', switchEvent), box.hook('claude', switchEvent)];
  const status = box.jevris(['status'], { json: true });
  box.stopSidecar();

  const recent = status.json?.result?.recentDecisions ?? [];
  evidence({ route: first.json?.result?.main, recent, hooks: hooks.map((h) => h.stdout) });

  await then('Jevris does not override the pin and records advice without repeated prompts', () => {
    for (const out of [first, second]) {
      assert.equal(out.code, 0, out.stderr);
      const main = out.json.result.main;
      assert.deepEqual([main.outcome, main.pinState, main.modelPin, main.recommendedModel, main.reasonCode], ['keep', 'pinned', 'claude-opus-5', null, 'PIN_RESPECTED']);
      assert.equal(out.json.result.applied, false);
    }
    // The switch hook neither blocks nor rewrites the model, and says nothing twice.
    for (const hook of hooks) {
      assert.equal(hook.code, 0, hook.stderr);
      assert.equal(/permissionDecision|"decision"\s*:|updatedInput|to_model|"model"\s*:/.test(hook.stdout), false, `the hook acted on the switch: ${hook.stdout}`);
    }
    assert.equal(/Jevris/.test(hooks[1].stdout), false, 'the repeated switch prompted again');
    // The advice is recorded once, with the pin as its reason.
    const pinned = recent.filter((d) => d.reasonCode === 'PIN_RESPECTED');
    assert.equal(pinned.length, 1, JSON.stringify(recent));
    assert.equal(pinned[0].outcome, 'advisory');
  });
});
