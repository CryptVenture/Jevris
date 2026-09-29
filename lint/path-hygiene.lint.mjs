import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path hygiene (BLD-02, BLD-03, BLD-07, QA-07). Product code builds paths with node:path and
 * @jevris/platform, so they are right on Windows as well as POSIX:
 *
 * - no `new URL(...).pathname` (a Windows drive path comes out as `/C:/...`; use fileURLToPath)
 * - no `startsWith('/')` absolute check (use isAbsoluteFor or isAbsoluteOnAnyPlatform)
 * - no `/`-joined template path such as `${dir}/${name}` (use join)
 * - no `homedir()` and no `.jevris` or `.config/jevris` path literal outside packages/platform
 *   (use jevrisPaths)
 *
 * A line that must keep a pattern ends with `// path-hygiene: allow <reason>`.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

export const RULES = [
  { id: 'url-pathname', pattern: /new URL\([^;]*?\)\.pathname\b/, hint: 'use fileURLToPath' },
  { id: 'posix-absolute', pattern: /\.startsWith\(\s*['"]\/['"]\s*\)/, hint: 'use isAbsoluteFor or isAbsoluteOnAnyPlatform' },
  { id: 'slash-template', pattern: /`[^`]*\$\{[^}]+\}\/(?:\$\{|[\w.-]+)[^`]*`/, hint: 'join path parts with node:path join', skip: ['packages/contracts/'] },
  { id: 'homedir', pattern: /\bhomedir\(\)/, hint: 'use resolveHome or jevrisPaths from @jevris/platform', platformOnly: true },
  { id: 'jevris-literal', pattern: /['"`](?:[^'"`]*[\\/])?(?:\.jevris|\.config[\\/]jevris)(?=[\\/'"`])/, hint: 'use jevrisPaths from @jevris/platform', platformOnly: true },
];

const ALLOW = /\/\/ path-hygiene: allow \S/;

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ((name.endsWith('.ts') && !name.endsWith('.d.ts')) || name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

export function productFiles(base = root) {
  const files = [];
  for (const group of ['apps', 'packages']) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir)) walk(join(dir, pkg, 'src'), files);
  }
  walk(join(base, 'plugins', 'shared'), files);
  walk(join(base, 'bin'), files);
  return files;
}

/** Findings for one file's text. `rel` uses forward slashes. */
export function lintText(rel, text) {
  const inPlatform = rel.startsWith('packages/platform/');
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ALLOW.test(line)) continue;
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    for (const rule of RULES) {
      if (rule.platformOnly === true && inPlatform) continue;
      if (rule.skip !== undefined && rule.skip.some((prefix) => rel.startsWith(prefix))) continue;
      if (rule.pattern.test(code)) findings.push(`${rel}:${i + 1} ${rule.id}: ${rule.hint}`);
    }
  }
  return findings;
}

test('product source builds paths through node:path and @jevris/platform', () => {
  const findings = [];
  for (const file of productFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    findings.push(...lintText(rel, readFileSync(file, 'utf8')));
  }
  assert.deepEqual(findings, []);
});

test('the rules catch each pattern and honour the allow comment', () => {
  const hit = (text, rel = 'apps/cli/src/x.ts') => lintText(rel, text).map((line) => line.split(' ')[1].replace(':', ''));
  assert.deepEqual(hit("const p = new URL('../x', import.meta.url).pathname;"), ['url-pathname']);
  assert.deepEqual(hit("if (p.startsWith('/')) return;"), ['posix-absolute']);
  assert.deepEqual(hit('const p = `${home}/.claude`;'), ['slash-template']);
  assert.deepEqual(hit('const h = homedir();'), ['homedir']);
  assert.deepEqual(hit("const d = join(home, '.jevris');"), ['jevris-literal']);
  assert.deepEqual(hit("const d = join(home, '.config/jevris');"), ['jevris-literal']);
  assert.deepEqual(hit("const d = join(home, '.jevris'); // path-hygiene: allow legacy layout probe"), []);
  assert.deepEqual(hit('const h = homedir();', 'packages/platform/src/paths.ts'), []);
  assert.deepEqual(hit("// see ~/.jevris for the old layout"), []);
  assert.deepEqual(hit("const id = 'jevris.skill-advice';"), []);
  assert.deepEqual(hit('const s = `${a} of ${b}`;'), []);
});
