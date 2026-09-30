import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, story } from './lib.mjs';
import { scanRead } from '../live-files.mjs';

// A Jev answer that names an option the question never offered, or whose probabilities do not
// sum to one, must be refused by validation: no action, and a redacted record naming the
// failure (C52, PRV-04). The stub serves the conformance mock's malformed scenarios.

function filesText(dir) {
  let out = '';
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out += filesText(full);
    else out += scanRead(full).toString('latin1');
  }
  return out;
}

async function malformed(t, sandbox, scenario) {
  const provider = await startJevStub(t, { scenario });
  const box = await sandbox({ env: provider.env });
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  const recover = box.jevris(['recover', '--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14'], { json: true });
  const status = box.jevris(['status'], { json: true });
  const decision = status.json?.result?.recentDecisions?.[0];
  const explain = decision === undefined ? null : box.jevris(['explain', decision.decisionId], { json: true });
  const { jevrisPaths } = await load('platform');
  const paths = jevrisPaths({ home: box.home });
  box.stopSidecar();
  return { provider, recover, decision, explain, stored: filesText(paths.data) + filesText(paths.state) };
}

story('US30', async ({ t, then, sandbox, evidence }) => {
  const unknown = await malformed(t, sandbox, 'unknown-candidate');
  const distribution = await malformed(t, sandbox, 'invalid-distribution');
  evidence({ unknown: unknown.explain?.json?.result?.trace, distribution: distribution.explain?.json?.result?.trace });

  await then('The result is invalid, no action is applied and a redacted error record identifies the schema failure', () => {
    for (const run of [unknown, distribution]) {
      assert.ok(run.provider.requests().length > 0, 'the provider was never asked, so validation never ran');
      assert.notEqual(run.decision, undefined, `no decision was recorded: ${JSON.stringify(run.recover.json)}`);
      assert.equal(run.decision.outcome, 'quarantined');
      assert.equal(run.decision.reasonCode, 'INVALID_RESPONSE');
    }
    // No action is applied.
    for (const run of [unknown, distribution]) {
      assert.equal(run.explain.code, 0, run.explain.stderr);
      const trace = run.explain.json.result.trace;
      assert.equal(trace.applied, false);
      assert.match(trace.rendered, /Proposed action: none/);
      assert.ok(trace.reasonCodes.includes('FALLBACK_RULES_ONLY'), trace.reasonCodes.join(','));
      // The command still answered, from local rules.
      assert.equal(run.recover.code, 0, run.recover.stderr);
      assert.equal(typeof run.recover.json.result.action, 'string');
    }
    // A redacted error record identifies the schema failure.
    assert.match(unknown.explain.json.result.trace.rendered, /Failure kind: unknown-candidate/);
    assert.match(distribution.explain.json.result.trace.rendered, /Failure kind: [a-z-]*distribution[a-z-]*/);
    // The raw answer is not kept: the invented option name appears nowhere in the store, the
    // decision journal or the logs.
    assert.equal(unknown.stored.includes('not_a_listed_option'), false, 'the raw provider answer was stored');
  });
});
