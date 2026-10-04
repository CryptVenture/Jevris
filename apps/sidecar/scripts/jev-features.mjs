#!/usr/bin/env node
/**
 * The Jev feature suite (`npm run smoke:jev:features`). Opt-in; never part of `npm test`.
 *
 *   JEVRIS_LIVE_JEV=1 npm run smoke:jev:features -- --evidence FILE   live: key from the OS keystore
 *                                                                     (service jevris, account typesafe-primary),
 *                                                                     fixed synthetic non-sensitive inputs only
 *   npm run smoke:jev:features -- --mock                              the same suite against the conformance
 *                                                                     mock (CI): no key, no network
 *
 * What it does. Every Jev decision the product makes runs once through its real handler, the real
 * engine and the real packet builders: route slice classification, plan slice labels, check ranking,
 * repeated-failure advice, new-task advice, the intent decisions C01 to C04, C06 and C07, the security decisions C51
 * and C49, and the worker-readiness advice. The capability catalogue (C18 to C72) runs through a real
 * sidecar, one case per Jev consult site, each reached through its real entry point (an op or a hook event). The hot path (route and plan at the product's 900 ms budget,
 * a concurrent burst, a repeat sequence for the cache hit rate) runs through the same sidecar, and the
 * check ranking and the repeated-failure advice run at their production waits in this process.
 *
 * Options.
 *   --mock                    use the conformance mock instead of the live API
 *   --evidence FILE           where to write the evidence record (default <data>/evidence/jev-features-<time>.json)
 *   --cold N                  cold runs per case that asks Jev (default 3; the engine groups)
 *   --cached N                cached runs per case (default 2)
 *   --hot N                   cold requests per op in the hot-path run (default 30)
 *   --groups a,b              run only these engine groups (default all)
 *   --skip engine,caps,hot    skip a part (engine groups, capability cases, hot path)
 *   --max-calls N             hard cap on live calls for the engine groups (default 400)
 *   --max-uusd N              hard cap on micro-USD for the engine groups (default 16000)
 *   --sidecar-uusd N          the decision budget the six capability passes share, in micro-USD (default 12000)
 *   --egress denied|approved  run the capability cases in one egress state only (default both)
 *   --parts a,b,c            run only these capability case parts (default all three)
 *   --hot-uusd N              the decision budget of the hot-path sidecar, in micro-USD (default 7000)
 *
 * Safety. The key is read only through the product's resolver, in this process for the engine groups
 * and by the sidecar itself for the sidecar parts; it is never printed, logged, put in argv or in the
 * record. Everything runs in a temporary home: the real ~/.jevris is never read or written. The run
 * stops at the first 401, 402 or 403, or three 429s in a row, or at a cap. The record holds numbers
 * and codes only.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const repoModule = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const number = (name, fallback) => {
  const n = Number.parseInt(option(name, String(fallback)), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

const mock = flag('--mock');
if (!mock && process.env.JEVRIS_LIVE_JEV !== '1') {
  process.stdout.write('smoke:jev:features is opt-in. Run: JEVRIS_LIVE_JEV=1 npm run smoke:jev:features -- --evidence FILE   (or --mock for the offline suite)\n');
  process.exit(0);
}
if (!mock && (process.env.JEVRIS_TEST === '1' || process.env.NODE_TEST_CONTEXT)) {
  process.stderr.write('smoke:jev:features: refusing a live run inside a test process.\n');
  process.exit(2);
}

const skip = new Set((option('--skip', '') ?? '').split(',').filter(Boolean));
const groups = option('--groups', undefined)?.split(',').filter(Boolean);
const cold = Math.max(1, number('--cold', 3));
const cached = number('--cached', 2);
const hotCount = number('--hot', 30);
const partsOption = option('--parts', 'a,b,c').split(',').filter(Boolean);
const egressOption = option('--egress', 'both');
const egressStates = egressOption === 'denied' ? ['denied'] : egressOption === 'approved' ? ['approved'] : ['denied', 'approved'];
const maxCalls = number('--max-calls', 400);
const maxMicroUsd = number('--max-uusd', 16_000);
const sidecarMicroUsd = number('--sidecar-uusd', 12_000);
const hotMicroUsd = number('--hot-uusd', 7_000);
const say = (line) => process.stdout.write(`${line}\n`);

const provider = await repoModule('packages', 'provider-typesafe', 'dist', 'index.js');
const { jevrisPaths, durableWrite } = await repoModule('packages', 'platform', 'dist', 'index.js');
const { PINNED_MODEL, containsSecret } = await repoModule('packages', 'contracts', 'dist', 'index.js');
const sidecar = await repoModule('apps', 'sidecar', 'dist', 'index.js');
const driver = await import('./jev-feature-driver.mjs');
const hot = await import('./jev-feature-hot.mjs');

const stamp = new Date().toISOString();
const home = realpathSync(mkdtempSync(join(tmpdir(), 'jev-features-')));
const work = join(home, 'work');
const stopFns = [];
let exitCode = 0;

try {
  // ------------------------------------------------------------------------------- credential and transport
  let credential = 'mock-key';
  let innerFetch;
  let mockServer = null;
  if (mock) {
    innerFetch = provider.createMockFetch({ scenario: 'valid' });
    // A loopback Jev for the sidecar process (the documented test override; the stored key is never sent to it).
    const mockFetch = provider.createMockFetch({ scenario: 'confident' });
    mockServer = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const headers = {};
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = value;
          const answer = await mockFetch(`https://api.typesafe.ai${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') });
          const bytes = Buffer.from(await answer.arrayBuffer());
          const sent = {};
          answer.headers.forEach((value, name) => (sent[name] = value));
          res.writeHead(answer.status, sent);
          res.end(bytes);
        } catch {
          res.destroy();
        }
      });
    });
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    stopFns.push(() => mockServer.close());
  } else {
    const cred = await repoModule('apps', 'cli', 'dist', 'credential.js');
    const resolved = await cred.resolveProviderCredential(cred.openHostEntry);
    if (resolved.mode === 'rules-only' || typeof resolved.apiKey !== 'string') {
      process.stderr.write('smoke:jev:features: no provider key in the OS keystore. Run: jevris credential set\n');
      process.exit(3);
    }
    credential = resolved.apiKey;
    innerFetch = provider.nodeFetch;
  }
  // The engine groups run in this process in a home of their own; the sidecar's home keeps its own budget, so each is capped on its own.
  const engineHome = join(home, 'engine-home');
  for (const base of [home, engineHome]) for (const dir of ['data', 'state', 'config']) mkdirSync(join(base, dir), { recursive: true });
  mkdirSync(work, { recursive: true });
  const meter = provider.createCallMeter(innerFetch, { maxCalls, maxMicroUsd });
  const createEngine = async ({ egress }) =>
    provider.createSidecarEngine({
      home: engineHome,
      credential,
      fetch: meter.fetch,
      budgetLimitMicroUsd: 5_000_000,
      sourceEgress: () => ({ provenance: 'administrator', sourceEgress: egress ? 'approved-scoped' : 'deny-until-approved' }),
    });

  const record = { schemaVersion: 'jev-features-suite-1', kind: 'jev-features-suite', mode: mock ? 'mock' : 'live', producedAt: stamp, pinnedModel: PINNED_MODEL };

  // ------------------------------------------------------------------------------------------ engine groups
  if (!skip.has('engine')) {
    say(`engine groups: cold ${cold}, cached ${cached}, caps ${maxCalls} calls / ${maxMicroUsd} micro-USD`);
    record.engine = await provider.runFeatureSuite({ meter, createEngine, cold, cached, ...(groups === undefined ? {} : { groups }), progress: say });
    for (const g of record.engine.groups) say(`${g.group.padEnd(17)} cases ${g.cases} rows ${g.rows} calls ${g.calls} uUSD ${g.costMicroUsd} callOk ${g.callOkRate} valid ${g.validatorAcceptRate} agree ${g.agreeRate} cold p50/p95 ${g.cold.p50}/${g.cold.p95} cached p50 ${g.cached.p50} leaks ${g.leaks}`);
  }

  // ------------------------------------------------------------------------------------------ the sidecars
  // Each sidecar part runs in a home of its own (a fresh process, a fresh decision cache and budget), capped by that home's
  // decision budget: the sidecar cannot be metered at the socket, so its own budget is the cap.
  let sidecarSpent = 0;
  const needsSidecar = !skip.has('caps') || !skip.has('hot');
  if (needsSidecar) {
    const { DEFAULT_CONFIG } = await repoModule('packages', 'orchestrator', 'dist', 'index.js');
    const coreModule = await repoModule('packages', 'core', 'dist', 'index.js');
    const { lookupDecision } = coreModule;
    // The capabilities read installed skills, agents and settings from the home they run in, and from these folders when they
    // are set: the run must never see the person's own, so they are unset (HOME itself stays: the keystore needs it).
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[name];
    process.env.JEVRIS_SIDECAR_ENTRY = join(repoRoot, 'apps', 'sidecar', 'dist', 'main.js');
    process.env.JEVRIS_SIDECAR_IDLE_MS = '1800000';
    if (mock) {
      process.env.JEVRIS_TEST = '1';
      process.env.JEVRIS_TEST_PROVIDER_URL = `http://127.0.0.1:${mockServer.address().port}`;
      process.env.JEVRIS_TEST_PROVIDER_KEY = 'jev-features-mock-key';
    } else {
      delete process.env.JEVRIS_TEST_PROVIDER_URL;
      delete process.env.JEVRIS_TEST_PROVIDER_KEY;
    }
    const perPassMicroUsd = Math.max(1, Math.floor(sidecarMicroUsd / (partsOption.length * egressStates.length)));
    /** A fresh home with its own decision budget, and the sidecar started in it. */
    const startSidecar = async (name, budgetMicroUsd = perPassMicroUsd) => {
      const dir = join(home, name);
      mkdirSync(jevrisPaths({ home: dir }).config, { recursive: true });
      writeFileSync(join(jevrisPaths({ home: dir }).config, 'jevris.config.json'), JSON.stringify({ ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, monthlyBudgetMicroUsd: budgetMicroUsd } }));
      return dir;
    };
    const boot = async (dir) => {
      const started = await sidecar.ensureSidecar({ home: dir, waitMs: 30_000 });
      if (!started.ok) throw new Error(`the sidecar did not start: ${started.message ?? started.reason ?? 'unknown'}`);
      stopFns.push(() => sidecar.stopSidecarProcess(dir));
    };
    const spentOf = async (dir, workspace) => {
      const status = await sidecar.sidecarRequest({ home: dir, op: 'status', scope: 'cli', workspace, body: {} });
      return status.ok ? (status.result?.budget?.spentMicroUsd ?? 0) : 0;
    };

    if (!skip.has('caps')) {
      const cases = await import('./jev-feature-cases.mjs');
      record.capabilities = { passes: [], rows: [] };
      for (const egress of egressStates) {
        for (const part of cases.PARTS.filter((p) => partsOption.includes(p.id))) {
          const dir = await startSidecar(`cases-${part.id}-${egress}`);
          const workspace = join(dir, 'ws');
          driver.writeWorkspace(workspace, { 'README.md': '# Synthetic workspace for the Jev feature cases\n', ...part.FILES });
          await part.preparePart({ home: dir, work: workspace, egress, mode: 'advise' });
          await boot(dir);
          const budgetFile = join(jevrisPaths({ home: dir }).data, 'decision-budget.json');
          // Counting the sidecar's Jev requests: every call that left holds a reservation in its decision
          // budget (released ones never left; reserved ones are still in flight).
          const requestCount = () => {
            try {
              const file = JSON.parse(readFileSync(budgetFile, 'utf8'));
              return file.reservations.filter((r) => r.state !== 'released' && r.state !== 'reserved').length;
            } catch {
              return 0;
            }
          };
          const rows = await driver.runCases({ sidecar: part.wrapSidecar(sidecar), home: dir, work: workspace, cases: part.CASES, requestCount, lookup: (id) => lookupDecision(id, { home: dir }), latestDecision: (specId) => driver.latestDecisionOf(coreModule, dir, specId), timeoutMs: 20_000 });
          for (const r of rows) say(`[caps ${part.id} ${egress}] ${r.id.padEnd(14)} ok=${r.ok} requests=${r.requests} source=${r.source} reason=${r.reasonCode} ms=${r.elapsedMs}${r.failure === null ? '' : ` failure=${r.failure}`}`);
          sidecarSpent += await spentOf(dir, workspace);
          await sidecar.stopSidecarProcess(dir);
          record.capabilities.rows.push(...rows.map((r) => ({ ...r, part: part.id, egress })));
          record.capabilities.passes.push({ part: part.id, egress, cases: rows.length, knownDefects: Object.keys(part.KNOWN_DEFECTS), knownLeaks: Object.keys(part.KNOWN_LEAKS) });
        }
      }
    }
    if (!skip.has('hot')) {
      say(`hot path: ${hotCount} cold requests per op through the sidecar`);
      const dir = await startSidecar('hot', hotMicroUsd);
      const workspace = join(dir, 'work');
      mkdirSync(workspace, { recursive: true });
      await boot(dir);
      record.hot = await hot.runSidecarHotPath({ sidecar, home: dir, work: workspace, cold: hotCount, progress: say });
      sidecarSpent += await spentOf(dir, workspace);
      await sidecar.stopSidecarProcess(dir);
    }
    record.sidecar = { spentMicroUsd: sidecarSpent, capsBudgetMicroUsd: sidecarMicroUsd, hotBudgetMicroUsd: hotMicroUsd };
  }

  // --------------------------------------------------------------------------- engine-level hot deciders
  if (!skip.has('hot')) {
    const core = await repoModule('packages', 'core', 'dist', 'index.js');
    const ctx = { workspaceId: 'jev-hot-ws' };
    const checks5 = ['unit-tests', 'lint', 'typecheck', 'build', 'docs-lint'].map((id) => ({ id, state: 'missing' }));
    const deciders = [
      {
        id: 'check-ranking',
        // A source and a test file and a doc: the rules are not sure, so Jev is asked. Distinct per run by file counts.
        async run(engine, i) {
          const paths = [...Array.from({ length: 1 + (i % 6) }, (_, k) => `src/a${k}.ts`), ...Array.from({ length: i % 4 }, (_, k) => `test/a${k}.test.ts`), ...(i % 5 === 0 ? ['docs/a.md'] : []), ...(i % 7 === 0 ? ['package.json'] : [])];
          const r = await core.rankChecks(engine, { checks: checks5, paths }, ctx, { assist: 'classify', deadlineMs: 700 });
          return { source: r.source, reasonCode: r.reasonCode, cacheHit: r.cacheHit };
        },
      },
      {
        id: 'repeated-failure',
        async run(engine, i) {
          const present = ['stack-trace', 'logs', 'failing-test-output', 'recent-diff', 'repro-steps', 'config-file', 'environment-info'].filter((_, k) => (i >> k) % 2 === 1 && k < 5);
          const features = { toolClass: ['shell', 'edit', 'read', 'web'][i % 4], exitClass: ['nonzero', 'signal', 'timeout', 'error'][Math.floor(i / 4) % 4], signature: 'aaaaaaaaaaaaaaaa', commandDigest: 'bbbbbbbbbbbbbbbb', environmental: false, elapsed: ['lt1s', 'lt10s', 'lt60s', 'gte60s'][i % 4], present };
          features.family = `${features.toolClass}:${features.exitClass}`;
          // The one question this advice asks Jev is the same-failure Noul (signatures differ, the same call ran again, nothing edited): which
          // artifact comes next is the rules' pick and never a request, so only an unsure failure makes one.
          const context = provider.failureContextOf(features, { attempts: 2 + (i % 3), sameCommand: true, editsSince: 0, unsure: true, previous: { environmental: false, elapsed: 'lt10s', present } }, 9);
          const a = await provider.adviseRepeatedFailure(engine, context, { assist: 'classify', deadlineMs: 1500, ids: { workspaceId: 'jev-hot-ws', sessionId: 'jev-hot-session' }, record: true });
          return { source: a.source, reasonCode: a.reasonCode, cacheHit: a.cacheHit };
        },
      },
    ];
    record.hotEngine = await hot.measureEngineHot({ deciders, createEngine: () => createEngine({ egress: false }), cold: Math.min(hotCount, 30), progress: say });
  }

  // ----------------------------------------------------------------------------------------------- the record
  const totals = meter.totals();
  record.spent = { engineCalls: totals.calls, engineMicroUsd: totals.costMicroUsd, engineInputTokens: totals.inputTokens, engineOutputTokens: totals.outputTokens, statuses: totals.statuses, sidecarMicroUsd: needsSidecar ? sidecarSpent : null, halted: meter.halted };
  const failures = [...(record.engine?.failures ?? [])];
  if (record.capabilities !== undefined) {
    // A case that needs source egress sends nothing while it is denied (that is the rule), and must ask once it is approved.
    const defects = new Set(record.capabilities.passes.flatMap((p) => p.knownDefects));
    const unreached = record.capabilities.rows.filter((r) => r.expectAsked && !defects.has(r.id) && (r.egress === 'approved' || !r.egressNeeded) && r.requests === 0);
    if (unreached.length > 0) failures.push('A_CAPABILITY_DID_NOT_REACH_JEV');
    const sentDenied = record.capabilities.rows.filter((r) => r.egress === 'denied' && r.egressNeeded && r.requests > 0);
    if (sentDenied.length > 0) failures.push('A_CAPABILITY_SENT_TEXT_WITHOUT_EGRESS');
    if (record.capabilities.rows.some((r) => !r.ok)) failures.push('A_CAPABILITY_CALL_FAILED');
  }
  record.failures = [...new Set(failures)];
  record.passed = record.failures.length === 0;
  record.applied = false;
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', shell: false });
  record.version = version;
  record.commit = head.status === 0 && /^[0-9a-f]{40}$/.test((head.stdout ?? '').trim()) ? head.stdout.trim() : null;
  record.environment = { os: process.platform, arch: process.arch, node: process.version };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (containsSecret(text)) throw new Error('the evidence record held something secret-shaped; not written');
  const out = option('--evidence', join(jevrisPaths().data, 'evidence', `jev-features-${stamp.replace(/[:.]/g, '-')}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const written = await durableWrite(out, text);
  say(`passed ${record.passed} failures ${record.failures.join(',') || 'none'}; engine calls ${totals.calls} (${totals.costMicroUsd} micro-USD), sidecar spent ${sidecarSpent ?? 'n/a'} micro-USD; evidence ${written.ok ? out : 'NOT WRITTEN'}`);
  exitCode = record.passed && written.ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`smoke:jev:features: ${String(error?.message ?? error).slice(0, 300)}\n`);
  exitCode = 1;
} finally {
  for (const stop of stopFns.reverse()) {
    try {
      await stop();
    } catch {
      // Best effort: the sidecar's idle timer ends it anyway.
    }
  }
  if (!flag('--keep-home')) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(exitCode);
