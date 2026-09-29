import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { checkFloors, packageOf, summarize } = await import('../scripts/coverage.mjs');
const { coverageArgs } = await import('../scripts/test.mjs');
const workspaces = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;

test('lcov records are summed per package, and files outside a dist are ignored (QA-06)', () => {
  const at = (...parts) => join(root, ...parts);
  const lcov = [
    `SF:${at('packages', 'core', 'dist', 'a.js')}`,
    'LF:10',
    'LH:9',
    'BRF:4',
    'BRH:2',
    'end_of_record',
    `SF:${at('packages', 'core', 'dist', 'nested', 'b.js')}`,
    'LF:10',
    'LH:10',
    'BRF:0',
    'BRH:0',
    'end_of_record',
    `SF:${at('scripts', 'test.mjs')}`,
    'LF:100',
    'LH:0',
    'end_of_record',
    `SF:${at('apps', 'cli', 'dist', 'cli.js')}`,
    'LF:3',
    'LH:1',
    'end_of_record',
  ].join('\n');
  const summary = summarize(lcov, root);
  assert.deepEqual(Object.keys(summary), ['apps/cli', 'packages/core']);
  assert.deepEqual(summary['packages/core'], { lines: 95, branches: 50 });
  assert.deepEqual(summary['apps/cli'], { lines: 33.33, branches: 100 });
  assert.equal(packageOf(at('packages', 'core', 'src', 'a.ts'), root), null); // test-hygiene: not product source
});

test('a package under its line or branch floor, or with no coverage, fails (QA-06)', () => {
  const summary = { 'packages/core': { lines: 90, branches: 70 } };
  assert.deepEqual(checkFloors(summary, { 'packages/core': { lines: 90, branches: 70 } }), []);
  assert.deepEqual(checkFloors(summary, { 'packages/core': { lines: 91, branches: 70 } }), ['packages/core: lines 90% < floor 91%']);
  assert.deepEqual(checkFloors(summary, { 'packages/core': { lines: 80, branches: 71 } }), ['packages/core: branches 70% < floor 71%']);
  assert.deepEqual(checkFloors(summary, { 'apps/cli': { lines: 1, branches: 1 } }), ['apps/cli: no coverage recorded']);
});

test('every workspace with a src directory has a coverage floor (QA-06)', () => {
  const floors = JSON.parse(readFileSync(join(root, 'coverage-floors.json'), 'utf8')).floors;
  for (const workspace of workspaces()) {
    if (!existsSync(join(root, workspace, 'src'))) continue; // test-hygiene: not product source
    const key = workspace.split(/[\\/]/).join('/');
    assert.equal(Object.hasOwn(floors, key), true, `${key} has no floor`);
    assert.equal(floors[key].lines >= 50 && floors[key].lines <= 100, true, key);
    assert.equal(floors[key].branches >= 50 && floors[key].branches <= 100, true, key);
  }
});

test('the test runner adds coverage flags only when asked', () => {
  assert.deepEqual(coverageArgs({}), []);
  const args = coverageArgs({ JEVRIS_TEST_COVERAGE_LCOV: join(root, 'coverage', 'lcov.info') });
  assert.equal(args.includes('--experimental-test-coverage'), true);
  assert.equal(args.includes('--test-reporter=lcov'), true);
  assert.equal(args.includes('--test-reporter=spec'), true);
});
