/**
 * The caller-owned total deadline of one transport call (§2.5 stack notes: the SDK timeout is per
 * attempt, so the caller owns the total deadline).
 *
 * One timer and the caller's AbortSignal drive a single combined signal. `guard` makes any piece
 * of the call (connect, headers, the body read) settle when that signal fires, even when the
 * underlying fetch or gateway client ignores its signal, so a call never outlives `timeoutMs`.
 * Whichever fires first decides the outcome: the timer is `expired`, the caller is `cancelled`.
 * `dispose` clears the timer and the caller listener; call it on every path.
 */

export type CallDeadlineState = 'running' | 'expired' | 'cancelled';

/** The rejection `guard` uses when the timer fires first. Never carries remote text. */
export class CallDeadlineExpired extends Error {
  constructor() {
    super('DEADLINE');
    this.name = 'CallDeadlineExpired';
  }
}

/** The rejection `guard` uses when the caller aborts first. */
export class CallCancelled extends Error {
  constructor() {
    super('CANCELLED');
    this.name = 'CallCancelled';
  }
}

export interface CallDeadline {
  /** Aborts when the deadline expires or the caller aborts, whichever is first. */
  readonly signal: AbortSignal;
  readonly state: CallDeadlineState;
  /** Resolves or rejects with `work`, or rejects as soon as `signal` fires. */
  guard<T>(work: Promise<T>): Promise<T>;
  /** Clears the timer and the caller listener. Safe to call more than once. */
  dispose(): void;
}

export function callDeadline(timeoutMs: number, caller?: AbortSignal): CallDeadline {
  const controller = new AbortController();
  let state: CallDeadlineState = 'running';
  const onCallerAbort = (): void => {
    if (state !== 'running') return;
    state = 'cancelled';
    controller.abort(new CallCancelled());
  };
  const timer = setTimeout(() => {
    if (state !== 'running') return;
    state = 'expired';
    controller.abort(new CallDeadlineExpired());
  }, Math.max(1, Math.floor(timeoutMs)));
  if (caller?.aborted === true) onCallerAbort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const reason = (): Error => (state === 'expired' ? new CallDeadlineExpired() : new CallCancelled());
  return {
    signal: controller.signal,
    get state(): CallDeadlineState {
      return state;
    },
    guard<T>(work: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        work.catch(() => undefined);
        return Promise.reject(reason());
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(reason());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        work.then(
          (value) => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
    dispose(): void {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Reads a body through a byte cap, obeying `signal`: an abort cancels the reader and rejects, so
 * a stalled body never outlives the call, and a cancelled read is never mistaken for a complete
 * body. Throws `tooLarge()` past the cap.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array>,
  cap: number,
  signal: AbortSignal | undefined,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let abortedRead = false;
  const onAbort = (): void => {
    abortedRead = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (abortedRead) throw signal?.reason instanceof Error ? signal.reason : new CallCancelled();
      const part = await reader.read();
      if (abortedRead) throw signal?.reason instanceof Error ? signal.reason : new CallCancelled();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > cap) {
        reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A read still pending on a stream that ignored the cancel keeps the lock; nothing to release.
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
