#!/usr/bin/env node
/**
 * Runtime assets ship in assets/ (BLD-04). Product code never reads fixtures/ at
 * runtime, so each asset is a checked-in copy of its source. This script
 * copies the sources over; `--check` exits 1 when any copy drifted. test/assets.test.mjs
 * runs the check in npm test.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** [shipped asset, source of truth], both repository-relative with forward slashes. */
export const ASSET_SOURCES = [
  ['assets/schemas/pack-manifest.schema.json', 'fixtures/ssot/schemas/pack-manifest.schema.json'],
  ['assets/evaluation/frontier-corpus.json', 'fixtures/evaluation/frontier-corpus.json'],
  ['assets/evaluation/cost-registry.json', 'fixtures/evaluation/cost-registry.json'],
];

function abs(root, rel) {
  return join(root, ...rel.split('/'));
}

export function driftedAssets(root = repoRoot) {
  const drifted = [];
  for (const [asset, source] of ASSET_SOURCES) {
    const a = abs(root, asset);
    const s = abs(root, source);
    if (!existsSync(a) || !existsSync(s) || !readFileSync(a).equals(readFileSync(s))) drifted.push(asset);
  }
  return drifted;
}

function main(argv) {
  if (argv.includes('--check')) {
    const drifted = driftedAssets();
    for (const asset of drifted) console.error(`drifted: ${asset}`);
    return drifted.length === 0 ? 0 : 1;
  }
  for (const [asset, source] of ASSET_SOURCES) {
    mkdirSync(dirname(abs(repoRoot, asset)), { recursive: true });
    copyFileSync(abs(repoRoot, source), abs(repoRoot, asset));
  }
  console.log(`synced ${ASSET_SOURCES.length} assets`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
