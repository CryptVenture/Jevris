/**
 * The release criterion "doctor proves it works" (RLS-04): after `jevris install` and
 * `jevris certify --harness all` in a sandbox home, `jevris doctor --json` must report
 *
 * - summary: installStatus "full", harnessProbe "certified", eventProbe "passed";
 * - every installed harness with at least one certification record and a passing smoke
 *   (the MCP handshake and the hook);
 * - no line of severity "action" or "broken", except the documented by-design ones below, and a
 *   harness line whose only miss is a feature a stand-in harness cannot prove (STAND_IN_UNPROVABLE);
 * - no private file with loose permissions (privateFiles.loose empty).
 *
 * `doctorProofProblems(json)` returns one plain sentence per failed item, naming it; an empty
 * list is a pass. scripts/pack-smoke.mjs runs it; test/doctor-proof.test.mjs pins it.
 */

/**
 * Lines that ask for an action doctor can never see done, by design, each documented in the
 * named guide. Nothing else may ask for an action on a certified install.
 */
export const BY_DESIGN_ACTIONS = [
  // Codex keeps its /hooks trust decisions to itself; the user trusts the hooks in Codex.
  { pattern: /^harness codex hookTrust: /, doc: 'docs/harnesses/codex.md' },
];

/**
 * Features certified only by a no-cost stub-model turn (certify's stub cases, OD-9): the harness
 * runs a real turn against the loopback stub. The stand-in harnesses the pack smoke installs into
 * start no turn, so these can never pass there; the owner's live certify run proves them. A harness
 * line that asks for an action only because of these is a limit of the stand-ins, not of the install.
 */
export const STAND_IN_UNPROVABLE = ['hooks.route', 'session.route', 'models.list-hosts', 'route.host'];

/**
 * True when a harness line's only action is `not certified here:` for stand-in-unprovable features.
 * Every other clause must be one a certified line carries; anything else still fails the proof.
 */
export function standInOnlyAction(text) {
  const match = /^harness ([a-z]+): installed; (.*)$/.exec(text);
  if (match === null) return false;
  let limited = false;
  for (const clause of match[2].split('; ')) {
    if (/^version \S+$/.test(clause) || /^certification records: \d+$/.test(clause) || clause.startsWith('certified for ') || clause.startsWith('optional, not certified here: ')) continue;
    if (clause.startsWith('fix: jevris certify --harness ')) continue;
    if (clause.startsWith('not certified here: ')) {
      const features = clause.slice('not certified here: '.length).split(', ').map((item) => item.replace(/ \([A-Z_]+\)$/, ''));
      if (features.some((feature) => !STAND_IN_UNPROVABLE.includes(feature))) return false;
      limited = true;
      continue;
    }
    return false;
  }
  return limited;
}

export function doctorProofProblems(json) {
  const problems = [];
  if (json === null || typeof json !== 'object') return ['doctor --json printed no JSON object'];
  const summary = json.summary ?? {};
  const want = { installStatus: 'full', harnessProbe: 'certified', eventProbe: 'passed' };
  for (const [key, value] of Object.entries(want)) {
    if (summary[key] !== value) problems.push(`summary.${key} is ${JSON.stringify(summary[key] ?? null)}, not "${value}"`);
  }
  const harnesses = Array.isArray(json.harnesses) ? json.harnesses : [];
  const installed = harnesses.filter((row) => row?.installed === true);
  if (installed.length === 0) problems.push('no harness is reported as installed');
  for (const row of installed) {
    const name = String(row.harness);
    if (!(Number(row.certificationRecords) > 0)) problems.push(`harness ${name} has no certification record`);
    const smoke = Array.isArray(row.smoke) ? row.smoke : [];
    for (const check of ['mcp', 'hook']) {
      const found = smoke.find((item) => item?.check === check);
      if (found?.ok !== true) problems.push(`harness ${name} ${check} smoke ${found === undefined ? 'is missing' : `failed: ${String(found.detail ?? '')}`}`);
    }
  }
  const lines = Array.isArray(json.lines) ? json.lines : null;
  if (lines === null) problems.push('doctor --json has no lines[] with severities');
  for (const line of lines ?? []) {
    if (line?.severity !== 'action' && line?.severity !== 'broken') continue;
    const text = String(line.text ?? '');
    if (line.severity === 'action' && BY_DESIGN_ACTIONS.some((item) => item.pattern.test(text))) continue;
    if (line.severity === 'action' && standInOnlyAction(text)) continue;
    problems.push(`${line.severity}: ${text.slice(0, 240)}`);
  }
  const loose = json.privateFiles?.loose;
  if (!Array.isArray(loose)) problems.push('doctor --json has no privateFiles.loose[]');
  for (const file of loose ?? []) problems.push(`private file with loose mode ${String(file?.mode ?? '?')}: ${String(file?.path ?? '?')} (want 0700 for a folder, 0600 for a file)`);
  return problems;
}
