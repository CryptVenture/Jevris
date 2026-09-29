import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedHostSkip } from '../../../test/managed-host.mjs';


const { main } = await import('../dist/cli.js');

const CANARY = 'OUTSIDE_CANARY_9f3a7c';

async function run(args) {
  let text = '';
  const code = await main(args, (chunk) => {
    text += chunk;
  });
  return { code, text };
}

async function withFixture(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'jevris-shortlist-'));
  const home = join(parent, 'home');
  const skills = join(home, 'skills', 'route');
  const evidence = join(home, 'evidence', 'src'); // test-hygiene: not product source
  const outside = join(parent, 'outside');
  await mkdir(skills, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await mkdir(outside, { recursive: true });
  const skill = [
    '---',
    'name: route',
    'description: Route advice',
    '---',
    'not a command',
    '',
  ].join('\n');
  await writeFile(join(skills, 'SKILL.md'), skill);
  await writeFile(join(evidence, 'app.ts'), 'export const n = 1;\n');
  await writeFile(join(outside, 'canary.txt'), CANARY);
  try {
    await fn({
      home,
      skillsRoot: join(home, 'skills'),
      evidenceRoot: join(home, 'evidence'),
      outside,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('shortlist prints none and does not read a sibling canary', async () => {
  await withFixture(async ({ home, skillsRoot, evidenceRoot, outside }) => {
    const { code, text } = await run([
      'shortlist',
      '--home',
      home,
      '--skills-root',
      skillsRoot,
      '--evidence-root',
      evidenceRoot,
      '--intent',
      'use route',
      'src/app.ts',
    ]);
    assert.equal(code, 0);
    assert.equal(text.includes('executed: false'), true);
    assert.equal(text.includes('uploaded: false'), true);
    assert.equal(text.includes('none'), true);
    assert.equal(text.split('\n').some((line) => line.startsWith('JEVRIS_REPORT ')), true);
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes(outside), false);
    assert.equal(skillsRoot.includes(outside), false);
    assert.equal(evidenceRoot.includes(outside), false);
  });
});

test('an escaping symlink is missing and an in-scope span is still returned', async () => {
  // C34 / SKIL-02: a symlink that leaves the approved root is not read.
  // C05 / SKIL-03: that id stays missing. The canary is not proof of a read.
  await withFixture(async ({ home, evidenceRoot, outside }) => {
    const canary = 'SYMLINK_ESCAPE_CANARY_4c91e0';
    const target = join(outside, 'secret.txt');
    await writeFile(target, canary);
    await symlink(target, join(evidenceRoot, 'link'));
    const { code, text } = await run([
      'shortlist',
      '--home',
      home,
      '--evidence-root',
      evidenceRoot,
      '--intent',
      'use route',
      'src/app.ts',
      'link',
    ]);
    assert.equal(code, 0);
    assert.equal(text.includes('executed: false'), true);
    assert.equal(text.includes('uploaded: false'), true);
    assert.equal(text.includes('src/app.ts'), true);
    assert.equal(text.includes('evidence missing: link state: missing'), true);
    assert.equal(text.includes(canary), false);
    assert.equal(text.includes('absent'), false);
    assert.equal(text.includes('\u001b'), false);
  });
});

test('a basename inside the root is fetched and an escaping match is not read', async () => {
  // C34 / SKIL-02: rank stays inside the approved root and does not upload it.
  await withFixture(async ({ home, evidenceRoot, outside }) => {
    const canary = 'SCAN_ESCAPE_CANARY_88aa21';
    await writeFile(join(outside, 'secret.txt'), canary);
    await symlink(join(outside, 'secret.txt'), join(evidenceRoot, 'route.ts'));
    await mkdir(join(evidenceRoot, 'keep'));
    await writeFile(join(evidenceRoot, 'keep', 'route.ts'), 'INSIDE_ROUTE_SPAN');
    await writeFile(join(evidenceRoot, 'router.ts'), 'ROUTER_NOT_A_MATCH');
    const { code, text } = await run([
      'shortlist',
      '--home',
      home,
      '--evidence-root',
      evidenceRoot,
      '--intent',
      'route',
    ]);
    assert.equal(code, 0);
    assert.equal(text.includes('INSIDE_ROUTE_SPAN'), true);
    assert.equal(text.includes(canary), false);
    assert.equal(text.includes('ROUTER_NOT_A_MATCH'), false);
    assert.equal(text.includes('executed: false'), true);
    assert.equal(text.includes('uploaded: false'), true);
    assert.equal(text.includes('evidence missing: route.ts'), false);
    assert.equal(text.includes('absent'), false);
  });
});

test('a missing in-scope id stays missing and an outside root is refused unread', async () => {
  // C05 / SKIL-03: the printed missing line names the id and does not disprove a behavior.
  await withFixture(async ({ home, skillsRoot, evidenceRoot, outside }) => {
    const missing = await run([
      'shortlist',
      '--home',
      home,
      '--evidence-root',
      evidenceRoot,
      '--intent',
      'use route',
      'gone.ts',
    ]);
    assert.equal(missing.code, 0);
    assert.equal(missing.text.includes('evidence missing: gone.ts state: missing'), true);
    assert.equal(missing.text.includes('executed: false'), true);
    assert.equal(missing.text.includes('uploaded: false'), true);
    assert.equal(missing.text.includes('absent'), false);
    assert.equal(missing.text.includes('\u001b'), false);
    assert.equal(missing.text.includes(CANARY), false);

    const route = await run([
      'shortlist',
      '--home',
      home,
      '--skills-root',
      skillsRoot,
      '--intent',
      'use route',
    ]);
    assert.equal(route.code, 0);
    assert.equal(route.text.includes('none'), true);
    assert.equal(route.text.includes('executed: false'), true);

    const refused = await run([
      'shortlist',
      '--home',
      home,
      '--evidence-root',
      outside,
      '--intent',
      'use route',
      'canary.txt',
    ]);
    assert.equal(refused.code, 2);
    assert.equal(refused.text, 'refused\n');
    assert.equal(refused.text.includes(CANARY), false);
  });
});

test('an unknown command and an unknown flag still refuse', async () => {
  await withFixture(async ({ home }) => {
    const unknown = await run(['nosuch', '--home', home]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.text.includes('refused'), true);
    const flag = await run(['shortlist', '--home', home, '--nope']);
    assert.equal(flag.code, 2);
    assert.equal(flag.text.includes('refused'), true);
    // ADM-01: without --home, shortlist uses JEVRIS_HOME (a temp home here).
    const saved = process.env.JEVRIS_HOME;
    process.env.JEVRIS_HOME = home;
    try {
      const defaultHome = await run(['shortlist', '--intent', 'use route']);
      assert.equal(defaultHome.code, 0);
      assert.equal(defaultHome.text.includes('executed: false'), true);
    } finally {
      if (saved === undefined) delete process.env.JEVRIS_HOME;
      else process.env.JEVRIS_HOME = saved;
    }
  });
});

test('a root outside home is refused before the canary can be read', async () => {
  await withFixture(async ({ home, outside }) => {
    const { code, text } = await run([
      'shortlist',
      '--home',
      home,
      '--skills-root',
      outside,
      '--intent',
      'use route',
    ]);
    assert.equal(code, 2);
    assert.equal(text, 'refused\n');
    assert.equal(text.includes(CANARY), false);
  });
});

test('selecting none still exits 0 and existing commands keep their flags', { skip: managedHostSkip() }, async () => {
  await withFixture(async ({ home, skillsRoot }) => {
    const none = await run([
      'shortlist',
      '--home',
      home,
      '--skills-root',
      skillsRoot,
      '--intent',
      'unrelated',
    ]);
    assert.equal(none.code, 0);
    assert.equal(none.text.includes('skills selected: none'), true);
    assert.equal(none.text.includes('executed: false'), true);
    const install = await run(['install', '--yes', '--home', home]);
    assert.equal(install.code, 0);
    // Install certifies what it installed, but a test run never starts a real harness: nothing claims certified.
    assert.equal(/certify [a-z]+: certified|mode: certified/.test(install.text), false, install.text);
    assert.match(install.text, /^mode: reduced for claude, kilocode, codex, opencode, antigravity \(observe only until certified; the lines above name the fix\)$/m);
    assert.equal(install.text.includes('enforced'), false);
    assert.equal(install.text.includes('verified true'), false);
    // ADM-01: --home is optional; without it the commands use JEVRIS_HOME (a temp home here).
    const saved = process.env.JEVRIS_HOME;
    process.env.JEVRIS_HOME = home;
    try {
      const uninstall = await run(['uninstall']);
      assert.equal(uninstall.code, 0);
      const doctor = await run(['doctor']);
      assert.notEqual(doctor.text, 'refused\n');
      const data = await run(['data', 'delete']);
      assert.equal(data.code, 0);
    } finally {
      if (saved === undefined) delete process.env.JEVRIS_HOME;
      else process.env.JEVRIS_HOME = saved;
    }
  });
});
