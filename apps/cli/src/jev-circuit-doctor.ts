/**
 * Doctor's Jev-disabled line (decision ea2af91a: status and doctor both show it; B's ruling on
 * how doctor reads it).
 *
 * - The disable is the running sidecar's state: its engine keys the circuit by provider and
 *   credential fingerprint, and lifts an entry left from an old key on the next call with the new
 *   one. So doctor asks a sidecar that is already running for its status and shows `jevCircuit`
 *   from it; it never reads the circuit file and never starts the sidecar. With no sidecar
 *   running, no circuit acts, and doctor's sidecar line already says so: no line here.
 * - The field is checked against the status contract's own schema, then rendered with status's
 *   jevCircuitLine: fixed text only (a reason code and class, a time, one command), never a key,
 *   a fingerprint or remote text.
 * - Severity (doctor-severity.ts): action. Billing or the account names
 *   `jevris credential reenable`; a refused key names `jevris credential set`.
 */
import { defineContract, JevCircuitStatusSchema, schema as S } from '@jevris/contracts';
import { jevCircuitLine } from './public/render.js';

const JevCircuitField = defineContract({
  name: 'DoctorJevCircuit',
  description: "The status answer's jevCircuit field, as doctor reads it from a running sidecar.",
  schema: S.nullable(JevCircuitStatusSchema),
});

/** The line for a status answer already read (tests pass one in); none for anything else. */
export function jevCircuitDoctorLinesFrom(status: unknown): string[] {
  if (typeof status !== 'object' || status === null) return [];
  const field = (status as { readonly jevCircuit?: unknown }).jevCircuit;
  if (field === undefined || field === null) return [];
  const checked = JevCircuitField.validate(field);
  return checked.ok && checked.value !== null ? [jevCircuitLine(checked.value)] : [];
}

/** status from a sidecar that is already running; null when none is or it does not answer. */
async function askRunningSidecar(home: string): Promise<unknown> {
  try {
    const sidecar = await import('@jevris/sidecar');
    const probe = await sidecar.probeSidecar(home, 500);
    if (!probe.running) return null;
    const res = await sidecar.sidecarRequest({ home, op: 'status', scope: 'cli', body: {}, timeoutMs: 5000 });
    return res.ok ? res.result : null;
  } catch {
    return null;
  }
}

/** Doctor's Jev line: one line while Jev is disabled, else none. */
export async function jevCircuitDoctorLines(home: string, ask?: () => Promise<unknown>): Promise<string[]> {
  let status: unknown;
  try {
    status = await (ask ?? (() => askRunningSidecar(home)))();
  } catch {
    return [];
  }
  return jevCircuitDoctorLinesFrom(status);
}
