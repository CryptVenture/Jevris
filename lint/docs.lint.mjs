import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * User documentation stays true to the product (UDOC-09).
 *
 * - Stale claims: no page says the package is private or unpublished, names the old Node
 *   range, or tells users to run `npx jevris` (the package is `@webventures/jevris`).
 * - Commands: every `jevris <command>` in a code span or block is a command in the generated
 *   CLI reference (docs/cli.md), and every subcommand or flag written after it appears in that
 *   command's help text. A page cannot document a command the product does not have.
 * - Links: every relative link resolves to a file in the repository.
 * - The pre-1.2 readiness audit carries its superseded banner.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
// AGENTS.md and CLAUDE.md are the maintainers' local agent instructions, not tracked, so not linted.
const TOP_LEVEL = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'RELEASING.md'];
// docs/adr/ and docs/audit/ are the maintainers' local records, not tracked, so not linted.
const LOCAL_ONLY = ['docs/adr/', 'docs/audit/'];

export const STALE_CLAIMS = [
  { id: 'private-package', pattern: /\b(?:private repository|repository is private|package is private|[Ii]t is private\b|not an npm package|not published to npm|`"private": true` in every)/ },
  { id: 'old-node-range', pattern: /Node(?:\.js)? \**22\** or \**24\**|>=22\.13 <25|Node 26 fails|Node 20, 25, and 26/ },
  { id: 'v1.0-only', pattern: /\bv1\.0 only\b|[Mm]ilestone \*\*v1\.0\*\* is/ },
  { id: 'unscoped-npx', pattern: /\bnpx jevris\b/ },
  { id: 'wrong-scope', pattern: /@antigravity\/jevris|@cryptventure\/jevris/ },
];

function walkMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** The user-facing pages: top-level files and docs/, without the local-only records. */
export function userPages(base = root) {
  const pages = [...TOP_LEVEL.map((name) => join(base, name)).filter((file) => existsSync(file)), ...walkMarkdown(join(base, 'docs'))];
  return pages.filter((file) => !LOCAL_ONLY.some((dir) => rel(file, base).startsWith(dir)));
}

function rel(file, base = root) {
  return relative(base, file).split(sep).join('/');
}

export function staleClaims(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const rule of STALE_CLAIMS) if (rule.pattern.test(line)) found.push({ line: index + 1, id: rule.id });
  });
  return found;
}

/** `## jevris <name>` sections of the generated CLI reference: name -> help text. */
export function cliSections(cliMarkdown) {
  const sections = new Map();
  const parts = cliMarkdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = part.slice(0, newline).trim();
    const match = /^jevris (.+)$/.exec(heading);
    if (match !== null) sections.set(match[1], part.slice(newline + 1));
  }
  return sections;
}

/**
 * Code spans and fenced blocks of a markdown page, with their line numbers. A ```text block is
 * program output, not a command to run, so it is skipped.
 */
export function codeFragments(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, index) => {
    const opener = /^\s*```\s*([\w-]*)/.exec(line);
    if (opener !== null) {
      fence = fence === null ? opener[1] || 'plain' : null;
      return;
    }
    if (fence !== null) {
      if (fence !== 'text') out.push({ line: index + 1, code: line.replace(/\s#\s.*$/, '') });
      return;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) out.push({ line: index + 1, code: match[1] });
  });
  return out;
}

/**
 * `jevris <words...>` invocations in one code fragment: the command, then the subcommand words
 * and flags written after it (placeholders like `<dir>` and values are skipped).
 */
export function invocations(code) {
  const out = [];
  for (const match of code.matchAll(/(?:^|[\s(/;|&])jevris((?:\s+[^\s|;&)]+)*)/g)) {
    const words = match[1].trim().split(/\s+/).map((word) => word.replace(/['"`),;]+$/, '').replace(/^\[+/, '').replace(/\]+$/, '')).filter((word) => word.length > 0);
    if (words.length === 0) continue;
    const [command, ...rest] = words;
    if (!/^[a-z][a-z-]*$/.test(command) && !command.startsWith('--') && command !== '-h') continue;
    const subcommands = [];
    const flags = [];
    let expectValue = false;
    for (const word of rest) {
      if (word.startsWith('--')) {
        flags.push(word.split('=')[0]);
        expectValue = false;
        continue;
      }
      if (expectValue || word.startsWith('<') || word.startsWith('"') || word.startsWith("'") || word.startsWith('$') || /[./\\:@]/.test(word) || /^\d/.test(word) || /^[A-Z]/.test(word)) continue;
      if (subcommands.length < 2 && flags.length === 0) subcommands.push(word);
    }
    out.push({ command, subcommands, flags });
  }
  return out;
}

/** Problems for one invocation against the CLI reference sections. */
export function invocationProblems(inv, sections) {
  const topHelp = sections.get('--help') ?? '';
  if (inv.command.startsWith('-')) return topHelp.includes(inv.command) ? [] : [`jevris ${inv.command} is not a global option`];
  if (inv.command === 'help') return [];
  const two = inv.subcommands.length > 0 ? `${inv.command} ${inv.subcommands[0]}` : null;
  const name = two !== null && sections.has(two) ? two : inv.command;
  const help = sections.get(name);
  if (help === undefined) return [`jevris ${inv.command} is not a command in docs/cli.md`];
  const problems = [];
  const subs = name === two ? inv.subcommands.slice(1) : inv.subcommands;
  for (const sub of subs) if (!new RegExp(`\\b${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(help)) problems.push(`jevris ${name} ${sub}: "${sub}" is not in its help text`);
  for (const flag of inv.flags) {
    if (['--help', '--home', '--json', '--version'].includes(flag)) continue;
    if (!help.includes(flag)) problems.push(`jevris ${name} ${flag}: the flag is not in its help text`);
  }
  return problems;
}

/** Relative markdown links that do not resolve to a file. */
export function brokenLinks(file, text, base = root) {
  const out = [];
  let fence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const path = decodeURIComponent(target.split('#')[0]);
      if (path.length === 0) continue;
      const full = resolve(dirname(file), path);
      if (!full.startsWith(base) || !existsSync(full)) out.push({ line: index + 1, target });
    }
  });
  return out;
}

test('user docs make no stale claim: private, old Node range, v1.0 only, npx jevris (UDOC-09)', () => {
  const found = [];
  for (const file of userPages()) {
    for (const hit of staleClaims(readFileSync(file, 'utf8'))) found.push(`${rel(file)}:${hit.line} ${hit.id}`);
  }
  assert.deepEqual(found, []);
});

test('every jevris command, subcommand and flag in the docs is in the CLI reference (UDOC-08, UDOC-09)', () => {
  const sections = cliSections(readFileSync(join(root, 'docs', 'cli.md'), 'utf8'));
  assert.ok(sections.size > 10, 'docs/cli.md has the generated command sections');
  const found = [];
  for (const file of userPages()) {
    if (rel(file) === 'docs/cli.md' || rel(file) === 'CHANGELOG.md') continue;
    for (const fragment of codeFragments(readFileSync(file, 'utf8'))) {
      for (const inv of invocations(fragment.code)) {
        for (const problem of invocationProblems(inv, sections)) found.push(`${rel(file)}:${fragment.line} ${problem}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

function walkSkillFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSkillFiles(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

test('every jevris command, subcommand and flag a skill tells the model or user to run is in the CLI reference (JEV-0032, JEV-0033)', () => {
  const sections = cliSections(readFileSync(join(root, 'docs', 'cli.md'), 'utf8'));
  assert.ok(sections.size > 10, 'docs/cli.md has the generated command sections');
  const found = [];
  let mentions = 0;
  for (const file of walkSkillFiles(join(root, 'plugins', 'shared', 'skills'))) {
    for (const fragment of codeFragments(readFileSync(file, 'utf8'))) {
      for (const inv of invocations(fragment.code)) {
        mentions += 1;
        for (const problem of invocationProblems(inv, sections)) found.push(`${rel(file)}:${fragment.line} ${problem}`);
      }
    }
  }
  assert.ok(mentions >= 3, `the skills mention too few jevris commands to check (${String(mentions)})`);
  assert.deepEqual(found, []);
});

test('every relative link in the docs resolves (UDOC-09)', () => {
  const found = [];
  for (const file of userPages()) {
    for (const hit of brokenLinks(file, readFileSync(file, 'utf8'))) found.push(`${rel(file)}:${hit.line} ${hit.target}`);
  }
  assert.deepEqual(found, []);
});

test('installation.md names the plugin sources the package ships and the entries install points at (UDOC-02, DRY)', async () => {
  const { PLUGIN_FILES } = await import('../scripts/release-policy.mjs');
  const { RUNTIME_ENTRIES } = await import('../scripts/bundle.mjs');
  const text = readFileSync(join(root, 'docs', 'installation.md'), 'utf8');
  for (const [named, holds] of [
    ['`plugins/claude`', PLUGIN_FILES.some((path) => path.startsWith('plugins/claude/'))],
    ['`hooks/hooks.json`', PLUGIN_FILES.includes('plugins/claude/hooks/hooks.json')],
    ['`.mcp.json`', PLUGIN_FILES.includes('plugins/claude/.mcp.json')],
    ['`.claude-plugin/plugin.json`', PLUGIN_FILES.includes('plugins/claude/.claude-plugin/plugin.json')],
    ['`plugins/shared/skills`', existsSync(join(root, 'plugins', 'shared', 'skills'))],
    ['`plugins/shared/mcp.js`', RUNTIME_ENTRIES.mcp === 'plugins/shared/mcp.js'],
    ['`dist/hook.mjs`', RUNTIME_ENTRIES.hook === 'dist/hook.mjs'],
  ]) {
    assert.equal(text.includes(named), true, `installation.md does not name ${named}`);
    assert.equal(holds, true, `installation.md names ${named}, which the package does not ship`);
  }
  for (const retired of ['`bin/hook.js`', '`bin/mcp.js`', 'plugins/claude/skills', 'plugins/claude/bin']) {
    assert.equal(text.includes(retired), false, `installation.md names ${retired}, which install renders instead of shipping`);
  }
});

test('every supported harness has a user guide, linked from installation.md (UDOC-03)', async () => {
  const { HARNESS_MANIFESTS } = await import('../scripts/release-policy.mjs');
  const guides = { claude: 'claude-code', codex: 'codex', kilocode: 'kilocode', opencode: 'opencode', antigravity: 'antigravity' };
  const installation = readFileSync(join(root, 'docs', 'installation.md'), 'utf8');
  assert.deepEqual(Object.keys(guides).sort(), Object.keys(HARNESS_MANIFESTS).sort(), 'a harness has no guide name');
  for (const name of [...Object.values(guides), 'parity-matrix']) {
    const page = join(root, 'docs', 'harnesses', `${name}.md`);
    assert.equal(existsSync(page), true, `docs/harnesses/${name}.md is missing`);
    assert.equal(installation.includes(`(harnesses/${name}.md)`), true, `installation.md does not link harnesses/${name}.md`);
  }
  for (const name of Object.values(guides)) {
    const text = readFileSync(join(root, 'docs', 'harnesses', `${name}.md`), 'utf8');
    for (const section of [/^## Install/m, /uninstall/i, /doctor/, /certify/]) assert.match(text, section, `docs/harnesses/${name}.md lacks ${section}`);
  }
});

test('the doc checks catch what they are for (UDOC-09)', () => {
  assert.deepEqual(staleClaims('This repository is private and is not an npm package.').map((hit) => hit.id), ['private-package']);
  assert.deepEqual(staleClaims('- Node.js **22** or **24**').map((hit) => hit.id), ['old-node-range']);
  assert.deepEqual(staleClaims('npx jevris install --home "$HOME"').map((hit) => hit.id), ['unscoped-npx']);
  assert.deepEqual(staleClaims('npx @webventures/jevris install; owner-only private files'), []);
  const sections = cliSections('## jevris --help\n\n  --version\n\n## jevris install\n\nUsage: jevris install [--harness <name>] [--yes]\n\n## jevris data delete\n\nUsage: jevris data delete\n');
  const check = (code) => invocations(code).flatMap((inv) => invocationProblems(inv, sections));
  assert.deepEqual(check('npx @webventures/jevris install --yes'), []);
  assert.deepEqual(check('jevris install --harness claude --dry-run'), ['jevris install --dry-run: the flag is not in its help text']);
  assert.deepEqual(check('jevris data delete'), []);
  assert.deepEqual(check('jevris evidence get <handle>'), ['jevris evidence is not a command in docs/cli.md']);
  assert.deepEqual(check('jevris install banana'), ['jevris install banana: "banana" is not in its help text']);
  assert.deepEqual(check('jevris install [--harness <name>] [--dry-run]'), ['jevris install --dry-run: the flag is not in its help text']);
  assert.deepEqual(check('jevris install a+b'), ['jevris install a+b: "a+b" is not in its help text']);
  assert.deepEqual(check('jevris --version'), []);
  assert.deepEqual(check('~/.config/jevris'), []);
  assert.deepEqual(codeFragments('run `jevris x`\n```sh\njevris y   # comment jevris z\n```\n```text\njevris needs Node\n```').map((f) => f.code.trim()), ['jevris x', 'jevris y']);
  assert.deepEqual(check("sh -c 'unlock; jevris data delete'"), []);
});
