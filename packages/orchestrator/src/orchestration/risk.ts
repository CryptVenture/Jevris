/**
 * The rules-only risk class of an owned-worker route (owner decision 2026-09-27, DOMAINS 7922ee3;
 * learning-coverage audit P1).
 *
 * C16 route learning explores, and follows an active slice, only on a `low` route. The class is
 * computed here by fixed rules when the task is created, never by a model and never from task
 * text. A task is `low` only when all of these hold:
 * - it has at least one acceptance check;
 * - it has write scopes, each inside the workspace (relative, no `..`, no symlink), and together
 *   they cover at most LOW_RISK_MAX_FILES files: a glob, `.` or a directory that is still empty
 *   of files counts as unbounded, an existing directory counts the files below it, and a path
 *   that does not exist yet counts as one file only when its last segment has an extension;
 * - none of those paths is protected (auth, secrets, CI, deploy, migrations, lockfiles, git
 *   internals);
 * - it is not security-labelled (`labels` includes `security`).
 *
 * A plan may lower the class (declare `risk: 'medium'` or `'high'`) but never raise it to `low`:
 * a declared `low` is ignored. A task that fails a rule is `high` when the reason is a protected
 * path, a security label or a scope outside the workspace, and `medium` otherwise.
 *
 * The limits are locked: changing LOW_RISK_MAX_FILES or the protected set is a policy change in
 * a reviewed commit (like the learning thresholds), never tuned by what is learned.
 */
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { protectedClasses, type RouteRisk } from '@jevris/core';
import { isAbsoluteOnAnyPlatform } from '@jevris/platform';


/** Locked: the most files a low-risk task's write scopes may cover. */
export const LOW_RISK_MAX_FILES = 5;

// The protected path classes are one locked list, shared with the slice classifier (packages/core protected-paths).
export { protectedClasses };

/** Locked: directory entries read while counting a directory scope's files. */
const WALK_ENTRY_CAP = 512;

export type RiskReason =
  | 'NO_ACCEPTANCE_CHECKS'
  | 'NO_WRITE_SCOPES'
  | 'WORKSPACE_UNKNOWN'
  | 'SCOPE_OUTSIDE_WORKSPACE'
  | 'SCOPE_SYMLINK'
  | 'SCOPE_UNBOUNDED'
  | 'TOO_MANY_FILES'
  | 'PROTECTED_AUTH'
  | 'PROTECTED_SECRETS'
  | 'PROTECTED_CI'
  | 'PROTECTED_DEPLOY'
  | 'PROTECTED_MIGRATIONS'
  | 'PROTECTED_LOCKFILE'
  | 'PROTECTED_GIT'
  | 'SECURITY_LABEL'
  | 'PLAN_DECLARED_MEDIUM'
  | 'PLAN_DECLARED_HIGH';

/** Reasons that make a non-low task `high` rather than `medium`. */
const HIGH_REASONS: ReadonlySet<RiskReason> = new Set([
  'SCOPE_OUTSIDE_WORKSPACE',
  'SCOPE_SYMLINK',
  'PROTECTED_AUTH',
  'PROTECTED_SECRETS',
  'PROTECTED_CI',
  'PROTECTED_DEPLOY',
  'PROTECTED_MIGRATIONS',
  'PROTECTED_LOCKFILE',
  'PROTECTED_GIT',
  'SECURITY_LABEL',
  'PLAN_DECLARED_HIGH',
]);

const GLOB = /[*?[\]{}]/;

/** What the filesystem says about a workspace path (a test seam; lstat, never following links). */
export interface ScopeProbe {
  lstat(absolute: string): Stats | undefined;
  list(absolute: string): readonly string[];
}

const FS_PROBE: ScopeProbe = {
  lstat(absolute) {
    try {
      return lstatSync(absolute);
    } catch {
      return undefined;
    }
  },
  list(absolute) {
    try {
      return readdirSync(absolute).slice(0, WALK_ENTRY_CAP);
    } catch {
      return [];
    }
  },
};

/** A filesystem that knows nothing: every path is new. */
const NO_PROBE: ScopeProbe = { lstat: () => undefined, list: () => [] };

/** The files below a directory scope, up to `cap + 1` (enough to know it is over), as workspace-relative paths. */
function filesBelow(root: string, rel: string, cap: number, probe: ScopeProbe, reasons: Set<RiskReason>): readonly string[] {
  const out: string[] = [];
  const queue = [rel];
  let visited = 0;
  while (queue.length > 0 && out.length <= cap) {
    const dir = queue.shift() as string;
    for (const name of probe.list(join(root, ...dir.split('/')))) {
      if (++visited > WALK_ENTRY_CAP) {
        reasons.add('SCOPE_UNBOUNDED');
        return out;
      }
      // The write-scope form: workspace-relative with forward slashes (joined on disk below).
      const child = [dir, name].join('/');
      const stat = probe.lstat(join(root, ...child.split('/')));
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) reasons.add('SCOPE_SYMLINK');
      else if (stat.isDirectory()) queue.push(child);
      else out.push(child);
      if (out.length > cap) return out;
    }
  }
  return out;
}

export interface RiskInput {
  readonly acceptanceCheckIds: readonly string[];
  readonly writeScopes: readonly string[];
  readonly labels?: readonly string[];
  /** A plan's declared class: it may lower the class, never raise it to low. */
  readonly declaredRisk?: RouteRisk;
}

export interface RiskClass {
  readonly risk: Exclude<RouteRisk, 'unknown'>;
  /** Why the task is not low (empty when it is). Reason codes only. */
  readonly reasons: readonly RiskReason[];
}

/** The rules-only risk class of a task in the workspace at `workspaceRoot`. */
export function taskRisk(input: RiskInput, workspaceRoot: string, probe: ScopeProbe = FS_PROBE): RiskClass {
  const reasons = new Set<RiskReason>();
  // Without a workspace root the scopes cannot be checked on disk: never low.
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    reasons.add('WORKSPACE_UNKNOWN');
    probe = NO_PROBE;
    workspaceRoot = '.';
  }
  if (input.acceptanceCheckIds.length === 0) reasons.add('NO_ACCEPTANCE_CHECKS');
  if (input.writeScopes.length === 0) reasons.add('NO_WRITE_SCOPES');
  if ((input.labels ?? []).some((l) => l.toLowerCase() === 'security')) reasons.add('SECURITY_LABEL');
  if (input.declaredRisk === 'medium') reasons.add('PLAN_DECLARED_MEDIUM');
  if (input.declaredRisk === 'high' || input.declaredRisk === 'unknown') reasons.add('PLAN_DECLARED_HIGH');
  const files = new Set<string>();
  for (const raw of input.writeScopes.slice(0, 256)) {
    const scope = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const segments = scope.split('/');
    if (scope === '' || isAbsoluteOnAnyPlatform(scope) || /^[A-Za-z]:/.test(scope) || scope.startsWith('~') || segments.includes('..')) {
      reasons.add('SCOPE_OUTSIDE_WORKSPACE');
      continue;
    }
    for (const c of protectedClasses(scope)) reasons.add(c);
    if (scope === '.' || GLOB.test(scope)) {
      reasons.add('SCOPE_UNBOUNDED');
      continue;
    }
    // Any existing ancestor that is a link could lead outside the workspace.
    let linked = false;
    for (let i = 1; i <= segments.length && !linked; i += 1) linked = probe.lstat(join(workspaceRoot, ...segments.slice(0, i)))?.isSymbolicLink() === true;
    if (linked) {
      reasons.add('SCOPE_SYMLINK');
      continue;
    }
    const stat = probe.lstat(join(workspaceRoot, ...segments));
    if (stat === undefined) {
      // Not there yet: a new file when its name has an extension, else possibly a new directory.
      if (/\.[A-Za-z0-9]+$/.test(segments.at(-1) ?? '')) files.add(scope);
      else reasons.add('SCOPE_UNBOUNDED');
    } else if (stat.isDirectory()) {
      const below = filesBelow(workspaceRoot, scope, LOW_RISK_MAX_FILES, probe, reasons);
      if (below.length === 0) reasons.add('SCOPE_UNBOUNDED');
      for (const f of below) {
        files.add(f);
        for (const c of protectedClasses(f)) reasons.add(c);
      }
    } else {
      files.add(scope);
    }
  }
  if (files.size > LOW_RISK_MAX_FILES) reasons.add('TOO_MANY_FILES');
  const list = [...reasons].sort();
  if (list.length === 0) return { risk: 'low', reasons: [] };
  return { risk: list.some((r) => HIGH_REASONS.has(r)) ? 'high' : 'medium', reasons: list };
}

/**
 * The slice a low-risk task routes under when its plan declares none: the rules that make a task
 * low (acceptance checks, a few files, nothing protected) describe a bounded edit, one of C's
 * shared slices. A task that is not low keeps no slice unless its plan declares one.
 */
export const DEFAULT_LOW_RISK_SLICE = 'bounded-edit';
