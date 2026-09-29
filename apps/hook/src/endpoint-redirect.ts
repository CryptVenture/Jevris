/**
 * Guard 6 for interactive sessions (design `.planning/research/access-limits.md` 5.5, OP-12): an
 * access signal from a session whose provider endpoint is not the provider's own names no known
 * party, so the launcher sends none.
 *
 * - Claude Code: a base-URL override or a cloud-provider switch (CLAUDE_REDIRECT_VAR) in the
 *   hook's environment (the session's, which carries user and managed settings' `env`), or a
 *   workspace `.claude/settings.json` or `settings.local.json` that sets one in `env` or supplies a
 *   key through `apiKeyHelper`.
 * - Kilo and OpenCode: a project config from the workspace up to its git root that defines the
 *   provider (T-R6's check, `projectConfigGuard`, which also refuses a linked Kilo worktree). The
 *   user's global config is trusted, as T-R6 trusts it (B's LOW 27: a global redefinition is the
 *   user's own proxy, and a wrong pause from it fails toward pausing).
 *
 * - Antigravity: no custom endpoint exists, so a `google` signal is never redirected; any other
 *   provider is.
 *
 * Any doubt (a settings file that is not a small regular JSON file, no workspace) counts as
 * redirected. Only failure events reach here, so the reads are off the common path.
 */
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nodeConfigHost, projectConfigGuard } from '@jevris/adapter-kilocode';
import type { LauncherName } from '@jevris/contracts';

/**
 * Variables that send Claude Code's model requests to another party or endpoint (Claude Code's
 * environment-variable reference, read 2026-09-28): any `ANTHROPIC_*BASE_URL` (the API, Bedrock,
 * Bedrock Mantle, Vertex, Foundry, Claude Platform on AWS), a cloud-provider switch
 * (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, and any later Mantle or AWS one), and the
 * Foundry resource and AWS workspace that select one (B's LOW 28).
 */
const CLAUDE_REDIRECT_VAR = /^(?:ANTHROPIC_(?:[A-Z0-9]+_)*BASE_URL|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE|AWS)[A-Z0-9_]*|ANTHROPIC_FOUNDRY_RESOURCE|ANTHROPIC_AWS_WORKSPACE_ID)$/;
const SETTINGS_CAP = 65_536;

type Rec = { readonly [key: string]: unknown };
const rec = (value: unknown): Rec | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined);

async function claudeRedirected(workspace: string, env: { readonly [key: string]: string | undefined }): Promise<boolean> {
  if (Object.keys(env).some((name) => CLAUDE_REDIRECT_VAR.test(name) && (env[name] ?? '') !== '')) return true;
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = join(workspace, '.claude', name);
    const info = await lstat(file).catch(() => null);
    if (info === null) continue;
    if (!info.isFile() || info.size > SETTINGS_CAP) return true;
    const settings = rec(await readFile(file, 'utf8').then((raw) => JSON.parse(raw) as unknown).catch(() => undefined));
    if (settings === undefined || settings['apiKeyHelper'] !== undefined) return true;
    const vars = rec(settings['env']);
    if (vars !== undefined && Object.keys(vars).some((key) => CLAUDE_REDIRECT_VAR.test(key) && vars[key] !== undefined && vars[key] !== '')) return true;
  }
  return false;
}

/** The nearest folder at or above `dir` that holds `.git` (a folder or a file), else `dir`. */
async function gitRoot(dir: string): Promise<string> {
  for (let level = dir, i = 0; i < 64; i += 1) {
    if ((await lstat(join(level, '.git')).catch(() => null)) !== null) return level;
    const up = dirname(level);
    if (up === level) break;
    level = up;
  }
  return dir;
}

/** Whether the session's endpoint for `provider` is redirected (see the module comment). */
export async function endpointRedirected(harness: LauncherName, provider: string, workspace: string | undefined, env: { readonly [key: string]: string | undefined }): Promise<boolean> {
  if (harness === 'agy') return provider !== 'google';
  if (workspace === undefined) return true;
  try {
    if (harness === 'claude') return provider !== 'anthropic' || (await claudeRedirected(workspace, env));
    if (harness !== 'kilo' && harness !== 'opencode') return true;
    const allows = projectConfigGuard(harness === 'kilo' ? 'kilocode' : 'opencode', { directory: workspace, worktree: await gitRoot(workspace) }, nodeConfigHost);
    return !(await allows(provider));
  } catch {
    return true;
  }
}
