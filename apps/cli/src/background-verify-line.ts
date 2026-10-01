/**
 * The value of the `background verify at stop` line in `jevris status` and `jevris configure`.
 *
 * Observe, advise and actuate are separate: a Stop that queues the approved checks is an actuation,
 * so the setting acts only when the mode allows acting (`bounded-auto`). With the setting on and a
 * lower mode the line says why nothing is queued, in the same words the docs use, so a person who
 * turned the setting on is never left wondering why no check ran at Stop.
 */
import { modeAllows, type Mode } from '@jevris/contracts';

export function backgroundVerifyAtStopText(setting: 'off' | 'on', mode: Mode, whenOn: string): string {
  if (setting !== 'on') return 'off';
  if (modeAllows(mode, 'actuate')) return `on (${whenOn})`;
  return `on, but mode ${mode} never runs checks at Stop: only bounded-auto does (observe, advise and actuate are separate)`;
}
