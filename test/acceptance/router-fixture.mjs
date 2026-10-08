/**
 * Acceptance fixture for the routing stories (US03, US04, US06, US07, US10, US11, US34, W05).
 *
 * The worker router (core `routeTask`, `runManagedWorker`) runs on the evidence an evaluation
 * produces: a signed calibration release and per-slice quality intervals. Those are external
 * evidence (EVL-12, EVL-13, RLS-11), so the stories use a synthetic release signed by a key made
 * here, with its public key passed as the trusted calibration key, and state the conditional
 * pair: with a release that applies, the router selects within the floor; without one (or with
 * one that does not apply), it abstains or keeps the approved baseline.
 */
import { generateKeyPairSync } from 'node:crypto';
import { load } from './lib.mjs';

export const ACCOUNT = 'acct-acceptance';
export const SLICE = 'bounded-edit';
export const VOLUME = { inputTokens: 2_000_000, outputTokens: 200_000 };
export const ASSUMPTIONS = { verificationMicroUsd: 200_000, reworkMicroUsd: 3_000_000, routingOverheadMicroUsd: 21_000 };

/** A quality interval for one model on one slice (from the synthetic holdout). */
export const quality = (modelId, lower, point, upper, sliceId = SLICE) => ({ modelId, sliceId, lower, point, upper, sourceId: 'holdout-synthetic-acceptance' });

/**
 * The bundled §8.1 models, eligible for the acceptance account; `overrides[modelId]` patches one.
 * The stories exercise routing on evidence, not the calendar, so the lifecycle dates are left
 * out (an entry without them is usable). The lifecycle gate has its own paired tests (core
 * router.test.mjs), which fix the routing time.
 */
export async function registry(overrides = {}) {
  const { BUNDLED_MODEL_REGISTRY } = await load('core');
  return {
    ...BUNDLED_MODEL_REGISTRY,
    // The stories are written against an Opus 5.5 baseline and evaluated qualities for Opus 5 and Sonnet 5.
    // The bundled baseline moved to Sonnet 5.5 on 2026-10-08, so this administrator-style registry names its own.
    baselineModelId: 'claude-opus-5-5',
    harnessDefaults: BUNDLED_MODEL_REGISTRY.harnessDefaults.map((row) => (row.harness === 'claude' ? { ...row, baselineModelId: 'claude-opus-5-5' } : row)),
    entries: BUNDLED_MODEL_REGISTRY.entries.map(({ lifecycle: _lifecycle, ...entry }) => ({
      ...entry,
      accountEligibility: [{ accountId: ACCOUNT, eligible: true, checkedAt: '2026-09-22T00:00:00Z' }],
      effortLevels: ['low', 'medium', 'high'],
      health: 'healthy',
      ...(overrides[entry.modelId] ?? {}),
    })),
  };
}

export function policy(overrides = {}) {
  return {
    managedAllowlist: null,
    allowedRegions: ['global'],
    requiredContextTokens: 50_000,
    requiredCapabilities: ['tools'],
    pins: { modelPin: null, effortPin: null },
    riskFloorFamilies: null,
    accountId: ACCOUNT,
    ...overrides,
  };
}

/** A calibration signer: `release(overrides)` returns a signed worker-readiness release for `SLICE`. */
export async function calibrationSigner() {
  const core = await load('core');
  const { signRecord } = await load('contracts');
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = 'calibration-acceptance-key';
  const nowMs = Date.now();
  const context = core.workerCalibrationContext({ sliceId: SLICE, nowMs });
  const release = (overrides = {}) =>
    signRecord(
      {
        id: 'cal-worker-readiness-acceptance',
        schemaVersion: '1.0',
        releaseState: 'released',
        decisionSpecId: context.decisionSpecId,
        decisionSpecVersion: context.decisionSpecVersion,
        dataset: { id: 'synthetic-routing-corpus', version: 'v1', contentHash: `sha256:${'d'.repeat(64)}` },
        questionHash: context.questionHash,
        model: { modelId: context.modelId, revisionHash: context.modelRevisionHash },
        encoderHash: context.encoderHash,
        threshold: { metric: 'noul-probability', value: 0.8, errorBudget: 0.05 },
        permittedSlices: [{ sliceId: SLICE, calibrationSampleSize: 120, holdoutSampleSize: 60 }],
        uncertaintyInterval: { lower: 0.82, upper: 0.93, confidenceLevel: 0.95, method: 'wilson' },
        reviewer: { id: 'reviewer-acceptance', reviewedAt: new Date(nowMs - 2 * 86_400_000).toISOString() },
        issuedAt: new Date(nowMs - 86_400_000).toISOString(),
        expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
        expiryConditions: ['model-revision-changed', 'encoder-changed', 'question-changed'],
        ...overrides,
      },
      privateKeyPem,
      keyId,
    );
  return { release, trustedKeys: new Map([[keyId, publicKeyPem]]), context, keyId, publicKeyPem, privateKeyPem };
}
