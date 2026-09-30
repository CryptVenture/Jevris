import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test isolation (QA-07): a test result must not depend on which harness or app is installed on
// the machine that runs it. Product code reaches a machine-wide harness location (an app bundle
// folder, an administrator's managed-settings file) only through one module, and that module
// stays quiet in a test run (liveHarnessAllowed: JEVRIS_TEST, a node test context or
// JEVRIS_NO_LIVE_HARNESS refuse it; JEVRIS_LIVE_HARNESS=1 lifts it for a live smoke). This reads
// apps/cli/src text, so it lives here and not in a test.
const root = fileURLToPath(new URL('..', import.meta.url));

/** Machine-wide locations, each with the one file that may name it. */
export const GUARDED = [
  { pattern: '/Applications', owner: 'antigravity-products.ts', what: 'the macOS application folder' },
  { pattern: '/Library/Application Support/ClaudeCode', owner: 'managed-policy.ts', what: 'Claude Code managed settings on macOS' },
  { pattern: '/etc/claude-code', owner: 'managed-policy.ts', what: 'Claude Code managed settings on Linux' },
];
const GATE = 'liveHarnessAllowed';

/** One message per problem: another file naming a guarded location, or its owner without the gate. */
export function isolationProblems(files, guarded = GUARDED) {
  const problems = [];
  for (const { pattern, owner, what } of guarded) {
    for (const [name, text] of files) {
      if (name !== owner && text.includes(pattern)) problems.push(`${name} names ${pattern} (${what}); only ${owner} may, behind ${GATE}`);
    }
    const ownerText = files.get(owner);
    if (ownerText === undefined) problems.push(`${owner} no longer exists; update GUARDED`);
    else if (!ownerText.includes(pattern)) problems.push(`${owner} no longer names ${pattern}; update GUARDED`);
    else if (!ownerText.includes(GATE)) problems.push(`${owner} names ${pattern} but not ${GATE}: a test run would read the machine`);
  }
  return problems;
}

test('machine-wide harness locations are named only by their gated owner module', () => {
  const srcDir = join(root, 'apps', 'cli', 'src');
  const files = new Map(
    readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => [name, readFileSync(join(srcDir, name), 'utf8')]),
  );
  assert.deepEqual(isolationProblems(files), []);
});

test('the isolation check catches an ungated owner, a stray reader and a stale entry', () => {
  const one = [{ pattern: '/Applications', owner: 'a.ts', what: 'apps' }];
  assert.deepEqual(isolationProblems(new Map([['a.ts', `const d = '/Applications'; liveHarnessAllowed();`]]), one), []);
  assert.deepEqual(isolationProblems(new Map([['a.ts', `const d = '/Applications';`]]), one), ['a.ts names /Applications but not liveHarnessAllowed: a test run would read the machine']);
  assert.deepEqual(isolationProblems(new Map([['a.ts', `'/Applications' liveHarnessAllowed`], ['b.ts', `readdir('/Applications')`]]), one), ['b.ts names /Applications (apps); only a.ts may, behind liveHarnessAllowed']);
  assert.deepEqual(isolationProblems(new Map([['a.ts', 'liveHarnessAllowed']]), one), ['a.ts no longer names /Applications; update GUARDED']);
  assert.deepEqual(isolationProblems(new Map(), one), ['a.ts no longer exists; update GUARDED']);
});
