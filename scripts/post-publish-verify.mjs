#!/usr/bin/env node
/**
 * Post-publish verification (PKG-13): after a publish, `npx @webventures/jevris@<version>`
 * resolves from the registry, prints its version and runs doctor under a temporary HOME, and
 * the installed package carries verified registry signatures and a provenance attestation.
 *
 *   node scripts/post-publish-verify.mjs --version 1.2.0              # from the npm registry
 *   node scripts/post-publish-verify.mjs --version 1.2.0 --package ./webventures-jevris-1.2.0.tgz
 *                                                                     # local rehearsal (no provenance)
 *   ... --report post-publish.json --retries 10
 *
 * Uses a private npm cache and a temp HOME; never the user's cache, HOME or a real harness.
 * The registry can lag a publish by minutes, so a missing version is retried with backoff.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMain } from './build.mjs';
import { npmCli } from './pack-smoke.mjs';
import { PACKAGE_NAME } from './release-policy.mjs';
import { testEnvironment, writeHarnessStubs } from './test.mjs';

export function parseArgs(argv) {
  const options = { version: undefined, package: undefined, report: undefined, retries: 10, provenance: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') options.version = argv[++i];
    else if (arg === '--package') options.package = argv[++i];
    else if (arg === '--report') options.report = argv[++i];
    else if (arg === '--retries') options.retries = Number(argv[++i]);
    else if (arg === '--no-provenance') options.provenance = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (typeof options.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error('--version <semver> is required');
  }
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 60) throw new Error('--retries must be 0..60');
  // A local tarball has no registry signature or attestation to check.
  if (options.package !== undefined) options.provenance = false;
  return options;
}

/** The package spec npx resolves: the registry version, or a local tarball for a rehearsal. */
export function packageSpec(options) {
  return options.package ?? `${PACKAGE_NAME}@${options.version}`;
}

/** Registry lag shows as E404 or ETARGET (no matching version yet). */
export function isPropagationError(stderr) {
  return /\b(E404|ETARGET|No matching version|is not in this registry)\b/.test(stderr);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npm(args, env, cwd) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function main(argv) {
  const options = parseArgs(argv);
  const work = mkdtempSync(join(tmpdir(), 'jevris-post-publish-'));
  const home = join(work, 'home');
  mkdirSync(join(home, '.config'), { recursive: true });
  const stubs = writeHarnessStubs(join(work, 'bin'));
  const env = { ...testEnvironment(home, 'unused-real-home', stubs), npm_config_cache: join(work, 'cache'), npm_config_update_notifier: 'false' };
  delete env.JEVRIS_HOME;
  const steps = [];
  const record = (id, ok, detail) => {
    steps.push({ id, ok, detail: String(detail).slice(0, 1000) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: ${String(detail).split('\n')[0]}`);
  };
  try {
    const spec = packageSpec(options);
    let version;
    for (let attempt = 0; ; attempt += 1) {
      version = npm(['exec', '--yes', '--package', spec, '--', 'jevris', '--version'], env, work);
      if (version.status === 0 || !isPropagationError(version.stderr) || attempt >= options.retries) break;
      console.log(`registry does not serve ${spec} yet; retry ${attempt + 1}/${options.retries}`);
      sleep(Math.min(60000, 5000 * 2 ** attempt));
    }
    record('npx --version', version.status === 0 && version.stdout.includes(options.version), `${version.status} ${version.stdout.trim()} ${version.stderr.trim().slice(-300)}`);
    const doctor = npm(['exec', '--yes', '--package', spec, '--', 'jevris', 'doctor', '--home', home], env, work);
    record('npx doctor', doctor.status === 0, `${doctor.status} ${doctor.stdout.split('\n')[0] ?? ''} ${doctor.stderr.trim().slice(-300)}`);
    if (options.provenance) {
      const project = join(work, 'project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'package.json'), '{"name":"post-publish-check","version":"1.0.0","private":true}\n');
      const install = npm(['install', '--no-audit', '--no-fund', spec], env, project);
      record('install from registry', install.status === 0, install.stderr.trim().slice(-300));
      const audit = npm(['audit', 'signatures'], env, project);
      record('registry signatures and provenance attestation', audit.status === 0 && /verified attestation/.test(audit.stdout), audit.stdout.trim().slice(-400));
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
  const ok = steps.length > 0 && steps.every((step) => step.ok);
  const report = { schemaVersion: 1, kind: 'post-publish', package: `${PACKAGE_NAME}@${options.version}`, platform: process.platform, node: process.version, at: new Date().toISOString(), ok, steps };
  if (options.report !== undefined) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`post-publish: ${ok ? 'ok' : 'FAILED'} on ${process.platform} ${process.version}`);
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
