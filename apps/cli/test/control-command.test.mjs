// ORC-12 surfaces against a real sidecar and a real control service run by `jevris control
// serve`: status names single host, unusable settings, a refused token and a reachable service;
// migrate needs a person and moves the workspace once; serve refuses plain HTTP off loopback and
// stops on SIGTERM. The token lives only in an owner-only file, never in argv or output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { tokenDigest } = await import('@jevris/orchestrator');
const { jevrisPaths, writePrivateFile } = await import('@jevris/platform');

/** Starts `jevris control serve` and resolves with its URL from the first JSON line. */
function serve(box, args) {
  const child = spawn(process.execPath, [box.product.bin, 'control', 'serve', ...args, '--json'], { env: box.env, cwd: box.work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n')[0];
      if (stdout.includes('\n')) {
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    exited.then(({ code }) => reject(new Error(`serve exited ${code}: ${stdout} ${stderr}`)));
  });
  return { child, ready, exited, output: () => stdout + stderr };
}

test('control status, migrate and serve: single host, a refused token, a reachable service, one migration by a person (ORC-12)', { skip: managedHostSkip() }, async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  // Status never starts anything: without a sidecar it says so, and the sidecar stays down.
  const down = box.jevris(['control', 'status'], { json: true });
  assert.equal(down.code, 1, down.stdout + down.stderr);
  assert.match(down.json.reasonCode, /^(NOT_RUNNING|SIDECAR_[A-Z_]+)$/);
  assert.match(box.jevris(['control', 'status']).stdout, /sidecar is not running/);
  assert.match(box.jevris(['sidecar', 'status']).stdout, /not running|stopped/i, 'control status started the sidecar');
  assert.equal(box.startSidecar().code, 0, 'the sidecar did not start');
  const config = jevrisPaths({ home: box.home }).config;
  mkdirSync(config, { recursive: true });
  const settings = join(config, 'control.json');

  const single = box.jevris(['control', 'status'], { json: true });
  assert.equal(single.code, 0, single.stdout + single.stderr);
  assert.deepEqual([single.json.command, single.json.reasonCode, single.json.configured, single.json.migrated], ['control status', 'SINGLE_HOST', false, false]);

  writeFileSync(settings, 'not json');
  const unusable = box.jevris(['control', 'status'], { json: true });
  assert.deepEqual([unusable.code, unusable.json.reasonCode], [1, 'CONTROL_SETTINGS_UNUSABLE']);
  assert.match(unusable.json.problem, /not JSON/);

  // Plain HTTP only on loopback; the service refuses any other address without TLS.
  const token = randomBytes(24).toString('hex');
  const tenants = box.write('control/tenants.json', { tenants: [{ id: 'team-a', tokenSha256: tokenDigest(token) }] });
  const offLoopback = box.jevris(['control', 'serve', '--root', join(box.dir, 'control', 'data'), '--tenants', tenants, '--host', '0.0.0.0', '--port', '0'], { json: true });
  assert.equal(offLoopback.code, 2);
  assert.deepEqual([offLoopback.json.reasonCode], ['SERVE_REFUSED']);
  assert.match(offLoopback.json.message, /TLS/);

  const service = serve(box, ['--root', join(box.dir, 'control', 'data'), '--tenants', tenants, '--host', '127.0.0.1', '--port', '0']);
  t.after(() => service.child.kill('SIGKILL'));
  const started = await service.ready;
  assert.deepEqual([started.command, started.serving], ['control serve', true]);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const tokenFile = join(box.dir, 'control', 'host.token');
  await writePrivateFile(tokenFile, `${randomBytes(24).toString('hex')}\n`);
  writeFileSync(settings, `${JSON.stringify({ schemaVersion: 'jevris-control-client-1', url: started.url, tokenFile })}\n`);
  const refused = box.jevris(['control', 'status'], { json: true });
  assert.deepEqual([refused.code, refused.json.reasonCode, refused.json.reachable], [1, 'CONTROL_UNAUTHORIZED', false]);

  rmSync(tokenFile);
  await writePrivateFile(tokenFile, `${token}\n`);
  const reachable = box.jevris(['control', 'status'], { json: true });
  assert.equal(reachable.code, 0, reachable.stdout + reachable.stderr);
  assert.deepEqual([reachable.json.reasonCode, reachable.json.url, reachable.json.reachable, reachable.json.activeLeases, reachable.json.migrated], ['CONTROL_SERVICE', started.url, true, 0, false]);
  const human = box.jevris(['control', 'status']);
  assert.match(human.stdout, /leases through the control service/);
  assert.doesNotMatch(human.stdout + reachable.stdout, new RegExp(token), 'the token is never shown');

  const unconfirmed = box.jevris(['control', 'migrate']);
  assert.equal(unconfirmed.code, 2);
  assert.match(unconfirmed.stdout, /Nothing was changed.*for good.*grants no local lease/s);
  assert.equal(box.jevris(['control', 'status'], { json: true }).json.migrated, false, 'migrated without confirmation');
  const migrated = box.jevris(['control', 'migrate', '--yes'], { json: true });
  assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
  assert.deepEqual([migrated.json.command, migrated.json.migrated, migrated.json.reasonCode], ['control migrate', true, 'MIGRATED']);
  assert.deepEqual(Object.keys(migrated.json.imported).sort(), ['budgets', 'fences', 'leases', 'reservations']);
  const again = box.jevris(['control', 'migrate', '--yes'], { json: true });
  assert.deepEqual([again.code, again.json.migrated, again.json.reasonCode], [1, false, 'ALREADY_MIGRATED']);
  assert.equal(box.jevris(['control', 'status'], { json: true }).json.migrated, true);

  // Migrated, then the settings are gone: this host grants no local lease and says so.
  rmSync(settings);
  const required = box.jevris(['control', 'status'], { json: true });
  assert.deepEqual([required.code, required.json.reasonCode, required.json.migrated], [1, 'CONTROL_SERVICE_REQUIRED', true]);

  // No model tool reaches the control service.
  const client = await box.mcp();
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).filter((name) => /control|migrat/.test(name)), []);

  service.child.kill('SIGTERM');
  const ended = await service.exited;
  if (process.platform !== 'win32') assert.equal(ended.code, 0, service.output());
});

test('control refuses bad arguments before any request or start', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  for (const argv of [
    ['control'],
    ['control', 'nope'],
    ['control', 'status', 'extra'],
    ['control', 'status', '--root', 'x'],
    ['control', 'status', '--yes'],
    ['control', 'serve'],
    ['control', 'serve', '--root', 'x'],
    ['control', 'serve', '--root', 'x', '--tenants', 'missing.json'],
    ['control', 'serve', '--root', 'x', '--tenants', 't.json', '--port', '70000'],
    ['control', 'serve', '--root', 'x', '--tenants', 't.json', '--tls-key', 'k.pem'],
  ]) {
    const out = box.jevris(argv);
    assert.equal(out.code, 2, `${argv.join(' ')}: ${out.stdout}`);
  }
});
