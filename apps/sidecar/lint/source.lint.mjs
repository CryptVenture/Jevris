import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Source checks for the sidecar (QA-07). They read src text, so they run in `npm run lint`,
 * not in the behavioural suite.
 */

const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const cliSrc = (name) => readFileSync(new URL(`../../cli/src/${name}`, import.meta.url), 'utf8');
const SAME_USER_SENTENCE =
  'A fully compromised OS account is outside what a same-user sidecar can reliably contain; stronger enforcement needs separate principals and operating-system isolation.';

// The legacy listener (server, frame, paths, span-gate, hook-client, launch-store, operator-frames,
// accepted-write) is retired. Its contracts are proven against the real daemon; see the domain STATUS.
const RETIRED = [
  'server.ts',
  'frame.ts',
  'paths.ts',
  'span-gate.ts',
  'hook-client.ts',
  'launch-store.ts',
  'operator-frames.ts',
  'accepted-write.ts',
  'scheduler.ts',
  'lease.ts',
  'worktree.ts',
  'worker.ts',
];

test('the retired legacy listener modules stay deleted and nothing imports them', async () => {
  const { readdirSync } = await import('node:fs');
  for (const name of RETIRED) {
    assert.equal(existsSync(new URL(`../src/${name}`, import.meta.url)), false, `${name} was reintroduced`);
  }
  const names = readdirSync(new URL('../src/', import.meta.url)).filter((file) => file.endsWith('.ts'));
  for (const name of names) {
    const text = src(name);
    for (const retired of RETIRED) {
      const module = `./${retired.replace(/\.ts$/, '.js')}`;
      assert.equal(text.includes(`'${module}'`), false, `${name} imports the retired ${module}`);
    }
  }
});

test('kill switch drill: the reader makes no network call and reads no environment', () => {
  const killSwitch = cliSrc('kill-switch.ts');
  assert.equal(killSwitch.includes('fetch('), false);
  assert.equal(killSwitch.includes('process.env'), false);
});

test('doctor still states the same-user limit; the sidecar entry points claim no peer-credential check', () => {
  const doctor = cliSrc('doctor.ts');
  assert.equal(doctor.includes(SAME_USER_SENTENCE), true);
  assert.equal(doctor.includes('lines.push(report.sameUserLimit)'), true);
  for (const name of ['index.ts', 'node-builtins.d.ts']) {
    const text = src(name);
    assert.equal(text.includes('getpeereid'), false);
    assert.equal(text.includes('SO_PEERCRED'), false);
  }
});

test('the sidecar reads no assets/skill-templates tree and does not shortlist skills (skills advice retired)', async () => {
  const { readdirSync } = await import('node:fs');
  const names = readdirSync(new URL('../src/', import.meta.url)).filter((file) => file.endsWith('.ts'));
  for (const name of names) {
    const text = src(name);
    assert.equal(text.includes('skill-templates'), false, `${name} reads the retired skill-templates tree`);
    assert.equal(text.includes('shortlistInstalledSkills'), false, `${name} still shortlists skills`);
  }
});

test('the sidecar passes only the three GOV-07 opt-in variables, and none under a test run (GOV-07)', () => {
  const source = src('state.ts');
  const call = source.slice(source.indexOf('resolveProviderCredential('), source.indexOf('credential-opt-in-refused'));
  assert.match(call, /optInEnv: cred\.keyringBlockedInTests\(\) \? \{\} : \{/);
  const names = [...call.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['CREDENTIALS_DIRECTORY', 'JEVRIS_CREDENTIAL_FILE', 'JEVRIS_CREDENTIAL_SYSTEMD']);
});

test('only the sidecar resolves the Jev credential: no other product source calls resolveProviderCredential (GOV-06)', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const callers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && readFileSync(full, 'utf8').includes('resolveProviderCredential')) callers.push(relative(repo, full).split(sep).join('/'));
    }
  };
  for (const group of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(repo, group))) {
      const srcDir = join(repo, group, workspace, 'src');
      if (existsSync(srcDir)) walk(srcDir);
    }
  }
  const outside = callers.filter((file) => file !== 'apps/cli/src/credential.ts' && !file.startsWith('apps/sidecar/src/'));
  assert.deepEqual(outside, [], 'a module outside the sidecar resolves the credential');
  assert.ok(callers.includes('apps/sidecar/src/state.ts'), 'the sidecar no longer resolves the credential');
});
