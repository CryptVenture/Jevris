// JEVRIS_SIDECAR_AUTOSTART=0 through the built product: no surface starts the sidecar. A hook
// observes (SIDECAR_AUTOSTART_OFF), the CLI and MCP answer rules-only. The sidecar entry here is a
// stand-in that only records that it was started, so a start is a durable fact, not a timing.
// The pair: without the variable, one hook delivery starts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sandbox } from '../../../test/acceptance/lib.mjs';

test('with JEVRIS_SIDECAR_AUTOSTART=0 no hook, CLI command or MCP tool starts the sidecar; without it a hook does', async (t) => {
  const box = await sandbox(t);
  box.gitInit();
  const marker = join(box.dir, 'sidecar-started.log');
  const entry = join(box.dir, 'sidecar-entry.mjs');
  writeFileSync(entry, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'started\\n');\n`);
  box.env.JEVRIS_SIDECAR_ENTRY = entry;
  const off = { JEVRIS_SIDECAR_AUTOSTART: '0' };
  const native = { hook_event_name: 'SessionStart', source: 'startup', session_id: 's-autostart', cwd: box.work };

  const hook = box.hook('claude', native, { extraEnv: off });
  assert.equal(hook.code, 0);
  assert.equal(hook.reason, 'SIDECAR_AUTOSTART_OFF', hook.stderr);
  assert.equal(hook.stdout.trim(), '', 'one observe answer: Claude reads empty stdout as no decision');

  const status = box.jevris(['status'], { json: true, extraEnv: off });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual([status.json.mode, status.json.sidecar.state], ['reduced', 'not-running']);
  const budget = box.jevris(['budget', 'status', 'b-1'], { json: true, extraEnv: off });
  assert.notEqual(budget.code, 0, 'no sidecar, no budget answer');
  const client = await box.mcp(off);
  const viaMcp = (await client.callTool({ name: 'jevris_status', arguments: {} })).structuredContent;
  assert.deepEqual([viaMcp.mode, viaMcp.sidecar.state], ['reduced', 'not-running']);

  // The pair: the same hook without the variable starts the sidecar (the stand-in records it).
  const started = box.hook('claude', { ...native, session_id: 's-autostart-2' });
  assert.equal(started.code, 0);
  for (let i = 0; i < 200 && !existsSync(marker); i += 1) await delay(50);
  assert.equal(existsSync(marker), true, 'without the variable the hook did not start the sidecar');
  assert.equal(readFileSync(marker, 'utf8'), 'started\n', 'exactly one start: none of the calls with the variable started it');
});
