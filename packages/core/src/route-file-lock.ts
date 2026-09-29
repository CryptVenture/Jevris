/**
 * The exclusive lock for a machine-wide route-learning file (a directory beside it), so every
 * sidecar on the machine can write it. A lock older than 10 s is taken over; a wait longer than
 * 3 s gives up (null).
 */
import { mkdir, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock, { recursive: false, mode: 0o700 });
      break;
    } catch {
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => null);
      if (age !== null && age > LOCK_STALE_MS) {
        await rmdir(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) return null;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}
