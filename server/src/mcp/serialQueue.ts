/**
 * A strictly FIFO, single-slot async queue.
 *
 * This replaces `flock(1)`, which does not exist on macOS. It reproduces the
 * semantics the shared-browser path relied on: at most one task runs at a time,
 * queued tasks start in arrival order, and a task that waits longer than
 * `waitTimeoutMs` for its turn is abandoned — it never runs.
 */

export class QueueWaitTimeoutError extends Error {
  constructor(waitTimeoutMs: number) {
    super(`Timed out after ${waitTimeoutMs}ms waiting for the shared browser.`);
    this.name = 'QueueWaitTimeoutError';
  }
}

interface Waiter {
  settled: boolean;
  start: () => void;
  abandon: (error: Error) => void;
}

export interface SerialQueue {
  run<T>(task: () => Promise<T>, options?: { waitTimeoutMs?: number }): Promise<T>;
  /** Tasks running plus tasks waiting. Observability only. */
  readonly depth: number;
}

export function createSerialQueue(): SerialQueue {
  const waiting: Waiter[] = [];
  let active = false;

  function pump(): void {
    if (active) return;
    const next = waiting.shift();
    if (!next) return;
    active = true;
    next.start();
  }

  async function run<T>(task: () => Promise<T>, options: { waitTimeoutMs?: number } = {}): Promise<T> {
    const { waitTimeoutMs } = options;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        start: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        },
        abandon: (error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          reject(error);
        },
      };
      const timer =
        waitTimeoutMs !== undefined && Number.isFinite(waitTimeoutMs)
          ? setTimeout(() => {
              // Drop it from the queue so its turn never comes.
              const index = waiting.indexOf(waiter);
              if (index >= 0) waiting.splice(index, 1);
              waiter.abandon(new QueueWaitTimeoutError(waitTimeoutMs));
            }, waitTimeoutMs)
          : undefined;
      timer?.unref();
      waiting.push(waiter);
      pump();
    });

    try {
      return await task();
    } finally {
      active = false;
      pump();
    }
  }

  return {
    run,
    get depth(): number {
      return waiting.length + (active ? 1 : 0);
    },
  };
}
