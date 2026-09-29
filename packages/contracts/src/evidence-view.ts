export interface EvidenceOffset {
  readonly start: number;
  readonly end: number;
}

export interface EvidenceView {
  readonly handle: string;
  readonly hash: string;
  readonly errorState: string;
  readonly offsets: readonly EvidenceOffset[];
  readonly passthrough: boolean;
  readonly text: string;
  readonly value?: unknown;
}
