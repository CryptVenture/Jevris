#!/usr/bin/env node
/**
 * SHA256SUMS for release assets (PKG-11): `node scripts/checksums.mjs <file>... --out SHA256SUMS`.
 * The format is `sha256sum`'s (`<hex>  <basename>`), so `sha256sum -c SHA256SUMS` verifies it on
 * Linux, `shasum -a 256 -c` on macOS and `scripts/checksums.mjs --check` anywhere.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isMain } from './build.mjs';

export function checksumLine(file) {
  return `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`;
}

export function checksums(files) {
  return `${[...files].sort((a, b) => basename(a).localeCompare(basename(b))).map(checksumLine).join('\n')}\n`;
}

/** Verifies a SHA256SUMS file against the files next to it. Returns the mismatching names. */
export function verify(sumsFile) {
  const bad = [];
  for (const line of readFileSync(sumsFile, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (match === null) continue;
    const file = join(dirname(sumsFile), match[2]);
    let actual = '';
    try {
      actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    } catch {
      actual = 'missing';
    }
    if (actual !== match[1]) bad.push(match[2]);
  }
  return bad;
}

function main(argv) {
  const checkIndex = argv.indexOf('--check');
  if (checkIndex >= 0) {
    const bad = verify(argv[checkIndex + 1]);
    for (const name of bad) console.error(`checksum mismatch: ${name}`);
    return bad.length === 0 ? 0 : 1;
  }
  const outIndex = argv.indexOf('--out');
  const files = argv.filter((arg, index) => arg !== '--out' && index !== outIndex + 1);
  if (files.length === 0 || outIndex < 0) {
    console.error('usage: node scripts/checksums.mjs <file>... --out SHA256SUMS | --check SHA256SUMS');
    return 2;
  }
  writeFileSync(argv[outIndex + 1], checksums(files));
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
