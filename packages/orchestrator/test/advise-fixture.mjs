// A shared fixture for the capability advice tests that run a real decision engine (its packet builder and transport guard) against a scripted
// Jev: a git repository, a Jevris home, an opened workspace and the engine, with source egress approved or denied. No live call is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidecarEngine } from '@jevris/provider-typesafe';
import { adviseCapability, openWorkspace } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A scripted Jev: a valid, confident answer to whatever is asked (the first option of a Choice, the middle anchor of a Score, a Noul of 0.9). */
export function scriptedJev() {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
      else if (q.type === 'score') {
        const n = q.criteria.length;
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 2 ? 0.9 : Math.round((0.1 / (n - 1)) * 1000) / 1000]));
        const score = Math.round(Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0) * 100) / 100;
        answers[id] = { type: 'score', score, probabilities, legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])), confidence: 0.9 };
      } else {
        const keys = Object.keys(q.criteria);
        const pick = keys.find((k) => k !== 'none' && k !== 'unknown') ?? keys[0];
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)]));
        answers[id] = { type: 'choice', choice: pick, probabilities, confidence: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

/**
 * A repository with `files`, a home with `skills` (name to description), an opened workspace and the real engine over the scripted Jev.
 * `egress`: whether the administrator approved source egress. Returns `advise(id, input)`, the request log and the folders to search.
 */
export async function adviseFixture(t, { egress, files = {}, skills = {} }) {
  const dir = tempDir('jv-adv-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const put = (root, rel, text) => {
    mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split('/')), text);
  };
  put(repo, 'README.md', '# app\n');
  for (const [rel, text] of Object.entries(files)) put(repo, rel, text);
  for (const [name, description] of Object.entries(skills)) put(home, `.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = testStore(dir);
  const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
  const script = scriptedJev();
  const engineHome = mkdtempSync(join(tmpdir(), 'jevris-adv-engine-'));
  const engine = await createSidecarEngine({ home: engineHome, credential: 'test-key-not-a-secret', fetch: script.fetch, env: {}, sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }) });
  t.after(() => {
    closeTestStore(store);
    rmSync(dir, { recursive: true, force: true });
    rmSync(engineHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return {
    ws,
    home,
    repo,
    dir,
    engine,
    engineHome,
    requests: script.requests,
    advise: (capabilityId, input = {}) => adviseCapability(ws, { capabilityId, input, home, env: { HOME: home }, engine, egressApproved: egress, remainingMs: 60_000 }),
    evidence: (text) => ws.evidence.put({ workspaceId: ws.workspaceId, kind: 'tool-output', bytes: new TextEncoder().encode(text), nowMs: Date.now() }).then((m) => m.handle),
  };
}

/** Every regular file under `dir`, recursively (git objects included: a loose object is compressed, so a search of it holds only for `git` output). */
export function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkFiles(path, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

/** The files under `dir` whose bytes hold `text`. */
export function filesHolding(dir, text) {
  return walkFiles(dir).filter((file) => {
    try {
      return readFileSync(file).includes(text);
    } catch {
      return false;
    }
  });
}
