import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { startJevStub } from './jev-stub.mjs';
import { load, story } from './lib.mjs';

// Source text and a credential reach Jevris as a tool result and as failure output. With host
// egress not approved, nothing but structured features may reach the (stub) provider; with it
// approved, the credential still never leaves (GOV-01, GOV-08, C50).

const MARKER = 'US02_SOURCE_MARKER_7f3a91';
const SECRET = ['aws_secret_access_key=', 'Q2x1ZGVz', 'aW5kZXgv', 'cHJvZmls', 'ZS9zaGFy', 'ZWQrdmFs'].join('');

const HOST = {
  schemaVersion: '1.0',
  mode: 'advise',
  egress: 'deny-until-approved',
  retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
  budget: { maxRequestBytes: 65536 },
  pin: { model: 'jev-1.13.0', respectHumanPins: true },
  packPrivileges: [],
  credentialRef: 'host-secret:typesafe-primary',
  installerEnvName: 'JEVRIS_INSTALLER_KEY',
  allowUncalibratedActuation: false,
};

async function scenario(t, sandbox, egress) {
  const provider = await startJevStub(t);
  const box = await sandbox({ env: provider.env });
  const { jevrisPaths } = await load('platform');
  const paths = jevrisPaths({ home: box.home });
  box.write(join(relative(box.dir, paths.config), 'host.json'), { ...HOST, egress });
  box.write('work/app/billing.ts', `// ${MARKER}\nexport const creds = '${SECRET}';\nexport function charge() { return 1; }\n`);
  assert.equal(box.startSidecar().code, 0, 'sidecar did not start');
  box.hook('claude', {
    hook_event_name: 'PostToolUse',
    session_id: 'us02',
    cwd: box.work,
    tool_name: 'Read',
    tool_input: { file_path: join(box.work, 'app', 'billing.ts') },
    tool_response: { file: { content: box.read('work/app/billing.ts') } },
  });
  const outputs = [
    box.jevris(['route', '--model', 'claude-opus-4-7'], { json: true }),
    box.jevris(['recover', '--failure', `TypeError at app/billing.ts ${MARKER}`, '--failure', `auth failed: ${SECRET}`], { json: true }),
    box.jevris(['recover', '--failure', `TypeError at app/billing.ts ${MARKER}`, '--failure', `TypeError at app/billing.ts ${MARKER}`], { json: true }),
  ];
  const log = box.read(join(relative(box.dir, paths.state), 'logs', 'sidecar.log'));
  return { box, provider, outputs, log, requests: provider.requests() };
}

story('US02', async ({ t, then, sandbox, evidence }) => {
  const denied = await scenario(t, sandbox, 'deny-until-approved');
  const approved = await scenario(t, sandbox, 'approved-scoped');
  // A repository file that claims approval: project files can only narrow host policy.
  const project = denied.box.write('work/.jevris/policy.json', { egress: 'approved-scoped' });
  const check = denied.box.jevris(['policy', 'check', '--home', denied.box.home, '--workspace', denied.box.work, '--would-send-source']);
  const withProject = denied.box.jevris(['policy', 'check', '--home', denied.box.home, '--workspace', denied.box.work, '--would-send-source', '--project', project]);
  evidence({ deniedCalls: denied.requests.length, approvedCalls: approved.requests.length, check: check.stdout });

  await then('No source request leaves the machine', () => {
    for (const out of denied.outputs) assert.equal(out.code, 0, `command failed: ${out.stderr}`);
    for (const { body } of denied.requests) {
      assert.equal(body.includes(MARKER), false, 'source text was sent without egress approval');
      assert.equal(body.includes('charge()'), false, 'source text was sent without egress approval');
      const state = JSON.parse(body).state ?? {};
      assert.deepEqual((state.untrustedEvidence ?? []).filter((item) => item.text.trim().length > 0), [], 'evidence text was sent without approval');
    }
    // Withheld evidence is described by size and digest only; nothing refused reaches the log.
    assert.ok(denied.requests.length > 0, 'no decision reached the provider, so nothing was proven');
    assert.equal(denied.log.includes(MARKER), false, 'source text reached the log');
    // With approval the credential still never leaves, in any request.
    for (const { body } of [...denied.requests, ...approved.requests]) assert.equal(body.includes(SECRET.split('=')[1]), false, 'a secret was sent to the provider');
    assert.equal(approved.log.includes(SECRET), false);
  });

  await then('a local explanation identifies the missing consent without revealing secrets', () => {
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /Egress denied: missing consent/);
    assert.doesNotMatch(withProject.stdout, /allowed|approved-scoped/i, 'a repository file approved egress');
    const texts = [check, withProject, ...denied.outputs, ...approved.outputs].flatMap((out) => [out.stdout, out.stderr]);
    for (const text of texts) {
      assert.equal(text.includes(SECRET.split('=')[1]), false, 'the explanation reveals a secret');
      assert.equal(text.includes(denied.provider.key), false, 'the explanation reveals the provider key');
    }
  });
});
