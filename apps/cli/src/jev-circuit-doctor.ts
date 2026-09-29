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
import { defineContract, jevBudgetText, JevCircuitStatusSchema, StatusBudgetSchema, schema as S } from '@jevris/contracts';
import { jevCircuitLine } from './public/render.js';

const JevCircuitField = defineContract({
  name: 'DoctorJevCircuit',
  description: "The status answer's jevCircuit field, as doctor reads it from a running sidecar.",
  schema: S.nullable(JevCircuitStatusSchema),
});

const BudgetField = defineContract({
  name: 'DoctorJevBudget',
  description: "The status answer's budget field, as doctor reads it from a running sidecar.",
  schema: StatusBudgetSchema,
});

/**
 * Doctor's Jev budget line (owner decision 2026-09-29): one line while the machine-wide monthly
 * limit has no room, so decisions run rules-only; none otherwise. Fixed text from the checked
 * field: the reason code, the amounts, the reset date and the command that raises it.
 */
export function jevBudgetDoctorLine(budget: unknown): string | null {
  const checked = BudgetField.validate(budget);
  if (!checked.ok) return null;
  const b = checked.value;
  if (b.state !== 'exhausted' || b.exhaustedBy !== 'machine' || b.limitMicroUsd === null) return null;
  if (b.limitMicroUsd === 0) return 'jev budget: 0 (BUDGET_MACHINE_LIMIT, BUDGET_ZERO): no Jev calls by setting; Jevris decides rules-only; change it with jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>';
  const until = b.resetsAt === undefined ? '' : ` until ${b.resetsAt.slice(0, 10)} (UTC)`;
  const spent = b.spentMicroUsd === undefined ? '' : ` (${jevBudgetText(b.spentMicroUsd)} of ${jevBudgetText(b.limitMicroUsd)}${b.period === undefined ? '' : ` in ${b.period}`})`;
  return `jev budget: spent (BUDGET_MACHINE_LIMIT)${spent}; Jevris decides rules-only${until}; raise it with jevris configure set decisions.monthlyBudgetMicroUsd <micro-USD>`;
}

/** The lines for a status answer already read (tests pass one in); none for anything else. */
export function jevCircuitDoctorLinesFrom(status: unknown): string[] {
  if (typeof status !== 'object' || status === null) return [];
  const lines: string[] = [];
  const field = (status as { readonly jevCircuit?: unknown }).jevCircuit;
  if (field !== undefined && field !== null) {
    const checked = JevCircuitField.validate(field);
    if (checked.ok && checked.value !== null) lines.push(jevCircuitLine(checked.value));
  }
  const budget = jevBudgetDoctorLine((status as { readonly budget?: unknown }).budget);
  if (budget !== null) lines.push(budget);
  return lines;
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
