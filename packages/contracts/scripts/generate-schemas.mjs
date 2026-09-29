#!/usr/bin/env node
/**
 * Writes the generated contract JSON Schemas to packages/contracts/schemas, or with --check
 * compares them and exits 1 on drift (a changed, missing or extra *.schema.json file).
 * Needs a built dist (npm run build). Cross-platform: node:path only; CRLF is normalised.
 *
 *   node packages/contracts/scripts/generate-schemas.mjs [--check] [--dir <path>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SCHEMA_DIR = join(packageRoot, 'schemas');

async function documents() {
  const { schemaDocuments } = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href);
  return schemaDocuments();
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Compares a directory with the generated documents. */
export async function checkSchemas(dir = DEFAULT_SCHEMA_DIR) {
  const expected = await documents();
  const present = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.schema.json')) : [];
  const changed = [];
  const missing = [];
  for (const [name, text] of expected) {
    if (!present.includes(name)) missing.push(name);
    else if (normalise(readFileSync(join(dir, name), 'utf8')) !== text) changed.push(name);
  }
  const extra = present.filter((name) => !expected.has(name)).sort();
  return { ok: changed.length + missing.length + extra.length === 0, changed, missing, extra };
}

/** Writes every generated document and removes stale *.schema.json files. */
export async function writeSchemas(dir = DEFAULT_SCHEMA_DIR) {
  const expected = await documents();
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.schema.json') && !expected.has(name)) rmSync(join(dir, name));
  }
  for (const [name, text] of expected) writeFileSync(join(dir, name), text);
  return [...expected.keys()];
}

async function main(argv) {
  const check = argv.includes('--check');
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 && argv[dirIndex + 1] !== undefined ? resolve(argv[dirIndex + 1]) : DEFAULT_SCHEMA_DIR;
  if (!check) {
    const written = await writeSchemas(dir);
    process.stdout.write(`wrote ${written.length} contract schemas to ${dir}\n`);
    return 0;
  }
  const result = await checkSchemas(dir);
  if (result.ok) {
    process.stdout.write('contract schemas are up to date\n');
    return 0;
  }
  for (const name of result.changed) process.stderr.write(`schema drift: ${name} differs from the contracts\n`);
  for (const name of result.missing) process.stderr.write(`schema drift: ${name} is missing\n`);
  for (const name of result.extra) process.stderr.write(`schema drift: ${name} has no contract\n`);
  process.stderr.write('run: node packages/contracts/scripts/generate-schemas.mjs\n');
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
