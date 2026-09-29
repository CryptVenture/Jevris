#!/usr/bin/env node
/**
 * Promote a published version to the `latest` dist-tag only when `jevris gates` passes on
 * evidence (RLS-12, §22.2). Every publish lands on `next`; this is the only path to `latest`.
 *
 *   node scripts/promote.mjs --version 1.2.0 --evidence <dir> [--commit <sha>]          # dry run
 *   node scripts/promote.mjs --version 1.2.0 --evidence <dir> --commit <sha> --apply    # owner, npm 2FA
 *
 * Run from a checkout of the release tag after `npm ci && npm run build`: the gates are judged by
 * that exact build. --apply runs `npm dist-tag add @webventures/jevris@<version> latest` with the
 * owner's own npm login (it prompts for the 2FA code); CI never holds a token that can move latest.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';
import { npmCli } from './pack-smoke.mjs';
import { PACKAGE_NAME } from './release-policy.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function parseArgs(argv) {
  const options = { version: undefined, evidence: undefined, commit: undefined, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') options.version = argv[++i];
    else if (arg === '--evidence') options.evidence = argv[++i];
    else if (arg === '--commit') options.commit = argv[++i];
    else if (arg === '--apply') options.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (typeof options.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error('--version <semver> is required');
  if (typeof options.evidence !== 'string' || options.evidence.length === 0) throw new Error('--evidence <dir> is required');
  if (options.commit !== undefined && !/^[0-9a-f]{40}$/.test(options.commit)) throw new Error('--commit takes a full 40-character SHA');
  if (options.apply && options.commit === undefined) throw new Error('--apply needs --commit: latest is promoted only for evidence bound to the release commit');
  if (options.apply && options.version.includes('-')) throw new Error('a prerelease never becomes latest');
  return options;
}

export function distTagCommand(version) {
  return ['dist-tag', 'add', `${PACKAGE_NAME}@${version}`, 'latest'];
}

function main(argv) {
  const options = parseArgs(argv);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (pkg.version !== options.version) {
    console.error(`promote: this checkout is ${pkg.version}, not ${options.version}; check out v${options.version} and build it first`);
    return 2;
  }
  const gateArgs = [join(repoRoot, 'bin', 'jevris.mjs'), 'gates', '--evidence', options.evidence, ...(options.commit === undefined ? [] : ['--commit', options.commit])];
  const gates = spawnSync(process.execPath, gateArgs, { cwd: repoRoot, stdio: 'inherit', shell: false, windowsHide: true });
  if (gates.status !== 0) {
    console.error(`promote: jevris gates exited ${gates.status}; ${PACKAGE_NAME}@${options.version} stays on next`);
    return 1;
  }
  const command = distTagCommand(options.version);
  if (!options.apply) {
    console.log(`promote: gates pass. Dry run; to promote run: npm ${command.join(' ')}   (or re-run with --apply)`);
    return 0;
  }
  const view = spawnSync(process.execPath, [npmCli(), 'view', `${PACKAGE_NAME}@${options.version}`, 'version'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (view.status !== 0 || view.stdout.trim() !== options.version) {
    console.error(`promote: ${PACKAGE_NAME}@${options.version} is not on the registry`);
    return 1;
  }
  const tagged = spawnSync(process.execPath, [npmCli(), ...command], { stdio: 'inherit', shell: false, windowsHide: true });
  return tagged.status === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
