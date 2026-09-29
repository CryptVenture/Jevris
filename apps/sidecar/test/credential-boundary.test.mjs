import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GOV-06: only the sidecar reads the Jev credential. The hook and MCP bundles carry no keyring
// or credential reader, and no key variable survives into the sidecar or anything it starts.

const { runSidecarMain, sidecarChildEnv, sidecarRequest } = await import('../dist/index.js');
const { scrubCredentialEnv } = await import('../dist/protocol.js');

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KEY_NAMES = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'JEVRIS_API_KEY', 'JEVRIS_INSTALLER_KEY', 'JEVRIS_HOOK_TOKEN'];
/** Built at run time so no key-shaped literal sits in the repository (QA-01). */
const canary = () => ['gov06', 'canary', process.pid, Date.now()].join('-');

test('the hook and MCP bundles never import the keyring or name the credential reader (GOV-06)', () => {
  const bundles = [join(repo, 'dist', 'hook.mjs'), join(repo, 'plugins', 'shared', 'mcp.js')];
  for (const bundle of bundles) {
    assert.equal(existsSync(bundle), true, `${bundle} is not built; run npm run build`);
    const text = readFileSync(bundle, 'utf8');
    for (const name of ['@napi-rs/keyring', 'resolveProviderCredential', 'openHostEntry', 'better-sqlite3']) {
      assert.equal(text.includes(name), false, `${bundle} contains ${name}`);
    }
    // Only node: built-ins are imported, statically or lazily.
    const specifiers = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"'\s,]+)["']/g)].map((match) => match[1]);
    assert.deepEqual(specifiers.filter((spec) => !spec.startsWith('node:')), [], `${bundle} imports a non-built-in module`);
  }
});

test('every key variable is dropped from the detached sidecar environment and nothing else is (GOV-06)', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/u', JEVRIS_HOME: '/home/u/.jevris', JEVRIS_TEST_PROVIDER_URL: 'http://127.0.0.1:1' };
  for (const name of KEY_NAMES) env[name] = canary();
  env.typesafe_api_key = canary();
  const child = sidecarChildEnv(env);
  assert.deepEqual(Object.keys(child).sort(), ['HOME', 'JEVRIS_HOME', 'JEVRIS_TEST_PROVIDER_URL', 'PATH']);
  // The caller's environment is not changed by building the child's.
  assert.equal(env.TYPESAFE_API_KEY !== undefined, true);
  const scrubbed = { ...env };
  assert.deepEqual([...scrubCredentialEnv(scrubbed)].sort(), [...KEY_NAMES, 'typesafe_api_key'].sort());
  assert.deepEqual(Object.keys(scrubbed).sort(), ['HOME', 'JEVRIS_HOME', 'JEVRIS_TEST_PROVIDER_URL', 'PATH']);
});

test('jevris sidecar run drops key variables from its own environment before it serves, so no child inherits one (GOV-06)', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvc-')));
  const env = { ...process.env, JEVRIS_HOME: undefined };
  delete env.JEVRIS_HOME;
  for (const name of KEY_NAMES) env[name] = canary();
  const seen = [];
  const ops = [
    {
      op: 'test.env',
      scope: 'status',
      budget: 'hot',
      workspace: 'optional',
      handle: () => ({ ok: true, body: { names: KEY_NAMES.filter((name) => env[name] !== undefined) } }),
    },
  ];
  let exited = false;
  const running = runSidecarMain({ home, env, idleMs: 0, packageOps: false, store: false, ops, write: (text) => seen.push(text) }).finally(() => {
    exited = true;
  });
  try {
    // Wait on the sidecar's own answer: the first ping that succeeds, or its exit.
    let answer = await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} });
    while (!answer.ok && !exited) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      answer = await sidecarRequest({ home, op: 'ping', scope: 'cli', body: {} });
    }
    assert.equal(answer.ok, true, `${JSON.stringify(answer)} ${seen.join('')}`);
    const names = await sidecarRequest({ home, op: 'test.env', scope: 'cli', body: {} });
    assert.equal(names.ok, true, JSON.stringify(names));
    assert.deepEqual(names.result.names, [], 'a key variable survived into the running sidecar');
  } finally {
    await sidecarRequest({ home, op: 'shutdown', scope: 'cli', body: {} });
    await running;
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(seen.join('').includes('gov06-canary'), false);
});
