/**
 * The per-harness install manifest, plugins/<harness>/harness.json (DRY plugin rule). Each
 * supported harness keeps its own folder with this one declarative file; the installer reads
 * where that harness wants its plugin, skills and MCP entry from it, renders the shared
 * sources (plugins/shared: skills, mcp.js, shim.js) into those places, and doctor reads the
 * `unsupported` reasons as the harness's parity line. No manifest holds copied code.
 *
 * Paths are home-relative with forward slashes. A leading `$CONFIG/` is the XDG config folder
 * (default `.config`) and a leading `$CODEX_HOME/` is Codex's home (default `.codex`), both
 * resolved by the installer inside the target home.
 */
import type { GlobalHarness } from './global-harness.js';
import { COMPATIBILITY_RULES, type CompatibilityRule } from './harness-versions.js';

export interface HarnessSkills {
  readonly dir: string;
  readonly namespace: string;
  readonly allowedToolsPrefix: string | null;
  readonly userInvocationField: string | null;
  /** Codex: the file beside SKILL.md that makes a user-invoked skill user-only (skill-render.ts). */
  readonly userOnlyPolicyFile?: string | null;
}

export interface HarnessMcp {
  readonly dir: string;
  readonly file: string;
  readonly key: readonly string[];
  readonly schema: string | null;
  /** The MCP server entry; the string `$MCP` stands for the runtime MCP server path. */
  readonly entry: unknown;
}

export interface HarnessManifest {
  readonly harness: GlobalHarness;
  readonly launcher: string;
  readonly displayName: string;
  readonly plugin: { readonly path: string; readonly template?: string; readonly export?: 'default' | 'named'; readonly [key: string]: unknown };
  readonly mcp?: HarnessMcp;
  readonly skills: HarnessSkills;
  readonly hooks: readonly string[];
  readonly events?: readonly string[];
  readonly features: readonly string[];
  readonly unsupported: Readonly<Record<string, string>>;
  /** How far a certification carries past the verified version, and why (release notes). */
  readonly compatibility?: { readonly rule: CompatibilityRule; readonly basis: string };
}

export const MCP_TOKEN = '$MCP';
const REL_PATH = /^(?:\$CONFIG\/|\$CODEX_HOME\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const SHIM_HARNESSES = new Set(['kilocode', 'opencode']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function relPath(value: unknown): value is string {
  return typeof value === 'string' && REL_PATH.test(value) && !value.split('/').includes('..');
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Parses and checks one manifest; the reason names the first problem. */
export function parseHarnessManifest(text: string, harness: GlobalHarness): { readonly manifest: HarnessManifest | null; readonly problem: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { manifest: null, problem: 'not JSON' };
  }
  const bad = (problem: string): { manifest: null; problem: string } => ({ manifest: null, problem });
  if (!isObject(parsed)) return bad('not an object');
  if (parsed['harness'] !== harness) return bad(`harness is not ${harness}`);
  if (typeof parsed['launcher'] !== 'string' || !/^[a-z]+$/.test(parsed['launcher'])) return bad('launcher');
  if (typeof parsed['displayName'] !== 'string' || parsed['displayName'].length === 0) return bad('displayName');
  const plugin = parsed['plugin'];
  if (!isObject(plugin) || !relPath(plugin['path'])) return bad('plugin.path');
  const skills = parsed['skills'];
  if (!isObject(skills) || !relPath(skills['dir']) || typeof skills['namespace'] !== 'string' || !nullableString(skills['allowedToolsPrefix']) || !nullableString(skills['userInvocationField']) || !(skills['userOnlyPolicyFile'] === undefined || nullableString(skills['userOnlyPolicyFile']))) return bad('skills');
  if (!strings(parsed['hooks']) || !strings(parsed['features'])) return bad('hooks or features');
  const unsupported = parsed['unsupported'];
  if (!isObject(unsupported) || !Object.values(unsupported).every((reason) => typeof reason === 'string' && reason.length > 0)) return bad('unsupported');
  const compatibility = parsed['compatibility'];
  if (compatibility !== undefined && (!isObject(compatibility) || !(COMPATIBILITY_RULES as readonly unknown[]).includes(compatibility['rule']) || typeof compatibility['basis'] !== 'string' || compatibility['basis'].length === 0)) return bad('compatibility');
  if (SHIM_HARNESSES.has(harness)) {
    if (plugin['export'] !== 'default' && plugin['export'] !== 'named') return bad('plugin.export');
    if (plugin['template'] !== 'plugins/shared/shim.js') return bad('plugin.template');
    const mcp = parsed['mcp'];
    if (!isObject(mcp) || !relPath(mcp['dir']) || typeof mcp['file'] !== 'string' || !/^[a-z]+$/.test(mcp['file']) || !strings(mcp['key']) || mcp['key'].length === 0 || !nullableString(mcp['schema']) || !isObject(mcp['entry'])) return bad('mcp');
    if (!JSON.stringify(mcp['entry']).includes(JSON.stringify(MCP_TOKEN))) return bad('mcp.entry names no $MCP');
    if (!strings(parsed['events'])) return bad('events');
  }
  return { manifest: parsed as unknown as HarnessManifest, problem: null };
}

/** Replaces every `$MCP` string in the manifest's MCP entry with the runtime MCP path. */
export function mcpEntry(entry: unknown, mcpPath: string): unknown {
  if (entry === MCP_TOKEN) return mcpPath;
  if (Array.isArray(entry)) return entry.map((item) => mcpEntry(item, mcpPath));
  if (isObject(entry)) return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, mcpEntry(value, mcpPath)]));
  return entry;
}
