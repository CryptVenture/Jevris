import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = new URL('../scripts/child-stdin.mjs', import.meta.url).href;

/** Runs a parent that stalls between spawn and its stdin write while its child exits at once. */
function stalledWrite(guarded) {
  const script = [
    "import { spawn } from 'node:child_process';",
    `const { guardStdin } = await import(${JSON.stringify(helper)});`,
    'const uncaught = [];',
    "process.on('uncaughtException', (error) => uncaught.push(error.code ?? error.message));",
    "const spawned = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] });",
    `const child = ${guarded ? 'guardStdin(spawned)' : 'spawned'};`,
    // The stall: the child is gone before the write, and the parent has not yet seen it exit.
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
    "child.stdin.write('x\\n');",
    'child.stdin.end();',
    "const code = await new Promise((resolve) => child.on('close', resolve));",
    'await new Promise((resolve) => setTimeout(resolve, 50));',
    'console.log(JSON.stringify({ code, uncaught }));',
  ].join('\n');
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

test('guardStdin: a write to a child that is already gone is no uncaught error, and the child\'s exit is still reported (QA-07)', () => {
  const guarded = stalledWrite(true);
  assert.deepEqual(guarded, { code: 3, uncaught: [] });
});

test('without guardStdin the same write is an uncaught EPIPE, the hazard the helper exists for (QA-07)', { skip: process.platform === 'win32' ? 'the POSIX EPIPE control' : false }, () => {
  const bare = stalledWrite(false);
  assert.equal(bare.code, 3);
  assert.ok(bare.uncaught.length > 0, 'an unguarded write fails the parent');
});

test('every script and test that spawns a child and writes or ends its stdin guards it (guardStdin, or its own stdin error listener) (QA-07)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dirs = ['scripts', 'test', 'lint'];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group))) for (const sub of ['test', 'scripts']) dirs.push(join(group, name, sub));
  }
  const files = dirs
    .filter((dir) => existsSync(join(root, dir)))
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true }).map((rel) => join(dir, String(rel))))
    .filter((rel) => /\.(m?js|ts)$/.test(rel) && !rel.split(/[\\/]/).includes('node_modules'));
  const writes = /\b(?!process\b)[A-Za-z_]\w*\.stdin\??\.(write|end)\(/;
  const unguarded = files.filter((rel) => {
    const text = readFileSync(join(root, rel), 'utf8');
    return /\b(spawn|fork)\(/.test(text) && writes.test(text) && !/guardStdin\(|\.stdin\??\.on\('error'/.test(text);
  });
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  assert.deepEqual(unguarded, []);
});
