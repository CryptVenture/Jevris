/**
 * The secret screen for text a capability keeps.
 *
 * Every request to Jev is screened for credentials first (the packet builder, then the transport guard), and a finding stops
 * the request. Text that a capability only stores (a question proposal in an evidence blob or on a proposals branch, a
 * campaign plan) never reaches that screen, so it gets the same rules here before anything is written: the packet builder's
 * (`screenText`) and the contracts' credential shapes (`containsSecret`). A finding stops the capability with `SECRET_BLOCKED`
 * (the code the engine uses for the same finding) and nothing is sent, stored or written.
 *
 * Sensitive path names (`.env`, `id_rsa`) are not screened here: the name of a file is not a credential, and the capability
 * keeps it for the person who wrote it. The packet builder still refuses them on a request, as before.
 */
import { containsSecret } from '@jevris/contracts';
import { screenText } from '@jevris/core';
import { abstainAdvice, type CapabilityAdvice, type CapabilityDefinition } from './advice.js';

/** One piece of text to keep, under a fixed name that says where it came from (never a name the caller chose). */
export interface KeptText {
  readonly field: string;
  readonly text: string;
}

/** True when `text` holds a credential shape. */
export function holdsSecret(text: string): boolean {
  return text.length > 0 && (containsSecret(text) || screenText(text, { paths: false }).length > 0);
}

/** The fixed names of the fields that hold a credential shape, in the order given and without repeats; never the text. */
export function secretFields(fields: readonly KeptText[]): readonly string[] {
  return [...new Set(fields.filter((f) => holdsSecret(f.text)).map((f) => f.field))];
}

/**
 * The refusal for text that holds a credential, or null when there is none. It names the fields and never the text, and it
 * carries no decision id, no handle and no recommendation: nothing was stored.
 */
export function refuseSecrets(def: Pick<CapabilityDefinition, 'id' | 'title' | 'primitive'>, fields: readonly KeptText[]): CapabilityAdvice | null {
  const found = secretFields(fields);
  if (found.length === 0) return null;
  return abstainAdvice(def, 'SECRET_BLOCKED', `Nothing was sent or stored: ${found.join(', ')} look${found.length === 1 ? 's' : ''} like they hold a secret (a token, a key or a password). Remove it and ask again.`);
}
