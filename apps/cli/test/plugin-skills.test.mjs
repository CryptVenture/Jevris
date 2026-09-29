import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { shortlistInstalledSkills } from '@jevris/core';
import { PUBLIC_COMMAND_NAMES } from '@jevris/contracts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const { TOOLS } = await import('../../../packages/mcp/dist/tools.js');
const { readSkillProfile, readSkillSources, renderSkillTree, skillFolder } = await import('../dist/skill-render.js');

/**
 * Each harness's skill tree, rendered in memory from the one committed source,
 * plugins/shared/skills, by the renderer the installer uses, with each harness's own manifest
 * (SKL-02). Keys are `<folder>/<file>`.
 */
const ENTRIES = await readSkillSources(join(repoRoot, 'plugins', 'shared', 'skills'));
const HARNESSES = ['claude', 'codex', 'kilocode', 'opencode', 'antigravity'];
const PROFILES = Object.fromEntries(await Promise.all(HARNESSES.map(async (harness) => [harness, await readSkillProfile(join(repoRoot, 'plugins', harness))])));
const TREES = Object.fromEntries(HARNESSES.map((harness) => [harness, renderSkillTree(ENTRIES, PROFILES[harness])]));
const file = (harness, name, leaf) => TREES[harness].get(`${skillFolder(name, PROFILES[harness])}/${leaf}`);
const SKILL_NAMES = [...PUBLIC_COMMAND_NAMES].sort();
const WITH_REFERENCE = ['checkpoint', 'plan', 'route', 'verify'];

/**
 * SKL-03 invocation rule: a skill is model-invocable only when every tool it may call is
 * read-only or advisory. A skill that writes state (a capsule, a settings change) is
 * user-invoked only (disable-model-invocation: true).
 */
const INVOCATION = {
  status: 'model',
  plan: 'model',
  route: 'model',
  recover: 'model',
  verify: 'model',
  explain: 'model',
  checkpoint: 'user',
  configure: 'user',
};

/**
 * SKL-03 token budget, measured with a deterministic estimator (ceil(chars / 4)) on the
 * Claude tree, which carries the longest frontmatter. Measured at 2026-09-25: largest skill
 * 368, all skills 2462, model-invocable listing 300. The real `claude plugin details` check is
 * the opt-in live smoke.
 */
const BUDGET = { perSkill: 420, total: 2800, listing: 360, description: 250 };
const tokens = (text) => Math.ceil(text.length / 4);

const CLAUDE_PREFIX = 'mcp__plugin_jevris_jevris__';
const catalogueId = /\bC(?:0[1-9]|[1-6]\d|7[0-2])\b/;

function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const fields = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '---') return fields;
    const split = line.indexOf(':');
    if (split <= 0) return null;
    fields.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  return null;
}

function rejectsInjection(text) {
  assert.equal(text.includes('!`'), false, 'no shell interpolation');
  assert.equal(/\bnpx\b/.test(text), false, 'no npx');
  assert.equal(text.includes('$ARGUMENTS'), false, 'no argument interpolation');
  assert.equal(text.includes('permissionDecision'), false);
  assert.equal(text.includes('verified: true'), false);
  assert.equal(catalogueId.test(text), false, 'no capability catalogue ids');
  for (const banned of ['/Users/', '/Volumes/', '/home/runner/']) assert.equal(text.includes(banned), false, banned);
}

test('the eight public skills render for every harness with their reference files and nothing else (SKL-01, SKL-02)', () => {
  for (const harness of HARNESSES) {
    // Codex reads a user-only skill's policy from agents/openai.yaml (G9); no other harness has one.
    const policy = (name) => (harness === 'codex' && INVOCATION[name] === 'user' ? [`${skillFolder(name, PROFILES[harness])}/agents/openai.yaml`] : []);
    const expected = SKILL_NAMES.flatMap((name) => [`${skillFolder(name, PROFILES[harness])}/SKILL.md`, ...(WITH_REFERENCE.includes(name) ? [`${skillFolder(name, PROFILES[harness])}/reference.md`] : []), ...policy(name)]).sort();
    assert.deepEqual([...TREES[harness].keys()].sort(), expected, `${harness}: no scripts, no stray files`);
  }
});

test('each skill states its purpose, evidence, tools, output contract and stop conditions (SKL-01)', async () => {
  const toolNames = new Set(TOOLS.map((tool) => tool.name));
  const effects = new Map(TOOLS.map((tool) => [tool.name, tool.effect]));
  for (const name of SKILL_NAMES) {
    const text = file('claude', name, 'SKILL.md');
    const fields = frontmatter(text);
    assert.ok(fields, name);
    assert.equal(fields.get('name'), name);
    for (const heading of ['Purpose:', 'Required evidence:', 'Output contract:', 'Stop when:']) assert.equal(text.includes(heading), true, `${name}: ${heading}`);
    rejectsInjection(text);

    // allowed-tools names only real Jevris MCP tools, qualified the way Claude names plugin tools.
    const allowed = fields.get('allowed-tools').split(',').map((tool) => tool.trim());
    assert.equal(allowed.length > 0, true, name);
    for (const qualified of allowed) {
      assert.equal(qualified.startsWith(CLAUDE_PREFIX), true, qualified);
      const tool = qualified.slice(CLAUDE_PREFIX.length);
      assert.equal(toolNames.has(tool), true, `${name}: ${tool} is an MCP tool`);
      assert.equal(text.includes(`\`${tool}\``), true, `${name} tells the model when to call ${tool}`);
    }

    // The invocation rule, checked against the tools' effect classes.
    const writes = allowed.some((qualified) => !['read', 'advise'].includes(effects.get(qualified.slice(CLAUDE_PREFIX.length))));
    assert.equal(INVOCATION[name], writes || name === 'configure' ? 'user' : 'model', `${name} classification`);
    assert.equal(fields.get('disable-model-invocation') === 'true', INVOCATION[name] === 'user', `${name} invocation`);
  }
});

test('the other harnesses get the same body with only portable frontmatter and the jevris- namespace (SKL-02)', () => {
  for (const name of SKILL_NAMES) {
    const claude = file('claude', name, 'SKILL.md');
    const body = claude.slice(claude.indexOf('\n---\n', 4) + 5);
    for (const harness of HARNESSES.filter((h) => h !== 'claude')) {
      const text = file(harness, name, 'SKILL.md');
      const fields = frontmatter(text);
      assert.deepEqual([...fields.keys()], ['name', 'description'], `${harness}/${name}: harnesses that ignore allowed-tools get none`);
      assert.equal(fields.get('name'), `jevris-${name}`, 'folder and name carry the jevris- namespace');
      assert.equal(text.endsWith(body), true, `${harness}/${name} body`);
    }
    const reference = file('claude', name, 'reference.md');
    assert.equal(reference !== undefined, WITH_REFERENCE.includes(name), `${name} reference`);
    if (reference !== undefined) {
      rejectsInjection(reference);
      for (const harness of HARNESSES) assert.equal(file(harness, name, 'reference.md'), reference);
    }
  }
});

test('the skills stay under the recorded token budget (SKL-03)', async () => {
  let total = 0;
  let listing = 0;
  for (const name of SKILL_NAMES) {
    const text = file('claude', name, 'SKILL.md');
    const description = frontmatter(text).get('description');
    assert.equal(description.length <= BUDGET.description, true, `${name} description is ${description.length} characters`);
    assert.equal(tokens(text) <= BUDGET.perSkill, true, `${name} is ${tokens(text)} tokens`);
    total += tokens(text);
    if (INVOCATION[name] === 'model') listing += tokens(`${name}: ${description}`);
  }
  assert.equal(total <= BUDGET.total, true, `all skills are ${total} tokens`);
  assert.equal(listing <= BUDGET.listing, true, `the model-invocable listing is ${listing} tokens`);
});

test('ranking the skill directories stays executed false', async (t) => {
  // PKG-02: a selected id is data. It is not a module to import. The Claude tree is written
  // to a temp folder, as the installer would lay it out.
  const root = mkdtempSync(join(tmpdir(), 'jevris-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of TREES.claude) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const directories = async (dir) => (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  let imported = 0;
  const seenRoots = [];
  const skills = await shortlistInstalledSkills({
    roots: [root],
    intent: 'status checkpoint route',
    requestedIds: ['not-a-skill'],
    reader: {
      async listDirectories(dir) {
        seenRoots.push(dir);
        assert.equal(dir, root);
        return directories(dir);
      },
      async readSkillMarkdown(dir, directoryName) {
        assert.equal(dir, root);
        assert.equal(directoryName === 'not-a-skill', false);
        return readFile(join(dir, directoryName, 'SKILL.md'));
      },
    },
    load() {
      imported += 1;
      throw new Error('ranking must not import skill code');
    },
  });
  assert.equal(skills.executed, false);
  assert.deepEqual(skills.unknownRejected, ['not-a-skill']);
  assert.equal(imported, 0);
  assert.deepEqual(skills.inventory.map((entry) => entry.id).sort(), SKILL_NAMES);
  assert.deepEqual(seenRoots, [root]);
});
