// DLV-01..06 through the product: `jevris delivery <report>` and the jevris_delivery_report MCP
// tool, against a real sidecar in a temp home, on a real git repository. Each report is advice
// built from Jevris's own records; nothing is opened, merged, installed, run or changed in CI.
// The pairs: the same report before and after the evidence that changes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, sandbox } from '../../../test/acceptance/lib.mjs';
import { verifySettled } from '../../../test/acceptance/verify-run.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const pass = [process.execPath, '-e', 'process.exit(0)'];
const guardsFalse = (advice) => Object.values(advice.guards).every((flag) => flag === false);

async function repo(t, files = {}) {
  const box = await sandbox(t);
  for (const [path, text] of Object.entries(files)) box.write(join('work', path), text);
  box.gitInit();
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  return box;
}

// verify approve needs a person at a terminal (SR-1): the sandbox records the approval as the CLI does.
async function approve(box, checks) {
  box.write('work/jevris.checks.json', { schemaVersion: 'jevris-checks-1', checks });
  const approved = await box.approveChecks();
  assert.equal(approved.code, 0, approved.reason);
}

// A test that goes on to import or to read receipts runs its check through `verifySettled`, and goes on after the run has ended. `jevris verify`
// answers inside a window of its request and the run goes on after it, and the run ends with a freshness pass: it demotes a receipt imported
// meanwhile (a CI receipt carries the committed tree's revision and the workspace has its manifest file untracked), so ci-triage found no current
// CI failure and answered NO_CI_FAILURES on a slow host, where the same test passes on a fast one.
async function runCheck(box, id) {
  const run = await verifySettled(box, ['--check', id], { checks: [id] });
  assert.equal(run.code, 0, `${id} did not pass locally: ${run.stdout} ${run.stderr}`);
  return run;
}

function delivery(box, report, ...argv) {
  const out = box.jevris(['delivery', report, ...argv], { json: true });
  assert.notEqual(out.json, null, `${report}: ${out.stdout} ${out.stderr}`);
  assert.equal(out.json.mode, 'full', `${report} answered ${out.json.mode}: ${out.json.sidecar?.reasonCode}`);
  assert.equal(guardsFalse(out.json.result), true, `${report} advice carries a guard that is not false`);
  return out;
}

test('pr-readiness is assembled from receipts and the task graph, and opening or merging stays with the user (DLV-01)', { skip: managedHostSkip() }, async (t) => {
  const box = await repo(t, { 'src/a.js': 'export const a = 1;\n' });
  await approve(box, [{ id: 'unit', argv: pass }]);

  // Before the check runs: not ready, the mandatory check and the reported comments block it.
  const before = delivery(box, 'pr-readiness', '--comments', '2');
  assert.equal(before.code, 1, 'a change that is not ready is a negative answer');
  assert.equal(before.json.result.recommendation, 'not-ready');
  assert.deepEqual(before.json.result.ranked.map((item) => item.id).sort(), ['check:unit', 'comments']);
  assert.equal(before.json.result.requiresApproval, true);

  // The report as a pull-request body: written where GOV-11 allows, refused in Jevris's data.
  const human = box.jevris(['delivery', 'pr-readiness', '--body-out', 'pr-body.md']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /^Pull-request readiness: Not ready: 1 blockers\.$/m);
  assert.match(human.stdout, /applied: no \(advice only; nothing was created, merged, installed or run\)/);
  assert.match(human.stdout, /pull-request body: .*pr-body\.md \(open the pull request yourself with it\)/);
  const body = readFileSync(join(box.work, 'pr-body.md'), 'utf8');
  assert.match(body, /^## Readiness \(from Jevris\)/);
  assert.match(body, /- unit: missing/);
  assert.match(body, /Creating or merging a pull request needs explicit user or organization authority/);
  const { jevrisPaths } = await load('platform');
  const data = jevrisPaths({ home: box.home }).data;
  const refused = box.jevris(['delivery', 'pr-readiness', '--body-out', join(data, 'pr-body.md')]);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /^refused: OUTPUT_PRIVATE_DIR$/m);
  assert.equal(existsSync(join(data, 'pr-body.md')), false);

  // After the check passes on this revision: ready, and still nothing is opened.
  assert.equal((await runCheck(box, 'unit')).json.result.readiness, 'verified');
  const after = delivery(box, 'pr-readiness');
  assert.equal(after.code, 0);
  assert.equal(after.json.result.recommendation, 'ready');
  assert.deepEqual(after.json.result.kept, ['unit']);
  assert.match(after.json.result.summary, /Opening or merging it is yours to do/);

  // No surface creates or merges: the CLI has no such report and MCP has no such tool.
  for (const verb of ['pr-create', 'pr-merge', 'merge']) assert.equal(box.jevris(['delivery', verb]).code, 2, `delivery ${verb} exists`);
  const client = await box.mcp();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools.filter((name) => /pull|merge|pr_|open_pr|create_pr/.test(name)), []);
  const viaMcp = (await client.callTool({ name: 'jevris_delivery_report', arguments: { capabilityId: 'C57' } })).structuredContent;
  assert.equal(viaMcp.result.recommendation, 'ready');
  assert.equal(guardsFalse(viaMcp.result), true);
  const extra = await client.callTool({ name: 'jevris_delivery_report', arguments: { capabilityId: 'C57', input: { merge: true } } });
  assert.equal(extra.isError, true, 'an unknown input is refused, not ignored');
});

test('pr-readiness with no approved check names that as the blocker instead of "0 blockers" (JEV-0012)', { skip: managedHostSkip() }, async (t) => {
  const box = await repo(t, { 'src/a.js': 'export const a = 1;\n' });
  const out = delivery(box, 'pr-readiness');
  assert.equal(out.code, 1, 'no mandatory check is a negative answer');
  assert.equal(out.json.result.recommendation, 'not-ready');
  assert.deepEqual(out.json.result.ranked.map((item) => item.id), ['verification:unsupported']);
  assert.match(out.json.result.ranked[0].reason, /jevris verify (profile|approve)/);
  assert.doesNotMatch(out.json.result.summary, /\b0 blockers/);
  const human = box.jevris(['delivery', 'pr-readiness']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /^Pull-request readiness: Not ready: 1 blockers\.$/m);
  assert.match(human.stdout, /no mandatory check to verify against/);
});

test('ci-triage routes a failing CI receipt from its evidence and changes nothing in CI (DLV-02)', { skip: managedHostSkip() }, async (t) => {
  const box = await repo(t, { 'src/a.js': 'export const a = 1;\n' });
  const none = delivery(box, 'ci-triage');
  assert.equal(none.json.result.reasonCode, 'NO_CI_FAILURES');

  // CI failed 'unit' on this revision; the same check passes locally at the same revision.
  await approve(box, [{ id: 'unit', argv: pass }]);
  await runCheck(box, 'unit');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = box.write('keys/ci.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }).toString());
  assert.equal((await box.trustIssuer('gh-actions', pub, { repository: 'acme/app' })).code, 0);
  const head = box.git('rev-parse', 'HEAD').stdout.trim();
  const artifact = 'TAP version 13\nnot ok 1 - db\n1..1\n';
  const sha = createHash('sha256').update(artifact).digest('hex');
  box.write('artifacts/unit.tap', artifact);
  const { signRecord } = await load('contracts');
  const bundle = signRecord(
    { schemaVersion: 'jevris-ci-receipts-1', issuerId: 'gh-actions', jobId: 'run-7', repository: 'acme/app', revision: head, createdAt: new Date().toISOString(), checks: [{ checkId: 'unit', outcome: 'failed', rawOutputHash: sha, artifact: { name: 'unit.tap', sha256: sha } }] },
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'default',
  );
  const bundleFile = box.write('bundle.json', bundle);
  const imported = box.jevris(['verify', 'import-ci', bundleFile, '--artifacts', join(box.dir, 'artifacts')], { json: true });
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  const checks = readFileSync(join(box.work, 'jevris.checks.json'), 'utf8');

  const triaged = delivery(box, 'ci-triage');
  assert.equal(triaged.json.result.recommendation, 'infra');
  assert.match(triaged.json.result.ranked[0].reason, /passes locally at the same revision/);
  assert.match(triaged.json.result.notes.join(' '), /not changed by triage/);
  assert.equal(readFileSync(join(box.work, 'jevris.checks.json'), 'utf8'), checks, 'the checks changed');
});

test('upgrades ranks the real lockfile change by risk and installs nothing (DLV-03)', async (t) => {
  const lock = (version) => JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/leftpad': { version } } });
  const box = await repo(t, { 'package-lock.json': lock('1.2.0'), 'src/a.js': "import pad from 'leftpad';\nexport const a = pad('x');\n" });
  assert.equal(delivery(box, 'upgrades').json.result.reasonCode, 'NO_UPGRADES');
  await approve(box, [{ id: 'unit', argv: pass }]);
  box.write('work/package-lock.json', lock('2.0.0'));
  const planned = delivery(box, 'upgrades');
  assert.equal(planned.json.result.ranked[0].id, 'leftpad');
  assert.match(planned.json.result.ranked[0].label, /1\.2\.0 -> 2\.0\.0 \(major\)/);
  assert.deepEqual(planned.json.result.validation, ['unit']);
  assert.equal(existsSync(join(box.work, 'node_modules')), false, 'something was installed');
});

test('migrations need a rehearsal record and explicit approval for destructive steps, and nothing runs (DLV-04)', { skip: managedHostSkip() }, async (t) => {
  const box = await repo(t, { 'src/a.js': 'export const a = 1;\n' });
  box.write('work/migrations/002_drop.sql', 'ALTER TABLE users DROP COLUMN legacy;\nDROP TABLE sessions;\n');
  const unrehearsed = delivery(box, 'migrations', '--migrations', 'migrations/002_drop.sql');
  assert.deepEqual([unrehearsed.json.result.verb, unrehearsed.json.result.recommendation, unrehearsed.json.result.requiresApproval], ['pause', 'rehearse', true]);
  assert.deepEqual(unrehearsed.json.result.ranked.map((item) => item.id), ['migrations/002_drop.sql:1', 'migrations/002_drop.sql:2']);
  await approve(box, [{ id: 'migration-rehearsal', argv: pass }]);
  await runCheck(box, 'migration-rehearsal');
  const rehearsed = delivery(box, 'migrations', '--migrations', 'migrations/002_drop.sql');
  assert.equal(rehearsed.json.result.recommendation, 'approve-destructive', 'a rehearsal does not approve destructive steps');
  assert.equal(rehearsed.json.result.requiresApproval, true);
  // An absolute or escaping migration path is refused before anything is read.
  assert.equal(box.jevris(['delivery', 'migrations', '--migrations', '../outside.sql']).code, 2);
  assert.equal(box.jevris(['delivery', 'migrations', '--comments', '1']).code, 2, 'a flag of another report is refused');
});

test('docs-drift links changed exports to the documents that reference them (DLV-05)', async (t) => {
  const box = await repo(t, { 'src/api.ts': 'export function uploadFile() {}\n', 'docs/guide.md': 'Call `uploadFile()` to upload.\n', 'docs/other.md': 'Nothing here.\n' });
  assert.equal(delivery(box, 'docs-drift').json.result.reasonCode, 'NO_INTERFACE_CHANGE');
  box.write('work/src/api.ts', 'export function uploadFiles() {}\n');
  const drift = delivery(box, 'docs-drift');
  assert.deepEqual(drift.json.result.ranked.map((item) => item.id), ['docs/guide.md']);
  assert.equal(readFileSync(join(box.work, 'docs/guide.md'), 'utf8'), 'Call `uploadFile()` to upload.\n', 'a document was rewritten');
});

test('team-policy recommends a compatible configuration without activating it, keeping repository exceptions (DLV-06)', async (t) => {
  // The repository's own exception: at most one concurrent worker.
  const box = await repo(t, {
    'package.json': '{"name":"x","scripts":{"test":"node --test"}}\n',
    'src/a.ts': 'export const a = 1;\n',
    '.jevris/config.json': '{"orchestration":{"maxConcurrentWorkers":1}}\n',
  });
  const before = readdirSync(box.home, { recursive: true }).filter((p) => String(p).endsWith('config.json')).sort();
  const policy = delivery(box, 'team-policy');
  assert.equal(policy.json.result.recommendation, 'node-service');
  assert.equal(policy.json.result.requiresApproval, true);
  assert.match(policy.json.result.summary, /not activated/);
  assert.ok(policy.json.result.kept.includes('workspace:orchestration.maxConcurrentWorkers=1'), `the repository exception was not kept: ${JSON.stringify(policy.json.result.kept)}`);
  assert.equal(readFileSync(join(box.work, '.jevris/config.json'), 'utf8'), '{"orchestration":{"maxConcurrentWorkers":1}}\n');
  assert.deepEqual(readdirSync(box.home, { recursive: true }).filter((p) => String(p).endsWith('config.json')).sort(), before, 'a configuration was written');
});
