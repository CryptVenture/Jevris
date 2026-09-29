/**
 * Where a public command acts: the Jevris home (never chosen by a model) and the workspace.
 *
 * Home: `--home`, else `JEVRIS_HOME`, else the OS home (ADM-01, E-16).
 * Workspace: `--workspace`, else `JEVRIS_WORKSPACE` (set by the MCP server from its roots),
 * else `CLAUDE_PROJECT_DIR`, else the working directory; then the nearest enclosing directory
 * that holds `.git`. The id is the root's identity (device, inode, birth time), the same id the
 * sidecar and the orchestrator use, so the same checkout gets one id from every surface.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { jevrisPaths, pathKey, resolveHome, type EnvLike, type JevrisPaths } from '@jevris/platform';
import type { SidecarClientKind, SurfacePorts } from './ports.js';

export interface SurfaceContext {
  readonly home: string;
  readonly homeSource: 'explicit' | 'JEVRIS_HOME' | 'os';
  readonly paths: JevrisPaths;
  readonly platform: string;
  readonly env: EnvLike;
  readonly workspaceRoot: string | null;
  readonly workspaceId: string;
  /** cli for a person at a terminal, mcp when the MCP server called on a model's behalf. */
  readonly scope: Extract<SidecarClientKind, 'cli' | 'mcp'>;
  readonly ports: SurfacePorts;
  /** Start the sidecar on demand (IPC-13). Off with JEVRIS_SIDECAR_AUTOSTART=0. */
  readonly autostart: boolean;
  readonly sidecarWaitMs: number;
  readonly requestTimeoutMs: number;
  nowMs(): number;
}

export interface ContextInput {
  readonly home?: string | undefined;
  readonly workspace?: string | undefined;
  readonly scope?: 'cli' | 'mcp';
  readonly env?: EnvLike;
  readonly platform?: string;
  readonly cwd?: string;
  readonly ports: SurfacePorts;
  readonly nowMs?: () => number;
}

const MAX_WALK = 64;

function plain(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The nearest directory at or above `start` that holds `.git`, else `start` itself. */
export function workspaceRootFor(start: string): string {
  const base = canonical(start);
  let dir = base;
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return base;
}

/**
 * The one workspace id (IPC-09): the same as @jevris/orchestrator's workspaceIdFor and the
 * sidecar's, so a record written here is found by every surface. The root's device, inode and
 * birth time (read as bigints); a path hash only when the root cannot be read. Inlined, not
 * imported, so the MCP bundle stays free of the orchestrator.
 */
export function workspaceIdFor(root: string | null, platform: string = process.platform): string {
  if (root === null) return 'ws-none';
  try {
    const st = statSync(realpathSync(root), { bigint: true });
    if (st.isDirectory()) return `w${createHash('sha256').update(`${String(st.dev)}:${String(st.ino)}:${String(st.birthtimeNs)}`).digest('hex').slice(0, 24)}`;
  } catch {
    // unreadable root: the path-derived id below
  }
  return `ws-${createHash('sha256').update(pathKey(root, platform)).digest('hex').slice(0, 20)}`;
}

function envText(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return plain(value) ? value : undefined;
}

export function createSurfaceContext(input: ContextInput): SurfaceContext {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const resolved = resolveHome({ ...(plain(input.home) ? { home: input.home } : {}), env, platform });
  const paths = jevrisPaths({ home: resolved.home, env, platform });
  const requested =
    (plain(input.workspace) ? input.workspace : undefined) ??
    envText(env, 'JEVRIS_WORKSPACE') ??
    envText(env, 'CLAUDE_PROJECT_DIR') ??
    input.cwd ??
    process.cwd();
  const root = isDirectory(requested) ? workspaceRootFor(requested) : null;
  const autostart = autostartAllowed(env);
  const now = input.nowMs ?? (() => Date.now());
  return {
    home: resolved.home,
    homeSource: resolved.source,
    paths,
    platform,
    env,
    workspaceRoot: root,
    workspaceId: workspaceIdFor(root, platform),
    scope: input.scope ?? 'cli',
    ports: input.ports,
    autostart,
    sidecarWaitMs: 1500,
    requestTimeoutMs: 5000,
    nowMs: now,
  };
}

/**
 * Whether a surface may start the sidecar: not with JEVRIS_SIDECAR_AUTOSTART=0. The CLI, and MCP
 * through it, then only use a sidecar that is already running. The one reading of the variable
 * for the CLI (the hook launcher reads it the same way).
 */
export function autostartAllowed(env: { readonly [key: string]: string | undefined }): boolean {
  return env['JEVRIS_SIDECAR_AUTOSTART'] !== '0';
}
