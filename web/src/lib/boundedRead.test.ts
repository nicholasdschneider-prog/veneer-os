import { afterEach, expect, it, vi } from 'vitest';
import { boundedRead } from './boundedRead';
afterEach(() => vi.useRealTimers());
it('coalesces overlapping reads but never caches completed results or other scopes', async () => {
  let finish!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
  const flight = boundedRead(read);
  const a=flight.run(), b=flight.run();
  expect(a).toBe(b); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
  finish(1); expect(await a).toBe(1);
  const c=flight.run(); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(2); finish(2); expect(await c).toBe(2);
  const other=boundedRead(async()=>3); expect(await other.run()).toBe(3);
});
it('cancels a pre-mutation read, ignores its late result and bounds a hung request', async () => {
  vi.useFakeTimers();
  let finish!: (value: number) => void;
  const flight=boundedRead(()=>new Promise<number>(resolve=>{finish=resolve;}),1000);
  const old=flight.run(); const rejected=expect(old).rejects.toMatchObject({name:'AbortError'});
  await Promise.resolve(); const late=finish; flight.cancel(); await rejected;
  const fresh=flight.run(); await Promise.resolve(); late(1); finish(2); expect(await fresh).toBe(2);
  const hung=flight.run(); const timeout=expect(hung).rejects.toMatchObject({name:'TimeoutError'});
  await vi.advanceTimersByTimeAsync(1001); await timeout;
  expect(await boundedRead(async()=>4).run()).toBe(4);
});
