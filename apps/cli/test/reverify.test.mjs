// Records cover version ranges and re-verify themselves (owner direction 2026-09-26). The paired
// tests the coordinator asked for:
// - a version inside the range is covered with no action;
// - a version outside it starts exactly one background check;
// - a failing check demotes only the failing feature;
// - a malformed live event demotes its feature and starts a re-check.
// Stub harness CLIs and temp homes only; the background start is a test seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_HELP } from './harness-cli-stubs.mjs';

const { certifyHarness, formatCertify, runCertifyCommand } = await import('../dist/certification.js');
const { loadCertifications, coveringCertification } = await import('../dist/certification-store.js');
const { maybeReverify, reverifyDir } = await import('../dist/reverify.js');
const { recordLiveEvent, readLiveEvidence } = await import('../dist/live-evidence.js');
const { runDoctorCommand } = await import('../dist/doctor-cli.js');
const { doctorLineSeverity } = await import('../dist/doctor-severity.js');
const { main } = await import('../dist/cli.js');

const root = fileURLToPath(new URL('../../..', import.meta.url));
const OS = process.platform;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'jevris-reverify-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

/** A Claude Code stand-in at `version`; `broken` names checks that fail. */
function claudeStub(version, broken = {}) {
  return {
    available: (file) => file === 'claude',
    run: async (_file, args) => {
      const line = args.join(' ');
      if (line === '--version') return { spawned: true, code: 0, stdout: `${version} (Claude Code)\n` };
      if (line === '--help') return { spawned: true, code: 0, stdout: WORKER_HELP.claude };
      if (line.startsWith('plugin validate')) return { spawned: true, code: 0, stdout: '✔ Validation passed\n' };
      if (line === 'plugin list --json') return { spawned: true, code: 0, stdout: '[{"id":"jevris@jevris-local","enabled":true}]' };
      if (line.startsWith('plugin details')) return { spawned: true, code: 0, stdout: broken.skills ? 'Skills: (none)\n' : 'Skills: status, plan, route, checkpoint, recover, verify, explain, configure\n' };
      return { spawned: true, code: 0, stdout: '' };
    },
  };
}

async function installed(home) {
  let out = '';
  assert.equal(await main(['install', '--yes', '--home', home, '--harness', 'claude'], (chunk) => (out += chunk)), 0, out);
}

/** The models.list listing (G13) in the throwaway profile: the stand-in answers with one id. */
const listModels = async () => ({ ok: true, models: ['claude-opus-5-5'] });

async function certify(home, version, broken = {}, nowMs = undefined) {
  const result = await certifyHarness({ home, harness: 'claude', json: false, root, cli: claudeStub(version, broken), listModels, policies: [], ...(nowMs === undefined ? {} : { nowMs }) });
  assert.equal(result.error === null || broken.skills === true, true, formatCertify(result));
  return result;
}

async function doctor(home, version, seams) {
  let out = '';
  await runDoctorCommand({ home, json: false, values: {}, root, cli: claudeStub(version), policies: [], ...seams }, (chunk) => (out += chunk));
  return out.split('\n').find((line) => line.startsWith('harness claude:'));
}

function counter() {
  const jobs = [];
  return { jobs, start: async (job) => (jobs.push(job), true), guard: () => null };
}

test('a version inside the record range is covered with no action and no check', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certify(home, '2.1.282');
  const seam = counter();
  // 2.1.290 is inside >=2.1.282 <2.2.0 (same-minor).
  const states = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.1.290' }, start: seam.start, guard: seam.guard });
  assert.deepEqual(states, []);
  assert.equal(seam.jobs.length, 0);
  const line = await doctor(home, '2.1.290', { reverifyStart: seam.start, reverifyGuard: seam.guard });
  assert.match(line, /certified for >=2\.1\.282 <2\.2\.0 \(last verified 2\.1\.282, /);
  assert.equal(doctorLineSeverity(line), 'ok');
  assert.equal(seam.jobs.length, 0);
});

test('a version outside the range starts exactly one background check, however many callers ask', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certify(home, '2.1.282');
  const seam = counter();
  const ask = () => maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.2.1' }, start: seam.start, guard: seam.guard });
  // Doctor, sidecar start and SessionStart can ask at the same moment.
  const results = await Promise.all([ask(), ask(), ask(), ask(), ask()]);
  assert.equal(seam.jobs.length, 1, 'one check for this version');
  assert.deepEqual(results.flat().map((item) => item.state).sort(), ['running', 'running', 'running', 'running', 'started']);
  assert.equal(seam.jobs[0].reason, 'out-of-range');
  assert.equal(seam.jobs[0].version, '2.2.1');
  assert.equal(seam.jobs[0].marker.startsWith(reverifyDir(home)), true);
  // Asking again later starts nothing new; doctor says it is re-checking, which needs nothing from the user.
  const line = await doctor(home, '2.2.1', { reverifyStart: seam.start, reverifyGuard: seam.guard });
  assert.equal(seam.jobs.length, 1);
  assert.match(line, /not covered yet: 2\.2\.1 is outside the record covers >=2\.1\.282 <2\.2\.0 \(last verified 2\.1\.282, .*\); re-checking in the background, no model call$/);
  assert.equal(doctorLineSeverity(line), 'info');
});

test('never in a test run or under a foreign HOME unless a caller allows it: the default guard refuses and doctor names the fix', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certify(home, '2.1.282');
  const started = [];
  const states = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.2.1' }, start: async (job) => (started.push(job), true) });
  assert.equal(started.length, 0);
  assert.equal(states[0].state, 'refused');
  const line = await doctor(home, '2.2.1', {});
  assert.match(line, /not covered: 2\.2\.1 is outside the record covers >=2\.1\.282 <2\.2\.0 .*\(not re-checked: test run\); fix: jevris certify --harness claude$/);
  assert.equal(doctorLineSeverity(line), 'action');
});

test('a failing background check demotes only the failing feature; the others stay certified for the new version', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certify(home, '2.1.282');
  // The check itself: `jevris certify --reverify <marker>` against a 2.2.1 whose skills are not discovered.
  const start = async (job) => {
    const code = await runCertifyCommand({ home, harness: 'claude', json: true, root, cli: claudeStub('2.2.1', { skills: true }), listModels, policies: [], reverify: job.marker }, () => {});
    assert.equal(code, 1);
    return true;
  };
  const [state] = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.2.1' }, start, guard: () => null });
  assert.equal(state.state, 'started');
  const marker = JSON.parse(readFileSync(join(reverifyDir(home), `claude-${OS}-2.2.1.json`), 'utf8'));
  assert.equal(marker.status, 'failed');
  // The stand-in never reaches the stub, so the optional access cases (R69) fail as well.
  assert.deepEqual(marker.failed.map((item) => item.featureId), ['skills.discovery', 'access.detect', 'access.session']);
  const load = await loadCertifications(home, { root });
  const at = (featureId) => coveringCertification(load, { harness: 'claude', harnessVersion: '2.2.1', operatingSystem: OS, nowMs: Date.now(), featureId }).covered !== null;
  assert.equal(at('skills.discovery'), false, 'the failing feature is demoted');
  for (const featureId of ['plugin.install', 'mcp.tools', 'hooks.observe', 'hooks.context', 'hooks.route', 'worker.route']) assert.equal(at(featureId), true, `${featureId} stays certified`);
  const line = await doctor(home, '2.2.1', { reverifyStart: async () => true, reverifyGuard: () => null });
  assert.match(line, /certified for >=2\.2\.1 <2\.3\.0 \(last verified 2\.2\.1, .*\): plugin\.install, mcp\.tools, hooks\.observe, hooks\.context, hooks\.route, worker\.route, models\.list; not certified here: skills\.discovery \(SKILLS_NOT_DISCOVERED\); optional, not certified here: access\.detect \(ACCESS_DETECT_CASE_FAILED\), access\.session \(ACCESS_SESSION_CASE_FAILED\); fix: jevris certify --harness claude$/);
  assert.equal(doctorLineSeverity(line), 'action');
});

test('a malformed live event demotes its feature to observe-only and starts one re-check; a later record lifts it', async (t) => {
  const home = tempHome(t);
  await installed(home);
  await certify(home, '2.1.283', {}, Date.now() - 60_000);
  for (let i = 0; i < 3; i += 1) assert.equal(await recordLiveEvent(home, { harness: 'claude', version: '2.1.283', featureId: 'hooks.context', conforming: true }), true);
  let load = await loadCertifications(home, { root });
  const covered = (featureId) => coveringCertification(load, { harness: 'claude', harnessVersion: '2.1.283', operatingSystem: OS, nowMs: Date.now(), featureId }).covered !== null;
  assert.equal(covered('hooks.context'), true, 'conforming deliveries change nothing');
  assert.equal(await recordLiveEvent(home, { harness: 'claude', version: '2.1.283', featureId: 'hooks.context', conforming: false, reasonCode: 'SCHEMA_MISMATCH' }), true);
  const evidence = await readLiveEvidence(home);
  assert.deepEqual(evidence.counts.claude['2.1.283']['hooks.context'], { conforming: 3, malformed: 1 });
  load = await loadCertifications(home, { root });
  assert.equal(covered('hooks.context'), false, 'demoted: actuation of hooks.context waits');
  assert.equal(covered('hooks.observe'), true, 'observation goes on');
  assert.equal(load.records[0].demoted[0].reasonCode, 'SCHEMA_MISMATCH');
  assert.equal(load.records[0].signed.features.find((item) => item.featureId === 'hooks.context').status, 'certified', 'the signed record is kept as signed');
  const seam = counter();
  const first = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.1.283' }, start: seam.start, guard: seam.guard, load });
  const second = await maybeReverify({ home, root, installed: ['claude'], versions: { claude: '2.1.283' }, start: seam.start, guard: seam.guard });
  assert.equal(seam.jobs.length, 1);
  assert.equal(seam.jobs[0].reason, 'demoted');
  assert.equal(first[0].state, 'started');
  assert.equal(second[0].state, 'running');
  const line = await doctor(home, '2.1.283', { reverifyStart: seam.start, reverifyGuard: seam.guard });
  assert.match(line, /; not certified here: hooks\.context \(LIVE_EVENT_MALFORMED\); optional, not certified here: access\.detect \(ACCESS_DETECT_CASE_FAILED\), access\.session \(ACCESS_SESSION_CASE_FAILED\); re-checking in the background, no model call$/);
  assert.equal(doctorLineSeverity(line), 'info');
  // The re-check passes: a record certified after the demotion lifts it.
  await certify(home, '2.1.283');
  load = await loadCertifications(home, { root });
  assert.equal(covered('hooks.context'), true);
});

test('live evidence is owner-only names and counts, refuses anything else, and survives concurrent writers', async (t) => {
  const home = tempHome(t);
  assert.equal(await recordLiveEvent(home, { harness: 'claude', version: 'not a version', featureId: 'hooks.context', conforming: true }), false);
  assert.equal(await recordLiveEvent(home, { harness: 'gemini', version: '1.0.0', featureId: 'hooks.context', conforming: true }), false);
  assert.equal(await recordLiveEvent(home, { harness: 'claude', version: '1.0.0', featureId: 'prompt text', conforming: true }), false);
  await Promise.all(Array.from({ length: 40 }, () => recordLiveEvent(home, { harness: 'codex', version: '0.157.1', featureId: 'hooks.observe', conforming: true })));
  const evidence = await readLiveEvidence(home);
  assert.equal(evidence.counts.codex['0.157.1']['hooks.observe'].conforming, 40);
  await recordLiveEvent(home, { harness: 'codex', version: '0.157.1', featureId: 'hooks.observe', conforming: false, reasonCode: 'lower case is not a code' });
  assert.equal((await readLiveEvidence(home)).demotions[0].reasonCode, 'MALFORMED_EVENT');
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs');
    const { jevrisPaths } = await import('../../../packages/platform/dist/index.js');
    const file = join(jevrisPaths({ home }).data, 'live-evidence', 'events.jsonl');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});
