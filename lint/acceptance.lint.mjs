import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance files stay honest (RLS-02, RLS-03):
 *
 * - one file per story or workflow, named after its id (us01.test.mjs, w01.test.mjs), for all
 *   US01..US40 and W01..W12;
 * - a story file asserts every Then clause of fixtures/ssot/user-stories.json by its exact text,
 *   so its clause count can never be lower than the specification's, or it declares the story
 *   `pending` with the owner and requirement it waits for;
 * - nothing is skipped: no `skip`, `todo` or `.only` in an acceptance file.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'test', 'acceptance');
const stories = JSON.parse(readFileSync(join(root, 'fixtures', 'ssot', 'user-stories.json'), 'utf8'));
const workflowIds = Array.from({ length: 12 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`);

export function clausesOf(then) {
  return then
    .split(/;\s*/)
    .map((clause) => clause.trim().replace(/\.$/, ''))
    .filter((clause) => clause.length > 0);
}

/** Problems in one acceptance file's text for `id`. */
export function fileProblems(id, text, clauses) {
  const problems = [];
  const declaresPending = new RegExp(`\\bpending\\(\\s*['"]${id}['"]`).test(text);
  const declaresStory = new RegExp(`\\b(?:story|workflow)\\(\\s*['"]${id}['"]`).test(text);
  if (!declaresPending && !declaresStory) problems.push(`${id}: declares neither story/workflow('${id}') nor pending('${id}')`);
  if (declaresPending && declaresStory) problems.push(`${id}: is both pending and implemented`);
  if (/\b(?:test|it|describe)\.(?:skip|todo|only)\b|\{\s*(?:skip|todo)\s*:/.test(text)) problems.push(`${id}: skips or narrows tests`);
  if (declaresStory && clauses !== null) {
    for (const clause of clauses) {
      if (!text.includes(`then(${JSON.stringify(clause)}`) && !text.includes(`then('${clause.replace(/'/g, "\\'")}'`)) problems.push(`${id}: Then clause not asserted verbatim: "${clause}"`);
    }
  }
  return problems;
}

test('every story and workflow has an acceptance file that asserts its Then clauses or is declared pending (RLS-02, RLS-03)', () => {
  const problems = [];
  for (const item of stories) {
    const file = join(dir, `${item.id.toLowerCase()}.test.mjs`);
    if (!existsSync(file)) problems.push(`${item.id}: test/acceptance/${item.id.toLowerCase()}.test.mjs is missing`);
    else problems.push(...fileProblems(item.id, readFileSync(file, 'utf8'), clausesOf(item.then)));
  }
  for (const id of workflowIds) {
    const file = join(dir, `${id.toLowerCase()}.test.mjs`);
    if (!existsSync(file)) problems.push(`${id}: test/acceptance/${id.toLowerCase()}.test.mjs is missing`);
    else problems.push(...fileProblems(id, readFileSync(file, 'utf8'), null));
  }
  const known = new Set([...stories.map((item) => `${item.id.toLowerCase()}.test.mjs`), ...workflowIds.map((id) => `${id.toLowerCase()}.test.mjs`)]);
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (name.endsWith('.test.mjs') && !known.has(name)) problems.push(`${name}: not a story or workflow id`);
  }
  assert.deepEqual(problems, []);
});

test('the acceptance lint catches a missing clause, a skip and an undeclared file (RLS-02)', () => {
  const clauses = ['Only Jevris-owned entries change', 'a concurrent user edit is preserved and data deletion is a separate choice'];
  const good = "story('US01', async ({ then }) => {\n  await then('Only Jevris-owned entries change', () => {});\n  await then('a concurrent user edit is preserved and data deletion is a separate choice', () => {});\n});";
  assert.deepEqual(fileProblems('US01', good, clauses), []);
  assert.deepEqual(fileProblems('US01', good.replace("  await then('Only Jevris-owned entries change', () => {});\n", ''), clauses), ['US01: Then clause not asserted verbatim: "Only Jevris-owned entries change"']);
  assert.deepEqual(fileProblems('US01', "pending('US01', 'F: ADM-02 installer v2');", clauses), []);
  assert.deepEqual(fileProblems('US01', `${good}\ntest.skip('x', () => {});`, clauses), ['US01: skips or narrows tests']);
  assert.deepEqual(fileProblems('US01', 'export {};', clauses), ["US01: declares neither story/workflow('US01') nor pending('US01')"]);
  assert.equal(clausesOf('Only Jevris-owned entries change; a concurrent user edit is preserved.').length, 2);
});
