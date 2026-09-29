/**
 * Test-home guard (ADM-01, owner decision 2026-09-26). `--home` is optional and defaults to
 * JEVRIS_HOME, else the real home. In the test environment (JEVRIS_TEST=1) a command must never
 * reach the real home, so it is refused, loudly, when:
 * - no explicit home was given (neither --home nor JEVRIS_HOME), or
 * - the home it resolved is the real home: the account's home directory, or the
 *   JEVRIS_TEST_REAL_HOME the test runner records.
 * Outside the test environment this never refuses anything.
 */
import { userInfo } from 'node:os';
import { resolve } from 'node:path';

export interface ResolvedHome {
  readonly home: string;
  readonly source: string;
}

export interface HomeRefusal {
  readonly reasonCode: 'HOME_REQUIRED_IN_TEST' | 'REAL_HOME_IN_TEST';
  readonly message: string;
}

function accountHome(): string | null {
  try {
    // The account's home from the user database, not $HOME (the runner points $HOME at a temp dir).
    const home = (userInfo() as unknown as { readonly homedir?: unknown }).homedir;
    return typeof home === 'string' && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string, platform: string): boolean {
  const fold = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
  };
  return fold(a) === fold(b);
}

export function testHomeRefusal(
  resolved: ResolvedHome,
  env: { readonly [key: string]: string | undefined } = process.env,
  options: { readonly platform?: string; readonly accountHome?: string | null } = {},
): HomeRefusal | null {
  if (env['JEVRIS_TEST'] !== '1') return null;
  if (resolved.source === 'os') {
    return {
      reasonCode: 'HOME_REQUIRED_IN_TEST',
      message: 'JEVRIS_TEST=1 and no --home or JEVRIS_HOME: a test must name its temporary home, so the real home is never used',
    };
  }
  const platform = options.platform ?? process.platform;
  const real = [env['JEVRIS_TEST_REAL_HOME'] ?? null, options.accountHome === undefined ? accountHome() : options.accountHome].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (real.some((p) => sameDir(p, resolved.home, platform))) {
    return { reasonCode: 'REAL_HOME_IN_TEST', message: `JEVRIS_TEST=1 and the home ${resolved.home} is the real home: tests use a temporary home only` };
  }
  return null;
}
