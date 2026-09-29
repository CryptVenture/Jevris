// CDX-04 live check: a real Codex owned session. Never part of `npm test` (scripts/test.mjs
// collects only apps/cli/test/*.test.mjs). It makes model calls (billed to a key, or counted
// against a ChatGPT plan's usage), so it runs only with JEVRIS_LIVE_HARNESS=1 and a model, in a
// temporary CODEX_HOME, never the owner's ~/.codex. A subscription login and an API key are both
// first-class (owner decision 2026-09-26); the credential comes from the environment or the
// OS credential store, and no auth file is ever copied.
//
//   API key:      JEVRIS_LIVE_HARNESS=1 OPENAI_API_KEY=<key> JEVRIS_LIVE_CODEX_MODEL=<model> \
//                   node --test apps/cli/test/live/codex-owned.live.mjs
//   Subscription: JEVRIS_LIVE_HARNESS=1 JEVRIS_LIVE_CODEX_AUTH=subscription JEVRIS_LIVE_CODEX_MODEL=<model> \
//                   node --test apps/cli/test/live/codex-owned.live.mjs
//
// Subscription mode removes every vendor key from the run and needs a ChatGPT login that the
// temporary CODEX_HOME can see. Where Codex keeps it in the OS credential store (macOS keychain)
// the temporary home sees it. Otherwise, sign a throwaway home in yourself first
// (`CODEX_HOME=<dir> codex login`) and pass JEVRIS_LIVE_CODEX_HOME=<dir>. The worker checks
// `codex login status` before the turn and refuses, with the reason, when there is no ChatGPT
// login.
//
// It checks what the mock cannot: the model is selected at turn start, the session writes in its
// worktree under the workspace-write sandbox, the thread id and token usage come back, and an
// abort stops a real turn promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const { runCodexWorker } = await import('../../dist/codex-worker.js');

const model = process.env.JEVRIS_LIVE_CODEX_MODEL;
const key = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
// D's `auto`: an API key when one is in the environment, else the subscription login.
const auth = process.env.JEVRIS_LIVE_CODEX_AUTH === 'subscription' || process.env.JEVRIS_LIVE_CODEX_AUTH === 'api-key' ? process.env.JEVRIS_LIVE_CODEX_AUTH : key !== '' ? 'api-key' : 'subscription';
const skip =
  process.env.JEVRIS_LIVE_HARNESS !== '1'
    ? 'set JEVRIS_LIVE_HARNESS=1 (live run)'
    : model === undefined || model === ''
      ? 'set JEVRIS_LIVE_CODEX_MODEL to the Codex model to select at turn start'
      : auth === 'api-key' && key === ''
        ? 'api-key mode: set OPENAI_API_KEY or CODEX_API_KEY'
        : false;

/** `codex` on PATH as an absolute path (an injected path, so the test-context guard allows it). */
function codexOnPath() {
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `codex${ext.toLowerCase()}`);
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
  const dir = mkdtempSync(join(tmpdir(), 'jevris-codex-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'worktree');
  const prepared = process.env.JEVRIS_LIVE_CODEX_HOME;
  const codexHome = auth === 'subscription' && prepared !== undefined && prepared !== '' ? prepared : join(dir, 'codex-home');
  mkdirSync(work);
  mkdirSync(codexHome, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: work }).status, 0);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string') env[name] = value;
  // A temporary (or owner-prepared throwaway) CODEX_HOME: never the owner's profile. The worker
  // shapes the environment for the mode: no vendor key on a subscription run.
  return { work, env: { ...env, CODEX_HOME: codexHome } };
}

test(`a real Codex owned session (${auth}) selects the model at turn start and writes in its worktree`, { skip, timeout: 600_000 }, async (t) => {
  const codex = codexOnPath();
  assert.ok(codex !== null, 'the Codex CLI (codex) is not on PATH');
  const box = sandbox(t);
  const outcome = await runCodexWorker({
    prompt: 'Create a file named hello.txt in the current directory containing exactly the word hi. Do nothing else.',
    model,
    cwd: box.work,
    allowedTools: ['Read', 'Write'],
    maxTurns: 10,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    command: { file: codex },
    env: box.env,
    auth,
  });
  assert.equal(outcome.status, 'completed', `${outcome.status}: ${outcome.reason}`);
  assert.equal(outcome.authMode, auth);
  assert.equal(outcome.requestedModel, model);
  assert.equal(outcome.sandbox, 'workspace-write');
  assert.ok(outcome.sessionId !== null, 'no thread id');
  assert.ok(outcome.usage !== null && outcome.usage.outputTokens > 0, 'no token usage');
  assert.ok(existsSync(join(box.work, 'hello.txt')), 'the session did not write in its worktree');
  assert.match(readFileSync(join(box.work, 'hello.txt'), 'utf8'), /hi/);
});

test(`an abort stops a real Codex turn promptly (${auth})`, { skip, timeout: 600_000 }, async (t) => {
  const codex = codexOnPath();
  assert.ok(codex !== null, 'the Codex CLI (codex) is not on PATH');
  const box = sandbox(t);
  const controller = new AbortController();
  const running = runCodexWorker({
    prompt: 'Count from 1 to 5000, writing each number on its own line in numbers.txt, one command per number.',
    model,
    cwd: box.work,
    allowedTools: ['Read', 'Write', 'Bash'],
    maxTurns: 500,
    maxBudgetUsd: 1,
    timeoutMs: 300_000,
    command: { file: codex },
    env: box.env,
    auth,
    onEvent: (event) => {
      if (event.type === 'turn.started') setTimeout(() => controller.abort(), 3_000);
    },
    signal: controller.signal,
  });
  const started = Date.now();
  const outcome = await running;
  assert.equal(outcome.status, 'aborted', `${outcome.status}: ${outcome.reason}`);
  assert.ok(Date.now() - started < 120_000);
});
