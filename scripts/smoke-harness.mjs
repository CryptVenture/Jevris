#!/usr/bin/env node
/**
 * Opt-in real-harness certification run (HCF-01, HCF-02, RLS-10). Never part of `npm test`.
 *
 *   JEVRIS_LIVE_HARNESS=1 npm run smoke:harness -- [--evidence <dir>] [--harness <name>]...
 *                                                 [--signing-key <pem> --key-id <id>] [--report <file>]
 *
 * For every harness binary found on PATH (claude, kilo, codex, opencode, agy), or only the ones
 * named with --harness, it runs `jevris certify --harness <name>`. certify installs Jevris
 * into a temporary harness profile, loads the plugin in the real binary, runs the conformance
 * cases and writes a signed certification record plus harness-conformance and
 * certification-record evidence. Jevris itself runs in a temporary home here, so nothing is
 * written to your real home; the evidence lands in --evidence (default release-evidence/).
 *
 * The certification key is the one passed with --signing-key/--key-id; without it certify
 * signs with a local key that the release trust store does not list, which is useful to
 * rehearse but does not count toward the release gates.
 *
 * Exit 0 when every harness it ran was certified, 1 when one was not or none was found,
 * 2 on a usage error or when it would run inside the test suite.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
/** Binary on PATH -> the name `jevris certify --harness` takes. */
export const HARNESS_BINARIES = { claude: 'claude', kilo: 'kilo', codex: 'codex', opencode: 'opencode', agy: 'agy' };

function refuse(message) {
  console.error(message);
  process.exit(2);
}

/** The first executable called `name` on PATH (PATHEXT on Windows), or null. */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir.length > 0);
  const exts = platform === 'win32' ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return null;
}

export function parseArgs(argv) {
  const options = { evidence: join(repoRoot, 'release-evidence'), harnesses: [], signingKey: undefined, keyId: undefined, report: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--evidence') options.evidence = resolve(next());
    else if (arg === '--harness') options.harnesses.push(next());
    else if (arg === '--signing-key') options.signingKey = resolve(next());
    else if (arg === '--key-id') options.keyId = next();
    else if (arg === '--report') options.report = resolve(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const name of options.harnesses) if (!Object.hasOwn(HARNESS_BINARIES, name)) throw new Error(`unknown harness ${name} (${Object.keys(HARNESS_BINARIES).join(', ')})`);
  if ((options.signingKey === undefined) !== (options.keyId === undefined)) throw new Error('--signing-key and --key-id go together');
  return options;
}

function certify(name, options, home) {
  const args = [join(repoRoot, 'bin', 'jevris.mjs'), 'certify', '--harness', HARNESS_BINARIES[name], '--home', home, '--evidence', options.evidence, '--json'];
  if (options.signingKey !== undefined) args.push('--signing-key', options.signingKey, '--key-id', options.keyId);
  const env = { ...process.env, JEVRIS_HOME: home };
  delete env.JEVRIS_NO_LIVE_HARNESS;
  const run = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  let result = null;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    result = null;
  }
  return { harness: name, status: run.status, result, stderr: (run.stderr ?? '').slice(-2000) };
}

function main(argv) {
  if (process.env.JEVRIS_LIVE_HARNESS !== '1') refuse('smoke:harness starts real harness binaries. Set JEVRIS_LIVE_HARNESS=1 to opt in.');
  if (process.env.JEVRIS_TEST === '1' || (process.env.NODE_TEST_CONTEXT ?? '').length > 0 || process.env.JEVRIS_NO_LIVE_HARNESS === '1') {
    refuse('smoke:harness does not run inside the test suite (JEVRIS_TEST, JEVRIS_NO_LIVE_HARNESS or a test runner is set).');
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    refuse(`smoke:harness: ${error.message}`);
  }
  if (!existsSync(join(repoRoot, 'dist', 'cli.mjs'))) refuse('smoke:harness: run npm run build first.');
  const wanted = options.harnesses.length > 0 ? options.harnesses : Object.keys(HARNESS_BINARIES);
  const found = wanted.filter((name) => findOnPath(name) !== null);
  for (const name of wanted.filter((item) => !found.includes(item))) console.log(`skip ${name}: not on PATH`);
  if (found.length === 0) {
    console.log('smoke:harness: no harness binary found; nothing was certified.');
    return 1;
  }
  mkdirSync(options.evidence, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'jevris-certify-'));
  const results = [];
  try {
    for (const name of found) {
      console.log(`certify ${name} (${findOnPath(name)}) ...`);
      const outcome = certify(name, options, home);
      results.push(outcome);
      const r = outcome.result;
      if (r === null) console.log(`FAIL ${name}: no result (exit ${outcome.status}) ${outcome.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
      else {
        const failed = (r.cases ?? []).filter((item) => item.passed !== true).map((item) => item.id);
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name} ${r.harnessVersion ?? 'unknown version'}: ${(r.cases ?? []).length - failed.length}/${(r.cases ?? []).length} cases${failed.length > 0 ? `; failing ${failed.join(', ')}` : ''}${r.error ? `; ${r.error}` : ''}`);
        const worker = r.workerCases ?? [];
        const workerFailed = worker.filter((item) => item.passed !== true).map((item) => item.id);
        console.log(`     ${HARNESS_BINARIES[name]}.worker: ${worker.length - workerFailed.length}/${worker.length} cases${workerFailed.length > 0 ? `; failing ${workerFailed.join(', ')}` : ''}`);
        for (const file of r.evidence ?? []) console.log(`     evidence: ${file}`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
  if (options.report !== undefined) writeFileSync(options.report, `${JSON.stringify({ results }, null, 2)}\n`);
  const ok = results.every((item) => item.result !== null && item.result.ok === true);
  console.log(`smoke:harness: ${results.filter((item) => item.result?.ok === true).length}/${results.length} certified; evidence in ${options.evidence}`);
  return ok ? 0 : 1;
}

const entry = process.argv[1];
if (typeof entry === 'string' && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
