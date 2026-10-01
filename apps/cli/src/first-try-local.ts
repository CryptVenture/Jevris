/**
 * The first-try views for the commands that answer without the sidecar (`jevris status` in reduced
 * mode, `jevris cost-report`): the same orchestrator functions the sidecar uses, over the local
 * first-try ledger. The workspace is opened only when its orchestration folder already exists, so
 * asking never creates state for a folder Jevris has not worked in. Any failure reads as no view.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FirstTrySetting, FirstTryStatus } from '@jevris/contracts';
import { emptyFirstTryCostView, firstTryCostView, firstTryStatusView, openWorkspace, type FirstTryCostView, type WorkspaceServices } from '@jevris/orchestrator';
import type { SurfaceContext } from './public/context.js';

type Where = Pick<SurfaceContext, 'home' | 'paths' | 'workspaceRoot' | 'workspaceId'>;

/** The workspace's services when Jevris has state for it, else null. */
export function firstTryWorkspaceOf(ctx: Where): WorkspaceServices | null {
  if (ctx.workspaceRoot === null || !existsSync(join(ctx.paths.data, 'orchestration', ctx.workspaceId))) return null;
  try {
    return openWorkspace({ home: ctx.home, workspaceRoot: ctx.workspaceRoot, workspaceId: ctx.workspaceId });
  } catch {
    return null;
  }
}

/** The `status` view from local state; undefined when it cannot be read. */
export async function localFirstTryStatus(ctx: Where, setting: FirstTrySetting): Promise<FirstTryStatus | undefined> {
  try {
    return await firstTryStatusView({ home: ctx.home, ws: firstTryWorkspaceOf(ctx), setting });
  } catch {
    return undefined;
  }
}

/** The `cost-report` view from local state; the empty view when the workspace has no state, null when it cannot be read. */
export async function localFirstTryCost(ctx: Where, setting: FirstTrySetting): Promise<FirstTryCostView | null> {
  try {
    const ws = firstTryWorkspaceOf(ctx);
    return ws === null ? emptyFirstTryCostView(setting) : await firstTryCostView({ ws, setting });
  } catch {
    return null;
  }
}
