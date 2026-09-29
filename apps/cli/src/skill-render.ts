/**
 * The one skill renderer (SKL-01, SKL-02, DRY plugin rule): plugins/shared/skills is the only
 * committed skill source, and this module turns it into each harness's tree. The installer
 * calls it at install time; scripts/emit-hook.mjs calls it at build time to check the sources.
 *
 * Every per-harness value comes from the harness's declarative manifest
 * (plugins/<harness>/harness.json, its `skills` section), never from a constant here:
 *
 * - `namespace`: prefixed to both the folder and the frontmatter name ('' or 'jevris-');
 * - `allowedToolsPrefix`: the harness's name for the Jevris MCP tools in allowed-tools, or
 *   null when the harness ignores allowed-tools (then no tool field ships);
 * - `userInvocationField`: the frontmatter switch that makes a user-invoked skill user-only,
 *   or null when the harness has none.
 *
 * A skill's reference.md is copied as is. The source-only fields (tools, invocation) never
 * ship. Pure functions over text, plus bounded file readers; no network, no process.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How one harness takes skills, from its manifest. */
export interface SkillProfile {
  /**
   * The skills folder: home-relative with forward slashes, optionally starting with a location
   * token the installer resolves ($CONFIG, $CODEX_HOME). The renderer itself does not use it.
   */
  readonly dir: string;
  readonly namespace: string;
  readonly allowedToolsPrefix: string | null;
  readonly userInvocationField: string | null;
  /**
   * A file beside SKILL.md that makes a user-invoked skill user-only, for a harness that reads
   * it there instead of a frontmatter field (Codex: `agents/openai.yaml` with
   * `policy.allow_implicit_invocation: false`, developers.openai.com/codex/skills), or null.
   */
  readonly userOnlyPolicyFile: string | null;
}

/** The body of a user-only policy file (Codex's agents/openai.yaml). */
export const USER_ONLY_POLICY = 'policy:\n  allow_implicit_invocation: false\n';

export interface SkillSource {
  readonly name: string;
  readonly description: string;
  /** The skill's Jevris MCP tools (`jevris_*`). */
  readonly tools: readonly string[];
  readonly invocation: 'model' | 'user';
  readonly body: string;
}

export interface SkillEntry {
  readonly skill: SkillSource;
  /** reference.md, when the skill has one. */
  readonly reference: string | null;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL = /^jevris_[a-z_]+$/;
const SOURCE_CAP = 65_536;
const MAX_SKILLS = 32;

/** Parses one source SKILL.md: name, description, tools, invocation, then the body. */
export function parseSkillSource(text: string, where = 'skill'): SkillSource {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (match === null) throw new Error(`${where} has no frontmatter`);
  const fields: { [key: string]: string } = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) throw new Error(`${where} has a malformed frontmatter line`);
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const name = fields['name'] ?? '';
  const description = fields['description'] ?? '';
  const invocation = fields['invocation'];
  const tools = (fields['tools'] ?? '').split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  if (!NAME.test(name)) throw new Error(`${where} has an invalid name`);
  if (description.length === 0) throw new Error(`${where} has no description`);
  if (invocation !== 'model' && invocation !== 'user') throw new Error(`${where} invocation must be model or user`);
  for (const tool of tools) if (!TOOL.test(tool)) throw new Error(`${where} names a non-Jevris tool ${tool.slice(0, 40)}`);
  return { name, description, tools, invocation, body: match[2] ?? '' };
}

const NAMESPACE = /^(?:|[a-z][a-z0-9]{0,15}-)$/;
const TOOL_PREFIX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD = /^[a-z][a-z0-9-]{0,63}$/;
const POLICY_FILE = /^[a-z][a-z0-9_-]{0,31}(?:\/[a-z][a-z0-9_-]{0,31}){0,2}\.yaml$/;
/** Home-relative, forward slashes, optionally starting with a location token ($CONFIG, $CODEX_HOME). */
const DIR = /^(?:\$[A-Z][A-Z_]{0,31}\/)?[A-Za-z0-9._-]{1,64}(?:\/[A-Za-z0-9._-]{1,64}){0,11}$/;
const MANIFEST_CAP = 65_536;

/** Validates a manifest's `skills` section; throws when it is missing or malformed. */
export function skillProfile(manifest: unknown, where = 'harness manifest'): SkillProfile {
  const skills = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? (manifest as { skills?: unknown }).skills : undefined;
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) throw new Error(`${where} has no skills section`);
  const s = skills as { [key: string]: unknown };
  const { dir, namespace, allowedToolsPrefix, userInvocationField } = s;
  const userOnlyPolicyFile = s['userOnlyPolicyFile'] ?? null;
  if (typeof dir !== 'string' || !DIR.test(dir) || dir.split('/').some((part) => part === '..' || part === '.')) throw new Error(`${where} skills.dir must be a plain relative folder`);
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) throw new Error(`${where} skills.namespace must be empty or a short lower-case prefix ending in -`);
  if (allowedToolsPrefix !== null && (typeof allowedToolsPrefix !== 'string' || !TOOL_PREFIX.test(allowedToolsPrefix))) throw new Error(`${where} skills.allowedToolsPrefix must be null or a tool-name prefix`);
  if (userInvocationField !== null && (typeof userInvocationField !== 'string' || !FIELD.test(userInvocationField))) throw new Error(`${where} skills.userInvocationField must be null or a frontmatter field name`);
  if (userOnlyPolicyFile !== null && (typeof userOnlyPolicyFile !== 'string' || !POLICY_FILE.test(userOnlyPolicyFile))) throw new Error(`${where} skills.userOnlyPolicyFile must be null or a relative .yaml file`);
  return { dir, namespace, allowedToolsPrefix, userInvocationField, userOnlyPolicyFile };
}

/** Reads `<pluginDir>/harness.json` and returns its skill profile. */
export async function readSkillProfile(pluginDir: string): Promise<SkillProfile> {
  const path = join(pluginDir, 'harness.json');
  const text = await readBounded(path, MANIFEST_CAP);
  if (text === null) throw new Error(`${path} is missing`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  return skillProfile(manifest, path);
}

/** The folder a skill is installed under. */
export function skillFolder(name: string, profile: SkillProfile): string {
  return `${profile.namespace}${name}`;
}

/** One SKILL.md for one harness. */
export function renderSkill(skill: SkillSource, profile: SkillProfile): string {
  const lines = ['---', `name: ${skillFolder(skill.name, profile)}`, `description: ${skill.description}`];
  if (profile.allowedToolsPrefix !== null && skill.tools.length > 0) lines.push(`allowed-tools: ${skill.tools.map((tool) => `${profile.allowedToolsPrefix ?? ''}${tool}`).join(', ')}`);
  if (profile.userInvocationField !== null && skill.invocation === 'user') lines.push(`${profile.userInvocationField}: true`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${skill.body}`;
}

/**
 * Checks one skill against its reference file: the body mentions reference.md exactly when
 * the skill has one.
 */
export function skillEntry(name: string, skillText: string, reference: string | null, where = `skill ${name}`): SkillEntry {
  const skill = parseSkillSource(skillText, where);
  if (skill.name !== name) throw new Error(`${where} is named ${skill.name}`);
  if (skill.body.includes('reference.md') !== (reference !== null)) throw new Error(`${where} mentions reference.md only if it has one`);
  return { skill, reference };
}

/** Reads and checks every skill under the shared source folder, sorted by name. */
export async function readSkillSources(dir: string): Promise<readonly SkillEntry[]> {
  // A folder without a SKILL.md (or a stray file) is not a skill.
  const names = (await readdir(dir)).filter((name) => NAME.test(name)).sort();
  if (names.length > MAX_SKILLS) throw new Error(`the skill source has more than ${MAX_SKILLS} skills`);
  const out: SkillEntry[] = [];
  for (const name of names) {
    const skillText = await readBounded(join(dir, name, 'SKILL.md'), SOURCE_CAP);
    if (skillText === null) continue;
    out.push(skillEntry(name, skillText, await readBounded(join(dir, name, 'reference.md'), SOURCE_CAP), `skill ${name}`));
  }
  return out;
}

async function readBounded(path: string, cap: number): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return null;
  }
  if (bytes.byteLength > cap) throw new Error(`${path} is larger than ${cap} bytes`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * A harness's whole skill tree: `<folder>/SKILL.md`, `<folder>/reference.md` and, for a
 * user-invoked skill on a harness with a policy file, that file; relative to the harness's
 * skills folder, in a stable order.
 */
export function renderSkillTree(entries: readonly SkillEntry[], profile: SkillProfile): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const { skill, reference } of entries) {
    const folder = skillFolder(skill.name, profile);
    out.set(`${folder}/SKILL.md`, renderSkill(skill, profile)); // path-hygiene: allow package-relative forward-slash path
    if (reference !== null) out.set(`${folder}/reference.md`, reference); // path-hygiene: allow package-relative forward-slash path
    if (profile.userOnlyPolicyFile !== null && skill.invocation === 'user') out.set(`${folder}/${profile.userOnlyPolicyFile}`, USER_ONLY_POLICY); // path-hygiene: allow package-relative forward-slash path
  }
  return out;
}
