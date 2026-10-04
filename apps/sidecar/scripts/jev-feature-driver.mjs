/**
 * The driver of the Jev capability cases (`jev-feature-cases-*.mjs`), shared by the live feature suite
 * (`npm run smoke:jev:features`) and its offline tests.
 *
 * A case is a plain object (see `jev-feature-cases.mjs`): optional setup `steps`, then one `call`, each
 * an op sent to a sidecar over its real socket. The driver runs them in order against one workspace and
 * records, per case, numbers and codes only: whether the call succeeded, how many Jev requests left
 * the machine during the call (counted by the caller's `requestCount`), the op's own answer summary
 * (source, reason code, decision id), the elapsed time, and the decision record's usage and cost.
 *
 * It never reads a key, never prints a body, and never writes outside the temporary home and workspace
 * it is given.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Strings the cases put in free-text fields; none may appear in a request while source egress is denied. */
export const MARKER = 'ZZMARKER';

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.email=jev-features@example.invalid', '-c', 'user.name=jev-features', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args[0]} failed: ${(out.stderr ?? '').slice(0, 200)}`);
  return out.stdout ?? '';
}

/** Writes `files` (relative path to text) under `root`, makes it a git repository and commits them. */
export function writeWorkspace(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'synthetic workspace for the Jev feature cases');
}

/** The head commit of the workspace (a step that edits files can read it back). */
export function headOf(root) {
  return git(root, 'rev-parse', 'HEAD').trim();
}

function pick(result, keys) {
  if (result === null || typeof result !== 'object') return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  }
  return null;
}

/** The default summary of an op answer: the fields the capability advice and the memory ops share. */
export function summarizeResult(result) {
  const body = result !== null && typeof result === 'object' && result.advice !== null && typeof result.advice === 'object' ? result.advice : result;
  return {
    source: pick(body, ['source']),
    reasonCode: pick(body, ['reasonCode']),
    decisionId: pick(body, ['decisionId']),
    verb: pick(body, ['verb']),
    recommendation: pick(body, ['recommendation']),
  };
}

/**
 * Runs the cases in order. Returns one row per case.
 *
 * @param {object} input
 * @param {{ sidecarRequest: Function }} input.sidecar the sidecar client (`apps/sidecar/dist/index.js`)
 * @param {string} input.home the Jevris home the sidecar runs in
 * @param {string} input.work the workspace root
 * @param {readonly object[]} input.cases the cases
 * @param {() => number} input.requestCount Jev requests that have left (or reached the stub) so far
 * @param {(decisionId: string) => Promise<object|null>} [input.lookup] reads a decision record
 * @param {(id: string) => boolean} [input.only] selects cases by id
 * @param {number} [input.timeoutMs] per-op timeout (default 20 s: these are measurements, not the hot path)
 */
export async function runCases(input) {
  const { sidecar, home, work, cases, requestCount } = input;
  const timeoutMs = input.timeoutMs ?? 20_000;
  const rows = [];
  for (const c of cases) {
    if (input.only !== undefined && !input.only(c.id)) continue;
    const row = { id: c.id, title: c.title, expectAsked: c.expectAsked !== false, egressNeeded: c.egressNeeded === true, ok: false, requests: 0, source: null, reasonCode: null, decisionId: null, verb: null, recommendation: null, elapsedMs: 0, failure: null, usage: null, costMicroUsd: null, durationMs: null, jevReasonCodes: [], answerProbabilities: [] };
    try {
      for (const step of c.steps ?? []) {
        if (step.files !== undefined) {
          // A workspace edit, not an op: write the files, and commit them when asked.
          for (const [rel, text] of Object.entries(step.files)) {
            const full = join(work, ...rel.split('/'));
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
          }
          if (step.commit === true) {
            git(work, 'add', '-A');
            git(work, 'commit', '-q', '-m', `case ${c.id}`);
          }
          continue;
        }
        const stepResult = await sidecar.sidecarRequest({ home, op: step.op, scope: step.scope ?? 'cli', workspace: work, body: step.body ?? {}, timeoutMs });
        if (!stepResult.ok && step.optional !== true) {
          row.failure = `step ${step.op}: ${stepResult.reasonCode ?? stepResult.reason}`;
          break;
        }
      }
      if (row.failure === null) {
        const before = requestCount();
        const started = performance.now();
        const answer = await sidecar.sidecarRequest({ home, op: c.call.op, scope: c.call.scope ?? 'cli', workspace: work, body: c.call.body ?? {}, timeoutMs });
        row.elapsedMs = Math.round(performance.now() - started);
        row.requests = requestCount() - before;
        if (answer.ok) {
          row.ok = true;
          Object.assign(row, (c.summarize ?? summarizeResult)(answer.result));
        } else {
          row.failure = `${c.call.op}: ${answer.reasonCode ?? answer.reason}`;
        }
      }
    } catch (error) {
      row.failure = `threw: ${String(error?.message ?? error).slice(0, 120)}`;
    }
    if (typeof row.decisionId === 'string' && input.lookup !== undefined) {
      try {
        const record = await input.lookup(row.decisionId);
        if (record !== null && record !== undefined) {
          row.usage = record.usage ?? null;
          row.costMicroUsd = record.cost?.actualMicroUsd ?? null;
          row.durationMs = record.durationMs ?? null;
          row.jevReasonCodes = Array.isArray(record.reasonCodes) ? record.reasonCodes.slice(0, 12) : [];
          // The provider's own certainty per question (a Noul's probability, a Choice's or Score's confidence): numbers only.
          row.answerProbabilities = Array.isArray(record.answerProbabilities) ? record.answerProbabilities.slice(0, 12).map((a) => ({ id: a.questionId, type: a.type, probability: a.probability })) : [];
        }
      } catch {
        // The record is a measurement aid; its absence changes nothing.
      }
    }
    rows.push(row);
  }
  return rows;
}
