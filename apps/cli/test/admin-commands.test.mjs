import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostSkip } from '../../../test/managed-host.mjs';

// Domain B administration commands: kill switch (GOV-02..04), store (DATA-01, DATA-13),
// audit (GOV-10), data purge (DATA-11) and authorize (GOV-09). Each runs against a real
// sidecar in a temporary home.

const { runRuntimeCommand } = await import('../dist/runtime-commands.js');
const { jevrisPaths } = await import('@jevris/platform');
const here = dirname(fileURLToPath(import.meta.url));
const SIDECAR_MAIN = join(here, '..', '..', 'sidecar', 'dist', 'main.js');
const posix = process.platform !== 'win32';

function capture() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

async function withHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jva-')));
  const previous = process.env.JEVRIS_SIDECAR_ENTRY;
  process.env.JEVRIS_SIDECAR_ENTRY = SIDECAR_MAIN;
  const run = async (argv, hooks = {}) => {
    const out = capture();
    const code = await runRuntimeCommand([...argv, '--home', home], out.write, { actor: 'tester', interactive: () => false, ...hooks });
    return { code, text: out.text() };
  };
  try {
    await fn({ home, run });
  } finally {
    await runRuntimeCommand(['sidecar', 'stop', '--home', home], () => undefined);
    if (previous === undefined) delete process.env.JEVRIS_SIDECAR_ENTRY;
    else process.env.JEVRIS_SIDECAR_ENTRY = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('kill switch: activate needs no rollback file and writes no drill record; clear needs a terminal; drill records only after its checks (GOV-03, GOV-04)', { skip: managedHostSkip() }, async () => {
  await withHome(async ({ home, run }) => {
    const config = jevrisPaths({ home }).config;
    let r = await run(['kill-switch', 'status']);
    assert.equal(r.code, 0);
    assert.match(r.text, /kill switch: clear/);

    assert.equal((await run(['sidecar', 'start'])).code, 0);
    r = await run(['kill-switch', 'activate', '--reason', 'incident 42']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /kill switch: stopped/);
    assert.match(r.text, /store: done \(0 pending effect\(s\) held for reconciliation; audit row \d+\)/);
    assert.equal(existsSync(join(config, 'kill-switch-drill.json')), false, 'activation never writes a drill record');
    assert.equal(existsSync(join(config, 'policy-previous.json')), false, 'no rollback file was needed');

    r = await run(['kill-switch', 'status', '--json']);
    const status = JSON.parse(r.text);
    assert.equal(status.state, 'stopped');
    assert.equal(status.recorded, 'set');
    assert.equal(status.actor, 'tester');
    assert.equal(status.reason, 'incident 42');
    assert.match((await run(['kill-switch', 'status'])).text, /^your flag: set \S+ by tester via /m);

    r = await run(['kill-switch', 'clear']);
    assert.equal(r.code, 2, 'a non-interactive clear (MCP, a hook or a script) is refused');
    assert.match(r.text, /interactive terminal/);
    assert.match((await run(['kill-switch', 'status'])).text, /stopped/);

    r = await run(['kill-switch', 'clear'], { interactive: () => true });
    assert.equal(r.code, 0, r.text);
    // The record is now the audited clear, and status says so rather than "set".
    const cleared = (await run(['kill-switch', 'status'])).text;
    assert.match(cleared, /kill switch: clear/);
    assert.match(cleared, /^your flag: cleared \S+ by tester via terminal$/m);
    assert.doesNotMatch(cleared, /your flag: set/);
    assert.equal(JSON.parse((await run(['kill-switch', 'status', '--json'])).text).recorded, 'cleared');

    r = await run(['kill-switch', 'drill'], { interactive: () => true });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /drill: passed/);
    assert.match(r.text, /sidecar: ok/);
    const record = JSON.parse(readFileSync(join(config, 'kill-switch-drill.json'), 'utf8'));
    assert.equal(record.passed, true);
    assert.deepEqual(record.checks, ['activate', 'sidecar', 'fail-closed', 'restore']);
    assert.match((await run(['kill-switch', 'status'])).text, /kill switch: clear/, 'the drill restored the previous state');

    // The store audit carries the activation, clear and drill.
    const exportPath = join(home, 'audit.jsonl');
    assert.equal((await run(['audit', 'export', exportPath])).code, 0);
    const kinds = readFileSync(exportPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
    for (const kind of ['kill-switch.activate', 'kill-switch.clear', 'kill-switch.drill']) assert.ok(kinds.includes(kind), kind);
  });
});

test('store backup, export, migrate --dry-run and restore; output paths are confined (DATA-13, GOV-11)', async () => {
  await withHome(async ({ home, run }) => {
    assert.equal((await run(['sidecar', 'start'])).code, 0);
    const backup = join(home, 'backups', 'one.db');
    mkdirSync(dirname(backup));
    let r = await run(['store', 'backup', backup]);
    assert.equal(r.code, 0, r.text);
    if (posix) assert.equal(statSync(backup).mode & 0o777, 0o600);

    r = await run(['store', 'backup', backup]);
    assert.equal(r.code, 2);
    assert.match(r.text, /PATH_EXISTS/);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'jvo-')));
    try {
      r = await run(['store', 'backup', join(outside, 'x.db')]);
      assert.equal(r.code, 2);
      assert.match(r.text, /PATH_OUTSIDE_HOME/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    r = await run(['store', 'export', join(home, 'store.jsonl')]);
    assert.equal(r.code, 0, r.text);
    const lines = readFileSync(join(home, 'store.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.table === 'schema_meta'));
    assert.equal(lines.some((line) => line.table === 'authorization_receipt'), false);

    r = await run(['store', 'migrate', '--dry-run']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /nothing pending/);
    assert.match(r.text, /Nothing was changed/);

    r = await run(['store', 'restore', backup]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /store restore: installed/);
    assert.match(r.text, /previous store was kept/);

    writeFileSync(join(home, 'junk.db'), 'not a database');
    r = await run(['store', 'restore', join(home, 'junk.db')]);
    assert.equal(r.code, 1);
    assert.match(r.text, /refused \(backup-(corrupt|unreadable)\)/);

    r = await run(['store', 'status']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /schema version \d+/);
  });
});

test('audit verify, data purge --dry-run and authorize from a terminal only (GOV-09, GOV-10, DATA-11)', async () => {
  await withHome(async ({ run }) => {
    let r = await run(['audit', 'verify']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /audit log: intact/);

    r = await run(['data', 'purge', '--dry-run']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /would be removed/);
    assert.match(r.text, /raw artifacts 7 days, decisions 30 days/);

    r = await run(['authorize', 'data.delete', '--scope', 'ledger']);
    assert.equal(r.code, 2, 'not from a script or MCP');
    r = await run(['authorize', 'data.delete', '--scope', 'ledger', '--ttl-minutes', '5'], { interactive: () => true });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /authorized: data.delete on ledger, single use/);
    r = await run(['authorize', 'data.delete', '--scope', 'ledger', '--ttl-minutes', '30'], { interactive: () => true });
    assert.equal(r.code, 2, 'longer than 15 minutes is refused');
    r = await run(['authorize', 'grant.everything', '--scope', 'x'], { interactive: () => true });
    assert.equal(r.code, 2);
    // ORC-10 (W09): a budget increase is its own action class, scoped to the budget id.
    r = await run(['authorize', 'budget.increase', '--scope', 'sprint-1'], { interactive: () => true });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /authorized: budget.increase on sprint-1, single use/);
  });
});

test('jevris help covers every domain B command', async () => {
  for (const command of ['sidecar', 'kill-switch', 'store', 'audit', 'data', 'authorize']) {
    const out = capture();
    assert.equal(await runRuntimeCommand(['help', command], out.write), 0);
    assert.match(out.text(), /^Usage: jevris /, command);
  }
  const out = capture();
  assert.equal(await runRuntimeCommand(['store', '--help'], out.write), 0);
  assert.match(out.text(), /backup/);
});

test('activation restores the previous compatible host policy when one was staged, and audits its id (GOV-03, US40)', async () => {
  const host = {
    schemaVersion: '1.0',
    mode: 'advise',
    egress: 'deny-until-approved',
    retention: { rawArtifactRetentionDays: 7, decisionRetentionDays: 30 },
    budget: { maxRequestBytes: 65536 },
    pin: { model: 'jev-1.13.0', respectHumanPins: true },
    packPrivileges: [],
    credentialRef: 'host-secret:typesafe-primary',
    installerEnvName: 'JEVRIS_INSTALLER_KEY',
    allowUncalibratedActuation: false,
  };
  await withHome(async ({ home, run }) => {
    const config = jevrisPaths({ home }).config;
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'host.json'), `${JSON.stringify(host)}\n`);
    const previous = `${JSON.stringify({ ...host, mode: 'observe' })}\n`;
    writeFileSync(join(config, 'policy-previous.json'), previous);
    writeFileSync(join(config, 'policy-active.json'), `${JSON.stringify(host)}\n`);
    assert.equal((await run(['sidecar', 'start'])).code, 0);
    const r = await run(['kill-switch', 'activate', '--json']);
    assert.equal(r.code, 0, r.text);
    const body = JSON.parse(r.text);
    assert.match(body.policyRestored, /^sha256:[a-f0-9]{16}$/);
    assert.equal(body.steps.find((step) => step.step === 'policy').ok, true);
    assert.equal(readFileSync(join(config, 'policy-active.json'), 'utf8'), previous);
    const exportPath = join(home, 'audit.jsonl');
    assert.equal((await run(['audit', 'export', exportPath])).code, 0);
    const row = readFileSync(exportPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.kind === 'kill-switch.activate');
    assert.equal(row.detail.policyRestored, body.policyRestored);
    assert.equal(row.actor, 'tester');
    assert.equal(row.channel, 'cli');
    assert.deepEqual(row.detail.heldIds, []);
  });
  await withHome(async ({ run }) => {
    const r = await run(['kill-switch', 'activate', '--json']);
    const body = JSON.parse(r.text);
    assert.equal(body.policyRestored, null);
    assert.equal(body.steps.find((step) => step.step === 'policy').detail, 'no previous policy');
  });
});

test('data delete removes every kill-switch file while the switch is clear, and refuses while it is stopped (GOV-04, DATA-12)', { skip: managedHostSkip() }, async () => {
  const { killSwitchDataPaths, purgeKillSwitchData } = await import('../dist/kill-switch.js');
  await withHome(async ({ home, run }) => {
    // Clear: activate, clear and drill leave the flag, the log and the drill record behind.
    assert.equal((await run(['kill-switch', 'activate'])).code, 0);
    assert.equal((await run(['kill-switch', 'clear'], { interactive: () => true })).code, 0);
    assert.equal((await run(['kill-switch', 'drill'], { interactive: () => true })).code, 0);
    const present = killSwitchDataPaths(home).filter((path) => existsSync(path));
    assert.ok(present.length >= 3, `expected the flag, log and drill record: ${present.join(', ')}`);
    const purged = await purgeKillSwitchData(home);
    assert.equal(purged.ok, true);
    assert.deepEqual([...purged.removed].sort(), [...present].sort());
    assert.deepEqual(killSwitchDataPaths(home).filter((path) => existsSync(path)), []);
    assert.equal((await purgeKillSwitchData(home)).ok, true, 'a second delete finds nothing and succeeds');
  });
  await withHome(async ({ home, run }) => {
    // Stopped: the delete refuses and keeps every file, so the stop is never lifted silently.
    assert.equal((await run(['kill-switch', 'activate'])).code, 0);
    const before = killSwitchDataPaths(home).filter((path) => existsSync(path)).map((path) => [path, readFileSync(path, 'utf8')]);
    const refused = await purgeKillSwitchData(home);
    assert.equal(refused.ok, false);
    assert.equal(refused.reasonCode, 'KILL_SWITCH_ACTIVE');
    assert.match(refused.message, /jevris kill-switch clear/);
    for (const [path, text] of before) assert.equal(readFileSync(path, 'utf8'), text, path);
    assert.match((await run(['kill-switch', 'status'])).text, /stopped/);
    // A damaged flag counts as stopped too.
    writeFileSync(killSwitchDataPaths(home)[0], '{not json');
    assert.equal((await purgeKillSwitchData(home)).reasonCode, 'KILL_SWITCH_ACTIVE');
  });
});
