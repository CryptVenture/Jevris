import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// JEV-0079: the person's own half of source-egress consent (`privacy.sourceEgress`) reaches every op context as
// `sourceEgressPreference`, read per request from the effective configuration, so an op that quotes text to Jev (the route's
// task title for the model tier) can require it next to the administrator's approval. Temp home, no credential, no harness.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');
const { DEFAULT_CONFIG } = await import('@jevris/orchestrator');
const { jevrisPaths } = await import('@jevris/platform');

test('the op context carries the person\'s privacy.sourceEgress, live, defaulting to deny-until-approved', { skip: managedHostSkip() }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-egress-pref-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const config = jevrisPaths({ home }).config;
  mkdirSync(config, { recursive: true });
  const probe = { op: 'test.egress-preference', scope: 'advice', budget: 'hot', handle: (ctx) => ({ ok: true, body: { preference: ctx.sourceEgressPreference ?? null } }) };
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, log: () => undefined, liveCertification: false, ops: [probe], limits: { budgetMs: { hot: 60_000, background: 60_000 } } });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    const preference = async () => {
      const res = await sidecarRequest({ home, op: 'test.egress-preference', scope: 'hook', timeoutMs: 60_000, workspace: repo, body: {} });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.result.preference;
    };
    assert.equal(await preference(), 'deny-until-approved', 'the default');
    // `jevris configure set privacy.sourceEgress approved-scoped` writes the user file (from a terminal): no restart.
    writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: 'approved-scoped' } }));
    assert.equal(await preference(), 'approved-scoped');
    writeFileSync(join(config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, privacy: { ...DEFAULT_CONFIG.privacy, sourceEgress: 'deny-until-approved' } }));
    assert.equal(await preference(), 'deny-until-approved', 'lowered again');
  } finally {
    await started.daemon.stop('test');
  }
});
