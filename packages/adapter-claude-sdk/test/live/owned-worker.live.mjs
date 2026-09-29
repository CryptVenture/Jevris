// ORC-05 / E-13 live check, API-key variant: a real Claude Agent SDK owned worker (the SDK runs
// only with ANTHROPIC_API_KEY; the subscription-login variant is
// packages/orchestrator/test/live/owned-worker-auth.live.mjs). Never part of `npm test`
// (scripts/test.mjs collects only <workspace>/test/*.test.mjs). It makes billed model calls,
// so it runs only when asked, with an Anthropic API key in the environment (never in argv)
// and a model id:
//
//   JEVRIS_LIVE_HARNESS=1 ANTHROPIC_API_KEY=<key> JEVRIS_LIVE_CLAUDE_MODEL=<model> \
//     node --test packages/adapter-claude-sdk/test/live/owned-worker.live.mjs
//
// It runs against a temporary CLAUDE_CONFIG_DIR, so the user's Claude settings are neither read
// nor changed. It checks what the scripted port cannot: the SDK loads, the session works in its
// worktree with only the granted tools, the actual model, usage and cost come back, the spend
// cap is passed through, and an abort stops a real turn promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runOwnedWorker } = await import('../../dist/index.js');

const model = process.env.JEVRIS_LIVE_CLAUDE_MODEL;
const key = process.env.ANTHROPIC_API_KEY;
const skip =
  process.env.JEVRIS_LIVE_HARNESS !== '1'
    ? 'set JEVRIS_LIVE_HARNESS=1 (billed live run)'
    : model === undefined || model === ''
      ? 'set JEVRIS_LIVE_CLAUDE_MODEL to the Claude model the worker should use'
      : key === undefined || key === ''
        ? 'set ANTHROPIC_API_KEY (the temporary config dir has no login)'
        : false;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'jv-live-sdk-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config');
  return {
    dir,
    done() {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a live owned worker writes in its worktree with the granted tools and reports model, usage and cost (ORC-05, E-13)', { skip, timeout: 240_000 }, async () => {
  const s = sandbox();
  try {
    const events = [];
    const outcome = await runOwnedWorker({
      prompt: 'Create a file named hello.txt in the current directory whose whole content is the text live-ok (no newline). Then stop.',
      model,
      cwd: s.dir,
      allowedTools: ['Write', 'Read'],
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      timeoutMs: 180_000,
      onEvent: (e) => events.push(e.type),
    });
    assert.equal(outcome.status, 'completed', outcome.reason);
    assert.equal(readFileSync(join(s.dir, 'hello.txt'), 'utf8').trim(), 'live-ok');
    assert.equal(typeof outcome.sessionId, 'string');
    assert.equal(typeof outcome.actualModel, 'string');
    assert.ok(outcome.costUsd !== null && outcome.costUsd > 0 && outcome.costUsd <= 0.5, String(outcome.costUsd));
    assert.ok(outcome.usage !== null && outcome.usage.outputTokens > 0);
    assert.ok(events.includes('result'));
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(key.slice(-12)), 'the key never appears in the outcome');
  } finally {
    s.done();
  }
});

test('a live owned worker stops promptly on abort and writes nothing more (ORC-05, E-13)', { skip, timeout: 120_000 }, async () => {
  const s = sandbox();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const outcome = await runOwnedWorker({
      prompt: 'Write fifty files named f1.txt to f50.txt, one at a time, each holding a long paragraph about lighthouses.',
      model,
      cwd: s.dir,
      allowedTools: ['Write'],
      maxTurns: 60,
      maxBudgetUsd: 0.5,
      timeoutMs: 100_000,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'assistant') controller.abort();
      },
    });
    assert.equal(outcome.status, 'aborted', outcome.reason);
    assert.ok(Date.now() - started < 60_000, 'the abort stopped the turn');
    assert.equal(existsSync(join(s.dir, 'f50.txt')), false);
  } finally {
    s.done();
  }
});
