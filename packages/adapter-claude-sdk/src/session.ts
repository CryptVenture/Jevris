import { loadAgentSdk, SDK_MISSING_MESSAGE } from './worker.js';

/**
 * Owned session factory. Native permissions stay on the default mode.
 * A port is the test seam. Production loads the optional Agent SDK with a literal dynamic
 * import only when no port is injected; when the SDK is absent the result is `unsupported`.
 * `runOwnedWorker` (worker.ts) is the path that runs a session to completion.
 */

const ALLOWED_KEYS = new Set(['permissionMode', 'prompt', 'promptKind', 'port', 'sessionId']);

export interface LockedOptions {
  readonly permissionMode: 'default';
  readonly abortController: AbortController;
  readonly disallowedTools: readonly string[];
}

export interface SessionPort {
  start(input: { readonly prompt: string | AsyncIterable<unknown>; readonly options: LockedOptions }): {
    readonly sessionId: string;
  };
  close(): void;
  abort(): void;
  interrupt(): void;
}

export interface CreateOwnedSessionInput {
  readonly permissionMode?: string;
  readonly prompt?: string | AsyncIterable<unknown>;
  readonly promptKind?: 'string' | 'stream';
  readonly port?: SessionPort;
  readonly sessionId?: string;
}

export type CreateOwnedSessionResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly permissionMode: 'default';
      readonly disallowedTools: readonly string[];
      readonly close: () => void;
      readonly abort: () => void;
      readonly interrupt?: () => void;
      readonly options: LockedOptions;
    }
  | { readonly ok: false; readonly reason: 'refused' }
  | { readonly ok: false; readonly reason: 'unsupported'; readonly message: typeof SDK_MISSING_MESSAGE };

let nextOwnedId = 0;

function newOwnedId(): string {
  nextOwnedId += 1;
  return `owned-${String(nextOwnedId)}`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function allowedInput(input: CreateOwnedSessionInput): boolean {
  if (input === null || typeof input !== 'object') return false;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) return false;
  }
  if (input.permissionMode !== undefined && input.permissionMode !== 'default') return false;
  if (input.promptKind !== undefined && input.promptKind !== 'string' && input.promptKind !== 'stream') return false;
  if (input.sessionId !== undefined && input.sessionId.length === 0) return false;
  if (input.port !== undefined && typeof input.port.start !== 'function') return false;
  return true;
}

function lockedOptions(controller: AbortController): LockedOptions {
  const disallowedTools: string[] = ['EnterWorktree', 'ExitWorktree'];
  return {
    permissionMode: 'default',
    abortController: controller,
    disallowedTools,
  };
}

async function openProduction(
  prompt: string | AsyncIterable<unknown>,
  controller: AbortController,
  options: LockedOptions,
  promptKind: 'string' | 'stream' | undefined,
  sessionId: string,
): Promise<CreateOwnedSessionResult> {
  if (typeof prompt !== 'string' && !isAsyncIterable(prompt)) return { ok: false, reason: 'refused' };
  if (typeof prompt === 'string' && prompt.length === 0) return { ok: false, reason: 'refused' };
  const query = (await loadAgentSdk()) as unknown as
    | ((args: { prompt: string; options: { permissionMode: 'default'; abortController: AbortController; disallowedTools: string[] } }) => {
        close(): void;
        interrupt(): Promise<void>;
      })
    | null;
  if (query === null) return { ok: false, reason: 'unsupported', message: SDK_MISSING_MESSAGE };
  const session = query({
    prompt: prompt as string,
    options: {
      permissionMode: 'default',
      abortController: controller,
      disallowedTools: ['EnterWorktree', 'ExitWorktree'],
    },
  });
  const close = (): void => {
    session.close();
  };
  const abort = (): void => {
    controller.abort();
  };
  const accepted = {
    ok: true as const,
    sessionId,
    permissionMode: 'default' as const,
    disallowedTools: options.disallowedTools,
    close,
    abort,
    options,
  };
  if (promptKind === 'stream' || isAsyncIterable(prompt)) {
    return {
      ...accepted,
      interrupt(): void {
        void session.interrupt();
      },
    };
  }
  return accepted;
}

export async function createOwnedSession(input: CreateOwnedSessionInput): Promise<CreateOwnedSessionResult> {
  if (!allowedInput(input)) return { ok: false, reason: 'refused' };
  const controller = new AbortController();
  const options = lockedOptions(controller);
  const prompt = input.prompt ?? '';
  const port = input.port;
  if (port !== undefined) {
    const started = port.start({ prompt, options });
    if (started.sessionId.length === 0) return { ok: false, reason: 'refused' };
    const close = (): void => {
      port.close();
    };
    const abort = (): void => {
      controller.abort();
      port.abort();
    };
    const accepted = {
      ok: true as const,
      sessionId: started.sessionId,
      permissionMode: 'default' as const,
      disallowedTools: options.disallowedTools,
      close,
      abort,
      options,
    };
    if (input.promptKind === 'stream') {
      return {
        ...accepted,
        interrupt(): void {
          port.interrupt();
        },
      };
    }
    return accepted;
  }
  const sessionId = input.sessionId ?? newOwnedId();
  return openProduction(prompt, controller, options, input.promptKind, sessionId);
}
