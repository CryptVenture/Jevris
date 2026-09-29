import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source checks for the hook (QA-07). They read apps/hook/src text, so they run in
 * `npm run lint`, not in the behavioural suite.
 */

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles() {
  const out = [];
  for (const name of readdirSync(srcDir)) {
    const full = join(srcDir, name);
    if (statSync(full).isFile()) out.push({ name, full, text: readFileSync(full, 'utf8') });
  }
  return out;
}

function stripLineComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const mark = line.indexOf('//');
      return mark === -1 ? line : line.slice(0, mark);
    })
    .join('\n');
}

function importSpecifiers(text) {
  const found = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) found.push(match[1]);
    match = pattern.exec(text);
  }
  return found;
}

test('hook source does not import the store, sqlite, the SDK, the provider, or child_process', () => {
  const forbidden = [
    '@jevris/store',
    'node:sqlite',
    'better-sqlite3',
    '@typesafe-ai/sdk',
    '@jevris/provider-typesafe',
    'node:child_process',
    'child_process',
  ];
  for (const { name, text: raw } of sourceFiles()) {
    const text = stripLineComments(raw);
    for (const specifier of importSpecifiers(text)) {
      for (const banned of forbidden) {
        assert.equal(specifier === banned || specifier.startsWith(`${banned}/`), false, `${name} imports ${specifier}`);
      }
    }
    assert.equal(text.includes('TYPESAFE_API_KEY'), false, `${name} reads the provider key env name`);
  }
});

test('hook source does not import the store, a scheduler or the keyring, and prints only through the adapter', () => {
  for (const { name, text } of sourceFiles()) {
    assert.equal(name.toLowerCase().includes('schedul'), false, name);
    assert.equal(text.includes('@jevris/store'), false, name);
    assert.equal(text.includes('recordDecision'), false, name);
    assert.equal(text.includes('@napi-rs/keyring'), false, name);
    assert.equal(text.includes('permissionDecision'), false, `${name} writes a permission decision`);
  }
});

test('the launcher never waits for the sidecar to start', () => {
  const launcher = sourceFiles().find((file) => file.name === 'launcher.ts');
  assert.ok(launcher);
  assert.equal(launcher.text.includes('waitMs: 0'), true);
  assert.equal(/waitMs:\s*[1-9]/.test(launcher.text), false);
});
