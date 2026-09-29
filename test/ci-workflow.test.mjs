import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflows = join(root, '.github', 'workflows');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const ci = read('.github', 'workflows', 'ci.yml');
const { CELL_STEPS, dockerImage, dockerScript, parseArgs } = await import('../scripts/ci-cell.mjs');

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
const NODES = ['22.14.0', '24', 'latest'];

/** The lines of one job block, from `  <name>:` to the next top-level job. */
function jobBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `job ${name}`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('the CI matrix is three OSes by Node 22.14.0, 24 and latest, fail-fast off (BLD-10)', () => {
  const job = jobBlock(ci, 'test');
  assert.match(job, /^ {4}name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/m);
  assert.match(job, /^ {6}fail-fast: false$/m);
  assert.match(job, new RegExp(`^ {8}os: \\[${OSES.join(', ')}\\]$`, 'm'));
  assert.match(job, new RegExp(`^ {8}node: \\[${NODES.map((n) => `'${n}'`).join(', ')}\\]$`, 'm'));
  assert.match(ci, /^ {2}push:$/m);
  assert.match(ci, /^ {2}pull_request:$/m);
});

test('every cell runs the same npm steps as scripts/ci-cell.mjs, in order (BLD-10)', () => {
  const runs = [...jobBlock(ci, 'test').matchAll(/^ {8}run: (npm .+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    runs,
    CELL_STEPS.map((step) => `npm ${step.npm.join(' ')}`),
  );
  assert.deepEqual(
    CELL_STEPS.map((step) => step.id),
    ['ci', 'build', 'clean', 'lint', 'test', 'pack', 'signatures'],
  );
});

test('the Linux cells run the cross-user sidecar test with a real second OS user (IPC-06, GOV-14)', () => {
  const job = jobBlock(ci, 'test');
  const user = job.indexOf('run: sudo useradd -m jevris-other');
  const run = job.indexOf('run: node scripts/test.mjs --no-build apps/sidecar/test/opt-in/cross-user.test.mjs');
  assert.equal(user > job.indexOf('run: npm run build') && run > user, true, 'the user is created after the build and before the test runs');
  assert.match(job.slice(user, run + 100), /JEVRIS_TEST_OTHER_USER: jevris-other/);
  for (const name of ['Second local user (IPC-06)', 'Cross-user sidecar refusal (IPC-06)']) {
    const at = job.indexOf(`- name: ${name}`);
    assert.match(job.slice(at, at + 200), /if: runner\.os == 'Linux'/, `${name} is Linux-only`);
  }
});

test('the Linux cells run the container locality test in a real container after the build (IPC-19, US37)', () => {
  const job = jobBlock(ci, 'test');
  const at = job.indexOf('- name: Container locality (IPC-19)');
  const run = job.indexOf('run: node scripts/test.mjs --no-build apps/sidecar/test/opt-in/container.test.mjs');
  assert.equal(at > job.indexOf('run: npm run build') && run > at, true, 'the container test runs after the build');
  assert.match(job.slice(at, run), /if: runner\.os == 'Linux'/);
  assert.match(job.slice(at, run), /JEVRIS_TEST_DOCKER_IMAGE: node:24/);
});

test('the pack-smoke job writes the threat-model record on each OS into the uploaded evidence (GOV-14)', () => {
  const job = jobBlock(ci, 'pack-smoke');
  const smoke = job.indexOf('run: node scripts/pack-smoke.mjs --full --npx');
  const suite = job.indexOf('run: node apps/sidecar/scripts/threat-model-suite.mjs --out release-evidence/threat-model-${{ matrix.os }}.json');
  const upload = job.indexOf('name: Upload smoke evidence');
  assert.equal(smoke >= 0 && suite > smoke && upload > suite, true, 'the suite runs after the smoke build and before the upload');
  assert.match(job, /run: sudo useradd -m jevris-other/);
  assert.match(job, /run: sudo sysadminctl -addUser jevris-other/);
  assert.match(job.slice(job.lastIndexOf('- name:', suite), suite), /continue-on-error: true[\s\S]*JEVRIS_TEST_OTHER_USER/);
  assert.match(job.slice(upload), /release-evidence\//);
});

test('the pack-smoke job writes the operations-drills record from the installed tarball on each OS (OBS-05)', () => {
  const job = jobBlock(ci, 'pack-smoke');
  assert.match(job, /run: node scripts\/pack-smoke\.mjs --full --npx [^\n]*--drills-evidence release-evidence\/operations-drills-\$\{\{ matrix\.os \}\}\.json/);
  assert.match(job.slice(job.indexOf('name: Upload smoke evidence')), /release-evidence\//);
});

test('CI never runs the live-harness smoke and uses no secrets outside the manual live Jev run (BLD-10)', () => {
  for (const name of readdirSync(workflows)) {
    const text = read('.github', 'workflows', name);
    if (name !== 'live-jev.yml') assert.equal(/\$\{\{[^}]*secrets\./.test(text), false, `${name} uses a secret`);
    assert.equal(/^\s*run:.*(smoke:harness|JEVRIS_LIVE_HARNESS=1)/m.test(text), false, `${name} runs the live smoke`);
    assert.equal(text.includes('pull_request_target'), false, `${name} uses pull_request_target`);
    assert.match(text, /^permissions:\n {2}contents: read$/m, `${name} default permissions`);
  }
});

test('every action is pinned by a full commit SHA with its version in a comment (BLD-12)', () => {
  let count = 0;
  for (const name of readdirSync(workflows)) {
    for (const match of read('.github', 'workflows', name).matchAll(/uses: (\S+)(.*)$/gm)) {
      if (/^\.\/\.github\/workflows\/[\w-]+\.yml$/.test(match[1]) && match[2] === '') continue;
      count += 1;
      assert.match(match[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name}: ${match[1]}`);
      assert.match(match[2], /^ # v\d+\.\d+\.\d+$/, `${name}: ${match[1]} version comment`);
    }
  }
  assert.equal(count >= 7, true);
});

test('supply-chain workflows and Dependabot are present (BLD-12)', () => {
  const codeql = read('.github', 'workflows', 'codeql.yml');
  assert.match(codeql, /languages: javascript-typescript/);
  assert.match(codeql, /security-events: write/);
  const review = read('.github', 'workflows', 'dependency-review.yml');
  assert.match(review, /actions\/dependency-review-action@/);
  assert.match(review, /fail-on-severity: moderate/);
  const dependabot = read('.github', 'dependabot.yml');
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(jobBlock(ci, 'test'), /run: npm audit signatures/);
});

test('coverage runs once on Ubuntu Node 24 and uploads the report (QA-06)', () => {
  const job = jobBlock(ci, 'coverage');
  assert.match(job, /runs-on: ubuntu-latest/);
  assert.match(job, /node-version: '24'/);
  assert.match(job, /run: npm run coverage/);
  assert.match(job, /actions\/upload-artifact@/);
  assert.match(job, /path: coverage\//);
});

test('docs/testing.md names the nine test cells and the three pack smokes as required checks (BLD-11)', () => {
  const docs = read('docs', 'testing.md');
  for (const os of OSES) {
    for (const node of NODES) assert.equal(docs.includes(`\`test (${os}, ${node})\``), true, `${os} ${node}`);
    assert.equal(docs.includes(`\`pack-smoke (${os})\``), true, `pack-smoke ${os}`);
  }
});

test('the pack smoke runs the full installed scenario on three OSes and uploads its evidence (PKG-08, RLS-04)', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const job = jobBlock(ci, 'pack-smoke');
  assert.match(job, /^ {4}name: pack-smoke \(\$\{\{ matrix\.os \}\}\)$/m);
  assert.match(job, new RegExp(`^ {8}os: \\[${OSES.join(', ')}\\]$`, 'm'));
  assert.match(job, /node-version: '22\.14\.0'/);
  assert.match(job, /run: node scripts\/pack-smoke\.mjs --full --npx --evidence release-evidence\//);
  assert.match(job, /actions\/upload-artifact@/);
  assert.match(ci, /^ {2}workflow_call:$/m);
});

test('ci-cell parses its flags and builds a fixed docker script', () => {
  assert.deepEqual(parseArgs(['--docker', '--node', '22.14.0', '--steps', 'build,test']), {
    docker: true,
    workingTree: false,
    node: '22.14.0',
    steps: ['build', 'test'],
    keep: false,
  });
  assert.equal(parseArgs(['--working-tree']).workingTree, true);
  assert.throws(() => parseArgs(['--node', '24; rm -rf /']), /invalid node version/);
  assert.throws(() => parseArgs(['--steps', 'pack-smoke']), /unknown step/);
  // The full pack smoke is an extra step: run only when named, never by default.
  assert.deepEqual(parseArgs(['--steps', 'ci,build,smoke']).steps, ['ci', 'build', 'smoke']);
  assert.equal(parseArgs([]).steps.includes('smoke'), false);
  assert.match(dockerScript(['smoke']), /npm run smoke:pack -- --full --npx --no-build/);
  assert.equal(dockerImage(undefined), 'node:current');
  assert.equal(dockerImage('latest'), 'node:current');
  assert.equal(dockerImage('24'), 'node:24');
  const script = dockerScript(['ci', 'test']);
  assert.match(script, /npm ci/);
  assert.match(script, /npm test/);
  assert.equal(script.includes('smoke'), false);
});

function jobPermissions(job) {
  const block = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(`${job}\n`);
  return block === null ? null : block[1].trim().split('\n').map((line) => line.trim()).sort();
}

test('the release workflow publishes a checked tag to next with provenance and no secrets (PKG-11)', () => {
  const release = read('.github', 'workflows', 'release.yml');
  assert.match(release, /^ {2}push:\n {4}tags: \['v\*\.\*\.\*'\]$/m);
  assert.match(release, /^ {6}dry-run:\n(?: {8}.+\n)*? {8}default: true$/m);
  assert.match(jobBlock(release, 'check'), /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(jobBlock(release, 'check'), /node scripts\/release-check\.mjs --tag "\$TAG"/);
  assert.match(jobBlock(release, 'ci'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  const publish = jobBlock(release, 'publish');
  assert.match(publish, /needs: \[check, ci, gates\]/);
  assert.deepEqual(jobPermissions(publish), ['contents: write', 'id-token: write']);
  assert.match(publish, /npm publish "release-assets\/webventures-jevris-\$VERSION\.tgz" --provenance --access public --tag next$/m);
  assert.match(publish, /node scripts\/checksums\.mjs --check/);
  assert.match(publish, /sbom\.cdx\.json/);
  assert.match(publish, /THIRD_PARTY_NOTICES\.md/);
  assert.match(publish, /gh release create "\$TAG"/);
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN|NPM_TOKEN|dist-tag add|--tag latest/);
  for (const job of ['check', 'gates', 'verify']) assert.equal(jobPermissions(jobBlock(release, job)), null, `${job} keeps read-only defaults`);
  assert.equal((release.match(/id-token: write/g) ?? []).length, 1);
});

test('the release gates read the pack-smoke evidence and post-publish runs on three OSes (RLS-04, PKG-13)', () => {
  const release = read('.github', 'workflows', 'release.yml');
  const gates = jobBlock(release, 'gates');
  assert.match(gates, /pattern: installed-e2e-\*/);
  assert.match(gates, /node bin\/jevris\.mjs gates --evidence gate-evidence --commit "\$GITHUB_SHA" --json --out gates-report\.json/);
  // The story and workflow reports (RLS-02, RLS-03) are produced on the tag, before the gates read them.
  assert.ok(gates.indexOf('node scripts/acceptance-report.mjs --no-build --out gate-evidence --commit "$GITHUB_SHA"') > 0);
  assert.ok(gates.indexOf('scripts/acceptance-report.mjs') < gates.indexOf('bin/jevris.mjs gates'));
  const verify = jobBlock(release, 'verify');
  assert.match(verify, new RegExp(`^ {8}os: \\[${OSES.join(', ')}\\]$`, 'm'));
  assert.match(verify, /node scripts\/post-publish-verify\.mjs --version "\$VERSION"/);
  assert.match(verify, /shell: bash/);
});

test('the live Jev suite runs by hand only, in a protected environment, with the key kept out of argv (PRV-10)', () => {
  const live = read('.github', 'workflows', 'live-jev.yml');
  const triggers = /^on:\n((?: {2}.*\n)+)/m.exec(live)[1];
  assert.deepEqual([...triggers.matchAll(/^ {2}(\w[\w-]*):/gm)].map((match) => match[1]), ['workflow_dispatch']);
  assert.match(live, /^ {4}environment: live-api$/m);
  const secrets = [...live.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)];
  assert.deepEqual(secrets.map((match) => match[1]), ['JEVRIS_JEV_API_KEY']);
  assert.match(live, /^ {10}JEV_KEY: \$\{\{ secrets\.JEVRIS_JEV_API_KEY \}\}$/m, 'the secret reaches the step only as an environment variable');
  assert.match(live, /printf "%s" "\$JEV_KEY" \| node bin\/jevris\.mjs credential set/);
  assert.match(live, /credential clear/);
  assert.match(live, /JEVRIS_LIVE_JEV=1 npm run smoke:jev -- --calls "\$CALLS" --evidence release-evidence\/api-live-suite\.json/);
  assert.doesNotMatch(live, /id-token|contents: write|echo "\$JEV_KEY"|--key/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['smoke:jev'], 'npm run smoke:jev -w @jevris/provider-typesafe --');
});

test('the bench job measures each OS and fails a p95 regression against the last main record, recording the first run, and only reports it in a release (OBS-04)', () => {
  const job = jobBlock(ci, 'bench');
  assert.match(job, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(job, /fail-fast: false/);
  assert.deepEqual(jobPermissions(job), ['actions: read', 'contents: read']);
  // The baseline is the bench-<os> record of the latest successful ci run on main.
  const baseline = job.indexOf('- name: Previous benchmark record');
  const bench = job.indexOf('- name: Benchmark (OBS-04)');
  const upload = job.indexOf('- name: Upload benchmark record');
  assert.equal(job.indexOf('run: npm run build') < baseline && baseline < bench && bench < upload, true, 'build, baseline, bench, upload in order');
  assert.match(job, /gh run list --repo "\$GITHUB_REPOSITORY" --workflow ci\.yml --branch main --status success --limit 1/);
  assert.match(job, /gh run download "\$run_id" --repo "\$GITHUB_REPOSITORY" --name "\$RECORD"/);
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job, /RECORD: bench-\$\{\{ matrix\.os \}\}/);
  // With a baseline: compare at ratio 1.5 and 10 ms slack. Without one: record only.
  assert.match(job, /node apps\/sidecar\/scripts\/bench\.mjs --out "\$RECORD\.json" --baseline "\$BASELINE" --ratio 1\.5 --slack-ms 10/);
  assert.match(job, /else\n\s+node apps\/sidecar\/scripts\/bench\.mjs --out "\$RECORD\.json"\n\s+fi/);
  const up = job.slice(upload);
  assert.match(up, /if: always\(\)/);
  assert.match(up, /name: bench-\$\{\{ matrix\.os \}\}/);
  assert.match(up, /retention-days: 90/);
  // release.yml reuses ci: its ci job grants what the bench job asks for, and nothing more.
  const release = read('.github', 'workflows', 'release.yml');
  assert.deepEqual(jobPermissions(jobBlock(release, 'ci')), ['actions: read', 'contents: read']);
  // A regression does not stop a release: release.yml calls ci with bench-advisory, which lets
  // only the benchmark step fail without failing the job. The record is still uploaded.
  assert.match(ci, /^ {2}workflow_call:\n {4}inputs:\n(?: {6}#.*\n)* {6}bench-advisory:\n {8}type: boolean\n {8}default: false$/m);
  assert.match(job.slice(bench, upload), /continue-on-error: \$\{\{ inputs\.bench-advisory == true \}\}/);
  assert.equal((ci.match(/continue-on-error: \$\{\{ inputs\.bench-advisory/g) ?? []).length, 1, 'only the benchmark step is advisory');
  assert.match(jobBlock(release, 'ci'), /with:\n {6}bench-advisory: true/);
  // The bench flags the job passes are the ones bench.mjs reads.
  const script = read('apps', 'sidecar', 'scripts', 'bench.mjs');
  for (const flag of ['--out', '--baseline', '--ratio', '--slack-ms']) assert.match(script, new RegExp(`flag\\(argv, '${flag}'\\)`), flag);
});
