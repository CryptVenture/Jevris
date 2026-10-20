// The status view "subagent routing": per harness, what this workspace's recent subagent launches got (counts and reason codes only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearSubagentRouteNotes, noteSubagentRoute } from '@jevris/core';
import { noteSubagentStart, openWorkspace, subagentRoutingCounts } from '../dist/index.js';
import { closeTestStore, testStore } from './store-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;

function setup() {
  const dir = tempDir('jv-routing-');
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { dir, home, repo };
}

test('subagentRoutingCounts: routed, advice only, left alone (by reason), no note; not-applicable and old launches are not counted', async () => {
  clearSubagentRouteNotes();
  const { dir, home, repo } = setup();
  const store = testStore(dir);
  try {
    const ws = openWorkspace({ home, workspaceRoot: repo, env: { HOME: home }, store });
    const note = (sessionId, subagentType, outcome, reasonCode, modelId = null, atMs = NOW) => assert.equal(noteSubagentRoute({ workspaceId: ws.workspaceId, sessionId, subagentType, reasonCode, outcome, atMs, modelId }), true);
    let n = 0;
    const start = (harness, sessionId, agentType, atMs = NOW) => noteSubagentStart(ws, { harness, sessionId, agentId: `a${(n += 1)}`, agentType, nowMs: atMs });
    // Claude Code: one rewritten, one advised, three left alone (two for risk, one explicit model), one with no note.
    note('s1', 'Explore', 'rendered', 'SUBAGENT_ROUTE_RISK_RULE', 'claude-haiku-5-5');
    await start('claude', 's1', 'Explore');
    note('s1', 'Plan', 'explained', 'SUBAGENT_ROUTE_RISK_RULE', 'claude-haiku-5-5');
    await start('claude', 's1', 'Plan');
    for (const type of ['general-purpose', 'gsd-executor']) {
      note('s1', type, 'abstained', 'RISK_HIGH');
      await start('claude', 's1', type);
    }
    note('s1', 'general-purpose', 'abstained', 'EXPLICIT_MODEL');
    await start('claude', 's1', 'general-purpose');
    await start('claude', 's1', 'code-reviewer');
    // OpenCode: one left alone for no evidence. Antigravity has no route to apply: not counted at all.
    note('o1', 'explore', 'abstained', 'NO_EVIDENCE');
    await start('opencode', 'o1', 'explore');
    await start('antigravity', 'g1', 'x');
    // A launch from before the window is not counted.
    note('s0', 'Explore', 'abstained', 'RISK_HIGH');
    await start('claude', 's0', 'Explore', NOW - 9 * DAY);

    const counts = subagentRoutingCounts(ws, NOW - 7 * DAY);
    assert.deepEqual(counts.map((c) => c.harness), ['claude', 'opencode'], 'sorted; antigravity (not-applicable) is absent');
    const claude = counts[0];
    assert.deepEqual([claude.launches, claude.routed, claude.advised, claude.leftAlone, claude.unknown], [6, 1, 1, 3, 1]);
    assert.deepEqual(claude.reasons, [{ code: 'RISK_HIGH', count: 2 }, { code: 'EXPLICIT_MODEL', count: 1 }], 'most first, then by code');
    assert.deepEqual(counts[1], { harness: 'opencode', launches: 1, routed: 0, advised: 0, leftAlone: 1, unknown: 0, reasons: [{ code: 'NO_EVIDENCE', count: 1 }] });
    // The whole history includes the old launch; a window after everything has none.
    assert.equal(subagentRoutingCounts(ws, 0).find((c) => c.harness === 'claude').launches, 7);
    assert.deepEqual(subagentRoutingCounts(ws, NOW + DAY), []);
    // Content-free: ids, codes and counts only.
    assert.doesNotMatch(JSON.stringify(counts), /gsd-executor|general-purpose|code-reviewer/, 'no subagent type name is in the view');
  } finally {
    closeTestStore(store);
  }
});
