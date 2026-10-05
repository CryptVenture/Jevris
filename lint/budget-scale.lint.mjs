import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The test budget scale. A test run may scale the sidecar's op budgets and the hook's deadline
// (JEVRIS_TEST_BUDGET_SCALE, docs/testing.md "slow machines"), and it must never reach the
// product. Product source therefore names the variable in exactly one place, the function that
// parses it, and that function reads it only after it has seen JEVRIS_TEST=1. Every other reader
// asks the function, which is how a sidecar that starts without JEVRIS_TEST=1 ignores the
// variable. This reads source text, so it lives here and not in a test.
const root = fileURLToPath(new URL('..', import.meta.url));

export const VARIABLE = 'JEVRIS_TEST_BUDGET_SCALE';
export const OWNER = 'packages/contracts/src/sidecar.ts';
export const PARSER = 'testBudgetScale';

/** The code lines (comments left out) of `text` that name the variable, as 1-based line numbers. */
function codeLinesNaming(text) {
  const lines = [];
  let inBlock = false;
  text.split('\n').forEach((line, index) => {
    let code = line;
    if (inBlock) {
      const end = code.indexOf('*/');
      if (end === -1) return;
      inBlock = false;
      code = code.slice(end + 2);
    }
    for (;;) {
      const start = code.indexOf('/*');
      if (start === -1) break;
      const end = code.indexOf('*/', start + 2);
      if (end === -1) {
        inBlock = true;
        code = code.slice(0, start);
        break;
      }
      code = code.slice(0, start) + code.slice(end + 2);
    }
    code = code.replace(/\/\/.*$/, '');
    if (code.includes(VARIABLE)) lines.push(index + 1);
  });
  return lines;
}

/** The 1-based first and last line of the exported function `name`: from its `export function` to the next `}` at column 0. */
function functionLines(text, name) {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith(`export function ${name}(`));
  if (first === -1) return null;
  const close = lines.findIndex((line, index) => index > first && line === '}');
  return close === -1 ? null : { first: first + 1, last: close + 1 };
}

/** One message per problem: product source reading the variable outside its parser, or a parser that does not check JEVRIS_TEST first. */
export function budgetScaleProblems(files, owner = OWNER) {
  const problems = [];
  for (const [name, text] of files) {
    if (name === owner) continue;
    const lines = codeLinesNaming(text);
    if (lines.length > 0) problems.push(`${name}:${lines[0]} reads ${VARIABLE}; only ${PARSER} in ${owner} may, so a product process outside a test run ignores it`);
  }
  const ownerText = files.get(owner);
  if (ownerText === undefined) return [`${owner} no longer exists; update OWNER`, ...problems];
  const range = functionLines(ownerText, PARSER);
  if (range === null) return [`${owner} no longer has export function ${PARSER}(...); update PARSER`, ...problems];
  const lines = codeLinesNaming(ownerText);
  if (lines.length === 0) problems.push(`${owner} no longer reads ${VARIABLE}; update VARIABLE`);
  for (const line of lines) {
    if (line < range.first || line > range.last) problems.push(`${owner}:${line} names ${VARIABLE} outside ${PARSER}`);
  }
  const body = ownerText.split('\n').slice(range.first - 1, range.last).join('\n');
  const gate = body.indexOf("env['JEVRIS_TEST'] !== '1'");
  const read = body.indexOf(`env['${VARIABLE}']`);
  if (gate === -1) problems.push(`${PARSER} in ${owner} does not return 1 unless JEVRIS_TEST is 1`);
  else if (read !== -1 && read < gate) problems.push(`${PARSER} in ${owner} reads ${VARIABLE} before it checks JEVRIS_TEST`);
  return problems;
}

/** Every product source file: <workspace>/src/**.ts of apps and packages, and the plugin sources, keyed by repository path. */
function productSources() {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  };
  for (const group of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(root, group))) {
      const src = join(root, group, workspace, 'src');
      try {
        walk(src);
      } catch {
        // a workspace with no src folder
      }
    }
  }
  try {
    walk(join(root, 'plugins'));
  } catch {
    // no plugins folder
  }
  return files;
}

test('product source names JEVRIS_TEST_BUDGET_SCALE only in the function that parses it, behind JEVRIS_TEST=1', () => {
  assert.deepEqual(budgetScaleProblems(productSources()), []);
});

test('the budget scale check catches a stray reader, an ungated parser and a stale owner', () => {
  const parser = (body) => `export function ${PARSER}(env) {\n${body}\n}\n`;
  const gated = parser(`  if (env['JEVRIS_TEST'] !== '1') return 1;\n  return Number(env['${VARIABLE}']);`);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', gated]]), 'o.ts'), []);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', `// ${VARIABLE} in a comment\n/** ${VARIABLE} */\n${gated}`]]), 'o.ts'), [], 'comments do not count');
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', gated], ['a.ts', `const s = process.env['${VARIABLE}'];`]]), 'o.ts'), [`a.ts:1 reads ${VARIABLE}; only ${PARSER} in o.ts may, so a product process outside a test run ignores it`]);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', parser(`  return Number(env['${VARIABLE}']);`)]]), 'o.ts'), [`${PARSER} in o.ts does not return 1 unless JEVRIS_TEST is 1`]);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', parser(`  const n = Number(env['${VARIABLE}']);\n  if (env['JEVRIS_TEST'] !== '1') return 1;\n  return n;`)]]), 'o.ts'), [`${PARSER} in o.ts reads ${VARIABLE} before it checks JEVRIS_TEST`]);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', `${gated}const outside = '${VARIABLE}';\n`]]), 'o.ts'), [`o.ts:5 names ${VARIABLE} outside ${PARSER}`]);
  assert.deepEqual(budgetScaleProblems(new Map(), 'o.ts'), ['o.ts no longer exists; update OWNER']);
  assert.deepEqual(budgetScaleProblems(new Map([['o.ts', 'export const x = 1;\n']]), 'o.ts'), [`o.ts no longer has export function ${PARSER}(...); update PARSER`]);
});
