import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function repoRoot() {
  return fileURLToPath(new URL('../../..', import.meta.url));
}

export async function assertProductHooksAbsentOrCertified() {
  const root = repoRoot();
  const hooksPath = join(root, 'plugins', 'claude', 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) return;
  const { scanHooks } = await import(pathToFileURL(join(root, 'apps', 'cli', 'dist', 'hook-scan.js')).href);
  const scanned = await scanHooks(join(root, 'plugins', 'claude'));
  assert.equal(scanned.accepted, true);
  const text = readFileSync(hooksPath, 'utf8');
  assertClaudeHooks(text);
  const plugin = JSON.parse(readFileSync(join(root, 'plugins', 'claude', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'jevris');
  assert.equal(plugin.defaultEnabled, false);
}


/** The full CLA-02 set, in the order the Claude adapter maps them. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

/**
 * The product hooks.json: every CLA-02 event runs the launcher in exec form with
 * `--harness claude` and a 5 s timeout; PreToolUse only for Agent and Task. No shell text,
 * no machine path, and nothing that could carry a permission decision.
 */
export function assertClaudeHooks(text) {
  for (const banned of ['npx', 'bash', 'jq', '|', ';', '`', '/Users/', '/Volumes/', 'permissionDecision', '"allow"', '"deny"', '"ask"']) {
    assert.equal(text.includes(banned), false, banned);
  }
  const parsed = JSON.parse(text);
  assert.equal(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), true);
  assert.deepEqual(Object.keys(parsed), ['hooks']);
  assert.deepEqual(Object.keys(parsed.hooks), CLAUDE_HOOK_EVENTS);
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    const matchers = groups.map((group) => group.matcher ?? null);
    assert.deepEqual(matchers, event === 'PreToolUse' ? ['Agent', 'Task'] : [null], event);
    for (const group of groups) {
      assert.equal(group.hooks.length, 1, event);
      assert.deepEqual(group.hooks[0], {
        type: 'command',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/bin/hook.js', '--harness', 'claude'],
        timeout: 5,
      });
    }
  }
}
