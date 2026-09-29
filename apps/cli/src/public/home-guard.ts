/**
 * Public-surface side of the ADM-01 test-home guard. `--home` is optional on every public command
 * and defaults to JEVRIS_HOME, else the real home. In the test environment (JEVRIS_TEST=1) the
 * CLI and MCP commands refuse the same way the admin commands do (apps/cli/src/home-guard.ts):
 * HOME_REQUIRED_IN_TEST when no home was named, REAL_HOME_IN_TEST when the named home is the
 * real one. Outside the test environment this never refuses.
 */
import { testHomeRefusal } from '../home-guard.js';
import type { SurfaceContext } from './context.js';

export function homeRefusal(ctx: Pick<SurfaceContext, 'env' | 'home' | 'homeSource'>): string | null {
  const refusal = testHomeRefusal({ home: ctx.home, source: ctx.homeSource }, ctx.env);
  return refusal === null ? null : `refused (${refusal.reasonCode}): ${refusal.message}`;
}
