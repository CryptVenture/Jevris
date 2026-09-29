#!/usr/bin/env node
// Guard before anything native loads. better-sqlite3 is built for N-API 10 and crashes
// (exit 139) on older Node releases, so check first and load the CLI dynamically after.
const napi = Number.parseInt(String(process.versions.napi ?? '0'), 10);
if (!Number.isFinite(napi) || napi < 10) {
  process.stderr.write(
    `jevris needs Node ^22.14.0 || >=23.6.0 (N-API 10 or later). This is Node ${process.version} with N-API ${process.versions.napi ?? 'unknown'}.\n`,
  );
  process.exit(2);
}

// Every file this process creates starts owner-only on POSIX (BLD-08).
if (process.platform !== 'win32') process.umask(0o077);

// The published package ships one bundled CLI file (PKG-06); scripts/build.mjs writes it.
const { main } = await import('../dist/cli.mjs');
const code = await main(process.argv.slice(2));
process.exit(code);
