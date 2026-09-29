// GOV-11: `jevris shadow --out <file>` writes only inside an approved root (the working
// directory, the home, the temp directory), never into Jevris's private directories and never
// through a link. A refused path prints the reason code, exits 2 and writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { main } = await import('../dist/cli.js');
const { jevrisPaths } = await import('@jevris/platform');

const FIXTURE = {
  policyVersion: 'policyV1',
  actualModel: 'claude-sonnet-5',
  rulesInput: { kind: 'known-failure', family: 'type_error' },
  jevLabel: 'jev-1.13.0',
  setting: { provenance: 'administrator', sourceEgress: 'approved-scoped' },
  untrustedClaims: [],
};

async function run(args) {
  let text = '';
  const code = await main(args, (chunk) => {
    text += chunk;
  });
  return { code, text };
}

function setup(t) {
  const parent = mkdtempSync(join(tmpdir(), 'jevris-shadow-out-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, 'home');
  mkdirSync(home);
  const fixture = join(parent, 'fixture.json');
  writeFileSync(fixture, JSON.stringify(FIXTURE));
  return { parent, home, fixture };
}

test('shadow --out in the temp directory is written', async (t) => {
  const { parent, home, fixture } = setup(t);
  const out = join(parent, 'reports', 'comparison.json');
  mkdirSync(join(parent, 'reports'));
  const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture, '--out', out]);
  assert.equal(code, 0, text);
  assert.equal(existsSync(out), true);
});

test('shadow --out inside a Jevris private directory is refused and nothing is written', async (t) => {
  const { home, fixture } = setup(t);
  const data = jevrisPaths({ home }).data;
  mkdirSync(data, { recursive: true });
  const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture, '--out', join(data, 'comparison.json')]);
  assert.equal(code, 2);
  assert.match(text, /^refused: OUTPUT_PRIVATE_DIR$/m);
  assert.deepEqual(readdirSync(data), []);
});

test('shadow --out through a linked directory is refused and nothing is written through it', async (t) => {
  const { parent, home, fixture } = setup(t);
  const target = join(parent, 'elsewhere');
  mkdirSync(target);
  // A junction on Windows: a directory link that needs no privilege.
  symlinkSync(target, join(parent, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture, '--out', join(parent, 'link', 'comparison.json')]);
  assert.equal(code, 2);
  assert.match(text, /^refused: OUTPUT_SYMLINK$/m);
  assert.deepEqual(readdirSync(target), []);
});

test('a rejected fixture whose .feedback.json sibling is a planted link is refused before anything is written', async (t) => {
  const { parent, home, fixture } = setup(t);
  writeFileSync(fixture, JSON.stringify({ ...FIXTURE, decision: 'rejected', recommendationId: 'routeAdvice', reason: 'preference', draft: true }));
  const victim = join(parent, 'victim.json');
  writeFileSync(victim, 'untouched');
  const out = join(parent, 'comparison.json');
  try {
    symlinkSync(victim, `${out}.feedback.json`, 'file');
  } catch (error) {
    // A file link needs a privilege on Windows without developer mode; the junction case above
    // covers link refusal there.
    if (process.platform === 'win32' && error?.code === 'EPERM') return t.skip('file links need a privilege here');
    throw error;
  }
  const { code, text } = await run(['shadow', '--home', home, '--fixture', fixture, '--out', out]);
  assert.equal(code, 2);
  assert.match(text, /^refused: OUTPUT_SYMLINK$/m);
  assert.equal(existsSync(out), false, 'the report was written before the sibling was checked');
  assert.equal(existsSync(`${out}.draft.json`), false);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
});
