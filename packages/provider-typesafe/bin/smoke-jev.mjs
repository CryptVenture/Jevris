#!/usr/bin/env node
/**
 * Opt-in Jev API suite (PRV-10). Never part of `npm test`.
 *
 *   JEVRIS_LIVE_JEV=1 npm run smoke:jev            live: key from the OS keystore (service jevris,
 *                                                 account typesafe-primary), fixed non-sensitive prompts
 *   npm run smoke:jev -- --mock                   the same suite against the conformance mock (CI)
 *   options: --calls N (latency sample, default 30),
 *            --evidence FILE (release evidence, kind api-live-suite; default <data>/evidence/api-live-suite-<time>.json). The file, and the
 *            folder it is in, must not be a symbolic link (on macOS /tmp is one: name /private/tmp/... or a folder under your home); a record
 *            that could not be written is said so on stderr with the platform's code (ESYMLINK, EACCES...) and what to do, and the run exits 1.
 *
 * The evidence file holds model ids, usage, latency and outcome codes only: never a key or a body.
 * It records every latency call and error probe with its elapsed milliseconds and outcome (reason
 * code, failure kind, HTTP status), and a count of failed calls per reason code. Every call runs
 * under a 10 s measuring timeout, not the 900 ms hot budget: the record gives the uncensored
 * p50/p95/p99/max and how many calls fit the budget, and the error probes get time for their 400
 * and 401. The product's hot path keeps its budget.
 * The first keystore read from a new process may show a macOS "allow access" prompt.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const mock = flag('--mock');
if (!mock && process.env.JEVRIS_LIVE_JEV !== '1') {
  process.stdout.write('smoke:jev is opt-in. Run: JEVRIS_LIVE_JEV=1 npm run smoke:jev   (or --mock for the offline suite)\n');
  process.exit(0);
}
if (!mock && (process.env.JEVRIS_TEST === '1' || process.env.NODE_TEST_CONTEXT)) {
  process.stderr.write('smoke:jev: refusing a live run inside a test process.\n');
  process.exit(2);
}

const provider = await import('../dist/index.js');
const { durableWrite, durableWriteRefusal } = await import('@jevris/platform');
const calls = Number.parseInt(option('--calls', '30'), 10);
const { jevrisPaths } = await import('@jevris/platform');
const { releaseEvidence, ReleaseEvidenceContract } = await import('@jevris/contracts');
const stamp = new Date().toISOString();
const out = option('--evidence', join(jevrisPaths().data, 'evidence', `api-live-suite-${stamp.replace(/[:.]/g, '-')}.json`));

let transport;
let badKeyTransport;
let cancelTransport;
if (mock) {
  cancelTransport = provider.createSdkTransport({ apiKey: 'mock-key', fetch: provider.createMockFetch({ scenario: 'aborted' }) });
  transport = provider.createSdkTransport({ apiKey: 'mock-key', fetch: provider.createMockFetch({ scenario: 'valid' }) });
  badKeyTransport = provider.createSdkTransport({ apiKey: 'mock-key', fetch: provider.createMockFetch({ scenario: 'http-401' }) });
} else {
  const { resolveProviderCredential, openHostEntry } = await import(pathToFileURL(join(repoRoot, 'apps', 'cli', 'dist', 'credential.js')).href);
  const resolved = await resolveProviderCredential(openHostEntry);
  if (resolved.mode === 'rules-only' || typeof resolved.apiKey !== 'string') {
    process.stderr.write('smoke:jev: no provider key in the OS keystore. Run: jevris credential set\n');
    process.exit(3);
  }
  transport = provider.createSdkTransport({ apiKey: resolved.apiKey });
  badKeyTransport = provider.createSdkTransport({ apiKey: 'jevris-invalid-key-for-401-probe' });
}

const record = await provider.runLiveSuite({ transport, badKeyTransport, ...(cancelTransport ? { cancelTransport } : {}), latencyCalls: Number.isSafeInteger(calls) && calls >= 0 ? calls : 30, mode: mock ? 'mock' : 'live' });
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', shell: false });
const commit = head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
const evidence = releaseEvidence({
  kind: 'api-live-suite',
  id: `api-live-suite-${stamp.replace(/[^0-9]/g, '').slice(0, 14)}`,
  producedAt: stamp,
  version,
  commit,
  tool: 'jevris-smoke-jev',
  run: mock ? 'mock' : 'live',
  os: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : null,
  arch: process.arch,
  node: process.version,
  payload: JSON.parse(JSON.stringify(record)),
});
const checked = ReleaseEvidenceContract.validate(evidence);
if (!checked.ok) {
  process.stderr.write(`smoke:jev: evidence did not validate: ${JSON.stringify(checked.issues)}\n`);
  process.exit(4);
}
mkdirSync(dirname(out), { recursive: true });
const written = await durableWrite(out, `${JSON.stringify(evidence, null, 2)}\n`);
// The record is the point of the run: one that was refused says why (the platform's code and a fixed sentence, never a path or a message) and fails the run (JEV-0075).
const refusal = written.ok ? null : durableWriteRefusal(written);
if (refusal !== null) process.stderr.write(`smoke:jev: evidence NOT WRITTEN (${refusal})\n`);
process.stdout.write(
  `${JSON.stringify({
    passed: record.passed,
    mode: record.mode,
    resolvedModels: record.resolvedModels,
    usage: record.usage,
    // The per-call rows stay in the evidence file; the summary line keeps the counts.
    latency: { ...record.latency, samples: undefined },
    combined: record.combined,
    errors: record.errors,
    cancellation: record.cancellation,
    caps: record.caps,
    evidence: written.ok ? out : null,
    ...(refusal === null ? {} : { evidenceNotWritten: refusal }),
  })}\n`,
);
process.exit(record.passed && written.ok ? 0 : 1);
