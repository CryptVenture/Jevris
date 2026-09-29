import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorProofProblems, standInOnlyAction } from '../scripts/doctor-proof.mjs';

function certified() {
  return {
    summary: { installStatus: 'full', harnessProbe: 'certified', eventProbe: 'passed' },
    harnesses: ['claude', 'codex'].map((harness) => ({ harness, installed: true, certificationRecords: 1, smoke: [{ check: 'mcp', ok: true, detail: '17 tools' }, { check: 'hook', ok: true }] })),
    lines: [
      { text: 'installStatus: full', severity: 'ok' },
      { text: 'harness codex parity: not available in codex, by design: statusLine', severity: 'info' },
      { text: 'harness codex hookTrust: Codex keeps its /hooks trust decisions to itself; run /hooks in Codex', severity: 'action' },
      { text: '  continuation', severity: null },
    ],
    privateFiles: { loose: [] },
  };
}

test('a certified, fully installed doctor report passes the release check (RLS-04)', () => {
  assert.deepEqual(doctorProofProblems(certified()), []);
});

test('each failed item is named: summary, certification, smoke, action and broken lines, loose modes (RLS-04)', () => {
  const report = certified();
  report.summary.installStatus = 'unsupported';
  report.harnesses[0].certificationRecords = 0;
  report.harnesses[1].smoke[0] = { check: 'mcp', ok: false, detail: 'handshake failed' };
  report.lines.push({ text: 'harness kilo auth: unknown (not detected, and not stated)', severity: 'action' });
  report.lines.push({ text: 'sidecar: store unreadable', severity: 'broken' });
  report.privateFiles.loose.push({ path: '/h/.jevris/key', kind: 'file', mode: '0644' });
  assert.deepEqual(doctorProofProblems(report), [
    'summary.installStatus is "unsupported", not "full"',
    'harness claude has no certification record',
    'harness codex mcp smoke failed: handshake failed',
    'action: harness kilo auth: unknown (not detected, and not stated)',
    'broken: sidecar: store unreadable',
    'private file with loose mode 0644: /h/.jevris/key (want 0700 for a folder, 0600 for a file)',
  ]);
});

test('the by-design exception covers only the documented Codex hook-trust action, never a broken line (RLS-04)', () => {
  const report = certified();
  report.lines.push({ text: 'harness codex hookTrust: something broke', severity: 'broken' });
  report.lines.push({ text: 'harness claude hookTrust: run /hooks', severity: 'action' });
  assert.deepEqual(doctorProofProblems(report), ['broken: harness codex hookTrust: something broke', 'action: harness claude hookTrust: run /hooks']);
});

test('a report without the fields the check reads fails, naming them (RLS-04)', () => {
  assert.deepEqual(doctorProofProblems(null), ['doctor --json printed no JSON object']);
  const problems = doctorProofProblems({ harnesses: [] });
  assert.ok(problems.includes('no harness is reported as installed'));
  assert.ok(problems.includes('doctor --json has no lines[] with severities'));
  assert.ok(problems.includes('doctor --json has no privateFiles.loose[]'));
});

test('a harness line that misses only stub-turn features is a stand-in limit; any other miss still fails (RLS-04)', () => {
  const head = 'harness kilocode: installed; version 7.7.9; certification records: 1; certified for >=7.7.9 <7.8.0 (last verified 7.7.9, 2026-09-28): plugin.install, mcp.tools';
  const standIn = `${head}; not certified here: hooks.route (ROUTE_CASE_FAILED), session.route (SESSION_ROUTE_CASE_FAILED), models.list-hosts (MODELS_LIST_HOSTS_FAILED), route.host (ROUTE_HOST_NEEDS_SESSION_ROUTE); optional, not certified here: access.detect (ACCESS_DETECT_CASE_FAILED); fix: jevris certify --harness kilo`;
  assert.equal(standInOnlyAction(standIn), true);
  const hooks = `${head}; not certified here: hooks.route (ROUTE_CASE_FAILED), hooks.context (HOOKS_NOT_RUNNING); fix: jevris certify --harness kilo`;
  assert.equal(standInOnlyAction(hooks), false);
  assert.equal(standInOnlyAction(`${head}; something else went wrong; fix: jevris certify --harness kilo`), false);
  assert.equal(standInOnlyAction(`${head}; fix: jevris certify --harness kilo`), false);
  assert.equal(standInOnlyAction('harness kilocode: not installed; not certified here: hooks.route (ROUTE_CASE_FAILED)'), false);
  const report = certified();
  report.lines.push({ text: standIn, severity: 'action' });
  report.lines.push({ text: hooks, severity: 'action' });
  assert.deepEqual(doctorProofProblems(report), [`action: ${hooks.slice(0, 240)}`]);
});
