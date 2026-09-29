import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CERTIFIED_ANALYZERS, profileWorkspace, proposeChecks } from '../dist/index.js';

function polyglot() {
  const root = mkdtempSync(join(tmpdir(), 'jevris-profile-'));
  const put = (rel, text) => {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  put('package.json', JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  put('pnpm-lock.yaml', '');
  put('services/api/pyproject.toml', '[tool.pytest.ini_options]\n');
  put('services/api/uv.lock', '');
  put('crates/core/Cargo.toml', '[package]\n');
  put('cmd/tool/go.mod', 'module x\n');
  put('java/pom.xml', '<project/>');
  put('java/mvnw', '#!/bin/sh\n');
  put('android/build.gradle.kts', '');
  put('native/CMakeLists.txt', '');
  put('dotnet/App.csproj', '<Project/>');
  put('firmware/platformio.ini', '[env:native]\n');
  put('node_modules/dep/package.json', '{}');
  put('empty/package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('profiling discovers every supported manifest deterministically and skips vendor trees (VER-07)', () => {
  const f = polyglot();
  try {
    const a = profileWorkspace(f.root);
    const b = profileWorkspace(f.root);
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.stacks.map((s) => `${s.dir}:${s.stack}`),
      [
        '.:pnpm',
        'android:gradle',
        'cmd/tool:go',
        'crates/core:cargo',
        'dotnet:dotnet',
        'empty:npm',
        'firmware:platformio',
        'java:maven',
        'native:cmake',
        'services/api:python',
      ],
    );
    assert.equal(a.stacks.some((s) => s.manifest.startsWith('node_modules')), false);
    assert.equal(a.toolchains.every((t) => t.version === null), true);
  } finally {
    f.done();
  }
});

test('toolchain versions come from the injected probe, never from a shell (VER-07)', () => {
  const f = polyglot();
  try {
    const calls = [];
    const profile = profileWorkspace(f.root, { platform: 'linux', probe: (program, args) => (calls.push([program, ...args]), `${program} 1.0`) });
    assert.ok(calls.some(([p]) => p === 'cargo'));
    assert.ok(calls.some(([p, arg]) => p === 'go' && arg === 'version'));
    assert.equal(profile.toolchains.find((t) => t.program === 'cargo').version, 'cargo 1.0');
    assert.ok(profile.toolchains.some((t) => t.program === 'node'));
  } finally {
    f.done();
  }
});

test('the certified analyzers propose checks and hardware-runner declarations (VER-07)', () => {
  const f = polyglot();
  try {
    const proposal = proposeChecks(profileWorkspace(f.root), f.root, 'linux');
    assert.equal(proposal.schemaVersion, 'jevris-checks-1');
    const ids = proposal.checks.map((c) => c.id);
    assert.ok(ids.includes('test') && ids.includes('lint'));
    assert.ok(!ids.includes('empty-test'), 'the npm placeholder test script is not a check');
    assert.ok(ids.includes('services-api-pytest'));
    assert.deepEqual(proposal.checks.find((c) => c.id === 'services-api-pytest').argv, ['uv', 'run', 'pytest', '-q']);
    assert.deepEqual(proposal.checks.find((c) => c.id === 'services-api-pytest').inputScopes, ['services/api']);
    assert.equal(proposal.checks.find((c) => c.id === 'java-mvn-test').argv[0], join(f.root, 'java', 'mvnw'));
    assert.ok(ids.includes('crates-core-cargo-test') && ids.includes('cmd-tool-go-test') && ids.includes('dotnet-dotnet-test'));
    assert.deepEqual(proposal.hardwareRunners, [
      {
        hardware: 'platformio-device',
        checkIds: ['firmware-pio-test-device'],
        availability: 'declared-unattached',
        description: proposal.hardwareRunners[0].description,
      },
    ]);
    const win = proposeChecks(profileWorkspace(f.root), f.root, 'win32');
    assert.equal(win.checks.find((c) => c.id === 'java-mvn-test').argv[0].endsWith('mvnw.cmd'), true);
    assert.equal(new Set(CERTIFIED_ANALYZERS.map((a) => a.stack)).size, CERTIFIED_ANALYZERS.length);
  } finally {
    f.done();
  }
});

test('an unknown toolchain: metadata is detected and reported, but build and test semantics are unverified (VER-02, W12)', () => {
  const root = mkdtempSync(join(tmpdir(), 'jevris-profile-unknown-'));
  try {
    writeFileSync(join(root, 'main.c'), 'int main(void) { return 0; }\n');
    writeFileSync(join(root, 'board.h'), '#define LED 1\n');
    writeFileSync(join(root, 'firmware.uvprojx'), '<Project/>');
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'x', 'skip.c'), '');
    const profile = profileWorkspace(root);
    assert.deepEqual(profile.stacks, []);
    assert.deepEqual(profile.metadata, [
      { kind: 'project', id: 'keil-uvision', evidence: 'firmware.uvprojx', count: 1 },
      { kind: 'language', id: 'c', evidence: 'board.h', count: 2 },
    ]);
    const proposal = proposeChecks(profile, root);
    assert.deepEqual(proposal.checks, []);
    assert.equal(proposal.semantics, 'unverified');
    assert.deepEqual(proposal.unverified.map((m) => m.id), ['keil-uvision', 'c']);
    assert.deepEqual(proposal.detected, profile.metadata);
    // A covered stack with an extra project system is partial; an empty directory detects nothing.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'index.js'), '');
    const mixed = proposeChecks(profileWorkspace(root), root);
    assert.equal(mixed.semantics, 'partial');
    assert.ok(!mixed.unverified.some((m) => m.id === 'javascript'), 'javascript is covered by the npm analyzer');
    const empty = mkdtempSync(join(tmpdir(), 'jevris-profile-empty-'));
    try {
      assert.equal(proposeChecks(profileWorkspace(empty), empty).semantics, 'nothing-detected');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
