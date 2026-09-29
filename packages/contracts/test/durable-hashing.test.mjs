import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as F from './fixtures.mjs';

const c = await import('../dist/index.js');

const codes = (result) => (result.ok ? [] : result.issues.map((issue) => issue.code));

test('canonicalJson follows RFC 8785 for key order, whitespace, numbers and strings (CTR-03)', () => {
  assert.equal(c.canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  // RFC 8785 appendix B number samples.
  const numbers = [
    [0, '0'],
    [-0, '0'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [123456789012345680000, '123456789012345680000'],
    [4.5, '4.5'],
    [0.000001, '0.000001'],
    [-1.7976931348623157e308, '-1.7976931348623157e+308'],
    [9007199254740992, '9007199254740992'],
  ];
  for (const [value, expected] of numbers) assert.equal(c.canonicalJson(value), expected, String(value));
  // Keys sort by UTF-16 code units (RFC 8785 §3.2.3), not by locale.
  assert.equal(c.canonicalJson({ '\u20ac': 1, '\r': 2, '\ud83d\ude00': 3, '\u0080': 4, '1': 5, a: 6, B: 7 }),
    '{"\\r":2,"1":5,"B":7,"a":6,"\u0080":4,"\u20ac":1,"\ud83d\ude00":3}');
  assert.equal(c.canonicalJson('\u0000\u001f"\\\u2028'), '"\\u0000\\u001f\\"\\\\\u2028"');
  assert.throws(() => c.canonicalJson({ a: undefined }), /JSON_UNDEFINED/);
  assert.throws(() => c.canonicalJson(Number.POSITIVE_INFINITY), /JSON_NUMBER/);
  assert.throws(() => c.canonicalJson(new Map()), /JSON_TYPE/);
});

test('contentHash is sha256 over the canonical form and independent of key order (CTR-03)', () => {
  const a = { workspaceId: 'ws-1', list: [1, 2], nested: { y: 'b', x: 'a' } };
  const b = { nested: { x: 'a', y: 'b' }, list: [1, 2], workspaceId: 'ws-1' };
  const expected = `sha256:${createHash('sha256').update(c.canonicalJson(a)).digest('hex')}`;
  assert.equal(c.contentHash(a), expected);
  assert.equal(c.contentHash(b), expected);
  assert.notEqual(c.contentHash({ ...a, list: [2, 1] }), expected, 'array order is meaningful');
  assert.notEqual(c.contentHash({ v: null }), c.contentHash({}), 'null and absent hash differently');
  assert.equal(c.isContentHash(expected), true);
  assert.equal(c.isContentHash('sha256:abc'), false);
});

test('sealDurable wraps a validated body with version, id, workspace, revision and hash (CTR-03)', () => {
  const task = F.taskNode();
  const sealed = c.sealDurable(c.TaskNodeContract, { id: 'task-1', workspaceId: 'ws-1', revision: 'rev-1' }, task);
  assert.deepEqual(Object.keys(sealed).sort(), ['body', 'contentHash', 'contract', 'id', 'revision', 'schemaVersion', 'workspaceId']);
  assert.equal(sealed.schemaVersion, '1.0');
  assert.equal(sealed.contract, 'TaskNode');
  assert.equal(sealed.contentHash, c.contentHash(task));
  assert.equal(Object.isFrozen(sealed.body), true);

  const opened = c.openCataloguedDurable(JSON.parse(JSON.stringify(sealed)));
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.value.body, task);

  const capsule = c.sealDurable(c.MemoryCapsuleContract, { id: 'capsule-1', workspaceId: 'ws-1', revision: 'rev-7' }, F.memoryCapsule());
  assert.equal(c.openCataloguedDurable(capsule).ok, true);
  const reservation = c.sealDurable(c.BudgetReservationContract, { id: 'res-1', workspaceId: 'ws-1', revision: 'rev-1' }, F.budgetReservation());
  assert.equal(c.openCataloguedDurable(reservation).ok, true, 'objects without their own workspaceId get scope from the envelope');
});

test('sealDurable refuses an invalid body or an identity mismatch', () => {
  assert.throws(() => c.sealDurable(c.TaskNodeContract, { id: 'task-1', workspaceId: 'ws-1', revision: 'rev-1' }, { ...F.taskNode(), state: 'done' }), c.ContractError);
  assert.throws(
    () => c.sealDurable(c.TaskNodeContract, { id: 'task-2', workspaceId: 'ws-1', revision: 'rev-1' }, F.taskNode()),
    /IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => c.sealDurable(c.TaskNodeContract, { id: 'task-1', workspaceId: 'ws-9', revision: 'rev-1' }, F.taskNode()),
    /IDENTITY_MISMATCH/,
  );
  assert.throws(() => c.sealDurable(c.TaskNodeContract, { id: 'bad id', workspaceId: 'ws-1', revision: 'rev-1' }, F.taskNode()), c.ContractError);
});

test('openDurable detects tampering, a wrong hash, an unknown contract and a non-durable contract', () => {
  const sealed = JSON.parse(JSON.stringify(c.sealDurable(c.TaskNodeContract, { id: 'task-1', workspaceId: 'ws-1', revision: 'rev-1' }, F.taskNode())));
  const tampered = structuredClone(sealed);
  tampered.body.state = 'verified';
  assert.deepEqual(codes(c.openCataloguedDurable(tampered)), ['HASH_MISMATCH']);
  assert.deepEqual(codes(c.openCataloguedDurable({ ...sealed, contentHash: F.H1 })), ['HASH_MISMATCH']);
  assert.deepEqual(codes(c.openCataloguedDurable({ ...sealed, contract: 'Nope' })), ['UNKNOWN_CONTRACT']);
  assert.deepEqual(codes(c.openCataloguedDurable({ ...sealed, contract: 'Mode' })), ['UNKNOWN_CONTRACT']);
  assert.deepEqual(codes(c.openCataloguedDurable({ ...sealed, revision: 'rev-2' })), ['IDENTITY_MISMATCH']);
  const invalidBody = structuredClone(sealed);
  invalidBody.body.state = 'done';
  assert.deepEqual(c.openCataloguedDurable(invalidBody).issues, [{ path: '/body/state', code: 'enum' }]);
  const missingVersion = { ...sealed };
  delete missingVersion.schemaVersion;
  assert.deepEqual(codes(c.openCataloguedDurable(missingVersion)), ['required']);
  assert.equal(c.openCataloguedDurable({ ...sealed, schemaVersion: '2.0' }).ok, false);
});

test('every durable contract name is catalogued', () => {
  for (const name of c.DURABLE_CONTRACT_NAMES) assert.ok(c.CONTRACTS.get(name), name);
});
