#!/usr/bin/env node
/**
 * npm run test:future -- [--days N] [runner arguments...]
 *
 * Runs the suite (scripts/test.mjs, with its build, temporary home and guards) with every test
 * process, and every Node child it starts, living N days ahead (default 90); see
 * scripts/test-clock-shift.mjs. A test that fails here and passes under npm test depends on
 * today's date: a fixed date beside a real-clock one, a fixture that expires, or a bundled model
 * that reaches its retirement date. Other arguments pass through, for example --no-build or
 * test files.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './build.mjs';

export function parseFutureArgs(argv) {
  const rest = [];
  let days = 90;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') {
      const value = argv[i + 1];
      if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) throw new Error('--days takes a whole number of days from 1 to 999999');
      days = Number(value);
      i += 1;
    } else rest.push(argv[i]);
  }
  return { days, rest };
}

/** A run with no test file named is the full suite, and takes the host suite lock. */
export function isFullSuite(rest) {
  return !rest.some((arg) => !arg.startsWith('-'));
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFutureArgs(argv);
  } catch (error) {
    console.error(`test:future: ${error.message}`);
    return 2;
  }
  const at = new Date(Date.now() + parsed.days * 86_400_000).toISOString().slice(0, 10);
  console.error(`test:future: every test process runs ${parsed.days} day(s) ahead, on ${at}`);
  const runner = fileURLToPath(new URL('./test.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [runner, ...parsed.rest], { stdio: 'inherit', env: { ...process.env, JEVRIS_TEST_CLOCK_SHIFT_DAYS: String(parsed.days) } });
  return run.status ?? 1;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  let full = false;
  try {
    full = isFullSuite(parseFutureArgs(argv).rest);
  } catch {
    // main reports the usage error
  }
  if (full) {
    // The full suite runs one at a time on this machine (the host suite lock); the runner it
    // starts inherits the hold and does not wait for itself.
    const { runHostLocked } = await import('./suite-lock.mjs');
    process.exit(await runHostLocked(() => main(argv)));
  }
  process.exit(main(argv));
}
