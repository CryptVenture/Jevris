import { join } from 'node:path';
import { copyHostDocument } from '@jevris/contracts';
import { EGRESS_REFUSED_STATUS, egressFreeText, screenText } from '@jevris/core';
import { jevrisPaths, resolveHome, type AuthorityFileRefusal } from '@jevris/platform';
import { readManagedPolicy } from '@jevris/cli/enterprise-policy';
import { sidecarManagedOptions } from './managed-exec.js';
import { readAuthorityPolicyJson } from './retention-policy.js';

/**
 * Source egress at the provider transport boundary (GOV-01, US02, SSOT §16.4, C50).
 *
 * Only the administrator's host policy approves egress: `host.json` with `egress:
 * "approved-scoped"`, and an `organization.json`, if present, that also approves. A missing,
 * unreadable or invalid file is not approval, and neither is one that breaks the SR-4
 * authority-file rules (a link, another owner, writable by others, or it or the Jevris home
 * inside a git work tree). Nothing in a repository, a prompt or a model answer is read here.
 *
 * The sidecar gives the decision engine a fetch that looks at every Jev request before it
 * leaves (see guardEgressFetch). A refused request is answered locally with status 451, so
 * the engine settles the decision rules-only; the sidecar logs the refused field pointers
 * and the reason code, never the text.
 */

export type EgressApproval = 'approved' | 'not-approved';

/** The decision, and the SR-4 reason when a policy file was ignored (null otherwise). */
export interface SourceEgressDetail {
  readonly approval: EgressApproval;
  readonly reasonCode: AuthorityFileRefusal | null;
}

export function resolveSourceEgress(input: { readonly home?: string }): EgressApproval {
  return sourceEgressDetail(input).approval;
}

/**
 * The egress decision with its SR-4 reason. host.json and organization.json count only under the
 * authority-file rules (readAuthorityPolicyJson): a file that breaks one is ignored with its
 * reason code and approves nothing, so egress stays denied.
 */
export function sourceEgressDetail(input: { readonly home?: string }): SourceEgressDetail {
  const where = input.home !== undefined ? { home: input.home } : {};
  const home = resolveHome(where).home;
  const config = jevrisPaths(where).config;
  const denied = (reasonCode: AuthorityFileRefusal | null = null): SourceEgressDetail => ({ approval: 'not-approved', reasonCode });
  // GOV-05: with a managed policy it must approve, and the user's files may only narrow it: each
  // one present must be valid and approve too. A refused managed policy approves nothing.
  const managed = readManagedPolicy(sidecarManagedOptions());
  if (managed.state === 'refused') return denied();
  if (managed.state === 'ok') {
    if (managed.document.egress !== 'approved-scoped') return denied();
    for (const name of ['host.json', 'organization.json']) {
      const layer = readAuthorityPolicyJson(join(config, name), home);
      if (layer.kind === 'missing') continue;
      if (layer.kind === 'refused') return denied(layer.reasonCode);
      const doc = layer.kind === 'ok' ? copyHostDocument(layer.value) : undefined;
      if (doc === undefined || doc.egress !== 'approved-scoped') return denied();
    }
    return { approval: 'approved', reasonCode: null };
  }
  const host = readAuthorityPolicyJson(join(config, 'host.json'), home);
  if (host.kind === 'refused') return denied(host.reasonCode);
  if (host.kind !== 'ok') return denied();
  const hostDoc = copyHostDocument(host.value);
  if (hostDoc === undefined || hostDoc.egress !== 'approved-scoped') return denied();
  const organization = readAuthorityPolicyJson(join(config, 'organization.json'), home);
  if (organization.kind === 'missing') return { approval: 'approved', reasonCode: null };
  if (organization.kind === 'refused') return denied(organization.reasonCode);
  if (organization.kind !== 'ok') return denied();
  const orgDoc = copyHostDocument(organization.value);
  return orgDoc !== undefined && orgDoc.egress === 'approved-scoped' ? { approval: 'approved', reasonCode: null } : denied();
}

type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

function bodyText(init: unknown): string | undefined {
  if (init === null || typeof init !== 'object') return undefined;
  const body = Reflect.get(init, 'body');
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder('utf-8').decode(body);
  return undefined;
}

export type EgressRefusal = 'EGRESS_NOT_APPROVED' | 'EGRESS_SECRET_BLOCKED';

function refusedResponse(reasonCode: EgressRefusal): unknown {
  const ResponseCtor = Reflect.get(globalThis, 'Response') as (new (body: string, init: object) => unknown) | undefined;
  const payload = JSON.stringify({ error: { type: reasonCode.toLowerCase(), reasonCode } });
  if (ResponseCtor === undefined) throw new Error(reasonCode);
  return new ResponseCtor(payload, { status: EGRESS_REFUSED_STATUS, headers: { 'content-type': 'application/json', 'x-jevris-egress': 'refused' } });
}

/**
 * Wraps `fetch` at the transport boundary. `approval` is read on every request, so a policy
 * change applies without a restart.
 *
 * - Not approved: a request carrying free-text evidence is refused (EGRESS_NOT_APPROVED).
 * - Approved: free text still goes through deterministic secret and sensitive-path screening;
 *   a finding refuses the request (EGRESS_SECRET_BLOCKED). The packet builder redacts first;
 *   this is the defence in depth.
 *
 * A body that is not JSON text is refused in both modes (it cannot be checked). The refusal is
 * answered locally with status 451: nothing is sent.
 */
export function guardEgressFetch(
  fetch: FetchLike,
  approval: () => EgressApproval,
  onRefused: (reasonCode: EgressRefusal, fields: readonly string[]) => void = () => undefined,
): FetchLike {
  return async (input, init) => {
    const text = bodyText(init);
    let parsed: unknown = null;
    let unreadable = false;
    if (text !== undefined) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        unreadable = true;
      }
    }
    const approved = approval() === 'approved';
    if (unreadable) {
      const reasonCode: EgressRefusal = approved ? 'EGRESS_SECRET_BLOCKED' : 'EGRESS_NOT_APPROVED';
      onRefused(reasonCode, ['/']);
      return refusedResponse(reasonCode);
    }
    const free = egressFreeText(parsed);
    if (!approved && free.length > 0) {
      onRefused('EGRESS_NOT_APPROVED', free.map((item) => item.pointer));
      return refusedResponse('EGRESS_NOT_APPROVED');
    }
    const secret = free.filter((item) => screenText(item.text).length > 0);
    if (secret.length > 0) {
      onRefused('EGRESS_SECRET_BLOCKED', secret.map((item) => item.pointer));
      return refusedResponse('EGRESS_SECRET_BLOCKED');
    }
    return fetch(input, init);
  };
}
