/**
 * Skill and evidence shortlist results. Types only.
 * executed and uploaded are assigned by the builder. This file does not accept them from a caller.
 * A missing id is not an absence proof.
 */

export interface SkillInventoryEntry {
  readonly id: string;
  readonly description: string | null;
}

export interface SkillShortlistResult {
  readonly schemaVersion: '1.0';
  readonly options: readonly string[];
  readonly selected: string;
  readonly executed: false;
  readonly unknownRejected: readonly string[];
  readonly truncated: boolean;
  readonly inventory: readonly SkillInventoryEntry[];
}

export interface EvidenceSpan {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface MissingEvidence {
  readonly id: string;
  readonly state: 'missing';
}

export interface EvidenceShortlistResult {
  readonly schemaVersion: '1.0';
  readonly uploaded: false;
  readonly spans: readonly EvidenceSpan[];
  readonly missing: readonly MissingEvidence[];
  readonly truncated: boolean;
}

export interface SkillDirectoryReader {
  listDirectories(root: string): readonly string[] | Promise<readonly string[]>;
  readSkillMarkdown(
    root: string,
    directoryName: string,
  ): Uint8Array | null | Promise<Uint8Array | null>;
}

export interface EvidencePrefix {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

export interface EvidenceReader {
  readPrefix(
    root: string,
    relativeId: string,
  ): EvidencePrefix | null | Promise<EvidencePrefix | null>;
  listFiles?(root: string): readonly string[] | Promise<readonly string[]>;
}
