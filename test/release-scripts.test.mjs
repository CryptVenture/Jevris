import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { protectionPayload, requiredChecks } from '../scripts/branch-protection.mjs';
import { checksums, verify } from '../scripts/checksums.mjs';
import { isPropagationError, packageSpec, parseArgs as parsePostPublish } from '../scripts/post-publish-verify.mjs';
import { distTagCommand, parseArgs as parsePromote } from '../scripts/promote.mjs';
import { manifestProblems, tagProblems } from '../scripts/release-check.mjs';
import { PACKAGE_NAME } from '../scripts/release-policy.mjs';
import { bumpFor, changelogSection, isReleaseTag, nextVersion, parseCommit, prependChangelog, releaseRelevant, renderNotes } from '../scripts/release-version.mjs';
import { placeholderFiles } from '../scripts/reserve-unscoped.mjs';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('release tags are full v-prefixed semver; two-part milestone tags never publish (PKG-12)', () => {
  assert.equal(isReleaseTag('v1.2.0'), true);
  assert.equal(isReleaseTag('v1.2.1-rc.1'), true);
  assert.equal(isReleaseTag('v1.1'), false);
  assert.equal(isReleaseTag('1.2.0'), false);
  assert.equal(isReleaseTag('milestone-v1.2'), false);
});

test('conventional commits parse with domain scopes and breaking markers (PKG-12)', () => {
  assert.deepEqual(parseCommit('feat(A/pkg): bundled runtime'), { type: 'feat', scope: 'A/pkg', breaking: false, text: 'bundled runtime' });
  assert.equal(parseCommit('fix!: drop old flag').breaking, true);
  assert.equal(parseCommit('refactor(core): x', 'BREAKING CHANGE: removed y').breaking, true);
  assert.equal(parseCommit('Merge branch main'), null);
});

test('planning, test and chore commits stay out of the notes; user-facing ones stay in (PKG-12)', () => {
  assert.equal(releaseRelevant(parseCommit('docs(planning): lint before commit')), false);
  assert.equal(releaseRelevant(parseCommit('test(F/adapters): conformance')), false);
  assert.equal(releaseRelevant(parseCommit('chore: bump')), false);
  assert.equal(releaseRelevant(parseCommit('docs(A/udoc): install guide')), true);
  assert.equal(releaseRelevant(parseCommit('fix(E/cli): exit codes')), true);
  assert.equal(releaseRelevant(parseCommit('chore!: drop node 20')), true);
});

test('the bump follows the most significant relevant commit (PKG-12)', () => {
  const feat = parseCommit('feat(A/pkg): x');
  const fix = parseCommit('fix(A/pkg): y');
  const breaking = parseCommit('feat!: z');
  const planning = parseCommit('docs(planning): w');
  assert.equal(bumpFor([fix, feat], '1.2.0'), 'minor');
  assert.equal(bumpFor([fix], '1.2.0'), 'patch');
  assert.equal(bumpFor([breaking, fix], '1.2.0'), 'major');
  assert.equal(bumpFor([breaking], '0.4.0'), 'minor');
  assert.equal(bumpFor([planning], '1.2.0'), null);
  assert.equal(nextVersion('1.2.0', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.0', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.3.0-rc.1', 'patch'), '1.3.0');
  assert.equal(nextVersion('1.2.0', null), '1.2.0');
});

test('notes group by type, list breaking changes first and strip the domain prefix (PKG-12)', () => {
  const notes = renderNotes('1.3.0', '2026-09-25', [parseCommit('feat(A/pkg): bundle'), parseCommit('fix!: drop flag'), parseCommit('docs(planning): skip me')]);
  assert.match(notes, /^## 1\.3\.0 \(2026-09-25\)/);
  assert.ok(notes.indexOf('### Breaking changes') < notes.indexOf('### Features'));
  assert.match(notes, /- \*\*pkg\*\*: bundle/);
  assert.doesNotMatch(notes, /skip me/);
  assert.match(renderNotes('1.3.1', '2026-09-25', [parseCommit('test: x')]), /No user-facing changes\./);
});

test('the changelog gains the new section under the title and loses the Unreleased block (PKG-12)', () => {
  const before = '# Changelog\n\n## Unreleased\n\n- pending\n\n## 1.1.0 (2026-01-01)\n\n- old\n';
  const after = prependChangelog(before, '## 1.2.0 (2026-09-25)\n\n### Features\n\n- new\n');
  assert.match(after, /^# Changelog\n\n## 1\.2\.0/);
  assert.doesNotMatch(after, /Unreleased|pending/);
  assert.equal(changelogSection(after, '1.2.0'), '## 1.2.0 (2026-09-25)\n\n### Features\n\n- new');
  assert.equal(changelogSection(after, '1.1.0'), '## 1.1.0 (2026-01-01)\n\n- old');
  assert.equal(changelogSection(after, '1.0.0'), null);
});

test('the release check accepts the root manifest and a matching tag (PKG-09, PKG-11)', () => {
  assert.deepEqual(manifestProblems(rootPackage), []);
  assert.deepEqual(tagProblems(`v${rootPackage.version}`, rootPackage.version), []);
});

test('the release check refuses a mismatched tag, a milestone tag and an unsafe manifest (PKG-09, PKG-11)', () => {
  assert.match(tagProblems('v9.9.9', '1.2.0')[0], /does not match/);
  assert.match(tagProblems('v1.2', '1.2.0')[0], /not a release tag/);
  assert.deepEqual(tagProblems(undefined, '1.2.0'), ['no tag given']);
  const unsafe = structuredClone(rootPackage);
  unsafe.publishConfig.tag = 'latest';
  unsafe.dependencies['better-sqlite3'] = '^13.0.3';
  unsafe.private = true;
  const problems = manifestProblems(unsafe).join('\n');
  assert.match(problems, /publishConfig\.tag is not next/);
  assert.match(problems, /better-sqlite3@\^13\.0\.3 is not an exact pin/);
  assert.match(problems, /private/);
});

test('SHA256SUMS round-trips and names a tampered or missing asset (PKG-11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-sums-'));
  try {
    writeFileSync(join(dir, 'b.tgz'), 'tarball');
    writeFileSync(join(dir, 'a.json'), '{}');
    const sums = checksums([join(dir, 'b.tgz'), join(dir, 'a.json')]);
    assert.match(sums, /^[0-9a-f]{64} {2}a\.json\n[0-9a-f]{64} {2}b\.tgz\n$/);
    writeFileSync(join(dir, 'SHA256SUMS'), sums);
    assert.deepEqual(verify(join(dir, 'SHA256SUMS')), []);
    writeFileSync(join(dir, 'b.tgz'), 'tampered');
    rmSync(join(dir, 'a.json'));
    assert.deepEqual(verify(join(dir, 'SHA256SUMS')).sort(), ['a.json', 'b.tgz']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branch protection requires every CI cell, the pack smoke on three OSes and the security checks (BLD-11)', () => {
  const checks = requiredChecks();
  assert.equal(checks.filter((name) => name.startsWith('test (')).length, 9);
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.ok(checks.includes(`pack-smoke (${os})`));
  assert.ok(checks.includes('codeql (javascript-typescript)'));
  assert.ok(checks.includes('dependency-review'));
  const payload = protectionPayload();
  assert.equal(payload.required_status_checks.strict, true);
  assert.equal(payload.allow_force_pushes, false);
  assert.equal(payload.enforce_admins, true);
});

test('the branch protection job names match the workflow jobs they require (BLD-11)', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const job of ['test', 'pack-smoke']) assert.match(ci, new RegExp(`^  ${job}:`, 'm'), `ci.yml has no ${job} job`);
});

test('post-publish verification reads a registry version or a local tarball and retries only registry lag (PKG-13)', () => {
  const registry = parsePostPublish(['--version', '1.2.0']);
  assert.equal(packageSpec(registry), `${PACKAGE_NAME}@1.2.0`);
  assert.equal(registry.provenance, true);
  const local = parsePostPublish(['--version', '1.2.0', '--package', './x.tgz']);
  assert.equal(packageSpec(local), './x.tgz');
  assert.equal(local.provenance, false);
  assert.throws(() => parsePostPublish([]), /--version/);
  assert.throws(() => parsePostPublish(['--version', '1.2.0', '--retries', '99']), /--retries/);
  assert.equal(isPropagationError('npm error code E404'), true);
  assert.equal(isPropagationError('npm error code ETARGET'), true);
  assert.equal(isPropagationError('npm error code EACCES'), false);
});

test('promotion to latest needs a release commit and never takes a prerelease (RLS-12)', () => {
  assert.deepEqual(distTagCommand('1.2.0'), ['dist-tag', 'add', `${PACKAGE_NAME}@1.2.0`, 'latest']);
  const sha = 'a'.repeat(40);
  assert.equal(parsePromote(['--version', '1.2.0', '--evidence', 'ev', '--commit', sha, '--apply']).apply, true);
  assert.equal(parsePromote(['--version', '1.2.0', '--evidence', 'ev']).apply, false);
  assert.throws(() => parsePromote(['--version', '1.2.0', '--evidence', 'ev', '--apply']), /--apply needs --commit/);
  assert.throws(() => parsePromote(['--version', '1.3.0-rc.1', '--evidence', 'ev', '--commit', sha, '--apply']), /prerelease/);
  assert.throws(() => parsePromote(['--version', '1.2.0', '--evidence', 'ev', '--commit', 'abc']), /40-character/);
  assert.throws(() => parsePromote(['--version', '1.2.0']), /--evidence/);
});

test('the unscoped placeholder only points at the scoped package and exits non-zero (PKG-14)', () => {
  const files = placeholderFiles();
  const manifest = JSON.parse(files['package.json']);
  assert.equal(manifest.name, 'jevris');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.match(files['index.js'], /process\.exit\(1\)/);
  assert.match(files['index.js'], new RegExp(`npx ${PACKAGE_NAME.replace('/', '\\/')}`));
  assert.doesNotMatch(files['index.js'], /require|import|spawn/);
});
