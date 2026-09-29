import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Moved from test/live-harness-guard.test.mjs (QA-07): it reads apps/cli/src text.
const root = fileURLToPath(new URL('..', import.meta.url));

const SPAWN_TEXT = "from 'node:child_process'";

/**
 * Files, besides live-harness.ts, whose text may name node:child_process, each with why. The match
 * is on text on purpose: code in a string that is written out and run still spawns. An entry whose
 * file is missing or no longer matches is stale and fails, so an exception cannot outlive its file.
 */
const ALLOWED = {
  // K21 (DOMAINS 3298853d, F; B reviewed): the usage-read runner is a string executed only inside
  // OS network isolation (sandbox-exec or unshare), where it spawns codex app-server against the
  // stub; the module itself spawns only through live-harness with the tripwire guard.
  'usage-read-case.ts': 'the K21 usage-read runner string, run only inside OS network isolation',
};

/** One message per problem: an unlisted file that names child_process, or a stale entry. */
export function spawnProblems(files, allowed = ALLOWED) {
  const problems = [];
  const importers = [...files.keys()].filter((name) => files.get(name).includes(SPAWN_TEXT)).sort();
  for (const name of importers) {
    if (name !== 'live-harness.ts' && !Object.hasOwn(allowed, name)) problems.push(`${name} names node:child_process; only live-harness.ts starts processes in the CLI`);
  }
  if (!importers.includes('live-harness.ts')) problems.push('live-harness.ts no longer names node:child_process');
  for (const name of Object.keys(allowed)) {
    if (!files.has(name)) problems.push(`${name} is allowed to name node:child_process but no longer exists; remove its entry from ALLOWED`);
    else if (!importers.includes(name)) problems.push(`${name} is allowed to name node:child_process but no longer does; remove its entry from ALLOWED`);
  }
  return problems;
}

test('only live-harness.ts starts processes in the CLI; the old direct spawns are gone', () => {
  const srcDir = join(root, 'apps', 'cli', 'src');
  const files = new Map(
    readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => [name, readFileSync(join(srcDir, name), 'utf8')]),
  );
  assert.deepEqual(spawnProblems(files), []);
});

test('the allow-list is narrow: any other file that names child_process still fails, and a stale or missing entry fails', () => {
  const spawn = `import { spawn } ${SPAWN_TEXT};`;
  const base = [['live-harness.ts', spawn], ['usage-read-case.ts', `const RUNNER = \`${spawn}\`;`]];
  assert.deepEqual(spawnProblems(new Map(base)), []);
  assert.deepEqual(spawnProblems(new Map([...base, ['doctor-cli.ts', spawn]])), ['doctor-cli.ts names node:child_process; only live-harness.ts starts processes in the CLI']);
  assert.deepEqual(spawnProblems(new Map([...base, ['x.ts', `const s = "${SPAWN_TEXT}";`]])), ['x.ts names node:child_process; only live-harness.ts starts processes in the CLI']);
  assert.deepEqual(spawnProblems(new Map([base[0], ['usage-read-case.ts', 'const RUNNER = "";']])), ['usage-read-case.ts is allowed to name node:child_process but no longer does; remove its entry from ALLOWED']);
  assert.deepEqual(spawnProblems(new Map([base[0]])), ['usage-read-case.ts is allowed to name node:child_process but no longer exists; remove its entry from ALLOWED']);
  assert.deepEqual(spawnProblems(new Map([['usage-read-case.ts', base[1][1]]])), ['live-harness.ts no longer names node:child_process']);
});
