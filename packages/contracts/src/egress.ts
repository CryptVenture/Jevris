/**
 * Egress decision types. These literals are not members of ReasonCode.
 * Provenance is the only allow source. A repository file is not this setting.
 */

export interface EgressSetting {
  readonly provenance: 'administrator';
  readonly sourceEgress: 'deny-until-approved' | 'approved-scoped';
}

export type EgressReasonCode =
  | 'EGRESS_NOT_APPROVED'
  | 'UNTRUSTED_APPROVAL'
  | 'CREDENTIAL_MISSING';

export interface EgressDeny {
  readonly decision: 'deny';
  readonly reasonCode: EgressReasonCode;
  readonly explanation: string;
  readonly sent: false;
  readonly toolPermission: false;
}

export interface EgressAllow {
  readonly decision: 'allow';
  readonly sent: false;
  readonly toolPermission: false;
}

export type EgressDecision = EgressDeny | EgressAllow;

export interface EgressLogLine {
  readonly reasonCode: EgressReasonCode;
  readonly line: string;
}

/**
 * One local diagnostic. Not a ReasonCode and not a grant.
 * Presence is injected. This object does not carry a path or a key.
 */
export interface CredentialDiagnostic {
  readonly reasonCode: 'CREDENTIAL_MISSING';
  readonly explanation: string;
}
