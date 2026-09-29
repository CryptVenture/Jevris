#!/usr/bin/env node
/**
 * Pre-publish checks for a release tag (PKG-09, PKG-11, PKG-12). The release workflow runs it
 * before anything is built for publishing; it is also the local dry run.
 *
 *   node scripts/release-check.mjs --tag v1.2.0 [--notes <file>]
 *
 * Fails when the tag is not a full semver release tag, does not equal `v<package.json version>`,
 * the manifest lacks public-package metadata, a runtime dependency is not an exact pin, or
 * CHANGELOG.md has no section for the version. --notes writes that section for the GitHub release.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';
import { OPTIONAL_EXTERNALS, PACKAGE_NAME, RUNTIME_EXTERNALS } from './release-policy.mjs';
import { changelogSection, isReleaseTag } from './release-version.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function manifestProblems(pkg) {
  const problems = [];
  if (pkg.name !== PACKAGE_NAME) problems.push(`name is ${pkg.name}, not ${PACKAGE_NAME}`);
  if (pkg.private === true) problems.push('the root package is private');
  if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access is not public');
  if (pkg.publishConfig?.tag !== 'next') problems.push('publishConfig.tag is not next: a plain publish would move latest');
  for (const field of ['description', 'license', 'author', 'homepage']) {
    if (typeof pkg[field] !== 'string' || pkg[field].length === 0) problems.push(`${field} is missing`);
  }
  if (typeof pkg.repository?.url !== 'string') problems.push('repository.url is missing');
  if (typeof pkg.bugs?.url !== 'string') problems.push('bugs.url is missing');
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) problems.push('keywords are missing');
  if (pkg.bin?.jevris !== './bin/jevris.mjs') problems.push('bin.jevris is not ./bin/jevris.mjs');
  if (pkg.engines?.node !== '^22.14.0 || >=23.6.0') problems.push('engines.node is not ^22.14.0 || >=23.6.0');
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  if (JSON.stringify(deps) !== JSON.stringify([...RUNTIME_EXTERNALS].sort())) problems.push(`dependencies are ${deps.join(', ')}; expected ${RUNTIME_EXTERNALS.join(', ')}`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${name}@${range} is not an exact pin`);
  }
  for (const name of OPTIONAL_EXTERNALS) {
    if (pkg.peerDependenciesMeta?.[name]?.optional !== true) problems.push(`${name} is not an optional peer`);
  }
  return problems;
}

export function tagProblems(tag, version) {
  if (typeof tag !== 'string' || tag.length === 0) return ['no tag given'];
  if (!isReleaseTag(tag)) return [`${tag} is not a release tag (v<major>.<minor>.<patch>[-pre]); milestone tags never publish`];
  if (tag !== `v${version}`) return [`${tag} does not match package.json version ${version}`];
  return [];
}

function main(argv) {
  const tag = argv[argv.indexOf('--tag') + 1];
  const notesIndex = argv.indexOf('--notes');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const problems = [...tagProblems(argv.includes('--tag') ? tag : undefined, pkg.version), ...manifestProblems(pkg)];
  const section = changelogSection(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), pkg.version);
  if (section === null) problems.push(`CHANGELOG.md has no section for ${pkg.version}; run node scripts/release-version.mjs --write`);
  for (const problem of problems) console.error(`release-check: ${problem}`);
  if (problems.length > 0) return 1;
  if (notesIndex >= 0) writeFileSync(argv[notesIndex + 1], `${section}\n`);
  console.log(`release-check: ${PACKAGE_NAME}@${pkg.version} is ready to publish from ${tag}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
