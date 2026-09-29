/**
 * Acceptance fixture: this machine has certified a harness's hooks. `jevris certify` needs the
 * real harness binary (JEVRIS_LIVE_HARNESS=1), and npm test never starts one, so the two facts
 * certify leaves behind are written directly, the way the product writes them:
 * - a CertificationRecord signed by the local certify key in <data>/certifications/, with the
 *   public key in <data>/certifications/keys/local.pub.pem;
 * - the installed harness version in the host ledger (install and doctor record it with
 *   recordHarnessVersion).
 * Everything goes into the sandbox home.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join, relative } from 'node:path';
import { load } from './lib.mjs';

const DAY = 86_400_000;

export async function certifyHooks(box, { harness = 'claude', version = '2.1.280', features = ['hooks.observe', 'hooks.context'] } = {}) {
  const { jevrisPaths } = await load('platform');
  const { signRecord } = await load('contracts');
  const { localKeyId } = await import('@jevris/cli/certifications');
  const pair = generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const dir = relative(box.dir, join(jevrisPaths({ home: box.home, env: box.env }).data, 'certifications'));
  box.write(join(dir, 'keys', 'local.pub.pem'), pub);
  const [major, minor] = version.split('.').map(Number);
  const now = Date.now();
  const record = {
    id: `cert-${harness}-acceptance`,
    schemaVersion: '1.0',
    harness,
    actuatorId: `${harness}.hooks`,
    harnessVersionRange: { minimum: `${major}.${minor}.0`, maximumExclusive: `${major}.${minor + 1}.0` },
    operatingSystems: [process.platform],
    models: [],
    tools: [],
    limitations: [],
    fixtureSuiteHash: `sha256:${'a'.repeat(64)}`,
    features: features.map((featureId) => ({ featureId, status: 'certified', reasonCode: null })),
    certifiedAt: new Date(now - DAY).toISOString(),
    expiresAt: new Date(now + 30 * DAY).toISOString(),
  };
  box.write(join(dir, `${harness}.json`), signRecord(record, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), localKeyId(pub)));
  const orchestrator = new URL('../../packages/orchestrator/dist/index.js', import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(orchestrator)}); await m.recordHarnessVersion(${JSON.stringify(box.home)}, ${JSON.stringify(harness)}, ${JSON.stringify(version)});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: box.env, cwd: box.work, encoding: 'utf8' });
  assert.equal(run.status, 0, `recording the harness version failed: ${run.stderr}`);
}

/**
 * One hook delivery that must reach the sidecar and come back: it runs with the launcher's longest
 * deadline (4 s). The deadline covers process start, so a loaded machine can end a shorter one
 * before the event reaches the sidecar, and a restore's rehydrate budget is the hook's remaining
 * time: both are the degraded path, not what a story checks. A delivery that still ran out of
 * time fails here with its reason, instead of in a later, misleading assertion.
 */
export function deliverHook(box, harness, native) {
  const hook = box.hook(harness, native, { extraEnv: { JEVRIS_HOOK_DEADLINE_MS: '4000' } });
  assert.equal(hook.code, 0, `${native.hook_event_name} exited ${hook.code}: ${hook.stderr}`);
  assert.doesNotMatch(hook.reason ?? '', /DEADLINE|TIMEOUT/, `${native.hook_event_name} ran out of time (${hook.reason}): the machine is too loaded for the 4 s hook deadline`);
  return hook;
}
