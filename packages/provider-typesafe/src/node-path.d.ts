// Ambient declaration of the node:path function the sidecar engine uses. The package compiles
// without Node types.
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

// The synchronous stat and read the test calibration-key gate uses (calibration-trust.ts).
declare module 'node:fs' {
  export interface Stats {
    readonly size: number;
    readonly mode: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function realpathSync(path: string): string;
}

/**
 * F's signed certification loader. Imported dynamically with a string literal so the runtime
 * bundle includes it; declared here because the CLI depends on this package (no reference).
 */
declare module '@jevris/cli/certifications' {
  export function loadCertifications(home: string): Promise<unknown>;
  export function coveringCertification(load: unknown, context: unknown): { readonly covered: unknown; readonly reasonCode: string | null };
}

/**
 * B's store session lookup (US12: requested versus actual model). Imported dynamically with a
 * string literal so the runtime bundle includes it; declared here to avoid a build dependency.
 */
declare module '@jevris/store' {
  export function getSession(store: unknown, sessionId: string): { readonly requestedModel: string | null; readonly actualModel: string | null } | undefined;
  /** P4: B's decision-outcome join (the fields C reads; the rows carry more). */
  export interface DecisionOutcomeRow {
    readonly decisionId: string;
    readonly kind: string;
    readonly decisionOutcome: string;
    readonly providerCalls: number;
    readonly label: string;
    readonly joinBasis: 'task' | 'session-window';
    readonly labelledAtMs: number;
  }
  export function decisionOutcomeFor(store: unknown, decisionId: string, workspaceId?: string): readonly DecisionOutcomeRow[];
  /** P12: B's decision_feedback (store v7). */
  export function recordDecisionFeedback(store: unknown, input: { readonly workspaceId?: string; readonly decisionId: string; readonly kind: string; readonly accepted: boolean; readonly reason: string | null; readonly atMs: number }): { readonly ok: true; readonly result: 'recorded' | 'replaced'; readonly revision: number } | { readonly ok: false; readonly reason: string };
  export function readDecisionFeedback(store: unknown, filter?: { readonly workspaceId?: string; readonly sinceMs?: number; readonly kind?: string; readonly limit?: number }): readonly { readonly decisionId: string; readonly kind: string; readonly accepted: boolean; readonly reason: string | null; readonly atMs: number; readonly revision: number }[];
  /** Owner decision 29423b6: B's live session link (undefined: none, ended, or unreadable). */
  export function sessionLinkFor(store: unknown, sessionId: string): { readonly sessionId: string; readonly harness: string; readonly taskId: string; readonly linkedAtMs: number; readonly via: string } | undefined;
  export function readDecisionOutcomes(store: unknown, filter?: { readonly workspaceId?: string; readonly sinceMs?: number; readonly kind?: string; readonly joinBasis?: 'task' | 'session-window'; readonly limit?: number }): readonly DecisionOutcomeRow[];
}
