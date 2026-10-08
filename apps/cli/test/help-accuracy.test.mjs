// The help says what the product does (coordinator's docs audit, 008db65..5917f3c). Each claim is
// checked against the built product, and each check is paired with the case it must catch:
// - every global option the CLI accepts is listed: --no-color is listed and accepted;
// - every model id in the route help is a current, usable model in the bundled registry (the
//   retired ids the audit found are not), and every example in the route help runs;
// - the effort levels the help names are the ones route learning explores on the baseline model;
// - the help's default for managed workers is the default the product reports (observe), and it
//   no longer says routing is "active from install";
// - every option the learning help lists is one the command accepts (an unlisted one is refused),
//   and every reset flag it names reaches the machine-wide layer as it says (C 7bea448);
// - the verify help's words for a running or queued check are the words verify prints, and an
//   unapproved check is refused with exit 2 as it says (D 21e3481).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sandbox } from '../../../test/acceptance/lib.mjs';

const core = await import('@jevris/core');

/** The lines under a help section heading, up to the next blank line. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === heading);
  assert.ok(start >= 0, `no ${heading} section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === '');
  return end < 0 ? rest : rest.slice(0, end);
}

test('the global options in jevris --help list --no-color, and the CLI accepts it', async (t) => {
  const box = await sandbox(t);
  const help = box.jevris(['--help']);
  assert.equal(help.code, 0, help.stderr);
  const flags = section(help.stdout, 'Global options:').map((line) => line.trim().split(/\s+/)[0]);
  assert.ok(flags.includes('--no-color'), flags.join(' '));
  // Pair: the listed flag is accepted and changes no words (a pipe is plain either way).
  const plain = box.jevris(['--version']);
  const withFlag = box.jevris(['--no-color', '--version']);
  assert.deepEqual([withFlag.code, withFlag.stdout], [plain.code, plain.stdout]);
});

test('the route help names only current models, and every example in it runs', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const help = box.jevris(['route', '--help']);
  assert.equal(help.code, 0, help.stderr);
  // The help is written against the bundled registry's snapshot, so a model counts as current if
  // the registry treated it as usable on its fetch date, not on the day the suite runs.
  // pinned-clock: the registry's fetchedOn, the date the help's model names were checked against.
  const now = Date.parse(core.BUNDLED_MODEL_REGISTRY.fetchedOn);
  assert.ok(Number.isFinite(now), core.BUNDLED_MODEL_REGISTRY.fetchedOn);
  const usable = (id) => {
    const model = core.registryModel(core.BUNDLED_MODEL_REGISTRY, id);
    return model !== null && core.lifecycleCheck(model, now).usable;
  };
  const ids = [...new Set(help.stdout.match(/\bclaude-[a-z0-9-]+/g) ?? [])];
  assert.ok(ids.includes(core.BUNDLED_MODEL_REGISTRY.baselineModelId), `the baseline model is not in the examples: ${ids.join(', ')}`);
  for (const id of ids) assert.ok(usable(id), `${id} in the route help is not a current model`);
  // Pair: the ids the audit found are not current, so the check above catches them.
  for (const old of ['claude-opus-4-7', 'claude-sonnet-4-6']) assert.equal(usable(old), false, old);

  const examples = help.stdout.split('\n').filter((line) => /^ {2}jevris route /.test(line)).map((line) => line.trim().split(/\s+/).slice(1));
  assert.ok(examples.length >= 6, String(examples.length));
  for (const argv of examples) {
    const r = box.jevris(argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

test('the effort levels in the learning help are the ones route learning explores on the baseline model', async (t) => {
  const box = await sandbox(t);
  const help = box.jevris(['route', 'learning', '--help']).stdout;
  const baseline = core.BUNDLED_MODEL_REGISTRY.baselineModelId;
  const explored = [...new Set([core.defaultEffortOf(baseline), ...core.learningSettings().effortArms])];
  const named = /learning tries Sonnet 5\.5 at ([a-z, ]+) effort/.exec(help.replace(/\n/g, ' '))?.[1]?.split(/, | and /) ?? [];
  assert.deepEqual([...named].sort(), [...explored].sort(), help);
  assert.match(help, new RegExp(`\\(${baseline}\\) at its default\\s+effort, ${core.defaultEffortOf(baseline)}`));
});

test('the learning help gives the managed-worker default the product reports: bounded-auto, with orchestration on from install', async (t) => {
  const box = await sandbox(t);
  const shown = box.jevris(['configure', 'show'], { json: true });
  assert.equal(shown.code, 0, shown.stderr);
  const { managedWorkers: managed, orchestrationEnabled } = shown.json.result.effective;
  // On a fresh home managed workers are bounded-auto (D 5061525) and orchestration is on (owner decision 5f7053f):
  // a worker still starts only when a person submits a plan.
  assert.deepEqual([managed, orchestrationEnabled], ['bounded-auto', true]);
  const help = box.jevris(['route', 'learning', '--help']).stdout.replace(/\s+/g, ' ');
  assert.match(help, new RegExp(`The default is ${managed} with orchestration on, so owned workers start when a person submits a plan, within its budget, the kill switch and certification\\.`));
  assert.match(help, /managed workers start only when orchestration is enabled, routing\.managedWorkers is bounded-auto and the kill switch is off/);
  assert.doesNotMatch(help, /active from install/);
  // D 563be43: an uncertified harness only advises.
  assert.match(help, /On a harness not certified for worker\.route \(jevris certify\), routing only advises/);
});

test('every option in the learning help is accepted, and reset --machine and --clear-evidence do what it says to the machine-wide learning (C16, C 7bea448)', async (t) => {
  const box = await sandbox(t);
  box.write('work/src/a.js', 'export const a = 1;\n');
  box.gitInit();
  const help = box.jevris(['route', 'learning', '--help']).stdout;
  const options = section(help, 'Options:').map((line) => line.trim().split(/\s+/)[0]).filter((word) => word.startsWith('--'));
  for (const flag of ['--clear-evidence', '--machine']) assert.ok(options.includes(flag), options.join(' '));
  assert.match(help, /jevris route learning reset \[--clear-evidence \| --machine\]/);
  // Each reset flag the help lists is accepted; an unlisted one is a usage error.
  for (const flag of ['--clear-evidence', '--machine']) {
    const run = box.jevris(['route', 'learning', 'reset', flag, '--yes'], { json: true });
    assert.equal(run.code, 0, `${flag}: ${run.stdout} ${run.stderr}`);
  }
  assert.equal(box.jevris(['route', 'learning', 'reset', '--everything', '--yes']).code, 2);
  // What the help says each does, checked against the product's own answers.
  const flat = help.replace(/\s+/g, ' ');
  assert.match(flat, /--clear-evidence, which also deletes them and withdraws this workspace's share of the learning shared across the workspaces on this machine/);
  // This workspace's local calibration cases file (C 01c1e29) goes with the evidence.
  const { workspaceIdFor } = await import('../dist/public/context.js');
  const casesFile = core.localCalibrationFile(box.home, workspaceIdFor(box.work));
  mkdirSync(dirname(casesFile), { recursive: true });
  writeFileSync(casesFile, '{}\n');
  const cleared = box.jevris(['route', 'learning', 'reset', '--clear-evidence', '--yes']).stdout;
  assert.match(cleared, /this workspace's share of the machine-wide learning was withdrawn/);
  assert.match(flat, /from the store and its local calibration cases file/);
  assert.match(cleared, /This workspace's local calibration cases file was removed \(REMOVED\)\./);
  assert.equal(existsSync(casesFile), false);
  // The store half (B's purgeStoreLearning for this workspace), reported as a reason code only.
  assert.match(flat, /and removes this workspace's learning records \(decision outcomes, advice adherence\) from the store/);
  assert.match(cleared, /This workspace's learning records in the store were removed \((?:STORE_PURGED|NO_STORE)\)\./);
  const clearedJson = box.jevris(['route', 'learning', 'reset', '--clear-evidence', '--yes'], { json: true });
  assert.ok(['STORE_PURGED', 'NO_STORE'].includes(clearedJson.json?.storePurge), clearedJson.stdout);
  assert.equal(clearedJson.json?.calibrationCases, 'REMOVED', clearedJson.stdout);
  assert.match(flat, /--machine instead clears that shared learning for every workspace; each keeps its own outcomes and policy/);
  assert.match(box.jevris(['route', 'learning', 'reset', '--machine', '--yes']).stdout, /shared by the workspaces on this machine is cleared .* Each workspace keeps its own outcomes and policy/);
});

test('the verify help says what verify prints for a running or queued check, and that an unapproved check is refused with exit 2 (D 21e3481)', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  const help = box.jevris(['verify', '--help']).stdout.replace(/\s+/g, ' ');
  const { runPublicCommand } = await import('../dist/public-commands.js');
  const check = (checkId, reasonCode) => ({ checkId, mandatory: true, outcome: 'not-run', receiptId: null, fresh: false, reasonCode, environment: null });
  const answer = (verify) => ({
    sidecar: { ensure: async () => ({ ok: true, endpoint: 'fake', started: false }), request: async () => (typeof verify === 'function' ? verify() : { ok: true, result: verify }) },
    engine: {},
    config: {},
  });
  const verify = async (ports) => {
    let text = '';
    const code = await runPublicCommand('verify', ['--check', 'test', '--check', 'lint'], (chunk) => (text += chunk), { ports, env: { JEVRIS_HOME: box.home, JEVRIS_SIDECAR_AUTOSTART: '0' }, cwd: box.work });
    return { code, text };
  };
  const shown = await verify(answer({ ran: false, readiness: 'not-verified', checks: [check('test', 'RUNNING'), check('lint', 'QUEUED')], missing: ['test', 'lint'] }));
  for (const words of ['still running in the background', 'queued behind the run under way']) {
    assert.ok(help.includes(words), `help: ${words}`);
    assert.ok(shown.text.includes(words), `output: ${words}`);
  }
  assert.ok(help.includes('run jevris verify again later to read the result'));
  assert.match(shown.text, /Run jevris verify again later to read the result\./);
  assert.match(help, /A check id that is not approved is refused \(UNKNOWN_CHECK, exit 2\), and nothing runs\./);
  const refused = await verify(answer(() => ({ ok: false, reason: 'rejected', reasonCode: 'UNKNOWN_CHECK', message: 'no approved check is named lint; jevris verify profile lists the checks' })));
  assert.equal(refused.code, 2);
  assert.match(refused.text, /UNKNOWN_CHECK.*Nothing ran\./);
});

test('the learning help\'s gone forms are accepted, gone needs no workspace as it says, and every option it lists for gone is one the command takes (C f5b19ab)', async (t) => {
  const box = await sandbox(t);
  const help = box.jevris(['route', 'learning', '--help']).stdout;
  assert.match(help, /jevris route learning gone \[list \| clear <model-id> \| clear --all\] \[--yes\] \[--json\]/);
  assert.match(help.replace(/\s+/g, ' '), /The record is per machine, so gone needs no workspace\./);
  const options = section(help, 'Options:').map((line) => line.trim().split(/\s+/)[0]);
  assert.ok(options.includes('--all'), options.join(' '));
  // The sandbox home is no repository: each form runs there.
  const outside = { cwd: box.home };
  for (const argv of [['gone'], ['gone', 'list'], ['gone', 'clear', 'claude-opus-5-5', '--yes'], ['gone', 'clear', '--all', '--yes']]) {
    const run = box.jevris(['route', 'learning', ...argv], outside);
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.doesNotMatch(run.stdout + run.stderr, /No workspace here/, argv.join(' '));
  }
  // What status is said to show, it shows.
  assert.match(help.replace(/\s+/g, ' '), /and the models found gone on this machine\./);
});

test('the configure help names exactly the keys configure set accepts (D\'s SETTABLE_KEYS), and docs/settings.md marks the same keys as yours', async (t) => {
  const box = await sandbox(t);
  const { SETTABLE_KEYS } = await import('@jevris/orchestrator');
  const settable = Object.keys(SETTABLE_KEYS).sort();
  const help = box.jevris(['configure', '--help']).stdout;
  const named = section(help, 'Settable keys (docs/settings.md gives each one\'s values):').join(' ').trim().split(/\s+/).sort();
  assert.deepEqual(named, settable);
  // docs/settings.md: every row whose "who sets it" starts with "you" is a settable key, and no other.
  const { readFileSync } = await import('node:fs');
  const all = readFileSync(new URL('../../../docs/settings.md', import.meta.url), 'utf8');
  // The "Every key" table only: from its heading to the next heading.
  const docs = all.slice(all.indexOf('## Every key')).split(/\n## /)[0];
  const yours = [...docs.matchAll(/^\| `([a-zA-Z.]+)` \| [^|]+ \| you\b/gm)].map((m) => m[1]).sort();
  assert.deepEqual(yours, settable);
  // Pair: a key the help names is one set accepts; a key outside the list is refused by name.
  const workdir = { cwd: box.home };
  assert.equal(box.jevris(['configure', 'set', 'orchestration.maxWorkerDepth', '2', '--dry-run'], workdir).code, 0);
  const refused = box.jevris(['configure', 'set', 'orchestration.maxStopContinuationsPerCondition', '2'], workdir);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout + refused.stderr, /is not a setting\. Settable: mode, /);
});
