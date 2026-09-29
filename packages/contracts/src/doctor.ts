/**
 * Doctor report types. These are not a certification and not a runtime validator.
 * verification is supported only while the workspace has an approved runner manifest
 * (VER-07). No enforced status exists on this report.
 */

import type { EgressReasonCode } from './egress.js';

/** full: every installed harness is certified for its version here and its smoke passed. */
export type DoctorInstallStatus = 'full' | 'reduced' | 'unsupported' | 'refused';

export type DoctorEnvironmentStatus = 'local' | 'reduced' | 'unsupported';

export type ActuatorStatus = 'unsupported' | 'certified';

export type PackDisposition = 'advice' | 'disabled';

export interface ActuatorRow {
  readonly id: string;
  readonly status: ActuatorStatus;
  readonly fixtureHash: string | null;
  readonly reason: string;
}

export interface PackReport {
  readonly id: string;
  readonly disposition: PackDisposition;
  readonly missingCapabilities: readonly string[];
}

/**
 * Installed-binary probe. The probe itself reports installation-only or unsupported, and
 * eventProbe did-not-pass: a version token is not certification. Doctor raises them to
 * certified and passed only from signed certification records that cover every installed
 * harness's version on this host (and each harness's installed smoke passed).
 */
export type HarnessProbeHealth = 'certified' | 'installation-only' | 'unsupported';

export type HarnessEventProbe = 'passed' | 'did-not-pass';

export interface HarnessProbe {
  readonly health: HarnessProbeHealth;
  readonly eventProbe: HarnessEventProbe;
  /**
   * The binary probe alone never certifies an actuator: 'unsupported'. Doctor raises it to
   * 'certified' together with `health`, when signed records cover every installed harness's
   * version range; each actuator's own status is in the report's `actuators` rows.
   */
  readonly actuators: 'certified' | 'unsupported';
  readonly binaryPresent: boolean;
  readonly versionToken: string | null;
}

export interface DoctorReport {
  readonly schemaVersion: '1.0';
  readonly harnessVersion: string;
  readonly harnessProbe: HarnessProbe;
  readonly egressDecision: 'allow' | 'deny';
  readonly egressReasonCode: EgressReasonCode | null;
  readonly installStatus: DoctorInstallStatus;
  readonly environmentStatus: DoctorEnvironmentStatus;
  readonly verification: 'supported' | 'unsupported';
  /** Why verification has that state, and what to run next when it is unsupported. */
  readonly verificationReason: string;
  readonly actuators: readonly ActuatorRow[];
  readonly packs: readonly PackReport[];
  readonly sameUserLimit: string;
}
