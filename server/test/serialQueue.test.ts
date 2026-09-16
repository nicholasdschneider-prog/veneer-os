import { describe, expect, it } from 'vitest';
import { QueueWaitTimeoutError, createSerialQueue } from '../src/mcp/serialQueue.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('shared browser serial queue', () => {
  it('runs tasks strictly one at a time', async () => {
    const queue = createSerialQueue();
    let running = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 8 }, () =>
      queue.run(async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      }),
    );
    await Promise.all(tasks);

    expect(maxConcurrent).toBe(1);
    expect(queue.depth).toBe(0);
  });

  it('starts queued tasks in arrival order', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        queue.run(async () => {
          order.push(index);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('abandons a task that waits past its timeout without ever running it', async () => {
    const queue = createSerialQueue();
    const blocker = deferred<void>();
    let secondRan = false;

    const held = queue.run(() => blocker.promise);
    const queued = queue.run(
      async () => {
        secondRan = true;
      },
      { waitTimeoutMs: 20 },
    );

    await expect(queued).rejects.toBeInstanceOf(QueueWaitTimeoutError);
    expect(secondRan).toBe(false);

    blocker.resolve();
    await held;
    // The abandoned task must not run when the slot frees up.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondRan).toBe(false);
    expect(queue.depth).toBe(0);
  });

  it('does not time out a task that got its turn in time', async () => {
    const queue = createSerialQueue();
    const first = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    // Long-running once started: the wait timeout covers queueing only.
    const second = queue.run(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return 'done';
      },
      { waitTimeoutMs: 25 },
    );

    await first;
    await expect(second).resolves.toBe('done');
  });

  it('keeps draining after a task throws', async () => {
    const queue = createSerialQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });

    await expect(failed).rejects.toThrow('boom');
    await expect(queue.run(async () => 'next')).resolves.toBe('next');
    expect(queue.depth).toBe(0);
  });
});
