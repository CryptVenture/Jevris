import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { managedHostSkip } from '../../../test/managed-host.mjs';

const { main } = await import('../dist/cli.js');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');

function capture() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

test('jevris sidecar status|start|stop|restart work through the CLI and report a degraded state when down (IPC-16, IPC-18)', { skip: managedHostSkip() }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvc-')));
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  try {
    let out = capture();
    assert.equal(await main(['sidecar', 'status', '--home', home], out.write), 1);
    assert.match(out.text(), /not running \(degraded: rules-only\)/);
    assert.match(out.text(), /jevris sidecar start/);

    out = capture();
    assert.equal(await main(['sidecar', 'status', '--home', home, '--json'], out.write), 1);
    assert.equal(JSON.parse(out.text()).degraded, true);

    out = capture();
    assert.equal(await main(['sidecar', 'start', '--home', home], out.write), 0, out.text());
    assert.match(out.text(), /running \(started\)/);

    out = capture();
    assert.equal(await main(['sidecar', 'status', '--home', home], out.write), 0);
    for (const field of ['pid:', 'version:', 'uptime:', 'endpoint:', 'store:', 'kill switch: clear']) assert.ok(out.text().includes(field), field);

    out = capture();
    assert.equal(await main(['sidecar', 'restart', '--home', home], out.write), 0, out.text());
    assert.match(out.text(), /running \(started\)/);

    out = capture();
    assert.equal(await main(['sidecar', 'stop', '--home', home], out.write), 0);
    assert.match(out.text(), /stopped \(pid \d+\)/);

    out = capture();
    assert.equal(await main(['sidecar', 'stop', '--home', home], out.write), 0);
    assert.match(out.text(), /not running/);

    out = capture();
    assert.equal(await main(['sidecar', 'bogus', '--home', home], out.write), 2);
    assert.match(out.text(), /usage: jevris sidecar/);
  } finally {
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    await main(['sidecar', 'stop', '--home', home], () => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

// The bin entry awaits main() at the top level and exits with its code. A CLI process
// has nothing else on its event loop, so every wait in start and stop must hold it open.
const CLI_MAIN = join(here, '..', 'dist', 'cli.js');
const ENTRY = `const { main } = await import(${JSON.stringify(pathToFileURL(CLI_MAIN).href)}); process.exit(await main(process.argv.slice(1)));`;

function runCli(args, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', ENTRY, ...args], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('jevris sidecar start, status and stop answer from a real CLI process (IPC-13, IPC-16)', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jvp-')));
  const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TMPDIR: tmpdir(), JEVRIS_SIDECAR_ENTRY: SIDECAR_MAIN };
  try {
    let run = runCli(['sidecar', 'start', '--home', home], env);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /running \(started\)/);
    assert.doesNotMatch(run.stderr, /unsettled top-level await/);

    run = runCli(['sidecar', 'status', '--home', home], env);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /sidecar: running/);

    run = runCli(['sidecar', 'stop', '--home', home], env);
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /stopped \(pid \d+\)/);
    assert.doesNotMatch(run.stderr, /unsettled top-level await/);

    run = runCli(['sidecar', 'status', '--home', home], env);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /not running/);
  } finally {
    runCli(['sidecar', 'stop', '--home', home], env);
    rmSync(home, { recursive: true, force: true });
  }
});
