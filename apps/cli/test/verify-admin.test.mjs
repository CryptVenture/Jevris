// jevris verify profile|approve|revoke|required|waive|issuer|import-ci and jevris evidence get
// (CMD-05): D's host-ledger records from the CLI only, with a person confirming each change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runPublicCommand, runEvidenceCommand } = await import('../dist/public-commands.js');
const { base64Of, describeMetadata, safeArtifactName } = await import('../dist/verify-admin.js');
const { openWorkspace, requiredCheckReport, verificationSupport } = await import('../../../packages/orchestrator/dist/index.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-verify-admin-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(work, '.git'), { recursive: true });
  return { dir, home, work, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

function fakePorts(answer = NOT_RUNNING) {
  const calls = [];
  return {
    calls,
    ports: {
      sidecar: {
        async ensure(input) {
          calls.push({ kind: 'ensure', ...input });
          return { ok: true, endpoint: 'fake', started: false };
        },
        async request(input) {
          calls.push({ kind: 'request', ...input });
          return typeof answer === 'function' ? answer(input) : answer;
        },
      },
      engine: {},
      config: {},
    },
  };
}

// A confirmation stands for a person at an interactive terminal: `interactive` follows it unless
// a test says otherwise (SR-1: approve, issuer add and waive need a terminal and refuse --yes).
async function verify(box, argv, { confirm = null, ports = fakePorts().ports, interactive = confirm !== null, env = box.env } = {}) {
  let text = '';
  const code = await runPublicCommand('verify', argv, (chunk) => (text += chunk), { ports, env, cwd: box.work, confirm, interactive: () => interactive });
  // A refused channel answers with one plain line, even under --json.
  return { code, text, json: argv.includes('--json') && !text.startsWith('Nothing was changed (CHANNEL_REFUSED)') ? JSON.parse(text) : null };
}

function writeChecks(box) {
  writeFileSync(join(box.work, 'jevris.checks.json'), JSON.stringify({ schemaVersion: 'jevris-checks-1', checks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'] }] }));
}

const support = (box) => verificationSupport(openWorkspace({ home: box.home, workspaceRoot: box.work }), process.platform).state;

test('approve needs a person at a terminal: no terminal, --yes, --json or a test run changes nothing; a yes answer approves (pair)', async (t) => {
  const box = sandbox(t);
  writeChecks(box);
  const refused = await verify(box, ['approve']);
  assert.equal(refused.code, 2);
  assert.equal(refused.text, "Nothing was changed (CHANNEL_REFUSED): this changes what counts as verified, so it needs a person at an interactive terminal who answers y (never --yes, --json, MCP, a hook, a script, a pipe or a model's shell).\n");
  assert.equal(support(box), 'unsupported');

  // SR-1: --yes is refused, even at a terminal, and the person is never asked.
  const asked = [];
  const ask = async (q) => (asked.push(q), true);
  for (const [argv, extra] of [
    [['approve', '--yes'], {}],
    [['approve', '--yes'], { confirm: ask }],
    [['approve', '--json'], { confirm: ask }],
    [['approve', '--yes', '--json'], { confirm: ask }],
    [['approve'], { confirm: ask, env: { ...box.env, JEVRIS_TEST: '1' } }],
    [['approve'], { confirm: ask, interactive: false }],
  ]) {
    const out = await verify(box, argv, extra);
    assert.equal(out.code, 2, argv.join(' '));
    assert.match(out.text, /^Nothing was changed \(CHANNEL_REFUSED\): .*\n$/, argv.join(' '));
    assert.equal(out.text.split('\n').length, 2, 'one line');
  }
  assert.deepEqual(asked, [], 'a refused channel is never asked');
  assert.equal(support(box), 'unsupported');

  const declined = await verify(box, ['approve'], { confirm: async () => false });
  assert.equal(declined.code, 2);
  assert.equal(support(box), 'unsupported');

  const questions = [];
  const answered = await verify(box, ['approve'], { confirm: async (q) => (questions.push(q), true) });
  assert.equal(answered.code, 0);
  assert.match(questions[0], /Approve 1 check\(s\) from jevris\.checks\.json: unit/);
  assert.equal(support(box), 'supported');

  const revoked = await verify(box, ['revoke', '--yes', '--json']);
  assert.equal(revoked.code, 0);
  assert.equal(revoked.json.revoked, 1);
  assert.equal(support(box), 'unsupported');

  const again = await verify(box, ['approve'], { confirm: async () => true });
  assert.deepEqual([again.code, again.text], [0, 'Approved: unit\n']);
  assert.equal(support(box), 'supported');
});

test('approve without a manifest, profile and --proposal answer without guessing', async (t) => {
  const box = sandbox(t);
  const none = await verify(box, ['approve', '--json']);
  assert.equal(none.code, 1);
  assert.equal(none.json.reasonCode, 'NO_MANIFEST');

  writeFileSync(join(box.work, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -e 0' } }));
  const profile = await verify(box, ['profile', '--json']);
  assert.equal(profile.json.proposal.schemaVersion, 'jevris-checks-1');
  assert.equal(support(box), 'unsupported', 'profile writes nothing');
  if (profile.json.proposal.checks.length > 0) {
    const approved = await verify(box, ['approve', '--proposal'], { confirm: async () => true });
    assert.equal(approved.code, 0);
    assert.equal(approved.text, `Approved: ${profile.json.proposal.checks.map((c) => c.id).sort().join(', ')}\n`);
  }
});

test('profile names what it detected and says the build and test semantics are unverified when no analyzer understands it (W12)', async (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.work, 'main.c'), 'int main(void) { return 0; }\n');
  writeFileSync(join(box.work, 'util.c'), 'int util(void) { return 1; }\n');
  writeFileSync(join(box.work, 'firmware.uvprojx'), '<Project/>\n');
  const json = await verify(box, ['profile', '--json']);
  assert.equal(json.json.proposal.semantics, 'unverified');
  const plain = await verify(box, ['profile']);
  assert.equal(plain.code, 1);
  assert.equal(plain.text, 'Detected: Keil µVision project (firmware.uvprojx), C (2 files). No certified analyzer understands them, so build and test semantics are unverified. Write jevris.checks.json by hand.\n');
  // Partly understood: the npm checks are proposed and the C sources are listed as unverified.
  writeFileSync(join(box.work, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -e 0' } }));
  const partial = await verify(box, ['profile', '--json']);
  assert.equal(partial.json.proposal.semantics, 'partial');
  const text = (await verify(box, ['profile'])).text;
  assert.match(text, /^Proposed checks \(nothing was written\):$/m);
  assert.match(text, /^Also detected, with build and test semantics unverified/m);
  assert.match(text, /^ {2}Keil µVision project \(firmware\.uvprojx\)$/m);
  assert.match(text, /^ {2}C \(2 files\)$/m);
  assert.equal(describeMetadata({ kind: 'language', id: 'rust', evidence: 'src/a.rs', count: 1 }), 'Rust (1 file)');
  assert.equal(describeMetadata({ kind: 'project', id: 'bazel', evidence: 'BUILD.bazel', count: 1 }), 'Bazel project (BUILD.bazel)');
});

test('waive records a named authority and required shows it as waived, never passed', async (t) => {
  const box = sandbox(t);
  assert.equal((await verify(box, ['waive', 'e2e', '--yes'])).code, 2, '--reason is required');
  const scripted = await verify(box, ['waive', 'e2e', '--reason', 'No browser here', '--authority', 'alice', '--yes']);
  assert.equal(scripted.code, 2, 'a waiver needs a person at a terminal (SR-1)');
  assert.match(scripted.text, /^Nothing was changed \(CHANNEL_REFUSED\): a waiver lets the required-check report complete without the check/);
  const waived = await verify(box, ['waive', 'e2e', '--reason', 'No browser here', '--authority', 'alice'], { confirm: async () => true });
  assert.equal(waived.code, 0);
  assert.match(waived.text, /^e2e is waived by alice\./);
  // The report comes from D's verify.required op (receipts live in the store). The fake
  // sidecar answers with D's report over the same host ledger.
  const op = fakePorts((input) =>
    input.op === 'verify.required' ? { ok: true, result: { checks: requiredCheckReport(openWorkspace({ home: box.home, workspaceRoot: box.work }), input.body.checkIds) } } : NOT_RUNNING,
  );
  const required = await verify(box, ['required', 'e2e', 'unit', '--json'], { ports: op.ports });
  assert.equal(required.code, 1, 'unit is missing');
  assert.deepEqual(required.json.checks.map((c) => [c.checkId, c.status, c.waiverAuthority]), [['e2e', 'waived', 'alice'], ['unit', 'missing', null]]);
  const request = op.calls.find((c) => c.kind === 'request');
  assert.deepEqual([request.op, request.scope, request.budget, request.body], ['verify.required', 'cli', 'hot', { checkIds: ['e2e', 'unit'] }]);

  const down = await verify(box, ['required', 'e2e', '--json']);
  assert.equal(down.code, 1, 'no local report: receipts are read only by the sidecar');
  assert.deepEqual(down.json.checks, []);
  assert.equal(down.json.reasonCode, 'NOT_RUNNING');
  const forged = await verify(box, ['required', 'e2e', '--json'], { ports: fakePorts({ ok: true, result: { checks: [{ checkId: 'other', status: 'passed', receiptId: null, issuer: null, waiverAuthority: null }] } }).ports });
  assert.equal(forged.code, 1);
  assert.equal(forged.json.reasonCode, 'SIDECAR_INVALID_RESULT', 'a line for a check that was not asked about is refused');
  assert.equal((await verify(box, ['required', '--json'])).code, 2);

  // D answers in sorted order: lines are matched by id, shown in the order named, and a
  // repeated id is asked for and shown once.
  const unsorted = await verify(box, ['required', 'unit', 'e2e', 'unit', '--json'], { ports: op.ports });
  assert.equal(unsorted.code, 1);
  assert.deepEqual(unsorted.json.checks.map((c) => [c.checkId, c.status]), [['unit', 'missing'], ['e2e', 'waived']]);
  assert.deepEqual(op.calls.filter((c) => c.kind === 'request').at(-1).body, { checkIds: ['unit', 'e2e'] });
  const doubled = await verify(box, ['required', 'e2e', 'unit', '--json'], {
    ports: fakePorts({ ok: true, result: { checks: ['e2e', 'e2e'].map((checkId) => ({ checkId, status: 'passed', receiptId: null, issuer: null, waiverAuthority: null })) } }).ports,
  });
  assert.equal(doubled.json.reasonCode, 'SIDECAR_INVALID_RESULT', 'a missing line cannot be covered by a repeated one');
});

test('issuer add takes only an Ed25519 public key and list never prints key material', async (t) => {
  const box = sandbox(t);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = join(box.dir, 'ci.pub.pem');
  const priv = join(box.dir, 'ci.key.pem');
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  assert.equal((await verify(box, ['issuer', 'add', 'github-ci', '--key', priv, '--yes'])).code, 2, 'a private key is refused');
  assert.equal((await verify(box, ['issuer', 'add', 'github-ci', '--key', pub, '--repository', 'not a repo', '--yes'])).code, 2);
  assert.equal((await verify(box, ['issuer', 'add', 'github-ci', '--key', pub])).code, 2, 'unconfirmed');
  const scripted = await verify(box, ['issuer', 'add', 'github-ci', '--key', pub, '--repository', 'acme/app', '--yes'], { confirm: async () => true });
  assert.equal(scripted.code, 2, 'trusting an issuer needs a person at a terminal, never --yes (SR-1)');
  assert.match(scripted.text, /^Nothing was changed \(CHANNEL_REFUSED\): trusting a CI issuer lets its signed receipts count as passed/);
  assert.deepEqual((await verify(box, ['issuer', 'list', '--json'])).json.issuers, []);
  const added = await verify(box, ['issuer', 'add', 'github-ci', '--key', pub, '--repository', 'acme/app'], { confirm: async () => true });
  assert.equal(added.code, 0);
  const listed = await verify(box, ['issuer', 'list', '--json']);
  assert.deepEqual(listed.json.issuers.map((i) => [i.issuerId, i.repository, i.keyIds]), [['github-ci', 'acme/app', ['default']]]);
  assert.equal(listed.text.includes('BEGIN PUBLIC KEY'), false);
  assert.equal((await verify(box, ['issuer', 'remove', 'github-ci', '--yes'])).code, 0);
  assert.deepEqual((await verify(box, ['issuer', 'list', '--json'])).json.issuers, []);
});

test('import-ci sends the bundle and its artifacts to the sidecar and reports the receipts', async (t) => {
  const box = sandbox(t);
  const artifacts = join(box.dir, 'artifacts');
  mkdirSync(join(artifacts, 'logs'), { recursive: true });
  writeFileSync(join(artifacts, 'logs', 'unit.txt'), 'ok\n');
  const bundle = join(box.dir, 'bundle.json');
  writeFileSync(bundle, JSON.stringify({ checks: [{ checkId: 'unit', artifact: { name: 'logs/unit.txt' } }] }));
  const imported = fakePorts({ ok: true, result: { accepted: true, reasonCode: 'IMPORTED', binding: 'current', receiptIds: ['r-1'] } });
  const ok = await verify(box, ['import-ci', bundle, '--artifacts', artifacts, '--json'], { ports: imported.ports });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json.receiptIds, ['r-1']);
  const request = imported.calls.find((c) => c.kind === 'request');
  assert.equal(request.op, 'verify.import-ci');
  assert.equal(request.scope, 'cli');
  assert.deepEqual(request.body.artifacts, [{ name: 'logs/unit.txt', base64: base64Of(new TextEncoder().encode('ok\n')) }]);

  const refusedBundle = await verify(box, ['import-ci', bundle, '--artifacts', artifacts, '--json'], { ports: fakePorts({ ok: true, result: { accepted: false, reasonCode: 'UNKNOWN_ISSUER', binding: null, receiptIds: [] } }).ports });
  assert.equal(refusedBundle.code, 1);
  assert.equal(refusedBundle.json.reasonCode, 'UNKNOWN_ISSUER');

  const down = await verify(box, ['import-ci', bundle, '--artifacts', artifacts, '--json']);
  assert.equal(down.code, 1, 'no local path: receipts land only through the sidecar');
  assert.equal(down.json.accepted, false);

  writeFileSync(bundle, JSON.stringify({ checks: [{ checkId: 'unit', artifact: { name: '../secret.txt' } }] }));
  const escape = fakePorts();
  assert.equal((await verify(box, ['import-ci', bundle, '--artifacts', artifacts], { ports: escape.ports })).code, 2);
  assert.equal(escape.calls.length, 0);
});

test('artifact names and base64 are safe and standard', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'a\\..\\b', '', 'x\0y', 'a b', 'x'.repeat(201)]) assert.equal(safeArtifactName(bad), false, bad);
  for (const good of ['a.txt', 'logs/unit.txt', 'a..b/c']) assert.equal(safeArtifactName(good), true, good);
  for (let n = 0; n < 40; n += 1) {
    const bytes = randomBytes(n);
    assert.equal(base64Of(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('evidence get returns not found locally and refuses a malformed handle', async (t) => {
  const box = sandbox(t);
  const run = async (argv) => {
    let text = '';
    const code = await runEvidenceCommand(argv, (chunk) => (text += chunk), { ports: fakePorts().ports, env: box.env, cwd: box.work });
    return { code, text };
  };
  // JEV-0015: only the ev:<64 hex> handle Jevris issues is accepted; an invented output:<id> handle is refused.
  assert.equal((await run(['get', 'output:nothing-here', '--json'])).code, 2);
  const missing = await run(['get', `ev:${'0'.repeat(64)}`, '--json']);
  assert.equal(missing.code, 1);
  const value = JSON.parse(missing.text);
  assert.equal(value.mode, 'reduced');
  assert.equal(value.result.found, false);
  assert.equal((await run(['get', '../etc/passwd'])).code, 2);
  assert.equal((await run(['list'])).code, 2);
  assert.match((await run(['--help'])).text, /Exit codes:/);
});

test('owned mode: on needs a person at a terminal (never --yes), off never does, and the setting is per workspace (TOOL-10)', async (t) => {
  const box = sandbox(t);
  const { ownedModeEnabled, workspaceIdFor } = await import('../../../packages/orchestrator/dist/index.js');
  const id = workspaceIdFor(box.work);
  const configure = async (argv, confirm = null) => {
    let text = '';
    const code = await runPublicCommand('configure', argv, (chunk) => (text += chunk), { ports: fakePorts().ports, env: box.env, cwd: box.work, confirm, interactive: () => confirm !== null });
    return { code, text };
  };
  assert.equal((await configure(['owned-mode', 'on'])).code, 2, 'no terminal');
  assert.equal(ownedModeEnabled(box.home, id), false);
  const scripted = await configure(['owned-mode', 'on', '--yes'], async () => true);
  assert.equal(scripted.code, 2, '--yes is refused (SR-1)');
  assert.match(scripted.text, /^Nothing was changed \(CHANNEL_REFUSED\): owned mode lets MCP clients start owned work/);
  assert.equal(ownedModeEnabled(box.home, id), false);
  assert.equal((await configure(['owned-mode', 'on'], async () => false)).code, 2);
  assert.equal(ownedModeEnabled(box.home, id), false);
  assert.equal((await configure(['owned-mode', 'on', '--json'], async () => true)).code, 2, '--json is scripted: it is refused');
  const on = await configure(['owned-mode', 'on'], async () => true);
  assert.equal(on.code, 0);
  assert.equal(JSON.parse((await configure(['owned-mode', '--json'])).text).enabled, true);
  assert.equal(ownedModeEnabled(box.home, id), true);
  assert.match((await configure(['owned-mode'])).text, /Owned mode is on/);
  assert.equal((await configure(['owned-mode', 'off'])).code, 0, 'turning it off needs no confirmation');
  assert.equal(ownedModeEnabled(box.home, id), false);
  assert.equal((await configure(['owned-mode', 'maybe'])).code, 2);
});
