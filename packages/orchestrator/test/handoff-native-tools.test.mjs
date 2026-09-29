// Harness parity audit G10: a handoff names each harness's tools as that harness reports them.
// Kilo's CLI reports OpenCode's names, not the legacy VS Code extension's; Antigravity's are the
// ones its hook payloads carry (the adapter fixtures), so its tools no longer all import as
// unresolved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_TOOLS } from '../dist/index.js';

const { FIXTURES: AGY_FIXTURES } = await import('../../adapter-antigravity/dist/protocol.js');

test('Kilo takes OpenCode tool names', () => {
  assert.deepEqual([...NATIVE_TOOLS.kilocode], [...NATIVE_TOOLS.opencode]);
  for (const legacy of ['read_file', 'execute_command', 'apply_diff']) assert.equal(NATIVE_TOOLS.kilocode.includes(legacy), false, legacy);
});

test('Antigravity names every tool its adapter fixtures carry', () => {
  assert.ok(NATIVE_TOOLS.antigravity.length > 0);
  const named = new Set(AGY_FIXTURES.map((f) => f.native?.toolCall?.name).filter((name) => typeof name === 'string'));
  assert.ok(named.size > 0, 'the fixtures name at least one tool');
  for (const name of named) assert.ok(NATIVE_TOOLS.antigravity.includes(name), name);
  for (const name of ['run_command', 'write_to_file', 'replace_file_content', 'view_file']) assert.ok(NATIVE_TOOLS.antigravity.includes(name), name);
  for (const list of Object.values(NATIVE_TOOLS)) assert.equal(new Set(list).size, list.length, 'no duplicates');
});
