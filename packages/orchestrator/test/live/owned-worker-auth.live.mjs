// ORC-05 / E-13 live check of owned-worker selection by auth mode (owner decision 2026-09-26).
// Never part of `npm test` (scripts/test.mjs collects only <workspace>/test/*.test.mjs). It makes
// real model calls, so it runs only when asked, with credentials in the environment only (never
// in argv, never copied from credential files), against a temporary CLAUDE_CONFIG_DIR:
//
//   Subscription login (the Claude Code CLI worker; token from `claude setup-token`):
//     JEVRIS_LIVE_HARNESS=1 CLAUDE_CODE_OAUTH_TOKEN=<token> JEVRIS_LIVE_CLAUDE_MODEL=<model> \
//       node --test packages/orchestrator/test/live/owned-worker-auth.live.mjs
//
//   API key (the Agent SDK when installed, else the CLI worker with the key):
//     JEVRIS_LIVE_HARNESS=1 ANTHROPIC_API_KEY=<key> JEVRIS_LIVE_CLAUDE_MODEL=<model> \
//       node --test packages/orchestrator/test/live/owned-worker-auth.live.mjs
//
// Either variant runs when its credential is present; both run when both are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadWorkerPort } = await import('../../dist/index.js');

const model = process.env.JEVRIS_LIVE_CLAUDE_MODEL;
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const key = process.env.ANTHROPIC_API_KEY;
const live = process.env.JEVRIS_LIVE_HARNESS === '1' && model !== undefined && model !== '';
const why = (name) => (process.env.JEVRIS_LIVE_HARNESS !== '1' ? 'set JEVRIS_LIVE_HARNESS=1 (live run)' : !live ? 'set JEVRIS_LIVE_CLAUDE_MODEL' : `set ${name}`);

async function runOnce(env, expectedMode) {
  const dir = mkdtempSync(join(tmpdir(), 'jv-live-auth-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config');
  try {
    const port = await loadWorkerPort({}, { env });
    assert.notEqual(port, null, 'a worker port loads');
    const outcome = await port.run({
      prompt: 'Create a file named hello.txt in the current directory whose whole content is the text live-ok (no newline). Then stop.',
      model,
      cwd: dir,
      allowedTools: ['Write', 'Read'],
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      timeoutMs: 180_000,
      signal: new AbortController().signal,
    });
    if (outcome.status === 'usage-limit') return outcome; // the subscription's limit is a valid, recorded outcome
    assert.equal(outcome.status, 'completed', outcome.reason);
    assert.equal(outcome.authMode, expectedMode);
    assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8').trim(), 'live-ok');
    for (const secret of [oauth, key]) if (secret) assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret.slice(-12)));
    return outcome;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('subscription login: a Claude model runs through the Claude Code CLI worker, never the Agent SDK (ORC-05)', { skip: live && oauth ? false : why('CLAUDE_CODE_OAUTH_TOKEN'), timeout: 240_000 }, async () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  await runOnce(env, 'subscription');
});

test('API key: a Claude model runs through the Agent SDK (or the CLI worker with the key) (ORC-05)', { skip: live && key ? false : why('ANTHROPIC_API_KEY'), timeout: 240_000 }, async () => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  await runOnce(env, 'api-key');
});
