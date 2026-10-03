import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';
import { jevrisPaths } from '@jevris/platform';

// Live repeated-failure advice: the event op gives subscribers the repair-attempt bound from the
// EFFECTIVE configuration (`orchestration.maxRepairAttempts`), for a failure event only, replacing
// whatever a hook claimed: the advice says the attempts are used up by this number, so a hook must
// not be able to set it. A subscriber that runs after the answer (observe mode) also gets the
// effective `jev.assist`, so `jev.assist: off` holds there as it does on the hot path.

const { startDaemon, sidecarRequest } = await import('../dist/index.js');

const answered = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
};

function userConfig({ mode, assist, maxRepairAttempts }) {
  return {
    schemaVersion: '1.0',
    mode,
    provider: { kind: 'typesafe-direct', model: 'jev-1.13.0', credentialRef: 'host-secret:typesafe-primary' },
    decisions: { hotPathDeadlineMs: 900, backgroundDeadlineMs: 5000, maxRequestBytes: 131072, maxQuestions: 12, allowUncalibratedActuation: false },
    privacy: { sourceEgress: 'deny-until-approved', remoteTelemetry: 'off', rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    routing: { mainSession: 'advice-only', managedWorkers: 'observe', respectHumanPins: true, calibrationArtifact: null },
    orchestration: { enabled: false, maxConcurrentWorkers: 2, maxWorkerDepth: 1, maxRepairAttempts, maxStopContinuationsPerCondition: 1 },
    compaction: { nativeAutoDeferral: false, preserveMandatoryFacts: true, rawTranscriptEditing: false },
    packs: ['jevris.observability', 'jevris.memory', 'jevris.skill-advice'],
    jev: { assist },
  };
}

const FAILURE = { toolClass: 'shell', exitClass: 'nonzero', family: 'shell:nonzero', signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'cccccccccccccccc', environmental: false, elapsed: 'lt10s', present: [] };

async function until(condition) {
  const stop = performance.now() + 30_000;
  while (!condition() && performance.now() < stop) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, 'the condition held before the generous bound');
}

async function withDaemon(config, run) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'b-repair-')));
  const root = join(home, 'repo');
  mkdirSync(root);
  const seen = [];
  const subscribers = [{ name: 'capture', handle: (ctx) => (seen.push({ body: ctx.body, jevAssist: ctx.jevAssist ?? null, mode: ctx.mode ?? null }), { ok: true }) }];
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, subscribers, log: () => undefined, limits: { budgetMs: { hot: 60_000, background: 60_000 } }, subscriberSliceMs: 60_000 });
  assert.equal(started.ok, true, started.ok ? '' : started.message);
  try {
    // Written after the start: a daemon that starts moves a file still saying `observe` (the old default) to the new default once.
    if (config !== null) {
      const dir = jevrisPaths({ home }).config;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'jevris.config.json'), JSON.stringify(config));
    }
    await answered(await sidecarRequest({ home, op: 'workspace.register', scope: 'hook', timeoutMs: 60_000, workspace: root }));
    let n = 0;
    const send = async (extra) => {
      n += 1;
      const before = seen.length;
      answered(await sidecarRequest({ home, op: 'event', scope: 'hook', timeoutMs: 60_000, workspace: root, body: { deliveryKey: `k-${String(n)}`, envelope: { kind: 'PostToolUse' }, ...extra } }));
      await until(() => seen.length > before);
      return seen[seen.length - 1];
    };
    await run({ send });
  } finally {
    await started.daemon.stop?.();
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test('a failure event carries the configured repair bound, whatever the hook claimed; other events carry none', { skip: managedHostSkip() }, async () => {
  await withDaemon(userConfig({ mode: 'observe', assist: 'classify', maxRepairAttempts: 5 }), async ({ send }) => {
    const failed = await send({ failure: FAILURE, repair: { maxAttempts: 99 } });
    assert.deepEqual(failed.body.repair, { maxAttempts: 5 }, 'the setting, not the hook claim');
    assert.deepEqual(failed.body.failure, FAILURE, 'the features reach the subscriber as sent');
    const claimedOnly = await send({ repair: { maxAttempts: 99 } });
    assert.equal(Object.hasOwn(claimedOnly.body, 'repair'), false, 'with no failure the claim is removed and nothing is added');
    const plain = await send({});
    assert.equal(Object.hasOwn(plain.body, 'repair'), false);
    const junk = await send({ failure: 'text of a failure' });
    assert.equal(Object.hasOwn(junk.body, 'repair'), false, 'a failure that is not an object adds nothing');
  });
});

test('with no configuration the bound is the default of 2', { skip: managedHostSkip() }, async () => {
  await withDaemon(null, async ({ send }) => {
    const failed = await send({ failure: FAILURE, repair: { maxAttempts: 99 } });
    assert.deepEqual(failed.body.repair, { maxAttempts: 2 });
  });
});

test('a subscriber that runs after the answer gets the effective jev.assist and mode', { skip: managedHostSkip() }, async () => {
  await withDaemon(userConfig({ mode: 'observe', assist: 'off', maxRepairAttempts: 3 }), async ({ send }) => {
    const seen = await send({ failure: FAILURE });
    assert.deepEqual([seen.mode, seen.jevAssist], ['observe', 'off'], 'jev.assist off holds for a subscriber queued after the answer');
    assert.deepEqual(seen.body.repair, { maxAttempts: 3 });
  });
  await withDaemon(userConfig({ mode: 'observe', assist: 'classify', maxRepairAttempts: 3 }), async ({ send }) => {
    const seen = await send({});
    assert.deepEqual([seen.mode, seen.jevAssist], ['observe', 'classify']);
  });
});
