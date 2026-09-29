/**
 * Separate interactive and background decision queues (DEC-10, §7.2, §17.4).
 *
 * Each lane has its own concurrency and queue, so a flood of background observations never
 * delays a user-facing decision. When the background queue is full, observation work is shed
 * first (the oldest queued observation is dropped); a background decision is refused only when
 * nothing sheddable is left. Queued work whose deadline passed is dropped, not started.
 */
import type { DecisionLane } from './decision-retry.js';

export type WorkKind = 'decision' | 'observation';

export interface QueueLimits {
  readonly interactiveConcurrency: number;
  readonly interactiveQueue: number;
  readonly backgroundConcurrency: number;
  readonly backgroundQueue: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = Object.freeze({
  interactiveConcurrency: 4,
  interactiveQueue: 32,
  backgroundConcurrency: 2,
  backgroundQueue: 64,
});

export type QueueOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: 'SHED' | 'QUEUE_FULL' | 'DEADLINE' | 'FAILED' };

export interface QueueDeadline {
  expired(): boolean;
}

interface Job {
  readonly kind: WorkKind;
  readonly deadline: QueueDeadline | undefined;
  readonly run: () => Promise<unknown>;
  readonly settle: (outcome: QueueOutcome<unknown>) => void;
}

class Lane {
  readonly #concurrency: number;
  readonly #capacity: number;
  readonly #queue: Job[] = [];
  #active = 0;
  shed = 0;
  refused = 0;
  completed = 0;

  constructor(concurrency: number, capacity: number) {
    this.#concurrency = Math.max(1, concurrency);
    this.#capacity = Math.max(0, capacity);
  }

  get depth(): number {
    return this.#queue.length;
  }

  get active(): number {
    return this.#active;
  }

  submit(job: Job): void {
    if (this.#active < this.#concurrency) {
      this.#start(job);
      return;
    }
    if (this.#queue.length >= this.#capacity) {
      // Shed the oldest queued observation first; only then refuse.
      const index = this.#queue.findIndex((queued) => queued.kind === 'observation');
      if (index >= 0) {
        const [dropped] = this.#queue.splice(index, 1);
        this.shed += 1;
        dropped?.settle({ ok: false, reasonCode: 'SHED' });
      } else if (job.kind === 'observation') {
        this.shed += 1;
        job.settle({ ok: false, reasonCode: 'SHED' });
        return;
      } else {
        this.refused += 1;
        job.settle({ ok: false, reasonCode: 'QUEUE_FULL' });
        return;
      }
    }
    this.#queue.push(job);
  }

  #start(job: Job): void {
    if (job.deadline?.expired() === true) {
      job.settle({ ok: false, reasonCode: 'DEADLINE' });
      this.#next();
      return;
    }
    this.#active += 1;
    let promise: Promise<unknown>;
    try {
      promise = job.run();
    } catch {
      promise = Promise.reject(new Error('FAILED'));
    }
    promise.then(
      (value) => job.settle({ ok: true, value }),
      () => job.settle({ ok: false, reasonCode: 'FAILED' }),
    ).finally(() => {
      this.#active -= 1;
      this.completed += 1;
      this.#next();
    });
  }

  #next(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) return;
      if (job.deadline?.expired() === true) {
        job.settle({ ok: false, reasonCode: 'DEADLINE' });
        continue;
      }
      this.#start(job);
    }
  }
}

export class DecisionQueues {
  readonly #interactive: Lane;
  readonly #background: Lane;

  constructor(limits: Partial<QueueLimits> = {}) {
    const l = { ...DEFAULT_QUEUE_LIMITS, ...limits };
    this.#interactive = new Lane(l.interactiveConcurrency, l.interactiveQueue);
    this.#background = new Lane(l.backgroundConcurrency, l.backgroundQueue);
  }

  /** Runs `work` on its lane. Observations always go to the background lane. */
  submit<T>(lane: DecisionLane, kind: WorkKind, work: () => Promise<T>, deadline?: QueueDeadline): Promise<QueueOutcome<T>> {
    const target = kind === 'observation' || lane === 'background' ? this.#background : this.#interactive;
    return new Promise((resolve) => {
      target.submit({ kind, deadline, run: work, settle: resolve as (outcome: QueueOutcome<unknown>) => void });
    });
  }

  stats(): {
    readonly interactive: { readonly active: number; readonly depth: number; readonly refused: number; readonly completed: number };
    readonly background: { readonly active: number; readonly depth: number; readonly shed: number; readonly refused: number; readonly completed: number };
  } {
    return {
      interactive: { active: this.#interactive.active, depth: this.#interactive.depth, refused: this.#interactive.refused, completed: this.#interactive.completed },
      background: {
        active: this.#background.active,
        depth: this.#background.depth,
        shed: this.#background.shed,
        refused: this.#background.refused,
        completed: this.#background.completed,
      },
    };
  }
}
