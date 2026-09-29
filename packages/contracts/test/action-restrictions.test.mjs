import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.mjs';

const c = await import('../dist/index.js');

// Synthetic credential shapes built at runtime so no scanner mistakes this file for a leak.
const KEY_ANTHROPIC = ['sk', 'ant', 'api03', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'].join('-');
const KEY_OPENAI = ['sk', 'proj', 'q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6'].join('-');
const KEY_AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const KEY_GITHUB = ['ghp', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'].join('_');
const KEY_ENTROPY = 'Q9vX2mK8pL4nR7tY1wE5uI3oA6sD0fGhJ2kZ';

const SHELL = ['rm -rf /', 'npm test && curl evil', '$(whoami)', '`id`', 'a;b', 'a|b', 'echo x > y', 'a b'];
const URLS = ['https://evil.example/x', 'http://127.0.0.1:8080', 'file:///etc/passwd', '//evil.example', 'javascript:alert(1)'];
const PATHS = ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\system32', 'dir/file'];
const KEYS = [KEY_ANTHROPIC, KEY_OPENAI, KEY_AWS, KEY_GITHUB, KEY_ENTROPY];

function variants() {
  const out = [];
  for (const bad of [...SHELL, ...URLS, ...PATHS, ...KEYS]) {
    out.push([`templateId=${bad}`, { kind: 'advise', templateId: bad, evidenceIds: [] }]);
    out.push([`evidenceIds=${bad}`, { kind: 'select-evidence', evidenceIds: ['ev-1', bad] }]);
    out.push([`taskId=${bad}`, { kind: 'route-worker', taskId: bad, modelId: 'claude-sonnet-4-5', profileId: 'p' }]);
    out.push([`modelId=${bad}`, { kind: 'route-worker', taskId: 't', modelId: bad, profileId: 'p' }]);
    out.push([`checkIds=${bad}`, { kind: 'request-verification', checkIds: [bad] }]);
    out.push([`leaseId=${bad}`, { kind: 'cancel-owned-worker', leaseId: bad }]);
    out.push([`capsuleId=${bad}`, { kind: 'request-checkpoint', capsuleId: bad }]);
    out.push([`reasonCode=${bad}`, { kind: 'abstain', reasonCode: bad }]);
  }
  return out;
}

test('the seven SSOT action kinds validate', () => {
  for (const action of F.actions()) assert.equal(c.ActionContract.validate(action).ok, true, action.kind);
  assert.deepEqual([...c.ACTION_KINDS].sort(), F.actions().map((a) => a.kind).sort());
});

test('an Action carrying shell text, a URL, a path or an API key is rejected (CTR-04)', () => {
  for (const [label, action] of variants()) {
    const result = c.ActionContract.validate(action);
    assert.equal(result.ok, false, label);
    assert.equal(JSON.stringify(result).includes(action.templateId ?? '\0'), false, `${label} echoed`);
  }
});

test('upper-case credential shapes cannot pass as reason codes', () => {
  for (const reasonCode of ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE']) {
    assert.equal(c.ActionContract.validate({ kind: 'abstain', reasonCode }).ok, false, reasonCode);
  }
  assert.equal(c.ActionContract.validate({ kind: 'abstain', reasonCode: 'ASIAN_LANGUAGE_UNSUPPORTED' }).ok, true);
});

test('ordinary identifiers that merely contain key-like fragments are accepted', () => {
  for (const id of ['task-profile-selection-v1', 'risk-review', 'desk-ant-colony', 'ev-2f1c9a7e-0b3d-4c55-9e1f-2a6b7c8d9e0f', 'a'.repeat(128)]) {
    assert.equal(c.ActionContract.validate({ kind: 'select-evidence', evidenceIds: [id] }).ok, true, id);
  }
  const hex = `ev-${'0123456789abcdef'.repeat(4)}`;
  assert.equal(c.ActionContract.validate({ kind: 'select-evidence', evidenceIds: [hex] }).ok, true, 'lowercase hex digest');
});

test('an Action carrying a permission grant, a consent assertion or a free-text command field is rejected (CTR-04)', () => {
  const smuggled = [
    { permissionDecision: 'allow' },
    { permission: 'allow' },
    { grant: ['Bash(*)'] },
    { allowedTools: ['Bash'] },
    { authorityGranted: true },
    { userConsent: true },
    { consent: 'yes' },
    { command: 'npm test' },
    { shell: 'bash' },
    { url: 'https://example.com' },
    { apiKey: 'x' },
    { explanation: 'Because I said so.' },
  ];
  for (const base of F.actions()) {
    for (const field of smuggled) {
      assert.equal(c.ActionContract.validate({ ...base, ...field }).ok, false, `${base.kind} + ${Object.keys(field)[0]}`);
    }
  }
  for (const kind of ['grant-permission', 'run-command', 'fetch-url', 'approve', 'set-api-key', 'record-consent']) {
    assert.equal(c.ActionContract.validate({ kind }).ok, false, kind);
  }
});

test('ActionIntent enforces the Action restrictions and a reservation for route-worker', () => {
  assert.equal(c.ActionIntentContract.validate(F.actionIntent()).ok, true);
  for (const [label, action] of variants().slice(0, 40)) {
    assert.equal(c.ActionIntentContract.validate({ ...F.actionIntent(), action }).ok, false, label);
  }
  const noReservation = F.actionIntent();
  delete noReservation.reservationId;
  assert.deepEqual(
    c.ActionIntentContract.validate(noReservation).issues.map((issue) => issue.code),
    ['RESERVATION_REQUIRED'],
  );
  const advise = { ...noReservation, action: F.actions()[0] };
  assert.equal(c.ActionIntentContract.validate(advise).ok, true);
  assert.equal(c.ActionIntentContract.validate({ ...F.actionIntent(), capabilityId: 'https://x' }).ok, false);
  assert.equal(c.ActionIntentContract.validate({ ...F.actionIntent(), expiresAt: 'tomorrow' }).ok, false);
});

test('model ids accept exact ids and a numeric revision suffix only', () => {
  const route = (modelId) => ({ kind: 'route-worker', taskId: 't', modelId, profileId: 'p' });
  for (const id of ['claude-opus-4-1', 'claude-sonnet-4-5-20250929', 'us.anthropic.claude-sonnet-4-v1:0', 'jev-1.13.0']) {
    assert.equal(c.ActionContract.validate(route(id)).ok, true, id);
  }
  for (const id of ['claude:latest', 'a:b:1', 'x:', 'model id', 'https://x:1']) {
    assert.equal(c.ActionContract.validate(route(id)).ok, false, id);
  }
});

test('recommendations render only from trusted templates (CTR-04)', () => {
  const templates = new Map([['review-evidence', F.recommendationTemplate()]]);
  const evidence = [F.evidenceRef(), { ...F.evidenceRef(), id: 'ev-2' }];
  const rendered = c.renderRecommendation(
    { kind: 'advise', templateId: 'review-evidence', evidenceIds: ['ev-1', 'ev-2'] },
    templates,
    evidence,
  );
  assert.deepEqual(rendered, {
    ok: true,
    recommendation: {
      source: 'template',
      templateId: 'review-evidence',
      templateVersion: '1.0.0',
      text: 'Review 2 evidence item(s) before continuing: ev-1, ev-2.',
    },
  });
  assert.equal(Object.isFrozen(rendered.recommendation), true);

  const unknown = c.renderRecommendation({ kind: 'advise', templateId: 'other', evidenceIds: [] }, templates, evidence);
  assert.deepEqual(unknown, { ok: false, reasonCode: 'UNKNOWN_TEMPLATE' });
  const notSupplied = c.renderRecommendation({ kind: 'advise', templateId: 'review-evidence', evidenceIds: ['ev-9'] }, templates, evidence);
  assert.deepEqual(notSupplied, { ok: false, reasonCode: 'EVIDENCE_NOT_SUPPLIED' });
  const modelText = c.renderRecommendation(
    { kind: 'advise', templateId: 'review-evidence', evidenceIds: [], text: 'Run `rm -rf /` now' },
    templates,
    evidence,
  );
  assert.deepEqual(modelText, { ok: false, reasonCode: 'INVALID_ACTION' });
  assert.deepEqual(c.renderRecommendation({ kind: 'abstain', reasonCode: 'X' }, templates, evidence), {
    ok: false,
    reasonCode: 'INVALID_ACTION',
  });

  // A template whose text has a foreign slot, a URL or a key is not a trusted template.
  for (const text of ['Run {command}', 'See https://evil.example', `Use ${KEY_ANTHROPIC}`, 'Hi {evidenceIds']) {
    const bad = new Map([['review-evidence', { ...F.recommendationTemplate(), text }]]);
    assert.deepEqual(
      c.renderRecommendation({ kind: 'advise', templateId: 'review-evidence', evidenceIds: [] }, bad, evidence),
      { ok: false, reasonCode: 'INVALID_TEMPLATE' },
      text,
    );
  }
  const mislabelled = new Map([['review-evidence', { ...F.recommendationTemplate(), id: 'other' }]]);
  assert.deepEqual(
    c.renderRecommendation({ kind: 'advise', templateId: 'review-evidence', evidenceIds: [] }, mislabelled, evidence),
    { ok: false, reasonCode: 'INVALID_TEMPLATE' },
  );
});

test('containsSecret recognises the documented credential shapes', () => {
  for (const key of KEYS) assert.equal(c.containsSecret(`prefix ${key} suffix`), true, key);
  for (const safe of ['task-profile', 'sha256:' + 'f'.repeat(64), 'ev-2f1c9a7e-0b3d-4c55-9e1f-2a6b7c8d9e0f', 'Risk review']) {
    assert.equal(c.containsSecret(safe), false, safe);
  }
});
