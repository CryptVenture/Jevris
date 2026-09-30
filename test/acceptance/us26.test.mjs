import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, story } from './lib.mjs';
import { scanRead } from '../live-files.mjs';

// Egress is approved, so evidence text may go to Jev; a credential or a sensitive path inside
// it must still be removed or rejected before transport (GOV-08, C50). The credentials are
// built at run time from their shape, so no key-shaped literal lives in the repository.

const repeat = (text, n) => Array.from({ length: n }, () => text).join('');
const TOKEN = ['gh', 'p_', repeat('Xk7q', 9)].join('');
const AWS = ['aws_secret_access_key=', repeat('Zm9v', 10)].join('');
const PATH_LINE = 'cat ~/.ssh/id_rsa && cat app/.env.production';

const HOST = {
  schemaVersion: '1.0',
  mode: 'advise',
  egress: 'approved-scoped',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

/** Every file under a directory, as text (the store and logs are small in a sandbox). */
function allText(dir) {
  let out = '';
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out += allText(full);
    else if (st.size < 32 * 1024 * 1024) out += scanRead(full).toString('latin1');
  }
  return out;
}

story('US26', async ({ t, then, sandbox, evidence }) => {
  const provider = await startJevStub(t);
  const box = await sandbox({ env: provider.env });
  const { jevrisPaths } = await load('platform');
  const paths = jevrisPaths({ home: box.home });
  box.write(join(relative(box.dir, paths.config), 'host.json'), HOST);
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');

  // A clean failure first: approved egress really does send evidence text.
  const clean = box.jevris(['recover', '--failure', 'TypeError at app/parse.ts:14', '--failure', 'TypeError at app/parse.ts:14'], { json: true });
  const cleanCalls = provider.requests().length;
  const withToken = box.jevris(['recover', '--failure', `push rejected for ${TOKEN}`, '--failure', `push rejected for ${TOKEN}`], { json: true });
  const withAws = box.jevris(['recover', '--failure', `boto3 failed: ${AWS}`, '--failure', `boto3 failed: ${AWS}`], { json: true });
  const withPath = box.jevris(['recover', '--failure', `permission denied: ${PATH_LINE}`, '--failure', `permission denied: ${PATH_LINE}`], { json: true });
  box.stopSidecar();
  const bodies = provider.requests().map((request) => request.body);
  evidence({ cleanCalls, calls: bodies.length, outcomes: [withToken.json?.result, withAws.json?.result, withPath.json?.result] });

  await then('The deterministic egress check removes or rejects it before transport, and logs contain no secret value', () => {
    assert.equal(clean.code, 0, clean.stderr);
    assert.ok(cleanCalls > 0, 'approved egress sent nothing, so the check was never exercised');
    assert.ok(bodies.slice(0, cleanCalls).some((body) => body.includes('app/parse.ts')), 'approved evidence text did not reach the provider');
    for (const out of [withToken, withAws, withPath]) assert.equal(out.code, 0, `recover failed: ${out.stderr}`);
    for (const body of bodies) {
      assert.equal(body.includes(TOKEN), false, 'a token reached the provider');
      assert.equal(body.includes(AWS.split('=')[1]), false, 'an AWS secret reached the provider');
      assert.equal(body.includes('id_rsa'), false, 'a sensitive path reached the provider');
      assert.equal(body.includes('.env.production'), false, 'a sensitive path reached the provider');
    }
    // Logs, the store and the decision journal hold no secret value either.
    const stored = allText(paths.state) + allText(paths.data) + allText(paths.config);
    for (const value of [TOKEN, AWS.split('=')[1]]) assert.equal(stored.includes(value), false, 'a secret value was written to a log, the store or the decision journal');
    for (const out of [withToken, withAws, withPath]) {
      assert.equal(`${out.stdout}${out.stderr}`.includes(TOKEN), false);
      assert.equal(`${out.stdout}${out.stderr}`.includes(AWS.split('=')[1]), false);
    }
  });
});
