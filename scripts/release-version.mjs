#!/usr/bin/env node
/**
 * Versioning and changelog from conventional commits (PKG-12).
 *
 *   node scripts/release-version.mjs                 # print the next version and the notes
 *   node scripts/release-version.mjs --write         # bump package.json + lockfile, prepend CHANGELOG
 *   node scripts/release-version.mjs --write --as 1.2.0   # the owner's chosen version (E-09)
 *
 * Release tags are full semver with a `v` prefix (`v1.2.0`, `v1.2.1-rc.1`). The milestone tags
 * `v1.0` and `v1.1` are two-part and never match, so they cannot collide with npm releases;
 * later milestones are tagged `milestone-v1.2`. Planning-only commits (`docs(planning)`) and
 * merges are left out of the notes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function isReleaseTag(tag) {
  return RELEASE_TAG.test(tag);
}

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) throw new Error(`not a semver version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null };
}

const TYPES = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  security: 'Security',
  refactor: 'Changes',
  revert: 'Reverts',
  docs: 'Documentation',
};

/** Parses one `type(scope)!: subject` line; returns null for a non-conventional subject. */
export function parseCommit(subject, body = '') {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/.exec(subject);
  if (match === null) return null;
  const [, type, scope = '', bang, text] = match;
  const breaking = bang === '!' || /^BREAKING[ -]CHANGE:/m.test(body);
  return { type, scope, breaking, text };
}

/** Whether a commit belongs in user-facing release notes. */
export function releaseRelevant(commit) {
  if (commit === null) return false;
  if (commit.type === 'docs' && /(^|\/)planning$/.test(commit.scope)) return false;
  if (['chore', 'ci', 'test', 'build', 'style'].includes(commit.type) && !commit.breaking) return false;
  return commit.type in TYPES || commit.breaking;
}

/** The semver bump the commits require: major for breaking (minor while 0.x), minor for feat, else patch. */
export function bumpFor(commits, current) {
  const relevant = commits.filter(releaseRelevant);
  if (relevant.length === 0) return null;
  const { major } = parseVersion(current);
  if (relevant.some((commit) => commit.breaking)) return major === 0 ? 'minor' : 'major';
  if (relevant.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

export function nextVersion(current, bump) {
  const v = parseVersion(current);
  if (v.pre !== null && bump !== null) return `${v.major}.${v.minor}.${v.patch}`;
  if (bump === 'major') return `${v.major + 1}.0.0`;
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (bump === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  return current;
}

/** Strips a domain prefix from a scope for the notes: `A/pkg` -> `pkg`. */
function scopeLabel(scope) {
  const parts = scope.split('/');
  return parts[parts.length - 1] ?? scope;
}

export function renderNotes(version, date, commits) {
  const groups = new Map();
  const breaking = [];
  for (const commit of commits.filter(releaseRelevant)) {
    const title = TYPES[commit.type] ?? 'Changes';
    if (!groups.has(title)) groups.set(title, []);
    const line = `- ${commit.scope.length > 0 ? `**${scopeLabel(commit.scope)}**: ` : ''}${commit.text}`;
    groups.get(title).push(line);
    if (commit.breaking) breaking.push(line);
  }
  const lines = [`## ${version} (${date})`, ''];
  if (breaking.length > 0) lines.push('### Breaking changes', '', ...breaking, '');
  for (const title of Object.values(TYPES)) {
    const items = groups.get(title);
    if (items === undefined) continue;
    lines.push(`### ${title}`, '', ...[...new Set(items)], '');
  }
  if (groups.size === 0) lines.push('No user-facing changes.', '');
  return lines.join('\n');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/** The newest release tag reachable from HEAD, ignoring two-part milestone tags. */
export function lastReleaseTag() {
  const tags = git(['tag', '--merged', 'HEAD', '--sort=-v:refname']).split('\n').filter((tag) => isReleaseTag(tag));
  return tags[0] ?? null;
}

export function commitsSince(tag) {
  const range = tag === null ? 'HEAD' : `${tag}..HEAD`;
  const out = git(['log', '--no-merges', '--format=%s%x1f%b%x1e', range]);
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [subject, body = ''] = entry.split('\x1f');
      return parseCommit(subject.trim(), body);
    })
    .filter((commit) => commit !== null);
}

/** Inserts a release section after the `# Changelog` title, replacing an `## Unreleased` block. */
export function prependChangelog(changelog, notes) {
  const lines = changelog.split('\n');
  const title = lines.findIndex((line) => line.startsWith('# '));
  const head = title < 0 ? ['# Changelog', ''] : lines.slice(0, title + 1);
  let rest = title < 0 ? lines : lines.slice(title + 1);
  const unreleased = rest.findIndex((line) => /^## Unreleased\s*$/.test(line));
  if (unreleased >= 0) {
    let end = rest.findIndex((line, index) => index > unreleased && line.startsWith('## '));
    if (end < 0) end = rest.length;
    rest = [...rest.slice(0, unreleased), ...rest.slice(end)];
  }
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  return `${[...head, '', notes.trimEnd(), '', ...rest].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The notes section of one version from CHANGELOG.md, or null. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?( |$)`).test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

function main(argv) {
  const write = argv.includes('--write');
  const asIndex = argv.indexOf('--as');
  const pkgPath = join(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const tag = lastReleaseTag();
  const commits = commitsSince(tag);
  const version = asIndex >= 0 ? argv[asIndex + 1] : tag === null ? pkg.version : nextVersion(tag.slice(1), bumpFor(commits, tag.slice(1)));
  parseVersion(version);
  const date = new Date().toISOString().slice(0, 10);
  const notes = renderNotes(version, date, commits);
  console.log(`last release tag: ${tag ?? 'none'}; ${commits.length} conventional commits; next version ${version}`);
  if (!write) {
    console.log(notes);
    return 0;
  }
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockPath = join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  writeFileSync(changelogPath, prependChangelog(readFileSync(changelogPath, 'utf8'), notes));
  console.log(`wrote version ${version} to package.json, package-lock.json and CHANGELOG.md; tag it v${version}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
