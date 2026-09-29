#!/usr/bin/env node
/**
 * Branch protection for main (BLD-11, E-10). A repository admin runs it once Actions are enabled.
 *
 *   node scripts/branch-protection.mjs            # print the payload and the gh command (dry run)
 *   node scripts/branch-protection.mjs --apply    # gh api PUT .../branches/main/protection
 *
 * Required checks: the nine CI matrix cells, CodeQL and dependency review, and the installed
 * pack smoke on three OSes. Uses the admin's own `gh` login; no token is stored anywhere.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './build.mjs';

export const REPOSITORY = 'CryptVenture/Jevris';
export const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
export const NODES = ['22.14.0', '24', 'latest'];

export function requiredChecks() {
  return [
    ...OSES.flatMap((os) => NODES.map((node) => `test (${os}, ${node})`)),
    ...OSES.map((os) => `pack-smoke (${os})`),
    'codeql (javascript-typescript)',
    'dependency-review',
  ];
}

export function protectionPayload() {
  return {
    required_status_checks: { strict: true, contexts: requiredChecks() },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true,
  };
}

function main(argv) {
  const apply = argv.includes('--apply');
  const payload = `${JSON.stringify(protectionPayload(), null, 2)}\n`;
  const args = ['api', '-X', 'PUT', `repos/${REPOSITORY}/branches/main/protection`, '--input'];
  if (!apply) {
    console.log(payload);
    console.log(`dry run. An admin applies it with: node scripts/branch-protection.mjs --apply   (gh ${args.join(' ')} <payload>)`);
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'jevris-protection-'));
  try {
    const file = join(dir, 'protection.json');
    writeFileSync(file, payload);
    const result = spawnSync('gh', [...args, file], { stdio: 'inherit', shell: false, windowsHide: true });
    return result.status === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
