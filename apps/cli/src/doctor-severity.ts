/**
 * The severity of each doctor line (agreed with E, 2026-09-26). The terminal shows
 * ok as ✓, info as a dim i, action as ! and broken as ✗; doctor --json carries the same value
 * per line so a release gate can require no action and no broken line.
 *
 * - ok: works.
 * - info: a by-design limit or a plain fact; nothing to do.
 * - action: a real problem the user can fix; the line names the command.
 * - broken: something is damaged or failing.
 *
 * null means the line is not a keyed doctor line (a reason line under an actuator, the
 * verification reason, the same-user limit): it continues the line above it.
 */

export type DoctorSeverity = 'ok' | 'info' | 'action' | 'broken';

/** Actuator rows that are unsupported by design here (the harness lines carry the fixes). */
function actuatorSeverity(status: string): DoctorSeverity {
  return status === 'certified' ? 'ok' : 'info';
}

function harnessSeverity(rest: string): DoctorSeverity {
  // rest: "<harness>: installed; ..." or "<harness> <check>: ..."
  const match = /^([a-z]+)(?: ([A-Za-z. ]+))?: (.*)$/.exec(rest);
  if (match === null) return 'info';
  const check = match[2] ?? '';
  const body = match[3] ?? '';
  if (check === '') {
    if (body.startsWith('not installed')) return 'info';
    // Automatic: a background re-check is running, nothing to do.
    if (body.includes('re-checking in the background')) return 'info';
    if (body.includes('; not certified here: ')) return 'action';
    return /; certified for /.test(body) ? 'ok' : 'action';
  }
  if (check === 'install') return 'action';
  if (check === 'mcp handshake' || check === 'hook fixture') return body.startsWith('ok') ? 'ok' : 'broken';
  if (check === 'parity') return 'info';
  if (check === 'hookTrust') return 'action';
  if (check === 'products') return 'info';
  if (check === 'policy') return 'action';
  if (check === 'worker') {
    if (body.startsWith('verified in use') || body.startsWith('certified, pending first use')) return 'ok';
    // Automatic: a background re-check is running, nothing to do.
    return body.includes('re-checking in the background') ? 'info' : 'action';
  }
  if (check === 'auth') {
    if (body.startsWith('unknown')) return 'action';
    // authLine: "<mode> (<source>; <detected>)[; <problem>]"
    if (/\); /.test(body)) return 'action';
    // A stated mode is settled; an unprobed auto mode is only a fact about this run.
    return /not probed/.test(body) && !/\(stated in workers\.json;/.test(body) ? 'info' : 'ok';
  }
  return 'info';
}

function sidecarSeverity(body: string): DoctorSeverity {
  if (body.startsWith('running')) return body.startsWith('running (degraded)') ? 'broken' : 'ok';
  if (body.startsWith('idle')) return body.startsWith('idle (degraded)') ? 'action' : 'info';
  // Not running by the user's choice (autostart off) is a fact; not running when it should is not.
  if (body.startsWith('not-running')) return body.startsWith('not-running (degraded)') ? 'action' : 'info';
  if (body.startsWith('in another execution environment')) return 'info';
  return 'broken';
}

/** The severity of one doctor line, or null when it continues the line above. */
export function doctorLineSeverity(line: string): DoctorSeverity | null {
  const at = line.indexOf(': ');
  if (at <= 0) return null;
  const key = line.slice(0, at);
  const body = line.slice(at + 2);
  const first = key.split(' ')[0] ?? '';
  switch (first) {
    case 'harnessVersion':
      return body === 'unknown' ? 'info' : 'ok';
    case 'harnessProbe':
      if (body.startsWith('certified')) return 'ok';
      if (body.includes('nothing to do: doctor shows the result')) return 'info';
      if (body.startsWith('unsupported') && body.includes('was not found')) return 'info';
      return 'action';
    case 'eventProbe':
      if (body.includes('nothing to do: doctor shows the result')) return 'info';
      return body.startsWith('passed') ? 'ok' : 'action';
    case 'installStatus':
      if (body.startsWith('full')) return 'ok';
      if (body.includes('nothing to do: doctor shows the result')) return 'info';
      return body.startsWith('refused') ? 'broken' : 'action';
    case 'egressDecision':
    case 'egressReasonCode':
      // Nothing leaves the machine until the owner approves it: by design.
      return 'info';
    case 'actuator':
      return key.split(' ').length === 2 ? actuatorSeverity(body) : null;
    case 'verification':
      return key === 'verification' ? (body === 'supported' ? 'ok' : 'info') : null;
    case 'pack':
      return body.startsWith('disabled') ? 'action' : 'info';
    case 'sidecar':
      // `sidecar build:` is a running sidecar on an older build than the installed runtime.
      return key === 'sidecar' ? sidecarSeverity(body) : key === 'sidecar build' ? 'action' : null;
    case 'harness':
      return harnessSeverity(line.slice('harness '.length));
    case 'workers.json':
      return 'broken';
    case 'certification':
      return body.startsWith('rejected') ? 'action' : 'info';
    case 'nativeAddon':
      if (body.startsWith('loaded')) return 'ok';
      if (key === 'nativeAddon keyring') return 'info';
      return 'broken';
    case 'privateFiles':
      return body === 'ok' ? 'ok' : 'action';
    case 'legacyLayout':
      return body === 'none' ? 'ok' : 'action';
    case 'jevris':
      // The `jevris` command: on PATH works; another jevris running first is a fact; a missing
      // PATH entry or launcher names its fix; a launcher whose Node or runtime is gone is broken.
      if (key !== 'jevris command') return null;
      if (body.startsWith('on PATH')) return 'ok';
      if (body.startsWith('broken')) return 'broken';
      if (body.startsWith('not on PATH') || body.startsWith('not installed')) return 'action';
      return 'info';
    case 'modelAvailability':
      // A model found gone on this machine is never routed: the line names the clear command for
      // once it is back. One not accessible from one harness and sign-in is a fact about that harness.
      return body.includes('(MODEL_GONE') ? 'action' : 'info';
    case 'modelRegistry':
      // An administrator override that does not validate leaves routing unavailable.
      return body.startsWith('the administrator override') ? 'broken' : 'info';
    case 'dataTerms':
      // What each provider does with what it receives, per sign-in: a fact to read.
      return key.split(' ').length === 2 ? 'info' : null;
    case 'providerConsent':
    case 'servingHosts':
    case 'hostTariffs':
      // Consent is the user's choice per maker and per serving host, and the hosts' tariffs are the
      // registry's facts; the lines only report them.
      return 'info';
    case 'accessLimits':
    case 'accessLimit':
      // Access limits (gap 5): nothing in force is ok; a timed pause lifts by itself (info); an
      // untimed one (credit, account) or an unreadable record needs the person (action). Never broken.
      if (key === 'accessLimits full') return 'info';
      // A damaged record set aside: pauses recorded before it may be missing (B's MEDIUM 41).
      if (key === 'accessLimits set aside') return 'action';
      if (key === 'accessLimits') {
        if (body === 'none in force') return 'ok';
        // A read that failed this time changes nothing and is retried: a fact, not a task.
        if (body.startsWith('the record could not be read this time')) return 'info';
        return body.startsWith('the record could not be read') || body.startsWith('the record was written by a newer') || / untimed /.test(body) ? 'action' : 'info';
      }
      return / since /.test(body) ? 'action' : 'info';
    case 'accessUsage':
      // OP-6: a Codex usage reading. A used-up window or usage not allowed means routes skip that
      // sign-in until the reset (action); otherwise, and for an unreadable file, it is a fact (info).
      return / used up/.test(body) || body.startsWith('usage not allowed') ? 'action' : 'info';
    case 'jev':
      // Jev disabled after a billing, account or key refusal (decision ea2af91a): the person fixes
      // the cause, then runs the command the line names. Decisions go on rules-only meanwhile.
      if (key === 'jev budget') return body.includes('BUDGET_ZERO') ? 'info' : 'action';
      return key === 'jev' ? 'action' : null;
    case 'credentialSource':
      // The opt-in Jev key source (GOV-07): a file that passes the owner-only checks works; a refused one names its fix.
      return body.startsWith('refused') ? 'action' : 'ok';
    case 'settings':
      // The effective mode and the layer that set it is a fact; a problem with a policy file that
      // caps it (refused as an authority, unreadable or invalid) names its fix.
      if (key === 'settings mode' || key === 'settings notice') return 'info';
      return key === 'settings issue' ? 'action' : null;
    case 'storeIdentity':
      // The host-name fallback is a limit of this machine, with the fix named in the line.
      return body.startsWith('machine id') ? 'ok' : 'info';
    default:
      break;
  }
  // The test-only diagnostics (provider override, test worker port) say what a test changed.
  if (line.startsWith('test provider override ') || line.startsWith('test worker port ')) return 'info';
  return null;
}
