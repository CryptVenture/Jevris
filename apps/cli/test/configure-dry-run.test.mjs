// JEV-0010: `jevris configure set ... --dry-run` says what would change and that nothing was written.
// Its summary never reads "Changed ...", and the human output ends with a dry-run line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEVRIS_SIDECAR_AUTOSTART = '0';

const { runPublicCommand } = await import('../dist/public-commands.js');

const NOT_RUNNING = { ok: false, reason: 'unavailable', reasonCode: 'NOT_RUNNING', message: 'The Jevris sidecar is not running.' };

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-cfgdry-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(join(workspace, '.git'), { recursive: true });
  return { home, workspace, env: { JEVRIS_HOME: home, JEVRIS_SIDECAR_AUTOSTART: '0' } };
}

const ports = {
  sidecar: {
    async ensure() {
      return { ok: true, endpoint: 'fake', started: false };
    },
    async request() {
      return NOT_RUNNING;
    },
  },
  engine: {},
  config: {},
};

async function configure(box, argv) {
  let text = '';
  const code = await runPublicCommand('configure', argv, (chunk) => (text += chunk), { ports, env: box.env, cwd: box.workspace, nowMs: () => Date.UTC(2026, 8, 25) });
  return { code, text };
}

test('JEV-0010: a dry-run set says "Would change", carries dryRun, and writes nothing', async (t) => {
  const box = sandbox(t);
  const dry = await configure(box, ['set', 'mode', 'advise', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.text);
  const value = JSON.parse(dry.text.trimEnd());
  assert.equal(value.result.dryRun, true);
  assert.deepEqual(value.result.changed.map((c) => c.key), ['mode']);
  assert.match(value.summary, /^Would change mode; nothing was written/);
  assert.doesNotMatch(value.summary, /^Changed/);
  assert.equal(existsSync(join(box.home, 'config')), false, 'nothing was written under the home');

  const human = await configure(box, ['set', 'mode', 'advise', '--dry-run']);
  assert.equal(human.code, 0, human.text);
  assert.match(human.text, /Would change mode/);
  assert.match(human.text, /changed: mode \S+ -> advise/);
  assert.match(human.text, /dry run: nothing was written/);
});

test('JEV-0010: a real set still says "Changed" and carries no dryRun', async (t) => {
  const box = sandbox(t);
  const real = await configure(box, ['set', 'mode', 'advise', '--json']);
  assert.equal(real.code, 0, real.text);
  const value = JSON.parse(real.text.trimEnd());
  assert.equal(value.result.dryRun, undefined);
  assert.match(value.summary, /^Changed mode; native permissions were not changed/);
});
