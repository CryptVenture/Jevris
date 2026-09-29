// Source-text checks moved out of apps/cli/test/doctor.test.mjs (QA-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('doctor source does not import the runtime or a process module', () => {
  const src = readFileSync(new URL('../src/doctor.ts', import.meta.url), 'utf8');
  for (const banned of ['runtime.js', 'node:child_process', 'node:process', 'fetch(', 'node:http', 'node:net', '127.0.0.1']) {
    assert.equal(src.includes(banned), false, banned);
  }
  assert.equal(src.includes('decideEgress'), true);
  assert.equal(src.includes('readInstalledHarnessVersion'), true);
  assert.equal(src.includes('classifyEnvironment'), true);
  assert.equal(src.includes('process.'), false);
});

test('platform and doctor sources do not open a network client', () => {
  for (const name of ['platform.ts', 'doctor.ts']) {
    const src = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const banned of ['fetch(', 'node:http', 'node:net', '127.0.0.1', 'node:child_process']) {
      assert.equal(src.includes(banned), false, `${name} ${banned}`);
    }
  }
});

test('platform.ts source does not contain certified', () => {
  const src = readFileSync(new URL('../src/platform.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('certified'), false);
});

test('the doctor command (the admin one; G18 removed the legacy branch in cli.ts) forwards the platform, node version and an empty certification set', () => {
  const src = readFileSync(new URL('../src/doctor-cli.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('process.platform'), true);
  assert.equal(src.includes('process.version'), true);
  assert.equal(src.includes('harnessProbeForCli('), true);
  assert.equal(src.includes('runDoctor('), true);
  assert.equal(src.includes('certificationRecords: []'), true);
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  for (const legacy of ['runDoctor(', 'installPlugin(', 'installGlobal(', 'uninstallGlobal(', 'deleteJevrisData(']) assert.equal(cli.includes(legacy), false, legacy);
});

test('the CLI refuses a certified actuator by its status field, not by a text match', () => {
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.equal(src.includes("status === 'certified'"), true);
  assert.equal(src.includes("includes('certified')"), false);
});
