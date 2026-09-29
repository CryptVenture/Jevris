/**
 * Calibration bound per pack, model and encoder (PAK-08, §11.4, US34).
 *
 * A pack names each calibration artifact it relies on in its manifest: the decision spec, the
 * model, the encoder hash, the artifact file and that file's hash. The loader refuses a binding
 * whose file is missing, altered or invalid, or whose artifact was calibrated for another spec,
 * model or encoder. At decision time, `calibrationFor` answers only for the exact model and
 * encoder in use; any other pair is a mismatch, and that automated decision stays disabled
 * (advice only) until a compatible artifact passes review and staged evaluation.
 */
import { CalibrationArtifactContract, sha256Hex, type CalibrationArtifact } from '@jevris/contracts';
import type { PackManifest } from './manifest.js';
import type { PackFile } from './files.js';

export type CalibrationRefusal = 'CALIBRATION_MISSING' | 'CALIBRATION_CHANGED' | 'CALIBRATION_INVALID' | 'CALIBRATION_MISMATCH';

export interface BoundCalibration {
  readonly decisionSpecId: string;
  readonly modelId: string;
  readonly encoderHash: string;
  readonly artifact: CalibrationArtifact;
}

export interface CalibrationCheck {
  readonly bound: readonly BoundCalibration[];
  readonly refused: readonly { readonly decisionSpecId: string; readonly modelId: string; readonly reasonCode: CalibrationRefusal; readonly detail: string }[];
}

/** Checks every binding against the pack's files. Pure: the caller read the files. */
export function checkCalibrationBindings(manifest: PackManifest, files: ReadonlyMap<string, PackFile>): CalibrationCheck {
  const bound: BoundCalibration[] = [];
  const refused: CalibrationCheck['refused'][number][] = [];
  for (const binding of manifest.calibration ?? []) {
    const refuse = (reasonCode: CalibrationRefusal, detail: string): void => {
      refused.push({ decisionSpecId: binding.decisionSpecId, modelId: binding.modelId, reasonCode, detail });
    };
    const file = files.get(binding.artifact);
    if (file === undefined) {
      refuse('CALIBRATION_MISSING', binding.artifact);
      continue;
    }
    if (`sha256:${sha256Hex(file.bytes)}` !== binding.artifactHash) {
      refuse('CALIBRATION_CHANGED', binding.artifact);
      continue;
    }
    const parsed = CalibrationArtifactContract.parse(file.bytes, 1_048_576);
    if (!parsed.ok) {
      refuse('CALIBRATION_INVALID', parsed.issues.map((issue) => `${issue.path || '/'} ${issue.code}`).slice(0, 4).join('; '));
      continue;
    }
    const artifact = parsed.value;
    if (artifact.decisionSpecId !== binding.decisionSpecId) refuse('CALIBRATION_MISMATCH', `spec ${artifact.decisionSpecId} is not ${binding.decisionSpecId}`);
    else if (artifact.model.modelId !== binding.modelId) refuse('CALIBRATION_MISMATCH', `model ${artifact.model.modelId} is not ${binding.modelId}`);
    else if (artifact.encoderHash !== binding.encoderHash) refuse('CALIBRATION_MISMATCH', 'encoder hash differs from the binding');
    else bound.push({ decisionSpecId: binding.decisionSpecId, modelId: binding.modelId, encoderHash: binding.encoderHash, artifact });
  }
  return { bound, refused };
}

export type CalibrationLookup =
  | { readonly ok: true; readonly calibration: BoundCalibration }
  | { readonly ok: false; readonly reasonCode: 'CALIBRATION_MISMATCH' | 'NOT_CALIBRATED' };

/**
 * The pack's calibration for one decision under the model and encoder actually in use. A
 * binding for the same spec under another model or encoder is a mismatch, never a fallback.
 */
export function calibrationFor(check: CalibrationCheck, context: { readonly decisionSpecId: string; readonly modelId: string; readonly encoderHash: string }): CalibrationLookup {
  const forSpec = check.bound.filter((item) => item.decisionSpecId === context.decisionSpecId);
  const exact = forSpec.find((item) => item.modelId === context.modelId && item.encoderHash === context.encoderHash);
  if (exact !== undefined) return { ok: true, calibration: exact };
  const refusedForSpec = check.refused.some((item) => item.decisionSpecId === context.decisionSpecId);
  return { ok: false, reasonCode: forSpec.length > 0 || refusedForSpec ? 'CALIBRATION_MISMATCH' : 'NOT_CALIBRATED' };
}
