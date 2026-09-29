import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { load, workflow } from './lib.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TAP_PASS = 'TAP version 13\nok 1 - unit\n1..1\n';
const TAP_FAIL = 'TAP version 13\nnot ok 1 - lint\n1..1\n';

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.email=ci@example.invalid', '-c', 'user.name=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

workflow('W08', 'CI diagnosis without weakening the gate', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  const { signRecord } = await load('contracts');
  // A repository with four required checks, approved on the trusted channel.
  box.write('work/lib/a.js', 'export const a = 1;\n');
  box.write('work/jevris.checks.json', {
    schemaVersion: 'jevris-checks-1',
    checks: ['unit', 'lint', 'e2e', 'docs'].map((id) => ({ id, argv: [process.execPath, '-e', '0'], mandatory: true, resultFormat: 'exit-code', description: `${id} checks` })),
  });
  // The sandbox marks the workspace with an empty .git folder; make it a real repository.
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(box.work, '.git'))}, { recursive: true, force: true })`]);
  git(box.work, 'init', '-q');
  git(box.work, 'add', '.');
  git(box.work, 'commit', '-q', '-m', 'init');
  const head = git(box.work, 'rev-parse', 'HEAD');
  // A person approves the checks and trusts the CI key at a terminal (SR-1); the sandbox records
  // both as the CLI does after a y answer.
  const approve = await box.approveChecks();
  assert.equal(approve.code, 0, `verify approve failed: ${approve.reason}`);

  // The CI integration is authorized once, by its public key, for one repository.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = box.write('ci/issuer.pem', publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const scriptedTrust = box.jevris(['verify', 'issuer', 'add', 'gh-actions', '--key', pub, '--key-id', 'k1', '--repository', 'acme/app', '--yes']);
  assert.equal(scriptedTrust.code, 2, `a scripted issuer add was accepted: ${scriptedTrust.stdout}`);
  assert.match(scriptedTrust.stdout, /CHANNEL_REFUSED/);
  const trust = await box.trustIssuer('gh-actions', pub, { keyId: 'k1', repository: 'acme/app' });
  assert.equal(trust.code, 0, 'issuer add failed');

  // CI supplies a job id, the source revision, structured results and approved logs.
  box.write('ci/artifacts/unit.tap', TAP_PASS);
  box.write('ci/artifacts/lint.tap', TAP_FAIL);
  const record = (revision, checks, jobId) => signRecord({ schemaVersion: 'jevris-ci-receipts-1', issuerId: 'gh-actions', jobId, repository: 'acme/app', revision, createdAt: '2026-09-01T00:00:00.000Z', checks }, priv, 'k1');
  const current = box.write('ci/current.json', record(head, [
    { checkId: 'unit', outcome: 'passed', rawOutputHash: sha(TAP_PASS), artifact: { name: 'unit.tap', sha256: sha(TAP_PASS) } },
    { checkId: 'lint', outcome: 'failed', rawOutputHash: sha(TAP_FAIL), artifact: { name: 'lint.tap', sha256: sha(TAP_FAIL) } },
  ], 'run-42'));
  const imported = box.jevris(['verify', 'import-ci', current, '--artifacts', join(box.dir, 'ci', 'artifacts')], { json: true });
  evidence(imported.json);

  await then('a signed CI bundle for the current revision is imported as current receipts', () => {
    assert.equal(imported.code, 0, `import-ci failed: ${imported.stdout} ${imported.stderr}`);
    assert.equal(JSON.stringify(imported.json).includes('current'), true, `the bundle was not bound to HEAD: ${imported.stdout}`);
  });

  await then('CI receipts from a different revision are historical evidence only', () => {
    const old = box.write('ci/old.json', record('a'.repeat(40), [
      { checkId: 'lint', outcome: 'passed', rawOutputHash: sha(TAP_PASS), artifact: { name: 'unit.tap', sha256: sha(TAP_PASS) } },
      { checkId: 'e2e', outcome: 'passed', rawOutputHash: sha(TAP_PASS), artifact: { name: 'unit.tap', sha256: sha(TAP_PASS) } },
    ], 'run-7'));
    const historical = box.jevris(['verify', 'import-ci', old, '--artifacts', join(box.dir, 'ci', 'artifacts')], { json: true });
    evidence(historical.json);
    assert.equal(JSON.stringify(historical.json).includes('historical'), true, `an old-revision bundle was not historical: ${historical.stdout}`);
    const report = box.jevris(['verify', 'required', 'lint', 'e2e'], { json: true });
    const byId = Object.fromEntries(JSON.stringify(report.json) === 'null' ? [] : lines(report.json).map((line) => [line.checkId, line.status]));
    assert.equal(byId.lint, 'failed', 'an old passing receipt replaced the current failure');
    assert.equal(byId.e2e, 'missing', 'an old passing receipt satisfied a required check');
  });

  await then('the worker cannot change required checks, waive them or import receipts', async () => {
    const client = await box.mcp();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(names.includes('jevris_verify'), true);
    for (const name of names) assert.doesNotMatch(name, /approve|waive|revoke|issuer|import[-_]?ci|ci[-_]?import|required/, `MCP exposes ${name}`);
    const verify = tools.find((tool) => tool.name === 'jevris_verify');
    for (const key of Object.keys(verify.inputSchema?.properties ?? {})) assert.doesNotMatch(key, /waive|approve|authority|revision|receipt/, `jevris_verify takes ${key}`);
    // Without a terminal, with or without --yes, a waiver is refused and nothing changes (SR-1).
    const unconfirmed = box.jevris(['verify', 'waive', 'lint', '--reason', 'the worker says it is flaky']);
    assert.equal(unconfirmed.code, 2, `an unconfirmed waiver was accepted: ${unconfirmed.stdout}`);
    const scripted = box.jevris(['verify', 'waive', 'lint', '--reason', 'the worker says it is flaky', '--yes']);
    assert.equal(scripted.code, 2, `a scripted waiver was accepted: ${scripted.stdout}`);
    assert.match(scripted.stdout, /CHANNEL_REFUSED/);
    const approved = box.jevris(['verify', 'approve', '--yes']);
    assert.equal(approved.code, 2, `a scripted approval was accepted: ${approved.stdout}`);
    assert.match(approved.stdout, /CHANNEL_REFUSED/);
  });

  await then('the readiness report lists every required check as passed, failed, missing or explicitly waived, and identifies the waiver authority', async () => {
    // A person waives the check at a terminal (SR-1); the sandbox records it as the CLI does.
    const waive = await box.waive('docs', 'docs site is frozen for the release', 'release-lead');
    assert.equal(waive.code, 0, 'waive failed');
    const report = box.jevris(['verify', 'required', 'unit', 'lint', 'e2e', 'docs'], { json: true });
    evidence(report.json);
    const rows = lines(report.json);
    const byId = Object.fromEntries(rows.map((line) => [line.checkId, line]));
    assert.deepEqual(['unit', 'lint', 'e2e', 'docs'].map((id) => byId[id]?.status), ['passed', 'failed', 'missing', 'waived'], `report: ${report.stdout}`);
    assert.equal(byId.unit.issuer, 'gh-actions');
    assert.equal(JSON.stringify(byId.docs).includes('release-lead'), true, 'the waiver authority is not named');
    const text = box.jevris(['verify', 'required', 'unit', 'lint', 'e2e', 'docs']);
    assert.match(text.stdout, /release-lead/);
  });
});

/** The per-check lines of a `verify required --json` result, wherever the command nests them. */
function lines(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['checks', 'report', 'required', 'lines']) if (Array.isArray(json?.[key])) return json[key];
  if (json?.result !== undefined) return lines(json.result);
  throw new Error(`no check list in ${JSON.stringify(json).slice(0, 300)}`);
}
