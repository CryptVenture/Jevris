// The one skill renderer (SKL-01, SKL-02, DRY plugin rule): plugins/shared/skills rendered for
// each harness from that harness's own manifest, the same way at build and at install time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { parseSkillSource, readSkillProfile, readSkillSources, renderSkill, renderSkillTree, skillEntry, skillFolder, skillProfile, USER_ONLY_POLICY } = await import('../dist/skill-render.js');
const { PUBLIC_COMMAND_NAMES } = await import('../../../packages/contracts/dist/index.js');

const PLUGINS = join(import.meta.dirname, '..', '..', '..', 'plugins');
/** Every harness keeps plugins/<harness>/ with its declarative manifest. */
const HARNESSES = ['claude', 'codex', 'kilocode', 'opencode', 'antigravity'];

test('every harness manifest declares how it takes skills, and the shared source renders for all five', async () => {
  const entries = await readSkillSources(join(PLUGINS, 'shared', 'skills'));
  assert.deepEqual(entries.map((e) => e.skill.name), [...PUBLIC_COMMAND_NAMES].sort());
  for (const harness of HARNESSES) {
    const profile = await readSkillProfile(join(PLUGINS, harness));
    const tree = renderSkillTree(entries, profile);
    const folders = [...new Set([...tree.keys()].map((rel) => rel.split('/')[0]))].sort();
    assert.deepEqual(folders, [...PUBLIC_COMMAND_NAMES].map((name) => `${profile.namespace}${name}`).sort(), harness);
    for (const { skill, reference } of entries) {
      const text = tree.get(`${skillFolder(skill.name, profile)}/SKILL.md`);
      const front = text.split('\n---\n')[0];
      assert.match(text, new RegExp(`^---\\nname: ${skillFolder(skill.name, profile)}\\ndescription: `), `${harness} ${skill.name}`);
      assert.equal(/^(tools|invocation):/m.test(front), false, 'source-only fields never ship');
      assert.equal(/^allowed-tools:/m.test(front), profile.allowedToolsPrefix !== null && skill.tools.length > 0, `${harness} ${skill.name} allowed-tools`);
      assert.equal(tree.get(`${skillFolder(skill.name, profile)}/reference.md`) ?? null, reference);
    }
  }
  // The manifests carry the per-harness differences the renderer used to hard-code.
  const claude = await readSkillProfile(join(PLUGINS, 'claude'));
  assert.equal(claude.namespace, '');
  assert.equal(claude.allowedToolsPrefix, 'mcp__plugin_jevris_jevris__');
  assert.equal(claude.userInvocationField, 'disable-model-invocation');
  for (const harness of HARNESSES.filter((h) => h !== 'claude')) {
    const profile = await readSkillProfile(join(PLUGINS, harness));
    assert.deepEqual([profile.namespace, profile.allowedToolsPrefix, profile.userInvocationField], ['jevris-', null, null], harness);
    assert.equal(profile.userOnlyPolicyFile, harness === 'codex' ? 'agents/openai.yaml' : null, harness);
  }
});

test('Codex user-only skills (G9): checkpoint and configure get agents/openai.yaml with allow_implicit_invocation false, and no other skill does', async () => {
  const entries = await readSkillSources(join(PLUGINS, 'shared', 'skills'));
  const codex = renderSkillTree(entries, await readSkillProfile(join(PLUGINS, 'codex')));
  const policies = [...codex.keys()].filter((key) => key.endsWith('/agents/openai.yaml')).sort();
  assert.deepEqual(policies, ['jevris-checkpoint/agents/openai.yaml', 'jevris-configure/agents/openai.yaml']);
  for (const key of policies) assert.equal(codex.get(key), USER_ONLY_POLICY);
  assert.equal(USER_ONLY_POLICY, 'policy:\n  allow_implicit_invocation: false\n');
  for (const harness of HARNESSES.filter((h) => h !== 'codex')) {
    const tree = renderSkillTree(entries, await readSkillProfile(join(PLUGINS, harness)));
    assert.equal([...tree.keys()].some((key) => key.includes('/agents/')), false, harness);
  }
});

test('a profile decides the frontmatter: qualified tools and user invocation, or name and description only', () => {
  const skill = parseSkillSource('---\nname: checkpoint\ndescription: Save a capsule.\ntools: jevris_checkpoint\ninvocation: user\n---\n\nBody.\n');
  const claudeLike = skillProfile({ skills: { dir: 'skills', namespace: '', allowedToolsPrefix: 'mcp__plugin_jevris_jevris__', userInvocationField: 'disable-model-invocation' } });
  const portable = skillProfile({ skills: { dir: 'skills', namespace: 'jevris-', allowedToolsPrefix: null, userInvocationField: null } });
  assert.equal(renderSkill(skill, claudeLike), '---\nname: checkpoint\ndescription: Save a capsule.\nallowed-tools: mcp__plugin_jevris_jevris__jevris_checkpoint\ndisable-model-invocation: true\n---\n\nBody.\n');
  assert.equal(renderSkill(skill, portable), '---\nname: jevris-checkpoint\ndescription: Save a capsule.\n---\n\nBody.\n');
  assert.equal(skillFolder('checkpoint', portable), 'jevris-checkpoint');
});

test('a malformed manifest or source is refused, never rendered', () => {
  const good = { dir: 'skills', namespace: 'jevris-', allowedToolsPrefix: null, userInvocationField: null };
  assert.throws(() => skillProfile({}), /no skills section/);
  assert.throws(() => skillProfile({ skills: { ...good, dir: '../skills' } }), /plain relative folder/);
  assert.throws(() => skillProfile({ skills: { ...good, dir: '/abs' } }), /plain relative folder/);
  assert.throws(() => skillProfile({ skills: { ...good, dir: '$CONFIG/../x' } }), /plain relative folder/);
  assert.equal(skillProfile({ skills: { ...good, dir: '$CONFIG/kilo/skills' } }).dir, '$CONFIG/kilo/skills');
  assert.throws(() => skillProfile({ skills: { ...good, namespace: 'Jevris' } }), /namespace/);
  assert.throws(() => skillProfile({ skills: { ...good, allowedToolsPrefix: 'mcp:bad' } }), /allowedToolsPrefix/);
  assert.throws(() => skillProfile({ skills: { ...good, userInvocationField: 'Bad Field' } }), /userInvocationField/);
  assert.throws(() => skillProfile({ skills: { ...good, userOnlyPolicyFile: '../agents/openai.yaml' } }), /userOnlyPolicyFile/);
  assert.throws(() => skillProfile({ skills: { ...good, userOnlyPolicyFile: 'agents/openai.json' } }), /userOnlyPolicyFile/);
  assert.equal(skillProfile({ skills: good }).userOnlyPolicyFile, null, 'absent means none');
  assert.throws(() => parseSkillSource('no frontmatter'), /no frontmatter/);
  assert.throws(() => parseSkillSource('---\nname: Bad\ndescription: x\ninvocation: model\n---\n'), /invalid name/);
  assert.throws(() => parseSkillSource('---\nname: a\ndescription: x\ninvocation: sometimes\n---\n'), /invocation/);
  assert.throws(() => parseSkillSource('---\nname: a\ndescription: x\ntools: Bash\ninvocation: model\n---\n'), /non-Jevris tool/);
  assert.throws(() => skillEntry('a', '---\nname: b\ndescription: x\ninvocation: model\n---\n', null), /is named b/);
  assert.throws(() => skillEntry('a', '---\nname: a\ndescription: x\ninvocation: model\n---\nSee reference.md.\n', null), /reference\.md/);
});
