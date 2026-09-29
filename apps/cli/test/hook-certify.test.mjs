import test from 'node:test';
import { assertClaudeHooks } from './product-hooks.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';


const { probeHookProcess } = await import('../dist/hook-certify.js');
const { probeInstalledHarness } = await import('../dist/harness-probe.js');

const PRODUCT_HOOKS = new URL('../../../plugins/claude/hooks/hooks.json', import.meta.url);
const PRODUCT_PLUGIN = new URL('../../../plugins/claude/.claude-plugin/plugin.json', import.meta.url);

async function productManifestAbsent() {
  await assert.rejects(access(PRODUCT_HOOKS));
  await assert.rejects(access(PRODUCT_PLUGIN));
}

test('a missing binary is fail-closed and writes no product manifest', async () => {
  const missing = '/tmp/jevris-missing-claude-does-not-exist';
  const hooksPath = fileURLToPath(PRODUCT_HOOKS);
  const before = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : null;
  const result = await probeHookProcess({
    binaryPath: missing,
    result: { eventProbe: 'passed', doctorExit: 0 },
  });
  assert.equal(result.eventProbe, 'did-not-pass');
  assert.equal(result.shell, false);
  assert.equal(Array.isArray(result.args), true);
  assert.equal(result.spawned, false);
  const skipped = await probeHookProcess({ skipped: true, binaryPath: missing });
  assert.equal(skipped.eventProbe, 'did-not-pass');
  assert.equal(skipped.spawned, false);
  const after = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : null;
  assert.equal(after, before);
  if (after === null) await productManifestAbsent();
  else await assertCertifiedProduct();

  const installed = await probeInstalledHarness({
    harnessRunner: async () => ({ stdout: '2.1.281\n', code: 0, spawned: true }),
  });
  assert.equal(installed.eventProbe, 'did-not-pass');
  assert.equal(installed.actuators, 'unsupported');
  const afterDoctor = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : null;
  assert.equal(afterDoctor, after);
});

const INSTALLED_BINARY = 'claude';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
// npm test never starts a real harness (live-harness.ts): the runner's stub stands in for
// `claude`, exits 1 and prints nothing, so the probe spawns but does not pass.
const STUB_BINARY =
  typeof process.env.JEVRIS_HARNESS_STUB_DIR === 'string' && process.platform !== 'win32'
    ? join(process.env.JEVRIS_HARNESS_STUB_DIR, 'claude')
    : '/tmp/jevris-missing-claude-does-not-exist';

function noHooksFile(path) {
  return path === null || path === undefined || existsSync(path) === false || existsSync(`${path}/hooks.json`) === false;
}

function productBytes() {
  const hooksPath = fileURLToPath(PRODUCT_HOOKS);
  const pluginPath = fileURLToPath(PRODUCT_PLUGIN);
  return {
    hooks: existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : null,
    plugin: existsSync(pluginPath) ? readFileSync(pluginPath, 'utf8') : null,
  };
}

test('a PATH lookup of claude is refused under npm test and spawns nothing', async () => {
  const before = productBytes();
  const refused = await probeHookProcess();
  assert.equal(refused.shell, false);
  assert.equal(refused.binary, INSTALLED_BINARY);
  assert.equal(refused.spawned, false);
  assert.equal(refused.eventProbe, 'did-not-pass');
  assert.deepEqual(productBytes(), before);
});

test('live probe spawns the injected binary with shell false outside the repo', async () => {
  const before = productBytes();
  const result = await probeHookProcess({ binaryPath: STUB_BINARY });
  assert.equal(result.shell, false);
  assert.equal(result.binary, STUB_BINARY);
  assert.equal(Array.isArray(result.args), true);
  for (const token of ['doctor', 'plugin', 'hooks', '--bare', '--add-dir', 'validate']) {
    assert.equal(result.args.includes(token), false, token);
  }
  if (result.spawned) {
    assert.equal(typeof result.cwd, 'string');
    assert.equal(result.cwd.length > 0, true);
    assert.equal(result.cwd.includes(repoRoot), false);
    assert.equal(result.cwd === repoRoot, false);
  }
  assert.equal(noHooksFile(result.cwd), true);
  assert.equal(result.eventProbe, 'did-not-pass');
  assert.deepEqual(productBytes(), before);

  const { classifyEnvironment } = await import('../dist/platform.js');
  assert.equal(classifyEnvironment({ platform: 'win32', nodeVersion: process.version, env: {} }), 'local');
  assert.equal(classifyEnvironment({ platform: 'darwin', nodeVersion: 'v26.5.0', env: {} }), 'local');
  const remote = await probeHookProcess({
    binaryPath: STUB_BINARY,
    platform: 'darwin',
    nodeVersion: 'v24.18.1',
    env: { SSH_CONNECTION: '1 2 3 4', CLAUDE_CODE_REMOTE: 'true' },
    inContainer: true,
  });
  assert.equal(remote.eventProbe, 'did-not-pass');
  assert.equal(remote.spawned, false);
  assert.deepEqual(productBytes(), before);
});

function treeHasHooksJson(path) {
  if (path === null || path === undefined || existsSync(path) === false) return false;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (name === 'hooks.json') return true;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(full);
    }
  }
  return false;
}

async function assertCertifiedProduct() {
  const { scanHooks } = await import('../dist/hook-scan.js');
  const root = fileURLToPath(new URL('../../../plugins/claude', import.meta.url));
  const scanned = await scanHooks(root);
  assert.equal(scanned.accepted, true);
  assertClaudeHooks(readFileSync(PRODUCT_HOOKS, 'utf8'));
  const plugin = JSON.parse(readFileSync(PRODUCT_PLUGIN, 'utf8'));
  assert.equal(plugin.name, 'jevris');
  assert.equal(plugin.defaultEnabled, false);
  assert.equal(String(plugin.description).toLowerCase().includes('installed'), true);
  assert.equal(String(plugin.description).toLowerCase().includes('not enforced'), true);
}

test('the product manifest stays absent unless the live probe passed', async () => {
  const certify = await import('../dist/hook-certify.js');
  assert.equal(Object.hasOwn(certify, 'writeCertifiedManifest'), false);
  assert.equal(typeof certify.writeCertifiedManifest, 'undefined');

  const before = productBytes();
  const live = await probeHookProcess({
    binaryPath: STUB_BINARY,
    result: { eventProbe: 'passed', doctorExit: 0, version: '2.1.281' },
  });
  assert.equal(live.shell, false);
  assert.equal(live.binary, STUB_BINARY);
  if (live.spawned) {
    assert.equal(live.args.includes('--plugin-dir'), true);
    assert.equal(live.args.includes('--print'), true);
    assert.equal(live.args.includes('--output-format'), true);
    assert.equal(live.args.includes('stream-json'), true);
    assert.equal(live.args.includes('--include-hook-events'), true);
    assert.equal(live.args.includes('ping'), true);
  }
  assert.equal(live.args.includes('--bare'), false);
  assert.equal(live.args.includes('doctor'), false);
  assert.equal(live.args.includes('plugin'), false);
  assert.equal(live.args.includes('hooks'), false);
  assert.equal(treeHasHooksJson(live.cwd), false);
  // A fabricated `result` never passes the probe, and a failed probe leaves the product manifest as it was.
  assert.equal(live.eventProbe, 'did-not-pass');
  assert.deepEqual(productBytes(), before);
  const hooksPath = fileURLToPath(PRODUCT_HOOKS);

  const beforeSkipped = existsSync(hooksPath);
  const fabricated = await probeHookProcess({
    skipped: true,
    result: { eventProbe: 'passed', doctorExit: 0, version: '2.1.281' },
  });
  assert.equal(fabricated.eventProbe, 'did-not-pass');
  assert.equal(fabricated.spawned, false);
  assert.equal(existsSync(hooksPath), beforeSkipped);
});
