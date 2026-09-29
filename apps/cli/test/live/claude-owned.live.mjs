// ORC-05 live check: a real Claude Code owned session through the installed CLI. Never part of
// `npm test` (scripts/test.mjs collects only apps/cli/test/*.test.mjs). It makes model calls
// (billed to a key, or counted against the subscription's usage), so it runs only with
// JEVRIS_LIVE_HARNESS=1 and a model, in a temporary HOME and CLAUDE_CONFIG_DIR, never the
// owner's profile. A subscription login and an API key are both first-class (owner decision
// 2026-09-26); the credential comes from the environment only, and no auth file is copied:
//
//   Subscription: JEVRIS_LIVE_HARNESS=1 CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token> JEVRIS_LIVE_CLAUDE_MODEL=<model> \
//                   node --test apps/cli/test/live/claude-owned.live.mjs
//   API key:      JEVRIS_LIVE_HARNESS=1 ANTHROPIC_API_KEY=<key> JEVRIS_LIVE_CLAUDE_MODEL=<model> \
//                   node --test apps/cli/test/live/claude-owned.live.mjs
//
// With both set, JEVRIS_LIVE_CLAUDE_AUTH=subscription|api-key picks one (default: the key, as
// D's `auto` does). It checks what the stub cannot: the session's init reports the decided auth
// source, the model answers, the session writes in its worktree, and an abort stops a real turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const { runClaudeWorker } = await import('../../dist/claude-worker.js');

const model = process.env.JEVRIS_LIVE_CLAUDE_MODEL;
const key = process.env.ANTHROPIC_API_KEY ?? '';
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
const stated = process.env.JEVRIS_LIVE_CLAUDE_AUTH;
const auth = stated === 'subscription' || stated === 'api-key' ? stated : key !== '' ? 'api-key' : 'subscription';
const skip =
  process.env.JEVRIS_LIVE_HARNESS !== '1'
    ? 'set JEVRIS_LIVE_HARNESS=1 (live run)'
    : model === undefined || model === ''
      ? 'set JEVRIS_LIVE_CLAUDE_MODEL to the model to select at start'
      : auth === 'api-key' && key === ''
        ? 'api-key mode: set ANTHROPIC_API_KEY'
        : auth === 'subscription' && token === ''
          ? 'subscription mode: set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token; the temporary profile has no login)'
          : false;

/** `claude` on PATH as an absolute path (an injected path, so the test-context guard allows it). */
function claudeOnPath() {
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // next
      }
    }
  }
  return null;
}

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jevris-claude-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'worktree');
  const home = join(dir, 'home');
  mkdirSync(work);
  mkdirSync(join(home, '.claude'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: work }).status, 0);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string') env[name] = value;
  // A temporary HOME and CLAUDE_CONFIG_DIR: never the owner's profile. The worker shapes the
  // environment for the mode (no key on a subscription run, no token on a key run).
  return { work, env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') } };
}

test(`a real Claude Code owned session (${auth}) reports its auth, answers and writes in its worktree`, { skip, timeout: 600_000 }, async (t) => {
  const claude = claudeOnPath();
  assert.ok(claude !== null, 'Claude Code (claude) is not on PATH');
  const box = sandbox(t);
  const outcome = await runClaudeWorker({
    prompt: 'Create a file named hello.txt in the current directory containing exactly the word hi. Do nothing else.',
    model,
    cwd: box.work,
    allowedTools: ['Read', 'Write'],
    maxTurns: 10,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    command: { file: claude },
    env: box.env,
    auth,
  });
  assert.equal(outcome.status, 'completed', `${outcome.status}: ${outcome.reason}`);
  assert.equal(outcome.authMode, auth);
  assert.equal(outcome.requestedModel, model);
  assert.ok(outcome.actualModel !== null, 'no answering model');
  assert.ok(outcome.sessionId !== null, 'no session id');
  assert.ok(outcome.usage !== null && outcome.usage.outputTokens > 0, 'no token usage');
  assert.equal(outcome.costUsd === null, auth === 'subscription', 'dollars only for an API key');
  assert.ok(existsSync(join(box.work, 'hello.txt')), 'the session did not write in its worktree');
  assert.match(readFileSync(join(box.work, 'hello.txt'), 'utf8'), /hi/);
});

test(`an abort stops a real Claude Code turn promptly (${auth})`, { skip, timeout: 600_000 }, async (t) => {
  const claude = claudeOnPath();
  assert.ok(claude !== null, 'Claude Code (claude) is not on PATH');
  const box = sandbox(t);
  const controller = new AbortController();
  const running = runClaudeWorker({
    prompt: 'Count from 1 to 5000, writing each number on its own line in numbers.txt, one command per number.',
    model,
    cwd: box.work,
    allowedTools: ['Read', 'Write', 'Bash'],
    maxTurns: 500,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    command: { file: claude },
    env: box.env,
    auth,
    onEvent: (event) => {
      if (event.type === 'system' && event.subtype === 'init') setTimeout(() => controller.abort(), 3_000);
    },
    signal: controller.signal,
  });
  const started = Date.now();
  const outcome = await running;
  assert.equal(outcome.status, 'aborted', `${outcome.status}: ${outcome.reason}`);
  assert.ok(Date.now() - started < 120_000);
});
